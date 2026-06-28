"""
NV Proxy Dashboard — backend Flask
- Login com sessão (usuários e senha-hash em SQLite, pasta /db)
- Backend guarda a URL e o Bearer Token do XMRig Proxy (vindos do .env) e
  faz as chamadas por trás — o navegador nunca vê o token.
- Endpoints /api/summary e /api/connected-miners (merge de /1/workers + /1/miners)
"""

import os
import sys
import sqlite3
import threading
import time
import json
import subprocess
import signal
from datetime import datetime, timezone
from functools import wraps

import requests
from flask import Flask, render_template, request, redirect, url_for, session, jsonify, flash
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "db", "app.db")

# ---------------------------------------------------------------------------
# Configuração (tudo vem do .env — nunca do navegador)
# ---------------------------------------------------------------------------
XMRIG_PROXY_URL = os.environ.get("XMRIG_PROXY_URL", "http://127.0.0.1:8080").rstrip("/")
XMRIG_API_TOKEN = os.environ.get("XMRIG_API_TOKEN", "")
REQUEST_TIMEOUT = float(os.environ.get("XMRIG_REQUEST_TIMEOUT", "8"))
ONLINE_THRESHOLD_SECONDS = int(os.environ.get("ONLINE_THRESHOLD_SECONDS", "90"))

# Cache global para estimativa de lucros
PROFIT_CACHE = {
    "price": None,
    "difficulty": None,
    "last_fetched": 0
}

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY")
if not app.secret_key:
    raise RuntimeError(
        "SECRET_KEY não definida no .env. Gere uma com:\n"
        '  python -c "import secrets; print(secrets.token_hex(32))"'
    )

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Em produção, atrás de HTTPS, troque para True:
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "0") == "1",
)


# ---------------------------------------------------------------------------
# Banco de dados (SQLite em /db) — usuários do painel
# ---------------------------------------------------------------------------
def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def get_proxy_config():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Verifica se a tabela settings existe
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
    if cursor.fetchone():
        url_row = cursor.execute("SELECT value FROM settings WHERE key = 'xmrig_proxy_url'").fetchone()
        token_row = cursor.execute("SELECT value FROM settings WHERE key = 'xmrig_api_token'").fetchone()
        url = url_row["value"] if url_row and url_row["value"] else XMRIG_PROXY_URL
        token = token_row["value"] if token_row and token_row["value"] else XMRIG_API_TOKEN
    else:
        url = XMRIG_PROXY_URL
        token = XMRIG_API_TOKEN
    conn.close()
    return url, token


def init_db():
    conn = get_db()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'admin',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT UNIQUE NOT NULL,
            value TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS hashrate_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            total_hashrate REAL,
            active_miners INTEGER,
            accepted_hashes INTEGER,
            rejected_hashes INTEGER
        )
        """
    )
    conn.commit()

    existing = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    if existing == 0:
        default_user = os.environ.get("DEFAULT_ADMIN_USER")
        default_pass = os.environ.get("DEFAULT_ADMIN_PASSWORD")
        if default_user and default_pass:
            conn.execute(
                "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
                (default_user, generate_password_hash(default_pass), "admin", datetime.now(timezone.utc).isoformat()),
            )
            conn.commit()
            print(f"[init_db] User '{default_user}' created from .env (DEFAULT_ADMIN_USER).")
        else:
            print("[init_db] No users registered yet.")
            print("[init_db] Create one with: python main.py create-admin <username> <password>")
    conn.close()


def find_user_by_username(username):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return user


def create_user(username, password, role="admin"):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
            (username, generate_password_hash(password), role, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Autenticação
# ---------------------------------------------------------------------------
def login_required(view):
    """Para rotas que renderizam páginas HTML: redireciona para /login."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def api_login_required(view):
    """For /api/* routes: returns JSON 401 instead of redirecting, allowing
    the frontend fetch() to handle expired sessions."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return jsonify({"error": "unauthorized", "message": "Session expired. Please log in again."}), 401
        return view(*args, **kwargs)
    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = find_user_by_username(username)
        # Generic message: doesn't reveal if user exists
        if user and check_password_hash(user["password_hash"], password):
            session.clear()
            session["user_id"] = user["id"]
            session["username"] = user["username"]
            session["role"] = user["role"]
            next_url = request.args.get("next") or url_for("dashboard")
            return redirect(next_url)
        flash("Invalid username or password.")

    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def dashboard():
    return render_template("dashboard.html", username=session.get("username"))


# ---------------------------------------------------------------------------
# Cliente HTTP para a API do XMRig Proxy (token fica só no backend)
# ---------------------------------------------------------------------------
def xmrig_get(path):
    """Retorna (data, None) em sucesso, ou (None, (codigo, mensagem)) em erro.
    Nunca deixa uma exceção subir — quem chama decide o que fazer com o erro."""
    url_base, token = get_proxy_config()
    url = f"{url_base}{path}"
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    try:
        resp = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
    except requests.exceptions.Timeout:
        return None, ("timeout", "Response timeout exceeded. The proxy may be offline or overloaded.")
    except requests.exceptions.ConnectionError:
        return None, ("network", "Could not connect to XMRig Proxy. Verify if the process is running.")
    except requests.exceptions.RequestException as exc:
        return None, ("network", f"Network error: {exc}")

    if resp.status_code == 401:
        return None, ("unauthorized", "Invalid or expired access token. Check XMRIG_API_TOKEN in .env.")
    if resp.status_code == 404:
        return None, ("not_found", "Endpoint not available on this configuration of XMRig Proxy (verify that 'workers' is enabled).")
    if not resp.ok:
        return None, ("http_error", f"XMRig Proxy responded with HTTP {resp.status_code}.")

    try:
        return resp.json(), None
    except ValueError:
        return None, ("parse_error", "Invalid (non-JSON) response from XMRig Proxy.")


def _miner_field(miners_format, miner_row, field_name):
    if field_name not in miners_format:
        return None
    idx = miners_format.index(field_name)
    return miner_row[idx] if idx < len(miner_row) else None


def merge_miners(workers_payload, miners_payload):
    """Faz o merge de /1/workers + /1/miners por rig_id -> user -> ip.
    Nunca lança exceção por dado ausente: tudo tem fallback."""
    workers = (workers_payload or {}).get("workers") or []
    miners_format = (miners_payload or {}).get("format") or []
    miners = (miners_payload or {}).get("miners") or []

    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    matched_indexes = set()
    rows = []

    for w in workers:
        name = w[0] if len(w) > 0 else None
        ip = w[1] if len(w) > 1 else None
        accepted = w[3] if len(w) > 3 else None
        rejected = w[4] if len(w) > 4 else None
        last_hash_ts = w[7] if len(w) > 7 else None
        hashrates = w[8:] if len(w) > 8 else []

        match = None
        for i, m in enumerate(miners):
            rig_id = _miner_field(miners_format, m, "rig_id")
            user = _miner_field(miners_format, m, "user")
            m_ip = _miner_field(miners_format, m, "ip")
            if (rig_id and rig_id == name) or (user and user == name) or (not rig_id and not user and m_ip == ip):
                match = m
                matched_indexes.add(i)
                break

        status = "unknown"
        if last_hash_ts:
            age_seconds = (now_ms - last_hash_ts) / 1000
            status = "online" if 0 <= age_seconds <= ONLINE_THRESHOLD_SECONDS else "offline"

        rows.append({
            "worker_name": name or (_miner_field(miners_format, match, "user") if match else None) or "—",
            "rig_id": (_miner_field(miners_format, match, "rig_id") if match else None) or name or "—",
            "ip": (_miner_field(miners_format, match, "ip") if match else None) or ip or "—",
            "hashrate_10s": hashrates[0] if len(hashrates) > 0 else None,
            "hashrate_1m": hashrates[1] if len(hashrates) > 1 else None,
            "accepted": accepted,
            "rejected": rejected,
            "difficulty": _miner_field(miners_format, match, "diff") if match else None,
            "agent": _miner_field(miners_format, match, "agent") if match else None,
            "status": status,
        })

    # Miners que existem em /1/miners mas não casaram com nenhum worker
    for i, m in enumerate(miners):
        if i in matched_indexes:
            continue
        rows.append({
            "worker_name": _miner_field(miners_format, m, "user") or _miner_field(miners_format, m, "rig_id") or "—",
            "rig_id": _miner_field(miners_format, m, "rig_id") or "—",
            "ip": _miner_field(miners_format, m, "ip") or "—",
            "hashrate_10s": None,
            "hashrate_1m": None,
            "accepted": None,
            "rejected": None,
            "difficulty": _miner_field(miners_format, m, "diff"),
            "agent": _miner_field(miners_format, m, "agent"),
            "status": "unknown",
        })

    return rows


# ---------------------------------------------------------------------------
# API (protegida por sessão) — o frontend só fala com estes endpoints
# ---------------------------------------------------------------------------
@app.route("/api/summary")
@api_login_required
def api_summary():
    data, error = xmrig_get("/1/summary")
    if error:
        code, message = error
        return jsonify({"error": code, "message": message}), 502
    return jsonify(data)


@app.route("/api/connected-miners")
@api_login_required
def api_connected_miners():
    workers_data, workers_error = xmrig_get("/1/workers")
    miners_data, miners_error = xmrig_get("/1/miners")

    if workers_error and miners_error:
        code, message = workers_error
        return jsonify({"error": code, "message": message}), 502

    rows = merge_miners(workers_data, miners_data)
    return jsonify({
        "miners": rows,
        "workers_error": workers_error[1] if workers_error else None,
        "miners_error": miners_error[1] if miners_error else None,
    })


# ---------------------------------------------------------------------------
# Histórico e Métricas (Gravação em Background)
# ---------------------------------------------------------------------------
def background_hashrate_recorder():
    """Logs historical hashrate and connections status every 60 seconds."""
    print("[background_recorder] Starting background monitoring thread...")
    while True:
        try:
            url_base, token = get_proxy_config()
            url = f"{url_base}/1/summary"
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            
            resp = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
            if resp.ok:
                data = resp.json()
                hashrates = data.get("hashrate", {}).get("total", [])
                current_hashrate = hashrates[0] if hashrates else 0.0
                active_miners = data.get("miners", {}).get("now", 0)
                accepted = data.get("results", {}).get("accepted", 0)
                rejected = data.get("results", {}).get("rejected", 0)
                
                conn = get_db()
                conn.execute(
                    "INSERT INTO hashrate_history (timestamp, total_hashrate, active_miners, accepted_hashes, rejected_hashes) VALUES (?, ?, ?, ?, ?)",
                    (datetime.now(timezone.utc).isoformat(), current_hashrate, active_miners, accepted, rejected)
                )
                
                # Mantém apenas os últimos 1000 registros (~16 horas se for de 1 em 1 minuto)
                conn.execute("""
                    DELETE FROM hashrate_history WHERE id NOT IN (
                        SELECT id FROM hashrate_history ORDER BY timestamp DESC LIMIT 1000
                    )
                """)
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[background_recorder] Error logging history: {e}", file=sys.stderr)
            
        time.sleep(60)


@app.route("/api/history")
@api_login_required
def api_history():
    conn = get_db()
    rows = conn.execute(
        "SELECT timestamp, total_hashrate, active_miners, accepted_hashes, rejected_hashes FROM hashrate_history ORDER BY timestamp ASC"
    ).fetchall()
    conn.close()
    
    result = []
    for r in rows:
        result.append({
            "timestamp": r["timestamp"],
            "hashrate": r["total_hashrate"],
            "miners": r["active_miners"],
            "accepted": r["accepted_hashes"],
            "rejected": r["rejected_hashes"]
        })
    return jsonify(result)


# ---------------------------------------------------------------------------
# API para Gerenciamento de Usuários (CRUD)
# ---------------------------------------------------------------------------
@app.route("/api/users")
@api_login_required
def api_users():
    conn = get_db()
    users = conn.execute("SELECT id, username, role, created_at FROM users").fetchall()
    conn.close()
    return jsonify([dict(u) for u in users])


@app.route("/api/users", methods=["POST"])
@api_login_required
def api_create_user():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    role = data.get("role", "admin").strip()

    if not username or not password:
        return jsonify({"error": "validation", "message": "Username and password are required."}), 400

    if len(password) < 6:
        return jsonify({"error": "validation", "message": "Password must be at least 6 characters long."}), 400

    if create_user(username, password, role):
        return jsonify({"status": "success", "message": f"User '{username}' created successfully."})
    else:
        return jsonify({"error": "exists", "message": f"User '{username}' already exists."}), 400


@app.route("/api/users/<int:user_id>", methods=["DELETE"])
@api_login_required
def api_delete_user(user_id):
    if session.get("user_id") == user_id:
        return jsonify({"error": "self_delete", "message": "You cannot delete your own account."}), 400

    conn = get_db()
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return jsonify({"status": "success", "message": "User deleted successfully."})


# ---------------------------------------------------------------------------
# API para Configurações (XMRig Proxy URL e Token no DB)
# ---------------------------------------------------------------------------
@app.route("/api/settings")
@api_login_required
def api_get_settings():
    url, token = get_proxy_config()
    conn = get_db()
    db_url = conn.execute("SELECT value FROM settings WHERE key = 'xmrig_proxy_url'").fetchone()
    db_token = conn.execute("SELECT value FROM settings WHERE key = 'xmrig_api_token'").fetchone()
    conn.close()
    return jsonify({
        "db_proxy_url": db_url["value"] if db_url else "",
        "db_api_token": db_token["value"] if db_token else "",
        "env_proxy_url": XMRIG_PROXY_URL,
        "has_env_token": bool(XMRIG_API_TOKEN),
        "current_proxy_url": url,
    })


@app.route("/api/settings", methods=["POST"])
@api_login_required
def api_save_settings():
    data = request.get_json() or {}
    url = data.get("xmrig_proxy_url", "").strip().rstrip("/")
    token = data.get("xmrig_api_token", "").strip()

    conn = get_db()
    if url:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('xmrig_proxy_url', ?)", (url,))
    else:
        conn.execute("DELETE FROM settings WHERE key = 'xmrig_proxy_url'")

    if token:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('xmrig_api_token', ?)", (token,))
    else:
        conn.execute("DELETE FROM settings WHERE key = 'xmrig_api_token'")

    conn.commit()
    conn.close()
    return jsonify({"status": "success", "message": "Settings saved successfully."})


# ---------------------------------------------------------------------------
# API for Profit Estimation (XMR Price + Difficulty)
# ---------------------------------------------------------------------------
@app.route("/api/profit-estimation")
@api_login_required
def api_profit_estimation():
    now = time.time()
    # Cache for 5 minutes (300 seconds) to avoid rate limits
    if now - PROFIT_CACHE["last_fetched"] > 300 or not PROFIT_CACHE["price"] or not PROFIT_CACHE["difficulty"]:
        try:
            # 1. Fetch price in USD (CoinGecko)
            resp_cg = requests.get(
                "https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd",
                timeout=5
            )
            if resp_cg.ok:
                PROFIT_CACHE["price"] = resp_cg.json().get("monero", {}).get("usd", 150.0)
            
            # 2. Fetch network difficulty (HeroMiners API)
            resp_hm = requests.get(
                "https://monero.herominers.com/api/stats",
                timeout=5
            )
            if resp_hm.ok:
                PROFIT_CACHE["difficulty"] = resp_hm.json().get("network", {}).get("difficulty", 350000000000)
            
            PROFIT_CACHE["last_fetched"] = now
        except Exception as e:
            print(f"[profit_api] Error fetching market data: {e}", file=sys.stderr)
            # Fallbacks if APIs fail
            if not PROFIT_CACHE["price"]:
                PROFIT_CACHE["price"] = 150.0
            if not PROFIT_CACHE["difficulty"]:
                PROFIT_CACHE["difficulty"] = 350000000000

    price = PROFIT_CACHE["price"]
    difficulty = PROFIT_CACHE["difficulty"]

    # Get current hashrate
    hashrate_hs = request.args.get("hashrate", type=float)
    if hashrate_hs is None:
        data, error = xmrig_get("/1/summary")
        if not error and data:
            hashrates = data.get("hashrate", {}).get("total", [])
            # XMRig Proxy returns hashrates in H/s
            hashrate_khs = hashrates[0] if hashrates else 0.0
            hashrate_hs = hashrate_khs * 1000.0
        else:
            hashrate_hs = 0.0

    # Standard Monero reward formula
    xmr_per_day = (hashrate_hs * 86400 * 0.6) / difficulty if difficulty else 0.0
    usd_per_day = xmr_per_day * price

    return jsonify({
        "hashrate": hashrate_hs,
        "difficulty": difficulty,
        "price": price,
        "xmr_per_day": xmr_per_day,
        "usd_per_day": usd_per_day,
        "xmr_per_month": xmr_per_day * 30,
        "usd_per_month": usd_per_day * 30
    })


# ---------------------------------------------------------------------------
# API for XMRig Proxy Daemon and Config Management
# ---------------------------------------------------------------------------
PROXY_DIR = os.path.join(BASE_DIR, "proxy")
PROXY_BIN_NAME = "xmrig-proxy" if os.name != 'nt' else "xmrig-proxy.exe"
PROXY_BIN_PATH = os.path.join(PROXY_DIR, PROXY_BIN_NAME)
PID_FILE_PATH = os.path.join(PROXY_DIR, "proxy.pid")
LOG_FILE_PATH = os.path.join(PROXY_DIR, "proxy.log")
PROXY_CONFIG_PATH = os.path.join(PROXY_DIR, "config.json")


def get_proxy_pid():
    if os.path.exists(PID_FILE_PATH):
        try:
            with open(PID_FILE_PATH, "r") as f:
                return int(f.read().strip())
        except ValueError:
            pass
    return None


def check_process_active(pid):
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


@app.route("/api/proxy/status")
@api_login_required
def api_proxy_status():
    pid = get_proxy_pid()
    active = check_process_active(pid)
    
    logs = ""
    if os.path.exists(LOG_FILE_PATH):
        try:
            with open(LOG_FILE_PATH, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()
                logs = "".join(lines[-25:])
        except Exception as e:
            logs = f"Error reading logs: {e}"
            
    return jsonify({
        "status": "running" if active else "stopped",
        "pid": pid if active else None,
        "logs": logs
    })


@app.route("/api/proxy/start", methods=["POST"])
@api_login_required
def api_proxy_start():
    pid = get_proxy_pid()
    if check_process_active(pid):
        return jsonify({"status": "running", "message": "Proxy is already running."})

    if not os.path.exists(PROXY_BIN_PATH):
        return jsonify({"error": "bin_missing", "message": f"Proxy binary not found at: {PROXY_BIN_PATH}"}), 404

    # Make executable on Unix
    if os.name != 'nt':
        try:
            os.chmod(PROXY_BIN_PATH, 0o755)
        except Exception:
            pass

    try:
        log_f = open(LOG_FILE_PATH, "a", encoding="utf-8")
        
        creation_flags = 0
        if os.name == 'nt':
            creation_flags = 0x08000000  # CREATE_NO_WINDOW

        p = subprocess.Popen(
            [PROXY_BIN_PATH],
            cwd=PROXY_DIR,
            stdout=log_f,
            stderr=log_f,
            creationflags=creation_flags
        )
        
        with open(PID_FILE_PATH, "w") as f:
            f.write(str(p.pid))
            
        return jsonify({"status": "success", "message": "Proxy started successfully."})
    except Exception as e:
        return jsonify({"error": "start_failed", "message": f"Failed to start proxy: {e}"}), 500


@app.route("/api/proxy/stop", methods=["POST"])
@api_login_required
def api_proxy_stop():
    pid = get_proxy_pid()
    if not check_process_active(pid):
        if os.path.exists(PID_FILE_PATH):
            os.remove(PID_FILE_PATH)
        return jsonify({"status": "stopped", "message": "Proxy is already stopped."})

    try:
        if os.name == 'nt':
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            os.kill(pid, signal.SIGTERM)
            for _ in range(20):
                time.sleep(0.1)
                if not check_process_active(pid):
                    break
            else:
                os.kill(pid, signal.SIGKILL)
                
        if os.path.exists(PID_FILE_PATH):
            os.remove(PID_FILE_PATH)
            
        return jsonify({"status": "success", "message": "Proxy stopped successfully."})
    except Exception as e:
        return jsonify({"error": "stop_failed", "message": f"Failed to stop proxy: {e}"}), 500


@app.route("/api/proxy/config")
@api_login_required
def api_get_proxy_config():
    if not os.path.exists(PROXY_CONFIG_PATH):
        return jsonify({"error": "not_found", "message": "config.json not found in proxy folder."}), 404
        
    try:
        with open(PROXY_CONFIG_PATH, "r") as f:
            config = json.load(f)
    except Exception as e:
        return jsonify({"error": "parse_error", "message": f"Failed to read config.json: {e}"}), 500

    pools = config.get("pools", [])
    pool = pools[0] if pools else {}
    
    bind_list = config.get("bind", [])
    bind = bind_list[0] if bind_list else {}
    
    http = config.get("http", {})

    return jsonify({
        "pool_url": pool.get("url", ""),
        "pool_user": pool.get("user", ""),
        "pool_pass": pool.get("pass", "x"),
        "pool_tls": pool.get("tls", False),
        
        "bind_port": bind.get("port", 3333),
        "bind_host": bind.get("host", "0.0.0.0"),
        
        "api_port": http.get("port", 0),
        "api_token": http.get("access-token", ""),
        
        "donate_level": config.get("donate-level", 0),
        "verbose": config.get("verbose", False)
    })


@app.route("/api/proxy/config", methods=["POST"])
@api_login_required
def api_save_proxy_config():
    if not os.path.exists(PROXY_CONFIG_PATH):
        return jsonify({"error": "not_found", "message": "config.json not found."}), 404

    data = request.get_json() or {}
    
    try:
        with open(PROXY_CONFIG_PATH, "r") as f:
            config = json.load(f)
    except Exception as e:
        return jsonify({"error": "parse_error", "message": f"Failed to read config.json: {e}"}), 500

    # Update pools
    if "pools" not in config or not config["pools"]:
        config["pools"] = [{}]
    config["pools"][0]["url"] = data.get("pool_url", config["pools"][0].get("url", ""))
    config["pools"][0]["user"] = data.get("pool_user", config["pools"][0].get("user", ""))
    config["pools"][0]["pass"] = data.get("pool_pass", config["pools"][0].get("pass", "x"))
    config["pools"][0]["tls"] = bool(data.get("pool_tls", config["pools"][0].get("tls", False)))

    # Update bind
    if "bind" not in config or not config["bind"]:
        config["bind"] = [{}]
    config["bind"][0]["port"] = int(data.get("bind_port", config["bind"][0].get("port", 3333)))
    config["bind"][0]["host"] = data.get("bind_host", config["bind"][0].get("host", "0.0.0.0"))
    
    if len(config["bind"]) > 1:
        config["bind"][1]["port"] = int(data.get("bind_port", config["bind"][1].get("port", 3333)))

    # Update http api
    if "http" not in config:
        config["http"] = {}
    
    api_port = int(data.get("api_port", 0))
    config["http"]["port"] = api_port
    config["http"]["access-token"] = data.get("api_token", config["http"].get("access-token", ""))
    config["http"]["enabled"] = api_port > 0

    # Update other parameters
    config["donate-level"] = int(data.get("donate_level", config.get("donate-level", 0)))
    config["verbose"] = bool(data.get("verbose", config.get("verbose", False)))

    try:
        with open(PROXY_CONFIG_PATH, "w") as f:
            json.dump(config, f, indent=4)
        return jsonify({"status": "success", "message": "config.json updated successfully."})
    except Exception as e:
        return jsonify({"error": "write_error", "message": f"Failed to write config.json: {e}"}), 500


# ---------------------------------------------------------------------------
# CLI utility: python main.py create-admin <username> <password>
# ---------------------------------------------------------------------------
def _cli():
    if len(sys.argv) >= 2 and sys.argv[1] == "create-admin":
        if len(sys.argv) != 4:
            print("Usage: python main.py create-admin <username> <password>")
            sys.exit(1)
        init_db()
        username, password = sys.argv[2], sys.argv[3]
        if create_user(username, password, role="admin"):
            print(f"User '{username}' created successfully.")
        else:
            print(f"User '{username}' already exists.")
        sys.exit(0)


if __name__ == "__main__":
    _cli()
    init_db()
    
    # Inicia a gravação em background do hashrate apenas no processo principal do Flask
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or os.environ.get("FLASK_DEBUG", "0") == "0":
        recorder_thread = threading.Thread(target=background_hashrate_recorder, daemon=True)
        recorder_thread.start()
        
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
    )
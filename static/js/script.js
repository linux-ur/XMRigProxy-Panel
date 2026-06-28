// NV Proxy Dashboard - Main Script (English)

// --- State Variables ---
let hashrateChart = null;
let minersChart = null;
let connectedMinersList = [];
let currentDifficulty = 350000000000;
let currentXmrPrice = 150.0;

// --- Formatting Helpers ---
function formatHashrate(value) {
    if (value === null || value === undefined) return '--';
    if (!value) return '0 H/s';
    if (value >= 1000000) return (value / 1000000).toFixed(2) + ' MH/s';
    if (value >= 1000) return (value / 1000).toFixed(2) + ' KH/s';
    return value.toFixed(2) + ' H/s';
}

function formatBytes(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' B';
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${days}d ${hours}h ${minutes}m`;
}

function formatNumber(num) {
    if (num === null || num === undefined) return '--';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTime(isoString) {
    try {
        const d = new Date(isoString);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
        return '';
    }
}

function getStatusClass(data) {
    if (!data || !data.miners) return 'status-offline';
    if (data.miners.now === 0) return 'status-offline';
    if (data.miners.now < data.miners.max * 0.5) return 'status-warning';
    return 'status-online';
}

function getStatusText(data) {
    if (!data || !data.miners) return 'Offline';
    if (data.miners.now === 0) return 'Offline';
    if (data.miners.now < data.miners.max * 0.5) return 'Warning';
    return 'Online';
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '--';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function statusBadgeHtml(status) {
    const map = {
        online: ['status-online', 'Online'],
        offline: ['status-offline', 'Offline'],
        unknown: ['status-warning', 'Unknown'],
    };
    const [cls, label] = map[status] || map.unknown;
    return `<span class="status-badge ${cls}">${label}</span>`;
}

// --- Fetch Utility ---
async function fetchJson(path) {
    const response = await fetch(path);
    if (response.status === 401) {
        window.location.href = '/login';
        return null;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.message || `HTTP ${response.status}`);
    }
    return body;
}

// --- Toast Alerts ---
function showToast(title, message, type = 'success') {
    const container = document.getElementById('alertContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `alert-toast toast-${type}`;
    
    let icon = 'info';
    if (type === 'success') icon = 'check-circle-2';
    if (type === 'error') icon = 'alert-triangle';
    if (type === 'warning') icon = 'alert-circle';

    toast.innerHTML = `
        <i data-lucide="${icon}"></i>
        <div class="toast-content">
            <div class="toast-title">${escapeHtml(title)}</div>
            <div class="toast-msg">${escapeHtml(message)}</div>
        </div>
    `;
    
    container.appendChild(toast);
    lucide.createIcons();
    
    setTimeout(() => {
        toast.classList.add('toast-leave');
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

// ==========================================================================
// 1. OVERVIEW
// ==========================================================================
function renderOverview(data) {
    const container = document.getElementById('dashboardOverview');
    
    const statusBadge = document.getElementById('statusBadge');
    statusBadge.className = 'status-badge ' + getStatusClass(data);
    statusBadge.textContent = getStatusText(data);
    
    document.getElementById('workerId').innerHTML = `<i data-lucide="cpu" class="inline-icon"></i> Worker: <span class="worker-emphasis">${escapeHtml(data.worker_id)}</span> / Version: <span class="worker-emphasis">${escapeHtml(data.version)}</span>`;
    
    const hashrates = (data.hashrate && data.hashrate.total) || [];
    const maxHashrate = Math.max(...hashrates, 0.0001);
    const hashrateBarHTML = hashrates.map(h => {
        const height = (h / maxHashrate * 100);
        return `<div class="hashrate-bar" style="height: ${height}%" title="${formatHashrate(h)}"></div>`;
    }).join('');

    const memoryUsedPercent = ((data.resources.memory.total - data.resources.memory.free) / data.resources.memory.total * 100).toFixed(1);
    const acceptanceRate = (data.results.accepted / (data.results.accepted + data.results.rejected) * 100 || 0).toFixed(2);

    container.innerHTML = `
        <div class="grid">
            <div class="card">
                <div class="card-title">Current Hashrate</div>
                <div class="card-value highlight-green">${formatHashrate(hashrates[0])}</div>
                <div class="card-label">10s average</div>
                <div class="hashrate-chart">${hashrateBarHTML}</div>
            </div>
            <div class="card">
                <div class="card-title">Active Miners</div>
                <div class="card-value ${data.miners.now > 0 ? 'highlight-green' : 'highlight-red'}">${formatNumber(data.miners.now)}</div>
                <div class="card-label">Peak: ${formatNumber(data.miners.max)} rigs</div>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${(data.miners.now / data.miners.max * 100 || 0)}%"></div>
                </div>
            </div>
            <div class="card">
                <div class="card-title">Upstream Workers</div>
                <div class="card-value highlight-blue">${data.workers}</div>
                <div class="card-label">Ratio: ${data.upstreams.ratio.toFixed(1)} miners / upstream</div>
            </div>
            <div class="card">
                <div class="card-title">Uptime</div>
                <div class="card-value">${formatUptime(data.uptime)}</div>
                <div class="card-label">Since last restart</div>
            </div>
        </div>
        <div class="grid">
            <div class="card large-card">
                <div class="card-header-flex">
                    <div>
                        <h3 class="card-title">Hashrate Performance</h3>
                        <span class="card-label">Historical averages compiled by proxy</span>
                    </div>
                </div>
                <div class="metrics-grid">
                    <div class="metric-item"><div class="metric-value highlight-green">${formatHashrate(hashrates[0])}</div><div class="metric-label">10 Seconds</div></div>
                    <div class="metric-item"><div class="metric-value">${formatHashrate(hashrates[1])}</div><div class="metric-label">1 Minute</div></div>
                    <div class="metric-item"><div class="metric-value">${formatHashrate(hashrates[2])}</div><div class="metric-label">15 Minutes</div></div>
                    <div class="metric-item"><div class="metric-value">${formatHashrate(hashrates[3])}</div><div class="metric-label">1 Hour</div></div>
                    <div class="metric-item"><div class="metric-value">${formatHashrate(hashrates[4])}</div><div class="metric-label">12 Hours</div></div>
                    <div class="metric-item"><div class="metric-value">${formatHashrate(hashrates[5])}</div><div class="metric-label">24 Hours</div></div>
                </div>
            </div>
        </div>
        <div class="grid double-grid">
            <div class="card">
                <div class="card-title">Server Resources</div>
                <div class="stat-row"><span class="stat-label">Memory Used</span><span class="stat-value">${formatBytes(data.resources.memory.total - data.resources.memory.free)}</span></div>
                <div class="progress-bar"><div class="progress-fill" style="width: ${memoryUsedPercent}%"></div></div>
                <div class="stat-row spaced"><span class="stat-label">Total Memory</span><span class="stat-value">${formatBytes(data.resources.memory.total)}</span></div>
                <div class="stat-row"><span class="stat-label">RSS Memory</span><span class="stat-value">${formatBytes(data.resources.memory.resident_set_memory)}</span></div>
                <div class="stat-row"><span class="stat-label">Load Average</span><span class="stat-value">${data.resources.load_average.join(' / ')}</span></div>
                <div class="stat-row"><span class="stat-label">CPU Cores</span><span class="stat-value">${data.resources.hardware_concurrency} Cores</span></div>
            </div>
            <div class="card">
                <div class="card-title">Upstream Pools</div>
                <div class="stat-row"><span class="stat-label">Active</span><span class="stat-value highlight-green">${data.upstreams.active}</span></div>
                <div class="stat-row"><span class="stat-label">Sleeping</span><span class="stat-value">${data.upstreams.sleep}</span></div>
                <div class="stat-row"><span class="stat-label">Error</span><span class="stat-value ${data.upstreams.error > 0 ? 'highlight-red' : ''}">${data.upstreams.error}</span></div>
                <div class="stat-row"><span class="stat-label">Total</span><span class="stat-value">${data.upstreams.total}</span></div>
                <div class="stat-row"><span class="stat-label">Avg Miners/Pool</span><span class="stat-value">${data.upstreams.ratio.toFixed(1)}</span></div>
            </div>
        </div>
        <div class="grid">
            <div class="card large-card">
                <div class="card-title">Mining Results</div>
                <div class="metrics-grid">
                    <div class="metric-item"><div class="metric-value highlight-green">${formatNumber(data.results.accepted)}</div><div class="metric-label">Accepted</div></div>
                    <div class="metric-item"><div class="metric-value highlight-red">${formatNumber(data.results.rejected)}</div><div class="metric-label">Rejected</div></div>
                    <div class="metric-item"><div class="metric-value highlight-yellow">${formatNumber(data.results.invalid)}</div><div class="metric-label">Invalid</div></div>
                    <div class="metric-item"><div class="metric-value">${formatNumber(data.results.expired)}</div><div class="metric-label">Expired</div></div>
                    <div class="metric-item"><div class="metric-value highlight-blue">${acceptanceRate}%</div><div class="metric-label">Acceptance Rate</div></div>
                    <div class="metric-item"><div class="metric-value">${data.results.latency} ms</div><div class="metric-label">Pool Latency</div></div>
                </div>
                <div class="stat-row spaced"><span class="stat-label">Total Hashes Submitted</span><span class="stat-value">${formatNumber(data.results.hashes_total)}</span></div>
                <div class="stat-row"><span class="stat-label">Average Submission Time</span><span class="stat-value">${data.results.avg_time} sec</span></div>
            </div>
        </div>
    `;
    container.className = 'tab-pane active';
    lucide.createIcons();
}

function showSummaryError(message) {
    const container = document.getElementById('dashboardOverview');
    container.innerHTML = `
        <div class="card large-card">
            <div class="error">
                <div class="error-title">Failed to connect to XMRig Proxy:</div>
                <div>${escapeHtml(message)}</div>
            </div>
            <p class="error-help">
                Check if the proxy process is running and the URL/Token are correct in <strong>Settings</strong>.
            </p>
        </div>
    `;
    container.className = 'tab-pane active';
    document.getElementById('statusBadge').className = 'status-badge status-offline';
    document.getElementById('statusBadge').textContent = 'Offline';
}

// ==========================================================================
// 2. ANALYTICS
// ==========================================================================
async function loadAnalyticsData() {
    try {
        const history = await fetchJson('/api/history');
        if (history && history.length > 0) {
            const labels = history.map(h => formatTime(h.timestamp));
            const hashrates = history.map(h => h.hashrate);
            const miners = history.map(h => h.miners);
            if (hashrateChart) { hashrateChart.data.labels = labels; hashrateChart.data.datasets[0].data = hashrates; hashrateChart.update(); }
            if (minersChart) { minersChart.data.labels = labels; minersChart.data.datasets[0].data = miners; minersChart.update(); }
        }
        const profit = await fetchJson('/api/profit-estimation');
        if (profit) {
            currentDifficulty = profit.difficulty;
            currentXmrPrice = profit.price;
            document.getElementById('networkDifficultyVal').textContent = formatNumber(profit.difficulty);
            document.getElementById('xmrPriceVal').textContent = '$' + profit.price.toFixed(2) + ' USD';
            const initialKhs = (profit.hashrate / 1000) || 50.0;
            document.getElementById('calcHashrateInput').value = initialKhs.toFixed(2);
            document.getElementById('calcHashrateUnit').value = 'KH';
            updateCalculatedProfit();
        }
    } catch (e) {
        showToast('Connection Error', 'Could not load Analytics data: ' + e.message, 'error');
    }
}

function updateCalculatedProfit() {
    const hashrateVal = parseFloat(document.getElementById('calcHashrateInput').value) || 0;
    const unit = document.getElementById('calcHashrateUnit').value;
    let multiplier = 1;
    if (unit === 'KH') multiplier = 1000;
    if (unit === 'MH') multiplier = 1000000;
    const hashrateHs = hashrateVal * multiplier;
    const xmrDay = (hashrateHs * 86400 * 0.6) / currentDifficulty;
    const usdDay = xmrDay * currentXmrPrice;
    document.getElementById('profitDayXmr').textContent = xmrDay.toFixed(5) + ' XMR';
    document.getElementById('profitDayUsd').textContent = '$' + usdDay.toFixed(2) + ' USD';
    document.getElementById('profitMonthXmr').textContent = (xmrDay * 30).toFixed(5) + ' XMR';
    document.getElementById('profitMonthUsd').textContent = '$' + (usdDay * 30).toFixed(2) + ' USD';
}

// ==========================================================================
// 3. MINERS
// ==========================================================================
async function loadMinersData() {
    try {
        const payload = await fetchJson('/api/connected-miners');
        if (payload) {
            connectedMinersList = payload.miners || [];
            renderMinersTable();
        }
    } catch (e) {
        document.getElementById('minersTableBody').innerHTML = `<tr><td colspan="10" class="error-state">Error loading miners: ${escapeHtml(e.message)}</td></tr>`;
    }
}

function renderMinersTable() {
    const query = document.getElementById('minersSearchInput').value.toLowerCase().trim();
    const tbody = document.getElementById('minersTableBody');
    const filtered = connectedMinersList.filter(m => {
        const s = [m.worker_name, m.rig_id, m.ip, m.agent].map(x => (x || '').toLowerCase()).join(' ');
        return s.includes(query);
    });
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="empty-state">No miners connected or matching search.</td></tr>`;
        return;
    }
    tbody.innerHTML = filtered.map(r => `
        <tr>
            <td class="cell-strong">${escapeHtml(r.worker_name)}</td>
            <td>${escapeHtml(r.rig_id)}</td>
            <td>${escapeHtml(r.ip)}</td>
            <td>${formatHashrate(r.hashrate_10s)}</td>
            <td>${formatHashrate(r.hashrate_1m)}</td>
            <td class="highlight-green">${formatNumber(r.accepted)}</td>
            <td class="highlight-red">${formatNumber(r.rejected)}</td>
            <td>${r.difficulty ?? '--'}</td>
            <td class="cell-muted" title="${escapeHtml(r.agent)}">${escapeHtml(r.agent ? (r.agent.length > 20 ? r.agent.substring(0, 20) + '...' : r.agent) : '--')}</td>
            <td>${statusBadgeHtml(r.status)}</td>
        </tr>
    `).join('');
    lucide.createIcons();
}

// ==========================================================================
// 4. USERS CRUD
// ==========================================================================
async function loadUsersData() {
    try {
        const users = await fetchJson('/api/users');
        const tbody = document.getElementById('usersTableBody');
        if (!users || users.length === 0) { tbody.innerHTML = `<tr><td colspan="4" class="empty-state">No users registered.</td></tr>`; return; }
        tbody.innerHTML = users.map(u => `
            <tr>
                <td class="cell-strong">${escapeHtml(u.username)}</td>
                <td><span class="status-badge status-online">${escapeHtml(u.role)}</span></td>
                <td class="cell-muted">${new Date(u.created_at).toLocaleString('en-US')}</td>
                <td class="cell-center">
                    <button class="btn-delete-icon" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')" title="Delete user">
                        <i data-lucide="trash-2"></i>
                    </button>
                </td>
            </tr>
        `).join('');
        lucide.createIcons();
    } catch (e) { showToast('Load Error', 'Failed to fetch users: ' + e.message, 'error'); }
}

window.deleteUser = async function(id, username) {
    if (!confirm(`Are you sure you want to delete user "${username}"?`)) return;
    try {
        const response = await fetch(`/api/users/${id}`, { method: 'DELETE' });
        const res = await response.json();
        if (response.ok) { showToast('Success', res.message, 'success'); loadUsersData(); }
        else { showToast('Error', res.message || 'Could not delete user.', 'error'); }
    } catch (e) { showToast('Network Error', 'Connection failed: ' + e.message, 'error'); }
};

// ==========================================================================
// 5. SETTINGS — Connection Override
// ==========================================================================
async function loadSettingsData() {
    try {
        const settings = await fetchJson('/api/settings');
        if (!settings) return;
        document.getElementById('settingsProxyUrl').value = settings.db_proxy_url || '';
        document.getElementById('settingsProxyToken').value = '';
        document.getElementById('settingsProxyToken').placeholder = settings.db_api_token ? '•••••••• (Overriding .env)' : 'Fill to override...';
        document.getElementById('hintEnvUrl').innerHTML = `Default from .env: <code>${escapeHtml(settings.env_proxy_url)}</code>`;
        document.getElementById('hintEnvToken').innerHTML = `.env status: <code>${settings.has_env_token ? 'Configured' : 'Empty / Not set'}</code>`;
    } catch (e) { showToast('Config Error', 'Could not load settings: ' + e.message, 'error'); }
}

// ==========================================================================
// 6. SETTINGS — Proxy Daemon Control
// ==========================================================================
async function loadProxyStatus() {
    try {
        const data = await fetchJson('/api/proxy/status');
        if (!data) return;
        const badge = document.getElementById('proxyProcessBadge');
        const terminal = document.getElementById('proxyLogsTerminal');
        if (data.status === 'running') {
            badge.className = 'status-badge status-online';
            badge.textContent = `Running (PID ${data.pid})`;
        } else {
            badge.className = 'status-badge status-offline';
            badge.textContent = 'Stopped';
        }
        terminal.textContent = data.logs || 'No logs available.';
        terminal.scrollTop = terminal.scrollHeight;
    } catch (e) { /* silent fail on status poll */ }
}

// ==========================================================================
// 7. SETTINGS — Config.json Editor
// ==========================================================================
async function loadProxyConfig() {
    try {
        const cfg = await fetchJson('/api/proxy/config');
        if (!cfg) return;
        document.getElementById('cfgPoolUrl').value = cfg.pool_url || '';
        document.getElementById('cfgPoolUser').value = cfg.pool_user || '';
        document.getElementById('cfgPoolPass').value = cfg.pool_pass || 'x';
        document.getElementById('cfgPoolTls').checked = !!cfg.pool_tls;
        document.getElementById('cfgBindPort').value = cfg.bind_port || 3333;
        document.getElementById('cfgBindHost').value = cfg.bind_host || '0.0.0.0';
        document.getElementById('cfgApiPort').value = cfg.api_port || 0;
        document.getElementById('cfgApiToken').value = cfg.api_token || '';
        document.getElementById('cfgDonateLevel').value = cfg.donate_level ?? 0;
        document.getElementById('cfgVerbose').checked = !!cfg.verbose;
    } catch (e) { showToast('Config Error', 'Could not load proxy config.json: ' + e.message, 'error'); }
}

// ==========================================================================
// Chart.js Initialization
// ==========================================================================
function getThemeValue(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function makeChartGradient(context, startColor, endColor) {
    const gradient = context.createLinearGradient(0, 0, 0, 250);
    gradient.addColorStop(0, startColor);
    gradient.addColorStop(1, endColor);
    return gradient;
}

function getChartPalette() {
    return {
        primary: getThemeValue('--chart-primary') || '#e4e4e7',
        primaryFillStart: getThemeValue('--chart-primary-fill-start') || 'rgba(228, 228, 231, 0.12)',
        primaryFillEnd: getThemeValue('--chart-primary-fill-end') || 'rgba(228, 228, 231, 0)',
        secondary: getThemeValue('--chart-secondary') || '#34d399',
        secondaryFillStart: getThemeValue('--chart-secondary-fill-start') || 'rgba(52, 211, 153, 0.16)',
        secondaryFillEnd: getThemeValue('--chart-secondary-fill-end') || 'rgba(52, 211, 153, 0)',
        grid: getThemeValue('--chart-grid') || 'rgba(167, 139, 250, 0.08)',
        tick: getThemeValue('--chart-tick') || '#aaa3ba',
        border: getThemeValue('--border') || '#292638',
        tooltipBg: getThemeValue('--chart-tooltip-bg') || '#161320',
        tooltipText: getThemeValue('--chart-tooltip-text') || '#f7f4ff'
    };
}

function chartOptions(palette) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        animation: { duration: 650, easing: 'easeOutQuart' },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: palette.tooltipBg,
                borderColor: palette.border,
                borderWidth: 1,
                cornerRadius: 0,
                titleColor: palette.tooltipText,
                bodyColor: palette.tooltipText,
                displayColors: false,
                padding: 10
            }
        },
        scales: {
            x: {
                border: { color: palette.border },
                grid: { color: palette.grid, drawTicks: false },
                ticks: { color: palette.tick, font: { family: 'Outfit', size: 11 }, padding: 8 }
            },
            y: {
                border: { color: palette.border },
                grid: { color: palette.grid, drawTicks: false },
                ticks: { color: palette.tick, font: { family: 'Outfit', size: 11 }, padding: 8 }
            }
        }
    };
}

function updateChartsForTheme() {
    if (!hashrateChart || !minersChart) return;

    const palette = getChartPalette();
    hashrateChart.data.datasets[0].borderColor = palette.primary;
    hashrateChart.data.datasets[0].backgroundColor = makeChartGradient(
        hashrateChart.ctx,
        palette.primaryFillStart,
        palette.primaryFillEnd
    );
    hashrateChart.options = chartOptions(palette);

    minersChart.data.datasets[0].borderColor = palette.secondary;
    minersChart.data.datasets[0].backgroundColor = makeChartGradient(
        minersChart.ctx,
        palette.secondaryFillStart,
        palette.secondaryFillEnd
    );
    const minersOptions = chartOptions(palette);
    minersOptions.scales.y.ticks.stepSize = 1;
    minersChart.options = minersOptions;

    hashrateChart.update();
    minersChart.update();
}

function initCharts() {
    const ctxHash = document.getElementById('hashrateChartCanvas');
    const ctxMiners = document.getElementById('minersChartCanvas');
    if (!ctxHash || !ctxMiners) return;

    const hashContext = ctxHash.getContext('2d');
    const minersContext = ctxMiners.getContext('2d');
    const palette = getChartPalette();
    const commonOpts = chartOptions(palette);

    hashrateChart = new Chart(ctxHash, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Hashrate (H/s)', data: [], borderColor: palette.primary, backgroundColor: makeChartGradient(hashContext, palette.primaryFillStart, palette.primaryFillEnd), borderWidth: 2, fill: true, tension: 0.42, pointStyle: 'rect', pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12 }] },
        options: commonOpts
    });

    minersChart = new Chart(ctxMiners, {
        type: 'line',
        data: { labels: [], datasets: [{ label: 'Active Connections', data: [], borderColor: palette.secondary, backgroundColor: makeChartGradient(minersContext, palette.secondaryFillStart, palette.secondaryFillEnd), borderWidth: 2, fill: true, tension: 0.42, pointStyle: 'rect', pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 12 }] },
        options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, ticks: { ...commonOpts.scales.y.ticks, stepSize: 1 } } } }
    });
}

// ==========================================================================
// Core Data Polling
// ==========================================================================
async function fetchData() {
    try {
        const summary = await fetchJson('/api/summary');
        if (summary) renderOverview(summary);
    } catch (error) {
        console.error('Summary fetch error:', error);
        showSummaryError(error.message);
    }
    document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();
}

// ==========================================================================
// Initialization & Event Listeners
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    initCharts();
    lucide.createIcons();
    window.addEventListener('nv-theme-change', updateChartsForTheme);

    // --- Tab Navigation ---
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            const sidebar = document.getElementById('sidebarMenu');
            if (sidebar) sidebar.classList.remove('open');
            const tabName = item.getAttribute('data-tab');
            if (!tabName) return;
            document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
            const activePane = document.getElementById(`tab-${tabName}`);
            if (activePane) activePane.classList.add('active');
            const titleSpan = item.querySelector('span') || item;
            document.getElementById('pageActiveTitle').textContent = titleSpan.textContent.trim();

            if (tabName === 'overview') fetchData();
            else if (tabName === 'analytics') loadAnalyticsData();
            else if (tabName === 'miners') loadMinersData();
            else if (tabName === 'users') loadUsersData();
            else if (tabName === 'settings') { loadSettingsData(); loadProxyStatus(); loadProxyConfig(); }
        });
    });

    // --- Mobile Sidebar Toggle ---
    document.getElementById('menuToggle').addEventListener('click', () => {
        const sidebar = document.getElementById('sidebarMenu');
        if (sidebar) sidebar.classList.toggle('open');
    });

    // --- Manual Refresh ---
    document.getElementById('manualRefreshBtn').addEventListener('click', () => {
        const icon = document.getElementById('manualRefreshBtn');
        icon.style.transition = 'transform 0.5s ease';
        icon.style.transform = 'rotate(360deg)';
        setTimeout(() => { icon.style.transition = 'none'; icon.style.transform = 'rotate(0deg)'; }, 500);
        const activeTabItem = document.querySelector('.nav-item.active');
        const tabName = activeTabItem ? activeTabItem.getAttribute('data-tab') : 'overview';
        if (tabName === 'overview') fetchData();
        else if (tabName === 'analytics') loadAnalyticsData();
        else if (tabName === 'miners') loadMinersData();
        else if (tabName === 'users') loadUsersData();
        else if (tabName === 'settings') { loadSettingsData(); loadProxyStatus(); loadProxyConfig(); }
        showToast('Refreshed', 'Data for the active tab has been reloaded.', 'success');
    });

    // --- Profit Calculator Live Inputs ---
    const calcInput = document.getElementById('calcHashrateInput');
    const calcUnit = document.getElementById('calcHashrateUnit');
    if (calcInput && calcUnit) {
        calcInput.addEventListener('input', updateCalculatedProfit);
        calcUnit.addEventListener('change', updateCalculatedProfit);
    }

    // --- Miners Search ---
    const searchInput = document.getElementById('minersSearchInput');
    if (searchInput) searchInput.addEventListener('input', renderMinersTable);

    // --- Create User Form ---
    const userForm = document.getElementById('createUserForm');
    if (userForm) {
        userForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('newUsername').value.trim();
            const password = document.getElementById('newPassword').value;
            const role = document.getElementById('newRole').value;
            try {
                const response = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role }) });
                const res = await response.json();
                if (response.ok) { showToast('Success', res.message, 'success'); userForm.reset(); loadUsersData(); }
                else { showToast('Error', res.message || 'Error creating account.', 'error'); }
            } catch (e) { showToast('Network Error', 'API connection failed: ' + e.message, 'error'); }
        });
    }

    // --- Settings Override Form ---
    const settingsForm = document.getElementById('settingsForm');
    if (settingsForm) {
        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const url = document.getElementById('settingsProxyUrl').value.trim();
            const token = document.getElementById('settingsProxyToken').value.trim();
            try {
                const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xmrig_proxy_url: url, xmrig_api_token: token }) });
                const res = await response.json();
                if (response.ok) { showToast('Success', res.message, 'success'); loadSettingsData(); fetchData(); }
                else { showToast('Error', res.message || 'Error saving settings.', 'error'); }
            } catch (e) { showToast('Connection Error', 'Failed to save: ' + e.message, 'error'); }
        });
        const resetBtn = document.getElementById('resetSettingsBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', async () => {
                if (!confirm('Clear database overrides and restore defaults from .env file?')) return;
                try {
                    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ xmrig_proxy_url: '', xmrig_api_token: '' }) });
                    const res = await response.json();
                    if (response.ok) { showToast('Success', 'Overrides cleared. Using .env defaults.', 'success'); loadSettingsData(); fetchData(); }
                    else { showToast('Error', res.message || 'Error restoring settings.', 'error'); }
                } catch (e) { showToast('Connection Error', 'Failed to restore: ' + e.message, 'error'); }
            });
        }
    }

    // --- Proxy Daemon Start/Stop ---
    const startBtn = document.getElementById('startProxyBtn');
    const stopBtn = document.getElementById('stopProxyBtn');
    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            startBtn.disabled = true;
            startBtn.textContent = 'Starting...';
            try {
                const response = await fetch('/api/proxy/start', { method: 'POST' });
                const res = await response.json();
                if (response.ok) { showToast('Success', res.message, 'success'); }
                else { showToast('Error', res.message || 'Could not start proxy.', 'error'); }
            } catch (e) { showToast('Network Error', e.message, 'error'); }
            startBtn.disabled = false;
            startBtn.innerHTML = '<i data-lucide="play"></i> Start Proxy';
            lucide.createIcons();
            setTimeout(loadProxyStatus, 1500);
        });
    }
    if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to stop the proxy daemon?')) return;
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
            try {
                const response = await fetch('/api/proxy/stop', { method: 'POST' });
                const res = await response.json();
                if (response.ok) { showToast('Success', res.message, 'success'); }
                else { showToast('Error', res.message || 'Could not stop proxy.', 'error'); }
            } catch (e) { showToast('Network Error', e.message, 'error'); }
            stopBtn.disabled = false;
            stopBtn.innerHTML = '<i data-lucide="square"></i> Stop Proxy';
            lucide.createIcons();
            setTimeout(loadProxyStatus, 1500);
        });
    }

    // --- Refresh Logs Button ---
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    if (refreshLogsBtn) {
        refreshLogsBtn.addEventListener('click', () => {
            loadProxyStatus();
            showToast('Logs Refreshed', 'Daemon output has been reloaded.', 'success');
        });
    }

    // --- Proxy Config.json Form ---
    const proxyConfigForm = document.getElementById('proxyConfigForm');
    if (proxyConfigForm) {
        proxyConfigForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                pool_url: document.getElementById('cfgPoolUrl').value.trim(),
                pool_user: document.getElementById('cfgPoolUser').value.trim(),
                pool_pass: document.getElementById('cfgPoolPass').value.trim() || 'x',
                pool_tls: document.getElementById('cfgPoolTls').checked,
                bind_port: parseInt(document.getElementById('cfgBindPort').value) || 3333,
                bind_host: document.getElementById('cfgBindHost').value.trim() || '0.0.0.0',
                api_port: parseInt(document.getElementById('cfgApiPort').value) || 0,
                api_token: document.getElementById('cfgApiToken').value.trim(),
                donate_level: parseInt(document.getElementById('cfgDonateLevel').value) || 0,
                verbose: document.getElementById('cfgVerbose').checked
            };
            try {
                const response = await fetch('/api/proxy/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                const res = await response.json();
                if (response.ok) { showToast('Success', res.message, 'success'); }
                else { showToast('Error', res.message || 'Failed to save config.json.', 'error'); }
            } catch (e) { showToast('Network Error', 'Failed to save config: ' + e.message, 'error'); }
        });
    }

    // --- Bootstrap ---
    fetchData();

    // --- Auto-Refresh (active tab only) ---
    setInterval(() => {
        const activeTabItem = document.querySelector('.nav-item.active');
        const tabName = activeTabItem ? activeTabItem.getAttribute('data-tab') : 'overview';
        if (tabName === 'overview') fetchData();
        else if (tabName === 'miners') loadMinersData();
    }, 10000);
});

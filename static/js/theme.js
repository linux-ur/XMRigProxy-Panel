// Shared color theme controller.
(function () {
    const storageKey = 'nv-theme';

    function normalizeTheme(theme) {
        return theme === 'light' ? 'light' : 'dark';
    }

    function storedTheme() {
        try {
            return localStorage.getItem(storageKey);
        } catch (e) {
            return null;
        }
    }

    function systemTheme() {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            return 'light';
        }
        return 'dark';
    }

    function setStoredTheme(theme) {
        try {
            localStorage.setItem(storageKey, theme);
        } catch (e) {
            // Storage may be unavailable in locked-down browsers.
        }
    }

    function updateButtons(theme) {
        const nextTheme = theme === 'dark' ? 'light' : 'dark';
        document.querySelectorAll('[data-theme-toggle]').forEach(button => {
            button.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
            button.setAttribute('title', `Switch to ${nextTheme} theme`);
            button.innerHTML = `<i data-lucide="${theme === 'dark' ? 'sun' : 'moon'}"></i>`;
        });

        if (window.lucide) {
            lucide.createIcons();
        }
    }

    function applyTheme(theme, options = {}) {
        const nextTheme = normalizeTheme(theme);
        document.documentElement.dataset.theme = nextTheme;
        document.documentElement.style.colorScheme = nextTheme;
        setStoredTheme(nextTheme);
        updateButtons(nextTheme);

        if (options.emit !== false) {
            window.dispatchEvent(new CustomEvent('nv-theme-change', {
                detail: { theme: nextTheme }
            }));
        }
    }

    window.NVTheme = {
        apply: applyTheme,
        current: () => normalizeTheme(document.documentElement.dataset.theme || storedTheme() || systemTheme()),
        next: () => window.NVTheme.current() === 'dark' ? 'light' : 'dark'
    };

    document.addEventListener('DOMContentLoaded', () => {
        applyTheme(document.documentElement.dataset.theme || storedTheme() || systemTheme(), { emit: false });

        document.querySelectorAll('[data-theme-toggle]').forEach(button => {
            button.addEventListener('click', () => {
                applyTheme(window.NVTheme.next());
            });
        });
    });
})();

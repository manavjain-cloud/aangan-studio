export const THEME_STORAGE_KEY = "aangan-theme";

/**
 * Inline script that runs before first paint and applies a saved theme choice. With no saved choice the CSS
 * follows the OS setting (prefers-color-scheme), so there is no flash of the wrong theme either way.
 * Storage access is wrapped in try/catch: private windows and blocked site data must never break the page.
 */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`;

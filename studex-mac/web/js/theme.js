/**
 * The theme, before anything else.
 *
 * This is a classic script rather than a module, and it is loaded from the
 * head, because both of those are what make it run before the first paint: a
 * module is deferred, and the account's real setting does not arrive until the
 * settings request comes back. Without it a light-theme user gets a dark page
 * for as long as that takes, on every launch.
 *
 * What is stored is the *setting* rather than the colour it resolved to, so
 * `system` still follows the machine — including a machine that changed its
 * mind while Studex was closed. `applyTheme` in store.js keeps it current.
 */
(() => {
  let setting = null;
  try {
    setting = localStorage.getItem('studex.theme');
  } catch {
    // Storage can be unavailable; the system preference below still answers.
  }
  const resolved = setting === 'light' || setting === 'dark'
    ? setting
    : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = resolved;
  // High contrast is a per-device accessibility choice; set it here too so the
  // very first paint is already high-contrast rather than flashing normal.
  try {
    document.documentElement.dataset.contrast = localStorage.getItem('studex.contrast') === 'on' ? 'high' : 'normal';
  } catch {
    document.documentElement.dataset.contrast = 'normal';
  }
})();

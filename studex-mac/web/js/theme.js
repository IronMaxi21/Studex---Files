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
  // The visual family changes the ground, the corners and the typeface, so it
  // has to be settled before the first paint for the same reason the theme
  // does — otherwise the app opens in Nocturne and re-draws into Organic.
  try {
    const family = localStorage.getItem('studex.themeFamily');
    document.documentElement.dataset.themeFamily =
      family === 'organic' || family === 'glass' ? family : 'default';
    // The frosted family is glass by definition; the toggle only speaks for
    // the other two.
    // Reduce Transparency is a system-wide answer, so it settles this before
    // the in-app toggle gets a say — and before the first paint, or the app
    // opens frosted and then turns solid in front of someone who asked it not
    // to be frosted at all.
    const opaque = window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
    document.documentElement.dataset.glass =
      !opaque && (family === 'glass' || localStorage.getItem('studex.glass') !== 'off') ? 'on' : 'off';
  } catch {
    document.documentElement.dataset.themeFamily = 'default';
    document.documentElement.dataset.glass = 'on';
  }

  /**
   * Whether this window is the one being worked in.
   *
   * macOS quiets an inactive window — the traffic lights go grey, the toolbar
   * recedes, a selected row loses its colour — and it is the single clearest
   * tell between a Mac app and a web page in a frame. The page has to keep its
   * own copy of that, because the chrome it dims is chrome it drew itself.
   */
  const key = () => {
    document.documentElement.dataset.key = document.hasFocus() ? 'on' : 'off';
  };
  key();
  window.addEventListener('focus', key);
  window.addEventListener('blur', key);
})();

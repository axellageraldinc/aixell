// Applies the stored colour mode before first paint. Classic script: loaded in <head>, no inline code (CSP).
(function () {
  var mode = 'light';
  try {
    var stored = localStorage.getItem('hermes.theme');
    if (stored === 'light' || stored === 'dark' || stored === 'auto') mode = stored;
  } catch (e) {
    // Storage unavailable: keep the light default.
  }
  var root = document.documentElement;
  try {
    var size = localStorage.getItem('hermes.fontsize');
    if (size === 's' || size === 'l' || size === 'xl') root.setAttribute('data-fs', size);
    if (localStorage.getItem('hermes.focus') === '1') root.setAttribute('data-focus', '');
    for (var gone of ['hermes.ui', 'hermes.sidebarCollapsed', 'hermes.sidebar-width']) localStorage.removeItem(gone); // retired settings (the Standar look is gone)
    if (localStorage.getItem('hermes.feedNav') === 'mini') root.setAttribute('data-feed-nav', 'mini');
  } catch (e) {
    // Storage unavailable: defaults.
  }
  root.setAttribute('data-color-mode', mode);
  // daisyUI theme: light and dark are explicit; auto leaves it off so the system setting decides (prefersdark).
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode === 'dark' ? 'aixell-dark' : 'aixell');
  // The browser / phone status bar follows the app's theme (not the system's): this tag is created here because the script
  // runs before the rest of <head>.
  var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = dark ? '#16191f' : '#fbfcfe';
  document.head.appendChild(meta);
})();

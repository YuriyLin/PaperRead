// Only same-origin pages inside our tab shell inherit the main-frame bridge.
(() => {
  if (window.easyreadDesktop || window.parent === window) return;
  try {
    const host = window.parent;
    if (host.location.origin !== location.origin || !host.easyreadTabs || !host.easyreadDesktop) return;
    window.easyreadDesktop = Object.fromEntries(
      Object.entries(host.easyreadDesktop).filter(([key]) => key !== 'onBeforeQuit')
    );
  } catch (_) { /* External frames receive no desktop capabilities. */ }
})();

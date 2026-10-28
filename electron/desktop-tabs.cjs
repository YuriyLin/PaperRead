// The desktop shell owns reader tabs; native IPC remains in its main frame.
function shellUrl(base, target) {
  const url = new URL('/web/tabs.html', base);
  if (target) url.searchParams.set('open', target);
  return url.href;
}

function detachedShellUrl(base, detachedToken) {
  const url = new URL('/web/tabs.html', base);
  if (detachedToken) url.searchParams.set('detached', detachedToken);
  return url.href;
}

function openPaper(window, target) {
  return window.webContents.executeJavaScript(
    `window.easyreadTabs ? (window.easyreadTabs.open(${JSON.stringify(target)}), true) : false`
  );
}

function bindShortcuts(window) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || !['Tab', 'w', 'W'].includes(input.key)) return;
    event.preventDefault();
    const key = JSON.stringify({ key: input.key, ctrlKey: true, shiftKey: input.shift });
    window.webContents.executeJavaScript(
      `window.easyreadTabs?.keyboard({...${key}, preventDefault(){}, stopImmediatePropagation(){}})`
    ).catch(() => {});
  });
}

module.exports = { shellUrl, detachedShellUrl, openPaper, bindShortcuts };

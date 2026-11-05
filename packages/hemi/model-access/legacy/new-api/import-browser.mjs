// Isolated native login window. It has no preload and cannot call Hemi IPC.
import { loginSiteKey } from './login-store.mjs';
import { createLoginMemory } from './login-memory.mjs';

export function createImportBrowser({ createWindow, sessionFromPartition, mainWindow, siteOrigin, loginStore, onLoginMemoryError, onContentReady }) {
  const session = sessionFromPartition(`persist:hemi-newapi-${loginSiteKey(siteOrigin)}`);
  session.setPermissionCheckHandler?.(() => false);
  session.setPermissionRequestHandler?.((_contents, _permission, reply) => reply(false));
  session.on?.('will-download', denyDownload);
  const window = createWindow({
    parent: mainWindow, width: 960, height: 720, show: false, title: `New API · ${new URL(siteOrigin).host}`,
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  const contents = window.webContents;
  const loginMemory = createLoginMemory({ session, siteOrigin, store: loginStore, onError: onLoginMemoryError });
  let disposed = false;
  let restored;
  const allow = target => {
    try { const url = new URL(target); return url.origin === siteOrigin && !url.username && !url.password; }
    catch { return false; }
  };
  contents.on('will-navigate', (event, url) => { if (!allow(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!allow(url)) event.preventDefault(); });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('close', (event) => {
    if (disposed) return;
    event.preventDefault();
    window.hide();
  });
  return {
    contents, session,
    async loadInitial(url) {
      if (!allow(url)) throw new Error('导入浏览器地址与站点不一致');
      restored ??= loginMemory.restore();
      await restored;
      if (disposed) throw new Error('导入浏览器已关闭');
      window.show();
      try { await contents.loadURL(url); }
      finally { onContentReady?.(); }
    },
    show() { if (!window.isDestroyed()) window.show(); },
    hide() { if (!window.isDestroyed()) window.hide(); },
    confirmLogin: identity => loginMemory.confirmLogin(identity),
    flushLoginMemory: () => loginMemory.flush(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      session.removeListener?.('will-download', denyDownload);
      if (!window.isDestroyed()) window.destroy();
      await loginMemory.dispose();
      await session.closeAllConnections?.();
    },
  };
}

function denyDownload(event) {
  event.preventDefault();
}

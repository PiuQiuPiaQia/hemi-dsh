// The embedded sign-in view has no preload and cannot call Hemi IPC.
import { loginSiteKey } from './login-store.mjs';
import { createLoginMemory } from './login-memory.mjs';

export function createImportBrowser({
  createView, sessionFromPartition, mainWindow, siteOrigin, loginStore, onLoginMemoryError, onContentReady,
  onNavigationBlocked, onRenderProcessGone,
}) {
  const session = sessionFromPartition(`persist:hemi-newapi-${loginSiteKey(siteOrigin)}`);
  session.setPermissionCheckHandler?.(() => false);
  session.setPermissionRequestHandler?.((_contents, _permission, reply) => reply(false));
  const view = createView(mainWindow, {
    webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  session.on?.('will-download', denyDownload);
  const contents = view.contents;
  const loginMemory = createLoginMemory({ session, siteOrigin, store: loginStore, onError: onLoginMemoryError });
  let disposed = false;
  let restored;
  const allow = target => {
    try { const url = new URL(target); return url.origin === siteOrigin && !url.username && !url.password; }
    catch { return false; }
  };
  const guardNavigation = (event) => {
    if (allow(event.url)) return;
    event.preventDefault();
    onNavigationBlocked();
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('render-process-gone', onRenderProcessGone);
  contents.setWindowOpenHandler(() => {
    onNavigationBlocked();
    return { action: 'deny' };
  });
  return {
    contents, session,
    async loadInitial(url) {
      if (!allow(url)) throw new Error('导入浏览器地址与站点不一致');
      restored ??= loginMemory.restore();
      await restored;
      if (disposed) throw new Error('导入浏览器已关闭');
      try { await contents.loadURL(url); }
      catch (error) {
        // A site may redirect by replacing its initial document before it finishes.
        if (error?.code !== 'ERR_ABORTED' || !allow(contents.getURL())) throw error;
      }
      finally { onContentReady?.(); }
    },
    setBounds(bounds) { view.setBounds(bounds); },
    focus() { view.focus(); },
    hide() { view.setBounds(null); },
    confirmLogin: identity => loginMemory.confirmLogin(identity),
    flushLoginMemory: () => loginMemory.flush(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      session.removeListener?.('will-download', denyDownload);
      view.dispose();
      await loginMemory.dispose();
      await session.closeAllConnections?.();
    },
  };
}

function denyDownload(event) {
  event.preventDefault();
}

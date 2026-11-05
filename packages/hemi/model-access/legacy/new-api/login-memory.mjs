// Preserve the isolated site's session cookies across application restarts.
export function createLoginMemory({ session, siteOrigin, store, onError = () => {} }) {
  let disposed = false;
  let cookieWrites = Promise.resolve();
  const report = () => onError('登录状态未能加密保存，请检查本机存储权限');
  // 专用 profile 中仅备份当前站点的 session Cookie，避免无过期时间的 Cookie 在退出时丢失。
  function siteCookie(cookie) {
    const host = new URL(siteOrigin).hostname;
    const domain = String(cookie.domain ?? '').replace(/^\./, '');
    return cookie.session === true && (host === domain || host.endsWith(`.${domain}`));
  }
  function persistCookies() {
    if (!session.cookies?.get) return cookieWrites;
    cookieWrites = cookieWrites.then(async () => {
      const cookies = (await session.cookies.get({})).filter(siteCookie);
      await store.update(siteOrigin, { sessionCookies: cookies });
    }).catch(report);
    return cookieWrites;
  }
  const changed = () => { if (!disposed) void persistCookies(); };

  return {
    async restore() {
      try {
        const saved = await store.read(siteOrigin);
        if (session.cookies?.set) {
          const existing = await session.cookies.get({});
          for (const cookie of saved.sessionCookies ?? []) {
            if (!siteCookie(cookie) || existing.some((item) => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path)) continue;
            const details = {
              url: `${siteOrigin}${cookie.path || '/'}`,
              name: cookie.name, value: cookie.value, path: cookie.path || '/',
              secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
              ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
            };
            await session.cookies.set(details);
          }
        }
      } catch { report(); }
      session.cookies?.on?.('changed', changed);
    },
    async confirmLogin() { await this.flush(); },
    async flush() {
      await persistCookies();
      try {
        session.flushStorageData?.();
        await session.cookies?.flushStore?.();
      } catch { report(); }
      await store.flush();
    },
    async dispose() {
      disposed = true;
      session.cookies?.removeListener?.('changed', changed);
      await this.flush();
    },
  };
}

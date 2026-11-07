// @vitest-environment jsdom
/** Browser handoff tracks the initiating attempt and cleans up unused tabs. */
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import { BrowserLogin } from '../src/client/browser-login.ts'

afterEach(() => { vi.restoreAllMocks() })
function view(phase: NonNullable<AccountView['attempt']>['phase'], authorizeUrl?: string): AccountView {
  return { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' },
    attempt: { id: 'attempt' as SignInAttemptId, phase, ...(authorizeUrl ? { authorizeUrl } : {}) } }
}
function setup() {
  const close = vi.fn()
  const replace = vi.fn()
  const popup: { closed: boolean; opener: unknown; close: typeof close; location: { replace: typeof replace } } = {
    closed: false, opener: window, close, location: { replace },
  }
  vi.spyOn(window, 'open').mockReturnValue(new Proxy(window, {
    get(target, property, receiver): unknown {
      if (property === 'closed') return popup.closed
      if (property === 'opener') return popup.opener
      if (property === 'close') return popup.close
      if (property === 'location') return popup.location
      return Reflect.get(target, property, receiver)
    },
    set(target, property, value: unknown, receiver) {
      if (property === 'opener') { popup.opener = value; return true }
      return Reflect.set(target, property, value, receiver)
    },
  }))
  const browser = new BrowserLogin(url => url)
  browser.begin()
  return { browser, popup, close, replace }
}
it('navigates once when waiting-browser arrives after the initial RPC response', () => {
  const { browser, popup, replace, close } = setup()
  expect(popup.opener).toBeNull()
  browser.follow(view('initializing'))
  expect(replace).not.toHaveBeenCalled()
  browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  expect(replace).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize')
  browser.dispose()
  expect(close).toHaveBeenCalledOnce()
})
it('closes the blank tab on request failure without later navigating it', () => {
  const { browser, close, replace } = setup()
  browser.dispose()
  browser.update(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  expect(close).toHaveBeenCalledOnce()
  expect(replace).not.toHaveBeenCalled()
})
it('retains the manual link route when popup opening is blocked', () => {
  vi.spyOn(window, 'open').mockReturnValue(null)
  const browser = new BrowserLogin(url => url)
  browser.begin()
  expect(() => { browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize')) }).not.toThrow()
})

it('closes the pending tab when the authenticated start request rejects', async () => {
  const { browser, close, replace } = setup()
  close.mockClear()
  await expect(browser.start(() => Promise.reject(new Error('disconnected')), () => undefined)).rejects.toThrow('disconnected')
  expect(close).toHaveBeenCalledTimes(2)
  expect(replace).not.toHaveBeenCalled()
})
it('uses a waiting frame received before the initial response', async () => {
  const { browser, replace } = setup()
  await browser.start(async () => view('initializing'), () => view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  expect(replace).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize')
})

it.each(['failed', 'expired', 'cancelled'] as const)('closes an already navigated tab on %s', (phase) => {
  const { browser, close } = setup()
  browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  browser.update(view(phase))
  expect(close).toHaveBeenCalledOnce()
})
it('leaves success completion to the Platform page', () => {
  const { browser, close } = setup()
  browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  browser.update(view('succeeded'))
  browser.dispose()
  expect(close).not.toHaveBeenCalled()
})
it('closes a blank tab when the Host finishes before it navigates', () => {
  const { browser, close } = setup()
  browser.follow(view('exchanging'))
  browser.update(view('succeeded'))
  browser.dispose()
  expect(close).toHaveBeenCalledOnce()
})
it('opens the destination mapped from the authorization URL', () => {
  const { replace } = setup()
  const browser = new BrowserLogin(url => `${url}?theme=dark`)
  browser.begin()
  browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  expect(replace).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize?theme=dark')
})


it('opens authorization through the owned system browser without a popup or native account watcher', async () => {
  const open = vi.fn(async () => {})
  const popup = vi.spyOn(window, 'open')
  const browser = new BrowserLogin(url => `${url}?theme=dark`, open)
  const waiting = view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize')
  await browser.start(async () => waiting, () => waiting)
  browser.update(waiting)
  expect(open).toHaveBeenCalledExactlyOnceWith('https://platform.deepseek.com/dsh/authorize?theme=dark')
  expect(popup).not.toHaveBeenCalled()
  browser.dispose()
})

it('reports a system-browser failure only while it still owns the attempt', async () => {
  const failed = vi.fn()
  const request = Promise.withResolvers<undefined>()
  const browser = new BrowserLogin(url => url, () => request.promise, failed)
  browser.begin()
  browser.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  request.reject(new Error('browser unavailable'))
  await vi.waitFor(() => { expect(failed).toHaveBeenCalledOnce() })
  const stale = Promise.withResolvers<undefined>()
  const disposed = new BrowserLogin(url => url, () => stale.promise, failed)
  disposed.begin()
  disposed.follow(view('waiting-browser', 'https://platform.deepseek.com/dsh/authorize'))
  disposed.dispose()
  stale.reject(new Error('late browser failure'))
  await Promise.resolve()
  expect(failed).toHaveBeenCalledOnce()
})

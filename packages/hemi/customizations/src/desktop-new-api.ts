/** Native New API import IPC. The embedded site cannot invoke product IPC. */
import { randomUUID } from 'node:crypto'
import { WebContentsView, ipcMain, safeStorage, session, type BrowserWindow, type IpcMainInvokeEvent, type WebContentsViewConstructorOptions } from 'electron'
import { createImportCoordinator, type BrowserImportAction, type BrowserImportInput, type BrowserImportResponse } from '@deepseek-ai/dsh-hemi-model-access/desktop-import'

const ACTIONS = new Set<BrowserImportAction>([
  'start', 'getState', 'setBrowserBounds', 'focusBrowser', 'listPending', 'checkLogin', 'setSelection',
  'submit', 'retry', 'pause', 'resume', 'cancel', 'resumePending',
])

type BrowserBounds = NonNullable<BrowserImportInput['bounds']>

function readBrowserBounds(value: unknown): BrowserBounds | null {
  if (value === null) return null
  if (typeof value === 'object' && 'x' in value && 'y' in value && 'width' in value && 'height' in value) {
    const { x, y, width, height } = value
    if (typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number'
      && [x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0) {
      return { x, y, width, height }
    }
  }
  throw new Error('Invalid New API sign-in viewport.')
}

function createSignInView(parent: BrowserWindow, options: WebContentsViewConstructorOptions) {
  const view = new WebContentsView(options)
  const contents = view.webContents
  let visible = false
  let ready = false
  let bounds: BrowserBounds | null = null
  function setVisible(next: boolean): void {
    if (contents.isDestroyed()) return
    if (!next && visible && contents.isFocused() && !parent.isDestroyed()) parent.webContents.focus()
    view.setVisible(next)
    visible = next
  }
  function dispose(): void {
    if (!parent.isDestroyed()) {
      parent.webContents.off('did-start-navigation', hideOnNavigation)
      parent.off('closed', dispose)
      parent.contentView.removeChildView(view)
    }
    if (!contents.isDestroyed()) contents.close()
  }
  function hideOnNavigation(event: { isMainFrame: boolean; isSameDocument: boolean }): void {
    if (event.isMainFrame && !event.isSameDocument) {
      bounds = null
      setVisible(false)
    }
  }
  function updatePlacement(): void {
    if (contents.isDestroyed() || parent.isDestroyed()) return
    if (bounds === null || !ready) { setVisible(false); return }
    const { width, height } = parent.getContentBounds()
    const zoom = parent.webContents.getZoomFactor()
    const x = Math.ceil(bounds.x * zoom)
    const y = Math.ceil(bounds.y * zoom)
    const right = Math.min(width, Math.floor((bounds.x + bounds.width) * zoom))
    const bottom = Math.min(height, Math.floor((bounds.y + bounds.height) * zoom))
    if (right <= x || bottom <= y) { setVisible(false); return }
    view.setBounds({ x, y, width: right - x, height: bottom - y })
    setVisible(true)
  }
  view.setVisible(false)
  parent.contentView.addChildView(view)
  parent.once('closed', dispose)
  parent.webContents.on('did-start-navigation', hideOnNavigation)
  contents.on('did-finish-load', () => { ready = true; updatePlacement() })
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && !input.isComposing && !parent.isDestroyed()) {
      event.preventDefault()
      parent.webContents.focus()
    }
  })
  return {
    contents,
    setBounds(next: BrowserBounds | null): void { bounds = next; updatePlacement() },
    focus(): void { if (visible && !contents.isDestroyed()) contents.focus() },
    dispose,
  }
}

interface HostConnection {
  url: string
  cookie: string
}

function hostImportCall(connection: () => HostConnection | undefined) {
  return async <T>(endpoint: string, args: object): Promise<T> => {
    const host = connection()
    if (host === undefined) throw new Error('Harness Host is unavailable.')
    const response = await fetch(new URL(`/api/hemiModelAccess/${endpoint}`, host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: host.cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method: `hemiModelAccess/${endpoint}`,
        payload: { args },
      }),
    })
    if (!response.ok) throw new Error('Harness Host rejected the New API import.')
    const payload = await response.json() as { result: { ok: boolean; value?: T } }
    if (!payload.result.ok) throw new Error('Harness Host could not complete the New API import.')
    return payload.result.value as T
  }
}

/** Electron operations retained by the shell until import cleanup finishes. */
export interface DesktopCustomizationHandle {
  /**
   * Dispatch one validated import operation after shell authorization.
   * @param event - native sender identity.
   * @param action - operation received over IPC.
   * @param input - operation payload received over IPC.
   * @returns current import state or operation result.
   */
  invoke(event: IpcMainInvokeEvent, action: unknown, input: unknown): Promise<BrowserImportResponse>
  /** Flush durable login state before Host shutdown. */
  dispose(): Promise<void>
}

/**
 * Bind legacy import state to the currently owned product window and Host.
 * @param getMainWindow - current product window.
 * @param connection - current authenticated Host connection.
 * @param journalDirPath - durable import journal directory.
 * @returns validated operations and import-state cleanup.
 */
export function desktopNewApiImport(
  getMainWindow: () => BrowserWindow | undefined,
  connection: () => HostConnection | undefined,
  journalDirPath: string,
): DesktopCustomizationHandle {
  const call = hostImportCall(connection)
  const coordinator = createImportCoordinator({
    getMainWindow,
    createView: createSignInView,
    sessionFromPartition: partition => session.fromPartition(partition),
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable()
        && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encryptString: value => safeStorage.encryptString(value),
      decryptString: value => safeStorage.decryptString(value),
    },
    getProfilesStore: () => ({
      list: async () => { await call<void>('checkNewApiBrowserImport', {}); return {} },
      importProvidersAtomic: input => call('commitNewApiBrowserImport', { input }),
      findImportReceipt: operationId => call('newApiBrowserReceipt', { operationId }),
    }),
    journalDirPath,
  })
  return {
    async invoke(event: IpcMainInvokeEvent, action: unknown, input: unknown) {
      if (typeof action !== 'string' || !ACTIONS.has(action as BrowserImportAction)
        || (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input)))) {
        throw new Error('Invalid New API import command.')
      }
      const payload: BrowserImportInput = input ?? {}
      if (action === 'start') {
        if (typeof payload.siteUrl !== 'string' || payload.siteUrl.length > 2048) throw new Error('Invalid New API site address.')
        return coordinator.start(event, { siteUrl: payload.siteUrl })
      }
      if (action === 'setBrowserBounds') {
        if (typeof payload.operationId !== 'string') throw new Error('Invalid New API import operation.')
        return coordinator.setBrowserBounds(event, { operationId: payload.operationId, bounds: readBrowserBounds(payload.bounds) })
      }
      return coordinator[action as Exclude<BrowserImportAction, 'start'>](event, payload)
    },
    async dispose() {
      if (coordinator.hasLoginMemoryWork()) await coordinator.disposeForQuit()
    },
  }
}

/**
 * Install Electron-only Hemi operations; the shell retains sender authorization and shutdown ordering.
 * @param getMainWindow - current product window.
 * @param connection - current authenticated Host connection.
 * @param journalDirPath - durable import journal directory.
 * @param channel - shell-owned IPC channel.
 * @param assertSender - shell authorization check, executed before every import operation.
 * @returns import handle whose disposal precedes Host shutdown.
 */
export function mountDesktopCustomizations(
  getMainWindow: () => BrowserWindow | undefined,
  connection: () => HostConnection | undefined,
  journalDirPath: string,
  channel: string,
  assertSender: (event: IpcMainInvokeEvent) => void,
): DesktopCustomizationHandle {
  const imports = desktopNewApiImport(getMainWindow, connection, journalDirPath)
  ipcMain.handle(channel, (event, action: unknown, input: unknown) => {
    assertSender(event)
    return imports.invoke(event, action, input)
  })
  return imports
}

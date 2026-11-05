/** Hemi's sandboxed preload adapter; it imports no Electron main-process code. */
import type { BrowserImportAction, BrowserImportInput, BrowserImportResponse, NewApiDesktopBridge } from '@deepseek-ai/dsh-hemi-model-access/desktop-import'

/**
 * Bind the model-import bridge to the shell's authenticated IPC channel.
 * @param invoke - shell callback invoking the import IPC channel.
 * @returns browser-safe model-import operations.
 */
export function createNewApiPreloadBridge(
  invoke: (action: BrowserImportAction, input?: BrowserImportInput) => Promise<unknown>,
): NewApiDesktopBridge {
  return { invoke: (action, input) => invoke(action, input) as Promise<BrowserImportResponse> }
}

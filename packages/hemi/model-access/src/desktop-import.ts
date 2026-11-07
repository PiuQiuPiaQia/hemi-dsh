/** Typed boundary for the native New API coordinator bundled from Hemi's desktop implementation. */
import type { NewApiBrowserCommit, NewApiBrowserCommitResult, NewApiImportReceipt } from './types.ts'

/**
 * One discovered model and its supported request protocol.
 */
export interface BrowserModel {
  modelName: string
  api: string
}

/**
 * The account group, models and protocols selected for import.
 */
export interface BrowserSelection {
  group: string
  budgetMode: 'usd' | 'unlimited'
  budgetUsd?: number
  expiryMode: 'days' | 'never'
  expiryDays?: number
  models: BrowserModel[]
}

/**
 * Recoverable desktop import progress without raw credentials.
 */
export interface BrowserImportState {
  operationId: string
  revision: number
  phase: string
  control: string
  siteOrigin: string
  accountLabel: string | null
  tokenName: string | null
  groups: { name: string; desc: string }[]
  candidates: { modelName: string; apis: string[]; unsupported: string[] }[]
  candidatesGroup: string | null
  siteLoading?: boolean
  siteNavigationBlocked?: boolean
  selection?: BrowserSelection | null
  preview?: { planHash: string; providers: { name: string; api: string; baseUrl: string; models: string[] }[] } | null
  error?: { code: string; message: string; retryTarget?: string } | null
  progress?: string | null
  validation?: { modelName: string; api: string; ok?: boolean; code?: string | null }[] | null
  result?: { providerIds: string[]; modelKeys: string[] } | null
  cleanupPending?: { siteOrigin: string; tokenName: string | null; tokenId?: number } | null
  can?: Partial<Record<'checkLogin' | 'setSelection' | 'submit' | 'pause' | 'resume' | 'retry' | 'cancel' | 'back', boolean>>
}

/**
 * Result of one desktop coordinator command.
 */
export interface BrowserImportResponse {
  ok: boolean
  code?: string
  message?: string
  state?: BrowserImportState | null
  pending?: { operationId: string; siteOrigin?: string; phase: string; readable: boolean }[]
}

/**
 * Command arguments submitted to the desktop import coordinator.
 */
export interface BrowserImportInput {
  siteUrl?: string
  operationId?: string
  revision?: number
  planHash?: string
  /** Model requests omit the protocol to let the coordinator resolve it from the selected group. */
  selection?: Omit<BrowserSelection, 'models'> & { models: { modelName: string; api?: string }[] }
  target?: string
  /** Login viewport in renderer CSS pixels; null hides it while keeping the site session. */
  bounds?: { x: number; y: number; width: number; height: number } | null
}

/**
 * Commands supported by the desktop import coordinator.
 */
export type BrowserImportAction = 'start' | 'getState' | 'setBrowserBounds' | 'focusBrowser' | 'listPending' | 'checkLogin'
  | 'setSelection' | 'submit' | 'retry' | 'pause' | 'resume' | 'cancel' | 'resumePending'

/**
 * Preload operations available to the New API import interface.
 */
export interface NewApiDesktopBridge {
  invoke(action: BrowserImportAction, payload?: BrowserImportInput): Promise<BrowserImportResponse>
}

type CoordinatorCommand = (event: unknown, payload?: BrowserImportInput) => BrowserImportResponse | Promise<BrowserImportResponse>
type CoordinatorCommands = Record<BrowserImportAction, CoordinatorCommand>

/**
 * Native import command owner with explicit shutdown.
 */
export interface DesktopImportCoordinator extends CoordinatorCommands {
  disposeForQuit(): Promise<void>
  hasLoginMemoryWork(): boolean
}

/**
 * Native sign-in view, encrypted storage and profile operations used by the coordinator.
 */
export interface DesktopImportDependencies {
  getMainWindow: () => unknown
  // The view and its session are supplied by Electron, which this package never imports.
  createView: (parent: never, options: never) => unknown
  sessionFromPartition: (partition: string) => unknown
  safeStorage: {
    isEncryptionAvailable: () => boolean
    encryptString: (value: string) => Buffer
    decryptString: (value: Buffer) => string
  }
  getProfilesStore: () => {
    list: () => Promise<unknown>
    importProvidersAtomic: (input: NewApiBrowserCommit) => Promise<NewApiBrowserCommitResult>
    findImportReceipt: (id: string) => Promise<NewApiImportReceipt | null>
  }
  journalDirPath: string
}

/**
 * The desktop bundle supplies the implementation from legacy/new-api.
 * @param dependencies - Native sign-in view, storage and profile services owned by the desktop shell.
 * @returns the native import operation owner; dispose it before Host shutdown.
 */
export declare function createImportCoordinator(dependencies: DesktopImportDependencies): DesktopImportCoordinator

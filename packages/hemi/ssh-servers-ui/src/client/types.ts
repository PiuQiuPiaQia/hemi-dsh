/** Presentation-only editor data and injected operation callbacks. */
import type { SshServer, SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { SshAuthenticationChallenge, SshAuthenticationChallengeId, SshRemoteDirectory } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type { createEditorStore } from './store.ts'
import type { NS } from './locales.ts'

/** Editable address and port text, separated into Host fields only on submission. */
export interface ServerDraft {
  name: string
  address: string
  port: string
  identityFile: string
  directory: string
}

/** An editor captures the selected record and revision, never a current Session. */
export type EditorRequest =
  | { kind: 'create' }
  | { kind: 'edit'; server: SshServer }
  | { kind: 'remove'; server: SshServer }
  | { kind: 'folder'; server: SshServer; selection: number }

/** Actionable failure kinds, independent of internal diagnostic messages. */
export type FolderProblem = 'folderUnavailable' | 'connectionFailed' | 'runtimeChanged' | 'workspaceFailed'
  | 'sshUnavailable' | 'runtimeMissing' | 'runtimeProvisionFailed' | 'cacheUnavailable' | 'protectedDirectory'
  | 'installationIncomplete' | 'directoryUnavailable' | 'authenticationCancelled' | 'passwordRememberFailed'
/** Failures retained by the currently open form, including a durable change with incomplete password cleanup. */
export type Problem = 'invalid' | 'conflict' | 'notFound' | 'failed' | 'credentialCleanupFailed' | FolderProblem
/** Localized transient operation outcome. */
export type Notice = 'saved' | 'removed' | 'savedRefreshFailed' | 'removedRefreshFailed'
  | 'folderOpened' | 'openUncertain' | Problem

/** Shared interaction state only; the authoritative list lives in the resource model. */
export interface EditorState {
  request: EditorRequest | null
  draft: ServerDraft
  busy: boolean
  validate: boolean
  problem: Problem | null
  invalidField: keyof ServerDraft | null
  notice: { key: Notice; seq: number } | null
  sequence: number
  /** Up to three visited locations per exact endpoint; transient picker navigation, not directory data. */
  directoryHistory: Readonly<Record<string, readonly string[]>>
}

/** Browser-safe commands whose asynchronous ownership stays outside React. */
export interface AuthenticationInjected {
  /** Remember is an explicit opt-in for an eligible password; cancellation never saves. */
  answerAuthentication: (id: SshAuthenticationChallengeId, answer: string | null, remember: boolean) => Promise<'accepted' | 'expired' | 'failed'>
}

/** Root-owned native login prompt, without durable credential fields. */
export type AuthenticationOverlayProps = PropsRuntime<'shell.overlay'> & SharedProps & InjectFace<AuthenticationInjected>

/** Browser-safe connection mutation callbacks. */
export interface EditorInjected {
  save: (server: SshServer | null, input: SshServerInput) => void
  remove: (server: SshServer) => void
  refresh: () => void
}

/** Root-owned folder commands; components retain no transport or navigation services. */
export interface FolderInjected {
  hooks: { directoryRequest: HostObservable<number> }
  browse: (selection: number, path: string) => void
  openFolder: (selection: number, path: string) => void
  closeFolder: () => void
}

/** Remote folder selection shares the editor's registered transient request. */
export type FolderOverlayProps = PropsRuntime<'shell.overlay'> & SharedProps & InjectFace<FolderInjected>

/** All entries share one registered root-scoped interaction store. */
export type SharedProps = PropsStore<ReturnType<typeof createEditorStore>> & PropsLocale<typeof NS>
/** Add-menu row with the workspace owner's dismissal and busy state. */
export type AddServerProps = PropsRuntime<'sidebar.workspaces.add.actions'> & SharedProps
/** Persistent root overlay; operation feedback survives the menu and sidebar drawer. */
export type ServerOverlayProps = PropsRuntime<'shell.overlay'> & SharedProps & InjectFace<EditorInjected>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Host-owned saved server references; there is no connection state. */
    'hemi-ssh-servers': readonly SshServer[]
    /** Pending native SSH challenges; response contents are never resource data. */
    'hemi-ssh-authentication': readonly SshAuthenticationChallenge[]
    /** Explicit editor directory requests against the staged endpoint, never the Host filesystem. */
    'hemi-ssh-editor-folders': SshRemoteDirectory
    /** Last successful remote directory in the captured connection interaction. */
    'hemi-ssh-folders': { readonly directory: SshRemoteDirectory | null; readonly request: number }
  }
}

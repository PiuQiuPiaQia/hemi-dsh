/** Saved helper deployment and real remote directory selections; no credentials or process capabilities. */
import type { ExecutionTargetId, SessionExecutionTarget } from '@deepseek-ai/dsh-session/types'
import type { SshServerId } from './types.ts'

/** Explicit, preinstalled helper deployment. Script workers must also supply a verified PTC bootstrap. */
export interface SshRuntimeDeployment {
  /** Absolute remote helper entry, outside workspaces and replaced temporary trees. */
  readonly helper: string
  /** Lowercase SHA-256 of the installed helper entry. */
  readonly helperHash: string
  /** Verified executable or Node script invocation. */
  readonly launch: {
    readonly kind: 'executable'
  } | {
    readonly kind: 'node-script'
    readonly node: string
    readonly bootstrapPath: string
    readonly bootstrapHash: string
  }
}

/** One configured deployment; saving it does not contact the server. */
export interface SshSavedRuntime {
  readonly serverId: SshServerId
  readonly revision: string
  readonly deployment: SshRuntimeDeployment
}

/** Saved endpoint and deployment revisions expected by one directory interaction. */
export interface SshWorkspaceRevision {
  readonly serverRevision: string
  readonly runtimeRevision: string
}

/** Existing physical remote directory ready for the ordinary Workspace registry. */
export interface SshDirectorySelection {
  readonly executionTarget: SessionExecutionTarget
  readonly path: string
  readonly title: string
  readonly serverName: string
}

/** Read-only remote directory view; an empty requested path means the remote login directory. */
export interface SshRemoteDirectory {
  readonly path: string
  readonly parentPath: string
  readonly directories: readonly { readonly name: string; readonly path: string }[]
}

/** Directory names and physical location returned by the remote filesystem, never the Host picker. */
export interface SshRemoteFolders extends SshRemoteDirectory {
  readonly revision: SshWorkspaceRevision
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The connection has no explicit verified helper deployment. */
    'hemi-ssh/runtime-unconfigured': { readonly serverId: SshServerId }
    /** A deployment or remote-directory field is invalid. */
    'hemi-ssh/invalid-runtime': { readonly field: string }
    /** The server or deployment changed while a remote directory was being resolved. */
    'hemi-ssh/connection-changed': { readonly serverId: SshServerId }
    /** A persisted execution reference no longer has its immutable target record. */
    'hemi-ssh/target-unavailable': { readonly targetId: ExecutionTargetId }
    /** No Workspace was selected; the connection could not complete the requested remote operation. */
    'hemi-ssh/connection-failed': { readonly serverId: SshServerId; readonly operation: 'browse' | 'open' | 'connect' }
    /** The operator cancelled a native SSH login prompt before the requested operation could start. */
    'hemi-ssh/authentication-cancelled': { readonly host: string }
    /** A single-use login prompt was already answered, cancelled or withdrawn. */
    'hemi-ssh/authentication-expired': Record<string, never>
    /** OpenSSH could not reach or authenticate the endpoint; no remote operation started. */
    'hemi-ssh/ssh-unavailable': { readonly host: string; readonly reason: string }
    /** The remote directory cannot be inspected; OpenSSH reached the endpoint but the command failed. */
    'hemi-ssh/remote-directory-unavailable': { readonly host: string; readonly path: string; readonly reason: string }
    /** The remote login directory is unusable, its platform has no bundled Node build, or no provisioner can supply one. */
    'hemi-ssh/remote-runtime-missing': { readonly host: string; readonly detail: string }
    /** Downloading, uploading or installing the bundled remote Node runtime failed. */
    'hemi-ssh/runtime-provision-failed': { readonly host: string; readonly detail: string }
    /** The app-owned remote cache directory could not be created or written. */
    'hemi-ssh/remote-cache-unwritable': { readonly host: string; readonly detail: string }
    /** The bundled helper artifacts this Hemi installation should ship are absent or unreadable. */
    'hemi-ssh/helper-artifacts-missing': { readonly detail: string }
    /** The selected directory would contain the deployed helper runtime itself. */
    'hemi-ssh/runtime-inside-workspace': { readonly serverId: SshServerId }
  }
}

export type { SshAuthenticationChallenge, SshAuthenticationChallengeId } from './authentication-types.ts'

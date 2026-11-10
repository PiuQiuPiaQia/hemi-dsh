/** Own remote-folder requests through cancellation and real Workspace admission; resource values stay in the resource model. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteFailure, type RemoteResult, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ResourceProtocolMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkspaceCreateRequest, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { SshServer, SshServerId } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'
import type { EditorRequest, FolderProblem } from './types.ts'

type FolderRemote = Pick<TypertClientRemote['hemiSshWorkspaces'], 'browseSavedFolders' | 'prepareServerFolder'>
type Result = { kind: 'complete' } | { kind: 'failed'; problem: FolderProblem | 'notFound' } | { kind: 'withdrawn' }
type Refresh = () => Promise<void>
interface Selection {
  readonly id: number
  readonly server: SshServer
  readonly control: AbortController
  readonly onPicked: (id: WorkspaceId) => void
  readonly onInterrupted: (uncertain: boolean) => void
  query: { readonly path: string }
}

/** One root UI owner; it never selects a connection id as a Workspace id. */
export class FolderController {
  /** Interaction revision distinguishes a retained old directory from the requested navigation. */
  readonly directoryRequest = createSnapshotStore(0)
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly folderReaders = new Set<Refresh>()
  private selection: Selection | undefined
  private writing: { selection: number; stage: 'prepare' | 'workspace' } | undefined
  private sequence = 0

  /**
   * @param remote - mounted generated folder namespace.
   * @param createWorkspace - ordinary Workspace admission, including its Client model echo.
   * @param allowed - live local operation grants; Host checks remain authoritative.
   */
  constructor(
    private readonly remote: FolderRemote,
    private readonly createWorkspace: (input: WorkspaceCreateRequest) => Promise<WorkspaceView>,
    private readonly allowed: (action: 'browse' | 'open') => boolean,
  ) {}

  /**
   * Capture a connection and the owning picker's navigation callback, without network access.
   * @param server - saved endpoint revision selected by the user.
   * @param onPicked - receives only a successfully admitted real Workspace.
   * @param onInterrupted - dismisses a selection after transport generation changes.
   * @returns transient request for the shared overlay store.
   */
  choose(server: SshServer, onPicked: (id: WorkspaceId) => void, onInterrupted: (uncertain: boolean) => void): EditorRequest {
    this.cancel()
    const selection: Selection = { id: ++this.sequence, server, control: new AbortController(), onPicked, onInterrupted,
      query: { path: server.directory ?? '' } }
    this.selection = selection
    this.directoryRequest.set(1)
    return { kind: 'folder', server, selection: selection.id }
  }

  /**
   * Withdraw navigation, including late outcomes; an already admitted Workspace write may still commit.
   * @returns whether Workspace admission was already dispatched and needs an uncertainty notice.
   */
  cancel(): boolean {
    const uncertain = this.writing?.selection === this.selection?.id && this.writing?.stage === 'workspace'
    this.selection?.control.abort(new Error('Remote folder selection was dismissed'))
    if (this.writing?.selection === this.selection?.id) this.writing = undefined
    this.selection = undefined
    return uncertain
  }

  /** Cancel captured navigation on transport replacement and reconnect held selections. */
  reset(): void {
    const interrupted = this.selection
    const uncertain = this.cancel()
    interrupted?.onInterrupted(uncertain)
  }

  /**
   * Request an explicit remote directory; successful frames replace the last directory only after I/O.
   * @param id - active interaction generation.
   * @param path - user-entered absolute remote path.
   */
  browse(id: number, path: string): void {
    const selection = this.active(id)
    if (selection === undefined || !this.allowed('browse')) return
    selection.query = { path }
    this.directoryRequest.set(this.directoryRequest.getSnapshot() + 1)
    for (const refresh of this.folderReaders) void refresh()
  }

  /**
   * Verify the physical directory, admit its real Workspace and then notify the original picker.
   * @param id - active interaction generation.
   * @param path - last successfully browsed physical directory.
   * @returns committed or uncertain operation outcome, never a fabricated Workspace identity.
   */
  open(id: number, path: string): Promise<Result> {
    return this.write(id, async (selection, signal) => {
      const prepared = await this.remote.prepareServerFolder(selection.server.id, path, selection.server.revision, signal)
      if (!prepared.ok) return failure(prepared.error, 'connectionFailed')
      signal.throwIfAborted()
      if (this.writing !== undefined) this.writing.stage = 'workspace'
      const workspace = await this.createWorkspace({ path: prepared.value.path, executionTarget: prepared.value.executionTarget })
      signal.throwIfAborted()
      selection.onPicked(workspace.workspaceId)
      return { kind: 'complete' }
    })
  }

  /**
   * Register per-interaction directory streams; failed navigation retains the resource model's prior value.
   * @returns provider for the active selection only.
   */
  foldersProvider(): ResourceProvider<'hemi-ssh-folders'> {
    return { protocol: 'hemi-ssh-folders', open: (address, context) => {
      const id = connectionId(address)
      if (id === undefined) return invalidAddress()
      const url = new URL(address)
      const selection = this.active(Number(url.searchParams.get('selection')))
      if (selection === undefined || id !== selection.server.id) return empty()
      const signal = AbortSignal.any([context.signal, selection.control.signal])
      return this.follow<ResourceProtocolMap['hemi-ssh-folders']>(signal, async (control) => {
        const request = this.directoryRequest.getSnapshot()
        const query = selection.query
        const result = await this.remote.browseSavedFolders(selection.server.id, query.path, selection.server.revision, control)
        return result.ok ? { ok: true, value: { directory: result.value, request } } : result
      }, this.folderReaders)
    } }
  }

  /** Abort UI ownership and join all dispatched reads and writes before unmounting Remote. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('Remote folder UI is closing'))
    this.cancel()
    await Promise.allSettled(this.pending)
  }

  private active(id: number): Selection | undefined {
    const selection = this.selection
    return !this.lifetime.signal.aborted && selection?.id === id && !selection.control.signal.aborted ? selection : undefined
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    const settled = (): void => { this.pending.delete(operation) }
    void operation.then(settled, settled)
    return operation
  }

  private write(id: number, action: (selection: Selection, signal: AbortSignal) => Promise<Result>): Promise<Result> {
    const selection = this.active(id)
    if (selection === undefined || this.writing !== undefined) return Promise.resolve({ kind: 'withdrawn' })
    if (!this.allowed('open')) return Promise.resolve({ kind: 'failed', problem: 'folderUnavailable' })
    const signal = AbortSignal.any([this.lifetime.signal, selection.control.signal])
    const writing = { selection: id, stage: 'prepare' as const }
    this.writing = writing
    return this.track(Promise.resolve().then(async (): Promise<Result> => {
      try {
        const result = await action(selection, signal)
        return signal.aborted ? { kind: 'withdrawn' } : result
      } catch (error: unknown) {
        if (signal.aborted) return { kind: 'withdrawn' }
        console.error('Remote folder operation failed:', error)
        return { kind: 'failed', problem: 'workspaceFailed' }
      } finally { if (this.writing === writing) this.writing = undefined }
    }))
  }

  private async *follow<T>(
    holder: AbortSignal, read: (signal: AbortSignal) => Promise<RemoteResult<T>>, readers: Set<Refresh>,
  ): AsyncIterable<RemoteResult<T>> {
    const signal = AbortSignal.any([holder, this.lifetime.signal])
    if (signal.aborted) return
    const frames: RemoteResult<T>[] = []
    const running = new Set<Promise<void>>()
    let revision = 0
    let current: AbortController | undefined
    let wake: (() => void) | undefined
    const stop = (): void => { current?.abort(); wake?.() }
    const refresh = (): Promise<void> => {
      const generation = ++revision
      current?.abort()
      const control = new AbortController()
      current = control
      const requestSignal = AbortSignal.any([signal, control.signal])
      const isCancelled = (): boolean => requestSignal.aborted
      const operation = this.track(Promise.resolve().then(async () => {
        if (isCancelled()) return
        let result: RemoteResult<T>
        try { result = await read(requestSignal) } catch (error: unknown) {
          if (isCancelled()) return
          console.error('Remote folder resource failed:', error)
          result = { ok: false, error: new RemoteError('gateway/internal', 'Remote folder resource is unavailable', {}) }
        }
        if (isCancelled() || generation !== revision) return
        frames.push(result); wake?.()
      }))
      running.add(operation)
      void operation.then(() => { running.delete(operation) })
      return operation
    }
    readers.add(refresh)
    signal.addEventListener('abort', stop, { once: true })
    void refresh()
    try {
      while (!signal.aborted) {
        const frame = frames.shift()
        if (frame !== undefined) yield frame
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      readers.delete(refresh)
      signal.removeEventListener('abort', stop)
      stop()
      await Promise.allSettled(running)
    }
  }
}

function connectionId(address: string): SshServerId | undefined {
  let id: string
  try { id = decodeURIComponent(new URL(address).pathname.slice(1)) }
  catch (_error: unknown) { return undefined } // Resource URLs may contain malformed percent escapes.
  return id !== '' && !id.includes('/') ? brandString<SshServerId>(id) : undefined
}

// oxlint-disable-next-line typescript/require-await -- ResourceProvider.open requires an async stream for this synchronous parser refusal.
async function *invalidAddress<T>(): AsyncIterable<RemoteResult<T>> {
  yield { ok: false, error: new RemoteError('gateway/bad-request', 'Invalid SSH resource address', {}) }
}

async function *empty(): AsyncIterable<never> { /* An obsolete interaction publishes no resource frames. */ }

function failure(error: RemoteFailure, fallback: FolderProblem): Result {
  switch (error.code) {
    case 'hemi-ssh/authentication-cancelled': return { kind: 'failed', problem: 'authenticationCancelled' }
    case 'hemi-ssh/remember-failed': return { kind: 'failed', problem: 'passwordRememberFailed' }
    case 'hemi-ssh/helper-artifacts-missing': return { kind: 'failed', problem: 'installationIncomplete' }
    case 'hemi-ssh/remote-directory-unavailable': return { kind: 'failed', problem: 'directoryUnavailable' }
    case 'hemi-ssh/ssh-unavailable': return { kind: 'failed', problem: 'sshUnavailable' }
    case 'hemi-ssh/remote-runtime-missing': return { kind: 'failed', problem: 'runtimeMissing' }
    case 'hemi-ssh/runtime-provision-failed': return { kind: 'failed', problem: 'runtimeProvisionFailed' }
    case 'hemi-ssh/remote-cache-unwritable': return { kind: 'failed', problem: 'cacheUnavailable' }
    case 'hemi-ssh/runtime-inside-workspace': return { kind: 'failed', problem: 'protectedDirectory' }
    case 'hemi-ssh/not-found': return { kind: 'failed', problem: 'notFound' }
    case 'hemi-ssh/connection-changed': case 'hemi-ssh/conflict': return { kind: 'failed', problem: 'runtimeChanged' }
    case 'hemi-ssh/invalid-runtime': case 'hemi-ssh/runtime-unconfigured': return { kind: 'failed', problem: 'connectionFailed' }
    default: return { kind: 'failed', problem: fallback }
  }
}

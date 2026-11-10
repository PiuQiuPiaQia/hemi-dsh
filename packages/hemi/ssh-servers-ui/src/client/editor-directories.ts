/** Resource-owned browsing for staged SSH connection fields, without saving or selecting a Workspace. */
import { RemoteError, type RemoteResult, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { SshRemoteDirectory } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'

type Remote = Pick<TypertClientRemote['hemiSshWorkspaces'], 'browseServer'>

/** A held resource owns cancellation; plugin teardown joins every dispatched call before Remote unmounts. */
export class EditorDirectories {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()

  /** @param remote - mounted generated namespace for staged endpoint browsing. */
  constructor(private readonly remote: Remote) {}

  /**
   * Register reads owned by explicit editor browse gestures.
   * @returns the staged-endpoint directory resource provider.
   */
  provider(): ResourceProvider<'hemi-ssh-editor-folders'> {
    return { protocol: 'hemi-ssh-editor-folders', open: (address, context) => this.read(address, context.signal) }
  }

  /** Abort and join in-flight directory calls before their namespace is removed. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.pending)
  }

  private async *read(address: string, holder: AbortSignal): AsyncIterable<RemoteResult<SshRemoteDirectory>> {
    const query = parse(address)
    if (query === undefined) {
      yield { ok: false, error: new RemoteError('gateway/bad-request', 'Invalid SSH editor directory request', {}) }
      return
    }
    const signal = AbortSignal.any([holder, this.lifetime.signal])
    const cancelled = (): boolean => signal.aborted
    if (cancelled()) return
    const request = this.remote.browseServer(query.input, query.path, signal)
    this.pending.add(request)
    let result: RemoteResult<SshRemoteDirectory>
    try { result = await request } catch (error: unknown) {
      if (cancelled()) return
      console.error('SSH editor directory request failed:', error)
      result = { ok: false, error: new RemoteError('gateway/internal', 'SSH directory request failed', {}) }
    } finally { this.pending.delete(request) }
    if (!cancelled()) yield result
  }
}

/**
 * Address one explicit browse gesture; an incremented request rereads an unchanged path.
 * @param input - staged server fields, without passwords or key contents.
 * @param path - remote path; empty resolves the authenticated remote home.
 * @param request - caller-owned gesture counter.
 * @returns address consumed only by the editor directory provider.
 */
export function editorDirectoryAddress(input: SshServerInput, path: string, request: number): string {
  const query = new URLSearchParams({ input: JSON.stringify(input), path, request: String(request) })
  return `dsh-resource://hemi-ssh-editor-folders/list?${query}`
}

function parse(address: string): { input: SshServerInput; path: string } | undefined {
  let url: URL, value: unknown
  try { url = new URL(address); value = JSON.parse(url.searchParams.get('input') ?? '') }
  catch (_error: unknown) { return undefined } // Resource addresses are untrusted serialized input.
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('name' in value) || typeof value.name !== 'string'
    || !('host' in value) || typeof value.host !== 'string'
    || !('username' in value) || typeof value.username !== 'string'
    || !('port' in value) || typeof value.port !== 'number'
    || !('identityFile' in value) || typeof value.identityFile !== 'string') return undefined
  const directory = 'directory' in value ? value.directory : undefined
  if (directory !== undefined && typeof directory !== 'string') return undefined
  return { input: { name: value.name, host: value.host, username: value.username, port: value.port,
    identityFile: value.identityFile, ...directory === undefined ? {} : { directory } }, path: url.searchParams.get('path') ?? '' }
}

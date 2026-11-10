/** Live SSH authentication challenges; secret responses never enter a resource, editor store or cache. */
import { RemoteError, type RemoteResult, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteStreamCarrierError, type RemoteStream, type RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import type { SshAuthenticationChallenge, SshAuthenticationChallengeId } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/remote'

type Remote = Pick<TypertClientRemote['hemiSshWorkspaces'], 'followAuthentication' | 'answerAuthentication' | 'answerAuthenticationAndRemember'>

/** Stable shared resource: the Host owns prompt identities and their single-use settlement. */
export const AUTHENTICATION_ADDRESS = 'dsh-resource://hemi-ssh-authentication/pending'

/** One registration owns challenge streams and dispatched replies until Remote can be unmounted. */
export class AuthenticationResources {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly streams = new Set<RemoteStream<readonly SshAuthenticationChallenge[]>>()

  /**
   * @param remote - mounted generated authentication operations.
   * @param factory - Gateway-owned connection recovery for live streams.
   */
  constructor(private readonly remote: Remote, private readonly factory: RemoteStreamFactory) {}

  /**
   * Expose native challenges as authoritative live resource data.
   * @returns the provider shared by the persistent authentication overlay.
   */
  provider(): ResourceProvider<'hemi-ssh-authentication'> {
    return { protocol: 'hemi-ssh-authentication', open: (_address, context) => this.follow(context.signal) }
  }

  /**
   * Send a single-use response without retaining its contents after dispatch.
   * @param id - active native challenge identity.
   * @param answer - native response or cancellation, never a saved connection field.
   * @param remember - explicit password opt-in; cancellation always uses the non-saving operation.
   * @returns the safe submission outcome, not an authentication or save receipt; private diagnostics and responses are excluded.
   */
  async answer(id: SshAuthenticationChallengeId, answer: string | null, remember: boolean): Promise<'accepted' | 'expired' | 'failed'> {
    if (this.lifetime.signal.aborted) return 'expired'
    const request = Promise.resolve().then(() => remember && answer !== null
      ? this.remote.answerAuthenticationAndRemember(id, answer, true, this.lifetime.signal)
      : this.remote.answerAuthentication(id, answer, this.lifetime.signal))
    this.pending.add(request)
    try {
      const result = await request
      if (result.ok) return 'accepted'
      return result.error.code === 'hemi-ssh/authentication-expired' || result.error.code === 'hemi-ssh/not-rememberable' ? 'expired' : 'failed'
    } catch (_error: unknown) {
      // Reporting contains no response or exception text because this command carries a secret.
      return 'failed'
    } finally { this.pending.delete(request) }
  }

  /** Abort callers and join streams and replies before withdrawing the generated namespace. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('SSH authentication UI is closing'))
    await Promise.all([...this.streams].map(stream => stream.dispose()))
    await Promise.allSettled(this.pending)
  }

  private async *follow(holder: AbortSignal): AsyncIterable<RemoteResult<readonly SshAuthenticationChallenge[]>> {
    const signal = AbortSignal.any([holder, this.lifetime.signal])
    const cancelled = (): boolean => signal.aborted
    if (cancelled()) return
    const completed = Promise.withResolvers<void>()
    this.pending.add(completed.promise)
    const failed: RemoteResult<readonly SshAuthenticationChallenge[]> = {
      ok: false, error: new RemoteError('gateway/internal', 'SSH authentication is unavailable', {}),
    }
    let frame: RemoteResult<readonly SshAuthenticationChallenge[]> | undefined
    let wake: (() => void) | undefined
    let ended = false
    const isEnded = (): boolean => ended
    const publish = (value: RemoteResult<readonly SshAuthenticationChallenge[]>): void => {
      if (cancelled()) return
      // Every challenge update is a full snapshot; only the latest undelivered frame is needed.
      frame = value
      wake?.()
    }
    let stream: RemoteStream<readonly SshAuthenticationChallenge[]> | undefined
    let reading: Promise<void> | undefined
    const stop = (): void => { void stream?.dispose(); wake?.() }
    signal.addEventListener('abort', stop, { once: true })
    try {
      stream = this.factory.$stream<readonly SshAuthenticationChallenge[]>({
        name: 'SSH authentication', open: generation => this.remote.followAuthentication(generation),
        ended: () => new RemoteStreamCarrierError('SSH authentication stream ended'),
        carrierFailed: () => { publish(failed) },
      })
      this.streams.add(stream)
      const owned = stream
      reading = (async () => {
        try {
          for await (const item of owned) {
            if (cancelled()) return
            publish({ ok: true, value: item.value })
            item.accept()
          }
        } catch (_error: unknown) {
          // Native prompts, response contents and carrier exception text must not enter diagnostics.
          publish(failed)
        } finally { ended = true; wake?.() }
      })()
      while (!cancelled()) {
        const next = frame
        frame = undefined
        if (next !== undefined) yield next
        else if (isEnded()) return
        else await new Promise<void>((resolve) => { wake = resolve })
      }
    } catch (_error: unknown) {
      if (!cancelled()) yield failed
    } finally {
      signal.removeEventListener('abort', stop)
      if (stream !== undefined) { await stream.dispose(); this.streams.delete(stream) }
      await reading
      completed.resolve(); this.pending.delete(completed.promise)
    }
  }
}

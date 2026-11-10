/** Session Controller adapter for Agent-scoped file-reference discovery. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-file-reference'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { FileReferenceEnvironmentUnsupportedError } from '@deepseek-ai/dsh-file-reference'
import type {} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `fileReferences` Remote namespace. */
    sessionFileReferences: SessionFileReferences
  }
}

/** Host Remote adapter over the composed file-reference provider. */
export class SessionFileReferences extends TypertRemoteService {
  static inject = ['fileReferences', 'typert']

  /** @param ctx - Host context carrying the selected file-reference provider. */
  constructor(ctx: Context) {
    super(ctx, 'sessionFileReferences', { namespace: 'fileReferences' })
  }

  /**
   * List file and directory candidates for one Agent's working directory.
   * @param agent - target Agent resolved from the Session identity on the wire.
   * @param query - path text following `@` or `@"`.
   * @param signal - caller cancellation.
   * @returns deterministic path-only candidates from the composed provider.
   */
  @Remote
  async list(
    agent: Agent,
    query: string,
    signal: AbortSignal,
  ): Promise<FileReferenceCandidate[]> {
    try { return await this.ctx.fileReferences.list(agent, query, signal) }
    catch (cause: unknown) {
      if (cause instanceof FileReferenceEnvironmentUnsupportedError) {
        throw new RemoteError('file-reference/unsupported-environment', 'File suggestions are unavailable in this execution environment; enter the remote file path directly', {}, { cause })
      }
      throw cause
    }
  }
}

export default SessionFileReferences

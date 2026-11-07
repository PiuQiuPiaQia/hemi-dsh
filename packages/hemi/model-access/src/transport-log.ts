/** Persist redacted model transport diagnostics in the local Harness home. */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PiAiTransportDiagnostic } from '@deepseek-ai/dsh-llm-pi-ai'

/**
 * Append one JSON line per diagnostic. Unload waits for writes already started.
 * @param ctx - the model access plugin context that owns the subscription.
 */
export function mountTransportLog(ctx: Context): void {
  const directory = dshHomePath('logs')
  const path = join(directory, 'codex-websocket.jsonl')
  const pending = new Set<Promise<void>>()
  const unsubscribe = ctx.on('llm-pi-ai/transport-diagnostic', (detail) => {
    const write = append(detail)
    pending.add(write)
    return write.finally(() => { pending.delete(write) })
  })
  ctx.effect(() => async () => {
    unsubscribe()
    await Promise.allSettled(pending)
  }, 'flush Codex WebSocket diagnostics on unload')

  async function append(detail: PiAiTransportDiagnostic): Promise<void> {
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await appendFile(path, JSON.stringify(detail) + '\n', { mode: 0o600 })
    } catch {
      ctx.logger.warn('hemi-model-access: could not write Codex WebSocket diagnostic', detail)
    }
  }
}

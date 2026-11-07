/** Project Codex SDK transport failures without forwarding provider-controlled text. */

import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { PiAiTransportDiagnostic } from './types.ts'

type Route = Pick<PiAiTransportDiagnostic, 'provider' | 'model' | 'sessionId' | 'purpose'>
type TerminalEvent = Extract<AssistantMessageEvent, { type: 'done' | 'error' }>

/**
 * Report terminal diagnostics, including a WebSocket failure hidden by successful SSE fallback.
 * @param event - the Codex SDK's terminal event.
 * @param route - the prepared request identity.
 * @param startedAt - SDK dispatch time in Unix milliseconds.
 * @param report - a synchronous observer that must not throw.
 */
export function reportCodexTransport(
  event: TerminalEvent,
  route: Route,
  startedAt: number,
  report: (detail: PiAiTransportDiagnostic) => void,
): void {
  const message = event.type === 'done' ? event.message : event.error
  for (const diagnostic of message.diagnostics ?? []) {
    if (diagnostic.type !== 'provider_transport_failure') continue
    const { configuredTransport, phase, fallbackTransport, requestBytes } = diagnostic.details ?? {}
    if (configuredTransport !== 'auto' && configuredTransport !== 'websocket'
      && configuredTransport !== 'websocket-cached') continue
    if (phase !== 'before_message_stream_start' && phase !== 'after_message_stream_start') continue
    const code = diagnostic.error?.code
    const closeCode = diagnostic.error?.name === 'WebSocketCloseError' && typeof code === 'number'
      && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : undefined
    report(Object.freeze({
      provider: route.provider,
      model: route.model,
      ...route.sessionId === undefined ? {} : { sessionId: route.sessionId },
      ...route.purpose === undefined ? {} : { purpose: route.purpose },
      transport: 'websocket',
      configuredTransport,
      timestamp: diagnostic.timestamp,
      elapsedMs: Math.max(0, diagnostic.timestamp - startedAt),
      phase,
      ...closeCode === undefined ? {} : { closeCode },
      ...fallbackTransport === 'sse' ? { fallbackTransport } : {},
      ...typeof requestBytes === 'number' && Number.isSafeInteger(requestBytes) && requestBytes >= 0
        ? { fullRequestBytes: requestBytes } : {},
      outcome: event.type === 'done' ? 'completed' : event.reason === 'aborted' ? 'aborted' : 'failed',
    }))
  }
}

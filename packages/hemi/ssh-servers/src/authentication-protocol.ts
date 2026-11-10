/** Bounded, single-request IPC between the Host owner and its native OpenSSH askpass worker. */

/** Maximum UTF-8 bytes in one native prompt; oversized prompts fail closed instead of being truncated. */
export const MAX_AUTHENTICATION_PROMPT_BYTES = 16 * 1024
/** Maximum UTF-8 bytes in one answer, excluding the native terminating newline. */
export const MAX_AUTHENTICATION_ANSWER_BYTES = 4096
/** Complete JSON frame limit, including escaped strings and the terminating newline. */
export const MAX_AUTHENTICATION_FRAME_BYTES = 128 * 1024

/** One private worker invocation; tokens identify an authenticating master, never a saved server. */
export interface AskpassRequest {
  readonly token: string
  readonly pid: number
  readonly prompt: string
  readonly hint: string | null
}

/** One transient answer; null terminates the native prompt without supplying input. */
export interface AskpassResponse { readonly answer: string | null }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Admit one complete worker request after transport framing has enforced its byte limit.
 * @param value - parsed, untrusted worker JSON.
 * @returns validated fields, or undefined without including the rejected payload in diagnostics.
 */
export function parseAskpassRequest(value: unknown): AskpassRequest | undefined {
  if (!record(value) || Object.keys(value).length !== 4
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.prompt !== 'string' || value.prompt.includes('\0')
    || Buffer.byteLength(value.prompt) > MAX_AUTHENTICATION_PROMPT_BYTES
    || value.hint !== null && (typeof value.hint !== 'string' || Buffer.byteLength(value.hint) > 32)) return undefined
  return { token: value.token, pid: value.pid, prompt: value.prompt, hint: value.hint }
}

/**
 * Check input before it reaches OpenSSH's line-oriented askpass channel.
 * @param answer - the transient reply; null cancels.
 * @returns whether the reply fits and contains no native line terminators.
 */
export function validAuthenticationAnswer(answer: string | null): boolean {
  return answer === null || !/[\0\r\n]/.test(answer) && Buffer.byteLength(answer) <= MAX_AUTHENTICATION_ANSWER_BYTES
}

/**
 * Admit one complete owner response after transport framing has enforced its byte limit.
 * @param value - parsed, untrusted owner JSON.
 * @returns validated fields, or undefined without retaining the rejected payload.
 */
export function parseAskpassResponse(value: unknown): AskpassResponse | undefined {
  if (!record(value) || Object.keys(value).length !== 1
    || value.answer !== null && typeof value.answer !== 'string'
    || !validAuthenticationAnswer(value.answer)) return undefined
  return { answer: value.answer }
}

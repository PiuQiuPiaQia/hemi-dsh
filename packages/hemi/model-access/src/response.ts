/**
 * Read untrusted service JSON within a fixed byte budget.
 * @param response - HTTP response whose successful JSON body is read within the byte limit.
 * @returns parsed JSON for the caller to validate.
 */
export async function readJson(response: Response): Promise<unknown> {
  const body = response.body
  if (!response.ok || body === null) {
    await body?.cancel()
    throw new Error('The service did not return a successful response.')
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let json = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        const value: unknown = JSON.parse(json + decoder.decode())
        return value
      }
      bytes += value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new Error('The service response is too large.')
      json += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch((_error: unknown) => { /* Preserve the read outcome if cancellation fails. */ })
    reader.releaseLock()
  }
}

/**
 * View one JSON object without assuming optional provider fields are present.
 * @param value - Caller-supplied value to inspect or submit.
 * @returns the object record, or undefined for non-object and array values.
 */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

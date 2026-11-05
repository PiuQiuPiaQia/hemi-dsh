/** Synthetic endpoint that validates the actual GLM signing protocol. */
export function createBigModelTestProvider(): {
  readonly state: { polls: number; pending: number; issued: number; handshakes: number; modelCalls: number }
  reply(url: string, init?: { headers?: HeadersInit; body?: string; method?: string }): Response | null
}

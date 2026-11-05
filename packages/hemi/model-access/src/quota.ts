/** Read the ChatGPT subscription windows using the same Codex grant as inference. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { asObject, readJson } from './response.ts'

import type { QuotaWindow } from './types.ts'

type OAuth = NonNullable<ReturnType<typeof openaiCodexProvider>['auth']['oauth']>
type OAuthCredential = Parameters<OAuth['refresh']>[0]

function grant(record: CredentialRecord | undefined): OAuthCredential | undefined {
  const value = record?.kind === 'grant' ? asObject(record.payload) : undefined
  if (value?.type !== 'oauth' || typeof value.access !== 'string'
    || typeof value.refresh !== 'string' || typeof value.expires !== 'number') return undefined
  return value as OAuthCredential
}

/**
 * Query Codex windows without retaining or returning the access token.
 * @param ctx - Owning Host or Client context providing the required services.
 * @param signal - Caller cancellation for this asynchronous operation.
 * @returns the account’s reported quota windows.
 */
export async function codexQuota(ctx: Context, signal: AbortSignal): Promise<QuotaWindow[]> {
  const key = credentialKey('llm-pi-ai', 'openai-codex')
  let credential = grant(await ctx.credentials.readRecord(key))
  if (credential !== undefined && credential.expires <= Date.now()) {
    const oauth = openaiCodexProvider().auth.oauth
    if (oauth === undefined) throw new Error('Codex OAuth is unavailable.')
    credential = grant(await ctx.credentials.modifyRecord(key, async (current) => {
      const latest = grant(current)
      if (latest === undefined || latest.expires > Date.now()) return undefined
      const next = await oauth.refresh(latest, signal)
      const payload: unknown = JSON.parse(JSON.stringify(next))
      return { kind: 'grant', payload }
    }))
  }
  if (credential === undefined) throw new Error('Connect ChatGPT Codex first.')
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}`, Accept: 'application/json' }
  if (typeof credential.accountId === 'string' && credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId
  const response = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers, redirect: 'error', signal })
  const body = asObject(await readJson(response))
  const limits = asObject(body?.rate_limit)
  const windows: QuotaWindow[] = []
  for (const raw of [limits?.primary_window, limits?.secondary_window]) {
    const window = asObject(raw)
    const seconds = window?.limit_window_seconds
    const used = window?.used_percent
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0
      || typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue
    if (windows.some(entry => entry.seconds === seconds)) continue
    const reset = window?.reset_at
    windows.push({ seconds, remainingPercent: 100 - used,
      ...typeof reset === 'number' && reset > 0 && Number.isSafeInteger(reset) ? { resetAt: reset * 1000 } : {} })
  }
  if (windows.length === 0) throw new Error('No quota windows were returned.')
  return windows.sort((a, b) => a.seconds - b.seconds)
}

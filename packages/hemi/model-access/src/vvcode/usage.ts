/** Pure parsing of VVCode usage answers: site display unit, wallet balance, active subscriptions. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { asObject } from '../response.ts'

import type { VvcodeUsage, VvcodeUsageItem } from '../types.ts'
import type { VvcodeOperation } from './types.ts'

/** The read-only scope that authorizes subscription reads; grants without it must re-authorize. */
export const VVCODE_WALLET_READ_SCOPE = 'wallet:read'

/** The site-declared display unit and the conversion from raw quota integers into it. */
export interface VvcodeUnitScale {
  /** The unit every usage amount of this account is reported in. */
  unit: VvcodeUsage['unit']
  /**
   * Convert one raw site quota integer into the display unit. The result can leave the
   * finite range for absurd magnitudes; the parser validates each reported amount.
   */
  amount: (raw: number) => number
}

/**
 * Build the typed request failure for a usage answer that violates its response contract.
 * @param operation - Usage read the answer belongs to.
 * @param message - User-facing failure detail.
 */
function invalidUsage(operation: VvcodeOperation, message: string): RemoteError<'hemi/vvcode-request-failed'> {
  return new RemoteError('hemi/vvcode-request-failed', message, { operation, status: 200 })
}

/**
 * Read the site display configuration into a unit scale. Nothing is assumed: a missing or
 * non-positive quota-per-unit, an unknown display type, or a missing rate or symbol for the
 * configured currency fails the whole usage read instead of falling back to defaults.
 * @param data - Envelope `data` of the public, credential-free status response.
 * @returns the unit and its raw-quota conversion.
 */
export function parseUsageUnit(data: unknown): VvcodeUnitScale {
  const status = asObject(data)
  const perUnit = status?.quota_per_unit
  const displayType = status?.quota_display_type
  const declared = typeof perUnit === 'number' && Number.isFinite(perUnit) && perUnit > 0
    && (displayType === 'USD' || displayType === 'CNY' || displayType === 'CUSTOM' || displayType === 'TOKENS')
  if (!declared) throw invalidUsage('usage-status', 'VVCode did not declare a usable balance unit.')
  const usdAmount = (raw: number): number => raw / perUnit
  if (displayType === 'TOKENS') return { unit: { kind: 'tokens', symbol: 'TOKENS' }, amount: raw => raw }
  if (displayType === 'USD') return { unit: { kind: 'currency', symbol: '$' }, amount: usdAmount }
  if (displayType === 'CNY') {
    const rate = status?.usd_exchange_rate
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw invalidUsage('usage-status', 'VVCode declared CNY display without a usable USD exchange rate.')
    }
    return { unit: { kind: 'currency', symbol: '¥' }, amount: raw => usdAmount(raw) * rate }
  }
  const rate = status?.custom_currency_exchange_rate
  const symbol = status?.custom_currency_symbol
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0
    || typeof symbol !== 'string' || symbol === '') {
    throw invalidUsage('usage-status', 'VVCode declared a custom currency without a usable rate or symbol.')
  }
  return { unit: { kind: 'currency', symbol }, amount: raw => usdAmount(raw) * rate }
}

/**
 * Read the wallet balance and convert it into the display unit. Negative balances are real
 * overdrafts and stay negative.
 * @param data - Envelope `data` of the account identity response.
 * @param amount - Conversion from raw quota integers into the display unit.
 * @returns the remaining balance in the display unit.
 */
export function parseBalance(data: unknown, amount: (raw: number) => number): number {
  const quota = asObject(data)?.quota
  if (typeof quota !== 'number' || !Number.isSafeInteger(quota)) {
    throw invalidUsage('usage-balance', 'VVCode returned an invalid wallet balance.')
  }
  const remaining = amount(quota)
  if (!Number.isFinite(remaining)) {
    throw invalidUsage('usage-balance', 'VVCode reported a balance outside the display unit range.')
  }
  return remaining
}

/**
 * Read the currently active subscriptions. Only the `subscriptions` field is read; the
 * historical `all_subscriptions` field is ignored. Records outside the active window —
 * another status, not yet started, already ended — are dropped, and every surviving record
 * is reported on its own; totals are never accumulated. A record whose `user_id` names
 * another account is a server contract violation and fails the read.
 * @param data - Envelope `data` of the subscription list response.
 * @param nowMs - Current time in epoch milliseconds, deciding the active window.
 * @param amount - Conversion from raw quota integers into the display unit.
 * @param expectedUserId - Account ID every record must name, when the client knows it.
 * @returns one item per active subscription, in server order.
 */
export function parseActiveSubscriptions(
  data: unknown,
  nowMs: number,
  amount: (raw: number) => number,
  expectedUserId: number | undefined,
): VvcodeUsageItem[] {
  const list = asObject(data)?.subscriptions
  if (!Array.isArray(list)) {
    throw invalidUsage('usage-subscriptions', 'VVCode returned an invalid subscription list.')
  }
  const nowSeconds = Math.floor(nowMs / 1000)
  const items: VvcodeUsageItem[] = []
  for (const value of list) {
    const record = asObject(asObject(value)?.subscription)
    const id = record?.id
    const userId = record?.user_id
    const total = record?.amount_total
    const used = record?.amount_used
    const startTime = record?.start_time
    const endTime = record?.end_time
    const resetAt = record?.next_reset_time
    const status = record?.status
    const valid = record !== undefined && typeof id === 'number' && Number.isSafeInteger(id) && id > 0
      && (userId === undefined || (typeof userId === 'number' && Number.isSafeInteger(userId)
        && (expectedUserId === undefined || userId === expectedUserId)))
      && typeof total === 'number' && Number.isSafeInteger(total) && total >= 0
      && typeof used === 'number' && Number.isSafeInteger(used) && used >= 0
      && typeof startTime === 'number' && Number.isSafeInteger(startTime)
      && typeof endTime === 'number' && Number.isSafeInteger(endTime)
      && typeof status === 'string'
      && (resetAt === undefined || resetAt === null
        || (typeof resetAt === 'number' && Number.isSafeInteger(resetAt) && resetAt >= 0))
    if (!valid) {
      throw invalidUsage('usage-subscriptions', 'VVCode returned an invalid subscription record.')
    }
    // The `valid` guard above proves every field; this view names the checked wire record.
    const entry = record as {
      id: number
      user_id?: number
      amount_total: number
      amount_used: number
      start_time: number
      end_time: number
      status: string
      next_reset_time?: number | null
    }
    if (entry.status !== 'active' || entry.start_time > nowSeconds || entry.end_time <= nowSeconds) continue
    // A zero total is the only unlimited quota; the server refuses negative plan totals.
    const unlimited = entry.amount_total === 0
    const itemTotal = unlimited ? null : amount(entry.amount_total)
    const itemUsed = amount(entry.amount_used)
    const itemRemaining = unlimited ? null : amount(Math.max(0, entry.amount_total - entry.amount_used))
    const expiresAt = entry.end_time * 1000
    const resetMs = entry.next_reset_time === undefined || entry.next_reset_time === null
      || entry.next_reset_time === 0 ? null : entry.next_reset_time * 1000
    if (!Number.isFinite(itemUsed) || (itemTotal !== null && !Number.isFinite(itemTotal))
      || (itemRemaining !== null && !Number.isFinite(itemRemaining))
      || !Number.isSafeInteger(expiresAt) || (resetMs !== null && !Number.isSafeInteger(resetMs))) {
      throw invalidUsage('usage-subscriptions', 'VVCode reported a subscription outside the display unit range.')
    }
    items.push({ id: entry.id, total: itemTotal, used: itemUsed, remaining: itemRemaining, expiresAt, resetAt: resetMs })
  }
  return items
}

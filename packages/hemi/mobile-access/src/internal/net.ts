/**
 * Bind-address enumeration for the mobile listener and the per-address pair
 * rate limiter. Enumeration lists only concrete non-internal IPv4 addresses in
 * home-LAN ranges; public, loopback-external, and wildcard forms never appear,
 * so `start` cannot be handed one.
 */

import { networkInterfaces } from 'node:os'
import type { MobileAddress } from '../types.ts'

/**
 * Classify one IPv4 literal into the home-LAN scopes this carrier serves.
 * @param address - dotted-quad IPv4 literal.
 * @returns the scope, or undefined for an address outside both ranges.
 */
export function classifyIPv4(address: string): 'private' | 'link-local' | undefined {
  const first = Number(address.slice(0, address.indexOf('.')))
  const second = Number(address.slice(address.indexOf('.') + 1, address.indexOf('.', address.indexOf('.') + 1)))
  if (first === 10) return 'private'
  if (first === 172 && second >= 16 && second <= 31) return 'private'
  if (first === 192 && second === 168) return 'private'
  if (first === 169 && second === 254) return 'link-local'
  return undefined
}

/**
 * Enumerate current bind candidates: one row per concrete non-internal IPv4
 * address in a private or link-local range, in interface order.
 * @returns candidate addresses; empty when no interface qualifies.
 */
export function enumerateMobileAddresses(): readonly MobileAddress[] {
  const out: MobileAddress[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const scope = classifyIPv4(entry.address)
      if (scope === undefined) continue
      out.push({ address: entry.address, interface: name, scope })
    }
  }
  return out
}

/**
 * Fixed-window rate limiter keyed by one string, sized for the pair endpoints.
 * Windows advance lazily on push, so an idle address holds no state.
 */
export class AddressRateLimiter {
  private readonly windows = new Map<string, { windowStart: number; count: number }>()

  /**
   * @param windowMs - window length in milliseconds.
   * @param maxPerWindow - allowed events per window.
   */
  constructor(
    private readonly windowMs: number,
    private readonly maxPerWindow: number,
  ) {}

  /**
   * Record one event.
   * @param key - caller identity, typically the socket remote address.
   * @param now - current epoch milliseconds.
   * @returns true when the event fits in the current window.
   */
  push(key: string, now: number): boolean {
    const current = this.windows.get(key)
    if (current === undefined || now - current.windowStart >= this.windowMs) {
      this.windows.set(key, { windowStart: now, count: 1 })
      return true
    }
    if (current.count >= this.maxPerWindow) return false
    current.count += 1
    return true
  }

  /** Drop all state; used when the listener stops. */
  reset(): void {
    this.windows.clear()
  }
}

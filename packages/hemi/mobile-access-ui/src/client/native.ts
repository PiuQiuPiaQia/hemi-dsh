/** Hemi iPhone document capability; the native shell owns its injection and teardown. */
import type { NativeConnection, NativeDisconnectOutcome } from './types.ts'

/** Frozen at main-frame document start; contains no credentials or network address. */
export interface HemiMobileBridge {
  readonly version: 1
  readonly serverName: string
  /** Dispatch native teardown without forgetting the paired computer; no completion acknowledgement. */
  disconnect(): void
}

declare global {
  interface Window {
    /** Present only in the Hemi-owned connected main-frame document; absent in ordinary browsers. */
    readonly __HEMI_MOBILE__?: HemiMobileBridge
  }
}

/**
 * Project the native capability into settings data and a single-dispatch action.
 * @param bridge - The document-start capability, or undefined for desktop/browser management.
 * @returns Native settings inputs, or null when no supported native capability is present.
 */
export function nativeConnection(bridge: HemiMobileBridge | undefined): NativeConnection | null {
  if (bridge === undefined) return null
  let outcome: NativeDisconnectOutcome | undefined
  return {
    serverName: bridge.serverName,
    disconnect: () => {
      if (outcome !== undefined) return outcome
      // Dispatch has no acknowledgement. Never retry an unknown outcome or claim native teardown completed.
      outcome = 'unknown'
      try { bridge.disconnect() } catch (_error: unknown) {
        return outcome
      }
      outcome = 'dispatched'
      return outcome
    },
  }
}

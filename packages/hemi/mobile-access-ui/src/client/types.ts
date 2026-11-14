/** Presentation inputs and lifecycle-owned resource values for desktop phone settings. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MobileAccessState, MobileDeviceId, MobileInvitation, MobileRequestId } from '../types.ts'
import type { MobileLocaleKey } from './locales.ts'

/** Localized, handling-relevant failures; Host diagnostics and invitation tokens are excluded. */
export type MobileProblem = Extract<MobileLocaleKey,
  'localOnly' | 'readFailed' | 'failed' | 'unknown' | 'invitationFailed' | 'noNetwork' | 'notListening'
  | 'requestGone' | 'wrongCode' | 'deviceGone' | 'credentialsFailed' | 'listenFailed' | 'copyFailed'>

/** Authorization denial replaces retained management data instead of leaving a stale list visible. */
export type MobileResourceView = { readonly kind: 'state'; readonly state: MobileAccessState }
  | { readonly kind: 'unauthorized' }

/** Complete commands carry a new single-use invitation only when one was explicitly created. */
export type CommandOutcome = { readonly kind: 'complete'; readonly invitation: MobileInvitation | null }
  | { readonly kind: 'failed'; readonly problem: MobileProblem }
  | { readonly kind: 'withdrawn' }

/** Native dispatch has no completion acknowledgement; unknown outcomes must not be retried. */
export type NativeDisconnectOutcome = 'dispatched' | 'unknown'

/** Native settings contain only the computer label and its narrow teardown action. */
export interface NativeConnection {
  readonly serverName: string
  /** Dispatch at most once through this injected action, retaining native pairing credentials. */
  readonly disconnect: () => NativeDisconnectOutcome
}

/** Narrow actions injected into the settings section; no Cordis context or service object crosses into React. */
export interface MobileInjected {
  /** Native capability selects connection controls; null preserves desktop/browser management behavior. */
  nativeConnection: NativeConnection | null
  /** Wake the currently held resource without opening a background reader. */
  refresh: () => void
  /** Enable local phone access without network configuration and create its first invitation. */
  start: () => Promise<CommandOutcome>
  /** Close only the phone listener, retaining paired devices and Agent tasks. */
  stop: () => Promise<CommandOutcome>
  /** Create an invitation whose secret remains in the mounted component's local state. */
  createInvitation: () => Promise<CommandOutcome>
  /** Approve only a request whose displayed six-digit code the user explicitly checked. */
  approve: (requestId: MobileRequestId, code: string) => Promise<CommandOutcome>
  /** Reject one active request without affecting paired devices. */
  reject: (requestId: MobileRequestId) => Promise<CommandOutcome>
  /** Revoke one paired device after the Host confirms its removal. */
  revoke: (deviceId: MobileDeviceId) => Promise<CommandOutcome>
  /** Copy only on a user gesture; false means the manual selection path is required. */
  copy: (text: string) => Promise<boolean>
}

/** Props derived from the settings shell, locale registration, and injected action face. */
export type MobileSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'hemi-mobile-access'> & InjectFace<MobileInjected>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { 'hemi-mobile-access': MobileResourceView }
  interface LocaleNamespaceMap { 'hemi-mobile-access': MobileLocaleKey }
}

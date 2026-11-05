import type { SignOptions } from '@electron/osx-sign'

/** Fixed public Mac signing identity; its private key is never packaged. */
export interface HemiMacSigning {
  readonly kind: 'mac-self-signed'
  readonly certificate: string
  readonly identity: string
  readonly sha256: string
}

/** Explicit GitHub distribution modes without commercial signing certificates. */
export type HemiCommunitySigning = HemiMacSigning | { readonly kind: 'windows-unsigned' }

/** Public certificate shipped with the source release tooling. */
export const hemiMacCertificate: string

/** Resolve the explicit mode; omitted configuration preserves DSH signing. */
export function resolveHemiCommunitySigning(environment: NodeJS.ProcessEnv, platform: 'darwin' | 'win32'): HemiCommunitySigning | undefined

/** Create the stable certificate-bound application requirement. */
export function hemiMacRequirement(applicationId: string, identity: string): string

/** Verify nested code, every architecture and the exact designated requirement. */
export function verifyHemiMacApplication(
  application: string, signing: HemiMacSigning, applicationId: string,
  execute?: (command: string, args: string[]) => string,
): void

/** Sign using the maintained builder signer, retaining entitlements and ignore rules. */
export function signHemiMacApplication(options: SignOptions, signing: HemiMacSigning, applicationId: string): Promise<void>

/** Sign and verify one DMG without Apple notarization. */
export function signHemiMacDiskImage(
  image: string, signing: HemiMacSigning, keychain: string | undefined,
  execute?: (command: string, args: string[]) => string,
): void

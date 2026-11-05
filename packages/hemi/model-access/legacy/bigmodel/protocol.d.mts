import type { CredentialStore, OAuthCredential, Provider } from '@earendil-works/pi-ai'

export declare const BIGMODEL_ORIGIN: string
export declare function bigModelCodingProvider(credentials: CredentialStore, options?: { fetchImpl?: typeof fetch }): Provider
export declare function codingAuthKey(credential: OAuthCredential): string
export declare function ensureCodingCredential(credentials: CredentialStore, options: {
  authKey: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<OAuthCredential>

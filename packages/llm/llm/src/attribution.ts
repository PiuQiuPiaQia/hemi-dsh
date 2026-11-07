/**
 * Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
 * adapters from drifting. See
 * `docs/subsystems/llm-streaming.md#appidentity--app-attribution`.
 *
 * App-attribution vocabulary for provider requests.
 * @module @deepseek-ai/dsh-llm/attribution
 */

import { createRequire } from 'node:module'

// The package's own manifest is the single source of the version so the
// User-Agent cannot drift from what is published (`./package.json` is an
// export of this package; the relative path resolves from both `src/` and
// the bundled `lib/`).
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/**
 * Static public application identity sent to LLM providers.
 *
 * Every field is a public product fact, safe on every request: no secrets,
 * local paths, session ids, prompt text, or per-user identifiers belong here,
 * and nothing per-request may influence the values.
 */
export interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version; sourced from package metadata, never hand-copied. */
  version: string
  /** Repository home URL of the app, used as the `User-Agent` comment. */
  url: string
}

/**
 * The harness's own identity: the default every adapter sends. Deployments
 * that need a white-label identity pass their own {@link AppIdentity} to
 * {@link attributionHeaders}; omission resolves launch-owned settings before this fallback. Nothing
 * can suppress attribution entirely.
 */
export const APP_IDENTITY: AppIdentity = {
  product: 'deepseek-harness',
  version,
  url: 'https://github.com/deepseek-ai/deepseek-harness',
}

/** Hemi fork: attribution is enforced after provider hooks, so launch-owned distribution defaults resolve here. */
function deploymentIdentity(): AppIdentity {
  const product = process.env.DSH_APP_PRODUCT
  const url = process.env.DSH_APP_URL
  if (product === undefined && url === undefined) return APP_IDENTITY
  if (product === undefined || url === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(product)) {
    throw new Error('Application attribution requires both a lowercase DSH_APP_PRODUCT token and an HTTPS DSH_APP_URL')
  }
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /[\s()]/u.test(url)) {
    throw new Error('DSH_APP_URL must be an HTTPS public application URL without credentials or header delimiters')
  }
  return { product, version: APP_IDENTITY.version, url }
}

/**
 * The standard `User-Agent` value: `product/version (+url)`. The
 * parenthesized `+url` comment is the conventional self-identification form
 * (RFC 9110 §10.1.5 product + comment syntax).
 * @param identity - Explicit identity; omission resolves deployment attribution or {@link APP_IDENTITY}.
 * @returns the ready-to-send header value.
 */
export function userAgent(identity: AppIdentity = deploymentIdentity()): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/**
 * Build the attribution headers an adapter must send on every provider
 * request. Header names are lowercase (HTTP field names are case-insensitive
 * on the wire).
 * @param identity - Explicit identity; omission resolves deployment attribution or {@link APP_IDENTITY} and cannot suppress attribution.
 * @returns headers to merge into the provider request (currently just `user-agent`).
 */
export function attributionHeaders(
  identity: AppIdentity = deploymentIdentity(),
): Record<string, string> {
  return { 'user-agent': userAgent(identity) }
}

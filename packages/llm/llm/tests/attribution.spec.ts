import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_IDENTITY, attributionHeaders, userAgent } from '@deepseek-ai/dsh-llm'
import type { AppIdentity } from '@deepseek-ai/dsh-llm'

const manifest = createRequire(import.meta.url)('../package.json') as { version: string }
afterEach(() => vi.unstubAllEnvs())

/** A white-label identity exercising every override hook. */
const forkIdentity: AppIdentity = {
  product: 'fork-agent',
  version: '9.9.9',
  url: 'https://example.com/fork-agent',
}

describe('APP_IDENTITY', () => {
  it('sources the version from the package manifest, never a hand-copied constant', () => {
    expect(APP_IDENTITY.version).toBe(manifest.version)
  })

  it('carries only static public product facts', () => {
    expect(APP_IDENTITY).toEqual({
      product: 'deepseek-harness',
      version: manifest.version,
      url: 'https://github.com/deepseek-ai/deepseek-harness',
    })
  })
})

describe('userAgent', () => {
  it('renders product/version with the +url comment', () => {
    expect(userAgent()).toBe(
      `deepseek-harness/${manifest.version} (+https://github.com/deepseek-ai/deepseek-harness)`,
    )
  })

  it('renders a custom identity', () => {
    expect(userAgent(forkIdentity)).toBe('fork-agent/9.9.9 (+https://example.com/fork-agent)')
  })
})

describe('attributionHeaders', () => {
  it('uses explicit deployment attribution without changing the native identity', () => {
    vi.stubEnv('DSH_APP_PRODUCT', 'hemi')
    vi.stubEnv('DSH_APP_URL', 'https://example.com/hemi')
    expect(attributionHeaders()['user-agent']).toBe(`hemi/${manifest.version} (+https://example.com/hemi)`)
    expect(APP_IDENTITY.product).toBe('deepseek-harness')
  })

  it.each([
    ['hemi', undefined], [undefined, 'https://example.com'], ['invalid token', 'https://example.com'],
    ['hemi', 'http://example.com'], ['hemi', 'https://user:password@example.com'], ['hemi', 'https://example.com/\r\nheader'],
  ])('refuses unsafe deployment attribution before a request (%s)', (product, url) => {
    vi.stubEnv('DSH_APP_PRODUCT', product)
    vi.stubEnv('DSH_APP_URL', url)
    expect(() => attributionHeaders()).toThrow()
  })

  it('defaults to the provider-neutral baseline: User-Agent and nothing else', () => {
    expect(attributionHeaders()).toEqual({ 'user-agent': userAgent() })
  })

  it('maps a custom identity onto the User-Agent header only', () => {
    expect(attributionHeaders(forkIdentity)).toEqual({
      'user-agent': 'fork-agent/9.9.9 (+https://example.com/fork-agent)',
    })
  })
})

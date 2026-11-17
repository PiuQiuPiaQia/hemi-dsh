/**
 * One sentence per endpoint code; carrier and unclassified failures share the
 * safe operation summary and never show their own message.
 */
import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// The namespace declaration `TranslateNS<'sidebarDocumentPreview'>` resolves against.
import type {} from '../src/client/index.ts'
import { emptyFailureRecourse, failureLine } from '../src/client/failure-line.ts'

/** Key-echoing translate that also shows its parameters, so a formatted value is visible. */
const t: TranslateNS<'sidebarDocumentPreview'> = (key, params) =>
  params === undefined ? key : `${key}(${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(',')})`

function failure(code: string, details: Record<string, unknown> = {}, message = 'boom'): RemoteFailure {
  return { code, message, details } as unknown as RemoteFailure
}

describe('failureLine', () => {
  it('names each workspace-file code', () => {
    expect(failureLine(t, failure('workspace-file/not-found'))).toBe('error.notFound')
    expect(failureLine(t, failure('workspace-file/not-text'))).toBe('error.notText')
    expect(failureLine(t, failure('workspace-file/not-regular-file'))).toBe('error.notRegularFile')
  })

  it('states the byte cap the way a person reads one', () => {
    expect(failureLine(t, failure('workspace-file/too-large', { limit: 512 }))).toBe('error.tooLarge(limit=512 B)')
    expect(failureLine(t, failure('workspace-file/too-large', { limit: 4096 }))).toBe('error.tooLarge(limit=4 KB)')
    expect(failureLine(t, failure('workspace-file/too-large', { limit: 3 * 1024 * 1024 }))).toBe('error.tooLarge(limit=3 MB)')
  })

  it('replaces carrier and unclassified failures with the shared safe summary', () => {
    expect(failureLine(t, new RemoteError('gateway/internal', 'socket closed', {}))).toBe('uiError.unknown')
    expect(failureLine(t, new RemoteError('gateway/cancelled', 'socket closed', {}))).toBe('uiError.cancelled')
    expect(failureLine(t, failure('someday/a-new-code', {}, '<error>/private/path</error>')))
      .toBe('uiError.unknown')
  })
})

describe('emptyFailureRecourse', () => {
  it('hands a readable file the preview cannot render to the Host', () => {
    expect(emptyFailureRecourse(failure('workspace-file/not-text'))).toBe('open')
    expect(emptyFailureRecourse(failure('workspace-file/too-large', { limit: 512 }))).toBe('open')
  })

  it('offers nothing for a path with nothing to show or open', () => {
    expect(emptyFailureRecourse(failure('workspace-file/not-found'))).toBe('none')
    expect(emptyFailureRecourse(failure('workspace-file/not-regular-file'))).toBe('none')
  })

  it('retries carrier and unclassified failures', () => {
    expect(emptyFailureRecourse(failure('gateway/internal'))).toBe('retry')
    expect(emptyFailureRecourse(failure('someday/a-new-code'))).toBe('retry')
  })
})

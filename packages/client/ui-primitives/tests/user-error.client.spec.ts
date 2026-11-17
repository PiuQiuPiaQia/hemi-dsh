/** Safe operation summaries preserve diagnostics without rendering them. */
import { expect, it } from 'vitest'
import { UserFacingError, userErrorMessage, type UserErrorKey } from '../src/user-error.ts'

const t = (key: UserErrorKey): string => key
const diagnostic = '<d:error>PUT /private/key.txt HTTP 403 token=secret</d:error>\nprivate stack'

it.each([null, undefined, diagnostic, new Error(diagnostic), { code: 'gateway/cancelled', message: diagnostic },
  { isDSHRemoteError: true, code: 403, message: diagnostic },
  { isDSHRemoteError: true, code: 'domain/unknown', message: diagnostic },
  { isDSHRemoteError: true, code: 'gateway/internal', message: diagnostic },
  { isDSHRemoteError: true, code: 'gateway/future-code', message: diagnostic },
])('uses the unknown-outcome hint for an unclassified failure %#', (failure) => {
  expect(userErrorMessage(t, failure)).toBe('uiError.unknown')
})

it.each<[string, UserErrorKey]>([
  ['gateway/cancelled', 'uiError.cancelled'],
  ['gateway/bad-request', 'uiError.invalidInput'],
  ['gateway/arguments-invalid', 'uiError.invalidInput'],
  ['gateway/input-invalid', 'uiError.unknown'],
  ['gateway/service-unavailable', 'uiError.unavailable'],
  ['gateway/context-unavailable', 'uiError.unavailable'],
  ['gateway/definition-unavailable', 'uiError.unavailable'],
  ['gateway/method-unavailable', 'uiError.unavailable'],
  ['gateway/peer-disposed', 'uiError.unknown'],
])('selects the summary by the exact Remote code %s', (code, key) => {
  const failure = { isDSHRemoteError: true, code, message: diagnostic }
  expect(userErrorMessage(t, failure)).toBe(key)
})

it('preserves explicitly localized UI advice with the original diagnostic cause', () => {
  const cause = new Error(diagnostic)
  const failure = new UserFacingError('Localized application advice', { cause })
  expect(userErrorMessage(t, failure)).toBe('Localized application advice')
  expect(failure.cause).toBe(cause)
  expect(cause.message).toBe(diagnostic)
})

it('never reads the diagnostic message and preserves the original failure', () => {
  const cause = new Error(diagnostic)
  const details = { privatePath: '/private/key.txt' }
  const failure = { isDSHRemoteError: true, code: 'gateway/internal', details, cause }
  Object.defineProperty(failure, 'message', { get() { throw new Error('diagnostic message must not be read') } })
  expect(userErrorMessage(t, failure)).toBe('uiError.unknown')
  expect(failure.details).toBe(details)
  expect(failure.cause).toBe(cause)
  expect(failure.code).toBe('gateway/internal')
})

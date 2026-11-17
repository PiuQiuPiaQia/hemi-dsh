/** Shared operation-error copy resolves through every feature namespace without replaying operations. */
import { Context } from '@deepseek-ai/cordis'
import { userErrorMessage } from '@deepseek-ai/dsh-client-ui-primitives'
import { expect, it, onTestFinished } from 'vitest'
import { LocaleRuntime } from '../src/client/index.ts'
import { en, zh } from '../src/locales/index.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'error-test.first': 'title'
    'error-test.second': 'title'
  }
}

it('shares the same translated safe summary across unrelated namespaces and locale changes', () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.register('common', { en, zh })
  locale.register('error-test.first', { en: { title: 'First' }, zh: { title: '一' } })
  locale.register('error-test.second', { en: { title: 'Second' }, zh: { title: '二' } })
  const first = locale.bind('error-test.first')
  const second = locale.bind('error-test.second')
  const failure = { isDSHRemoteError: true, code: 'gateway/internal', message: '<error>/private/path secret</error>' }
  locale.setLocale('zh')
  expect(userErrorMessage(first, failure)).toBe(zh['uiError.unknown'])
  expect(userErrorMessage(second, failure)).toBe(zh['uiError.unknown'])
  locale.setLocale('en')
  expect(userErrorMessage(first, failure)).toBe(en['uiError.unknown'])
  expect(userErrorMessage(second, failure)).toBe(en['uiError.unknown'])
})

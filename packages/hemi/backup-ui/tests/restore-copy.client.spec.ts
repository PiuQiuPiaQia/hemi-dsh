/** Locale-owned restore policy shown by the installed backup settings section. */
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

it('explains preserved Sessions and ordinary merge conflicts in both locales', async () => {
  await expect(`${en.mergeNote}\n`).toMatchFileSnapshot('./expected/restore-policy-en.txt')
  await expect(`${zh.mergeNote}\n`).toMatchFileSnapshot('./expected/restore-policy-zh.txt')
})

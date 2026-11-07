/** Startup branding stays sandbox-safe and leaves unbranded windows native. */
import { expect, it } from 'vitest'
import { hemiBootPresentation } from '../release/identity.mjs'

const marker = '--dsh-desktop-product=hemi-dsh'

it('preserves native presentation when the distribution marker is absent', () => {
  expect(hemiBootPresentation([])).toBeUndefined()
})

it('uses English startup copy for an unsupported operating-system locale', () => {
  expect(hemiBootPresentation([marker, '--dsh-desktop-locale=unsupported']))
    .toEqual(hemiBootPresentation([marker, '--dsh-desktop-locale=en']))
  expect(hemiBootPresentation([marker])).toEqual(hemiBootPresentation([marker, '--dsh-desktop-locale=en']))
})

it('supplies localized startup copy in every shipped language', async () => {
  const output = ['en', 'zh-CN', 'ja', 'es', 'fr', 'de', 'ru', 'pt'].map((id) => {
    const boot = hemiBootPresentation([marker, `--dsh-desktop-locale=${id}`])!
    return { id, boot }
  })
  await expect(JSON.stringify(output, null, 2) + '\n').toMatchFileSnapshot('./expected/desktop-startup.json')
})

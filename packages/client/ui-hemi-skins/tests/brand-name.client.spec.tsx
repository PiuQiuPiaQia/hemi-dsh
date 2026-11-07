/** Hemi names and artwork occupy the existing brand slots. */
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type {} from '../src/client/index.ts'
import { HemiBrandName } from '../src/client/HemiBrandName.tsx'
import { HemiBrandMark, HemiRunningMark } from '../src/client/HemiBrandMark.tsx'
import { en, zh } from '../src/client/locales.ts'

it.each([['en', en], ['zh', zh]] as const)('renders the %s Hemi product label', async (language, dictionary) => {
  const t = (key: string) => key === 'brand.name' || key === 'brand.edition' ? dictionary[key] : key
  await expect(renderToStaticMarkup(<HemiBrandName t={t} />) + '\n').toMatchFileSnapshot(`./expected/brand-name-${language}.html`)
})

it('leaves the running artwork empty without a layout placeholder', () => {
  expect(renderToStaticMarkup(<HemiRunningMark />)).toBe('')
})

it('retains the Hemi hero artwork', () => {
  expect(renderToStaticMarkup(<HemiBrandMark size={48} />)).toContain('data-hemi-brand-mark')
})

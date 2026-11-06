/** Product naming is locale-owned and rendered through the existing sidebar seat. */
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type {} from '../src/client/index.ts'
import { HemiBrandName } from '../src/client/HemiBrandName.tsx'
import { en, zh } from '../src/client/locales.ts'

it.each([['en', en], ['zh', zh]] as const)('renders the %s Hemi product label', async (language, dictionary) => {
  const t = (key: string) => key === 'brand.name' ? dictionary['brand.name'] : key
  await expect(renderToStaticMarkup(<HemiBrandName t={t} />)).toMatchFileSnapshot(`./expected/brand-name-${language}.html`)
})

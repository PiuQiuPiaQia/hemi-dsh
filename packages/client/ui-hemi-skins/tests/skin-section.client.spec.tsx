// @vitest-environment jsdom
/** Skin settings keep a page heading and the existing selectable presets. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'
import { SkinSection } from '../src/client/SkinSection.tsx'
import { en, zh, type SkinKey } from '../src/client/locales.ts'
import { HEMI_SKINS, HEMI_DEFAULT_SKIN } from '../src/client/skins.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it.each([['en', en], ['zh', zh]] as const)('renders the %s heading and presets without explanatory copy', async (language, dictionary) => {
  // The section does not consume framework runtime hooks.
  const runtime = {} as PropsRuntime<'settings.section'>
  const t = (key: string) => dictionary[key as SkinKey] ?? key
  const props = { ...runtime, t, setSkin: vi.fn() }
  render(<SkinSection {...props} />)
  const heading = screen.getByRole('heading', { level: 2, name: dictionary['skin.title'] })
  const section = screen.getByRole('region', { name: dictionary['skin.title'] })
  expect(heading.parentElement).toBe(section)
  expect(section.textContent).toBe(dictionary['skin.title'] + HEMI_SKINS.map(skin => skin.name).join(''))
  expect(heading.nextElementSibling?.contains(screen.getAllByRole('button')[0]!)).toBe(true)
  await expect(renderToStaticMarkup(<SkinSection {...props} />) + '\n')
    .toMatchFileSnapshot(`./expected/skin-section-${language}.html`)
})

it.each([null, 'removed-skin'])('marks the active default when the saved skin is %s', (stored) => {
  if (stored !== null) localStorage.setItem('hemi-skin', stored)
  const runtime = {} as PropsRuntime<'settings.section'>
  render(<SkinSection {...runtime} setSkin={vi.fn()} t={key => en[key as SkinKey] ?? key} />)
  expect(screen.getByRole('button', { name: HEMI_DEFAULT_SKIN.name }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1)
})

it('retains the saved selection and applies a different skin on click', () => {
  const saved = HEMI_SKINS[1]!
  const next = HEMI_SKINS[2]!
  localStorage.setItem('hemi-skin', saved.id)
  const runtime = {} as PropsRuntime<'settings.section'>
  const setSkin = vi.fn()
  render(<SkinSection {...runtime} setSkin={setSkin} t={key => en[key as SkinKey] ?? key} />)
  expect(screen.getAllByRole('button')).toHaveLength(HEMI_SKINS.length)
  expect(screen.getByRole('button', { name: saved.name }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: next.name }))
  expect(setSkin).toHaveBeenCalledExactlyOnceWith(next.id)
  expect(screen.getByRole('button', { name: next.name }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: saved.name }).getAttribute('aria-pressed')).toBe('false')
})

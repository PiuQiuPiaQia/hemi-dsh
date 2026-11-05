// @vitest-environment jsdom
/** Backdrop layer behavior: visual-only app-region participation, skins, and teardown. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installBackdrop } from '../src/client/backdrop.ts'
import { Context } from '@deepseek-ai/cordis'
import { HEMI_SKINS } from '../src/client/skins.ts'

const contexts: Context[] = []

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

const skin = (id: string) => {
  const selected = HEMI_SKINS.find(entry => entry.id === id)
  if (selected === undefined) throw new Error(`Missing test skin ${id}`)
  return selected
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  document.body.replaceChildren()
})

describe('Hemi backdrop layer', () => {
  it('opts out of app-region collection so the macOS drag surface keeps working', () => {
    // The layer is a full-viewport body child after `#root`; without an
    // opt-out, the shell's `body > :not(#root)` no-drag rule wins over every
    // drag row by DOM order and disables titlebar dragging and its native
    // double-click zoom. The declaration lives in CSS because that shell
    // selector carries id specificity, so only `!important` outranks it.
    const sheet = readFileSync(join(process.cwd(), 'packages/client/ui-hemi-skins/src/client/Backdrop.module.css'), 'utf8')
    const rule = /\.layer\s*\{[^}]*\}/.exec(sheet)?.[0]
    expect(rule, 'the .layer rule exists').toBeDefined()
    expect(rule).toMatch(/-webkit-app-region:\s*initial\s*!important/)
  })

  it('mounts behind #root as a visual-only layer, shows artwork, and hides for classic', () => {
    const ctx = context()
    const update = installBackdrop(ctx)
    const layer = document.querySelector('body > div[aria-hidden="true"]') as HTMLElement
    expect(layer).not.toBeNull()
    update(skin('cafe-blue'))
    expect(layer.hidden).toBe(false)
    expect(layer.querySelector('img')?.getAttribute('src')).toContain('cafe-blue')
    update(skin('classic'))
    expect(layer.hidden).toBe(true)
    expect(layer.querySelector('img')?.getAttribute('src')).toBeNull()
  })

  it('removes the layer on teardown', async () => {
    const ctx = context()
    installBackdrop(ctx)
    expect(document.querySelector('body > div[aria-hidden="true"]')).not.toBeNull()
    await ctx.fiber.dispose()
    expect(document.querySelector('body > div[aria-hidden="true"]')).toBeNull()
  })
})

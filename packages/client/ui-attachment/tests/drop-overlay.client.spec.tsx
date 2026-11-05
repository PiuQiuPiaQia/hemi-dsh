// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DropOverlay } from '../src/DropOverlay.tsx'

const overlayCss = readFileSync(join(process.cwd(), 'packages/client/ui-attachment/src/DropOverlay.module.css'), 'utf8')

afterEach(cleanup)

describe('DropOverlay', () => {
  it('opts out of app-region collection so the macOS drag surface survives the invitation', () => {
    // The mask portals to document.body beside #root and covers the whole
    // window; the shell's darwin `body > :not(#root)` no-drag rule would
    // otherwise erase every drag row, including the titlebar's native
    // double-click zoom, for as long as the overlay is mounted. The opt-out
    // lives in CSS because that shell selector carries id specificity, so only
    // `!important` beats it; hit testing is untouched below.
    const rule = /\.mask\s*\{[^}]*\}/.exec(overlayCss)?.[0]
    expect(rule, 'the .mask rule exists').toBeDefined()
    expect(rule).toMatch(/-webkit-app-region:\s*initial\s*!important/)
    expect(rule).toMatch(/pointer-events:\s*none/)
  })

  it('portals the invitation with its title and limits desc to the body', () => {
    const view = render(
      <DropOverlay disabled={false} labels={{ title: '图片拖动到此处即可添加', desc: '最多 20 张，每张 5MB' }} />,
    )
    const overlay = view.getByRole('status')
    expect(overlay.parentElement).toBe(document.body)
    expect(overlay.textContent).toContain('图片拖动到此处即可添加')
    expect(overlay.textContent).toContain('最多 20 张，每张 5MB')
  })

  it('omits the desc line when none is resolved', () => {
    const view = render(<DropOverlay disabled={false} labels={{ title: '图片拖动到此处即可添加' }} />)
    expect(view.getByRole('status').textContent).toBe('图片拖动到此处即可添加')
  })

  it('drops the desc and switches the illustration while disabled', () => {
    const enabled = render(
      <DropOverlay disabled={false} labels={{ title: '拖入', desc: '限制' }} />,
    )
    const enabledSvg = enabled.getByRole('status').querySelector('svg')!.innerHTML
    enabled.unmount()
    const disabled = render(
      <DropOverlay disabled labels={{ title: '当前无法添加图片', desc: '限制' }} />,
    )
    const overlay = disabled.getByRole('status')
    expect(overlay.textContent).toBe('当前无法添加图片')
    expect(overlay.querySelector('svg')!.innerHTML).not.toBe(enabledSvg)
  })
})

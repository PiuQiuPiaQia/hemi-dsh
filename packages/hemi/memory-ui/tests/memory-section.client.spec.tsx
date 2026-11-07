// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MemorySection, type MemoryActions } from '../src/client/MemorySection.tsx'
import type {} from '../src/client/index.ts'
import { en, zh, type MemoryLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

function mount(copy = en, save = vi.fn<MemoryActions['save']>().mockResolvedValue('revision-2')) {
  const actions: MemoryActions = {
    read: vi.fn<MemoryActions['read']>().mockResolvedValue({ content: 'Saved memory', revision: 'revision-1' }),
    save,
  }
  render(<MemorySection t={key => key in copy ? copy[key as MemoryLocaleKey] : key} actions={actions} />)
  return actions
}

it.each([{ language: 'en', copy: en }, { language: 'zh', copy: zh }])(
  'shows the memory editor without introductory explanations in $language',
  async ({ language, copy }) => {
    mount(copy)
    const editor = await screen.findByDisplayValue('Saved memory')
    expect(editor).toBe(screen.getByRole('textbox', { name: copy.content }))
    expect(screen.getByRole('heading', { level: 2, name: copy.nav })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: copy.store })).toBeTruthy()
    expect(screen.getByRole('button', { name: copy.save }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: copy.reload }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('status').textContent).toBe('')
    await expect(`${screen.getByRole('region', { name: copy.nav }).textContent}\n`)
      .toMatchFileSnapshot(`./expected/editor-${language}.txt`)
  },
)

it('keeps the unsaved warning and saves edits before switching memory types', async () => {
  const actions = mount()
  const editor = await screen.findByDisplayValue('Saved memory')
  const type = screen.getByRole('combobox', { name: en.store })
  fireEvent.change(editor, { target: { value: 'Updated memory' } })
  expect(screen.getByRole('status').textContent).toBe(en.unsaved)
  expect(type.hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: en.discard })).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.save })) })
  expect(actions.save).toHaveBeenCalledWith('long_term', 'Updated memory', 'revision-1', undefined)
  expect(screen.getByRole('status').textContent).toBe(en.saved)
  expect(type.hasAttribute('disabled')).toBe(false)
  await act(async () => { fireEvent.change(type, { target: { value: 'daily' } }) })
  expect(screen.getByLabelText(en.date)).toBeTruthy()
  expect(actions.read).toHaveBeenLastCalledWith('daily', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u))
})

it.each(['conflict', 'saveFailed'] as const)('keeps the draft and %s feedback', async (notice) => {
  const save = vi.fn<MemoryActions['save']>(async () => {
    if (notice === 'saveFailed') throw new Error('write failed')
    return null
  })
  mount(en, save)
  const editor = await screen.findByDisplayValue('Saved memory')
  fireEvent.change(editor, { target: { value: 'Keep this draft' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.save })) })
  expect(screen.getByRole('status').textContent).toBe(en[notice])
  expect(screen.getByDisplayValue('Keep this draft')).toBe(editor)
  expect(screen.getByRole('button', { name: en.discard }).hasAttribute('disabled')).toBe(false)
})

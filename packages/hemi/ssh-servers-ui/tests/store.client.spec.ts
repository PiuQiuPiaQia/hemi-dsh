import { expect, it } from 'vitest'
import type { SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import { createEditorStore } from '../src/client/store.ts'
import { directoryHistoryKey, EMPTY_DIRECTORY_HISTORY, serverInput } from '../src/client/draft.ts'

const endpoint: SshServerInput = { name: 'Remote', host: 'remote', username: 'operator', port: 22, identityFile: '' }

it('keeps only three distinct visited paths in most-recent order for a picker endpoint', () => {
  const store = createEditorStore().create()
  const key = directoryHistoryKey(endpoint)
  for (const path of ['/one', '/two', '/three', '/two', '/four']) store.actions.rememberDirectory(key, path)
  expect(store.getSnapshot().directoryHistory[key]).toEqual(['/four', '/two', '/three'])
  store.actions.rememberDirectory(key, '/four')
  expect(store.getSnapshot().directoryHistory[key]).toEqual(['/four', '/two', '/three'])
})

it('isolates navigation history by host, login, port and identity file, not display labels or preferred paths', () => {
  const store = createEditorStore().create()
  const endpoints = [endpoint, { ...endpoint, host: 'other' }, { ...endpoint, username: 'other' },
    { ...endpoint, port: 2200 }, { ...endpoint, identityFile: '/fixture/other-key' }]
  endpoints.forEach((value, index) => { store.actions.rememberDirectory(directoryHistoryKey(value), `/project-${String(index)}`) })
  expect(new Set(endpoints.map(directoryHistoryKey)).size).toBe(5)
  endpoints.forEach((value, index) => {
    expect(store.getSnapshot().directoryHistory[directoryHistoryKey(value)]).toEqual([`/project-${String(index)}`])
  })
  const renamed: SshServerInput = { ...endpoint, name: 'Renamed', directory: '/preferred' }
  expect(directoryHistoryKey(renamed)).toBe(directoryHistoryKey(endpoint))
})

it('retains visited locations across picker dismissal and successful selection within one UI lifetime', () => {
  const store = createEditorStore().create()
  const key = directoryHistoryKey(endpoint)
  store.actions.open({ kind: 'create' })
  store.actions.rememberDirectory(key, '/项目 with spaces')
  store.actions.close()
  store.actions.open({ kind: 'create' })
  expect(store.getSnapshot().directoryHistory[key]).toEqual(['/项目 with spaces'])
  store.actions.complete('saved')
  expect(store.getSnapshot().directoryHistory[key]).toEqual(['/项目 with spaces'])
  expect('directoryHistory' in serverInput(store.getSnapshot().draft)).toBe(false)
})

it('starts a separate UI store without another instance’s visited paths', () => {
  const first = createEditorStore().create()
  const second = createEditorStore().create()
  const key = directoryHistoryKey(endpoint)
  first.actions.rememberDirectory(key, '/first-instance')
  expect(second.getSnapshot().directoryHistory[key]).toBeUndefined()
  expect(second.getSnapshot().directoryHistory[key] ?? EMPTY_DIRECTORY_HISTORY).toBe(EMPTY_DIRECTORY_HISTORY)
  expect(EMPTY_DIRECTORY_HISTORY).toEqual([])
})

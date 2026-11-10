/** Staged SSH directory resources retain request ownership and never write saved connections or Workspaces. */
import { expect, it, onTestFinished, vi } from 'vitest'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { SshServerInput } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { SshRemoteDirectory } from '@deepseek-ai/dsh-hemi-ssh-servers/workspace-types'
import { EditorDirectories, editorDirectoryAddress } from '../src/client/editor-directories.ts'

const input: SshServerInput = { name: 'Draft', host: 'host', username: 'user', port: 22, identityFile: '', directory: '/old' }
const directory: SshRemoteDirectory = { path: '/home/user/project', parentPath: '/home/user', directories: [] }
type Browse = TypertClientRemote['hemiSshWorkspaces']['browseServer']

it('browses staged fields through Remote and publishes only the real remote directory', async () => {
  const browseServer = vi.fn<Browse>(async () => ({ ok: true, value: directory }))
  const owner = new EditorDirectories({ browseServer })
  const holder = new AbortController()
  const reader = owner.provider().open(editorDirectoryAddress(input, '', 1), { signal: holder.signal })[Symbol.asyncIterator]()
  onTestFinished(async () => { holder.abort(); await reader.return?.(); await owner.dispose() })
  expect((await reader.next()).value).toEqual({ ok: true, value: directory })
  expect(browseServer).toHaveBeenCalledWith(input, '', expect.any(AbortSignal))
  holder.abort(); await reader.return?.(); await owner.dispose()
})

it('rejects malformed serialized requests before contacting an endpoint', async () => {
  const browseServer = vi.fn<Browse>()
  const owner = new EditorDirectories({ browseServer })
  const reader = owner.provider().open('dsh-resource://hemi-ssh-editor-folders/list?input={}',
    { signal: new AbortController().signal })[Symbol.asyncIterator]()
  onTestFinished(async () => { await reader.return?.(); await owner.dispose() })
  expect((await reader.next()).value).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
  expect(browseServer).not.toHaveBeenCalled()
  await reader.return?.(); await owner.dispose()
})

it('aborts a released holder and joins its late result without publishing it', async () => {
  const entered = Promise.withResolvers<AbortSignal>()
  const release = Promise.withResolvers<undefined>()
  const browseServer = vi.fn<Browse>(async (_input, _path, signal) => {
    if (signal === undefined) throw new Error('Expected the resource-owned cancellation signal')
    entered.resolve(signal); await release.promise
    return { ok: true, value: directory }
  })
  const owner = new EditorDirectories({ browseServer })
  const holder = new AbortController()
  const reader = owner.provider().open(editorDirectoryAddress(input, '/home/user', 1), { signal: holder.signal })[Symbol.asyncIterator]()
  onTestFinished(async () => { holder.abort(); release.resolve(undefined); await owner.dispose(); await reader.return?.() })
  const next = reader.next()
  const signal = await entered.promise
  holder.abort()
  expect(signal.aborted).toBe(true)
  let closed = false
  const closing = owner.dispose().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  release.resolve(undefined)
  expect((await next).done).toBe(true)
  await closing
  await reader.return?.()
})

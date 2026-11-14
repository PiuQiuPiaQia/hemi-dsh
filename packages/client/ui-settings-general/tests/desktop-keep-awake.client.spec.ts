import { expect, it, vi } from 'vitest'
import { DesktopKeepAwakeSource } from '../src/client/desktop-keep-awake-source.ts'
import type { DesktopKeepAwakeState } from '../src/types.ts'

const on: DesktopKeepAwakeState = { enabled: true }
const off: DesktopKeepAwakeState = { enabled: false }

function fixture() {
  const get = Promise.withResolvers<DesktopKeepAwakeState>()
  const set = Promise.withResolvers<DesktopKeepAwakeState>()
  let listener: (state: DesktopKeepAwakeState) => void = () => {}
  const unsubscribe = vi.fn()
  const write = vi.fn(() => set.promise)
  const source = new DesktopKeepAwakeSource({ get: () => get.promise, set: write,
    subscribe(next) { listener = next; return unsubscribe } })
  return { source, get, set, write, unsubscribe, emit: (state: DesktopKeepAwakeState) => { listener(state) } }
}

it('keeps a pushed state ahead of a stale initial read and settles its own toggle', async () => {
  const f = fixture()
  f.emit(off)
  f.get.resolve(on)
  await f.get.promise
  expect(f.source.store.getSnapshot().state).toEqual(off)
  const pending = f.source.setEnabled(true)
  expect(f.source.store.getSnapshot().pending).toBe(true)
  f.set.resolve(on)
  await pending
  expect(f.write).toHaveBeenCalledOnce()
  expect(f.source.store.getSnapshot()).toEqual({ state: on, failed: false })
  f.source.dispose()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it('reverts a rejected toggle to the last known state and propagates the rejection', async () => {
  const f = fixture()
  f.get.resolve(on)
  await f.get.promise
  const pending = f.source.setEnabled(false)
  f.emit(on)
  f.set.reject(new Error('IPC closed'))
  await expect(pending).rejects.toThrow('IPC closed')
  expect(f.source.store.getSnapshot()).toEqual({ state: on, failed: false })
  f.source.dispose()
})

it('reports an initial read failure and clears it on the next broadcast', async () => {
  const f = fixture()
  f.get.reject(new Error('unavailable'))
  await Promise.resolve()
  expect(f.source.store.getSnapshot()).toEqual({ failed: true })
  f.emit(on)
  expect(f.source.store.getSnapshot()).toEqual({ state: on, failed: false })
  f.emit({ enabled: true, error: 'read' })
  expect(f.source.store.getSnapshot()).toEqual({ state: { enabled: true, error: 'read' }, failed: false })
  f.source.dispose()
})

it('ignores rejected reads, later events and new toggles after disposal', async () => {
  const f = fixture()
  f.emit(on)
  f.source.dispose()
  const before = f.source.store.getSnapshot()
  f.get.reject(new Error('late read'))
  await Promise.resolve()
  f.emit(off)
  await f.source.setEnabled(false)
  expect(f.write).not.toHaveBeenCalled()
  expect(f.source.store.getSnapshot()).toBe(before)
})

it('runs one toggle at a time and ignores a response a broadcast superseded', async () => {
  const f = fixture()
  f.get.resolve(off)
  await f.get.promise
  const first = f.source.setEnabled(true)
  const second = f.source.setEnabled(false)
  await second
  expect(f.write).toHaveBeenCalledOnce()
  f.emit({ enabled: true, error: 'read' })
  f.set.resolve(on)
  await first
  expect(f.source.store.getSnapshot()).toEqual({ state: { enabled: true, error: 'read' }, failed: false })
  f.source.dispose()
})

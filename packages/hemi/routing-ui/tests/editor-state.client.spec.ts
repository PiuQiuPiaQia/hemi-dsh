import { expect, it, onTestFinished, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { createRoutingEditor } from '../src/client/editor-state.ts'
import type { RoutingConfig } from '../src/client/types.ts'

const main = { provider: 'provider/a', model: 'model/a', reasoningEffort: 'high' }
const config: RoutingConfig = {
  main,
  roles: { oracle: { provider: 'private', model: 'retired', reasoningEffort: 'low' } },
}
const catalog: ModelCatalog = {
  default: main, routableProviders: ['provider/a'],
  groups: [{ id: 'provider/a', name: 'Provider A', models: [{ id: 'model/a', name: 'Model A' }] }],
  failures: [],
}

function bench(load = vi.fn(async () => catalog)) {
  const form = stubConfigForm<RoutingConfig>()
  form.publish({ status: 'ready', writable: true, revision: 7, value: config })
  const editor = createRoutingEditor(form.scope, load)
  onTestFinished(() => editor.dispose())
  return { form, editor, load, ...editor.injected }
}

it('writes only the selected setting, fencing the latest role map with the read revision', async () => {
  const b = bench()
  b.saveRoute('explorer', { provider: 'provider/a', model: 'model/a' })
  expect(b.hooks.routingWrite.getSnapshot()).toEqual({ status: 'saving', field: 'explorer' })
  await vi.waitFor(() => { expect(b.hooks.routingWrite.getSnapshot().status).toBe('saved') })
  expect(b.form.mutate).toHaveBeenLastCalledWith([{
    op: 'set', path: ['roles'], value: { ...config.roles, explorer: { provider: 'provider/a', model: 'model/a' } },
  }], 7)
  b.form.publish({ revision: 8, value: { ...config, roles: { ...config.roles, designer: main } } })
  b.saveRoute('oracle', null)
  await vi.waitFor(() => { expect(b.hooks.routingWrite.getSnapshot().status).toBe('saved') })
  expect(b.form.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['roles'], value: { designer: main } }], 8)
  b.saveRoute('main', main)
  await vi.waitFor(() => { expect(b.hooks.routingWrite.getSnapshot().status).toBe('saved') })
  expect(b.form.mutate).toHaveBeenLastCalledWith([{ op: 'set', path: ['main'], value: main }], 8)
})

it('preserves an untouched legacy route when writing a canonical role table', async () => {
  const b = bench()
  const review = { provider: 'private', model: 'legacy-review', reasoningEffort: 'low' }
  b.form.publish({ revision: 8, value: { main, roles: { review } } })
  b.saveRoute('explorer', main)
  await vi.waitFor(() => { expect(b.hooks.routingWrite.getSnapshot().status).toBe('saved') })
  expect(b.form.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['roles'], value: { explorer: main, oracle: review } }], 8)
})

it('keeps saved values authoritative and prevents overlapping editor writes', async () => {
  const b = bench()
  const operation = Promise.withResolvers<boolean>()
  b.form.mutate.mockReturnValueOnce(operation.promise)
  b.saveRoute('main', null)
  b.saveRoute('designer', main)
  await vi.waitFor(() => { expect(b.form.mutate).toHaveBeenCalledOnce() })
  expect(b.hooks.routingSettings.getSnapshot().value?.main).toEqual(main)
  operation.resolve(true)
  await vi.waitFor(() => { expect(b.hooks.routingWrite.getSnapshot().status).toBe('saved') })
  expect(b.hooks.routingSettings.getSnapshot().value?.main).toEqual(main)
  b.form.publish({ value: { ...config, main: null }, revision: 8 })
  expect(b.hooks.routingSettings.getSnapshot().value?.main).toBeNull()
})

it.each(['refused', 'error', 'string'] as const)('retains configured routes when a save is %s', async (kind) => {
  const b = bench()
  if (kind === 'refused') b.form.mutate.mockResolvedValueOnce(false)
  else b.form.mutate.mockRejectedValueOnce(kind === 'error' ? new Error('offline') : 'offline')
  b.saveRoute('oracle', null)
  await vi.waitFor(() => {
    expect(b.hooks.routingWrite.getSnapshot()).toEqual({
      status: 'failed', field: 'oracle', message: kind === 'refused' ? null : 'offline',
    })
  })
  expect(b.form.scope.getSnapshot().value).toEqual(config)
})

it.each(['loading', 'unavailable', 'readOnly', 'noRevision', 'noValue'] as const)('does not submit from %s settings', (kind) => {
  const b = bench()
  if (kind === 'loading' || kind === 'unavailable') b.form.publish({ status: kind })
  if (kind === 'readOnly') b.form.publish({ writable: false })
  if (kind === 'noRevision') b.form.publish({ revision: undefined })
  if (kind === 'noValue') b.form.publish({ value: undefined })
  b.saveRoute('main', null)
  expect(b.form.mutate).not.toHaveBeenCalled()
  expect(b.hooks.routingWrite.getSnapshot().status).toBe('failed')
})

it('deduplicates catalog reads and supports retries with visible partial failures', async () => {
  const pending = Promise.withResolvers<ModelCatalog>()
  const load = vi.fn(() => pending.promise)
  const b = bench(load)
  b.refreshCatalog()
  b.refreshCatalog()
  expect(b.hooks.routingCatalog.getSnapshot().status).toBe('loading')
  await vi.waitFor(() => { expect(load).toHaveBeenCalledOnce() })
  pending.resolve(catalog)
  await vi.waitFor(() => { expect(b.hooks.routingCatalog.getSnapshot().status).toBe('ready') })
  const slow = Promise.withResolvers<ModelCatalog>()
  load.mockReturnValueOnce(slow.promise)
  b.refreshCatalog()
  expect(b.hooks.routingCatalog.getSnapshot()).toMatchObject({ status: 'ready', groups: catalog.groups })
  slow.resolve(catalog)
  await vi.waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  load.mockRejectedValueOnce(new Error('catalog offline'))
  b.refreshCatalog()
  await vi.waitFor(() => { expect(b.hooks.routingCatalog.getSnapshot()).toMatchObject({ status: 'failed', error: 'catalog offline', groups: catalog.groups }) })
  load.mockRejectedValueOnce('still offline')
  b.refreshCatalog()
  await vi.waitFor(() => { expect(b.hooks.routingCatalog.getSnapshot().error).toBe('still offline') })
  load.mockResolvedValueOnce({ ...catalog, failures: [{ id: 'missing', name: 'Missing provider', message: 'offline' }] })
  b.refreshCatalog()
  await vi.waitFor(() => { expect(b.hooks.routingCatalog.getSnapshot()).toMatchObject({ status: 'ready', failures: [{ id: 'missing' }] }) })
})

it('waits for dispatched operations on disposal without publishing late results', async () => {
  const read = Promise.withResolvers<ModelCatalog>()
  const change = Promise.withResolvers<boolean>()
  const b = bench(vi.fn(() => read.promise))
  b.form.mutate.mockReturnValueOnce(change.promise)
  b.refreshCatalog()
  b.saveRoute('main', null)
  await vi.waitFor(() => { expect(b.form.mutate).toHaveBeenCalledOnce() })
  const readSnapshot = b.hooks.routingCatalog.getSnapshot()
  const writeSnapshot = b.hooks.routingWrite.getSnapshot()
  const settled = vi.fn()
  const disposal = b.editor.dispose().then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  b.refreshCatalog()
  b.saveRoute('explorer', main)
  read.resolve(catalog)
  change.resolve(true)
  await disposal
  expect(settled).toHaveBeenCalledOnce()
  expect(b.hooks.routingCatalog.getSnapshot()).toBe(readSnapshot)
  expect(b.hooks.routingWrite.getSnapshot()).toBe(writeSnapshot)
  expect(b.form.mutate).toHaveBeenCalledOnce()
})

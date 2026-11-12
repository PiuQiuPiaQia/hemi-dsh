import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteError, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { InvocationDescriptor, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as mountRemote, inject as remoteInject } from '@deepseek-ai/dsh-api-gateway/client'
import { z } from 'zod'
import { mountRouting } from '../src/client/mount.ts'
import { apply as hostApply } from '../src/index.ts'
import { RoutingDialog, type RoutingDialogInjected } from '../src/client/RoutingDialog.tsx'
import { RoutingModeToggle, type RoutingModeInjected } from '../src/client/RoutingModeToggle.tsx'
import { RoutingModelLabel, type RoutingLabelInjected } from '../src/client/RoutingModelLabel.tsx'
import { RoutingSettingsEntry, type RoutingSettingsEntryInjected } from '../src/client/RoutingSettingsEntry.tsx'
import type { RoutingConfig } from '../src/client/types.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { HemiSessionUsage, type SessionUsageInjected } from '../src/client/usage/SessionUsage.tsx'

/** Fake wire descriptors exercised through the real Client Remote mount. */
const modeDescriptor: InvocationDescriptor = {
  id: '@fixture/routing#hemiRoutingSettings/setEnabled',
  service: 'hemiRoutingSettings', namespace: 'hemiRoutingSettings', method: 'setEnabled',
  invocation: { kind: 'direct' }, scope: { context: 'agent', wire: 'agentId' },
  parameters: [
    { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: { mode: 'strict', typeSymbol: '@fixture#AgentId', create: () => z.string() } },
    { name: 'enabled', wire: 'enabled', source: 'json', codec: { mode: 'strict', typeSymbol: '@fixture#Enabled', create: () => z.boolean() } },
  ],
  result: { mode: 'strict', typeSymbol: '@fixture#Void', create: () => z.void() },
}
const catalogDescriptor: InvocationDescriptor = {
  id: '@fixture/catalog#session/modelCatalog',
  service: 'session', namespace: 'session', method: 'modelCatalog',
  invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol: '@fixture#Catalog', create: () => z.unknown() },
}
const routingContribution = { package: '@fixture/routing', descriptors: [modeDescriptor] }

async function bench() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const form = stubConfigForm<RoutingConfig>()
  form.publish({ status: 'ready', writable: true, revision: 1, value: { main: null, roles: {} } })
  const get = vi.fn(() => form.scope)
  ctx.provide('configForms', { get } as never)
  const directory = createSnapshotStore({ groups: [], failures: [] })
  const directoryFor = vi.fn(() => ({ store: directory }))
  ctx.provide('modelDirectories', { directoryFor } as never)
  const modelCatalog = vi.fn(async () => ({
    ok: true as const,
    value: { default: { provider: 'p', model: 'm' }, groups: [], failures: [], routableProviders: [] },
  }))
  const setEnabled = vi.fn(async (_sessionId: SessionId, _enabled: boolean): Promise<RemoteResult<void>> =>
    ({ ok: true, value: undefined }))
  await ctx.plugin(TypertRegistry)
  ctx.provide('connection', {
    interactions: 'none', isLoopback: true,
    openWebSocket: () => { throw new Error('fixture has no WebSocket') },
    generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    reconnect: () => {}, registerGenerationSource: () => () => {}, start: () => ({ stop: () => {} }),
    rpc: {
      call: async (_channel, endpoint, payload) => {
        if (endpoint === 'session/modelCatalog') return modelCatalog()
        if (endpoint === 'hemiRoutingSettings/setEnabled') {
          const { args } = z.object({ args: z.object({ agentId: z.string(), enabled: z.boolean() }) }).parse(payload)
          return setEnabled(SessionId(args.agentId), args.enabled)
        }
        throw new Error(`unexpected endpoint ${endpoint}`)
      },
      open: async function* () { throw new Error('fixture has no streams') },
    },
  } satisfies ConnectionHandle)
  await ctx.plugin({ inject: remoteInject, apply: mountRemote })
  await ctx.remote.$mount({ package: '@fixture/catalog', descriptors: [catalogDescriptor] })
  expect(ctx.get('remote.hemiRoutingSettings')).toBeUndefined()
  const declare = () => ctx.slots.register({ name: 'root', children: {
    'shell.overlay': { kind: 'list', scope: 'root' },
    'settings.models.footer': { kind: 'list', scope: 'root' },
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
    'conversation.input.model.options': { kind: 'list', scope: 'session' },
    'conversation.input.model.label': { kind: 'single', scope: 'session', inline: true },
  } } as never, () => null)
  const collapse = declare()
  const fiber = ctx.plugin({ inject: ['slots', 'locale', 'configForms', 'remote', 'remote.session'], apply: scope => mountRouting(scope, routingContribution) })
  await fiber.await()
  expect(ctx.get('remote.hemiRoutingSettings')).toBeDefined()
  return { ctx, fiber, form, get, modelCatalog, setEnabled, collapse, declare, directory, directoryFor }
}

it('registers native model-menu and label contributions plus one shared settings editor', async () => {
  const b = await bench()
  expect(b.get).toHaveBeenCalledWith('hemi-routing-settings')
  const entry = b.ctx.slots.entries('settings.models.footer').find(entry => entry.component === RoutingSettingsEntry)!
  const overlay = b.ctx.slots.entries('shell.overlay').find(entry => entry.component === RoutingDialog)!
  const mode = b.ctx.slots.entries('conversation.input.model.options').find(entry => entry.component === RoutingModeToggle)!
  const label = b.ctx.slots.entries('conversation.input.model.label').find(entry => entry.component === RoutingModelLabel)!
  expect([entry, overlay, mode, label].every(value => value.locale === 'hemi-routing')).toBe(true)
  const formValue: object = overlay.inject!()
  const dialog = formValue as RoutingDialogInjected
  const settingsValue: object = entry.inject!()
  const settings = settingsValue as RoutingSettingsEntryInjected
  expect(dialog.hooks.routingSettings).toBe(b.form.scope)
  expect(dialog.hooks.routingOpen.getSnapshot()).toBe(false)
  expect(b.modelCatalog).not.toHaveBeenCalled()
  settings.openConfiguration()
  expect(dialog.hooks.routingOpen.getSnapshot()).toBe(true)
  await vi.waitFor(() => { expect(dialog.hooks.routingCatalog.getSnapshot().status).toBe('ready') })
  expect(b.modelCatalog).toHaveBeenCalledOnce()
  dialog.closeConfiguration()
  expect(dialog.hooks.routingOpen.getSnapshot()).toBe(false)
  const modeValue: object = mode.inject!(SessionId('first') as never)
  const first = modeValue as RoutingModeInjected
  first.openConfiguration()
  expect(dialog.hooks.routingOpen.getSnapshot()).toBe(true)
  const labelValue: object = label.inject!(SessionId('first') as never)
  const labelFace = labelValue as RoutingLabelInjected
  expect(labelFace.hooks.routingSettings).toBe(b.form.scope)
  expect(labelFace.resolveText({ en: 'Official', zh: '官方' })).toBe('Official')
  const usage = b.ctx.slots.entries('conversation.composer.dock').find(entry => entry.component === HemiSessionUsage)!
  const usageValue: object = usage.inject!(SessionId('first') as never)
  const usageFace = usageValue as SessionUsageInjected
  expect(usageFace.hooks.modelDirectory).toBe(b.directory)
  expect(b.directoryFor).toHaveBeenLastCalledWith('first')
  await b.fiber.dispose()
  expect(b.ctx.slots.entries('conversation.composer.dock')).toHaveLength(0)
  expect(b.ctx.slots.entries('settings.models.footer')).toHaveLength(0)
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.input.model.options')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.input.model.label')).toHaveLength(0)
  expect(dialog.hooks.routingOpen.getSnapshot()).toBe(false)
  expect(b.ctx.get('remote.hemiRoutingSettings')).toBeUndefined()
})

it('binds enable/disable commands to the originating Session and propagates refusal', async () => {
  const b = await bench()
  const mode = b.ctx.slots.entries('conversation.input.model.options')[0]!
  const firstValue: object = mode.inject!(SessionId('first') as never)
  const secondValue: object = mode.inject!(SessionId('second') as never)
  const first = firstValue as RoutingModeInjected
  const second = secondValue as RoutingModeInjected
  await expect(first.setEnabled(true)).resolves.toBeNull()
  expect(b.setEnabled).toHaveBeenLastCalledWith('first', true)
  await expect(second.setEnabled(false)).resolves.toBeNull()
  expect(b.setEnabled).toHaveBeenLastCalledWith('second', false)
  b.setEnabled.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
  await expect(first.setEnabled(true)).resolves.toBe('offline')
  expect(b.setEnabled).toHaveBeenLastCalledWith('first', true)
})

it('surfaces catalog remote failures through the editor’s retry state', async () => {
  const b = await bench()
  const overlay = b.ctx.slots.entries('shell.overlay')[0]!
  const value: object = overlay.inject!()
  const dialog = value as RoutingDialogInjected
  b.modelCatalog.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) } as never)
  const settingsValue: object = b.ctx.slots.entries('settings.models.footer')[0]!.inject!()
  const settings = settingsValue as RoutingSettingsEntryInjected
  settings.openConfiguration()
  await vi.waitFor(() => { expect(dialog.hooks.routingCatalog.getSnapshot()).toMatchObject({ status: 'failed', error: 'offline' }) })
  dialog.refreshCatalog()
  await vi.waitFor(() => { expect(dialog.hooks.routingCatalog.getSnapshot().status).toBe('ready') })
})

it('withdraws launcher and mode controls with the shell overlay declaration, then re-registers', async () => {
  const b = await bench()
  const overlay = b.ctx.slots.entries('shell.overlay')[0]!
  const value: object = overlay.inject!()
  const dialog = value as RoutingDialogInjected
  const settingsValue: object = b.ctx.slots.entries('settings.models.footer')[0]!.inject!()
  ;(settingsValue as RoutingSettingsEntryInjected).openConfiguration()
  b.collapse()
  expect(dialog.hooks.routingOpen.getSnapshot()).toBe(false)
  expect(b.ctx.slots.entries('settings.models.footer')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.input.model.options')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.input.model.label')).toHaveLength(0)
  b.declare()
  await vi.waitFor(() => { expect(b.ctx.slots.entries('conversation.input.model.options')).toHaveLength(1) })
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(1)
})

it('keeps the Host half inert and the Client exports limited to the Loader entry', async () => {
  expect(() => { hostApply() }).not.toThrow()
  const module = await import('../src/client/index.ts')
  expect(Object.keys(module).sort()).toEqual(['apply', 'inject'])
})

it('rejects a conflicting contribution without leaving controls behind', async () => {
  const b = await bench()
  await expect(mountRouting(b.ctx, routingContribution)).rejects.toThrow(/already mounted/)
  expect(b.ctx.slots.entries('conversation.input.model.options')).toHaveLength(1)
  await b.fiber.dispose()
  expect(b.ctx.slots.entries('conversation.input.model.options')).toHaveLength(0)
  expect(b.ctx.get('remote.hemiRoutingSettings')).toBeUndefined()
})

it('rolls back its Remote namespace when control registration fails', async () => {
  const b = await bench()
  await b.fiber.dispose()
  b.get.mockImplementationOnce(() => { throw new Error('settings unavailable') })
  const failing = b.ctx.plugin({ inject: ['remote', 'slots', 'locale', 'configForms'], apply: ctx => mountRouting(ctx, routingContribution) })
  await expect(failing.await()).rejects.toThrow('settings unavailable')
  await failing.dispose()
  expect(b.ctx.get('remote.hemiRoutingSettings')).toBeUndefined()
  expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(b.ctx.slots.entries('conversation.input.model.options')).toHaveLength(0)
})

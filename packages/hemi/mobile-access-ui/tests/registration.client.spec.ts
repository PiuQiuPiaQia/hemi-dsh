import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { mountMobile } from '../src/client/mount.ts'
import { MobileSection } from '../src/client/MobileSection.tsx'
import type { MobileInjected } from '../src/client/types.ts'
import { remoteFixture } from './fixtures.client.ts'

function hasTestedActions(value: Record<string, unknown>): value is Record<string, unknown> & Pick<MobileInjected, 'refresh' | 'stop'> {
  return typeof value.refresh === 'function' && typeof value.stop === 'function'
}

function hasNativeConnection(value: Record<string, unknown>): value is Record<string, unknown> & Pick<MobileInjected, 'nativeConnection'> {
  const connection = value.nativeConnection
  return typeof connection === 'object' && connection !== null
    && 'serverName' in connection && typeof connection.serverName === 'string'
    && 'disconnect' in connection && typeof connection.disconnect === 'function'
}

afterEach(() => { vi.unstubAllGlobals() })

it('injects the document native capability and dispatches teardown without invoking any management Remote', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const disconnect = vi.fn()
  vi.stubGlobal('window', { __HEMI_MOBILE__: Object.freeze({ version: 1, serverName: '电脑', disconnect }) })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const remote = remoteFixture()
  const invokeRemote = vi.fn((): never => { throw new Error('Native settings must not invoke management Remote') })
  for (const method of Object.values(remote)) method.mockImplementation(invokeRemote)
  ctx.provide('remote', { $mount: async () => {
    const remove = ctx.reflect.provide('remote.hemiMobileAccess', remote)
    return async () => { await remove() }
  } } as never)
  ctx.provide('resources', { register: () => () => {} } as never)
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const fiber = ctx.plugin({
    inject: ['slots', 'locale', 'remote', 'resources'],
    apply: scope => mountMobile(scope, { package: '@fixture/mobile', descriptors: [] }),
  })
  await fiber.await()
  const section = ctx.slots.entries('settings.section')[0]!
  const injected = section.inject!()
  if (!hasNativeConnection(injected) || injected.nativeConnection === null) throw new Error('Native disconnect action is missing')
  const connection = injected.nativeConnection
  expect(connection).toMatchObject({ serverName: '电脑' })
  expect(connection.disconnect()).toBe('dispatched')
  expect(connection.disconnect()).toBe('dispatched')
  ctx.emit('connection/reset')
  expect(disconnect).toHaveBeenCalledExactlyOnceWith()
  expect(invokeRemote).not.toHaveBeenCalled()
  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
})

it('registers a real settings section without starting LAN and removes UI and resources before its namespace', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const remote = remoteFixture()
  const unmount = vi.fn()
  ctx.provide('remote', { $mount: async () => {
    const remove = ctx.reflect.provide('remote.hemiMobileAccess', remote)
    return async () => {
      expect(ctx.slots.entries('settings.section')).toHaveLength(0)
      expect(providers.size).toBe(0)
      unmount()
      await remove()
    }
  } } as never)
  const providers = new Set<ResourceProvider<'hemi-mobile-access'>>()
  ctx.provide('resources', { register: (provider: ResourceProvider<'hemi-mobile-access'>) => {
    providers.add(provider)
    return () => { providers.delete(provider) }
  } } as never)
  const declare = () => ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  let collapse = declare()
  const fiber = ctx.plugin({
    inject: ['slots', 'locale', 'remote', 'resources'],
    apply: scope => mountMobile(scope, { package: '@fixture/mobile', descriptors: [] }),
  })
  await fiber.await()
  expect(providers.size).toBe(1)
  expect(remote.getState).not.toHaveBeenCalled()
  expect(remote.start).not.toHaveBeenCalled()
  const section = ctx.slots.entries('settings.section')[0]!
  expect(section.component).toBe(MobileSection)
  const injected = section.inject!()
  if (!hasTestedActions(injected)) throw new Error('Settings registration is missing refresh or stop actions')
  collapse()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  collapse = declare()
  expect(ctx.slots.entries('settings.section')).toHaveLength(1)
  await fiber.dispose()
  expect(unmount).toHaveBeenCalledOnce()
  injected.refresh()
  expect(await injected.stop()).toEqual({ kind: 'withdrawn' })
  expect(remote.stop).not.toHaveBeenCalled()
  collapse()
})

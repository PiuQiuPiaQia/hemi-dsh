import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRenderSlots, RegisterFactoryOptions } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'
import { createModelActionFeedback, ModelActionToast } from '../src/client/ModelActionToast.tsx'

type Feedback = Omit<ReturnType<typeof createModelActionFeedback>, 'reportModelFailure'>

function OverlayFrame({ renderSlot }: PropsRenderSlots<'shell.overlay'>) {
  return renderSlot('shell.overlay', {})
}

it('withdraws the shell toast on declaration collapse and plugin disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const unmount = vi.fn(async () => {})
  // The transport mount is external to this registration test; the browser scenario uses its real descriptors.
  ctx.provide('remote', { $mount: async () => unmount, hemiModelAccess: {} } as never)
  ctx.provide('remote.hemiModelAccess', {} as never)
  const factories = vi.spyOn(ctx.slots, 'registerFactory')
  const declare = () => ctx.slots.register({ name: 'root', children: {
    'shell.overlay': { kind: 'list', scope: 'root' },
  } }, OverlayFrame)
  const collapse = declare()
  const fiber = ctx.plugin({ inject, apply })
  await fiber.await()
  const entry = ctx.slots.entries('shell.overlay')[0]!
  expect(entry.component).toBe(ModelActionToast)
  expect(entry.options.id).toBe('hemi.model-action-toast')
  const feedback = entry.inject!() as Feedback
  const connections = factories.mock.calls.find(([options]) => options.name === 'hemi.models.connections')!
  const options = connections[0] as RegisterFactoryOptions<'hemi.models.connections'>
  const face = options.inject()
  face.actions.reportModelFailure({ operation: 'test', model: 'model/a' })
  expect(feedback.hooks.modelActionNotice.getSnapshot()).toEqual([{ operation: 'test', model: 'model/a', seq: 1 }])
  collapse()
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
  declare()
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)
  const remounted = ctx.slots.entries('shell.overlay')[0]!.inject!() as Feedback
  expect(remounted.hooks.modelActionNotice).toBe(feedback.hooks.modelActionNotice)
  await fiber.dispose()
  expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
  expect(unmount).toHaveBeenCalledOnce()
})

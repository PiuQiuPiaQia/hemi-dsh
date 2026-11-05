/** Independent settings navigation and plugin-owned registration lifetime. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { expect, it, onTestFinished } from 'vitest'
import { mountBackup } from '../src/client/index.ts'

it('registers one localized Backup page and removes it before withdrawing Remote', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({ name: 'root', children: {
    'settings.section': { kind: 'list', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  let withdrawn = false
  ctx.provide('remote', {
    async $mount() {
      const remove = ctx.provide('remote.hemiBackup', {} as never)
      return async () => {
        expect(ctx.slots.entries('settings.section')).toHaveLength(0)
        remove()
        withdrawn = true
      }
    },
  } as never)
  const fiber = ctx.plugin({
    inject: ['slots', 'locale', 'remote'],
    apply: scope => mountBackup(scope, { package: '@fixture/backup', descriptors: [] }),
  })
  await fiber.await()
  const pages = ctx.slots.entries('settings.section')
  expect(pages).toHaveLength(1)
  expect(pages[0]).toMatchObject({ options: { id: 'hemi-backup', order: 70 }, locale: 'hemi-backup' })
  const label = pages[0]?.options.label
  expect(resolveSlotLabel(label)).toBe('备份')
  locale.setLocale('en')
  expect(resolveSlotLabel(label)).toBe('Backup')
  expect(ctx.slots.entries('settings.general.item')).toHaveLength(0)
  await fiber.dispose()
  expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  expect(withdrawn).toBe(true)
})

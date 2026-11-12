/** Subscription disconnect through the real Loader, ConfigEditor, and Settings pipeline. */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { initProfile, mountRootInclude, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import HemiModelAccess from '../src/index.ts'
import { asObject } from '../src/response.ts'

const contexts: Context[] = []
const homes: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

interface Host {
  ctx: Context
  service: HemiModelAccess
  patchPath: string
}

/** One profile whose pi-ai section stores the supplied routes. */
function createProfile(providers: Record<string, unknown>, subscriptionModels: Record<string, string[]> = {}): {
  profile: ProfileContext
  patchPath: string
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-hemi-disconnect-')))
  homes.push(home)
  const dir = join(home, 'profile')
  initProfile(dir, ['test-disconnect-bundle'])
  const bundle = join(dir, 'node_modules', 'test-disconnect-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-disconnect-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'llm-pi-ai', name: 'cordis:llm-pi-ai', config: {} },
    { id: 'hemi-model-access', name: 'cordis:hemi-model-access', config: {} },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  // The selected models live in the user patch layer, as a subscription's own writes do.
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    ...Object.entries(providers).flatMap(([id, profile]) => [
      `      ${id}:`,
      ...Object.entries(profile as Record<string, unknown>).map(([key, value]) =>
        `        ${key}: ${JSON.stringify(value)}`),
    ]),
    '- id: hemi-model-access',
    '  config:',
    '    subscriptionModels:',
    ...Object.entries(subscriptionModels).map(([id, models]) => `      ${id}: ${JSON.stringify(models)}`),
    '',
  ].join('\n'))
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-disconnect-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  return { profile, patchPath: join(dir, 'cordis.patch.yml') }
}

/** Boot the profile with a real Loader, ConfigEditor, Settings, and credential store. */
async function startHost(providers: Record<string, unknown>, subscriptionModels: Record<string, string[]> = {}): Promise<Host> {
  const { profile, patchPath } = createProfile(providers, subscriptionModels)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(profile.home, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  ctx.baseUrl = pathToFileURL(profile.home).href + '/'
  ctx.provide('profileContext', profile)
  await ctx.plugin(Loader)
  ctx.loader.builtins['llm-pi-ai'] = LlmPiAi
  ctx.loader.builtins['hemi-model-access'] = HemiModelAccess
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(Settings)
  await mountRootInclude(ctx, join(profile.dir, 'cordis.yml'), readProfilePatches('test', profile))
  await ctx.loader.await()
  const service = ctx.get('hemiModelAccess')
  if (service === undefined) throw new Error('the loaded composition did not publish hemiModelAccess')
  return { ctx, service, patchPath }
}

/** The stored `providers` map of the pi-ai settings namespace. */
function storedProviders(ctx: Context): Record<string, unknown> {
  const section = ctx.settings.describe().find(item => item.ns === 'llm-pi-ai')
  if (section === undefined) throw new Error('pi-ai settings are unavailable')
  return asObject(asObject(section.value)?.providers) ?? {}
}

/** The saved `subscriptionModels` map of the Hemi model-access namespace. */
function volatileModels(ctx: Context): Record<string, unknown> {
  const section = ctx.settings.describe().find(item => item.ns === 'hemi-model-access')
  if (section === undefined) throw new Error('hemi model-access settings are unavailable')
  return asObject(asObject(section.value)?.subscriptionModels) ?? {}
}

describe('subscription disconnect', () => {
  it('removes the route whose models the subscription selected', async () => {
    const host = await startHost({ 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }], hiddenModels: [] } })
    expect((await host.ctx.llm.listModels('openai-codex')).map(model => model.id)).toEqual(['gpt-6.1-sol'])

    await host.service.disconnect('openai-codex')

    expect(storedProviders(host.ctx)).toEqual({})
    await expect(host.ctx.llm.listModels('openai-codex')).rejects.toMatchObject({ code: 'NO_ADAPTER' })
  })

  it('drops the GLM selections so the coding plan offers no model', async () => {
    const host = await startHost({}, { bigmodel: ['glm-5.3'] })
    await host.ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'bigmodel'), () => Promise.resolve({
      kind: 'grant' as const,
      payload: { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 60_000 },
    }))
    expect((await host.ctx.llm.listModels('bigmodel')).map(model => model.id)).toEqual(['glm-5.3'])

    await host.service.disconnect('bigmodel')

    expect(volatileModels(host.ctx)).toEqual({})
    expect(await host.ctx.llm.listModels('bigmodel')).toEqual([])
  })

  it('keeps a route an API key authenticates', async () => {
    const host = await startHost({ 'openai-codex': { models: [{ id: 'gpt-6.1-sol' }], apiKeyEnv: 'OPENAI_API_KEY' } })

    await host.service.disconnect('openai-codex')

    expect(Object.keys(storedProviders(host.ctx))).toEqual(['openai-codex'])
  })
})

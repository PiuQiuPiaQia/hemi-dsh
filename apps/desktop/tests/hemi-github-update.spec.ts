/** Hemi fork: qualify GitHub generic feeds through the existing Desktop update adapters. */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { afterEach, expect, it } from 'vitest'
import { parseUpdateInfo, resolveFiles } from 'electron-updater/out/providers/Provider.js'
import { resolveDesktopAutoUpdateConfig, resolveDesktopUploadConfig } from '../scripts/desktop-auto-update-environment.mjs'
import { loadDesktopPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { resolveDesktopPolicyEnvironment } from '../scripts/desktop-policy-environment.mjs'
import { createMacOSAppUpdateConfig, verifyMacOSAppUpdateConfig, writeMacOSAppUpdateConfig } from '../scripts/macos-app-update-config.mjs'

const roots: string[] = []
const GITHUB = { DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', HEMI_DESKTOP_GITHUB_REPOSITORY: 'example/hemi-dsh',
  HEMI_DESKTOP_UPDATE_POLICY: 'disabled' }
const root = fileURLToPath(new URL('../../..', import.meta.url))

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'hemi-update-config-'))
  roots.push(path)
  return path
}

it.each([['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']] as const)('embeds a platform-specific public feed for %s %s', (platform, arch) => {
  const update = resolveDesktopAutoUpdateConfig(GITHUB, platform, arch)
  expect(update.publicUrl).toBe(`https://raw.githubusercontent.com/example/hemi-dsh/desktop-update-feeds/feeds/${platform === 'darwin' ? 'mac' : 'win'}-${arch}/`)
  expect(resolveDesktopPolicyEnvironment(GITHUB)).toBeUndefined()
  expect(() => resolveDesktopUploadConfig(GITHUB, platform, arch)).toThrow('instead of COS')
})

it('keeps existing DSH policy requirements unless Hemi explicitly disables them', () => {
  expect(() => resolveDesktopPolicyEnvironment({ ...GITHUB, HEMI_DESKTOP_UPDATE_POLICY: undefined })).toThrow('HTTPS origin')
  expect(() => resolveDesktopPolicyEnvironment({ DSH_DESKTOP_AUTO_UPDATE_ENV: 'production', HEMI_DESKTOP_UPDATE_POLICY: 'disabled' }))
    .toThrow('REPOSITORY')
})

it.each(['macos', 'windows'])('loads file-owned %s distribution and ignores ambient redirection', async (platform) => {
  const path = await directory()
  const env = Object.entries(GITHUB).map(([name, value]) => `${name}=${value}`).join('\n') + '\n'
  await writeFile(join(path, `.env.${platform}`), env)
  const selected = loadDesktopPackageEnvironment(platform === 'macos' ? 'darwin' : 'win32', {
    HEMI_DESKTOP_GITHUB_REPOSITORY: 'wrong/repository', HEMI_DESKTOP_GITHUB_FEED_BRANCH: 'wrong',
    HEMI_DESKTOP_UPDATE_POLICY: 'required', DSH_DESKTOP_UPDATE_CHANNEL: 'stable',
  }, path)
  expect(selected).toMatchObject(GITHUB)
  expect(selected.HEMI_DESKTOP_GITHUB_FEED_BRANCH).toBeUndefined()
  expect(resolveDesktopAutoUpdateConfig(selected, platform === 'macos' ? 'darwin' : 'win32', 'x64').channel).toBe('stable')
})

it('loads GitHub settings from production presets while keeping signing secrets separate', async () => {
  const path = await directory()
  await mkdir(join(path, 'presets'))
  await writeFile(join(path, 'presets/production.env'), Object.entries(GITHUB).map(([key, value]) => `${key}=${value}`).join('\n') + '\n')
  const selected = loadDesktopPackageEnvironment('darwin', { DSH_PACKAGING_PRESET: 'production', DSH_PACKAGING_CONFIG_DIR: path }, path, { unsigned: true })
  expect(selected).toMatchObject(GITHUB)
})

it('seals the GitHub generic feed before signing and verifies it without a main-process change', async () => {
  const path = await directory()
  const resources = join(path, 'Contents/Resources')
  await mkdir(resources, { recursive: true })
  const update = resolveDesktopAutoUpdateConfig({ ...GITHUB, DSH_DESKTOP_UPDATE_CHANNEL: 'stable' }, 'darwin', 'arm64')
  expect(createMacOSAppUpdateConfig(update, 'test-cache')).toMatchObject({ provider: 'generic', url: update.publicUrl, channel: 'stable' })
  await writeMacOSAppUpdateConfig(resources, update, 'test-cache')
  await expect(verifyMacOSAppUpdateConfig(path, update, 'test-cache')).resolves.toBeUndefined()
})

it('the pinned real updater resolves absolute Release URLs from the public branch feed', async () => {
  const snapshot = JSON.parse(await readFile(join(root, 'packages/hemi/customizations/tests/expected/github-release.json'), 'utf8')) as {
    feeds: { path: string; contents: string }[]
  }
  for (const feed of snapshot.feeds) {
    const base = new URL(`https://raw.githubusercontent.com/example/hemi-dsh/desktop-update-feeds/${feed.path}`)
    const metadata = parseUpdateInfo(feed.contents, feed.path, base)
    const files = resolveFiles(metadata, base)
    expect(files[0]!.url.href).toMatch(/^https:\/\/github.com\/example\/hemi-dsh\/releases\/download\/hemi-desktop-stable-v1.2.3\//u)
    expect(files[0]!.info.sha512).toBe(metadata.files[0]!.sha512)
  }
})

it('the source CLI prepares tag-triggered builds and rejects a version from another product', async () => {
  const output = join(await directory(), 'outputs')
  const product = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
  const run = (version: string) => spawnSync(process.execPath, ['--import', 'tsx/esm',
    'apps/desktop/scripts/hemi-github-release.ts', 'prepare'], { cwd: root, encoding: 'utf8', env: {
    ...process.env, GITHUB_OUTPUT: output, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `hemi-desktop-v${version}`,
    GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/hemi-dsh', HEMI_RELEASE_CHANNEL: '',
    HEMI_RELEASE_TARGETS: undefined, HEMI_RELEASE_SIGNING_MODE: 'community', HEMI_RELEASE_VERSION: '',
  }, timeout: 15_000 })
  const valid = run(product.version)
  expect(valid.error).toBeUndefined()
  expect(valid.signal).toBeNull()
  expect(valid.stderr).toBe('')
  expect(valid.status).toBe(0)
  expect(await readFile(output, 'utf8')).toContain('targets=mac-arm64,mac-x64,win-x64\n')
  expect(run('99.0.0').status).not.toBe(0)
})

interface Workflow {
  on: { push: unknown; workflow_dispatch: { inputs: Record<string, { default?: string; options?: string[] }> } }
  env: Record<string, string>
  permissions: Record<string, string>
  concurrency: { 'cancel-in-progress': boolean }
  jobs: Record<string, {
    needs?: string[]
    permissions?: Record<string, string>
    environment?: string
    steps: { run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }[]
  }>
}

it('defaults manual and tag-triggered releases to all three desktop targets', () => {
  const workflow = load(readFileSync(resolve(root, '.github/workflows/hemi-desktop-release.yml'), 'utf8')) as Workflow
  expect(workflow.on.workflow_dispatch.inputs.targets).toMatchObject({
    default: 'all', options: ['mac-arm64', 'mac-all', 'win-x64', 'all'],
  })
  expect(workflow.env.HEMI_RELEASE_TARGETS).toBe("${{ inputs.targets || vars.HEMI_DESKTOP_RELEASE_TARGETS || 'all' }}")
})

it('keeps a single GitHub publisher after all signed packages and previews without a token', () => {
  const workflow = load(readFileSync(resolve(root, '.github/workflows/hemi-desktop-release.yml'), 'utf8')) as Workflow
  expect(Object.keys(workflow.on)).toEqual(['push', 'workflow_dispatch'])
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  expect(workflow.jobs.publish!.needs).toEqual(['prepare', 'package'])
  expect(workflow.jobs.publish!.permissions?.contents).toBe('write')
  expect(workflow.jobs.publish!.environment).toBe('hemi-desktop-production')
  const steps = workflow.jobs.publish!.steps
  expect(steps.find(step => step.run?.endsWith('preview'))?.env?.GH_TOKEN).toBeUndefined()
  expect(steps.filter(step => step.run?.endsWith('publish'))).toHaveLength(1)
  expect(workflow.jobs.package!.steps.some(step => step.run?.includes('--publish'))).toBe(false)
  expect(workflow.jobs.package!.steps.some(step => step.run?.includes('--unsigned') || step.run?.includes('--skip-notarization'))).toBe(false)
})

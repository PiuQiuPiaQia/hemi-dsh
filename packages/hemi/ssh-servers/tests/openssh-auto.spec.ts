/** Automatic runtime readiness and plain-SSH browsing against a real localhost OpenSSH server; nothing is preconfigured. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search/src/search-core.ts'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/workspaces'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { createOpenSshFixture } from './support/openssh.ts'

const run = promisify(execFile)
const overlay = fileURLToPath(new URL('./support/openssh-profile.patch.yml', import.meta.url))
const builder = fileURLToPath(new URL('./support/remote-helper-build.mjs', import.meta.url))
const canRun = process.platform !== 'win32' && existsSync('/usr/sbin/sshd')

let artifactsDir: string

/** Build the shipped-layout helper artifact set once; product packaging produces the same tree under lib/remote. */
beforeAll(async () => {
  if (!canRun) return
  const parent = await realpath(tmpdir())
  artifactsDir = await mkdtemp(join(parent, 'hemi-ssh-artifacts-'))
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [builder, artifactsDir], { stdio: ['ignore', 'ignore', 'inherit'] })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`helper artifact build failed (${code})`))
    })
  })
  expect(existsSync(join(artifactsDir, 'manifest.json'))).toBe(true)
}, 120_000)

afterEach(() => { vi.unstubAllEnvs() })

async function bootProfile(): Promise<Context> {
  return bootProductionProfile({
    binName: 'SSH auto runtime acceptance', profile: 'web', overlayPaths: [overlay],
    prepare: (ctx) => {
      provideCmdline(ctx, { args: ['--no-open', '--port', '0'], exit: (code) => { throw new Error(`Unexpected Web exit ${code}`) } })
    },
  })
}

/** One remote exercise of the prepared execution target: files, processes, PTC and Bash. */
async function exercise(agent: Agent, cwd: string, expected: string): Promise<void> {
  const fs = agent.ctx.get('fs')
  const subprocess = agent.ctx.get('subprocess')
  const ptc = agent.ctx.get('ptcRuntime')
  const shell = agent.ctx.get('shell')
  assert(fs && subprocess && ptc && shell)
  expect(fs.processPathFromHostPath(cwd)).toBeUndefined()
  expect(await fs.readText(await fs.resolve('identity.txt'))).toBe(expected)
  const preview = agent.ctx.get('workspaceFiles')!
  const scope: WorkspaceFileScope = { sessionId: agent.id, workspaceRoot: cwd, executionTarget: agent.session.header.executionTarget }
  expect((await preview.read(scope, 'identity.txt', {}, new AbortController().signal)).text).toBe(expected)
  const execution = subprocess.spawn({
    argv: ['/bin/pwd'], cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000,
  })
  expect(await execution.done).toEqual({ exitCode: 0, signal: null })
  assert(execution.collected.stdout)
  expect(execution.collected.stdout.readFrom(0).text.trim()).toBe(cwd)
  const rg = await subprocess.resolveExecutable({ command: 'rg', resolveLocalPath: async () => {
    throw new Error('A remote lookup must not invoke the Harness packaged-binary locator')
  } })
  const search = subprocess.spawn({ argv: [rg, '--no-config', '--files'], cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000 })
  expect(await search.done).toEqual({ exitCode: 0, signal: null })
  assert(search.collected.stdout)
  expect(search.collected.stdout.readFrom(0).text.split('\n')).toContain('identity.txt')
  const policy = agent.ctx.get('sandboxPolicy')!.resolve({ session: agent.session })
  const written = await fs.writeText(await fs.resolve('via-auto-ssh.txt'), `written:${expected}`, undefined, undefined, policy)
  expect(written.after).toBe(`written:${expected}`)
  const program = await ptc.run(ptc.resolve({
    program: 'return { value: 42, cwd: process.cwd() }', bindings: [], cwd, sandboxPolicy: policy,
  }))
  expect(program.error).toBeUndefined()
  expect(program.value).toEqual({ value: 42, cwd })
  const bash = await (await shell.execute(shell.resolve({ command: 'pwd; cat identity.txt', workdir: cwd, sandboxPolicy: policy }))).result()
  expect(bash.exitCode).toBe(0)
  expect(bash.stdout.text.trim()).toBe(`${cwd}\n${expected}`)
}

// Real sshd, streamed helper and profile boot share this integration budget.
it.skipIf(!canRun)(
  'connects a fresh saved server with no configured runtime, browses its login directory and executes remotely',
  async () => {
    const ssh = await createOpenSshFixture({
      env: { HOME: '${root}/remote-home', XDG_CACHE_HOME: '${root}/remote-xdg' },
    })
    let ctx: Context | undefined
    try {
      const remoteHome = join(ssh.root, 'remote-home')
      const remoteCache = join(ssh.root, 'remote-xdg')
      // The fixture operator installs its available Node on the fake server's PATH, like any real host.
      await symlink(process.execPath, join(ssh.bin, 'node'))
      await symlink(await resolveRgPath(), join(ssh.bin, 'rg'))
      const project = join(remoteHome, 'project')
      await mkdir(project, { recursive: true })
      await writeFile(join(project, 'identity.txt'), 'auto-runtime')
      const direct = await run('/usr/bin/ssh', ['-F', ssh.clientConfig, ssh.host, 'printf inetd-ready'])
      expect(direct.stdout).toBe('inetd-ready')
      vi.stubEnv('DSH_HOME', join(ssh.root, 'harness-home'))
      vi.stubEnv('DSH_AGENTS_HOME', join(ssh.root, 'agents-home'))
      vi.stubEnv('DSH_TELEMETRY_DISABLED', '1')
      vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', artifactsDir)
      vi.stubEnv('PATH', `${ssh.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`)
      ctx = await bootProfile()
      const servers = ctx.get('hemiSshServers')!
      const folders = ctx.get('hemiSshWorkspaces')!
      const input = { name: 'Loopback auto', host: ssh.host, port: ssh.port,
        username: ssh.username, identityFile: ssh.identityFile }
      const server = await servers.create(input, new AbortController().signal)
      const signal = new AbortController().signal

      // Draft browsing needs no runtime: an empty path resolves the remote login directory.
      const draftHome = await folders.browseServer(input, '', signal)
      expect(draftHome.path).toBe(remoteHome)
      expect(draftHome.directories.map(entry => entry.name)).toContain('project')

      // Saved browsing needs no runtime either and refuses a stale endpoint revision first.
      const savedHome = await folders.browseSavedFolders(server.id, '', server.revision, signal)
      expect(savedHome).toEqual(draftHome)
      const projectView = await folders.browseSavedFolders(server.id, project, server.revision, signal)
      expect(projectView.directories).toEqual([])

      // connectServer deploys the bundled runtime into the owned cache and verifies it for real.
      const ready = await folders.connectServer(server.id, server.revision, signal)
      expect(ready.deployment.launch).toMatchObject({ kind: 'node-script', node: join(ssh.bin, 'node') })
      expect(ready.deployment.helper.startsWith(`${remoteCache}/hemi-ssh/helper-`)).toBe(true)
      const again = await folders.connectServer(server.id, server.revision, signal)
      expect(again.revision).toBe(ready.revision)
      const helperBytes = await readFile(ready.deployment.helper.replace(remoteCache, remoteCache))
      const manifest = JSON.parse(await readFile(join(artifactsDir, 'manifest.json'), 'utf8')) as { files: { path: string; sha256: string }[] }
      const helperEntry = manifest.files.find(file => file.path === 'runtime/helper/helper.js')
      assert(helperEntry)
      const { createHash } = await import('node:crypto')
      expect(createHash('sha256').update(helperBytes).digest('hex')).toBe(ready.deployment.helperHash)
      expect(helperEntry.sha256).toBe(ready.deployment.helperHash)

      // Opening the prepared directory yields a true remote execution target.
      const selection = await folders.prepareServerFolder(server.id, project, server.revision, signal)
      expect(selection.path).toBe(project)
      const workspace = await ctx.get('workspaceController')!.create(selection)
      const created = await ctx.get('sessionController')!.create({ workspaceId: workspace.workspace.workspaceId })
      const agent = ctx.get('agents')!.get(created.sessionId)!
      expect(agent.session.header.executionTarget).toEqual(selection.executionTarget)
      await exercise(agent, project, 'auto-runtime')

      // The login directory stays openable; a directory containing the deployed runtime is refused explicitly.
      const homeSelection = await folders.prepareServerFolder(server.id, '', server.revision, signal)
      expect(homeSelection.path).toBe(remoteHome)
      await expect(folders.prepareServerFolder(server.id, ssh.root, server.revision, signal))
        .rejects.toMatchObject({ code: 'hemi-ssh/runtime-inside-workspace' })
    } catch (error: unknown) {
      throw new Error(`Automatic OpenSSH runtime acceptance failed. sshd diagnostics:\n${ssh.diagnostics()}`, { cause: error })
    } finally {
      try { await ctx?.fiber.dispose() } finally { await ssh.close() }
    }
  },
  180_000,
)

it.skipIf(!canRun)('reports unreachable or untrusted endpoints precisely before any runtime work', async () => {
  const ssh = await createOpenSshFixture()
  let ctx: Context | undefined
  try {
    vi.stubEnv('DSH_HOME', join(ssh.root, 'harness-home'))
    vi.stubEnv('DSH_AGENTS_HOME', join(ssh.root, 'agents-home'))
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '1')
    vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', artifactsDir)
    // No fixture ssh wrapper on PATH: the host's own ssh reaches a port nothing listens on.
    ctx = await bootProfile()
    const servers = ctx.get('hemiSshServers')!
    const server = await servers.create({ name: 'Dead port', host: '127.0.0.1', port: 1,
      username: ssh.username, identityFile: ssh.identityFile }, new AbortController().signal)
    const signal = new AbortController().signal
    await expect(ctx.get('hemiSshWorkspaces')!.browseServer(
      { name: 'Dead port', host: '127.0.0.1', port: 1, username: '', identityFile: '' }, '/tmp', signal))
      .rejects.toMatchObject({ code: 'hemi-ssh/ssh-unavailable' })
    await expect(ctx.get('hemiSshWorkspaces')!.connectServer(server.id, server.revision, signal))
      .rejects.toMatchObject({ code: 'hemi-ssh/ssh-unavailable' })
  } finally {
    try { await ctx?.fiber.dispose() } finally { await ssh.close() }
  }
}, 120_000)

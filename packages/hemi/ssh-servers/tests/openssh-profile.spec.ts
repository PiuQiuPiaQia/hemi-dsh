/** Real localhost OpenSSH and shipped Web-profile acceptance; no execution provider or SSH transport is mocked. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search/src/search-core.ts'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers'
import type {} from '@deepseek-ai/dsh-hemi-ssh-servers/workspaces'
import type { SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import type { SshRuntimeDeployment } from '../src/workspace-types.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { createOpenSshFixture } from './support/openssh.ts'

const run = promisify(execFile)
const overlay = fileURLToPath(new URL('./support/openssh-profile.patch.yml', import.meta.url))
const helper = fileURLToPath(new URL('../../../ssh/ssh/lib/helper.js', import.meta.url))
const bootstrap = fileURLToPath(new URL('../../../ptc-runtime/ptc-runtime-node/lib/process.js', import.meta.url))

afterEach(() => { vi.unstubAllEnvs() })

async function bootProfile(): Promise<Context> {
  return bootProductionProfile({
    binName: 'SSH profile acceptance', profile: 'web', overlayPaths: [overlay],
    prepare: (ctx) => {
      provideCmdline(ctx, { args: ['--no-open', '--port', '0'], exit: (code) => { throw new Error(`Unexpected Web exit ${code}`) } })
    },
  })
}

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
  expect(await agent.ctx.get('typert')!.lookups.get('workspaceFileScope')!.resolve(agent.id)).toEqual(scope)
  const signal = new AbortController().signal
  expect(scope.executionTarget).toEqual(agent.session.header.executionTarget)
  expect((await preview.read(scope, 'identity.txt', {}, signal)).text).toBe(expected)
  expect(Buffer.from((await preview.readBytes(scope, 'identity.txt', {}, signal)).data).toString('utf8')).toBe(expected)
  expect((await preview.stat(scope, 'identity.txt', signal)).absolutePath).toBe(join(cwd, 'identity.txt'))
  expect((await preview.list(scope, '.', signal)).entries.map(entry => entry.name)).toContain('identity.txt')
  const changes = preview.changes(scope, 'identity.txt', signal)[Symbol.asyncIterator]()
  try { await expect(changes.next()).rejects.toMatchObject({ code: 'workspace-file/watch-unsupported' }) }
  finally { await changes.return?.() }
  expect((await preview.read(scope, 'identity.txt', {}, signal)).text).toBe(expected)
  const execution = subprocess.spawn({
    argv: ['/bin/pwd'], cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    graceMs: 3000,
  })
  expect(await execution.done).toEqual({ exitCode: 0, signal: null })
  assert(execution.collected.stdout)
  expect(execution.collected.stdout.readFrom(0).text.trim()).toBe(cwd)
  expect(await execution.waitForExit()).toBe(true)
  const rg = await subprocess.resolveExecutable({ command: 'rg', resolveLocalPath: async () => {
    throw new Error('A remote lookup must not invoke the Harness packaged-binary locator')
  } })
  const search = subprocess.spawn({ argv: [rg, '--no-config', '--files'], cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 3000 })
  expect(await search.done).toEqual({ exitCode: 0, signal: null })
  assert(search.collected.stdout)
  expect(search.collected.stdout.readFrom(0).text.split('\n')).toContain('identity.txt')
  expect(await search.waitForExit()).toBe(true)
  const policy = agent.ctx.get('sandboxPolicy')!.resolve({ session: agent.session })
  const written = await fs.writeText(await fs.resolve('via-ssh.txt'), `written:${expected}`, undefined, undefined, policy)
  expect(written.after).toBe(`written:${expected}`)
  expect(await fs.readText(await fs.resolve('via-ssh.txt'))).toBe(`written:${expected}`)
  const program = await ptc.run(ptc.resolve({
    program: "return { value: 42, cwd: process.cwd(), leaked: ['DSH_HOME', 'DSH_PROFILE_DIR'].filter(key => process.env[key] !== undefined) }",
    bindings: [], cwd, sandboxPolicy: policy,
  }))
  expect(program.error).toBeUndefined()
  expect(program.value).toEqual({ value: 42, cwd, leaked: [] })
  const bash = await (await shell.execute(shell.resolve({ command: 'pwd; cat identity.txt', workdir: cwd, sandboxPolicy: policy }))).result()
  expect(bash.exitCode).toBe(0)
  expect(bash.stdout.text.trim()).toBe(`${cwd}\n${expected}`)
}

// OpenSSH multiplexing, Unix stream forwarding and sshd require a POSIX host with an installed server.
it.skipIf(process.platform === 'win32' || !existsSync('/usr/sbin/sshd'))(
  'opens two saved SSH directory Workspaces and cold-resumes their actual execution target through a shipped profile',
  async () => {
    const ssh = await createOpenSshFixture()
    let ctx: Context | undefined
    try {
      const direct = await run('/usr/bin/ssh', ['-F', ssh.clientConfig, ssh.host, 'printf inetd-ready'])
      expect(direct.stdout).toBe('inetd-ready')
      const one = join(ssh.root, 'one')
      const two = join(ssh.root, 'two')
      // The fixture operator explicitly installs its available native rg on the remote PATH.
      await symlink(await resolveRgPath(), join(ssh.bin, 'rg'))
      await mkdir(one); await mkdir(two)
      await writeFile(join(one, 'identity.txt'), 'directory-one')
      await writeFile(join(two, 'identity.txt'), 'directory-two')
      vi.stubEnv('DSH_HOME', join(ssh.root, 'harness-home'))
      vi.stubEnv('DSH_AGENTS_HOME', join(ssh.root, 'agents-home'))
      vi.stubEnv('DSH_TELEMETRY_DISABLED', '1')
      vi.stubEnv('PATH', `${ssh.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`)
      ctx = await bootProfile()
      const servers = ctx.get('hemiSshServers')!
      const folders = ctx.get('hemiSshWorkspaces')!
      const server = await servers.create({ name: 'Loopback', host: ssh.host, port: ssh.port,
        username: ssh.username, identityFile: ssh.identityFile }, new AbortController().signal)
      const deployment: SshRuntimeDeployment = {
        helper, helperHash: createHash('sha256').update(await readFile(helper)).digest('hex'),
        launch: { kind: 'node-script', node: process.execPath, bootstrapPath: bootstrap,
          bootstrapHash: createHash('sha256').update(await readFile(bootstrap)).digest('hex') },
      }
      const signal = new AbortController().signal
      const runtime = await folders.configureRuntime(server.id, undefined, deployment, signal)
      const revision = { serverRevision: server.revision, runtimeRevision: runtime.revision }
      const first = await folders.browseFolders(server.id, one, revision, signal)
      const second = await folders.browseFolders(server.id, two, revision, signal)
      const selectedOne = await folders.prepareFolder(server.id, first.path, first.revision, signal)
      const selectedTwo = await folders.prepareFolder(server.id, second.path, second.revision, signal)
      expect(selectedOne.executionTarget).not.toEqual(selectedTwo.executionTarget)
      const workspaceController = ctx.get('workspaceController')!
      const a = await workspaceController.create(selectedOne)
      const b = await workspaceController.create(selectedTwo)
      expect(a.workspace.workspaceId).not.toBe(b.workspace.workspaceId)
      expect(a.workspace.path).toBe(one)
      expect(b.workspace.path).toBe(two)
      const createdOne = await ctx.get('sessionController')!.create({ workspaceId: a.workspace.workspaceId })
      const createdTwo = await ctx.get('sessionController')!.create({ workspaceId: b.workspace.workspaceId })
      const agentOne = ctx.get('agents')!.get(createdOne.sessionId)!
      const agentTwo = ctx.get('agents')!.get(createdTwo.sessionId)!
      expect(agentOne.session.header.executionTarget).toEqual(selectedOne.executionTarget)
      expect(agentTwo.session.header.executionTarget).toEqual(selectedTwo.executionTarget)
      await exercise(agentOne, one, 'directory-one')
      await exercise(agentTwo, two, 'directory-two')
      const target: SessionExecutionTarget = selectedOne.executionTarget
      await ctx.fiber.dispose()
      ctx = await bootProfile()
      expect(ctx.get('hemiSshServers')!.list(signal).map(row => row.id)).toContain(server.id)
      expect(ctx.get('workspaceRegistry')!.get(a.workspace.workspaceId)?.executionTarget).toEqual(target)
      const resumed = await ctx.get('agents')!.resume({ resumeSessionId: createdOne.sessionId })
      expect(resumed.agent.session.header.executionTarget).toEqual(target)
      expect(resumed.agent.session.header.cwd).toBe(one)
      await exercise(resumed.agent, one, 'directory-one')
      await resumed.dispose()
    } catch (error: unknown) {
      throw new Error(`Real OpenSSH profile acceptance failed. sshd diagnostics:\n${ssh.diagnostics()}`, { cause: error })
    } finally {
      try { await ctx?.fiber.dispose() } finally { await ssh.close() }
    }
  },
  // Two full source-profile Loader lifecycles plus real helper/process teardown share this integration budget.
  120_000,
)

/** Bundled artifact resolution and remote runtime preparation over a mocked OpenSSH transport. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'

beforeEach(() => { vi.clearAllMocks() })
import { loadHelperArtifacts } from '../src/runtime-artifacts.ts'
import { prepareRemoteRuntime, probeRemoteRuntime, streamHelperArtifacts } from '../src/runtime-bootstrap.ts'
import type { SshHelperArtifacts } from '../src/runtime-artifacts.ts'
import { PROVISIONED_NODE_VERSION } from '../src/node-provision.ts'
import { containsPath, type SshEndpointArgs } from '../src/browse.ts'

const transport = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.execFile,
}))

const signal = new AbortController().signal
const endpoint: SshEndpointArgs = { host: 'probe-host', port: 2200, username: 'user', identityFile: '' }

interface Directory { dir: string; artifacts: SshHelperArtifacts }

async function artifactDirectory(): Promise<Directory> {
  const dir = await mkdtemp(join(tmpdir(), 'hemi-ssh-runtime-'))
  onTestFinished(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }) })
  return { dir, artifacts: await fixtures(dir) }
}

async function fixtures(dir: string): Promise<SshHelperArtifacts> {
  const helper = Buffer.from('helper payload\n')
  const bootstrap = Buffer.from('bootstrap payload\n')
  const pkg = Buffer.from('{"name":"hemi-ssh-helper-runtime","version":"1.0.0-test","type":"module"}\n')
  await mkdir(join(dir, 'runtime/helper'), { recursive: true })
  await writeFile(join(dir, 'runtime/helper/helper.js'), helper)
  await writeFile(join(dir, 'runtime/helper/ptc-process.js'), bootstrap)
  await writeFile(join(dir, 'runtime/package.json'), pkg)
  const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    version: '1.0.0-test', helper: 'runtime/helper/helper.js', bootstrap: 'runtime/helper/ptc-process.js',
    files: [
      { path: 'runtime/helper/helper.js', sha256: digest(helper) },
      { path: 'runtime/helper/ptc-process.js', sha256: digest(bootstrap) },
      { path: 'runtime/package.json', sha256: digest(pkg) },
    ],
  }))
  const contentId = createHash('sha256')
    .update(JSON.stringify([
      ['runtime/helper/helper.js', digest(helper)],
      ['runtime/helper/ptc-process.js', digest(bootstrap)],
      ['runtime/package.json', digest(pkg)],
    ]))
    .digest('hex').slice(0, 16)
  return {
    version: '1.0.0-test', contentId, helperPath: 'runtime/helper/helper.js', bootstrapPath: 'runtime/helper/ptc-process.js',
    files: [
      { path: 'runtime/helper/helper.js', sha256: digest(helper), bytes: helper },
      { path: 'runtime/helper/ptc-process.js', sha256: digest(bootstrap), bytes: bootstrap },
      { path: 'runtime/package.json', sha256: digest(pkg), bytes: pkg },
    ],
  }
}

it('loads the shipped artifact set with digest verification', async () => {
  const { dir, artifacts } = await artifactDirectory()
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', dir)
  await expect(loadHelperArtifacts()).resolves.toMatchObject({
    version: artifacts.version,
    helperPath: 'runtime/helper/helper.js',
    files: artifacts.files.map(file => ({ path: file.path, sha256: file.sha256 })),
  })
})

it('refuses absent or corrupted shipped artifacts precisely', async () => {
  const missing = await mkdtemp(join(tmpdir(), 'hemi-ssh-runtime-missing-'))
  onTestFinished(() => rm(missing, { recursive: true, force: true }))
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', missing)
  await expect(loadHelperArtifacts()).rejects.toMatchObject({
    code: 'hemi-ssh/helper-artifacts-missing', details: { detail: 'manifest.json is missing or unreadable' },
  })
  const corrupted = await mkdtemp(join(tmpdir(), 'hemi-ssh-runtime-corrupt-'))
  onTestFinished(() => rm(corrupted, { recursive: true, force: true }))
  const good = await fixtures(corrupted)
  await writeFile(join(corrupted, 'runtime/helper/helper.js'), 'tampered\n')
  vi.stubEnv('DSH_HEMI_SSH_HELPER_DIR', corrupted)
  await expect(loadHelperArtifacts()).rejects.toMatchObject({
    code: 'hemi-ssh/helper-artifacts-missing',
    details: { detail: 'runtime/helper/helper.js does not match its recorded digest' },
  })
  void good
})

it('probes Node capability, login directory and cache writability in one command', async () => {
  let command = ''
  transport.execFile.mockImplementationOnce((
    _command: string, args: string[], _options: unknown, callback: (error: null, stdout: string) => void,
  ) => { command = args.at(-1) ?? ''; callback(null, 'H/remote-home\nN/usr/local/bin/node\nVv24.11.2\nC/remote-home/.cache/hemi-ssh\n') })
  await expect(probeRemoteRuntime(endpoint, signal)).resolves.toEqual({
    home: '/remote-home', node: '/usr/local/bin/node', nodeVersion: 'v24.11.2', cacheDir: '/remote-home/.cache/hemi-ssh',
  })
  expect(command).toContain('command -v node')
  expect(command).toContain('XDG_CACHE_HOME')
})

it.each([
  ['no Node at all', 'H/remote-home\nN\nV\nC/remote-home/.cache/hemi-ssh'],
  ['old Node', 'H/remote-home\nN/usr/bin/node\nVv18.20.4\nC/remote-home/.cache/hemi-ssh'],
  ['relative Node path', 'H/remote-home\nNnode\nVv24.19.0\nC/remote-home/.cache/hemi-ssh'],
])('treats %s as provisionable instead of refusing the probe', async (_name, output) => {
  transport.execFile.mockImplementationOnce((
    _command: string, _args: unknown[], _options: unknown, callback: (error: null, stdout: string) => void,
  ) => { callback(null, output) })
  await expect(probeRemoteRuntime(endpoint, signal)).resolves.toEqual({
    home: '/remote-home', cacheDir: '/remote-home/.cache/hemi-ssh',
  })
})

it('reports an unwritable app-owned cache directory', async () => {
  transport.execFile.mockImplementationOnce((
    _command: string, _args: unknown[], _options: unknown, callback: (error: Error) => void,
  ) => { callback(Object.assign(new Error('mkdir failed'), { code: 70 })) })
  await expect(probeRemoteRuntime(endpoint, signal)).rejects.toMatchObject({ code: 'hemi-ssh/remote-cache-unwritable' })
})

it('reports refused transport before probing capabilities', async () => {
  transport.execFile.mockImplementationOnce((
    _command: string, _args: unknown[], _options: unknown, callback: (error: Error) => void,
  ) => { callback(Object.assign(new Error('ssh: connect refused'), { code: 255 })) })
  await expect(probeRemoteRuntime(endpoint, signal)).rejects.toMatchObject({ code: 'hemi-ssh/ssh-unavailable' })
})

it('streams each artifact file atomically into the versioned cache directory', async () => {
  const { artifacts } = await artifactDirectory()
  const streams: { command: string; bytes: Buffer[] }[] = []
  transport.spawn.mockImplementation((_command: string, args: unknown[]) => {
    const command = String(args.at(-1))
    const bytes: Buffer[] = []
    streams.push({ command, bytes })
    return {
      stdin: { end: (chunk: Buffer) => { bytes.push(chunk) },
        on: () => undefined },
      stderr: { setEncoding: () => undefined, on: () => undefined },
      once: (event: string, listener: (code: number) => void) => { if (event === 'close') queueMicrotask(() => { listener(0) }); return this },
      kill: () => undefined,
    } as never
  })
  const versionDir = await streamHelperArtifacts(endpoint, artifacts, '/remote-home/.cache/hemi-ssh', signal)
  expect(versionDir).toBe(`/remote-home/.cache/hemi-ssh/helper-1.0.0-test-${artifacts.contentId}`)
  expect(streams).toHaveLength(artifacts.files.length)
  for (const stream of streams) {
    expect(stream.command).toContain('umask 077')
    expect(stream.command).toContain('cat >')
    expect(stream.command).toContain('mv -f')
    expect(stream.command).toContain('hemi-')
  }
  expect(streams.map(stream => stream.bytes[0]?.toString())).toEqual(artifacts.files.map(file => file.bytes.toString()))
})

it('refuses a manifest path escaping the artifact set', async () => {
  const { artifacts } = await artifactDirectory()
  const escaping = { ...artifacts, files: [{ ...artifacts.files[0]!, path: '../outside.js' }] }
  await expect(streamHelperArtifacts(endpoint, escaping, '/remote-home/.cache/hemi-ssh', signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/helper-artifacts-missing' })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('keeps the legacy refusal when nothing can supply a Node runtime', async () => {
  const { artifacts } = await artifactDirectory()
  transport.execFile.mockImplementationOnce((
    _command: string, _args: unknown[], _options: unknown, callback: (error: null, stdout: string) => void,
  ) => { callback(null, 'H/remote-home\nN\nV\nC/remote-home/.cache/hemi-ssh') })
  await expect(prepareRemoteRuntime(endpoint, artifacts, signal))
    .rejects.toMatchObject({ code: 'hemi-ssh/remote-runtime-missing' })
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('deploys the helper with the provisioned Node path when the machine has none', async () => {
  const { artifacts } = await artifactDirectory()
  transport.execFile.mockImplementationOnce((
    _command: string, _args: unknown[], _options: unknown, callback: (error: null, stdout: string) => void,
  ) => { callback(null, 'H/remote-home\nN\nV\nC/remote-home/.cache/hemi-ssh') })
  const order: string[] = []
  let streamed = false
  transport.spawn.mockImplementation((_command: string, _args: unknown[]) => ({
    stdin: { end: () => { if (!streamed) { order.push('stream'); streamed = true } }, on: () => undefined },
    stderr: { setEncoding: () => undefined, on: () => undefined },
    once: (event: string, listener: (code: number) => void) => {
      if (event === 'close') queueMicrotask(() => { listener(0) })
      return undefined
    },
    kill: () => undefined,
  }) as never)
  const provisionedNode = `/remote-home/.cache/hemi-ssh/node/${PROVISIONED_NODE_VERSION}-linux-x64`
    + `/runtime/node-${PROVISIONED_NODE_VERSION}-linux-x64/bin/node`
  const provision = vi.fn(async () => { order.push('provision'); return provisionedNode })
  const prepared = await prepareRemoteRuntime(endpoint, artifacts, signal, provision)
  expect(provision).toHaveBeenCalledWith('/remote-home/.cache/hemi-ssh')
  const bootstrap = artifacts.files.find(file => file.path === artifacts.bootstrapPath)
  expect(prepared.deployment.launch).toEqual({
    kind: 'node-script', node: provisionedNode,
    bootstrapPath: `/remote-home/.cache/hemi-ssh/helper-${artifacts.version}-${artifacts.contentId}/runtime/helper/ptc-process.js`,
    bootstrapHash: bootstrap?.sha256,
  })
  // the machine receives no helper bytes until its Node runtime exists
  expect(order).toEqual(['provision', 'stream'])
})

it('bounds a hung remote stream with a deadline instead of waiting forever', async () => {
  vi.useFakeTimers()
  try {
    let closeListener: ((code: number | null) => void) | undefined
    transport.spawn.mockImplementation(() => ({
      stdin: { end: () => undefined, on: () => undefined },
      stderr: { setEncoding: () => undefined, on: () => undefined },
      once: (event: string, listener: (code: number | null) => void) => {
        if (event === 'close') closeListener = listener
        return undefined
      },
      kill: () => { closeListener?.(null) },
    }) as never)
    const { artifacts } = await artifactDirectory()
    const streaming = streamHelperArtifacts(endpoint, artifacts, '/remote-home/.cache/hemi-ssh', signal)
    const rejected = expect(streaming).rejects.toMatchObject({
      code: 'hemi-ssh/ssh-unavailable', details: { host: 'probe-host', reason: 'SSH command timed out' },
    })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejected
  } finally {
    vi.useRealTimers()
  }
})

it.each([
  ['/', '/home/user/cache', true], ['/home/user', '/home/user/..cache/runtime', true],
  ['/home/user', '/home/other/cache', false], ['/home/user', '/home/user-other/cache', false],
] as const)('checks remote containment without treating dot-prefixed child names as parents: %s %s', (parent, child, expected) => {
  expect(containsPath(parent, child)).toBe(expected)
})

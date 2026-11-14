/** Official Node provisioning over a mocked OpenSSH transport and an injected fake download; no network is contacted. */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { SshEndpointArgs } from '../src/browse.ts'
import { provisionRemoteNode, PROVISIONED_NODE_SHA256, PROVISIONED_NODE_VERSION } from '../src/node-provision.ts'

const transport = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawn: transport.spawn, execFile: transport.execFile,
}))

// The pinned digests name external nodejs.org artifacts no test can rehash, so every provisioner
// digest comparison resolves through this scripted value while the hashing itself stays real.
const digest = vi.hoisted(() => ({ sha256: '' }))
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: (algorithm: string) => Object.assign(actual.createHash(algorithm), { digest: () => digest.sha256 }),
  }
})

const signal = new AbortController().signal
const endpoint: SshEndpointArgs = { host: 'provision-host', port: 22, username: 'user', identityFile: '' }
const remoteCacheDir = '/remote-home/.cache/hemi-ssh'

const LINUX_X64 = 'OLinux\nRx86_64\nGglibc 2.35\nU\n'
const LINUX_ARM64 = 'OLinux\nRaarch64\nGglibc 2.35\nU\n'
const DARWIN_ARM64 = 'ODarwin\nRarm64\nG\nU\n'

/** Remote commands the provisioner may run, classified by stable fragments. */
type RemoteCommandKind = 'platform' | 'reuse' | 'extract' | 'verify' | 'cleanup'

/** One scripted stdout/exit pair for a remote command kind. */
interface RemoteReply { readonly stdout?: string; readonly exitCode?: number }

function commandKind(command: string): RemoteCommandKind {
  if (command.includes('uname -s')) return 'platform'
  if (command.includes('if [ -x')) return 'reuse'
  if (command.includes('rm -rf')) return 'cleanup'
  if (command.includes('tar -xzf')) return 'extract'
  if (command.includes('--version')) return 'verify'
  throw new Error(`unexpected remote command: ${command}`)
}

/** Install one remote-command dispatcher keyed by the classified command kind, recording every command. */
function runRemote(respond: (kind: RemoteCommandKind) => RemoteReply | undefined): string[] {
  const executed: string[] = []
  transport.execFile.mockImplementation((
    _command: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout?: string) => void,
  ) => {
    const command = args.at(-1) ?? ''
    executed.push(command)
    const reply = respond(commandKind(command))
    if (reply === undefined) throw new Error(`no scripted reply for: ${command}`)
    callback(reply.exitCode === undefined ? null : Object.assign(new Error(`remote exited ${reply.exitCode}`), { code: reply.exitCode }), reply.stdout ?? '')
  })
  return executed
}

/** Script the complete successful remote side with per-kind overrides, recording every command. */
function remoteScript(platform: string, overrides: Partial<Record<RemoteCommandKind, RemoteReply>> = {}): string[] {
  const replies: Record<RemoteCommandKind, RemoteReply> = {
    platform: { stdout: platform },
    reuse: { stdout: '' },
    extract: { stdout: '' },
    verify: { stdout: `${PROVISIONED_NODE_VERSION}\n` },
    cleanup: { stdout: '' },
  }
  return runRemote(kind => ({ ...replies[kind], ...overrides[kind] }))
}

/** The streamed upload commands and bytes of one scripted accepting transport. */
interface StreamedUploads { readonly commands: string[]; readonly bytes: Buffer[] }

/** Accept every streamed upload and record its command and bytes. */
function acceptUploads(delayMs = 0): StreamedUploads {
  const commands: string[] = []
  const bytes: Buffer[] = []
  transport.spawn.mockImplementation((_command: string, args: string[]) => {
    commands.push(args.at(-1) ?? '')
    return {
      stdin: { end: (chunk: Buffer) => { bytes.push(chunk) }, on: () => undefined },
      stderr: { setEncoding: () => undefined, on: () => undefined },
      once: (event: string, listener: (code: number) => void) => {
        if (event === 'close') {
          if (delayMs === 0) queueMicrotask(() => { listener(0) })
          else setTimeout(() => { listener(0) }, delayMs)
        }
        return undefined
      },
      kill: () => { throw new Error('the upload was killed before its provisioning deadline') },
    }
  })
  return { commands, bytes }
}

/** Refuse every streamed upload with a remote exit status. */
function refuseUploads(): void {
  transport.spawn.mockImplementation((_command: string, _args: string[]) => ({
    stdin: { end: () => undefined, on: () => undefined },
    stderr: { setEncoding: () => undefined, on: () => undefined },
    once: (event: string, listener: (code: number) => void) => {
      if (event === 'close') queueMicrotask(() => { listener(1) })
      return undefined
    },
    kill: () => undefined,
  }))
}

let fetchedUrls: string[] = []

/** Serve scripted HTTP responses and record every requested URL. */
function fakeDownload(respond: () => Response): typeof fetch {
  fetchedUrls = []
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    fetchedUrls.push(url)
    if (init?.signal?.aborted) throw new Error('download aborted before it started')
    return respond()
  }
}

const mustNotFetch: typeof fetch = () => { throw new Error('provisioning must not reach nodejs.org') }

async function cacheDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hemi-ssh-provision-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function provisionedNode(os = 'linux', arch = 'x64'): string {
  const id = `${PROVISIONED_NODE_VERSION}-${os}-${arch}`
  return `${remoteCacheDir}/node/${id}/runtime/node-${PROVISIONED_NODE_VERSION}-${os}-${arch}/bin/node`
}

const platforms = [
  { name: 'linux x64', output: LINUX_X64, id: 'linux-x64' },
  { name: 'linux arm64', output: LINUX_ARM64, id: 'linux-arm64' },
  { name: 'darwin arm64', output: DARWIN_ARM64, id: 'darwin-arm64' },
] as const

beforeEach(() => {
  digest.sha256 = PROVISIONED_NODE_SHA256['linux-x64']
  fetchedUrls = []
  vi.clearAllMocks()
})

it.each(platforms)('maps a $name report onto the official distribution and its pinned digest', async ({ output, id }) => {
  digest.sha256 = PROVISIONED_NODE_SHA256[id]
  const executed = remoteScript(output)
  acceptUploads()
  const cacheDir = await cacheDirectory()
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir, download: fakeDownload(() => new Response('tarball bytes')) }))
    .resolves.toBe(provisionedNode(id === 'darwin-arm64' ? 'darwin' : 'linux', id === 'linux-x64' ? 'x64' : 'arm64'))
  expect(fetchedUrls).toEqual([`https://nodejs.org/dist/${PROVISIONED_NODE_VERSION}/node-${PROVISIONED_NODE_VERSION}-${id}.tar.gz`])
  await expect(readFile(join(cacheDir, PROVISIONED_NODE_VERSION, `node-${PROVISIONED_NODE_VERSION}-${id}.tar.gz`)))
    .resolves.toEqual(Buffer.from('tarball bytes'))
  // the probe is one round trip covering system, architecture, glibc and the musl loader
  const probe = executed[0]
  expect(probe).toContain('uname -s')
  expect(probe).toContain('uname -m')
  expect(probe).toContain('getconf GNU_LIBC_VERSION')
  expect(probe).toContain('ld-musl')
})

it.each([
  { name: ' FreeBSD on amd64', output: 'OFreeBSD\nRamd64\nG\nU\n', detail: 'uname -s=FreeBSD' },
  { name: ' Linux on an unshipped architecture', output: 'OLinux\nRppc64le\nGglibc 2.35\nU\n', detail: 'uname -m=ppc64le' },
])('refuses a$name remote as outside the bundled Node platforms', async ({ output, detail }) => {
  runRemote(() => ({ stdout: output }))
  const refused = provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir: await cacheDirectory(), download: mustNotFetch })
  await expect(refused).rejects.toMatchObject({ code: 'hemi-ssh/remote-runtime-missing', details: { host: 'provision-host' } })
  await expect(refused).rejects.toHaveProperty('details.detail', expect.stringContaining(detail))
  await expect(refused).rejects.toHaveProperty('message', expect.stringContaining('does not ship'))
  expect(transport.spawn).not.toHaveBeenCalled()
  expect(fetchedUrls).toEqual([])
})

it('warns about an old glibc and continues provisioning', async () => {
  const warnings: string[] = []
  remoteScript('OLinux\nRx86_64\nGglibc 2.26\nU\n')
  acceptUploads()
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, {
    cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')), onWarn: message => warnings.push(message),
  })).resolves.toBe(provisionedNode())
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('glibc 2.26')
  expect(warnings[0]).toContain('glibc 2.28')
})

it('warns about musl loaders and continues provisioning', async () => {
  const warnings: string[] = []
  remoteScript('OLinux\nRx86_64\nG\nUmusl\n')
  acceptUploads()
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, {
    cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')), onWarn: message => warnings.push(message),
  })).resolves.toBe(provisionedNode())
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain('musl')
  expect(warnings[0]).toContain('glibc 2.28')
})

it('reuses the digest-verified host tarball without fetching again', async () => {
  remoteScript(LINUX_X64)
  acceptUploads()
  const cacheDir = await cacheDirectory()
  await provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir, download: fakeDownload(() => new Response('tarball bytes')) })
  expect(fetchedUrls).toHaveLength(1)
  // only the atomically published tarball remains; no temporary file survived
  expect(await readdir(join(cacheDir, PROVISIONED_NODE_VERSION))).toEqual([`node-${PROVISIONED_NODE_VERSION}-linux-x64.tar.gz`])
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir, download: mustNotFetch }))
    .resolves.toBe(provisionedNode())
  expect(fetchedUrls).toHaveLength(1)
})

it('refuses downloaded bytes that miss the pinned digest and leaves no temporary file', async () => {
  digest.sha256 = '0'.repeat(64)
  remoteScript(LINUX_X64)
  const cacheDir = await cacheDirectory()
  const refused = provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir, download: fakeDownload(() => new Response('tampered')) })
  await expect(refused).rejects.toMatchObject({ code: 'hemi-ssh/runtime-provision-failed', details: { host: 'provision-host' } })
  await expect(refused).rejects.toHaveProperty('details.detail', expect.stringContaining('SHA-256'))
  await expect(refused).rejects.toHaveProperty('details.detail', expect.stringContaining('nodejs.org/dist'))
  expect(await readdir(join(cacheDir, PROVISIONED_NODE_VERSION))).toEqual([])
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('refuses a download announcing more than the byte cap before reading it', async () => {
  remoteScript(LINUX_X64)
  const refused = provisionRemoteNode(endpoint, remoteCacheDir, signal, {
    cacheDir: await cacheDirectory(),
    download: fakeDownload(() => new Response('tiny', { status: 200, headers: { 'content-length': String(256 * 1024 * 1024 + 1) } })),
  })
  await expect(refused).rejects.toMatchObject({ code: 'hemi-ssh/runtime-provision-failed' })
  await expect(refused).rejects.toHaveProperty('details.detail', expect.stringContaining('byte cap'))
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('refuses a failed nodejs.org answer', async () => {
  remoteScript(LINUX_X64)
  const refused = provisionRemoteNode(endpoint, remoteCacheDir, signal, {
    cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response(null, { status: 403 })),
  })
  await expect(refused).rejects.toMatchObject({ code: 'hemi-ssh/runtime-provision-failed' })
  await expect(refused).rejects.toHaveProperty('details.detail', expect.stringContaining('403'))
  expect(transport.spawn).not.toHaveBeenCalled()
})

it('reuses an intact remote installation without uploading or fetching', async () => {
  const executed = remoteScript(LINUX_X64, { reuse: { stdout: `${PROVISIONED_NODE_VERSION}\n` } })
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir: await cacheDirectory(), download: mustNotFetch }))
    .resolves.toBe(provisionedNode())
  expect(transport.spawn).not.toHaveBeenCalled()
  expect(fetchedUrls).toEqual([])
  expect(executed).toHaveLength(2)
})

it('uploads through the atomic transaction, extracts under the runtime directory and verifies the binary', async () => {
  const executed = remoteScript(LINUX_X64)
  const uploads = acceptUploads()
  const id = `${PROVISIONED_NODE_VERSION}-linux-x64`
  await provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')) })
  expect(uploads.commands).toHaveLength(1)
  expect(uploads.commands[0]).toContain('umask 077')
  expect(uploads.commands[0]).toContain(`mkdir -p '${remoteCacheDir}/node/${id}'`)
  expect(uploads.commands[0]).toContain('cat >')
  expect(uploads.commands[0]).toContain('mv -f')
  expect(uploads.commands[0]).toContain(`${id}/node.tar.gz.hemi-`)
  expect(uploads.bytes).toHaveLength(1)
  const extract = executed.find(command => command.includes('tar -xzf'))
  expect(extract).toContain(`tar -xzf '${remoteCacheDir}/node/${id}/node.tar.gz'`)
  expect(extract).toContain(`-C '${remoteCacheDir}/node/${id}/runtime'`)
  expect(executed.at(-1)).toBe(`'${provisionedNode()}' --version`)
})

it('completes a Node upload that takes more than 30 seconds within the provisioning deadline', async () => {
  const cacheDir = await cacheDirectory()
  remoteScript(LINUX_X64)
  const uploads = acceptUploads(35_000)
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const ready = expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, {
    cacheDir, download: fakeDownload(() => new Response('tarball bytes')), timeoutMs: 60_000,
  })).resolves.toBe(provisionedNode())
  await vi.waitFor(() => { expect(uploads.bytes).toEqual([Buffer.from('tarball bytes')]) })
  await vi.advanceTimersByTimeAsync(35_000)
  await ready
})

it('kills an upload at the provisioning deadline and waits for SSH to close before reporting failure', async () => {
  const executed = remoteScript(LINUX_X64)
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  onTestFinished(() => { timeout.mockRestore() })
  const uploading = Promise.withResolvers<undefined>()
  let close: ((code: number) => void) | undefined
  const kill = vi.fn()
  transport.spawn.mockImplementation(() => ({
    stdin: { end: () => { uploading.resolve(undefined) }, on: () => undefined },
    stderr: { setEncoding: () => undefined, on: () => undefined },
    once: (event: string, listener: (code: number) => void) => { if (event === 'close') close = listener },
    kill,
  }))
  const provision = provisionRemoteNode(endpoint, remoteCacheDir, signal, {
    cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')), timeoutMs: 60_000,
  })
  const finished = vi.fn()
  const rejected = expect(provision.finally(finished)).rejects.toMatchObject({
    code: 'hemi-ssh/runtime-provision-failed',
  })
  await uploading.promise
  deadline.abort(new DOMException('Timed out', 'TimeoutError'))
  await Promise.resolve()
  expect(kill).toHaveBeenCalledOnce()
  expect(finished).not.toHaveBeenCalled()
  close?.(0)
  await rejected
  await expect(provision).rejects.toHaveProperty('details.detail', expect.stringContaining('60000 ms budget'))
  expect(executed.map(commandKind)).toEqual(['platform', 'reuse'])
})

it.skipIf(process.platform === 'win32')('rejects a truncated upload without replacing a cached archive', async () => {
  const cacheDir = await cacheDirectory()
  const remote = join(cacheDir, "remote cache's files")
  const runtimeDir = join(remote, 'node', `${PROVISIONED_NODE_VERSION}-linux-x64`)
  const archive = join(runtimeDir, 'node.tar.gz')
  await mkdir(runtimeDir, { recursive: true })
  await writeFile(archive, 'previous archive')
  const executed = remoteScript(LINUX_X64)
  transport.spawn.mockImplementation((_command: string, args: string[]) => ({
    stdin: {
      end: (bytes: Buffer) => {
        const result = spawnSync('/bin/sh', ['-c', args.at(-1)!], { input: bytes.subarray(0, 4) })
        expect(result.error).toBeUndefined()
        queueMicrotask(() => { uploadsClosed?.(result.status) })
      },
      on: () => undefined,
    },
    stderr: { setEncoding: () => undefined, on: () => undefined },
    once: (event: string, listener: (code: number | null) => void) => { if (event === 'close') uploadsClosed = listener },
    kill: () => undefined,
  }))
  let uploadsClosed: ((code: number | null) => void) | undefined
  const provision = provisionRemoteNode(endpoint, remote, signal, { cacheDir, download: fakeDownload(() => new Response('tarball bytes')) })
  await expect(provision).rejects.toMatchObject({ code: 'hemi-ssh/runtime-provision-failed' })
  await expect(provision).rejects.toHaveProperty('details.detail', expect.stringContaining('before the complete Node archive arrived'))
  await expect(readFile(archive, 'utf8')).resolves.toBe('previous archive')
  await expect(readdir(runtimeDir)).resolves.toEqual(['node.tar.gz'])
  expect(executed.map(commandKind)).toEqual(['platform', 'reuse'])
})

it('cleans the failed version-platform directory and retries the complete upload and extraction once', async () => {
  const id = `${PROVISIONED_NODE_VERSION}-linux-x64`
  let extractions = 0
  const executed = runRemote((kind) => {
    if (kind === 'platform') return { stdout: LINUX_X64 }
    if (kind === 'reuse') return { stdout: '' }
    if (kind === 'cleanup') return { stdout: '' }
    if (kind === 'extract') return ++extractions === 1 ? { exitCode: 2 } : { stdout: '' }
    return { stdout: `${PROVISIONED_NODE_VERSION}\n` }
  })
  const uploads = acceptUploads()
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')) }))
    .resolves.toBe(provisionedNode())
  expect(extractions).toBe(2)
  expect(executed.filter(command => command.includes('rm -rf'))).toEqual([`rm -rf '${remoteCacheDir}/node/${id}'`])
  expect(uploads.commands).toHaveLength(2)
})

it('reports a second installation failure with the provisioning error code after one cleanup', async () => {
  const id = `${PROVISIONED_NODE_VERSION}-linux-x64`
  const executed = remoteScript(LINUX_X64, { extract: { exitCode: 2 } })
  const uploads = acceptUploads()
  const refused = provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')) })
  await expect(refused).rejects.toMatchObject({ code: 'hemi-ssh/runtime-provision-failed', details: { host: 'provision-host' } })
  await expect(refused).rejects.toHaveProperty('details.detail', expect.stringContaining('two installation attempts failed'))
  expect(executed.filter(command => command.includes('rm -rf'))).toEqual([`rm -rf '${remoteCacheDir}/node/${id}'`])
  expect(uploads.commands).toHaveLength(2)
})

it('retries the deployment when the installed binary reports another version', async () => {
  let verifications = 0
  runRemote((kind) => {
    if (kind === 'platform') return { stdout: LINUX_X64 }
    if (kind === 'reuse') return { stdout: '' }
    if (kind === 'cleanup') return { stdout: '' }
    if (kind === 'extract') return { stdout: '' }
    return ++verifications === 1 ? { stdout: 'v18.20.4\n' } : { stdout: `${PROVISIONED_NODE_VERSION}\n` }
  })
  const uploads = acceptUploads()
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')) }))
    .resolves.toBe(provisionedNode())
  expect(verifications).toBe(2)
  expect(uploads.commands).toHaveLength(2)
})

it('reports an unwritable remote cache without retrying the upload', async () => {
  const executed = remoteScript(LINUX_X64)
  refuseUploads()
  const refused = provisionRemoteNode(endpoint, remoteCacheDir, signal, { cacheDir: await cacheDirectory(), download: fakeDownload(() => new Response('tarball bytes')) })
  await expect(refused).rejects.toMatchObject({ code: 'hemi-ssh/remote-cache-unwritable', details: { host: 'provision-host' } })
  await expect(refused).rejects.toHaveProperty('details.detail', expect.stringContaining('exit 1'))
  expect(executed.filter(command => command.includes('rm -rf'))).toEqual([])
  expect(transport.spawn).toHaveBeenCalledTimes(1)
})

it('maps an expired provisioning deadline onto the provisioning error code', async () => {
  remoteScript(LINUX_X64)
  const hanging: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { reject(new Error('download ran past the deadline')) }, { once: true })
  })
  const deadline = provisionRemoteNode(endpoint, remoteCacheDir, signal,
    { cacheDir: await cacheDirectory(), download: hanging, timeoutMs: 25 })
  await expect(deadline).rejects.toMatchObject({ code: 'hemi-ssh/runtime-provision-failed', details: { host: 'provision-host' } })
  await expect(deadline).rejects.toHaveProperty('details.detail', expect.stringContaining('budget'))
})

it('propagates caller cancellation instead of a provisioning failure', async () => {
  const cancelled = new AbortController()
  cancelled.abort(new Error('caller cancelled provisioning'))
  await expect(provisionRemoteNode(endpoint, remoteCacheDir, cancelled.signal, {
    cacheDir: await cacheDirectory(), download: mustNotFetch,
  })).rejects.toThrow('caller cancelled provisioning')
  expect(transport.execFile).not.toHaveBeenCalled()
})

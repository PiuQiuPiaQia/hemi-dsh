/** SSH startup identity and request lifetimes over the actual administrative protocol. */
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: transport.spawn }))

class Child extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: string[] = []
  readonly terminating = Promise.withResolvers<undefined>()
  ignoreTerm = false
  closed = false
  kill(signal = 'SIGTERM'): boolean {
    this.signals.push(signal)
    this.terminating.resolve(undefined)
    if (this.ignoreTerm && signal !== 'SIGKILL') return true
    if (!this.closed) {
      this.closed = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

const config: Config = {
  host: 'test-alias', launch: { kind: 'node-script', node: '/remote/node' }, helper: '/remote/helper.js', helperHash: 'a'.repeat(64), workspace: '/remote/workspace',
  requestTimeoutMs: 1000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
}
const hello = {
  protocol: SSH_PROTOCOL_VERSION, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0',
  kind: 'node-script', executable: '/canonical/node', workspace: '/canonical/workspace',
}

function setup(options: {
  config?: Partial<Config>
  hello?: Record<string, unknown>
  holdHello?: boolean
  heartbeatFailure?: Error
} = {}) {
  const ctx = new Context()
  const child = new Child()
  const releaseHello = Promise.withResolvers<undefined>()
  const helloEntered = Promise.withResolvers<undefined>()
  const requestEntered = Promise.withResolvers<AbortSignal>()
  const released = Promise.withResolvers<null>()
  const calls: { method: string; params: unknown }[] = []
  const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method, params, signal) => {
    calls.push({ method, params })
    if (method === 'hello') {
      helloEntered.resolve(undefined)
      if (options.holdHello) await releaseHello.promise
      return { ...hello, ...options.hello }
    }
    if (method === 'held') { requestEntered.resolve(signal); return released.promise }
    if (method === 'echo') return params
    if (method === 'heartbeat' && options.heartbeatFailure !== undefined) throw options.heartbeatFailure
    if (method === 'heartbeat' || method === 'close') return null
    throw new Error(`unexpected helper request ${method}`)
  })
  transport.spawn.mockReturnValue(child)
  // oxlint-disable-next-line eslint/prefer-const -- Failed construction still runs the pre-registered fixture cleanup.
  let service: SshConnection | undefined
  onTestFinished(async () => {
    releaseHello.resolve(undefined)
    released.resolve(null)
    try { await service?.dispose() }
    finally {
      helper.close(); child.stderr.destroy(); child.kill()
      await ctx.fiber.dispose()
      vi.restoreAllMocks()
      for (const mock of Object.values(transport)) mock.mockReset()
    }
  })
  service = new SshConnection(ctx, { ...config, ...options.config })
  return { service, child, helper, calls, requestEntered: requestEntered.promise,
    helloEntered: helloEntered.promise, releaseHello: () => { releaseHello.resolve(undefined) }, release: () => { released.resolve(null) } }
}

describe.skipIf(process.platform === 'win32')('SSH connection startup', () => {
  it.each([
    { host: '-option' }, { host: 'alias; command' }, { host: '2001:db8::not-an-address' },
    { port: 0 }, { port: 65536 }, { port: 22.5 }, { username: '-override' }, { username: 'user\ncommand' },
    { username: 'root', host: 'other@host' }, { identityFile: '/key\ncommand' }, { identityFile: '' }, { launch: { kind: 'node-script', node: 'relative' } }, { helperHash: 'bad' },
    { launch: { kind: 'node-script', node: '/remote/node', bootstrapPath: '/remote/bootstrap.js' } }, { launch: { kind: 'node-script', node: '/remote/node', bootstrapHash: 'b'.repeat(64) } },
    { requestTimeoutMs: 0 }, { requestTimeoutMs: 2_147_483_648 },
    { maxFrameBytes: 64 * 1024 * 1024 + 1 }, { maxPending: 129 }, { leaseMs: 2999 },
  ] satisfies Partial<Config>[])('rejects invalid deployment configuration before SSH starts: %j', (invalid) => {
    expect(() => setup({ config: invalid })).toThrow()
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it.each(['server-alias', 'example.test', '127.0.0.1', '2001:db8::1', '[::1]'])(
    'uses explicit login fields as argv values for the helper: %s', async (host) => {
      const identityFile = "/keys/private' key"
      const test = setup({ config: { host, username: 'ops@company', port: 2200, identityFile } })
      await test.service.ready
      const argv = transport.spawn.mock.calls[0]?.[1] as string[]
      expect(argv.slice(-8, -2)).toEqual(['-l', 'ops@company', '-p', '2200', '-i', identityFile])
      expect(argv.at(-2)).toBe(host)
      expect(argv.at(-1)).not.toContain(identityFile)
      const stream = await test.service.connectStream(test.helper.reserveStream().id)
      expect(stream.readableFlowing).toBe(false)
      stream.destroy()
      await test.service.dispose()
      expect(transport.spawn).toHaveBeenCalledTimes(1)
    },
  )

  it('retains existing OpenSSH alias selection when explicit login fields are omitted', async () => {
    const test = setup({ config: { host: 'legacy-user@server-alias' } })
    await test.service.ready
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv.at(-2)).toBe('legacy-user@server-alias')
    expect(argv).not.toContain('-l')
    expect(argv).not.toContain('-p')
    expect(argv).not.toContain('-i')
    expect(test.service.signal.aborted).toBe(false)
    const lost = once(test.service.signal, 'abort')
    test.child.kill()
    await lost
    expect(test.service.signal.aborted).toBe(true)
  })

  it('rejects a non-POSIX client before starting SSH', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try { expect(() => setup()).toThrow('POSIX client') }
    finally { platform.mockRestore() }
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('publishes only verified remote coordinates and quotes the configured executable paths', async () => {
    const test = setup({ holdHello: true, config: { helper: "/remote/helper's file.js", launch: { kind: 'node-script', node: '/remote/node', bootstrapPath: '/remote/process.js', bootstrapHash: 'b'.repeat(64) } }, hello: { bootstrapHash: 'b'.repeat(64) } })
    expect(() => test.service.ptcLaunch).toThrow('not ready')
    await test.helloEntered
    test.releaseHello()
    await test.service[Service.init]()
    expect(test.service.ptcLaunch).toEqual({ kind: 'node-script', executable: '/canonical/node', bootstrapPath: '/remote/process.js' })
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('ForwardAgent=no')
    expect(argv.at(-1)).toBe("'/remote/node' '--disable-sigusr1' '/remote/helper'\\''s file.js'")
    expect(test.calls[0]?.params).toEqual({ protocol: SSH_PROTOCOL_VERSION, workspace: '/remote/workspace', leaseMs: 30_000, bootstrapPath: '/remote/process.js' })
  })

  it('permits filesystem-only deployments and refuses an unconfigured PTC bootstrap getter', async () => {
    const test = setup()
    await test.service.ready
    expect(() => test.service.ptcLaunch).toThrow('verified bootstrapPath')
    expect(await test.service.request('echo', { value: 42 }, z.object({ value: z.number() }))).toEqual({ value: 42 })
  })

  it('launches an executable directly and publishes its embedded PTC worker', async () => {
    const test = setup({
      config: { launch: { kind: 'executable' }, helper: '/remote/helper with spaces' },
      hello: { kind: 'executable', executable: '/canonical/dsh-ssh-helper' },
    })
    await test.service.ready
    expect(test.service.ptcLaunch).toEqual({ kind: 'embedded', executable: '/canonical/dsh-ssh-helper' })
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv.at(-1)).toBe("NODE_OPTIONS='--disable-sigusr1' '/remote/helper with spaces'")
    expect(test.calls[0]?.params).toEqual({ protocol: SSH_PROTOCOL_VERSION, workspace: '/remote/workspace', leaseMs: 30_000 })
  })

  it.each([
    { hello: { hash: 'c'.repeat(64) }, error: 'helper digest' },
    { hello: { bootstrapHash: 'c'.repeat(64) }, error: 'bootstrap digest' },
    { hello: { protocol: 2 }, error: 'Invalid' },
    { hello: { kind: 'executable' }, error: 'launch kind' },
  ])('refuses a mismatched helper identity before readiness: $error', async ({ hello, error }) => {
    const test = setup({ hello })
    await expect(test.service.ready).rejects.toThrow(error)
    expect(() => test.service.ptcLaunch).toThrow('not ready')
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow()
  })

  it('preserves the first SSH process error and closes later requests', async () => {
    const test = setup()
    await test.service.ready
    const failure = new Error('SSH transport refused')
    test.child.emit('error', failure)
    await Promise.resolve()
    await expect(test.service.request('echo', {}, z.unknown())).rejects.toBe(failure)
    expect(test.child.signals).toContain('SIGTERM')
  })

  it('cancels bounded administrative work and allows explicit process waits past that deadline', async () => {
    const test = setup()
    await test.service.ready
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      const pending = test.service.request('held', {}, z.null())
      const rejected = expect(pending).rejects.toThrow('cancelled')
      const remoteSignal = await test.requestEntered
      deadline.abort()
      await rejected
      await expect.poll(() => remoteSignal.aborted).toBe(true)
      expect(timeout).toHaveBeenCalledWith(1000)
      test.release()
      expect(await test.service.request('echo', 42, z.number(), undefined, true)).toBe(42)
      const caller = AbortSignal.abort(new Error('caller cancelled'))
      await expect(test.service.request('echo', {}, z.unknown(), caller)).rejects.toThrow('caller cancelled')
    } finally { timeout.mockRestore() }
  })

  it('invalidates requests when a heartbeat reports a failed helper', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const test = setup({ heartbeatFailure: new Error('helper unhealthy') })
    try {
      await test.service.ready
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(test.service.request('echo', {}, z.unknown())).rejects.toThrow('helper unhealthy')
      expect(test.child.signals).toContain('SIGTERM')
    } finally { await test.service.dispose(); vi.useRealTimers() }
  })

  it('force-kills a helper process that does not exit after termination', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const test = setup()
    try {
      await test.service.ready
      test.child.ignoreTerm = true
      const disposal = test.service.dispose()
      await test.child.terminating.promise
      await vi.advanceTimersByTimeAsync(1000)
      await disposal
      expect(test.child.signals).toContain('SIGKILL')
    } finally {
      test.child.ignoreTerm = false
      test.child.kill()
      await test.service.dispose()
      vi.useRealTimers()
    }
  })

  it('borrows an authenticated master without enabling fresh transport or terminating its owner', async () => {
    const test = setup({ config: { authenticatedControlPath: '/managed/authentication-master' } })
    await test.service.ready
    const argv = transport.spawn.mock.calls[0]?.[1] as string[]
    expect(argv).not.toContain('-M')
    expect(argv).toContain('/managed/authentication-master')
    expect(argv).toContain('ControlMaster=no')
    expect(argv).toContain('ProxyCommand=false')
    const stream = await test.service.connectStream(test.helper.reserveStream().id)
    await test.service.dispose()
    expect(stream.destroyed).toBe(true)
    expect(transport.spawn).toHaveBeenCalledTimes(1)
  })
})

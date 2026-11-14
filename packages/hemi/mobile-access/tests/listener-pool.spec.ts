/** Scripted pool members verify shared ports, rollback, and stop joining in-flight binds. */

import { describe, expect, it } from 'vitest'
import { AddressRateLimiter } from '../src/internal/net.ts'
import { PairingEngine } from '../src/internal/pairing.ts'
import type { MobileTlsMaterial } from '../src/internal/tls.ts'
import { MobileTlsListener, type MobileListenerDeps } from '../src/listener.ts'
import { MobileListenerPool, type PoolListener } from '../src/listener-pool.ts'

const TLS: MobileTlsMaterial = {
  keyPem: 'fixture-key-pem',
  certPem: 'fixture-cert-pem',
  fingerprint: 'f'.repeat(64),
  sanIps: ['192.168.1.5', '10.0.0.2'],
  createdAt: 0,
}

/** A listen failure carrying a Node error code, as the OS reports through `node:https`. */
function bindFailure(code: string): NodeJS.ErrnoException {
  const failure: NodeJS.ErrnoException = new Error(`bind failed: ${code}`)
  failure.code = code
  return failure
}

/** Scripted pool member: records every call and defers bind outcomes to the test. */
class FakeMember implements PoolListener {
  readonly startCalls: Array<{ readonly host: string; readonly port: number; readonly tls: MobileTlsMaterial }> = []
  stopCalls = 0
  /** Makes the next `stop` reject once, to exercise close-failure ownership. */
  failNextStop = false
  private bound: { readonly port: number; readonly origin: string } | undefined

  constructor(private readonly behave: (host: string, port: number) => Promise<number>) {}

  get port(): number | undefined {
    return this.bound?.port
  }

  get listenerOrigin(): string | undefined {
    return this.bound?.origin
  }

  async start(host: string, port: number, tls: MobileTlsMaterial): Promise<void> {
    this.startCalls.push({ host, port, tls })
    const assigned = await this.behave(host, port)
    this.bound = { port: assigned, origin: `https://${host}:${String(assigned)}` }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
    this.bound = undefined
    if (this.failNextStop) {
      this.failNextStop = false
      throw new Error('fixture close failure')
    }
  }
}

/** A pool over scripted members; `behave` resolves with the bound port or rejects. */
function fakePool(behave: (host: string, port: number) => Promise<number>): { pool: MobileListenerPool; members: FakeMember[] } {
  const members: FakeMember[] = []
  const pool = new MobileListenerPool(() => {
    const member = new FakeMember(behave)
    members.push(member)
    return member
  })
  return { pool, members }
}

/** Binds any address; a request for port 0 reports the fixture OS-assigned port. */
const bindAny = async (_host: string, port: number): Promise<number> => (port === 0 ? 45678 : port)

/** A manual release the test controls to hold binds in flight. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/** Capture a promise's rejection value without throwing. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error)
}

/** The single scripted member created so far, for close-failure scripting. */
function onlyMember(members: readonly FakeMember[]): FakeMember {
  const member = members[0]
  if (member === undefined) throw new Error('fixture member missing')
  return member
}

/** Enough deps to construct (never start) a real listener for the member-contract check. */
function idleListenerDeps(): MobileListenerDeps {
  return {
    authenticate: async () => undefined,
    pairing: new PairingEngine(1, 1),
    serveApi: async () => undefined,
    readResource: async () => new Response(null),
    acceptUpgrade: () => undefined,
    websocketPath: '/api/remote.mux',
    limiter: new AddressRateLimiter(1, 1),
    serverName: 'fixture-host',
    maxPairBodyBytes: 1,
    isReady: () => false,
    now: () => 0,
    log: () => undefined,
  }
}

describe('MobileListenerPool start', () => {
  it('binds each distinct address once, in order, sharing the OS-assigned port', async () => {
    const { pool, members } = fakePool(bindAny)
    await pool.start(['192.168.1.5', '192.168.1.5', '10.0.0.2', '192.168.1.5'], 0, TLS)
    expect(members.map(member => member.startCalls)).toEqual([
      [{ host: '192.168.1.5', port: 0, tls: TLS }],
      [{ host: '10.0.0.2', port: 45678, tls: TLS }],
    ])
    expect(pool.port).toBe(45678)
    expect(pool.listenerOrigin).toBe('https://192.168.1.5:45678')
    expect(pool.origins).toEqual(['https://192.168.1.5:45678', 'https://10.0.0.2:45678'])
  })

  it('reuses the explicitly requested port for every member', async () => {
    const { pool, members } = fakePool(bindAny)
    await pool.start(['192.168.1.5', '10.0.0.2'], 8443, TLS)
    expect(members.map(member => member.startCalls.map(call => call.port))).toEqual([[8443], [8443]])
    expect(pool.port).toBe(8443)
    expect(pool.listenerOrigin).toBe('https://192.168.1.5:8443')
  })

  it('skips candidates whose address disappeared and stops them without touching the pool port', async () => {
    const { pool, members } = fakePool(async (host, port) => {
      if (host === '10.0.0.9') throw bindFailure('EADDRNOTAVAIL')
      if (host === '169.254.100.5') throw bindFailure('ENETDOWN')
      return port === 0 ? 45678 : port
    })
    await pool.start(['10.0.0.9', '169.254.100.5', '192.168.1.5'], 0, TLS)
    expect(members.map(member => member.startCalls.map(call => call.host))).toEqual([['10.0.0.9'], ['169.254.100.5'], ['192.168.1.5']])
    expect(pool.port).toBe(45678)
    expect(pool.listenerOrigin).toBe('https://192.168.1.5:45678')
    expect(pool.origins).toEqual(['https://192.168.1.5:45678'])
    // Skipped members converge with one no-op stop each; the bound one keeps serving.
    expect(members.map(member => member.stopCalls)).toEqual([1, 1, 0])
  })

  it('rolls back every member when a later candidate hits a port conflict', async () => {
    const { pool, members } = fakePool(async (host, port) => {
      if (host === '10.0.0.2') throw bindFailure('EADDRINUSE')
      return port === 0 ? 45678 : port
    })
    await expect(pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(members.map(member => member.stopCalls)).toEqual([1, 1])
    expect(pool.port).toBeUndefined()
    expect(pool.listenerOrigin).toBeUndefined()
    expect(pool.origins).toEqual([])
    await expect(pool.start(['192.168.1.5'], 0, TLS)).rejects.toThrow('retired')
    await expect(pool.stop()).resolves.toBeUndefined()
  })

  it('rejects a member that reports a different port than the group', async () => {
    const { pool, members } = fakePool(async (host, port) => {
      if (host === '10.0.0.2') return 45999
      return port === 0 ? 45678 : port
    })
    await expect(pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)).rejects.toThrow('bound port 45999, expected 45678')
    expect(members.map(member => member.stopCalls)).toEqual([1, 1])
    expect(pool.port).toBeUndefined()
    expect(pool.origins).toEqual([])
  })

  it('treats a rejection that is not a coded error as fatal and rethrows it as-is', async () => {
    const plain = { fatal: true }
    const { pool, members } = fakePool((host, port) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Test cleanup for a non-Error transport rejection.
      if (host === '10.0.0.2') return Promise.reject(plain)
      return port === 0 ? Promise.resolve(45678) : Promise.resolve(port)
    })
    await expect(pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)).rejects.toBe(plain)
    expect(members.map(member => member.stopCalls)).toEqual([1, 1])
  })

  it('reports an unclosed member at rollback and retries it on the next stop', async () => {
    const held = gate()
    const { pool, members } = fakePool(async (host, port) => {
      if (host === '10.0.0.2') {
        await held.promise
        throw bindFailure('EACCES')
      }
      return port === 0 ? 45678 : port
    })
    const starting = pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)
    onlyMember(members).failNextStop = true
    held.release()
    const failure = await rejectionOf(starting)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('mobile-access: listener pool rollback left a member open')
    const cause = (failure as Error).cause as { bind: NodeJS.ErrnoException; close: unknown[] }
    expect(cause.bind.code).toBe('EACCES')
    expect(cause.close).toHaveLength(1)
    await expect(pool.stop()).resolves.toBeUndefined()
    expect(members.map(member => member.stopCalls)).toEqual([2, 1])
  })

  it('fails when no candidate binds and reports the last skipped failure as the cause', async () => {
    const gone = bindFailure('EADDRNOTAVAIL')
    const down = bindFailure('ENETDOWN')
    const { pool, members } = fakePool(async (host) => {
      throw host === '10.0.0.9' ? gone : down
    })
    const failure = await rejectionOf(pool.start(['10.0.0.9', '169.254.100.5'], 0, TLS))
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('mobile-access: no candidate address could be bound')
    expect((failure as Error).cause).toBe(down)
    expect(members.map(member => member.stopCalls)).toEqual([1, 1])
  })

  it('fails an empty candidate list the same way', async () => {
    const { pool } = fakePool(bindAny)
    const failure = await rejectionOf(pool.start([], 0, TLS))
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('mobile-access: no candidate address could be bound')
    expect((failure as Error).cause).toBeUndefined()
  })
})

describe('MobileListenerPool single-group lifecycle', () => {
  it('refuses a second start while one is in flight and after it succeeds', async () => {
    const held = gate()
    const { pool } = fakePool(async (_host, port) => {
      await held.promise
      return port === 0 ? 45678 : port
    })
    const starting = pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)
    await expect(pool.start(['192.168.1.5'], 0, TLS)).rejects.toThrow('already started')
    held.release()
    await starting
    await expect(pool.start(['192.168.1.5'], 0, TLS)).rejects.toThrow('already started')
  })

  it('accepts the real TLS listener as a member factory and starts with no facts', () => {
    const listener = new MobileTlsListener(idleListenerDeps())
    const pool = new MobileListenerPool(() => listener)
    expect(pool.port).toBeUndefined()
    expect(pool.listenerOrigin).toBeUndefined()
    expect(pool.origins).toEqual([])
  })

  it('stop retires synchronously, joins the pending binds, and closes every member', async () => {
    const held = gate()
    const { pool, members } = fakePool(async (_host, port) => {
      await held.promise
      return port === 0 ? 45678 : port
    })
    const starting = pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)
    const stopping = pool.stop()
    await expect(pool.start(['192.168.1.5'], 0, TLS)).rejects.toThrow('retired')
    // Only the first bind is in flight so far, and stop has not closed it.
    expect(members.map(member => member.stopCalls)).toEqual([0])
    held.release()
    await expect(starting).resolves.toBeUndefined()
    await expect(stopping).resolves.toBeUndefined()
    expect(members.map(member => member.stopCalls)).toEqual([1, 1])
    expect(pool.port).toBeUndefined()
    expect(pool.listenerOrigin).toBeUndefined()
    expect(pool.origins).toEqual([])
  })

  it('stop settles after an in-flight start fails, with rollback already complete', async () => {
    const held = gate()
    const { pool, members } = fakePool(async (host, port) => {
      if (host === '192.168.1.5') {
        await held.promise
        throw bindFailure('EADDRINUSE')
      }
      return port === 0 ? 45678 : port
    })
    const starting = pool.start(['192.168.1.5'], 0, TLS)
    const stopping = pool.stop()
    held.release()
    await expect(starting).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await expect(stopping).resolves.toBeUndefined()
    expect(members.map(member => member.stopCalls)).toEqual([1])
    await expect(pool.start(['192.168.1.5'], 0, TLS)).rejects.toThrow('retired')
  })

  it('stops idempotently and refuses to serve another group afterwards', async () => {
    const { pool, members } = fakePool(bindAny)
    await pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)
    await pool.stop()
    await pool.stop()
    expect(members.map(member => member.stopCalls)).toEqual([1, 1])
    expect(pool.port).toBeUndefined()
    expect(pool.origins).toEqual([])
    await expect(pool.start(['192.168.1.5'], 0, TLS)).rejects.toThrow('retired')
  })

  it('reports an unclosed member at stop and retries it on the next stop', async () => {
    const { pool, members } = fakePool(bindAny)
    await pool.start(['192.168.1.5', '10.0.0.2'], 0, TLS)
    onlyMember(members).failNextStop = true
    const failure = await rejectionOf(pool.stop())
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('mobile-access: listener pool stop left a member open')
    expect(((failure as Error).cause as unknown[])).toHaveLength(1)
    expect(pool.port).toBeUndefined()
    expect(pool.origins).toEqual([])
    await expect(pool.stop()).resolves.toBeUndefined()
    expect(members.map(member => member.stopCalls)).toEqual([2, 1])
  })

  it('stops cleanly before any start', async () => {
    const { pool } = fakePool(bindAny)
    await expect(pool.stop()).resolves.toBeUndefined()
    await expect(pool.start(['192.168.1.5'], 0, TLS)).rejects.toThrow('retired')
  })
})

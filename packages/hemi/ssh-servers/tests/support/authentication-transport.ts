/** Private-socket controller for deterministic external authentication transport scenarios. */
import { createServer, type Socket } from 'node:net'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One real askpass invocation requested by the external transport fixture. */
export interface AuthenticationPromptStep {
  readonly prompt: string
  readonly hint: string | null
  readonly expected: string | null
}

/** Exit or emit a native readiness marker after the specified prompts. */
export interface AuthenticationScenario {
  readonly prompts: readonly AuthenticationPromptStep[]
  readonly ready: boolean
  readonly stderr?: string
  readonly exitCode?: number
}

/** Observable child events; no reply bytes are sent back to the test controller. */
export type AuthenticationTransportEvent = {
  readonly kind: 'started'
  readonly pid: number
  readonly argv: string[]
  readonly authSocket: string
  readonly token: string
  readonly wrapper: string
  readonly leakedEnvironment: string[]
  readonly agentSocket?: string
} | {
  readonly kind: 'worker'
  readonly pid: number
} | {
  readonly kind: 'reply'
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly matched: boolean
  readonly stderrEmpty: boolean
} | {
  readonly kind: 'ready'
  readonly controlPath: string
}

/** One foreground fake ssh process and its event-driven observations. */
export interface AuthenticationTransportConnection {
  /** Await an event type without depending on process scheduling. */
  next<K extends AuthenticationTransportEvent['kind']>(kind: K): Promise<Extract<AuthenticationTransportEvent, { kind: K }>>
  /** Resolves when the fake transport disconnects from its controller. */
  readonly closed: Promise<void>
}

/** Owned transport executable and atomic private listener. */
export interface AuthenticationTransportFixture {
  readonly sshPath: string
  readonly root: string
  /** Await a connection and supply its scenario before any prompt is issued. */
  connection(scenario: AuthenticationScenario): Promise<AuthenticationTransportConnection>
  /** Disconnect every controller channel and remove only this fixture's verified root. */
  close(): Promise<void>
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

/**
 * Allocate an independent external transport fixture with no network or user SSH configuration.
 * @returns its private executable and quiescent listener cleanup.
 */
export async function createAuthenticationTransport(): Promise<AuthenticationTransportFixture> {
  const parent = await realpath('/tmp')
  const root = await realpath(await mkdtemp(join(parent, 'hemi-auth-fixture-')))
  const server = createServer()
  const sockets = new Map<Socket, Promise<void>>()
  const incoming: Socket[] = []
  const waiting: ((socket: Socket) => void)[] = []
  const socketPath = join(root, 'fixture')
  let disposal: Promise<void> | undefined
  server.on('connection', (socket) => {
    const closed = new Promise<void>((resolve) => { socket.once('close', () => { sockets.delete(socket); resolve() }) })
    sockets.set(socket, closed)
    socket.on('error', () => { socket.destroy() })
    const next = waiting.shift()
    if (next === undefined) { socket.pause(); incoming.push(socket) }
    else next(socket)
  })
  const close = (): Promise<void> => disposal ??= (async () => {
    const closed = server.listening ? new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    }) : Promise.resolve()
    const connections = [...sockets.entries()]
    for (const [socket] of connections) socket.destroy()
    await Promise.all([closed, ...connections.map(([, done]) => done)])
    const actual = await realpath(root)
    if (actual !== root || dirname(actual) !== parent || !basename(actual).startsWith('hemi-auth-fixture-')) {
      throw new Error('Refusing to remove a replaced authentication fixture')
    }
    await rm(actual, { recursive: true, force: true })
  })()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    const runner = fileURLToPath(new URL('./authentication-transport-runner.ts', import.meta.url))
    const sshPath = join(root, 'ssh')
    await writeFile(sshPath, `#!/bin/sh\nexec ${quote(process.execPath)} --disable-sigusr1 ${quote(runner)} ${quote(socketPath)} "$@"\n`,
      { flag: 'wx', mode: 0o700 })
    return { root, sshPath, close, connection: async (scenario) => {
      const socket = incoming.shift() ?? await new Promise<Socket>((resolve) => { waiting.push(resolve) })
      const events: AuthenticationTransportEvent[] = []
      const cursors = new Map<string, number>()
      const changed = new Set<() => void>()
      let stopped = false
      let pending = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        pending += chunk
        for (;;) {
          const newline = pending.indexOf('\n')
          if (newline === -1) break
          events.push(JSON.parse(pending.slice(0, newline)) as AuthenticationTransportEvent)
          pending = pending.slice(newline + 1)
        }
        for (const listener of [...changed]) listener()
      })
      const closed = new Promise<void>((resolve) => {
        socket.once('close', () => { stopped = true; for (const listener of [...changed]) listener(); resolve() })
      })
      socket.resume()
      socket.write(`${JSON.stringify(scenario)}\n`)
      return {
        closed,
        next: async <K extends AuthenticationTransportEvent['kind']>(kind: K): Promise<Extract<AuthenticationTransportEvent, { kind: K }>> => {
          for (;;) {
            const start = cursors.get(kind) ?? 0
            const index = events.findIndex((event, offset) => offset >= start && event.kind === kind)
            if (index !== -1) {
              cursors.set(kind, index + 1)
              return events[index] as Extract<AuthenticationTransportEvent, { kind: K }>
            }
            if (stopped) throw new Error(`Authentication fixture closed before ${kind}`)
            await new Promise<void>((resolve) => {
              const listener = (): void => { changed.delete(listener); resolve() }
              changed.add(listener)
            })
          }
        },
      }
    } }
  } catch (error: unknown) {
    await close()
    throw error
  }
}

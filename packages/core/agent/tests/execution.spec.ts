/** Execution providers remain alive until their signalled consumers release their leases. */
import { setImmediate as immediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ExecutionProviderId, ExecutionTargetId, SessionExecutionTarget } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import AgentRegistry, { ExecutionTargetUnavailableError } from '../src/index.ts'
import type { AgentExecutionLease } from '../src/index.ts'

const target = (): SessionExecutionTarget => ({
  provider: brandString<ExecutionProviderId>('test-provider'), id: brandString<ExecutionTargetId>('target-1'),
})

async function harness() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function rawLease() {
  const closed = Promise.withResolvers<undefined>()
  const close = vi.fn(() => { closed.resolve(undefined); return Promise.resolve() })
  const lease: AgentExecutionLease = {
    realm: Symbol('execution-instance'), signal: new AbortController().signal,
    bind: base => base,
    close,
  }
  return { lease, close, closed: closed.promise }
}

it('rejects a missing exact provider without using default services', async () => {
  const ctx = await harness()
  await expect(ctx.agents.acquireExecution(target(), new AbortController().signal)).rejects.toBeInstanceOf(ExecutionTargetUnavailableError)
})

it('withdraws an effect-owned registration only after signalled leases are released', async () => {
  const ctx = await harness()
  const raw = rawLease()
  const owner = ctx.inject(['agents'], (scope: Context) => {
    scope.agents.registerExecutionProvider(target().provider, { acquire: async () => raw.lease })
  })
  await owner
  const acquired = await ctx.agents.acquireExecution(target(), new AbortController().signal)
  expect(acquired.realm).toBe(raw.lease.realm)
  expect(acquired.bind(ctx)).toBe(ctx)
  const aborted = Promise.withResolvers<undefined>()
  acquired.signal.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
  const withdrawal = owner.dispose()
  await aborted.promise
  expect(raw.close).not.toHaveBeenCalled()
  await expect(ctx.agents.acquireExecution(target(), new AbortController().signal)).rejects.toBeInstanceOf(ExecutionTargetUnavailableError)
  await acquired.close()
  await acquired.close()
  await withdrawal
  expect(raw.close).toHaveBeenCalledTimes(1)
})

it('releases a late acquisition after its caller has already cancelled', async () => {
  const ctx = await harness()
  const raw = rawLease()
  const entered = Promise.withResolvers<undefined>()
  const reply = Promise.withResolvers<AgentExecutionLease>()
  ctx.agents.registerExecutionProvider(target().provider, { acquire: () => { entered.resolve(undefined); return reply.promise } })
  const abort = new AbortController()
  const pending = ctx.agents.acquireExecution(target(), abort.signal)
  await entered.promise
  abort.abort(new Error('cancelled acquisition'))
  await expect(pending).rejects.toThrow('cancelled acquisition')
  reply.resolve(raw.lease)
  await raw.closed
  expect(raw.close).toHaveBeenCalledTimes(1)
})

it('joins the same close when an abort listener releases the lease reentrantly', async () => {
  const ctx = await harness()
  const raw = rawLease()
  const drained = Promise.withResolvers<undefined>()
  raw.close.mockImplementation(() => drained.promise)
  ctx.sessions.registerExecutionProvider(target().provider, { acquire: async () => raw.lease })
  const lease = await ctx.agents.acquireExecution(target(), new AbortController().signal)
  let nested: Promise<void> | undefined
  lease.signal.addEventListener('abort', () => { nested = lease.close() }, { once: true })
  const closing = lease.close()
  try {
    await immediate()
    expect(raw.close).toHaveBeenCalledTimes(1)
    expect(nested).toBe(closing)
  } finally { drained.resolve(undefined); await closing; await nested }
})

it('does not invoke an acquisition when cancellation precedes admission', async () => {
  const ctx = await harness()
  const acquire = vi.fn(async () => rawLease().lease)
  ctx.agents.registerExecutionProvider(target().provider, { acquire })
  const abort = new AbortController()
  abort.abort(new Error('cancelled before admission'))
  expect(() => ctx.agents.acquireExecution(target(), abort.signal)).toThrow('cancelled before admission')
  expect(acquire).not.toHaveBeenCalled()
})

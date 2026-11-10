import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished } from 'vitest'
import SessionStore, { isSessionExecutionTarget, Session, SessionId, SESSION_FORMAT_VERSION } from '../src/index.ts'
import type { ExecutionProviderId, ExecutionTargetId, SessionHeader } from '../src/types.ts'

const target = () => ({ provider: brandString<ExecutionProviderId>('ssh'), id: brandString<ExecutionTargetId>('folder-1') })
const header = (id = SessionId('execution-target')): SessionHeader => ({
  id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false, cwd: '/project', executionTarget: target(),
})

it('keeps local Sessions free of an execution override and additional events', () => {
  const session = Session.create(SessionId('local'))
  expect(session.header.executionTarget).toBeUndefined()
  expect(session.seq).toBe(0)
})

it('snapshots and freezes the explicit target without deriving it from a directory or preset', () => {
  const source = header()
  const session = Session.create(source.id, undefined, source)
  expect(session.header.executionTarget).toEqual(source.executionTarget)
  expect(session.header.executionTarget).not.toBe(source.executionTarget)
  expect(Object.isFrozen(session.header.executionTarget)).toBe(true)
  expect(session.seq).toBe(0)
  const other = Session.create(SessionId('other'), undefined, { ...source, id: SessionId('other'), executionTarget: {
    ...target(), id: brandString<ExecutionTargetId>('folder-2'),
  } })
  expect(other.header.cwd).toBe(session.header.cwd)
  expect(other.header.executionTarget).not.toEqual(session.header.executionTarget)
})

it('preserves execution identity through store preparation and ordinary forks', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const parent = ctx.sessions.create(SessionId('remote-parent'), { meta: { cwd: '/project', executionTarget: target() } })
  const child = ctx.sessions.fork(parent, undefined, SessionId('remote-child'))
  expect(child.header.executionTarget).toEqual(parent.header.executionTarget)
  expect(child.header.executionTarget).not.toBe(parent.header.executionTarget)
  expect(child.header.cwd).toBe('/project')
})

it.each([null, {}, [], { provider: '', id: 'x' }, { provider: 'ssh', id: '' },
  { provider: 'ssh', id: 'x', host: 'other' }, { provider: 'ssh', id: '\n' },
  { provider: 'ssh', id: 'x'.repeat(513) }, { provider: 1, id: 'x' },
])('rejects incomplete or ambiguous execution identities at the JSON boundary: %j', (value) => {
  expect(isSessionExecutionTarget(value)).toBe(false)
})

it('accepts the complete bounded opaque reference', () => {
  expect(isSessionExecutionTarget(target())).toBe(true)
  expect(isSessionExecutionTarget({ provider: 'x'.repeat(512), id: 'x'.repeat(512) })).toBe(true)
})

/** Seed durable target metadata through real services before the public SDK resumes it. */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { SessionId, isSessionExecutionTarget } from '@deepseek-ai/dsh-session'

export const inject = ['sessions', 'sessionPersistence', 'sessionQuery']

/** @param ctx - shipped SDK profile context with real Session storage. */
export async function apply(ctx) {
  const reference = { provider: 'unavailable-sdk-fixture', id: 'saved-remote-directory' }
  if (!isSessionExecutionTarget(reference)) throw new Error('Invalid fixture execution target')
  const parentId = SessionId('sdk-target-parent')
  const childId = SessionId('sdk-target-fork')
  const cwd = process.env.DSH_SDK_TARGET_CWD
  const report = process.env.DSH_SDK_TARGET_REPORT
  const trace = process.env.DSH_SDK_TARGET_TRACE
  if (!cwd || !report || !trace) throw new Error('Execution target fixture coordinates are required')
  if (!existsSync(trace)) writeFileSync(trace, '', { flag: 'wx' })
  ctx.on('agent/created', ({ agent }) => {
    appendFileSync(trace, `${JSON.stringify({ sessionId: agent.session.id })}\n`)
  })
  if (await ctx.sessionPersistence.stat(parentId) === undefined) {
    const parent = ctx.sessions.create(parentId, { meta: { createdAt: 0, cwd, executionTarget: reference } })
    const fork = ctx.sessions.fork(parent, undefined, childId)
    for (const session of [parent, fork]) {
      const snapshot = await ctx.sessionQuery.readSession(session.id)
      const handle = await ctx.sessionPersistence.create(snapshot.session, { inheritedEventCount: snapshot.inheritedEventCount })
      try {
        await handle.append(snapshot.events)
        await handle.flush()
      } finally { await handle.close() }
    }
  }
  const headers = []
  for (const id of [parentId, childId]) {
    const saved = await ctx.sessionPersistence.stat(id)
    if (saved === undefined) throw new Error(`Fixture Session is missing: ${id}`)
    headers.push({ id: saved.header.id, isSeeded: saved.header.isSeeded, executionTarget: saved.header.executionTarget })
  }
  writeFileSync(report, `${JSON.stringify(headers)}\n`)
}

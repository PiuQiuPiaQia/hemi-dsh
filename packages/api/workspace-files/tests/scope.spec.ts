import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { isSessionExecutionTarget, SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceFiles from '../src/index.ts'

const CAPS = {
  maxBytes: 1024,
  maxFileBytes: 1024,
  maxLines: 100,
  maxEntries: 100,
}

function header(id: SessionId, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    isSeeded: false,
    origin: 'subagent',
    ...cwd === undefined ? {} : { cwd },
  }
}

describe('Workspace Files Session scope lookup', () => {
  it('retains live and cold target identity and refuses a target header without a workspace', async () => {
    const ctx = new Context()
    const target = { provider: 'fixture', id: 'remote-directory' }
    if (!isSessionExecutionTarget(target)) throw new Error('invalid target')
    const cold = SessionId('cold-target'), live = SessionId('live-target'), invalid = SessionId('missing-target-root')
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: '/Host/fallback' } as never)
    ctx.provide('sessionPersistence', { stat: async (id: SessionId) => ({
      header: { ...header(id, id === invalid ? undefined : '/remote/work'), executionTarget: target },
    }) } as never)
    await ctx.plugin(SessionStore)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(WorkspaceFiles, CAPS)
    try {
      ctx.sessions.create(live, { meta: { cwd: '/remote/live', executionTarget: target } })
      const lookup = ctx.typert.lookups.get('workspaceFileScope')!
      await expect(lookup.resolve(live)).resolves.toEqual({ sessionId: live, workspaceRoot: '/remote/live', executionTarget: target })
      await expect(lookup.resolve(cold)).resolves.toEqual({ sessionId: cold, workspaceRoot: '/remote/work', executionTarget: target })
      await expect(lookup.resolve(invalid)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    } finally { await ctx.fiber.dispose() }
  })

  it('uses live or stored headers without an Agent and leaves with its plugin', async () => {
    const liveId = SessionId('live-subagent')
    const coldId = SessionId('cold-subagent')
    const fallbackId = SessionId('cold-without-cwd')
    const missingId = SessionId('missing')
    const liveRoot = resolve('live-workspace')
    const coldRoot = resolve('cold-workspace')
    const fallbackRoot = resolve('fallback-workspace')
    const stat = vi.fn(async (id: SessionId) => {
      if (id === coldId) return { header: header(coldId, coldRoot) }
      if (id === fallbackId) return { header: header(fallbackId) }
      return undefined
    })
    const ctx = new Context()
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: fallbackRoot, executionTarget: undefined } as never)
    ctx.provide('sessionPersistence', { stat } as never)
    const sessions = await ctx.plugin(SessionStore)
    const typert = await ctx.plugin(TypertRegistry)
    const workspaceFiles = await ctx.plugin(WorkspaceFiles, CAPS)

    try {
      ctx.sessions.create(liveId, { meta: { cwd: liveRoot, origin: 'subagent' } })
      expect(ctx.get('agents')).toBeUndefined()
      const lookup = ctx.typert.lookups.get('workspaceFileScope')
      expect(lookup).toMatchObject({
        parameter: 'workspaceFileScope',
        wire: 'workspaceFileScopeId',
        // A method taking a scope reads the scope's Session as its access-control resource.
        resource: 'session',
        hostTypeSymbol: '@deepseek-ai/dsh-api-workspace-files#WorkspaceFileScope',
        wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
      })
      if (lookup === undefined) throw new Error('workspaceFileScope lookup did not register')

      await expect(lookup.resolve(liveId)).resolves.toEqual({ sessionId: liveId, workspaceRoot: liveRoot, executionTarget: undefined })
      expect(stat).not.toHaveBeenCalled()
      await expect(lookup.resolve(coldId)).resolves.toEqual({ sessionId: coldId, workspaceRoot: coldRoot, executionTarget: undefined })
      await expect(lookup.resolve(fallbackId)).resolves.toEqual({ sessionId: fallbackId, workspaceRoot: fallbackRoot })
      await expect(lookup.resolve(missingId)).resolves.toBeUndefined()
      expect(stat.mock.calls.map(([id]) => id)).toEqual([coldId, fallbackId, missingId])

      await workspaceFiles.dispose()
      expect(ctx.typert.lookups.get('workspaceFileScope')).toBeUndefined()
    } finally {
      await workspaceFiles.dispose()
      await sessions.dispose()
      await typert.dispose()
    }
  })
})

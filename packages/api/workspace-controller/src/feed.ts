/** Reconnect-safe Workspace baseline and increment producer. */

import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import type { Workspace, WorkspaceRecord } from '@deepseek-ai/dsh-workspace'
import {
  workspaceDomainState,
  workspaceRecord,
  WorkspaceId,
} from '@deepseek-ai/dsh-workspace'
import type {
  WorkspaceBaseline,
  WorkspaceFollowFrame,
  WorkspaceView,
} from './types.ts'

/** The frames the feed produces: every follow frame except `replace`, which only access filtering sends. */
type WorkspaceFeedFrame = Exclude<WorkspaceFollowFrame, { readonly type: 'replace' }>

/**
 * Project one authoritative Workspace entity into its Remote value.
 * @param workspace - authoritative registry entity.
 * @returns detached Workspace projection for Remote consumers.
 */
// Hemi fork: both baseline and durable-change projections preserve the environment of a physical directory.
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    ...workspace.executionTarget === undefined ? {} : { executionTarget: { ...workspace.executionTarget } },
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: WorkspaceId(workspaceId),
    path: record.path,
    ...record.executionTarget === undefined ? {} : { executionTarget: { ...record.executionTarget } },
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

// Hemi fork: display providers project existing execution identities without persisting presentation state.
/** Synchronous display-only naming with an invalidation subscription owned by its registration. */
export interface WorkspaceDisplayTitleProvider {
  /**
   * Read a label without mutating the Workspace or contacting its execution environment.
   * @param workspace - detached committed row, with its stored title.
   * @param views - committed registered rows before any display provider decorates them.
   * @returns a display title, or undefined to delegate to another provider or native naming.
   */
  resolve(workspace: WorkspaceView, views: readonly WorkspaceView[]): string | undefined
  /**
   * Observe facts the resolver reads; published changes refresh existing follow consumers.
   * @param listener - synchronous display invalidation callback.
   * @returns idempotent unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/** Owns Workspace domain observation and all active follow generations. */
export class WorkspaceFeed {
  private readonly followers = new Set<WorkspaceFollower>()
  private readonly displayTitles = new Map<symbol, WorkspaceDisplayTitleProvider>()
  // Hemi fork: domain notifications precede Workspace entity swaps; naming refreshes retain committed rows, not stale entities.
  private readonly views: Map<string, WorkspaceView>
  private order: readonly string[]
  private archived: readonly string[]
  private pinned: readonly string[]

  /** @param ctx - Host context containing the authoritative Workspace registry. */
  constructor(private readonly ctx: Context) {
    const baseline = ctx.workspaceRegistry.list()
    this.views = new Map(baseline.map(workspace => [String(workspace.id), workspaceView(workspace)]))
    this.order = baseline.map(workspace => String(workspace.id))
    this.archived = ctx.workspaceRegistry.archivedSessionIds.map(String)
    this.pinned = ctx.workspaceRegistry.pinnedSessionIds.map(String)
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-controller.feed')
  }

  // Hemi fork: baseline, increments and unary echoes share one generic display projection.
  /**
   * Project a Workspace with the first applicable display provider.
   * @param workspace - authoritative registry entity.
   * @returns detached row with committed naming and the entity's current filtered Session membership.
   */
  view(workspace: Workspace): WorkspaceView {
    const committed = this.views.get(workspace.id) ?? workspaceView(workspace)
    return this.withDisplayTitle({ ...committed, sessionIds: [...workspace.sessionIds] })
  }

  /**
   * Install display-only naming and refresh existing consumers on registration, invalidation and removal.
   * @param provider - synchronous resolver and its invalidation source; first registered match wins.
   * @returns idempotent disposer; the caller owns it through its plugin effect.
   */
  registerDisplayTitle(provider: WorkspaceDisplayTitleProvider): () => void {
    const id = Symbol('Workspace display title')
    const unsubscribe = provider.subscribe(() => { this.refreshDisplayTitles() })
    this.displayTitles.set(id, provider)
    this.refreshDisplayTitles()
    return () => {
      if (!this.displayTitles.delete(id)) return
      unsubscribe()
      this.refreshDisplayTitles()
    }
  }

  private withDisplayTitle(workspace: WorkspaceView): WorkspaceView {
    const views = [...this.views.values()]
    for (const provider of this.displayTitles.values()) {
      const displayTitle = provider.resolve(workspace, views)
      if (displayTitle !== undefined) return { ...workspace, displayTitle }
    }
    return workspace
  }

  private refreshDisplayTitles(): void {
    for (const workspace of this.views.values()) {
      this.publish({ type: 'upsert', workspace: this.withDisplayTitle(workspace) })
    }
  }

  /**
   * Read the complete current projection synchronously.
   * @returns all active Workspaces plus archived and pinned Session identities.
   */
  baseline(): WorkspaceBaseline {
    return {
      items: this.ctx.workspaceRegistry.list().map(workspace => this.view(workspace)),
      archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds],
      pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds],
    }
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    signal.throwIfAborted()
    const follower = new WorkspaceFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', value: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace') return
    if (change.table === '') {
      if (change.operation !== 'put') return
      const state = workspaceDomainState.parse(change.value)
      const nextOrder = state.workspaceIds.map(String)
      const orderChanged = !sameStrings(this.order, nextOrder)
      const added: WorkspaceView[] = []
      for (const id of state.workspaceIds) {
        if (this.views.has(id)) continue
        const workspace = this.ctx.workspaceRegistry.get(id)
        if (workspace === undefined) {
          throw new Error(`committed Workspace registry references missing Workspace "${id}"`)
        }
        const view = workspaceView(workspace)
        this.views.set(id, view)
        added.push(view)
      }
      if (added.length > 0 && this.displayTitles.size > 0) this.refreshDisplayTitles()
      else for (const workspace of added) this.publish({ type: 'upsert', workspace })
      this.order = nextOrder
      if (orderChanged) this.publish({ type: 'order', workspaceIds: [...state.workspaceIds] })
      const nextArchived = state.archivedSessionIds.map(String)
      if (!sameStrings(this.archived, nextArchived)) {
        this.archived = nextArchived
        this.publish({ type: 'archived', archivedSessionIds: [...state.archivedSessionIds] })
      }
      const nextPinned = state.pinnedSessionIds.map(String)
      if (!sameStrings(this.pinned, nextPinned)) {
        this.pinned = nextPinned
        this.publish({ type: 'pinned', pinnedSessionIds: [...state.pinnedSessionIds] })
      }
      return
    }
    if (change.table !== 'workspaces') return
    if (change.operation === 'deleted') {
      if (!this.views.delete(change.key)) return
      this.publish({ type: 'remove', workspaceId: WorkspaceId(change.key) })
      if (this.displayTitles.size > 0) this.refreshDisplayTitles()
      return
    }
    if (!this.views.has(change.key)) return
    const workspace = changedWorkspaceView(change.key, change.value)
    this.views.set(change.key, workspace)
    if (this.displayTitles.size > 0) this.refreshDisplayTitles()
    else this.publish({ type: 'upsert', workspace })
  }

  private publish(frame: Exclude<WorkspaceFeedFrame, { readonly type: 'baseline' }>): void {
    for (const follower of this.followers) follower.push(frame)
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

class WorkspaceFollower {
  private readonly frames = new Deque<WorkspaceFeedFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: WorkspaceFeedFrame): void {
    /* v8 ignore next -- closed followers are removed before later publication can reach them. */
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceFeedFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}

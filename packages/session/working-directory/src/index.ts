/**
 * Session working directories, durable changes, and model context.
 * @module @deepseek-ai/dsh-working-directory
 */

import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workingDirectory: WorkingDirectoryService
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Committed working-directory transition notices.
     * @persistenceAttribution
     */
    'working-directory': { kind: 'working-directory' }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Effective working directory; the immutable Session header retains the original project. */
    'working-directory/change': {
      /** Absolute directory used by subsequent directory-based operations. */
      cwd: string
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Recorded current directory for Session observations, or null when none is recorded. */
    workingDirectory: string | null
  }
}

/** Deployment default for Sessions without an original project directory. */
export interface Config {
  /** Absolute execution-world fallback directory; omitted values use the launch directory. */
  defaultDirectory?: string
}

/** One owner for each Session's effective directory and its model-visible changes. */
export class WorkingDirectoryService extends Service {
  static inject = ['fs', 'sessionProjections', 'systemPrompt']

  static Config: z<Config> = z.object({
    defaultDirectory: z.string(),
  })

  /** Absolute deployment fallback for Sessions with no recorded original directory. */
  readonly defaultDirectory: string
  private readonly pending = new WeakMap<Session, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly lifecycle = new AbortController()

  private workingDirectoryProjectionHandle!: ProjectionHandle<string | null>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workingDirectory')
    const directory = config.defaultDirectory ?? process.cwd()
    if (!isAbsolute(directory)) throw new Error('working-directory: defaultDirectory must be absolute')
    this.defaultDirectory = directory
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const directorySchema = zod.string().min(1).refine(isAbsolute).nullable()
    this.workingDirectoryProjectionHandle = await ctx.sessionProjections.register({
      key: 'workingDirectory',
      stateVersion: 1,
      stateSchema: directorySchema,
      init: header => header.cwd ?? null,
      apply: (state, event) => event.type === 'working-directory/change' ? event.data.cwd : state,
      wire: { viewSchema: directorySchema, view: state => state },
    })
    ctx.systemPrompt.context({
      name: 'working-directory:current',
      order: ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true,
      interpolate: false,
      text: context => context.agent === undefined ? '' : this.contextText(context.agent.session),
    })
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent === undefined) return next()
      await this.ensure(context.agent, context.signal)
      const assembly = await next()
      this.lifecycle.signal.throwIfAborted()
      const text = this.contextText(context.agent.session)
      const contribution = assembly.contexts.find(entry => entry.name === 'working-directory:current')
      if (contribution === undefined) assembly.contexts.unshift({ name: 'working-directory:current', text, interpolate: false })
      else {
        contribution.text = text
        contribution.interpolate = false
      }
      return assembly
    }, { prepend: true })
    ctx.effect(() => async () => {
      this.lifecycle.abort(new Error('working-directory service disposed'))
      await Promise.allSettled(this.operations)
    })
  }

  /**
   * Read the committed directory without filesystem I/O.
   * @param session - Session whose directory is requested.
   * @returns its effective absolute directory.
   * @throws when an explicit execution target has no recorded initial directory.
   */
  get(session: Session): string {
    const recorded = this.workingDirectoryProjectionHandle.stateOf(session)
    if (recorded !== null) return recorded
    if (session.header.executionTarget !== undefined) {
      throw new Error('working-directory: an explicit execution target requires an initial directory')
    }
    return this.defaultDirectory
  }

  /**
   * Validate the current directory and restore the original project when it disappeared.
   * @param agent - live or unpublished Agent owning the Session.
   * @param signal - cancellation for filesystem inspection.
   * @returns the existing directory; recovery is committed before fulfillment.
   * A notice failure is warned without reverting the committed state.
   * @throws when the original project is also unavailable.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      const current = this.get(agent.session)
      const fs = this.filesystem(agent)
      const target = await fs.resolve(current, { signal: control })
      const info = await fs.stat(target, control)
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      if (info?.type === 'directory') {
        if (this.workingDirectoryProjectionHandle.stateOf(agent.session) === null) {
          agent.session.append('working-directory/change', { cwd: current })
        }
        return current
      }
      const original = agent.session.header.cwd ?? this.defaultDirectory
      const restored = await this.directory(fs, original, original, control)
      this.commit(agent, restored, true, control)
      return restored
    })
  }

  /**
   * Change one Session's directory without changing existing processes or permissions.
   * @param agent - live or unpublished Agent owning the Session.
   * @param path - absolute path or a path relative to its current directory.
   * @param signal - cancellation before the durable change.
   * @returns the canonical absolute directory, committed before fulfillment.
   * A notice failure is warned; the next request still receives the committed directory.
   * @throws when the requested path is not an existing directory.
   */
  set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    return this.serialize(agent, signal, async (control) => {
      if (path.length === 0) throw new Error('working-directory: cd must not be empty')
      const directory = await this.directory(this.filesystem(agent), path, this.get(agent.session), control)
      this.commit(agent, directory, false, control)
      return directory
    })
  }

  private contextText(session: Session): string {
    return `Current working directory: ${JSON.stringify(this.get(session))}.`
  }

  private filesystem(agent: Agent): FileSystem {
    // Hemi fork: the shared directory projection must validate in the Agent's bound execution world.
    const fs = agent.ctx.get('fs')
    if (fs === undefined) throw new Error('working-directory: execution filesystem is unavailable')
    return fs
  }

  private async directory(fs: FileSystem, path: string, cwd: string, signal: AbortSignal): Promise<string> {
    const target = await fs.resolve(path, { cwd, signal })
    const info = await fs.stat(target, signal)
    signal.throwIfAborted()
    if (info?.type !== 'directory') {
      throw new Error(`working-directory: directory does not exist: ${JSON.stringify(path)}`)
    }
    return fs.processPath(target)
  }

  private commit(agent: Agent, directory: string, recovered: boolean, signal: AbortSignal): void {
    signal.throwIfAborted()
    agent.ctx.fiber.assertActive()
    const previous = this.get(agent.session)
    if (previous === directory) return
    agent.session.append('working-directory/change', { cwd: directory })
    const notice = createUserMessage({
      content: [{
        type: 'text',
        text: recovered
          ? `The working directory ${JSON.stringify(previous)} is unavailable. The working directory is now ${JSON.stringify(directory)}.`
          : `The working directory changed from ${JSON.stringify(previous)} to ${JSON.stringify(directory)}.`,
      }],
      source: { kind: 'working-directory' },
    })
    try {
      agent.inject(notice)
    } catch (error) {
      this.ctx.logger.warn(`working-directory: committed ${JSON.stringify(directory)}, but could not queue its notice: ${String(error)}`)
    }
  }

  private async serialize<T>(agent: Agent, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const session = agent.session
    const owner = new AbortController()
    const control = AbortSignal.any([this.lifecycle.signal, owner.signal, ...signal === undefined ? [] : [signal]])
    const unfollow = agent.ctx.effect(() => () => {
      owner.abort(new Error('working-directory: Agent scope disposed'))
      // The operation caller owns its failure; scope teardown only joins its filesystem use.
      return operation.then(() => {}, () => {})
    }, 'working-directory.operation')
    const operation = (this.pending.get(session) ?? Promise.resolve()).then(() => {
      control.throwIfAborted()
      agent.ctx.fiber.assertActive()
      return action(control)
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- Promise.finally awaits scope cleanup before settlement.
    const settled = operation.finally(async () => {
      this.operations.delete(settled)
      await unfollow()
    })
    this.operations.add(settled)
    this.pending.set(session, settled.then(() => {}, () => {}))
    return settled
  }
}

export default WorkingDirectoryService

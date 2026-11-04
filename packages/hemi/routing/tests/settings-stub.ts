/** Typed in-memory Settings and volatile-config stand-in shared by the routing tests. */

import type { Context } from '@deepseek-ai/cordis'
import type { Route } from '../src/types.ts'
import { SETTINGS_NAMESPACE } from '../src/settings.ts'

/** Backing document the volatile config reads and every settings write mutates. */
export interface RoutingConfigDocument {
  main: Route | null
  roles: Record<string, Route>
  sessionModes: Record<string, boolean>
}

/** Behavior planned for one upcoming settings write. */
export interface PlannedWrite {
  /** Hold the write until {@linkcode MutableRoutingSettings.release} runs; omitted settles immediately. */
  readonly hold?: boolean
  /** Fail the write with this error after any hold. */
  readonly failure?: Error
}

/** Settings stand-in with controllable mode-write settlement and a live config view. */
export class MutableRoutingSettings {
  private document: RoutingConfigDocument
  private planned: PlannedWrite | undefined
  private readonly held: Array<() => void> = []
  /** Settled writes per operation, for ordering and retry assertions. */
  readonly writes = { mutate: 0 }
  /** Attempted writes per operation, including held and failed ones. */
  readonly attempts = { mutate: 0 }

  constructor(initial: Partial<RoutingConfigDocument> = {}) {
    this.document = { main: initial.main ?? null, roles: initial.roles ?? {}, sessionModes: initial.sessionModes ?? {} }
  }

  /** The volatile config view the routing service constructor reads. */
  get config(): {
    main: { get(): Route | null }
    roles: { get(): Record<string, Route> }
    sessionModes: { get(): Record<string, boolean> }
  } {
    return {
      main: { get: () => this.document.main },
      roles: { get: () => this.document.roles },
      sessionModes: { get: () => this.document.sessionModes },
    }
  }

  /** Provide this stand-in as the context's `settings` service. */
  provide(ctx: Context): void {
    ctx.provide('settings', this)
  }

  /** Detached copy of the backing document. */
  snapshot(): RoutingConfigDocument {
    return { main: this.document.main, roles: { ...this.document.roles }, sessionModes: { ...this.document.sessionModes } }
  }

  /** Replace the main/roles config directly, like a settings-card edit. */
  setConfig(next: { main?: Route | null; roles?: Record<string, Route> }): void {
    this.document = { ...this.document, ...next }
  }

  /** Plan the behavior of the next settings write; one plan covers one write. */
  plan(write: PlannedWrite): void {
    this.planned = write
  }

  /** Release every held write. */
  release(): void {
    for (const resume of this.held.splice(0)) resume()
  }

  /** Apply one path-addressed mode write to the backing document. */
  async mutate(ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]): Promise<void> {
    this.attempts.mutate += 1
    await this.settle()
    if (ns !== SETTINGS_NAMESPACE) throw new Error(`settings stub: unexpected namespace "${ns}"`)
    for (const op of ops) {
      const [head, key] = op.path
      if (op.op !== 'set' || head !== 'sessionModes' || key === undefined) {
        throw new Error(`settings stub: unsupported path ${JSON.stringify(op.path)}`)
      }
      if (typeof op.value !== 'boolean') throw new Error('settings stub: sessionModes values are booleans')
      this.document = { ...this.document, sessionModes: { ...this.document.sessionModes, [key]: op.value } }
    }
    this.writes.mutate += 1
  }

  /** Enforce the planned behavior of one write, if any. */
  private async settle(): Promise<void> {
    const planned = this.planned
    this.planned = undefined
    if (planned?.hold) await new Promise<void>((resolve) => { this.held.push(resolve) })
    if (planned?.failure !== undefined) throw planned.failure
  }
}

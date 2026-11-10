/** Provider-owned execution environments shared by Agents and directory consumers. */
import type { Context } from '@deepseek-ai/cordis'
import type { ExecutionTargetId } from './types.ts'

/** A live execution instance; equal target ids do not imply equal realm instances. */
export interface AgentExecutionContext {
  /** Core-derived base without an Agent subject, suitable for activating shared preset consumers. */
  readonly base: Context
  /** Identity of the actual provider instance, not the persisted target id. */
  readonly realm: symbol
}

/** Retains one environment until its consumers stop and dispose their scopes. */
export interface AgentExecutionLease {
  /** Actual shared provider instance used to distinguish composition generations. */
  readonly realm: symbol
  /** Aborts on acquisition cancellation, provider withdrawal or connection loss. */
  readonly signal: AbortSignal
  /**
   * Bind execution services to a Core-derived base without replacing its other dependency origins.
   * @param base - the loop or directory consumer's dependency context.
   * @returns a derived context selecting this environment's registered execution services.
   */
  bind(base: Context): Context
  /** Release only after tools, processes and preset consumers have settled. */
  close(): Promise<void>
}

/** Resolves immutable targets without changing the deployment's default providers. */
export interface AgentExecutionProvider {
  /**
   * Retain one target's live execution instance.
   * @param target - immutable provider-owned target id.
   * @param signal - cancellation and registration withdrawal; the operation must settle on abort.
   * @returns an owned lease; callers close late results even after cancellation.
   */
  acquire(target: ExecutionTargetId, signal: AbortSignal): Promise<AgentExecutionLease>
}

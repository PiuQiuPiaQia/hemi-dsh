/**
 * Hemi role-based delegation routing. Renders the configured role-to-route
 * table as a system prompt section next to the subagent tool guidance, so the
 * agent knows which child route to pass for research, review, execution, and
 * design delegations. Route authority stays with the session policy (the
 * user-selected subagent models on the Plugins page); this plugin only
 * documents the intended mapping and the parent-route fallback.
 * @module @deepseek-ai/dsh-hemi-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Cordis plugin name. */
export const name = 'hemi-routing'

/** The prompt registry this row contributes to. */
export const inject = ['systemPrompt']

/** One explicit child route offered for a role. */
export interface RoleRoute {
  /** Provider id as configured in the model provider settings. */
  provider: string
  /** Model id within the provider. */
  model: string
  /** Optional reasoning effort passed through to the child. */
  reasoningEffort?: string
}

/** Plugin config: the role-to-route table. */
export interface Config {
  /**
   * Role name to explicit child route. Role names are free-form labels the
   * prompt explains (for example `research`, `review`); a route must be within
   * the session's allowed subagent models or the delegation rejects it.
   */
  roles: Record<string, RoleRoute>
}

/** Runtime schema for the routing table. */
export const Config: z<Config> = z.object({
  roles: z.dict(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    reasoningEffort: z.string(),
  })).default({}),
})

/**
 * Render the prompt section text for the configured table.
 * @param roles - the configured role-to-route mapping.
 * @returns the section text; empty when no role is configured.
 */
function renderSection(roles: Config['roles']): string {
  const entries = Object.entries(roles)
  if (entries.length === 0) return ''
  const table = entries.map(([role, route]) => {
    const routeText = route.reasoningEffort === undefined
      ? `${route.provider} / ${route.model}`
      : `${route.provider} / ${route.model} (reasoning_effort: ${route.reasoningEffort})`
    return `- ${role}: \`${routeText}\``
  })
  return [
    '## Role-based delegation routes',
    '',
    'When the user frames a delegation as one of these roles, set the subagent call\'s `provider` and `model` to the listed route (`reasoning_effort` when noted):',
    '',
    ...table,
    '',
    'Any delegation outside these roles inherits this conversation\'s route: omit `provider` and `model`. A route outside the session\'s allowed subagent models is rejected; in that case retry once without the route fields.',
  ].join('\n')
}

/**
 * Register the role-routing prompt section for the mounting preset's scope.
 * @param ctx - agent preset scope context providing the prompt registry.
 * @param config - the role-to-route table.
 */
export function apply(ctx: Context, config: Config): void {
  const text = renderSection(config.roles)
  if (text === '') return
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'hemi:role-routing',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text,
  }), 'hemi-routing.section()')
}

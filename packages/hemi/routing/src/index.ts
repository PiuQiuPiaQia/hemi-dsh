/**
 * Hemi role-based delegation routing. Ships four preset delegation roles
 * (explorer, oracle, fixer, designer), native agent presets bound
 * to the user-chosen routes, and a prompt section describing the
 * preset roles. In auto mode the plugin selects the configured main model at
 * each new turn and binds every role to its configured route (or main); in
 * fixed mode nothing is routed and children inherit the parent's actual
 * model. Routes are hard-bound at delegation: the model never picks child
 * routes itself — the user chooses them per role in the settings section.
 * @module @deepseek-ai/dsh-hemi-routing
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { HemiRoleId } from './types.ts'

/** Cordis plugin name. */
export const name = 'hemi-routing'

/** Services: tool registry, subagent seam, prompt registry, and the settings owner. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'hemiRoutingSettings']

/** Legacy delegation fields retained so existing profile patches keep loading. */
export interface Config {
  /** Legacy backend name, retained for profile compatibility. Configure the native subagent tool instead. */
  provider?: string
  /** Legacy depth preference; configure the native subagent tool for enforcement. */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
})

/** One preset delegation role with its fixed duty. */
export interface HemiRole {
  /** Native child agent preset ID. */
  id: HemiRoleId
  /** Chinese display name. */
  label: string
  /** English duty sentence embedded into the delegated prompt. */
  duty: string
  /** When the lead should choose this role and what it should expect back. */
  routing: string
}

/** The four preset Hemi roles, in display order. */
export const HEMI_ROLES: readonly HemiRole[] = [
  {
    id: 'explorer',
    label: '侦察',
    duty: 'Role: explorer — read-only reconnaissance. Gather context from code, docs, and references; report facts, options, and risks. Do not make changes.',
    routing: 'Choose for broad or uncertain fact-finding, independent searches, or when a concise map with sources is useful. Read a known location directly.',
  },
  {
    id: 'oracle',
    label: '分析',
    duty: 'Role: oracle — independent analysis. Reason over the given question or output without inheriting the requester\'s assumptions; report conclusions, trade-offs, and failure modes.',
    routing: 'Choose for independent judgment on consequential assumptions, conflicting evidence, or trade-offs. Ask for reasoning, uncertainty, and a next check.',
  },
  {
    id: 'fixer',
    label: '执行',
    duty: 'Role: fixer — carry out the instructed multi-step changes: edit files, run commands, and verify the results.',
    routing: 'Choose for substantial, well-scoped execution. Specify the boundaries and ask for the verified result and remaining gaps.',
  },
  {
    id: 'designer',
    label: '设计',
    duty: 'Role: designer — design or refine the user-facing interface: layout, hierarchy, typography, motion, and responsive behavior.',
    routing: 'Choose when visual or interaction judgment materially affects the outcome. Ask for the design or implementation and evidence of how it works.',
  },
]

const ROLE_DISPATCH = [
  'Follow the user’s explicit role assignment or request to work directly.',
  'For each coherent piece of work, delegate when the extra evidence, specialized judgment, parallelism, or context isolation '
    + 'is worth the handoff, wait, and verification. Do small, bounded work directly. '
    + 'If evidence conflicts or the current approach stalls, seek new evidence, a discriminating test, or independent analysis.',
  ...HEMI_ROLES.map(role => `- \`${role.id}\` — ${role.routing}`),
  'Give each child a standalone goal, scope, constraints, known evidence, and completion criteria. '
    + 'Verify and integrate the results needed for the final answer.',
].join('\n\n')

/**
 * Register the native role guidance, the
 * per-turn auto-routing plan, and the per-step mode capture. The plan runs on
 * the first claimed message of every turn, before the loop reads the step's
 * model; the step capture runs in the `agent/pre-step` waterfall, so a manual
 * model selection between steps redirects the next step's requests and its
 * delegations, while steps already prepared and delegations already
 * dispatched keep their routes.
 * @param ctx - agent preset scope context.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.maxDepth !== 'provider-managed') assertSubagentMaxDepth(config.maxDepth)
  const lastPreparedTurn = new WeakMap<Agent, number>()
  ctx.effect(() => ctx.on('agent/inbox/claimed', ({ agent, turn }) => {
    if (lastPreparedTurn.get(agent) === turn) return
    lastPreparedTurn.set(agent, turn)
    if (agent.session.header.origin === 'subagent') return
    if (ctx.subagents.rootOf(agent) !== agent) return
    ctx.hemiRoutingSettings.prepareTurn(agent)
  }), 'hemi-routing: turn preparation')
  ctx.effect(() => ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.session.header.origin === 'subagent') return await next()
    if (ctx.subagents.rootOf(agent) !== agent) return await next()
    ctx.hemiRoutingSettings.captureStep(agent)
    const reason = ctx.hemiRoutingSettings.blockedReason(agent)
    if (reason === null) return await next()
    ctx.logger.error(`hemi-routing: ${reason} (session ${agent.id})`)
    return { kind: 'reject' as const }
  }), 'hemi-routing: step capture and fail-closed pre-step')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'hemi:role-routing',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ agent, scope, toolSet }) => {
      const available = toolSet === undefined ? ctx.tools.get('subagent', scope) : toolSet.view(scope).get('subagent')
      if (available === undefined || ctx.subagents.resolveMaxDepth() === 0) return ''
      const roles = 'Use the native `subagent` tool with `agent_preset` set to explorer, oracle, fixer, or designer for Hemi roles. '
        + 'For independent role tasks, issue the tool calls together. '
        + 'Use `subagent` for work outside these roles.'
      if (agent === undefined || agent.session.header.origin === 'subagent') return roles
      return `${roles}\n\n${ROLE_DISPATCH}`
    },
  }), 'hemi-routing: role prompt section')
}

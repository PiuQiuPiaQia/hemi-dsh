/**
 * Hemi role-based delegation routing. Ships four preset delegation roles
 * (explorer, oracle, fixer, designer), one `hemi_delegate` tool that binds
 * each role to the user-chosen route, and a prompt section describing the
 * preset roles. In auto mode the plugin selects the configured main model at
 * each new turn and binds every role to its configured route (or main); in
 * fixed mode nothing is routed and children inherit the parent's actual
 * model. Routes are hard-bound at delegation: the model never picks child
 * routes itself — the user chooses them per role in the settings section.
 * @module @deepseek-ai/dsh-hemi-routing
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { HemiRoleId } from './types.ts'
import { HEMI_ROLE_IDS } from './types.ts'

/** Cordis plugin name. */
export const name = 'hemi-routing'

/** Services: tool registry, subagent seam, prompt registry, and the settings owner. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'hemiRoutingSettings']

/** Config: which subagent provider receives delegations, plus the depth policy. */
export interface Config {
  /** The `ctx.subagents` provider name delegations start on. */
  provider: string
  /**
   * Maximum child depth: a non-negative safe integer (`0` forbids
   * delegation), or `'provider-managed'` to send no cap. Omission reads the
   * current Host subagent depth setting at each delegation.
   */
  maxDepth?: number | 'provider-managed'
}

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn'),
  maxDepth: z.union([z.natural().max(Number.MAX_SAFE_INTEGER), z.const('provider-managed' as const)]),
})

/** One preset delegation role with its fixed duty. */
export interface HemiRole {
  /** Stable role id used by the `hemi_delegate` tool. */
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
].join('\n')

/**
 * Register the `hemi_delegate` tool, the preset-roles prompt section, the
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
  const provider = config.provider
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
  const delegate = defineDelegateTool(ctx, provider, config.maxDepth)
  ctx.effect(() => ctx.tools.register(delegate), 'hemi-routing: hemi_delegate tool')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'hemi:role-routing',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ agent, scope, toolSet }) => {
      const available = toolSet === undefined ? ctx.tools.get(delegate.name, scope) : toolSet.view(scope).get(delegate.name)
      if (available !== delegate || ctx.subagents.resolveMaxDepth(config.maxDepth) === 0) return ''
      const roles = 'Use `hemi_delegate` for Hemi roles. For independent role tasks, issue the tool calls together. '
        + 'Use `subagent` for work outside these roles.'
      if (agent === undefined || agent.session.header.origin === 'subagent') return roles
      return `${roles}\n\n${ROLE_DISPATCH}`
    },
  }), 'hemi-routing: role prompt section')
}

/**
 * Build the `hemi_delegate` tool definition.
 * @param ctx - the preset scope context.
 * @param provider - the `ctx.subagents` provider delegations start on.
 * @param maxDepth - configured depth policy; omitted reads the Host setting.
 * @returns the tool definition.
 */
function defineDelegateTool(ctx: Context, provider: string, maxDepthConfig: Config['maxDepth']) {
  return defineTool({
    name: 'hemi_delegate',
    description: 'Delegate a task to a Hemi role using its configured model. Returns the child’s result in the current turn by default.',
    parameters: {
      role: {
        type: 'string',
        enum: HEMI_ROLE_IDS,
        required: true,
        description: 'Delegation role. explorer gathers read-only context and reports; oracle analyzes independently; fixer makes the changes; designer works on the interface.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display. Use the language of the user\'s current request.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The complete standalone task for the subagent, including every constraint and the expected deliverable. The role\'s duty is prepended automatically.',
      },
      background: {
        type: 'boolean',
        description: 'Set true only when the user requests background execution. Returns an ID immediately and delivers the result later.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['activation', 'result'] },
          subagentId: { type: 'string', required: true },
          role: { type: 'string', required: true },
          answer: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'activation'
          ? `started ${value.role} subagent ${value.subagentId}`
          : `${value.role} subagent ${value.subagentId} completed.\n${value.answer || 'It left no text report.'}`,
      }],
      presentationMeta: (_args, value) => ({ kind: value.kind, subagentId: value.subagentId, role: value.role }),
    },
    presentCall: args => ({ card: 'generic', title: `${args.role} · ${args.description}` }),
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('hemi_delegate requires a calling agent (exec.agent was undefined)')
      const role = HEMI_ROLES.find(entry => entry.id === args.role)
      if (role === undefined) throw new Error(`unknown delegation role ${args.role}`)
      const routing = ctx.hemiRoutingSettings.routeForDelegation(parent, role.id)
      const maxDepth = ctx.subagents.resolveMaxDepth(maxDepthConfig)
      exec.signal.throwIfAborted()
      const prompt: ContentBlock[] = [{ type: 'text', text: `${role.duty}\n\n${args.prompt}` }]
      const started = await ctx.subagents.startActivation({
        provider,
        label: args.description,
        prompt,
        parent,
        ...routing.kind === 'bound'
          ? {
            agentOptions: {
              provider: routing.route.provider,
              model: routing.route.model,
              ...routing.route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(routing.route.reasoningEffort) },
            },
          }
          : {},
        ...maxDepth === undefined ? {} : { maxDepth },
        signal: exec.signal,
        delivery: args.background === true ? 'parent' : 'caller',
      })
      if (args.background === true) return { kind: 'activation' as const, subagentId: started.childId, role: role.id }

      // The startup signal only owns unpublished work. Stop this exact child
      // if the parent is cancelled after the activation has been accepted.
      let disposal: Promise<void> | undefined
      const onAbort = (): void => {
        disposal = started.dispose().catch((error: unknown) => {
          ctx.logger.warn(`hemi-routing: could not stop subagent ${started.childId}: ${String(error)}`)
        })
      }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) onAbort()
      try {
        const result = await started.result
        exec.signal.throwIfAborted()
        if (result.stopReason !== 'completed') {
          const diagnostic = result.diagnostic === undefined ? '' : ` (${result.diagnostic})`
          throw new HarnessError(
            `${role.id} subagent ${started.childId} ended with ${result.stopReason}${diagnostic}`,
            'HEMI_DELEGATION_FAILED',
          )
        }
        const answer = result.output.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        return { kind: 'result' as const, subagentId: started.childId, role: role.id, answer }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        await disposal
      }
    },
  })
}

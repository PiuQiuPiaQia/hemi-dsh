/**
 * Hemi role-based delegation routing. Ships four preset delegation roles
 * (research, review, execution, design), one `hemi_delegate` tool that binds
 * each role to the user-chosen child route, and a prompt section describing
 * the preset roles. Routes are hard-bound at delegation: the model never
 * picks child routes itself — the user chooses them per role in the settings
 * section, and the plugin reads them from the root-scope settings service.
 * @module @deepseek-ai/dsh-hemi-routing
 */

import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { RoleRoute, RoleRoutes } from './settings.ts'
import type {} from './settings.ts'

/** Cordis plugin name. */
export const name = 'hemi-routing'

/** Services: tool registry, subagent seam, prompt registry, and the settings owner. */
export const inject = ['tools', 'subagents', 'systemPrompt', 'hemiRoutingSettings']

/** One preset delegation role with its fixed duty. */
export interface HemiRole {
  /** Stable role id used by the `hemi_delegate` tool. */
  id: 'research' | 'review' | 'execution' | 'design'
  /** Chinese display name. */
  label: string
  /** English duty sentence embedded into the delegated prompt. */
  duty: string
}

/** The four preset Hemi roles, in display order. */
export const HEMI_ROLES: readonly HemiRole[] = [
  {
    id: 'research',
    label: '研究',
    duty: 'Role: research — gather context and summarize findings. Read code, docs, and references; report facts, options, and risks. Do not make changes.',
  },
  {
    id: 'review',
    label: '评审',
    duty: 'Role: review — critically review the given output or diff for correctness, edge cases, and quality. Report concrete findings; do not fix them yourself.',
  },
  {
    id: 'execution',
    label: '执行',
    duty: 'Role: execution — carry out the instructed multi-step changes: edit files, run commands, and verify the results.',
  },
  {
    id: 'design',
    label: '设计',
    duty: 'Role: design — design or refine the user-facing interface: layout, hierarchy, typography, motion, and responsive behavior.',
  },
]

/**
 * Register the `hemi_delegate` tool and the preset-roles prompt section.
 * Routes come from the root-scope settings service (`hemiRoutingSettings`);
 * a role without a configured route inherits the parent conversation route.
 * @param ctx - agent preset scope context.
 */
export function apply(ctx: Context): void {
  const routes = (): RoleRoutes => ctx.hemiRoutingSettings.currentRoutes()
  ctx.tools.register(defineDelegateTool(ctx, routes))
  ctx.systemPrompt.section({
    name: 'hemi:role-routing',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: 'Role-scoped subagent work goes through `hemi_delegate`: role `research` gathers context and summarizes findings, `review` critically reviews outputs or diffs, `execution` carries out the instructed changes, and `design` works on the user-facing interface. The plugin binds each role to the user-chosen model — do not pass `provider` or `model` for these delegations. For work outside these roles, use `subagent`.',
  })
}

/**
 * Build the `hemi_delegate` tool definition.
 * @param ctx - the preset scope context.
 * @param routes - live reader for the current role routes.
 * @returns the tool definition.
 */
function defineDelegateTool(ctx: Context, routes: () => RoleRoutes) {
  return defineTool({
    name: 'hemi_delegate',
    description: 'Delegate a task to a preset role subagent: research (gather and summarize), review (critique outputs), execution (carry out changes), or design (user-facing interface). Each role carries its duty and the user-chosen model; child routes are bound by the plugin and cannot be chosen here. Starts an independently managed subagent and immediately returns its id; the runtime delivers its completion notice with the final answer.',
    parameters: {
      role: {
        type: 'string',
        enum: HEMI_ROLES.map(role => role.id),
        description: 'Delegation role. research gathers context and reports; review critiques; execution makes the changes; design works on the interface.',
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
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
          role: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `started ${value.role} subagent ${value.subagentId}` }],
      presentationMeta: (_args, value) => ({ kind: value.kind, subagentId: value.subagentId, role: value.role }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('hemi_delegate requires a calling agent (exec.agent was undefined)')
      const role = HEMI_ROLES.find(entry => entry.id === args.role)
      if (role === undefined) throw new Error(`unknown delegation role ${String(args.role)}`)
      const route: RoleRoute | undefined = routes()[role.id]
      exec.signal.throwIfAborted()
      const prompt: ContentBlock[] = [{ type: 'text', text: `${role.duty}\n\n${args.prompt}` }]
      const started = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: args.description,
        prompt,
        parent,
        ...(route !== undefined
          ? {
            agentOptions: {
              provider: route.provider,
              model: route.model,
              ...(route.reasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
            },
          }
          : {}),
        signal: exec.signal,
        delivery: 'parent',
      })
      return { kind: 'activation' as const, subagentId: started.childId, role: role.id }
    },
  })
}

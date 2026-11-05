/** Use the real native preset registry in role-routing tests. */
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { HEMI_ROLE_IDS } from '../src/types.ts'

export async function mountNativeRoles(ctx: Context): Promise<void> {
  if (ctx.get('loader') === undefined) await ctx.plugin(Loader)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  for (const id of ['standard', ...HEMI_ROLE_IDS]) {
    const dispose = await ctx.agentPresets.register({ id, plugins: [] })
    ctx.effect(() => dispose, `test role preset ${id}`)
  }
}

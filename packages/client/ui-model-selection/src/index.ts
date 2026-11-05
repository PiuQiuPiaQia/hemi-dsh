/** Hemi fork: publish composer ownership options while retaining native model directories and /model. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { type Config, MODEL_SELECTION_CONFIG_GLOBAL } from './config.ts'

export { Config } from './config.ts'

/**
 * Publish native picker composition options before Client plugins activate.
 * @param ctx - Host collecting page initialization data.
 * @param config - Loader-validated composition options.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: MODEL_SELECTION_CONFIG_GLOBAL, value: config })
  })
}

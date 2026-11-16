/** Validated VVCode request budgets and non-secret subscription settings. */
import z from '@deepseek-ai/schemastery'

/** Deployment-specific VVCode origin and bounded management operations. */
export interface VvcodeConfig {
  /** HTTPS origin serving the VVCode account and model APIs. */
  origin: string
  /** Deadline for each management or model-catalog request in milliseconds. */
  timeoutMs: number
  /** Maximum browser authorization duration in milliseconds. */
  loginTimeoutMs: number
  /** Maximum decoded response bytes accepted from VVCode. */
  maxResponseBytes: number
  /** Maximum number of advertised model IDs accepted from the gateway. */
  maxModels: number
  /** Maximum pages inspected when recovering a uniquely named model token. */
  tokenPageLimit: number
}

/** Request controls remain editable through the owning plugin's configuration. */
export const vvcodeConfig = z.object({
  origin: z.string().default('https://cf.vvcode.top'),
  timeoutMs: z.number().step(1).min(1).default(30_000),
  loginTimeoutMs: z.number().step(1).min(1).default(5 * 60_000),
  maxResponseBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
  maxModels: z.number().step(1).min(1).default(500),
  tokenPageLimit: z.number().step(1).min(1).default(20),
})

/** The current group and advertised protocol metadata contain no secret literals. */
export const vvcodeConnectionConfig = z.union([z.const(null), z.object({
  origin: z.string().required(),
  group: z.string().required(),
  userId: z.string().required(),
  tokenId: z.number().step(1).min(1).required(),
  apiKeyRef: z.string().required(),
  models: z.array(z.object({
    id: z.string().required(),
    api: z.union(['openai-completions', 'openai-responses', 'anthropic-messages']).required(),
  })),
})]).default(null).volatile()

/**
 * One saved group binding: the migrated legacy group keeps its provider route, and every other
 * group owns an independent `vvcode-group-…` route, key reference, catalog and selection.
 * The binding contains no secret literal; the key lives behind `apiKeyRef`.
 */
export const vvcodeConnectionsConfig = z.dict(z.object({
  origin: z.string().required(),
  group: z.string().required(),
  userId: z.string().required(),
  tokenId: z.number().step(1).min(1).required(),
  apiKeyRef: z.string().required(),
  provider: z.string().required(),
  models: z.array(z.object({
    id: z.string().required(),
    api: z.union(['openai-completions', 'openai-responses', 'anthropic-messages']).required(),
  })).required(),
  selected: z.array(z.string()).required(),
  ratio: z.union([z.number(), z.const('auto')]),
  desc: z.string(),
  revoked: z.boolean(),
})).default({}).volatile()

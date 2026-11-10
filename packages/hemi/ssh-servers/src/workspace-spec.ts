/** Immutable SSH execution targets and explicit installed helper deployments. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExecutionTargetId } from '@deepseek-ai/dsh-session/types'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { serverSchema } from './spec.ts'
import type { SshServerId } from './types.ts'

const remotePath = z.string().startsWith('/').refine(value => !value.includes('\0'), 'path contains NUL')
const hash = z.string().regex(/^[0-9a-f]{64}$/)

/** Saved deployment validation runs before any SSH process is admitted. */
export const runtimeDeploymentSchema = z.object({
  helper: remotePath,
  helperHash: hash,
  launch: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('executable') }).strict(),
    z.object({ kind: z.literal('node-script'), node: remotePath, bootstrapPath: remotePath, bootstrapHash: hash }).strict(),
  ]),
}).strict()

const runtime = z.object({
  serverId: z.uuid().transform(value => brandString<SshServerId>(value)),
  revision: z.uuid(),
  deployment: runtimeDeploymentSchema,
}).strict()

const target = z.object({
  id: z.uuid().transform(value => brandString<ExecutionTargetId>(value)),
  server: serverSchema,
  runtimeRevision: z.uuid(),
  deployment: runtimeDeploymentSchema,
  path: remotePath,
}).strict()

/** Snapshot binding one Session target to its server revision, deployment and physical directory. */
export type SshExecutionTargetRecord = z.infer<typeof target>

/** Targets remain after connection edits or removal so saved Sessions never silently change hosts. */
export const sshWorkspacesSpec = defineDomain({
  name: 'hemi_ssh_workspaces', version: 1, tables: {},
  global: {
    schema: z.object({ runtimes: z.array(runtime), targets: z.array(target) }).strict()
      .refine(state => new Set(state.runtimes.map(row => row.serverId)).size === state.runtimes.length)
      .refine(state => new Set(state.targets.map(row => row.id)).size === state.targets.length),
    initial: { runtimes: [], targets: [] },
  },
})

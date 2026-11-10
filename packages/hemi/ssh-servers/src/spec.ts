/** Validated durable SSH server directory, stored separately from local Workspaces. */
import { isIP } from 'node:net'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { SshServerId } from './types.ts'

const noControls = /^[^\p{Cc}]*$/u

/** Input validation shared by writes and persisted records; secrets are not accepted fields. */
export const serverInputSchema = z.object({
  name: z.string().trim().min(1).max(120).regex(noControls),
  host: z.string().trim().min(1).max(253).refine(value => isIP(value) !== 0
    || /^\[[^\]]+\]$/.test(value) && isIP(value.slice(1, -1)) === 6
    || /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().max(128).regex(/^[a-zA-Z0-9_.@-]*$/).refine(value => !value.startsWith('-')),
  identityFile: z.string().trim().max(4096).regex(noControls).refine(value => value === ''
    || value.startsWith('/') || value.startsWith('~/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')),
  directory: z.string().trim().max(4096).regex(noControls).refine(value => value === '' || value.startsWith('/')).optional(),
}).strict()

/** Validated durable server reference, including its immutable identity and revision. */
export const serverSchema = serverInputSchema.extend({
  id: z.uuid().transform(value => brandString<SshServerId>(value)),
  revision: z.uuid(),
}).strict()

/** One atomic document keeps server order and records consistent after failed writes. */
export const sshServersSpec = defineDomain({
  name: 'hemi_ssh_servers',
  version: 1,
  tables: {},
  global: {
    schema: z.object({ servers: z.array(serverSchema) }).strict().refine(state =>
      new Set(state.servers.map(server => server.id)).size === state.servers.length),
    initial: { servers: [] },
  },
})

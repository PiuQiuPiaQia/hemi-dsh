/** Remote argv wrapper that selects and applies the sandbox on the SSH host. */
import { Service } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError, SandboxUnsupportedPolicyError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-ssh'
import { z } from 'zod'

const factsSchema = z.object({ argv: z.array(z.string()).min(1), enforcement: z.enum(['full', 'partial']), denialSignatures: z.array(z.string()), runnerFailureRules: z.array(z.object({ allowedExitCodes: z.array(z.number().int()).optional(), fatalSignatures: z.array(z.string()), informationalLines: z.array(z.string()).optional() }).strict()) }).strict()

/** Resolve each confinement request on the same host as its filesystem and subprocess providers. */
export class SshSandboxProvider extends SandboxProvider {
  static inject = ['ssh']

  // Hemi fork: expose only verified target-local coordinates to agentless policy consumers.
  override get executionTarget() { return this.ctx.ssh.executionTarget }
  override get workspaceRoot() { return this.executionTarget === undefined ? undefined : this.ctx.ssh.workspaceRoot }

  async [Service.init](): Promise<void> { await this.ctx.ssh.ready }

  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    const target = this.executionTarget
    if (target !== undefined && (policy.additionalWritableRoots?.length ?? 0) > 0) {
      throw new SandboxUnsupportedPolicyError('Deployment extra writable roots are not authorized for an explicit execution target; omit those roots')
    }
    const admitted: SandboxPolicy = { mode: policy.mode, workspaceRoot: policy.workspaceRoot,
      ...policy.sessionId === undefined ? {} : { sessionId: policy.sessionId },
      ...target !== undefined || policy.additionalWritableRoots === undefined ? {}
        : { additionalWritableRoots: [...policy.additionalWritableRoots] },
    }
    try {
      const confined = await this.ctx.ssh.request('sandbox', { argv, policy: admitted }, factsSchema, signal)
      signal?.throwIfAborted()
      return {
        ...confined,
        runnerFailureRules: confined.runnerFailureRules.map(rule => ({
          fatalSignatures: rule.fatalSignatures,
          ...(rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: rule.allowedExitCodes }),
          ...(rule.informationalLines === undefined ? {} : { informationalLines: rule.informationalLines }),
        })),
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new SandboxUnavailableError(admitted.mode, error instanceof Error ? error.message : String(error))
    }
  }
}

export default SshSandboxProvider

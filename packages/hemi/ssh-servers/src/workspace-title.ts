/** Display-only SSH Workspace names from immutable execution targets and matching saved connections. */
import { posix } from 'node:path'
import type { SessionExecutionTarget } from '@deepseek-ai/dsh-session/types'
import { sameSshEndpoint } from './remembered-passwords.ts'
import type { SshExecutionTargetRecord } from './workspace-spec.ts'
import type { SshServer } from './types.ts'

interface TitleWorkspace {
  readonly title: string
  readonly path: string
  readonly executionTarget?: SessionExecutionTarget | undefined
}

/**
 * Name a known SSH target without changing a stored Workspace title or reading its directory.
 * @param workspace - stored name and explicit execution identity, never inferred from its path.
 * @param provider - this plugin's execution provider identity.
 * @param targets - immutable target snapshots, including those whose connection was removed.
 * @param servers - current saved connections; names follow only an unchanged exact endpoint.
 * @param workspaces - registered Workspaces whose final labels may need endpoint disambiguation.
 * @returns the display label, or undefined for another execution environment.
 */
export function sshWorkspaceDisplayTitle(
  workspace: TitleWorkspace,
  provider: SessionExecutionTarget['provider'],
  targets: readonly SshExecutionTargetRecord[],
  servers: readonly SshServer[],
  workspaces: readonly TitleWorkspace[] = [],
): string | undefined {
  const reference = workspace.executionTarget
  if (reference?.provider !== provider) return undefined
  const target = targets.find(row => row.id === reference.id)
  if (target === undefined) return `${workspace.title}（${reference.provider}:${reference.id}）`
  const nameOf = (snapshot: SshServer): string => servers
    .find(server => server.id === snapshot.id && sameSshEndpoint(server, snapshot))?.name ?? snapshot.name
  const endpointOf = (snapshot: SshServer): string => {
    const host = snapshot.host.includes(':') ? `[${snapshot.host}]` : snapshot.host
    return `${snapshot.username === '' ? '' : `${snapshot.username}@`}${host}:${snapshot.port}`
  }
  const titleOf = (storedTitle: string, snapshot: SshExecutionTargetRecord): string => {
    const names = [nameOf(snapshot.server), snapshot.server.name]
    const suffixes = names.flatMap(value => [`（${value}）`, `（${value} · ${endpointOf(snapshot.server)}）`])
    let title = storedTitle
    // Only suffixes naming this target are decoration; unrelated user-authored parentheses stay intact.
    for (;;) {
      const suffix = suffixes.find(value => title.endsWith(value))
      if (suffix === undefined) break
      title = title.slice(0, -suffix.length)
    }
    return title || posix.basename(snapshot.path) || snapshot.path
  }
  const name = nameOf(target.server)
  const endpoint = endpointOf(target.server)
  const title = titleOf(workspace.title, target)
  const ambiguous = workspaces.some((other) => {
    if (other.path !== workspace.path || other.executionTarget?.provider !== provider
      || other.executionTarget.id === reference.id) return false
    const snapshot = targets.find(row => row.id === other.executionTarget?.id)
    return snapshot !== undefined && nameOf(snapshot.server) === name && titleOf(other.title, snapshot) === title
      && endpointOf(snapshot.server) !== endpoint
  })
  const displayName = ambiguous ? `${name} · ${endpoint}` : name
  return `${title}（${displayName}）`
}

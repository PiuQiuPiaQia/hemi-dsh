import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ExecutionProviderId, ExecutionTargetId } from '@deepseek-ai/dsh-session/types'
import type { SshServer, SshServerId } from '../src/types.ts'
import type { SshExecutionTargetRecord } from '../src/workspace-spec.ts'
import { sshWorkspaceDisplayTitle } from '../src/workspace-title.ts'

const provider = brandString<ExecutionProviderId>('hemi-ssh')
const server: SshServer = {
  id: brandString<SshServerId>('connection-one'), revision: 'revision-one', name: 'aimuxr',
  host: 'first.example', port: 22, username: 'modyzer', identityFile: '',
}
const target: SshExecutionTargetRecord = {
  id: brandString<ExecutionTargetId>('target-one'), server, runtimeRevision: 'runtime-one', path: '/home/modyzer',
  deployment: { helper: '/opt/helper', helperHash: 'a'.repeat(64), launch: { kind: 'executable' } },
}
const workspace = { title: 'modyzer', path: '/home/modyzer', executionTarget: { provider, id: target.id } }

const label = (title = workspace.title, servers: readonly SshServer[] = [server]) =>
  sshWorkspaceDisplayTitle({ ...workspace, title }, provider, [target], servers)

describe('SSH Workspace display titles', () => {
  it('names existing directory Workspaces from their immutable target, without changing their title', () => {
    expect(label()).toBe('modyzer（aimuxr）')
    expect(workspace.title).toBe('modyzer')
    expect(target.server.name).toBe('aimuxr')
  })

  it('does not infer SSH identity from matching local or other-provider paths', () => {
    expect(sshWorkspaceDisplayTitle({ title: 'Custom local', path: workspace.path }, provider, [target], [server])).toBeUndefined()
    expect(sshWorkspaceDisplayTitle({ ...workspace, executionTarget: {
      provider: brandString<ExecutionProviderId>('other-provider'), id: target.id,
    } }, provider, [target], [server])).toBeUndefined()
  })

  it('preserves custom titles and adds the connection name only once', () => {
    expect(label('Deployment')).toBe('Deployment（aimuxr）')
    expect(label('Deployment（aimuxr）')).toBe('Deployment（aimuxr）')
    expect(label('Deployment（aimuxr）（aimuxr）')).toBe('Deployment（aimuxr）')
    expect(label('Deployment（production）')).toBe('Deployment（production）（aimuxr）')
    expect(label('（aimuxr）')).toBe('modyzer（aimuxr）')
  })

  it('follows a pure connection rename and replaces only suffixes naming that target', () => {
    const renamed = [{ ...server, name: 'Production', revision: 'revision-two', directory: '/another/start' }]
    expect(label('modyzer', renamed)).toBe('modyzer（Production）')
    expect(label('Deployment（aimuxr）', renamed)).toBe('Deployment（Production）')
    expect(label('Deployment（Production）（aimuxr）', renamed)).toBe('Deployment（Production）')
    expect(server.name).toBe('aimuxr')
  })

  it.each([
    { host: 'replacement.example' }, { port: 2222 }, { username: 'another-user' }, { identityFile: '/keys/replacement' },
  ])('keeps the snapshot name after an endpoint field changes: %j', (replacement) => {
    expect(label('modyzer', [{ ...server, ...replacement, name: 'Replacement' }])).toBe('modyzer（aimuxr）')
  })

  it('keeps the snapshot name after deletion or replacement with another saved identity', () => {
    expect(label('modyzer', [])).toBe('modyzer（aimuxr）')
    expect(label('modyzer', [{ ...server, id: brandString<SshServerId>('connection-two'), name: 'Another connection' }]))
      .toBe('modyzer（aimuxr）')
  })

  it('distinguishes directories on one connection and matching directories on different connections', () => {
    const other: SshExecutionTargetRecord = { ...target, id: brandString<ExecutionTargetId>('target-two'),
      path: '/srv/repository' }
    const secondServer = { ...server, id: brandString<SshServerId>('connection-two'), host: 'second.example', name: 'staging' }
    const second = { ...target, id: brandString<ExecutionTargetId>('target-three'), server: secondServer }
    const targets = [target, other, second]
    expect(sshWorkspaceDisplayTitle({ ...workspace, title: 'repository', path: other.path,
      executionTarget: { provider, id: other.id } }, provider, targets, [server, secondServer])).toBe('repository（aimuxr）')
    expect(sshWorkspaceDisplayTitle({ ...workspace, executionTarget: { provider, id: second.id } },
      provider, targets, [server, secondServer])).toBe('modyzer（staging）')
  })

  it('qualifies duplicate connection names only when the same directory belongs to different host, login or port values', () => {
    const otherServer = { ...server, id: brandString<SshServerId>('connection-two'), host: 'second.example' }
    const other = { ...target, id: brandString<ExecutionTargetId>('target-two'), server: otherServer }
    const otherWorkspace = { ...workspace, executionTarget: { provider, id: other.id } }
    const workspaces = [workspace, otherWorkspace]
    expect(sshWorkspaceDisplayTitle(workspace, provider, [target, other], [server, otherServer], workspaces))
      .toBe('modyzer（aimuxr · modyzer@first.example:22）')
    expect(sshWorkspaceDisplayTitle(otherWorkspace,
      provider, [target, other], [server, otherServer], workspaces)).toBe('modyzer（aimuxr · modyzer@second.example:22）')
    expect(sshWorkspaceDisplayTitle(workspace, provider, [target, other], [server, otherServer], [workspace]))
      .toBe('modyzer（aimuxr）')
    expect(sshWorkspaceDisplayTitle(workspace, provider, [target, other], [server, otherServer],
      [workspace, { ...otherWorkspace, title: 'Custom' }])).toBe('modyzer（aimuxr）')
    expect(sshWorkspaceDisplayTitle(workspace, provider, [target, other], [server, otherServer],
      [workspace, { ...otherWorkspace, executionTarget: undefined }])).toBe('modyzer（aimuxr）')
    expect(sshWorkspaceDisplayTitle(workspace, provider, [target, { ...other, path: '/different' }], [server, otherServer],
      [workspace, { ...otherWorkspace, path: '/different' }])).toBe('modyzer（aimuxr）')
    const identityOnly = { ...otherServer, host: server.host, identityFile: '/another/key' }
    expect(sshWorkspaceDisplayTitle(workspace, provider, [target, { ...other, server: identityOnly }], [server, identityOnly], workspaces))
      .toBe('modyzer（aimuxr）')
    expect(sshWorkspaceDisplayTitle({ ...workspace, title: 'Custom（aimuxr · modyzer@first.example:22）' },
      provider, [target, other], [server, otherServer], workspaces.map(row => ({ ...row, title: 'Custom' }))))
      .toBe('Custom（aimuxr · modyzer@first.example:22）')
  })

  it('retains the explicit provider and target identity when the immutable snapshot is unavailable', () => {
    expect(sshWorkspaceDisplayTitle(workspace, provider, [], [server])).toBe('modyzer（hemi-ssh:target-one）')
  })

  it('names a filesystem root without producing an empty folder name', () => {
    expect(sshWorkspaceDisplayTitle({ title: '', path: '/', executionTarget: workspace.executionTarget }, provider,
      [{ ...target, path: '/' }], [server])).toBe('/（aimuxr）')
  })
})

/** Automatic remote helper preparation: capability probe, artifact streaming and deployment resolution. */
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteCommandError, quoteRemote, sshExec, sshStream, type SshEndpointArgs } from './browse.ts'
import type { SshHelperArtifacts } from './runtime-artifacts.ts'
import type { SshRuntimeDeployment } from './workspace-types.ts'

/** Remote Node major the probe reuses when present; machines below it receive the provisioned official runtime. */
const REQUIRED_NODE_MAJOR = 24
/** Cache-directory probe refuses with this exit status when the app-owned directory cannot exist. */
const CACHE_REFUSAL_EXIT = 70
/** Fixed fallback locations probed when the remote PATH has no Node executable. */
const NODE_FALLBACK_PATHS = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node', '/opt/local/bin/node'] as const

function helperDirectoryName(artifacts: SshHelperArtifacts): string {
  return `helper-${artifacts.version}-${artifacts.contentId}`
}

/**
 * Identify a deployment created by Hemi's content-addressed cache, including protocol 3 deployments.
 * @param deployment - saved execution target's helper and bootstrap.
 * @returns the artifact directory name for a managed pair, if present.
 */
export function managedHelperDirectory(deployment: SshRuntimeDeployment): string | undefined {
  const match = /\/(helper-[A-Za-z0-9][A-Za-z0-9._+-]*-[0-9a-f]{16})\/runtime\/helper\/helper\.js$/u.exec(deployment.helper)
  if (match === null || deployment.launch.kind !== 'node-script' ||
    deployment.launch.bootstrapPath !== posix.join(posix.dirname(deployment.helper), 'ptc-process.js')) return undefined
  return match[1]
}

/**
 * Check whether a managed deployment already points at the helper shipped by this Host.
 * @param directory - the saved managed artifact directory name.
 * @param artifacts - the bundled, digest-verified artifact set.
 * @returns whether the current artifact identity is already deployed for the target.
 */
export function isCurrentManagedHelper(directory: string, artifacts: SshHelperArtifacts): boolean {
  return directory === helperDirectoryName(artifacts)
}

/** One probe of the remote machine's usable capabilities for helper execution. */
export interface SshRemoteProbe {
  /** Absolute remote login directory reported by the remote shell. */
  readonly home: string
  /** Absolute remote Node executable able to run the helper; undefined when provisioning must supply one. */
  readonly node?: string
  /** Remote Node version string, for example `v24.1.0`; present only together with {@link node}. */
  readonly nodeVersion?: string
  /** App-owned remote cache directory that exists and accepted a directory write. */
  readonly cacheDir: string
}

/** Result of a complete automatic preparation run. */
export interface SshPreparedRuntime {
  readonly deployment: SshRuntimeDeployment
  readonly probe: SshRemoteProbe
}

function unavailable(host: string, detail: string, message: string): RemoteError {
  return new RemoteError('hemi-ssh/remote-runtime-missing', message, { host, detail })
}

/**
 * Parse single-character-tagged probe lines into their fields.
 * @param output - stdout of a probe command that printed one `X<value>` line per tag.
 * @returns the first value recorded for each tag.
 */
export function taggedFields(output: Buffer): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const line of output.toString('utf8').split('\n')) {
    const tag = line[0]
    if (tag === undefined || fields[tag] !== undefined) continue
    fields[tag] = line.slice(1)
  }
  return fields
}

/**
 * Probe the remote login directory, its reusable Node capability and the app-owned cache directory.
 * A missing, relative or too-old Node is reported as no reusable executable, not a failure: provisioning
 * supplies the pinned official runtime instead.
 * @param endpoint - saved connection fields.
 * @param signal - caller cancellation.
 * @returns the remote executable when one is reusable, and the physical home/cache directories.
 * @throws RemoteError `hemi-ssh/ssh-unavailable` when OpenSSH cannot reach or authenticate the endpoint.
 * @throws RemoteError `hemi-ssh/remote-runtime-missing` when the remote login directory is not usable.
 * @throws RemoteError `hemi-ssh/remote-cache-unwritable` when the owned cache directory cannot exist.
 */
export async function probeRemoteRuntime(endpoint: SshEndpointArgs, signal: AbortSignal): Promise<SshRemoteProbe> {
  const fallbacks = NODE_FALLBACK_PATHS.map(quoteRemote).join(' ')
  const command = [
    'h=${HOME:-}',
    'c=${XDG_CACHE_HOME:-$h/.cache}/hemi-ssh',
    'mkdir -p "$c" 2>/dev/null || exit 70',
    // A symlinked cache location must not place the runtime inside a workspace through an alias.
    'c=$(cd -- "$c" && pwd -P) || exit 70',
    'n=$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)',
    `if [ -z "$n" ]; then for p in ${fallbacks}; do [ -x "$p" ] && n=$p && break; done; fi`,
    'v=',
    '[ -n "$n" ] && v=$("$n" --version 2>/dev/null)',
    'printf \'H%s\\nN%s\\nV%s\\nC%s\\n\' "$h" "$n" "$v" "$c"',
  ].join('\n')
  const output = await sshExec(endpoint, command, signal).catch((error: unknown) => {
    if (error instanceof RemoteCommandError && error.exitCode === CACHE_REFUSAL_EXIT) {
      throw new RemoteError('hemi-ssh/remote-cache-unwritable', 'The remote user directory cannot hold the Hemi runtime cache', {
        host: endpoint.host, detail: 'mkdir of the cache directory failed',
      })
    }
    throw error
  })
  const fields = taggedFields(output)
  const home = fields.H ?? ''
  const node = fields.N ?? ''
  const nodeVersion = fields.V ?? ''
  const cacheDir = fields.C ?? ''
  if (home === '' || !posix.isAbsolute(home)) {
    throw unavailable(endpoint.host, 'empty or relative HOME', 'The remote login directory is not usable')
  }
  if (cacheDir === '' || !posix.isAbsolute(cacheDir)) {
    throw new RemoteError('hemi-ssh/remote-cache-unwritable', 'The remote cache directory is not usable', {
      host: endpoint.host, detail: 'empty or relative cache path',
    })
  }
  const major = /^v(\d+)\./.exec(nodeVersion)?.[1]
  const reusable = node !== '' && posix.isAbsolute(node) && major !== undefined && Number(major) >= REQUIRED_NODE_MAJOR
  return reusable ? { home, node, nodeVersion, cacheDir } : { home, cacheDir }
}

/**
 * Stream every bundled artifact file into the app-owned content-addressed cache directory.
 * @param endpoint - saved connection fields.
 * @param artifacts - digest-verified Host artifact set; its content identity names the directory.
 * @param cacheDir - app-owned physical remote cache directory.
 * @param signal - caller cancellation.
 * @returns the remote directory holding exactly this artifact payload; a same-version rebuild with
 * different bytes gets its own directory, so deployments recorded by existing Sessions are never replaced.
 */
export async function streamHelperArtifacts(
  endpoint: SshEndpointArgs, artifacts: SshHelperArtifacts, cacheDir: string, signal: AbortSignal,
): Promise<string> {
  const versionDir = `${cacheDir.replace(/\/+$/, '')}/${helperDirectoryName(artifacts)}`
  for (const file of artifacts.files) {
    const relative = posix.normalize(file.path)
    if (relative.startsWith('/') || relative.startsWith('..') || relative.includes('\\')) {
      throw new RemoteError('hemi-ssh/helper-artifacts-missing', 'This Hemi installation is missing its bundled SSH runtime; reinstall the app',
        { detail: `manifest path escapes the artifact set: ${file.path}` })
    }
    const final = `${versionDir}/${relative}`
    const temporary = `${final}.hemi-${randomBytes(6).toString('hex')}`
    const directory = posix.dirname(final)
    const command = `umask 077 && mkdir -p ${quoteRemote(directory)} && cat > ${quoteRemote(temporary)} && mv -f ${quoteRemote(temporary)} ${quoteRemote(final)}`
    await sshStream(endpoint, command, file.bytes, signal).catch((error: unknown) => {
      if (error instanceof RemoteCommandError) {
        throw new RemoteError('hemi-ssh/remote-cache-unwritable', 'The remote user directory cannot hold the Hemi runtime cache', {
          host: endpoint.host, detail: `writing ${relative} failed: ${error.reason === '' ? `exit ${error.exitCode}` : error.reason}`,
        })
      }
      throw error
    })
  }
  return versionDir
}

/**
 * Resolve the helper's Node executable, supplying the provisioned official runtime when nothing is reusable.
 * @param endpoint - saved connection fields, for error attribution when no provisioner exists.
 * @param cacheDir - app-owned remote cache directory the provisioner installs into.
 * @param provision - Host callback deploying the official Node build; omitted keeps the legacy refusal.
 * @returns an absolute remote Node executable path.
 * @throws RemoteError `hemi-ssh/remote-runtime-missing` when no Node is reusable and no provisioner is supplied.
 */
async function supplyRemoteNode(
  endpoint: SshEndpointArgs, cacheDir: string, provision: ((cacheDir: string) => Promise<string>) | undefined,
): Promise<string> {
  if (provision === undefined) {
    throw unavailable(endpoint.host, 'no reusable Node and no provisioner supplied',
      'The remote machine has no Node runtime Hemi can use; install Node 24 or newer there')
  }
  return provision(cacheDir)
}

/**
 * Probe the remote machine and deploy the bundled helper into its owned cache.
 * @param endpoint - saved connection fields.
 * @param artifacts - digest-verified Host artifact set.
 * @param signal - caller cancellation.
 * @param provisionNode - Host callback deploying the official Node build when the machine has none Hemi can reuse;
 *   its failures carry the provisioning error codes.
 * @returns the resolved deployment and the probe facts it depends on.
 */
export async function prepareRemoteRuntime(
  endpoint: SshEndpointArgs, artifacts: SshHelperArtifacts, signal: AbortSignal,
  provisionNode?: (cacheDir: string) => Promise<string>,
): Promise<SshPreparedRuntime> {
  const probe = await probeRemoteRuntime(endpoint, signal)
  // Provisioning runs before streaming so a machine without a runtime costs no artifact upload.
  const node = probe.node ?? await supplyRemoteNode(endpoint, probe.cacheDir, provisionNode)
  const versionDir = await streamHelperArtifacts(endpoint, artifacts, probe.cacheDir, signal)
  const helperFile = artifacts.files.find(file => file.path === artifacts.helperPath)
  const bootstrapFile = artifacts.files.find(file => file.path === artifacts.bootstrapPath)
  if (helperFile === undefined || bootstrapFile === undefined) {
    throw new RemoteError('hemi-ssh/helper-artifacts-missing', 'This Hemi installation is missing its bundled SSH runtime; reinstall the app',
      { detail: 'manifest entry files were not present in the verified set' })
  }
  return {
    probe,
    deployment: {
      helper: `${versionDir}/${posix.normalize(artifacts.helperPath)}`,
      helperHash: helperFile.sha256,
      launch: {
        kind: 'node-script', node,
        bootstrapPath: `${versionDir}/${posix.normalize(artifacts.bootstrapPath)}`, bootstrapHash: bootstrapFile.sha256,
      },
    },
  }
}

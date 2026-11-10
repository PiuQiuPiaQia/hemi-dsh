/** Host-side download and remote deployment of the official Node distribution for servers without a usable Node. */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { containsPath, quoteRemote, RemoteCommandError, sshExec, sshStream, type SshEndpointArgs } from './browse.ts'
import { taggedFields } from './runtime-bootstrap.ts'

/** Official Node the provisioner deploys; pinned to the Node version this repository's runtime ships. */
export const PROVISIONED_NODE_VERSION = 'v24.14.1' as const

/** Operating systems the official Node distribution ships for and Hemi accepts. */
type RemoteNodeOs = 'linux' | 'darwin'

/** Machine architectures the official Node distribution ships for and Hemi accepts. */
type RemoteNodeArch = 'x64' | 'arm64'

/** Pinned SHA-256 of each official `node-<version>-<os>-<arch>.tar.gz` in nodejs.org/dist SHASUMS256.txt, keyed `<os>-<arch>`. */
export const PROVISIONED_NODE_SHA256: Record<`${RemoteNodeOs}-${RemoteNodeArch}`, string> = {
  'linux-x64': 'ace9fa104992ed0829642629c46ca7bd7fd6e76278cb96c958c4b387d29658ea',
  'linux-arm64': '734ff04fa7f8ed2e8a78d40cacf5ac3fc4515dac2858757cbab313eb483ba8a2',
  'darwin-x64': '2526230ad7d922be82d4fdb1e7ee1e84303e133e3b4b0ec4c2897ab31de0253d',
  'darwin-arm64': '25495ff85bd89e2d8a24d88566d7e2f827c6b0d3d872b2cebf75371f93fcb1fe',
}

/** Hard cap on one downloaded distribution; official Linux x64 tarballs stay far below it. */
const MAX_TARBALL_BYTES = 256 * 1024 * 1024

/** Oldest glibc the official Linux build supports, as reported by `getconf GNU_LIBC_VERSION`. */
const MINIMUM_GLIBC_MAJOR = 2
const MINIMUM_GLIBC_MINOR = 28

/** Loader pattern whose presence marks a musl system the official Linux build does not target. */
const MUSL_LOADER_GLOB = '/lib/ld-musl-*.so.1'

/** Host-side options for {@link provisionRemoteNode}; production defaults resolve from the environment. */
export interface SshNodeProvisionerOptions {
  /** Host cache directory holding downloaded official tarballs across connections; defaults to `<tmpdir>/hemi-ssh-node-runtime`. */
  readonly cacheDir?: string
  /** HTTP client reaching nodejs.org; production uses `globalThis.fetch`, tests inject a fake. */
  readonly download?: typeof fetch
  /** Deadline in milliseconds for the whole provisioning operation; unset means only the caller's signal bounds it. */
  readonly timeoutMs?: number
}

/** One remote machine's distribution target as reported by its own POSIX tools. */
interface RemoteNodePlatform {
  readonly os: RemoteNodeOs
  readonly arch: RemoteNodeArch
  /** `getconf GNU_LIBC_VERSION` output, for example `glibc 2.35`; empty on musl and macOS. */
  readonly glibc: string
  /** Whether the remote loader reports a musl system. */
  readonly musl: boolean
}

/** Structured failure for every download, digest, deadline and installation problem below the probe level. */
function provisionFailed(host: string, detail: string): RemoteError {
  return new RemoteError('hemi-ssh/runtime-provision-failed',
    'Could not prepare the remote Node runtime; check the network connection of this computer and try again', { host, detail })
}

/** Bounded single-line reason of an arbitrary failure. */
function describeError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').trim().slice(0, 300)
  return message === '' ? 'unknown failure' : message
}

/**
 * Absolute host path of the cached official tarball for one platform.
 * @param cacheDir - host cache root.
 * @param os - remote operating system.
 * @param arch - remote machine architecture.
 * @returns the pinned cache file path.
 */
function hostTarballPath(cacheDir: string, os: RemoteNodeOs, arch: RemoteNodeArch): string {
  return join(cacheDir, PROVISIONED_NODE_VERSION, `node-${PROVISIONED_NODE_VERSION}-${os}-${arch}.tar.gz`)
}

/**
 * Read the remote operating system, machine architecture and libc in one shell round trip.
 * @param endpoint - saved connection fields.
 * @param signal - caller cancellation.
 * @returns the distribution target the official Node build must match.
 * @throws RemoteError `hemi-ssh/ssh-unavailable` when OpenSSH cannot reach or authenticate the endpoint.
 * @throws RemoteError `hemi-ssh/remote-runtime-missing` when the platform has no official Node build Hemi ships.
 */
async function probeRemoteNodePlatform(endpoint: SshEndpointArgs, signal: AbortSignal): Promise<RemoteNodePlatform> {
  const command = [
    'o=$(uname -s)',
    'r=$(uname -m)',
    'g=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)',
    'u=',
    `[ -n "$(ls ${MUSL_LOADER_GLOB} 2>/dev/null)" ] && u=musl`,
    'printf \'O%s\\nR%s\\nG%s\\nU%s\\n\' "$o" "$r" "$g" "$u"',
  ].join('\n')
  const fields = taggedFields(await sshExec(endpoint, command, signal))
  const system = fields.O ?? ''
  const machine = fields.R ?? ''
  const os = system === 'Linux' ? 'linux' as const : system === 'Darwin' ? 'darwin' as const : undefined
  const arch = machine === 'x86_64' ? 'x64' as const : machine === 'aarch64' || machine === 'arm64' ? 'arm64' as const : undefined
  if (os === undefined || arch === undefined) {
    throw new RemoteError('hemi-ssh/remote-runtime-missing',
      'The bundled Node runtime does not ship for this remote platform '
        + `(${system === '' ? 'unknown system' : system} ${machine === '' ? 'unknown architecture' : machine}); `
        + 'install Node 24 or newer there',
      { host: endpoint.host, detail: `uname -s=${system}; uname -m=${machine}` })
  }
  return { os, arch, glibc: fields.G ?? '', musl: fields.U === 'musl' }
}

/**
 * Describe a libc the official Linux build may not run on; the connection continues regardless.
 * @param platform - detected remote platform.
 * @returns the warning text, or undefined when the libc is supported.
 */
function libcWarning(platform: RemoteNodePlatform): string | undefined {
  const requirement = `glibc ${MINIMUM_GLIBC_MAJOR}.${MINIMUM_GLIBC_MINOR} or newer`
  if (platform.musl) {
    return `The remote system loads ${MUSL_LOADER_GLOB} (musl); the bundled Node runtime needs ${requirement} and may not start there`
  }
  const reported = /^glibc (\d+)\.(\d+)$/.exec(platform.glibc.trim())
  if (reported === null) return undefined
  const major = Number(reported[1])
  const minor = Number(reported[2])
  if (major > MINIMUM_GLIBC_MAJOR || (major === MINIMUM_GLIBC_MAJOR && minor >= MINIMUM_GLIBC_MINOR)) return undefined
  return `The remote system reports ${platform.glibc.trim()}; the bundled Node runtime needs ${requirement} and may not start there`
}

/**
 * Check whether the remote installation already reports the pinned version.
 * @param endpoint - saved connection fields.
 * @param remoteNode - absolute remote `bin/node` path of the version-platform installation.
 * @param signal - caller cancellation.
 * @returns true when the remote binary exists and prints exactly the pinned version.
 * @throws RemoteError `hemi-ssh/ssh-unavailable` when OpenSSH cannot reach or authenticate the endpoint.
 */
async function reusableRemoteNode(endpoint: SshEndpointArgs, remoteNode: string, signal: AbortSignal): Promise<boolean> {
  const reported = await sshExec(endpoint,
    `if [ -x ${quoteRemote(remoteNode)} ]; then ${quoteRemote(remoteNode)} --version; fi`, signal)
    .then(output => output.toString('utf8').trim())
    // An absent or unrunnable binary is the ordinary not-provisioned case; only a broken transport escapes.
    .catch((error: unknown) => {
      if (error instanceof RemoteError) throw error
      return ''
    })
  return reported === PROVISIONED_NODE_VERSION
}

/**
 * Stream-hash one file.
 * @param path - file to digest.
 * @returns the lowercase SHA-256.
 */
async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  await pipeline(createReadStream(path), digest)
  return digest.digest('hex')
}

/**
 * Copy the response body into a temporary file under the cap, digest it and publish it atomically.
 * @param endpoint - saved connection fields, for error attribution.
 * @param url - official distribution URL.
 * @param path - final host cache path; the temporary file is created beside it.
 * @param sha256 - pinned digest the downloaded bytes must match.
 * @param signal - caller cancellation or the provisioning deadline.
 * @param download - injected or global HTTP client.
 */
async function downloadTarball(
  endpoint: SshEndpointArgs, url: string, path: string, sha256: string, signal: AbortSignal, download: typeof fetch,
): Promise<void> {
  const response = await download(url, { redirect: 'follow', signal }).catch((error: unknown) => {
    if (signal.aborted) throw error
    throw provisionFailed(endpoint.host, `downloading ${url} failed: ${describeError(error)}`)
  })
  if (!response.ok) {
    throw provisionFailed(endpoint.host, `nodejs.org answered ${response.status} ${response.statusText} for ${url}`)
  }
  const announced = Number(response.headers.get('content-length'))
  if (Number.isFinite(announced) && announced > MAX_TARBALL_BYTES) {
    throw provisionFailed(endpoint.host, `nodejs.org announced ${announced} bytes for ${url}, over the ${MAX_TARBALL_BYTES} byte cap`)
  }
  const source = response.body
  if (source === null) throw provisionFailed(endpoint.host, `nodejs.org returned an empty body for ${url}`)
  const temporary = `${path}.hemi-${randomBytes(6).toString('hex')}`
  const digest = createHash('sha256')
  let received = 0
  await mkdir(dirname(path), { recursive: true })
  try {
    await pipeline(
      Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0]),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          received += chunk.byteLength
          if (received > MAX_TARBALL_BYTES) throw new Error(`download exceeded the ${MAX_TARBALL_BYTES} byte cap`)
          // The hash updates inline: as a pipeline stage it would feed its raw digest to the writer.
          digest.update(chunk)
          yield chunk
        }
      },
      createWriteStream(temporary),
    )
  } catch (error: unknown) {
    // A failed download never leaves a temporary file behind; deletion failure keeps the original error.
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  const actual = digest.digest('hex')
  if (actual !== sha256) {
    await rm(temporary, { force: true })
    throw provisionFailed(endpoint.host, `downloaded ${url} does not match the pinned SHA-256 (${actual})`)
  }
  await rename(temporary, path)
}

/**
 * Ensure the host cache holds the official tarball: reuse it when its digest matches the pin, otherwise download.
 * @param endpoint - saved connection fields, for error attribution.
 * @param os - remote operating system naming the official distribution.
 * @param arch - remote machine architecture naming the official distribution.
 * @param path - final host cache path.
 * @param signal - caller cancellation or the provisioning deadline.
 * @param download - injected or global HTTP client.
 */
async function ensureHostTarball(
  endpoint: SshEndpointArgs, os: RemoteNodeOs, arch: RemoteNodeArch, path: string, signal: AbortSignal, download: typeof fetch,
): Promise<void> {
  const sha256 = PROVISIONED_NODE_SHA256[`${os}-${arch}`]
  const cached = await sha256File(path).catch(() => undefined)
  if (cached === sha256) return
  const url = `https://nodejs.org/dist/${PROVISIONED_NODE_VERSION}/node-${PROVISIONED_NODE_VERSION}-${os}-${arch}.tar.gz`
  await downloadTarball(endpoint, url, path, sha256, signal, download)
}

/**
 * Upload the verified tarball through the atomic stream transaction, extract it and verify the binary.
 * @param endpoint - saved connection fields.
 * @param remoteDir - version-platform installation directory under the app-owned cache.
 * @param tarball - digest-verified distribution bytes.
 * @param remoteNode - absolute remote `bin/node` path extraction must produce.
 * @param expectedVersion - version the remote binary must report.
 * @param signal - caller cancellation or the provisioning deadline.
 * @throws RemoteError `hemi-ssh/remote-cache-unwritable` when the upload cannot be written.
 * @throws Error when extraction fails or the deployed binary reports another version; the caller retries once.
 */
async function installRemoteNode(
  endpoint: SshEndpointArgs, remoteDir: string, tarball: Buffer, remoteNode: string, expectedVersion: string, signal: AbortSignal,
): Promise<void> {
  const remoteTarball = `${remoteDir}/node.tar.gz`
  const runtimeDir = `${remoteDir}/runtime`
  const temporary = `${remoteTarball}.hemi-${randomBytes(6).toString('hex')}`
  await sshStream(endpoint,
    `umask 077 && mkdir -p ${quoteRemote(remoteDir)} && cat > ${quoteRemote(temporary)} && mv -f ${quoteRemote(temporary)} ${quoteRemote(remoteTarball)}`,
    tarball, signal,
  ).catch((error: unknown) => {
    if (error instanceof RemoteCommandError) {
      throw new RemoteError('hemi-ssh/remote-cache-unwritable', 'The remote user directory cannot hold the Hemi runtime cache', {
        host: endpoint.host, detail: `writing node.tar.gz failed: ${error.reason === '' ? `exit ${error.exitCode}` : error.reason}`,
      })
    }
    throw error
  })
  await sshExec(endpoint,
    `umask 077 && mkdir -p ${quoteRemote(runtimeDir)} && tar -xzf ${quoteRemote(remoteTarball)} -C ${quoteRemote(runtimeDir)}`, signal)
  const reported = (await sshExec(endpoint, `${quoteRemote(remoteNode)} --version`, signal)).toString('utf8').trim()
  if (reported !== expectedVersion) {
    throw new Error(`the deployed Node reports ${reported === '' ? 'no version' : reported}`)
  }
}

/**
 * Remove one failed version-platform installation, refusing any path outside the app-owned cache.
 * @param endpoint - saved connection fields.
 * @param remoteDir - version-platform installation directory to delete.
 * @param ownedPrefix - app-owned `<remoteCacheDir>/node` prefix the directory must live under.
 * @param signal - caller cancellation or the provisioning deadline.
 * @throws RemoteError `hemi-ssh/runtime-provision-failed` when the path would leave the owned cache.
 */
async function removeFailedInstall(
  endpoint: SshEndpointArgs, remoteDir: string, ownedPrefix: string, signal: AbortSignal,
): Promise<void> {
  if (!containsPath(ownedPrefix, remoteDir)) {
    throw provisionFailed(endpoint.host, `refusing to clean the installation outside the Hemi cache: ${remoteDir}`)
  }
  await sshExec(endpoint, `rm -rf ${quoteRemote(remoteDir)}`, signal)
}

/**
 * Supply the pinned official Node runtime on the remote machine and return its executable path.
 * The Host caches the downloaded distribution by digest; the remote cache reuses an installation that
 * already reports the pinned version, cleans and reinstalls a broken one once, then fails.
 * @param endpoint - saved connection fields.
 * @param remoteCacheDir - app-owned physical remote cache directory; the runtime installs under `<dir>/node/`.
 * @param signal - caller cancellation.
 * @param options - host cache, HTTP client, deadline and warning sink; production defaults resolve internally.
 * @returns the absolute remote `bin/node` path of the deployed official build.
 * @throws RemoteError `hemi-ssh/ssh-unavailable` when OpenSSH cannot reach or authenticate the endpoint.
 * @throws RemoteError `hemi-ssh/remote-runtime-missing` when the remote platform has no official Node build Hemi ships.
 * @throws RemoteError `hemi-ssh/remote-cache-unwritable` when the remote cache cannot hold the upload.
 * @throws RemoteError `hemi-ssh/runtime-provision-failed` when download, digest, deadline or installation fails.
 */
export async function provisionRemoteNode(
  endpoint: SshEndpointArgs, remoteCacheDir: string, signal: AbortSignal,
  options?: SshNodeProvisionerOptions & { readonly onWarn?: (message: string) => void },
): Promise<string> {
  signal.throwIfAborted()
  const control = options?.timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)])
  const download = options?.download ?? globalThis.fetch
  try {
    const platform = await probeRemoteNodePlatform(endpoint, control)
    const warning = libcWarning(platform)
    if (warning !== undefined) options?.onWarn?.(warning)
    const platformId = `${PROVISIONED_NODE_VERSION}-${platform.os}-${platform.arch}`
    const nodeCache = `${remoteCacheDir.replace(/\/+$/, '')}/node`
    const remoteDir = `${nodeCache}/${platformId}`
    const remoteNode = `${remoteDir}/runtime/node-${PROVISIONED_NODE_VERSION}-${platform.os}-${platform.arch}/bin/node`
    // Reuse beats download: an intact remote installation needs no Host transfer at all.
    if (await reusableRemoteNode(endpoint, remoteNode, control)) return remoteNode
    const tarballPath = hostTarballPath(options?.cacheDir ?? join(tmpdir(), 'hemi-ssh-node-runtime'), platform.os, platform.arch)
    await ensureHostTarball(endpoint, platform.os, platform.arch, tarballPath, control, download)
    const tarball = await readFile(tarballPath)
    try {
      await installRemoteNode(endpoint, remoteDir, tarball, remoteNode, PROVISIONED_NODE_VERSION, control)
      return remoteNode
    } catch (error: unknown) {
      if (error instanceof RemoteError) throw error
      await removeFailedInstall(endpoint, remoteDir, nodeCache, control)
      await installRemoteNode(endpoint, remoteDir, tarball, remoteNode, PROVISIONED_NODE_VERSION, control)
        .catch((second: unknown) => {
          if (second instanceof RemoteError) throw second
          throw provisionFailed(endpoint.host, `two installation attempts failed: ${describeError(error)}; ${describeError(second)}`)
        })
      return remoteNode
    }
  } catch (error: unknown) {
    if (error instanceof RemoteError) throw error
    if (control.aborted && !signal.aborted) {
      throw provisionFailed(endpoint.host, `did not finish within the ${options?.timeoutMs} ms budget: ${describeError(error)}`)
    }
    throw error
  }
}

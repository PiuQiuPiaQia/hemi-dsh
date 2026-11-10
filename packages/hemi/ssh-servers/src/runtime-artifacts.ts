/** Host-side resolution of the bundled, versioned helper artifacts streamed to remote machines. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Deployment packaging override for source checkouts and packaging tests.
 * Product builds resolve the artifacts shipped beside this module and need no value here.
 */
export const HELPER_ARTIFACTS_ENV = 'DSH_HEMI_SSH_HELPER_DIR'

/** Version identifiers that reach a remote directory name; printable, no separators or traversal. */
const versionValue = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/)
/** Artifact-relative POSIX paths: no drive letters, separators, or parent traversal. */
const relativePath = z.string().regex(/^(?!\/)(?!\\)[^\\\0]+$/).refine(
  value => value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
  'path must be a normalized relative POSIX path',
)

const manifestSchema = z.object({
  version: versionValue,
  /** Entry executed by the remote Node, relative to the artifact root. */
  helper: relativePath,
  /** Self-contained PTC bootstrap, relative to the artifact root. */
  bootstrap: relativePath,
  /** Every file that must exist beside the entry, with its lowercase SHA-256. */
  files: z.array(z.object({ path: relativePath, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()).min(1),
}).strict()

/** Verified artifact set the Host streams into its app-owned remote cache. */
export interface SshHelperArtifacts {
  /** Artifact layout version; names the remote cache directory together with {@link contentId}. */
  readonly version: string
  /** Stable digest of the complete manifest payload; distinguishes same-version rebuilds. */
  readonly contentId: string
  /** Relative helper entry path within the artifact set. */
  readonly helperPath: string
  /** Relative PTC bootstrap path within the artifact set. */
  readonly bootstrapPath: string
  /** Every file with its bytes and digest, in stream order. */
  readonly files: readonly { readonly path: string; readonly sha256: string; readonly bytes: Buffer }[]
}

function missing(detail: string): RemoteError {
  return new RemoteError('hemi-ssh/helper-artifacts-missing',
    'This Hemi installation is missing its bundled SSH runtime; reinstall the app', { detail })
}

function artifactsDirectory(): string {
  const override = process.env[HELPER_ARTIFACTS_ENV]
  if (override !== undefined && override !== '') return override
  // Product ships the artifact tree beside the built module; source checkouts use the override.
  return join(dirname(fileURLToPath(import.meta.url)), 'remote')
}

/**
 * Load and digest-check the bundled helper artifacts this installation ships.
 * @returns the fully read artifact set, including a content digest of the whole manifest payload.
 * @throws RemoteError `hemi-ssh/helper-artifacts-missing` when the shipped set is absent, malformed, or corrupted.
 */
export async function loadHelperArtifacts(): Promise<SshHelperArtifacts> {
  const root = artifactsDirectory()
  let manifest: unknown
  try { manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) } catch {
    throw missing('manifest.json is missing or unreadable')
  }
  const parsed = manifestSchema.safeParse(manifest)
  if (!parsed.success) {
    throw missing(`manifest.json is invalid: ${parsed.error.issues[0]?.message ?? 'schema'}`
      .replaceAll('\n', ' ').replaceAll('\r', ' ').slice(0, 300))
  }
  const files: SshHelperArtifacts['files'][number][] = []
  for (const entry of parsed.data.files) {
    let bytes: Buffer
    try { bytes = await readFile(join(root, entry.path)) } catch { throw missing(`${entry.path} is unreadable`) }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== entry.sha256) throw missing(`${entry.path} does not match its recorded digest`)
    files.push({ path: entry.path, sha256, bytes })
  }
  const helper = parsed.data.helper
  const bootstrap = parsed.data.bootstrap
  if (!files.some(file => file.path === helper)) throw missing(`manifest entry file ${helper} is absent`)
  if (!files.some(file => file.path === bootstrap)) throw missing(`manifest entry file ${bootstrap} is absent`)
  // The manifest payload identity, not the product version alone, names the remote cache
  // directory: a same-version rebuild streams beside, never over, a previously deployed set.
  const contentId = createHash('sha256')
    .update(JSON.stringify(parsed.data.files.map(file => [file.path, file.sha256])))
    .digest('hex').slice(0, 16)
  return { version: parsed.data.version, contentId, helperPath: helper, bootstrapPath: bootstrap, files }
}

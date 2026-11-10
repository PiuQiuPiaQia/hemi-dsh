/**
 * Build the app-owned SSH remote helper artifact set shipped beside this package's `lib`.
 *
 * The output layout is the contract `src/runtime-artifacts.ts` resolves in production
 * (no environment variable): `lib/remote/manifest.json` plus
 * `runtime/{package.json, helper/{helper.js, chunks, ptc-process.js}}`. The bundle entry
 * is the tsdown-built `packages/ssh/ssh/lib/helper.js`, so this build must run after the
 * Host bundle step; `node-pty` stays external and intentionally absent (remote terminals
 * are reported unsupported separately).
 */
import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'tsdown'

/** Artifact-root-relative helper entry executed by the remote Node, fixed by the resolver contract. */
export const REMOTE_HELPER_ENTRY = 'runtime/helper/helper.js'

/** Artifact-root-relative self-contained PTC bootstrap, fixed by the resolver contract. */
export const REMOTE_HELPER_BOOTSTRAP = 'runtime/helper/ptc-process.js'

/** One digest-verified file of the shipped artifact set, in manifest stream order. */
export interface RemoteHelperFile {
  readonly path: string
  readonly sha256: string
}

/** Result of one artifact build: the manifest identity and its verified files. */
export interface RemoteHelperBuildResult {
  readonly version: string
  readonly files: readonly RemoteHelperFile[]
}

/**
 * Whether one emitted path is filesystem residue rather than helper payload.
 * AppleDouble `._` sidecars appear for every file while the checkout sits on an ExFAT
 * volume; `.tsbuildinfo` is defensive residue from compiler runs.
 * @param path - Artifact-relative path with `/` separators.
 * @returns Whether the file must be excluded from the manifest and payload.
 */
export function isArtifactNoise(path: string): boolean {
  return path.split('/').some(segment => segment.startsWith('._')) || path.endsWith('.tsbuildinfo')
}

/**
 * Reject a bundled module that still references a workspace package by bare specifier.
 * The streamed runtime resolves no workspace dependencies: a static `@deepseek-ai/*`
 * import would fail on every remote machine. Lazy resolution such as
 * `import.meta.resolve(...)` inside feature-gated paths and the intentionally absent
 * `node-pty` external are not static imports and stay allowed.
 * @param path - Artifact-relative path of the bundled module, used in the error.
 * @param bytes - Module bytes to scan.
 * @throws Naming the file and the unresolved workspace specifier.
 */
export function assertPortableModule(path: string, bytes: Buffer): void {
  const source = bytes.toString('utf8')
  for (const match of source.matchAll(/(?:\bfrom|\bimport|\brequire|__require)\s*\(?\s*["'](@deepseek-ai\/[^"'\n]+)["']/gu)) {
    throw new Error(`remote helper ${path} statically imports workspace package ${match[1]}; the streamed runtime resolves no workspace dependencies`)
  }
}

/**
 * Write the nested runtime package manifest.
 * Bundled attribution code reads `createRequire(import.meta.url)('../package.json')` at
 * startup; without this file the helper fails on the remote machine before the handshake.
 * @param root - Artifact root receiving `runtime/package.json`.
 * @param version - Version of the shipped helper runtime.
 */
export async function writeRuntimePackage(root: string, version: string): Promise<void> {
  await mkdir(join(root, 'runtime'), { recursive: true })
  await writeFile(join(root, 'runtime/package.json'), `${JSON.stringify({ name: 'hemi-ssh-helper-runtime', version, type: 'module' }, null, 2)}\n`)
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Digest every payload file under one artifact root in deterministic path order.
 * @param root - Artifact root containing `runtime/`.
 * @returns Manifest entries with lowercase SHA-256 digests, residue excluded.
 * @throws When the helper entry, the PTC bootstrap, or the runtime package manifest is absent.
 */
export async function collectRemoteHelperFiles(root: string): Promise<RemoteHelperFile[]> {
  const entries: RemoteHelperFile[] = []
  const helperDirectory = join(root, 'runtime/helper')
  for (const name of await readdir(helperDirectory, { recursive: true })) {
    if (typeof name !== 'string') continue
    const relative = name.replaceAll('\\', '/')
    if (isArtifactNoise(relative)) continue
    // Recursive listing names directories too; only files belong to the payload.
    if (!(await lstat(join(helperDirectory, relative))).isFile()) continue
    const bytes = await readFile(join(helperDirectory, relative))
    entries.push({ path: `runtime/helper/${relative}`, sha256: digest(bytes) })
  }
  let runtimePackage: Buffer
  try {
    runtimePackage = await readFile(join(root, 'runtime/package.json'))
  } catch {
    // The nested manifest is a build output, not caller input; report the artifact gap, not the raw ENOENT.
    throw new Error('remote helper artifact set is missing runtime/package.json')
  }
  entries.push({ path: 'runtime/package.json', sha256: digest(runtimePackage) })
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const required of [REMOTE_HELPER_ENTRY, REMOTE_HELPER_BOOTSTRAP, 'runtime/package.json']) {
    if (!entries.some(entry => entry.path === required)) throw new Error(`remote helper artifact set is missing ${required}`)
  }
  return entries
}

async function helperRuntimeVersion(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, 'packages/ssh/ssh/package.json'), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('remote helper build: packages/ssh/ssh/package.json has no version')
  }
  return manifest.version
}

/**
 * Build the helper artifact set `loadHelperArtifacts()` ships from this installation.
 * @param root - Repository root providing the built Host outputs.
 * @param outDir - Artifact root to write; defaults to this package's `lib/remote`.
 * @returns The manifest identity and the entries written.
 * @throws When the Host inputs are missing (run after the host-bundle build step), the
 *   bundle leaves static workspace imports, or a required payload file is absent.
 */
export async function buildRemoteHelperArtifacts(root: string, outDir = join(import.meta.dirname, '../lib/remote')): Promise<RemoteHelperBuildResult> {
  const version = await helperRuntimeVersion(root)
  const staging = await mkdtemp(join(tmpdir(), 'hemi-remote-helper-'))
  try {
    // The stub deliberately carries no `paths`: repository mappings would resolve
    // workspace packages to src, whose decorators reach the bundle unlowered.
    await writeFile(join(staging, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { target: 'es2024' } })}\n`)
    await build({
      cwd: root,
      config: false,
      // The entry must be the built helper entry; the Host tsc pass lowers decorators.
      entry: [join(root, 'packages/ssh/ssh/lib/helper.js')],
      outDir: join(outDir, 'runtime/helper'),
      tsconfig: join(staging, 'tsconfig.json'),
      format: ['esm'],
      platform: 'node',
      target: 'es2024',
      fixedExtension: false,
      dts: false,
      clean: true,
      deps: { alwaysBundle: [/./], neverBundle: ['node-pty'] },
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  await copyFile(join(root, 'packages/ptc-runtime/ptc-runtime-node/lib/process.js'), join(outDir, REMOTE_HELPER_BOOTSTRAP))
  await writeRuntimePackage(outDir, version)
  const files = await collectRemoteHelperFiles(outDir)
  for (const file of files) {
    if (file.path.endsWith('.js')) assertPortableModule(file.path, await readFile(join(outDir, file.path)))
  }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify({ version, helper: REMOTE_HELPER_ENTRY, bootstrap: REMOTE_HELPER_BOOTSTRAP, files }, null, 2)}\n`)
  return { version, files }
}

const repositoryRoot = resolve(import.meta.dirname, '../../../..')

if (import.meta.main) {
  const result = await buildRemoteHelperArtifacts(repositoryRoot, process.argv[2] !== undefined ? resolve(process.argv[2]) : undefined)
  console.log(`remote helper artifacts: version ${result.version}, ${String(result.files.length)} files`)
}

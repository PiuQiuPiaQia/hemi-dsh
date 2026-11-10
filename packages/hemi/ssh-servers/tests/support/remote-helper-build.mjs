/**
 * Test-owned entry building the shipped SSH helper artifact set through the production
 * builder, so tests and packaging always produce the same tree.
 *
 * Runs as a child process (`node …/remote-helper-build.mjs <outDir>`) so the package needs
 * no bundler dependency; `tsdown` resolves from the repository root. Node's type stripping
 * imports the TypeScript builder directly.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRemoteHelperArtifacts } from '../../build/remote-helper.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const outDir = resolve(process.argv[2] ?? '.scratch/remote-helper')
const result = await buildRemoteHelperArtifacts(repo, outDir)
console.log(JSON.stringify({ outDir, files: result.files.map(file => file.path) }))

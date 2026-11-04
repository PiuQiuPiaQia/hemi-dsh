/** Package the built Host, Client, and profile layer without publishing or changing a user profile. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const bundleDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(bundleDir, '../..')
const destination = resolve(process.argv[2] ?? join(bundleDir, 'dist'))
const packages = [
  { directory: join(root, 'packages/hemi/routing'), required: ['lib/index.js', 'lib/settings.js', 'lib/typert.host.js', 'lib/typert.remote-client.js'] },
  { directory: join(root, 'packages/hemi/routing-ui'), required: ['lib/index.js', 'lib/client.js'] },
  { directory: bundleDir, required: ['cordis.patch.yml'] },
]

function main() {
  for (const { directory, required } of packages) {
    for (const file of required) {
      if (!existsSync(join(directory, file))) {
        throw new Error(`Missing ${join(directory, file)}; build the routing packages before packing`)
      }
    }
  }
  mkdirSync(destination, { recursive: true })
  const archives = []
  for (const { directory } of packages) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    const command = spawnSync('pnpm', ['pack', '--pack-destination', destination], {
      cwd: directory,
      stdio: 'inherit',
    })
    if (command.error !== undefined) throw command.error
    if (command.status !== 0) throw new Error(`Packing ${manifest.name} failed (${command.status ?? command.signal})`)
    const filename = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
    const path = join(destination, filename)
    if (!existsSync(path)) throw new Error(`Pack did not create ${path}`)
    const bytes = readFileSync(path)
    archives.push({ package: manifest.name, version: manifest.version, file: filename, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  writeFileSync(join(destination, 'packages.json'), JSON.stringify({ packages: archives }, null, 2) + '\n')
  console.log(`Packed ${archives.length} routing packages into ${destination}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

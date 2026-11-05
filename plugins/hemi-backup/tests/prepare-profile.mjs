// Prepare a fresh profile and clean official composition for the real backup plugin-install smoke.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const requireCli = createRequire(join(root, 'apps/cli/package.json'))
const { initProfile } = requireCli('@deepseek-ai/dsh-app-boot')
const area = resolve(process.argv[2] ?? join(root, '.artifacts/hemi-backup'))
mkdirSync(area, { recursive: true })
const firstForkChange = execFileSync('git', [
  'log', '--reverse', '--format=%H', '--', 'packages/hemi', 'packages/client/ui-hemi-skins',
], { cwd: root, encoding: 'utf8' }).trim().split('\n').find(Boolean)
if (firstForkChange === undefined) throw new Error('The checkout has no Hemi package introduction to identify its clean composition')
const baseline = `${firstForkChange}^`
const original = file => execFileSync('git', ['show', `${baseline}:${file}`], { cwd: root, encoding: 'utf8' })
const home = mkdtempSync(join(area, 'home-'))
const profile = join(home, 'profiles/web')
initProfile(profile, ['@deepseek-ai/dsh-base'])
const cleanBundle = join(home, 'clean-official-web')
mkdirSync(cleanBundle, { recursive: true })
const officialManifest = JSON.parse(original('packages/bundle/web-app/package.json'))
for (const file of officialManifest.dsh.bundle.patch) {
  const relative = file.replace(/^\.\//, '')
  const destination = join(cleanBundle, relative)
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, original(`packages/bundle/web-app/${relative}`))
}
writeFileSync(join(cleanBundle, 'package.json'), JSON.stringify({
  name: '@hemi/test-clean-official-web-backup',
  version: '0.2.2-alpha.3',
  private: true,
  type: 'module',
  dsh: { bundle: { patch: officialManifest.dsh.bundle.patch } },
}, null, 2) + '\n')

const backupsDir = join(home, 'backups')
mkdirSync(backupsDir, { recursive: true })
const agentsHome = join(home, 'agents')
mkdirSync(join(agentsHome, 'skills/fixture'), { recursive: true })
writeFileSync(join(agentsHome, 'skills/fixture/SKILL.md'), '# Isolated backup fixture\n')
const state = { root, baseline, home, agentsHome, profile, cleanBundle, backupsDir }
writeFileSync(join(area, 'state.json'), JSON.stringify(state, null, 2) + '\n')
console.log(JSON.stringify(state, null, 2))

import { resolve } from 'node:path'
import { copyFileSync } from 'node:fs'
import { signHemiMacApplication, createHemiMacRuntimeSigner } from '@deepseek-ai/dsh-hemi-customizations/github-community-signing'
const [app, identity, keychain, requirement] = process.argv.slice(2)
await signHemiMacApplication({ app, keychain, platform:'darwin',
  optionsForFile:()=>({ hardenedRuntime:true, entitlements:resolve('apps/desktop/scripts/macos-entitlements.plist') }) },
  { kind:'mac-self-signed',identity,certificate:'isolated test certificate',sha256:'isolated test' },requirement.split('"')[1])
const runtimeProbe = `${app}.runtime-probe`
copyFileSync('/usr/bin/true', runtimeProbe)
await createHemiMacRuntimeSigner({ kind: 'mac-self-signed', identity, certificate: 'isolated test', sha256: 'isolated test' }, keychain)
  .signFile(runtimeProbe, `${requirement.split('"')[1]}.runtime.probe`, resolve('apps/desktop/scripts/jit-entitlements.plist'))

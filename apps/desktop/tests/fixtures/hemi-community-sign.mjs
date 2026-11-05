import { resolve } from 'node:path'
import { signHemiMacApplication } from '@deepseek-ai/dsh-hemi-customizations/github-community-signing'
const [app, identity, keychain, requirement] = process.argv.slice(2)
await signHemiMacApplication({ app, keychain, platform:'darwin',
  optionsForFile:()=>({ hardenedRuntime:true, entitlements:resolve('apps/desktop/scripts/macos-entitlements.plist') }) },
  { kind:'mac-self-signed',identity,certificate:'isolated test certificate',sha256:'isolated test' },requirement.split('"')[1])

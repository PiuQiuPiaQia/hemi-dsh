/** Sign isolated native loader fixtures through the production fixed-certificate provider. */
import { join } from 'node:path'
import { createHemiMacRuntimeSigner } from '@deepseek-ai/dsh-hemi-customizations/github-community-signing'
const [directory, identity, keychain] = process.argv.slice(2)
const signer = createHemiMacRuntimeSigner({ kind: 'mac-self-signed', identity, certificate: 'isolated test', sha256: 'isolated test' }, keychain)
await signer.signFile(join(directory, 'loader'), 'ai.hemi.runtime-loader', undefined)
await signer.signFile(join(directory, 'probe.dylib'), 'ai.hemi.runtime-library', undefined)

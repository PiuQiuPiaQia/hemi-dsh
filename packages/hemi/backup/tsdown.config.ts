import { defineConfig } from 'tsdown'

const entry = (path: string) => ({
  entry: [path],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024' as const,
  fixedExtension: false,
  dts: false,
  clean: false,
})

/**
 * Build the self-contained Loader entry: the host service plus the type-only
 * client face at `./client`.
 */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/client.js'),
])

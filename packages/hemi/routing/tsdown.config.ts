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
 * Build self-contained Loader entries: the preset-scope tool plugin, the
 * root-scope settings/Remote service at `./settings`, and the client-safe
 * type module at `./client`.
 */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/settings.js'),
  entry('lib/types/client.js'),
])

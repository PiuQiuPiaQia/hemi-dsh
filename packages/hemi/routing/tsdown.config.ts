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
 * Build self-contained Loader entries: the preset-scope tool plugin and the
 * root-scope settings service exposed at `./settings`.
 */
export default defineConfig([
  entry('lib/types/index.js'),
  entry('lib/types/settings.js'),
])

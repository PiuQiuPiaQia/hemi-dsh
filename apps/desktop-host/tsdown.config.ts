import { defineConfig } from 'tsdown'

export default defineConfig(['index', 'cli'].map(name => ({
  entry: ['lib/types/' + name + '.js'],
  outDir: 'lib',
  format: ['esm'] as const,
  outputOptions: { codeSplitting: false },
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // Hemi fork: the startup adapter is build-only because the shipped Host closure excludes private workspace packages.
  deps: { alwaysBundle: ['@deepseek-ai/dsh-hemi-customizations/desktop-branding'] },
})))

import { defineConfig } from 'tsdown'

export default defineConfig([{ index: 'lib/types/index.js' }, { 'desktop-import': 'legacy/new-api/desktop-import.mjs' }].map(entry => ({
  entry,
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})))

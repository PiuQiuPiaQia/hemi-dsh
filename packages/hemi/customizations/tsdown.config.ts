import { defineConfig } from 'tsdown'

export default defineConfig(['index', 'preload'].map(entry => ({
  entry: [`lib/types/${entry}.js`],
  outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
  deps: { neverBundle: ['electron'] },
})))

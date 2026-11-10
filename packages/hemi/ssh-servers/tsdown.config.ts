import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/types.js', 'lib/types/workspaces.js', 'lib/types/workspace-types.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { askpass: 'lib/types/askpass.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    outputOptions: { codeSplitting: false },
    dts: false,
    clean: false,
  },
])

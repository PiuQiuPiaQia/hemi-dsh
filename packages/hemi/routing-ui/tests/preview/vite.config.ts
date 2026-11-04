/** Test-only component preview; no Harness profile or live Remote connection. */
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const project = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({
  root: import.meta.dirname,
  resolve: { tsconfigPaths: true },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [project] } },
  plugins: [{
    name: 'routing-preview-tokens',
    transformIndexHtml: () => [
      'base.css', 'design-platform.css', 'focus.css', 'corner-shape.css', 'scrollbar.css', 'gradient-shadow-text.css',
    ].map(file => ({
      tag: 'link', attrs: { rel: 'stylesheet', href: `/@fs/${resolve(project, 'packages/client/ui-theme/src/styles', file)}` }, injectTo: 'head' as const,
    })),
  }],
})

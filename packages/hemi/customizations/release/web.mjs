/** Build-time Web identity adapter; no browser or Electron runtime imports. */
import { readdir, copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { hemiDesktopArtwork } from './artwork.mjs'

/**
 * Replace install metadata and icons only for an explicitly named Hemi distribution.
 * @param {NodeJS.ProcessEnv} environment Public client build settings.
 * @returns {import('vite').Plugin} Vite adapter retaining native assets in other distributions.
 */
export function hemiWebBranding(environment = process.env) {
  const enabled = environment.DSH_CLIENT_TITLE === 'Hemi'
  let output = ''
  return {
    name: 'hemi-web-branding',
    configResolved(config) { output = resolve(config.root, config.build.outDir) },
    transformIndexHtml(html) {
      return enabled ? html.replace('name="apple-mobile-web-app-title" content="DSH"', 'name="apple-mobile-web-app-title" content="Hemi"') : html
    },
    async writeBundle() {
      if (!enabled) return
      for (const file of await readdir(hemiDesktopArtwork.web)) {
        await copyFile(resolve(hemiDesktopArtwork.web, file), resolve(output, file))
      }
    },
  }
}

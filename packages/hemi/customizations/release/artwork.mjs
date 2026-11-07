/** Native packaging paths for Hemi's monochrome wave-H artwork. */
import { fileURLToPath } from 'node:url'

/** Committed distribution resources; regenerate with render-artwork.mjs after editing the client SVG. */
export const hemiDesktopArtwork = Object.freeze({
  icon: fileURLToPath(new URL('../artwork/icon.png', import.meta.url)),
  mac: fileURLToPath(new URL('../artwork/icon-macos.png', import.meta.url)),
  windows: fileURLToPath(new URL('../artwork/icon-windows.png', import.meta.url)),
  tray: fileURLToPath(new URL('../artwork/tray-windows.ico', import.meta.url)),
  web: fileURLToPath(new URL('../artwork/web/', import.meta.url)),
})

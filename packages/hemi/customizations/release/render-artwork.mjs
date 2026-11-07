/** Regenerate Hemi distribution artwork from the client plugin's wave-H SVG. */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { packIco } from '../../../../apps/desktop/scripts/render-tray-icon.ts'

const require = createRequire(new URL('../../../../apps/desktop/package.json', import.meta.url))
const sharp = require('sharp')
const source = await readFile(new URL('../../../client/ui-hemi-skins/src/client/assets/hemi-mark.svg', import.meta.url), 'utf8')
const root = new URL('../artwork/', import.meta.url)
await mkdir(new URL('web/', root), { recursive: true })
const glyph = source.slice(source.indexOf('  <g'), source.indexOf('</svg>'))
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n${body}</svg>\n`
const tile = svg(`<rect x="48" y="48" width="928" height="928" rx="224" fill="black"/>\n${glyph.replace('fill="black"', 'fill="white"')}`)
const maskable = svg(`<rect width="1024" height="1024" fill="black"/>\n${glyph.replace('fill="black"', 'fill="white"')}`)
await writeFile(new URL('icon.svg', root), tile)
await writeFile(new URL('icon-inverse.svg', root), tile.replace('fill="black"', 'fill="#fff"').replace('fill="white"', 'fill="#000"'))
for (const file of ['icon.png', 'icon-macos.png', 'icon-windows.png']) {
  await sharp(Buffer.from(tile)).png().toFile(fileURLToPath(new URL(file, root)))
}
for (const [file, size, data] of [
  ['icon-192.png', 192, tile], ['icon-512.png', 512, tile],
  ['icon-maskable-512.png', 512, maskable], ['apple-touch-icon.png', 180, maskable],
]) await sharp(Buffer.from(data)).resize(size, size).png().toFile(fileURLToPath(new URL(`web/${file}`, root)))
const favicon = svg(`<g transform="translate(-384 -384) scale(1.75)">${glyph}</g>`)
await writeFile(new URL('web/favicon.svg', root), favicon)
await writeFile(new URL('web/favicon-dark.svg', root), favicon.replace('fill="black"', 'fill="white"'))
await writeFile(new URL('web/manifest.webmanifest', root), JSON.stringify({
  name: 'Hemi', short_name: 'Hemi', start_url: './', scope: './', display: 'standalone',
  background_color: '#ffffff', theme_color: '#ffffff', icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n')
const sizes = [16, 20, 24, 32, 40, 48, 64]
const images = await Promise.all(sizes.map(size => sharp(Buffer.from(tile)).resize(size).png().toBuffer()))
await writeFile(new URL('tray-windows.ico', root), packIco(images.map((png, index) => ({ size: sizes[index], png }))))

/**
 * Hemi skin backdrop: one fixed, click-through layer showing the ported
 * character artwork plus the skin's lettering, kept in step with the
 * selected skin. The layer sits behind the app content (`z-index: -1`);
 * `classic` carries no artwork and hides it.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HemiSkin } from './skins.ts'
import css from './Backdrop.module.css'
import artBlue from './assets/cafe-blue.webp'
import artPurple from './assets/cafe-purple.webp'
import artOrange from './assets/cafe-orange.webp'
import artGold from './assets/cafe-gold.webp'
import artRed from './assets/cafe-red.webp'

/** Ported artwork by Hemi skin id; classic has none. */
const ART: Record<string, string> = {
  'cafe-blue': artBlue,
  'cafe-purple': artPurple,
  'cafe-orange': artOrange,
  'cafe-gold': artGold,
  'cafe-red': artRed,
}

/**
 * Mount the backdrop layer under `document.body` and return its updater.
 * @param ctx - Owning plugin context (removes the layer on teardown).
 * @returns the skin update function.
 */
export function installBackdrop(ctx: Context): (skin: HemiSkin) => void {
  const layer = document.createElement('div')
  layer.className = css.layer ?? ''
  const lettering = document.createElement('div')
  lettering.className = css.lettering ?? ''
  const headline = document.createElement('span')
  headline.className = css.headline ?? ''
  const subline = document.createElement('span')
  subline.className = css.subline ?? ''
  lettering.append(headline, subline)
  layer.append(lettering)
  document.body.append(layer)
  ctx.effect(() => () => { layer.remove() }, 'ui-hemi-skins: backdrop layer')

  const update = (skin: HemiSkin): void => {
    const art = ART[skin.id]
    layer.style.backgroundImage = art === undefined ? 'none' : `url(${art})`
    const text = skin.lettering
    lettering.style.display = text === null || art === undefined ? 'none' : ''
    if (text !== null && art !== undefined) {
      headline.textContent = text.headline
      subline.textContent = text.subline
      lettering.style.color = text.color
    }
  }
  return update
}

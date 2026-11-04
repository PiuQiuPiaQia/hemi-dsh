/** Hemi character artwork behind the app; classic has no artwork. */
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
  layer.setAttribute('aria-hidden', 'true')
  const actor = document.createElement('img')
  actor.className = css.actor ?? ''
  actor.alt = ''
  layer.append(actor)
  document.body.append(layer)
  ctx.effect(() => () => { layer.remove() }, 'ui-hemi-skins: backdrop layer')

  const update = (skin: HemiSkin): void => {
    const art = ART[skin.id]
    layer.hidden = art === undefined
    if (art === undefined) actor.removeAttribute('src')
    else actor.src = art
  }
  return update
}

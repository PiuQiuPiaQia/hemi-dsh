/**
 * Hemi character skins, ported from the Hemi desktop assistant's
 * `skins.config.json` palette table. Each skin maps to one DSH
 * alias-token theme over the light base palette plus a durable
 * `overrideTokens` layer (per light/dark mode) so the skin applies
 * regardless of the built-in theme preference; the built-in settings
 * schema only accepts light/dark/system, so a registered third-party
 * preference would be reverted by the next settings adopt. Background
 * art, portraits, idle animation, and lettering arrive with the asset
 * pipeline port.
 */
import type { ThemeDefinition, ThemeTokenOverrides } from '@deepseek-ai/dsh-client-ui-theme/client'

/** Ported lettering text from skins.config.json. */
export interface HemiLettering {
  /** Large headline word (for example `Smile`). */
  headline: string
  /** Smaller subline word (for example `DeepSeek`). */
  subline: string
  /** Lettering ink color. */
  color: string
}

/** One ported Hemi skin: source id, display name, theme, and override layer. */
export interface HemiSkin {
  /** Hemi skin id from skins.config.json (for example `cafe-blue`). */
  id: string
  /** Chinese display name from skins.config.json. */
  name: string
  /** The registered (selectable) DSH theme definition. */
  definition: ThemeDefinition
  /** The durable token override layer applying this skin to the active theme. */
  overrides: ThemeTokenOverrides
  /** Lettering overlay; `classic` carries none. */
  lettering: HemiLettering | null
}

/** Positional skin inputs from the Hemi skins.config.json palette table. */
interface SkinInput {
  id: string
  name: string
  rail: string
  accent: string
  hover: string
  line: string
  deep: string
  deepLine: string
  lettering: HemiLettering | null
}

function skin(input: SkinInput): HemiSkin {
  const { id, name, rail, accent, hover, line, deep, deepLine, lettering } = input
  // Panels paint bg-base opaquely; keep a translucent mix so the backdrop
  // artwork shows through the surfaces (Hemi's panel-over-art look).
  const railAlpha = `color-mix(in srgb, ${rail} 66%, transparent)`
  const deepAlpha = `color-mix(in srgb, ${deep} 84%, transparent)`
  // Token rows as tuples so each alias has explicit light/dark values
  // without non-null assertions.
  const tokens: readonly (readonly [name: string, light: string, dark: string])[] = [
    ['--dsw-alias-brand-primary', accent, accent],
    ['--dsw-alias-brand-text', accent, accent],
    ['--dsw-alias-button-primary-fill', accent, accent],
    ['--dsw-alias-button-primary-hover', hover, hover],
    ['--dsw-alias-bg-base', railAlpha, deepAlpha],
    ['--dsw-alias-border-l', line, deepLine],
    ['--dsw-focus-ring-color', accent, accent],
  ]
  const definition: ThemeDefinition = {
    id: `hemi-${id}`,
    colorScheme: 'light',
    tokens: Object.fromEntries(tokens.map(([token, light]) => [token, light])),
  }
  const overrides: ThemeTokenOverrides = Object.fromEntries(
    tokens.map(([token, light, dark]) => [token, { light, dark }]),
  )
  return { id, name, lettering, definition, overrides }
}

const CAFE_BLUE = skin({
  id: 'cafe-blue', name: '晴海蓝', rail: '#edf2fb', accent: '#385f9f', hover: '#587fc1', line: '#dce4f0',
  deep: '#10141f', deepLine: '#253f70', lettering: { headline: 'Smile', subline: 'DeepSeek', color: '#7893b6' },
})

/** All ported Hemi skins in config order (classic first, then the five character skins). */
export const HEMI_SKINS: readonly HemiSkin[] = [
  skin({ id: 'classic', name: '经典', rail: '#f6f6f5', accent: '#566e5d', hover: '#74907b', line: '#e9e9e7', deep: '#1b211d', deepLine: '#2c362f', lettering: null }),
  CAFE_BLUE,
  skin({ id: 'cafe-purple', name: '月见紫', rail: '#f4effa', accent: '#70509c', hover: '#8965b0', line: '#e4dceb', deep: '#161021', deepLine: '#2e2350', lettering: { headline: 'Sister', subline: 'GPT', color: '#a08ab9' } }),
  skin({ id: 'cafe-orange', name: '焦糖橙', rail: '#f8efe7', accent: '#a6502e', hover: '#b76841', line: '#e8dbce', deep: '#1d1410', deepLine: '#4a2a18', lettering: { headline: 'Suspended', subline: 'Claude', color: '#b78b6d' } }),
  skin({ id: 'cafe-gold', name: '蜜糖金', rail: '#faf4e5', accent: '#876318', hover: '#9c7e30', line: '#e8dfc9', deep: '#1a160c', deepLine: '#3d3014', lettering: { headline: 'Sweet', subline: 'Grok', color: '#b59d6f' } }),
  skin({ id: 'cafe-red', name: '围巾红', rail: '#f9efed', accent: '#a63034', hover: '#bb565a', line: '#eadbd8', deep: '#1c1010', deepLine: '#4a1d1f', lettering: { headline: 'Stupid', subline: 'Doubao', color: '#b58583' } }),
]

/** Skin applied through the durable override layer until a skin picker row ships (v1 default). */
export const HEMI_DEFAULT_SKIN: HemiSkin = CAFE_BLUE

/** Id of {@linkcode HEMI_DEFAULT_SKIN}. */
export const HEMI_DEFAULT_SKIN_ID: string = HEMI_DEFAULT_SKIN.id

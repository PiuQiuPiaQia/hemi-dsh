/**
 * Hemi skin picker row registered into the settings General section item
 * slot: title + one color-dotted cube per ported skin. Selection re-stacks
 * the package's `overrideTokens` layer, so the change applies immediately
 * and survives theme preference switches.
 */
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createSkinRowStore } from './skin-store.ts'
import { HEMI_SKINS } from './skins.ts'
import css from './SkinRow.module.css'

/** Injected business face: the skin write. */
export interface SkinRowInjected {
  /** Switch the active Hemi skin. */
  setSkin: (id: string) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type SkinRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createSkinRowStore>>
  & PropsLocale<'hemi-skins'> & SkinRowInjected

/**
 * Render the Hemi skin row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function SkinRow({ t, setSkin, useStore }: SkinRowComponentProps) {
  const skinId = useStore(s => s.skinId)
  return (
    <div className={css.group}>
      <div className={css.title}>{t('skin.title')}</div>
      <div className={css.cubeRow}>
        {HEMI_SKINS.map(skin => (
          <button
            key={skin.id}
            type="button"
            className={clsx(css.skinCube, skinId === skin.id && css.selected)}
            aria-pressed={skinId === skin.id}
            onClick={() => { setSkin(skin.id) }}
          >
            <span className={css.dot} style={{ background: skin.definition.tokens['--dsw-alias-brand-primary'] }} />
            {skin.name}
          </button>
        ))}
      </div>
    </div>
  )
}

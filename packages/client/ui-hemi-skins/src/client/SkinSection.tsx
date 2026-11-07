/** Skin settings with immediately applied, browser-persisted presets. */
import { useState } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCheckOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { HEMI_SKINS, HEMI_DEFAULT_SKIN } from './skins.ts'
import css from './SkinSection.module.css'

/** Injected business face: the skin write. */
export interface SkinSectionInjected {
  /** Switch the active Hemi skin. */
  setSkin: (id: string) => void
}

/** Full component props: runtime share + locale seat + injected face. */
export type SkinSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'hemi-skins'>
  & InjectFace<SkinSectionInjected>

/**
 * Render the skin section and its selectable presets.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function SkinSection(props: SkinSectionProps) {
  const { t, setSkin } = props
  const [selected, setSelected] = useState<string>(() => {
    const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem('hemi-skin')
    return HEMI_SKINS.find(skin => skin.id === stored)?.id ?? HEMI_DEFAULT_SKIN.id
  })
  return (
    <section className={css.section} aria-label={t('skin.title')}>
      <h2 className={css.title}>{t('skin.title')}</h2>
      <div className={css.presets}>
        {HEMI_SKINS.map(skin => (
          <button
            key={skin.id}
            type="button"
            className={clsx(css.preset, selected === skin.id && css.selected)}
            aria-pressed={selected === skin.id}
            onClick={() => {
              setSelected(skin.id)
              setSkin(skin.id)
            }}
          >
            <span className={css.dot} style={{ background: skin.definition.tokens['--dsw-alias-brand-primary'] }} />
            <span className={css.label}>{skin.name}</span>
            <span className={css.check} aria-hidden="true">
              {selected === skin.id && <IconCheckOutlineRegular size={16} />}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * Hemi skin picker settings section: one card holding the preset skin
 * choices, persisted per browser and applied through the durable override
 * layer. Layout follows the settings-section conventions (the shell owns the
 * panel padding and the close control).
 */
import { useState } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { HEMI_SKINS } from './skins.ts'
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
 * Render the skin section: one card with the preset skin choices.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function SkinSection(props: SkinSectionProps) {
  const { t, setSkin } = props
  const [selected, setSelected] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem('hemi-skin') ?? ''
  })
  return (
    <section className={css.section} aria-label={t('skin.title')}>
      <div className={css.card}>
        <span className={css.title}>{t('skin.title')}</span>
        <span className={css.description}>{t('skin.description')}</span>
        <div className={css.cubeRow}>
          {HEMI_SKINS.map(skin => (
            <button
              key={skin.id}
              type="button"
              className={clsx(css.skinCube, selected === skin.id && css.selected)}
              aria-pressed={selected === skin.id}
              onClick={() => {
                setSelected(skin.id)
                setSkin(skin.id)
              }}
            >
              <span className={css.dot} style={{ background: skin.definition.tokens['--dsw-alias-brand-primary'] }} />
              <span className={css.cubeLabel}>{skin.name}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

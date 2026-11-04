/**
 * Hemi skin picker settings section: one card selecting the preset role
 * skin, persisted per browser and applied through the durable override
 * layer.
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

/** Full component props: runtime share + locale seat + injected face + shell close. */
export type SkinSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'hemi-skins'>
  & InjectFace<SkinSectionInjected>
  & { close?: () => void }

/**
 * Render the skin section: title, description, and one cube per skin.
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
    <div className={css.section}>
      <div className={css.header}>
        <span className={css.title}>{t('skin.title')}</span>
        {props.close !== undefined ? <button type="button" aria-label="close" onClick={props.close} className={css.close}>✕</button> : null}
      </div>
      <p className={css.description}>{t('skin.description')}</p>
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
            {skin.name}
          </button>
        ))}
      </div>
    </div>
  )
}

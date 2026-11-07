/** Locale-owned name for the Hemi distribution's existing sidebar brand seat. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './HemiBrandName.module.css'

/** @param props Locale share supplied by the slot registry. @returns Hemi product name. */
export function HemiBrandName({ t }: PropsLocale<'hemi-skins'>) {
  return <span className={css.name} data-hemi-sidebar-name>{t('brand.name')}
    <Tag tone="solid" className={css.edition}>{t('brand.edition')}</Tag>
  </span>
}

/** @returns a hidden slot occupant suppressing the native sidebar logo fallback. */
export function HemiSidebarMark() {
  return <span className={css.noMark} aria-hidden="true" />
}

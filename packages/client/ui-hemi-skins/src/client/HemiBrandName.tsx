/** Locale-owned name for the Hemi distribution's existing sidebar brand seat. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** @param props Locale share supplied by the slot registry. @returns Hemi product name. */
export function HemiBrandName({ t }: PropsLocale<'hemi-skins'>) {
  return <span>{t('brand.name')}</span>
}

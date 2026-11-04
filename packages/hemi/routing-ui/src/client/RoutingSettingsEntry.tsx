/** Lightweight Models-page entry into the same routing configuration editor. */
import { Button, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { NS } from './locales.ts'
import css from './RoutingSection.module.css'

/** Shared editor launcher. */
export interface RoutingSettingsEntryInjected { openConfiguration: () => void }

/** Derived Models footer props. */
export type RoutingSettingsEntryProps = PropsRuntime<'settings.models.footer'> & PropsLocale<typeof NS> & InjectFace<RoutingSettingsEntryInjected>

/**
 * Leave page padding, navigation and closing to the settings shell.
 * @param props - Localized copy and the shared editor launcher.
 * @returns a compact settings card with a discoverable configuration entry.
 */
export function RoutingSettingsEntry({ openConfiguration, t }: RoutingSettingsEntryProps) {
  return (
    <section className={css.entry} aria-label={t('title')}>
      <div className={css.entryCopy}><h3 className={css.entryTitle}>{t('title')}</h3><p className={css.help}>{t('footerDescription')}</p></div>
      <Button variant="outline" size="sm" onClick={openConfiguration} icon={<IconSettingsOutlineRegular size={14} aria-hidden="true" />}>{t('configure')}</Button>
    </section>
  )
}

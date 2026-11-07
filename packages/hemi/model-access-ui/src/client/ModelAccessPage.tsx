/** Model connection methods within the shared settings shell. */
import { useCallback, useId, useState } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { NewApiDesktopBridge } from '@deepseek-ai/dsh-hemi-model-access/desktop-import'
import { BrowserImportSection } from './BrowserImportSection.tsx'
import { KeyProfiles } from './KeyProfiles.tsx'
import { NewApiSection } from './NewApiSection.tsx'
import { SubscriptionSection } from './SubscriptionSection.tsx'
import type { NS } from './copy.ts'
import type { ModelAccessActions, ModelTest } from './types.ts'
import css from './page.module.css'

const methods = ['subscriptionsMethod', 'keyMethod'] as const

type Props = InjectFace<{ actions: ModelAccessActions }> & PropsLocale<typeof NS>
  & PropsRenderFactories & { test: ModelTest }

/**
 * Render connection methods with the standard settings switcher.
 * @param props - Localized copy, connection actions, model test and factory renderer.
 * @returns the connection methods and their keyboard-accessible tabs.
 */
export function ModelAccessPage({ actions, test, t, renderFactorySlot }: Props) {
  const methodsId = useId()
  const [method, setMethod] = useState<typeof methods[number]>('subscriptionsMethod')
  const [newApiOpen, setNewApiOpen] = useState(false)
  const [importRevision, setImportRevision] = useState(0)
  const imported = useCallback(() => { setImportRevision(value => value + 1) }, [])
  const desktop = (globalThis as { dshDesktop?: { newApiImport?: NewApiDesktopBridge } }).dshDesktop?.newApiImport
  return (
    <section className={css.page}>
      <h2>{t('title')}</h2>
      <SegmentedControl id={methodsId} value={method} label={t('nav')} className={css.methods}
        options={methods.map(value => ({ value, label: t(value) }))} onChange={setMethod} />
      <div id={`${methodsId}-subscriptionsMethod-panel`} role="tabpanel" aria-labelledby={`${methodsId}-subscriptionsMethod`}
        hidden={method !== 'subscriptionsMethod'}>
        <SubscriptionSection actions={actions} test={test} t={t} renderFactorySlot={renderFactorySlot} />
      </div>
      <div id={`${methodsId}-keyMethod-panel`} role="tabpanel" aria-labelledby={`${methodsId}-keyMethod`} hidden={method !== 'keyMethod'}>
        {method === 'keyMethod' && <KeyProfiles actions={actions} test={test} t={t} importRevision={importRevision}
          openNewApi={() => { setNewApiOpen(true) }} />}
        {desktop === undefined
          ? <NewApiSection actions={actions} t={t} open={newApiOpen} onClose={() => { setNewApiOpen(false) }} onImported={imported} />
          : <BrowserImportSection bridge={desktop} t={t} open={newApiOpen}
            onClose={() => { setNewApiOpen(false) }} onImported={imported} />}
      </div>
    </section>
  )
}

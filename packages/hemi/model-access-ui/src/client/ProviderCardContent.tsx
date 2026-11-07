/** Shared provider header and model rows; callers own account and credential operations. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { ModelConnectionTest } from './ModelConnectionTest.tsx'
import { ProviderUsage, type ProviderUsageProps } from './ProviderUsage.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & {
  provider: string
  name: string
  description: string
  detail?: string
  models: string[]
  actions: ModelAccessActions
  test: ModelTest
  saved: () => Promise<void>
  remove: (model: string) => Promise<void>
  buttons: { id: string; label: string; disabled: boolean; run: () => void }[]
  discovery?: {
    disabled: boolean
    load: (signal: AbortSignal) => Promise<string[]>
    add: (models: string[]) => Promise<void>
  }
  usage?: ProviderUsageProps
  modelLoading?: boolean
}

/**
 * Render the shared contents of a provider card without owning its connection lifecycle.
 * @param props - Provider identity, usage, header operations and model callbacks.
 * @returns the subscription-style header and compact model rows.
 */
export function ProviderCardContent({ provider, name, description, detail, models, actions, test, saved, remove,
  buttons, discovery, usage, modelLoading, t }: Props) {
  return <>
    <div className={css.providerHeader}>
      <div className={css.providerIdentity}>
        <div className={css.providerDescription}><strong>{name}</strong><p>{description}</p>{detail && <small>{detail}</small>}</div>
        {usage !== undefined && <ProviderUsage {...usage} />}
      </div>
      <div className={css.actions}>
        {discovery !== undefined && <ModelPicker current={models} t={t} iconOnly disabled={discovery.disabled}
          load={discovery.load} add={discovery.add} />}
        {buttons.map(button => <Button key={button.id} variant="outline" size="sm" disabled={button.disabled}
          onClick={button.run}>{button.label}</Button>)}
      </div>
    </div>
    {models.map(model => <ModelConnectionTest key={model} provider={provider} model={model}
      test={test} t={t} actions={actions} saved={saved} remove={() => remove(model)} />)}
    {modelLoading && <p role="status">{t('loading')}</p>}
  </>
}

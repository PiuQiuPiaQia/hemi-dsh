import { useEffect, useRef, useState } from 'react'
import { Button, IconLoadingOutlineRegular, IconPlayOutlineRegular, IconTrashOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelAccessActions, ModelTest } from './types.ts'
import { SavedModelOptions } from './ModelOptionsEditor.tsx'
import type { NS } from './copy.ts'
import css from './page.module.css'

/**
 * Run the saved route with row-local cancellation and app-wide failure feedback.
 * @param props - Saved route, connection operations and localized copy.
 * @returns the model row with its test result and actions.
 */
export function ModelConnectionTest({ provider, model, test, remove, actions, saved, t }: PropsLocale<typeof NS> & {
  provider: string
  model: string
  test: ModelTest
  remove?: () => Promise<void>
  actions: ModelAccessActions
  saved?: () => Promise<void>
}) {
  const [status, setStatus] = useState<'testingModel' | 'modelToolOk' | 'modelResponseOk' | null>(null)
  const testing = status === 'testingModel'
  const [removing, setRemoving] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => { active.current?.abort() }, [])
  async function run(): Promise<void> {
    if (active.current !== null) return
    const request = new AbortController()
    active.current = request
    setStatus('testingModel')
    try {
      const toolCall = await test(provider, model, request.signal)
      if (!request.signal.aborted) setStatus(toolCall ? 'modelToolOk' : 'modelResponseOk')
    } catch (_error: unknown) {
      if (!request.signal.aborted) {
        setStatus(null)
        actions.reportModelFailure({ operation: 'test', model })
      }
    } finally {
      if (active.current === request) active.current = null
    }
  }
  return (
    <div className={css.modelTestRow} role="group" aria-label={model}>
      <span className={css.modelName}>{model}</span>
      <div className={css.actions}>
        <SavedModelOptions provider={provider} model={model} actions={actions} t={t}
          disabled={testing || removing} {...saved === undefined ? {} : { saved }} />
        {status !== null && status !== 'testingModel' && <small role="status">{t(status)}</small>}
        <Tooltip label={t(testing ? 'testingModel' : 'testModel')} side="top" portal>
          <Button variant="ghost" size="sm" className={css.modelIconButton}
            aria-label={t(testing ? 'testingModel' : 'testModel')} aria-busy={testing}
            icon={testing ? <IconLoadingOutlineRegular size={16} className={css.modelTestSpinner} /> : <IconPlayOutlineRegular size={16} />}
            disabled={testing || removing} onClick={() => { void run() }} />
        </Tooltip>
        {remove !== undefined && <Tooltip label={t('deleteModel')} side="top" portal>
          <Button variant="ghost" size="sm" className={`${css.modelIconButton} ${css.dangerAction}`}
            aria-label={t('deleteModel')} icon={<IconTrashOutlineRegular size={16} />}
            disabled={testing || removing} onClick={() => {
              if (!window.confirm(t('confirmDeleteModel', { model }))) return
              setRemoving(true)
              void remove().catch((_error: unknown) => { actions.reportModelFailure({ operation: 'remove', model }) })
                .finally(() => { setRemoving(false) })
            }} />
        </Tooltip>}
      </div>
    </div>
  )
}

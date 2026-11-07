/** Explicit per-model capability editing for drafts and saved connections. */
import { useState } from 'react'
import { Button, IconSettingsOutlineRegular, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelOptions, ModelOptionsView } from '@deepseek-ai/dsh-hemi-model-access/types'
import type { ModelAccessActions } from './types.ts'
import type { NS } from './copy.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS>

/**
 * Edit the four model fields supported by the connection page.
 * @param props - Explicit overrides, effective values, save callback and localized copy.
 * @returns an isolated draft dialog; cancellation performs no write.
 */
export function ModelOptionsEditor({ model, options, effective, save, close, t }: Props & {
  model: string
  options: ModelOptions
  effective: ModelOptions
  save: (options: ModelOptions) => Promise<void>
  close: () => void
}) {
  const initial = { ...effective, ...options }
  const [name, setName] = useState(initial.name ?? model)
  const [context, setContext] = useState(initial.contextWindow?.toString() ?? '')
  const [output, setOutput] = useState(initial.maxTokens?.toString() ?? '')
  const [input, setInput] = useState<readonly ('text' | 'image')[]>(initial.input ?? ['text'])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const capacity = (value: string): number | undefined => value.trim() === '' ? undefined : Number(value)
  const contextWindow = capacity(context)
  const maxTokens = capacity(output)
  const invalidCapacity = [contextWindow, maxTokens].some(value => value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
  const invalidInput = input.length === 0
  const next: ModelOptions = { ...options }
  if (name !== (initial.name ?? model)) {
    delete next.name
    if (name.trim() !== '') next.name = name.trim()
  }
  if (context !== (initial.contextWindow?.toString() ?? '')) {
    delete next.contextWindow
    if (contextWindow !== undefined) next.contextWindow = contextWindow
  }
  if (output !== (initial.maxTokens?.toString() ?? '')) {
    delete next.maxTokens
    if (maxTokens !== undefined) next.maxTokens = maxTokens
  }
  const initialInput = initial.input ?? ['text']
  if (input.length !== initialInput.length || input.some(type => !initialInput.includes(type))) next.input = input
  return (
    <Modal open title={t('modelSettings')} closeLabel={t('close')} onClose={() => { if (!busy) close() }}
      description={model} className={css.modelDialog ?? ''} contentClassName={`${css.dialogContent} scrollable`}
      footer={<div className={css.actions}>
        <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || invalidCapacity || invalidInput} onClick={() => {
          setBusy(true); setFailed(false)
          void save(next).then(close, () => { setFailed(true) }).finally(() => { setBusy(false) })
        }}>{t(busy ? 'loading' : 'saveModel')}</Button>
      </div>}>
      <div className={css.dialogForm}>
        <label>{t('modelDisplayName')}<Input className={css.input ?? ''} value={name} disabled={busy} placeholder={model}
          onChange={(event) => { setName(event.currentTarget.value) }} /></label>
        <div className={css.capacityFields}>
          <label>{t('contextWindow')}<Input className={css.input ?? ''} inputMode="numeric" value={context} disabled={busy}
            aria-invalid={contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0)}
            onChange={(event) => { setContext(event.currentTarget.value) }} /></label>
          <label>{t('maxTokens')}<Input className={css.input ?? ''} inputMode="numeric" value={output} disabled={busy}
            aria-invalid={maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)}
            onChange={(event) => { setOutput(event.currentTarget.value) }} /></label>
        </div>
        {invalidCapacity && <p role="alert">{t('invalidCapacity')}</p>}
        <fieldset className={css.inputTypes} disabled={busy}>
          <legend>{t('inputTypes')}</legend>
          {(['text', 'image'] as const).map(type => <label className={css.modelChoice} key={type}>
            <input type="checkbox" checked={input.includes(type)} onChange={(event) => {
              setInput(event.currentTarget.checked ? [...input, type] : input.filter(item => item !== type))
            }} />{t(type === 'text' ? 'textInput' : 'imageInput')}
          </label>)}
          {invalidInput && <p role="alert">{t('inputRequired')}</p>}
        </fieldset>
        {failed && <p role="alert">{t('modelSaveFailed')}</p>}
      </div>
    </Modal>
  )
}

/**
 * Load saved model settings on demand and retain the observed revision until save.
 * @param props - Saved model identity, owner actions and localized copy.
 * @returns a settings button and its model editor.
 */
export function SavedModelOptions({ provider, model, actions, t, disabled, saved }: Props & {
  provider: string
  model: string
  actions: ModelAccessActions
  disabled: boolean
  saved?: () => Promise<void>
}) {
  const [view, setView] = useState<ModelOptionsView | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  return <>
    <Tooltip label={t('modelSettings')} side="top" portal>
      <Button variant="ghost" size="sm" className={css.modelIconButton} aria-label={t('modelSettings')}
        icon={<IconSettingsOutlineRegular size={16} />} disabled={disabled || loading} aria-busy={loading} onClick={() => {
          setLoading(true); setFailed(false)
          void actions.getModelOptions(provider, model).then(setView, () => { setFailed(true) }).finally(() => { setLoading(false) })
        }} />
    </Tooltip>
    {failed && <small role="alert">{t('failed')}</small>}
    {view !== null && <ModelOptionsEditor model={model} options={view.options} effective={view.effective} t={t}
      close={() => { setView(null) }}
      save={async (options) => {
        await actions.saveModelOptions(provider, model, options, view.revision)
        try { await saved?.() } catch { setFailed(true) }
      }} />}
  </>
}

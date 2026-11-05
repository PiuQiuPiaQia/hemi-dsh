import { useEffect, useState } from 'react'
import { Button, IconSettingsOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { KeyDirectory, KeyProfile, KeyProfileInput, ModelOptions } from '@deepseek-ai/dsh-hemi-model-access/types'
import { ModelPicker } from './ModelPicker.tsx'
import { ModelConnectionTest } from './ModelConnectionTest.tsx'
import { ModelOptionsEditor } from './ModelOptionsEditor.tsx'
import type { ModelAccessActions, ModelTest } from './types.ts'
import type { NS } from './copy.ts'
import css from './page.module.css'

type Props = PropsLocale<typeof NS> & { actions: ModelAccessActions; test: ModelTest }

const PRESETS = [
  ['deepseek', 'DeepSeek', 'https://api.deepseek.com/v1'],
  ['qwen', '通义千问', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['kimi', 'Kimi', 'https://api.moonshot.cn/v1'],
  ['zhipu', '智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4'],
  ['openai', 'OpenAI', 'https://api.openai.com/v1'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
  ['ollama', 'Ollama', 'http://127.0.0.1:11434/v1'],
]

/** Existing connections and an explicit editor; provider presets never inject model IDs. */
export function KeyProfiles({ actions, test, t }: Props) {
  const [directory, setDirectory] = useState<KeyDirectory | null>(null)
  const [editing, setEditing] = useState<KeyProfile | 'new' | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  async function refresh(): Promise<void> {
    setDirectory(await actions.keyDirectory())
    setFailed(false)
  }
  useEffect(() => {
    let alive = true
    void actions.keyDirectory().then((value) => { if (alive) setDirectory(value) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [actions])
  if (editing !== null && directory !== null) return (
    <KeyEditor key={typeof editing === 'string' ? editing : editing.id} actions={actions} test={test} t={t}
      revision={directory.revision} profile={editing === 'new' ? undefined : editing}
      close={() => { setEditing(null) }} saved={async () => { await refresh(); setEditing(null) }} />
  )
  return (
    <section className={css.section} aria-label={t('apiConnections')}>
      <div className={css.row}>
        <h3>{t('apiConnections')}</h3>
        <Button variant="outline" size="sm" disabled={directory === null} onClick={() => { setEditing('new') }}>{t('addKey')}</Button>
      </div>
      {directory === null && !failed && <p>{t('loading')}</p>}
      {directory?.profiles.length === 0 && <p>{t('noConnections')}</p>}
      {directory?.profiles.map(profile => (
        <section className={css.providerGroup} aria-label={profile.name} key={profile.id}>
          <div className={css.providerRow}>
            <div><strong>{profile.name}</strong><p>{profile.baseUrl}</p><small>{t('modelCount', { count: profile.models.length })}</small></div>
            <div className={css.actions}>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { setEditing(profile) }}>{t('editConnection')}</Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => {
                if (!window.confirm(t('confirmRemove'))) return
                setBusy(true)
                void actions.removeKeyProfile(profile.id, directory.revision).then(refresh, () => { setFailed(true) })
                  .finally(() => { setBusy(false) })
              }}>{t('removeConnection')}</Button>
            </div>
          </div>
          {profile.models.map(model => <ModelConnectionTest key={model} provider={profile.id} model={model}
            test={test} t={t} actions={actions} saved={refresh}
            remove={async () => {
              await actions.saveKeyProfile({ ...profile, revision: directory.revision, models: profile.models.filter(id => id !== model) })
              await refresh()
            }} />)}
          <ModelPicker current={profile.models} t={t}
            load={signal => actions.discoverKeyModels({ ...profile, revision: directory.revision }, signal)}
            add={async (models) => {
              await actions.saveKeyProfile({
                ...profile, revision: directory.revision, models: [...new Set([...profile.models, ...models])],
              })
              await refresh()
            }} />
        </section>
      ))}
      {failed && <p role="alert">{t('failed')} <button type="button" onClick={() => { void refresh().catch(() => { setFailed(true) }) }}>{t('retryImport')}</button></p>}
    </section>
  )
}

function KeyEditor({ actions, t, revision, profile, close, saved }: Props & {
  revision: number
  profile: KeyProfile | undefined
  close: () => void
  saved: () => Promise<void>
}) {
  const [name, setName] = useState(profile?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '')
  const [api, setApi] = useState(profile?.api ?? 'openai-completions')
  const [key, setKey] = useState('')
  const [models, setModels] = useState(profile?.models ?? [])
  const [modelOptions, setModelOptions] = useState<Record<string, ModelOptions>>(profile?.modelOptions ?? {})
  const [editingModel, setEditingModel] = useState<{ model: string; effective: ModelOptions } | null>(null)
  const [candidates, setCandidates] = useState(profile?.models ?? [])
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input: KeyProfileInput = {
    ...profile === undefined ? {} : { id: profile.id },
    revision, name, baseUrl, api, models, modelOptions, ...key === '' ? {} : { apiKey: key },
  }
  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    try { await action() } catch { setError(t('keyFailed')) } finally { setBusy(false) }
  }
  return (
    <section className={css.section} aria-label={t('keyEditor')}>
      <div className={css.row}><h3>{t(profile ? 'editConnection' : 'addKey')}</h3>
        <Button variant="outline" size="sm" disabled={busy} onClick={close}>{t('back')}</Button></div>
      <form className={css.card} onSubmit={(event) => {
        event.preventDefault()
        void run(async () => { await actions.saveKeyProfile(input); setKey(''); await saved() })
      }}>
        {profile === undefined && <label>{t('providerPreset')}
          <select aria-label={t('providerPreset')} defaultValue="" disabled={busy} onChange={(event) => {
            const preset = PRESETS.find(item => item[0] === event.currentTarget.value)
            setName(preset?.[1] ?? '')
            setBaseUrl(preset?.[2] ?? '')
            setKey(preset?.[0] === 'ollama' ? 'ollama' : '')
            setCandidates([])
            setModels([])
            setModelOptions({})
          }}>
            <option value="">{t('customProvider')}</option>
            {PRESETS.map(preset => <option value={preset[0]} key={preset[0]}>{preset[1]}</option>)}
          </select>
        </label>}
        <label>{t('providerName')}<input required maxLength={128} value={name} disabled={busy}
          onChange={(event) => { setName(event.currentTarget.value) }} /></label>
        <label>{t('apiEndpoint')}<input required type="url" value={baseUrl} disabled={busy}
          onChange={(event) => { setBaseUrl(event.currentTarget.value) }} /></label>
        <label>{t('protocol')}<select aria-label={t('protocol')} value={api} disabled={busy} onChange={(event) => { setApi(event.currentTarget.value) }}>
          <option value="openai-completions">{t('protocolCompletions')}</option>
          <option value="openai-responses">{t('protocolResponses')}</option>
          <option value="anthropic-messages">{t('protocolMessages')}</option>
        </select></label>
        <label>{t('apiKey')}<input type="password" autoComplete="off" value={key} disabled={busy}
          placeholder={profile?.hasKey ? t('savedKey') : undefined} onChange={(event) => { setKey(event.currentTarget.value) }} /></label>
        <ModelPicker current={models} buttonText={t('readModels')} disabled={busy || baseUrl === ''} t={t}
          load={signal => actions.discoverKeyModels(input, signal)} add={(found) => {
            setCandidates([...new Set([...candidates, ...found])]); setModels([...new Set([...models, ...found])])
            return Promise.resolve()
          }} />
        <div className={css.candidates} aria-label={t('selectModels')}>
          {candidates.map(model => <div className={css.row} role="group" aria-label={model} key={model}><label className={css.modelChoice}>
            <input type="checkbox" checked={models.includes(model)} disabled={busy}
              onChange={(event) => { setModels(event.currentTarget.checked ? [...models, model] : models.filter(id => id !== model)) }} />
            {model}
          </label><Tooltip label={t('modelSettings')} side="top" portal>
            <Button variant="ghost" size="sm" className={css.modelIconButton} aria-label={t('modelSettings')}
              icon={<IconSettingsOutlineRegular size={16} />} disabled={busy || !models.includes(model)}
              onClick={() => { void run(async () => {
                const effective = await actions.getModelDefaults(api, model, profile?.id)
                setEditingModel({ model, effective })
              }) }} />
          </Tooltip></div>)}
        </div>
        <label>{t('manualModel')}<input value={manual} disabled={busy} onChange={(event) => { setManual(event.currentTarget.value) }} /></label>
        <Button variant="outline" size="sm" type="button" disabled={busy || manual.trim() === ''} onClick={() => {
          const id = manual.trim()
          setCandidates([...new Set([...candidates, id])]); setModels([...new Set([...models, id])]); setManual('')
        }}>{t('addModel')}</Button>
        {error && <p role="alert">{error}</p>}
        <Button variant="outline" size="sm" type="submit" disabled={busy || models.length === 0}>{t(busy ? 'loading' : 'saveConnection')}</Button>
      </form>
      {editingModel !== null && <ModelOptionsEditor model={editingModel.model} options={modelOptions[editingModel.model] ?? {}}
        effective={editingModel.effective} t={t}
        close={() => { setEditingModel(null) }} save={(options) => {
          setModelOptions({ ...modelOptions, [editingModel.model]: options })
          return Promise.resolve()
        }} />}
    </section>
  )
}

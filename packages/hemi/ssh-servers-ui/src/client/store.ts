/** One transient root-scoped editor shared by the menu, list and shell overlay. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SshServer } from '@deepseek-ai/dsh-hemi-ssh-servers/types'
import type { EditorRequest, EditorState, Notice, Problem, ServerDraft } from './types.ts'
import { serverDraft } from './draft.ts'

type EditorActions = {
  open: (draft: EditorState, request: EditorRequest) => void
  close: (draft: EditorState) => void
  setField: (draft: EditorState, field: keyof ServerDraft, value: string) => void
  validateFields: (draft: EditorState) => void
  begin: (draft: EditorState) => void
  fail: (draft: EditorState, problem: Problem, field: keyof ServerDraft | null) => void
  complete: (draft: EditorState, notice: Notice) => void
  dismissNotice: (draft: EditorState, seq: number) => void
  folderFail: (draft: EditorState, problem: Problem) => void
  inform: (draft: EditorState, notice: Notice) => void
  rememberDirectory: (draft: EditorState, endpoint: string, path: string) => void
}

/**
 * Replace the transient operation notice.
 * @param state - Mutable editor state.
 * @param key - Localized feedback key.
 */
function notify(state: EditorState, key: Notice): void {
  state.sequence += 1
  state.notice = { key, seq: state.sequence }
}

/**
 * Create the shared interaction-store declaration.
 * @returns Store handle, instantiated only by registered entries or isolated tests.
 */
export function createEditorStore(): EngineStoreHandle<EditorState, EditorActions> {
  return defineStore({
    init: (): EditorState => ({
      request: null, draft: serverDraft(), busy: false, validate: false, problem: null,
      invalidField: null, notice: null, sequence: 0, directoryHistory: {},
    }),
    actions: {
      open: (d, request) => {
        if (d.busy) return
        const server: SshServer | undefined = request.kind === 'create' ? undefined : request.server
        d.request = request
        d.draft = serverDraft(server)
        d.problem = null
        d.invalidField = null
        d.validate = false
      },
      close: (d) => {
        if (d.busy && d.request?.kind !== 'folder') return
        d.request = null; d.problem = null; d.busy = false
      },
      setField: (d, field, value) => {
        if (d.busy) return
        d.draft[field] = value
        if (d.problem === 'invalid') d.problem = null
        if (d.invalidField === field) d.invalidField = null
      },
      validateFields: (d) => { d.validate = true },
      begin: (d) => { d.busy = true; d.problem = null; d.invalidField = null },
      fail: (d, problem, field) => {
        d.busy = false
        d.problem = problem
        d.invalidField = field
        d.validate = true
        notify(d, problem)
      },
      complete: (d, notice) => {
        d.busy = false
        d.request = null
        d.problem = null
        notify(d, notice)
      },
      dismissNotice: (d, seq) => { if (d.notice?.seq === seq) d.notice = null },
      folderFail: (d, problem) => { d.busy = false; d.problem = problem },
      inform: (d, notice) => { notify(d, notice) },
      rememberDirectory: (d, endpoint, path) => {
        const paths = d.directoryHistory[endpoint]
        if (paths?.[0] === path) return
        d.directoryHistory = { ...d.directoryHistory, [endpoint]: [path, ...(paths ?? []).filter(value => value !== path)].slice(0, 3) }
      },
    },
  })
}

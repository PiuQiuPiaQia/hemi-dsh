/** Model-row failure feedback hosted by the shell, independently of the connection page. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './copy.ts'
import type { ModelActionFailure } from './types.ts'

/**
 * Create the plugin-owned notice source shared by connection rows and the shell overlay.
 * @returns queued failures, their report callback and sequence-checked dismissal.
 */
export function createModelActionFeedback() {
  const notices = createSnapshotStore<readonly (ModelActionFailure & { seq: number })[]>([])
  let seq = 0
  return {
    hooks: { modelActionNotice: notices },
    reportModelFailure: (failure: ModelActionFailure): void => { notices.set([...notices.getSnapshot(), { ...failure, seq: ++seq }]) },
    dismiss: (sequence: number): void => {
      if (notices.getSnapshot()[0]?.seq === sequence) notices.set(notices.getSnapshot().slice(1))
    },
  }
}

type Props = PropsLocale<typeof NS> & InjectFace<Omit<ReturnType<typeof createModelActionFeedback>, 'reportModelFailure'>>

/**
 * Announce model test and removal failures without replacing model rows.
 * @param props - Plugin-owned notice hook, dismissal and localized copy.
 * @returns the shared toast, or nothing while no failure is pending.
 */
export function ModelActionToast({ useModelActionNotice, dismiss, t }: Props) {
  const notice = useModelActionNotice(value => value[0] ?? null)
  if (notice === null) return null
  return <Toast key={notice.seq} text={t(notice.operation === 'test' ? 'modelTestFailed' : 'modelRemoveFailed', { model: notice.model })}
    icon={<IconWarningOutlineRegular />} onDone={() => { dismiss(notice.seq) }} />
}

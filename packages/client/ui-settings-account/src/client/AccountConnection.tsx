/** Hemi fork: reusable account presentation with caller-selected content and shared account operations. */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountSection } from './AccountSection.tsx'

/** @param props - account operations and optional caller presentation. @returns the selected account view. */
export function AccountConnection({ useFactorySlot, title }: FactoryComponentPropsOf<'account.connection'>) {
  const Content = useFactorySlot('content', AccountSection)
  return <Content {...title === undefined ? {} : { title }} />
}

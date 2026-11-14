/** Type-only browser declarations; Remote methods are inferred from generated descriptors. */
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-hemi-mobile-access/remote'

export type {
  MobileAccessState, MobileAddress, MobileDeviceId, MobileDeviceView,
  MobileInvitation, MobileInvitationView, MobilePairRequest, MobileRequestId,
} from '@deepseek-ai/dsh-hemi-mobile-access/types'

/** Generated mobile management namespace, including transport-owned cancellation arguments. */
export type MobileAccessRemote = TypertClientRemote['hemiMobileAccess']

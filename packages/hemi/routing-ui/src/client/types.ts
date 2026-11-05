/** Browser-facing routing settings and editor state. */
import type { ModelCatalogFailure, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfiguredRoleRoutes, HemiRoleId, HemiRoutingEffort, RoleRoutes, Route } from '@deepseek-ai/dsh-hemi-routing/client'

/** The routing package owns the route and role vocabulary; UI only composes it. */
export type { RoleRoutes, Route }

/** One preset delegation identity. */
export type RoutingRole = HemiRoleId

/** Settings resolved by the Host's hemi-routing-settings namespace. */
export type RoutingConfig = {
  main: Route | null
  roles: ConfiguredRoleRoutes
  /** Profile-owned preference per conversation; older settings omit the map. */
  sessionModes?: Readonly<Record<string, boolean>>
  /** Conversation effort overrides for automatic routing. */
  sessionEfforts?: Readonly<Record<string, HemiRoutingEffort>>
  /** Default for conversations without an effort override. */
  defaultReasoningEffort?: HemiRoutingEffort
}

/** One independently saved route. */
export type RoutingField = 'main' | RoutingRole

/** Catalog load shared by the editor's controls. */
export interface RoutingCatalog {
  status: 'idle' | 'loading' | 'ready' | 'failed'
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  error: string | null
}

/** Last route write, retained when the dialog closes. */
export type RoutingWrite =
  | { status: 'idle' }
  | { status: 'saving' | 'saved'; field: RoutingField }
  | { status: 'failed'; field: RoutingField; message: string | null }

/** Shared settings reads and route-scoped writes supplied by registration. */
export interface RoutingEditorInjected {
  /** The model menu supports leaving routing by choosing any concrete model. */
  modelChoiceMenu?: boolean
  hooks: {
    routingSettings: HostObservable<ConfigFormSnapshot<RoutingConfig>>
    routingCatalog: HostObservable<RoutingCatalog>
    routingWrite: HostObservable<RoutingWrite>
  }
  /** Save one field using the current namespace revision. */
  saveRoute: (field: RoutingField, route: Route | null) => void
  /** Refresh the catalog, preserving failed providers as visible notices. */
  refreshCatalog: () => void
}

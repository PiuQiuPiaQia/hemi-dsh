/** Shared Hemi routing vocabulary: roles, routes, and routing modes.
 * @module @deepseek-ai/dsh-hemi-routing/types
 */

/** One preset delegation role id. Users pick models per role; roles themselves are fixed. */
export type HemiRoleId = 'explorer' | 'oracle' | 'fixer' | 'designer'

/** Every preset role id, in display order. */
export const HEMI_ROLE_IDS: readonly HemiRoleId[] = ['explorer', 'oracle', 'fixer', 'designer']

/** Legacy role ids written by pre-canonical builds, mapped one-to-one onto canonical roles. */
export const LEGACY_ROLE_IDS = {
  research: 'explorer',
  review: 'oracle',
  execution: 'fixer',
  design: 'designer',
} as const satisfies Record<string, HemiRoleId>

/** One user-chosen model route. `reasoningEffort` omitted means the model default. */
export interface Route {
  /** Registered provider id. */
  provider: string
  /** Model id within the provider. */
  model: string
  /** Explicit reasoning effort id; the empty legacy value normalizes to the model default. */
  reasoningEffort?: string
}

/** Canonical role-to-route table; absent roles follow the configured main route. */
export type RoleRoutes = Partial<Record<HemiRoleId, Route>>

/** Stored role table, including keys accepted from older configurations. */
export type ConfiguredRoleRoutes = Partial<Record<HemiRoleId | keyof typeof LEGACY_ROLE_IDS, Route>>

/** Legacy settings key for a canonical role. */
export type LegacyRoleFor<Role extends HemiRoleId> = {
  [Key in keyof typeof LEGACY_ROLE_IDS]: typeof LEGACY_ROLE_IDS[Key] extends Role ? Key : never
}[keyof typeof LEGACY_ROLE_IDS]

/** Routing mode. `fixed` is the default and means the plugin routes nothing. */
export type HemiRoutingMode = 'auto' | 'fixed'

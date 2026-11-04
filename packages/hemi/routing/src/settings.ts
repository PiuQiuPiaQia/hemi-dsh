/**
 * Host-owned settings service for the Hemi role routing table. Root-scope
 * service owning the `hemi-routing-settings` namespace: the user-chosen
 * child route per preset role, written by the settings card through the
 * standard settings pipeline. The preset-scope `hemi-routing` plugin reads
 * the routes through {@linkcode HemiRoutingSettingsService.currentRoutes}
 * when it composes the `hemi_delegate` tool's arguments.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name; also the settings namespace id. */
export const name = 'hemi-routing-settings'

/** One user-chosen child route for a preset role. */
export interface RoleRoute {
  /** Provider id as configured in the model provider settings. */
  provider: string
  /** Model id within the provider. */
  model: string
  /** Optional reasoning effort id; empty means the model default. */
  reasoningEffort: string
}

/** Roles to route mapping; absent roles inherit the parent conversation route. */
export type RoleRoutes = Partial<Record<'research' | 'review' | 'execution' | 'design', RoleRoute>>

/** Plugin config: the user-chosen role routes. */
export interface Config {
  roles: RoleRoutes
}

/** Runtime schema; volatile so the settings card writes it. */
export const Config = z.object({
  roles: z.any().default({}).volatile(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The role routing settings namespace owner. */
    hemiRoutingSettings: HemiRoutingSettingsService
  }
}

/** Settings namespace service for the role routing table. */
export class HemiRoutingSettingsService extends Service {
  /** No host services required; the settings pipe owns persistence. */
  static inject = []

  /** Runtime schema; volatile fields are writable from the settings card. */
  static Config = Config

  private config: { roles: { get(): unknown } }

  constructor(ctx: Context, config: { roles: { get(): unknown } }) {
    super(ctx, 'hemiRoutingSettings')
    this.config = config
  }

  /**
   * Read the current role routes as a detached, validated copy.
   * @returns the volatile roles snapshot; malformed entries are dropped.
   */
  currentRoutes(): RoleRoutes {
    const raw: unknown = this.config.roles.get()
    const entries = typeof raw === 'object' && raw !== null ? Object.entries(raw) : []
    const routes: RoleRoutes = {}
    for (const [role, value] of entries) {
      const route = typeof value === 'object' && value !== null ? value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } : undefined
      if (route === undefined) continue
      if (typeof route.provider !== 'string' || route.provider === ''
        || typeof route.model !== 'string' || route.model === '') continue
      routes[role as keyof RoleRoutes] = {
        provider: route.provider,
        model: route.model,
        reasoningEffort: typeof route.reasoningEffort === 'string' ? route.reasoningEffort : '',
      }
    }
    return routes
  }
}

export default HemiRoutingSettingsService

/** Editor-owned catalog loading and revision-fenced, single-field route writes. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConfiguredRoleRoutes, LegacyRoleFor } from '@deepseek-ai/dsh-hemi-routing/client'
import type {
  Route, RoutingCatalog, RoutingConfig, RoutingEditorInjected, RoutingField, RoutingRole, RoutingWrite,
} from './types.ts'

/** Every preset role, in display order; the settings section renders the same order. */
const ROLE_IDS: readonly RoutingRole[] = ['explorer', 'oracle', 'fixer', 'designer']

const LEGACY_ROLE_BY_ID = {
  explorer: 'research', oracle: 'review', fixer: 'execution', designer: 'design',
} satisfies { [Role in RoutingRole]: LegacyRoleFor<Role> }

/**
 * Read a role from a Host-validated table that can contain legacy keys.
 * @param routes - settings value returned by the Host.
 * @param role - canonical role to display or preserve in an edit.
 * @returns the saved route, or undefined when the role follows the main model.
 */
export function configuredRoleRoute(routes: ConfiguredRoleRoutes, role: RoutingRole): Route | undefined {
  return routes[role] ?? routes[LEGACY_ROLE_BY_ID[role]]
}

/** JSON value of one route as the settings pipeline stores it. */
type RouteValue = { provider: string; model: string; reasoningEffort?: string }

/**
 * Detach one route into the JSON value the settings write accepts; the routing
 * package's `Route` interface carries no index signature and cannot cross the wire as-is.
 * @param route - route chosen in the editor.
 * @returns the plain JSON value.
 */
function routeValue(route: Route): RouteValue {
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {},
  }
}

/** Settings namespace owned by the routing Host plugin. */
export const ROUTING_NS = 'hemi-routing-settings'

/**
 * Own the editor's asynchronous operations without copying the settings mirror.
 * Role writes replace the latest role map under its exact revision, so a stale
 * editor cannot overwrite another accepted change or clear an untouched route.
 * @param form - Shared Host-resolved settings form and serialized mutation queue.
 * @param fetchCatalog - Existing Session Remote catalog operation.
 * @returns the editor's injectable reads/actions and asynchronous teardown.
 */
export function createRoutingEditor(form: ConfigForm<RoutingConfig>, fetchCatalog: () => Promise<ModelCatalog>): {
  injected: RoutingEditorInjected
  dispose(): Promise<void>
} {
  const catalog = createSnapshotStore<RoutingCatalog>({ status: 'idle', groups: [], failures: [], error: null })
  const write = createSnapshotStore<RoutingWrite>({ status: 'idle' })
  let disposed = false
  let catalogOperation: Promise<void> | undefined
  let writeOperation: Promise<void> | undefined

  const refreshCatalog = (): void => {
    if (disposed || catalogOperation !== undefined) return
    catalogOperation = Promise.resolve().then(fetchCatalog).then((value) => {
      if (!disposed) catalog.set({ status: 'ready', groups: value.groups, failures: value.failures, error: null })
    }, (error: unknown) => {
      if (!disposed) catalog.set({ ...catalog.getSnapshot(), status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { catalogOperation = undefined })
    // A refresh over held groups stays readable: the spinner belongs only to the first load.
    const held = catalog.getSnapshot()
    catalog.set({ ...held, status: held.status === 'ready' ? 'ready' : 'loading', error: null })
  }

  const saveRoute = (field: RoutingField, route: Route | null): void => {
    if (disposed || writeOperation !== undefined) return
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined || !snapshot.writable || snapshot.revision === undefined) {
      write.set({ status: 'failed', field, message: null })
      return
    }
    const roles: Partial<Record<RoutingRole, RouteValue>> = {}
    if (field !== 'main') {
      for (const id of ROLE_IDS) {
        const value = id === field ? route : configuredRoleRoute(snapshot.value.roles, id)
        if (value !== undefined && value !== null) roles[id] = routeValue(value)
      }
    }
    const mutation = field === 'main'
      ? { op: 'set' as const, path: ['main'], value: route === null ? null : routeValue(route) }
      : { op: 'set' as const, path: ['roles'], value: roles }
    writeOperation = Promise.resolve().then(() => form.mutate([mutation], snapshot.revision)).then((ok) => {
      if (!disposed) write.set(ok ? { status: 'saved', field } : { status: 'failed', field, message: null })
    }, (error: unknown) => {
      if (!disposed) write.set({ status: 'failed', field, message: error instanceof Error ? error.message : String(error) })
    }).finally(() => { writeOperation = undefined })
    write.set({ status: 'saving', field })
  }

  const injected: RoutingEditorInjected = {
    hooks: { routingSettings: form, routingCatalog: catalog, routingWrite: write },
    saveRoute,
    refreshCatalog,
  }
  return {
    injected,
    /** Stop new operations and wait for already dispatched writes and reads. */
    async dispose(): Promise<void> {
      disposed = true
      await Promise.all([catalogOperation, writeOperation])
    },
  }
}

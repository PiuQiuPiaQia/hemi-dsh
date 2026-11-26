/** Host Loader entry declaring the Models credential-onboarding choice; onboarding belongs to the Client. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { HemiModelsNavigationConfig, ModelsConfig } from './types.ts'

/** Credential-onboarding choice synced to the browser, with the Hemi navigation choice. */
export type Config = ModelsConfig & HemiModelsNavigationConfig

/** Credential-onboarding and navigation choices synced to the browser. */
export const Config = z.object({
  credentialOnboarding: z.boolean().default(true).volatile(),
  // Hemi fork: a composition hides only the built-in Models navigation entry through this field; the shared
  // provider-editor factory stays registered. Volatile so the synced Config delivers it like credentialOnboarding.
  showSettingsSection: z.boolean().default(true).volatile(),
})

/**
 * Register the browser plugin without Host behavior; the Loader validates the entry's Config, and the browser face
 * receives its volatile fields.
 * @param _ctx - Host context; unused.
 * @param _config - validated Config; unused on the Host.
 */
export function apply(_ctx: Context, _config: Config): void {}

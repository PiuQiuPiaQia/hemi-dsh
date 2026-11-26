/** Models settings plugin configuration shared by the Host and Client faces; types only. */
import type { Volatile } from '@deepseek-ai/cordis'

/** Credential-onboarding choice; the browser receives it through its synced Config. */
export interface ModelsConfig {
  /** Offer the browser API-key step automatically when no native shell owns credential onboarding. */
  credentialOnboarding: Volatile<boolean>
}

// Hemi fork: compositions with their own connection page hide only the built-in Models navigation entry while the
// shared provider-editor factory and credential onboarding stay available. The field is declared apart from
// ModelsConfig so callers that predate it stay assignable to the Client `apply` parameter; see
// hemi-fork-changes.md#hemi-customization-isolation.
/** Navigation choice a Hemi composition delivers through the synced Config beside {@link ModelsConfig}. */
export interface HemiModelsNavigationConfig {
  /** Show the built-in Models settings navigation entry. */
  showSettingsSection: Volatile<boolean>
}

// Hemi fork: alternate account pages can hide native navigation without disabling shared account operations.
/** Public account UI and contact options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Questionnaire destination shared by Host and Client. */
export interface ContactConfig {
  /** Register the account-owned Desktop introduction. */
  desktopOnboarding: boolean
  /** Initialize the account provider as a default model after sign-in. */
  initializeDefaultModel: boolean
  /** Let the native shell own account authorization browser actions. */
  nativeSignIn: boolean
  /** Show the built-in account settings navigation entry. */
  showSettingsSection: boolean
  /** Show the sidebar account menu. */
  showLauncher: boolean
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
}
/** Validate public questionnaire options. */
export const ContactConfigFields = {
  // Hemi fork: optional account UIs must not own provider-neutral Desktop startup.
  desktopOnboarding: z.boolean().default(true),
  initializeDefaultModel: z.boolean().default(true),
  nativeSignIn: z.boolean().default(true),
  showSettingsSection: z.boolean().default(true),
  showLauncher: z.boolean().default(true),
  contactFormUrl: z.string().pattern(/^https:\/\/[^/\s]+\//).default('https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'),
  contactSource: z.string().default(''),
}
/** Validate public questionnaire options. */
export const ContactConfig: z<Partial<ContactConfig>, ContactConfig> = z.object(ContactConfigFields)
/** Bootstrap key containing no account credentials. */
export const CONTACT_CONFIG_GLOBAL = '__DSH_CONTACT_CONFIG__'

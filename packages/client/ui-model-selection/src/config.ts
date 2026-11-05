/** Public composition options for the native model picker. */
import z from '@deepseek-ai/schemastery'

/** Native picker options after Loader defaults. */
export interface Config {
  /** Register the native composer picker; /model and model directories remain available when false. */
  showComposer: boolean
}

/** Validate Loader options and the public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({ showComposer: z.boolean().default(true) })

/** Bootstrap key carrying only native picker composition options. */
export const MODEL_SELECTION_CONFIG_GLOBAL = '__DSH_MODEL_SELECTION_CONFIG__'

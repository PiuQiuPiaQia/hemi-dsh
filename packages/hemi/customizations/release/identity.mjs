/** Stable Hemi desktop identity shared by packaging and its Electron adapter. */
export const hemiDesktopIdentity = Object.freeze({ productName: 'Hemi', distributionId: 'hemi-dsh', artifactPrefix: 'hemi-dsh', protocol: 'hemi-dsh', homeDirectory: '.hemi-dsh' })

/**
 * Read the explicit fork marker while retaining legacy packages without one.
 * @param {unknown} metadata Packaged manifest or release completion record.
 * @returns {typeof hemiDesktopIdentity | undefined} Fork identity, or the original DSH identity.
 */
export function resolveHemiDesktopIdentity(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Hemi Desktop: expected an application manifest object')
  }
  if (metadata.hemiDesktopProduct === undefined) return undefined
  if (metadata.hemiDesktopProduct !== hemiDesktopIdentity.distributionId) throw new Error('Hemi Desktop: unsupported product identity')
  return hemiDesktopIdentity
}

/**
 * Preserve locale-owned wording while substituting the selected proper product name.
 * @param {Record<string, string>} messages Shipped Desktop dictionary.
 * @returns {Record<string, string>} A new branded dictionary with the same keys.
 */
export function hemiDesktopMessages(messages) {
  return Object.fromEntries(Object.entries(messages).map(([key, value]) => [key, value.replaceAll('DeepSeek Harness', hemiDesktopIdentity.productName)]))
}

/** Localized copy for the Hemi startup surfaces, before locale plugins load. */
const startupCopy = {
  en: { loading: 'Starting Hemi…', failed: 'Hemi could not start' },
  zh: { loading: '正在启动 Hemi…', failed: 'Hemi 启动失败' },
  ja: { loading: 'Hemi を起動中…', failed: 'Hemi を起動できませんでした' },
  es: { loading: 'Iniciando Hemi…', failed: 'No se pudo iniciar Hemi' },
  fr: { loading: 'Démarrage de Hemi…', failed: 'Impossible de démarrer Hemi' },
  de: { loading: 'Hemi wird gestartet…', failed: 'Hemi konnte nicht gestartet werden' },
  ru: { loading: 'Запуск Hemi…', failed: 'Не удалось запустить Hemi' },
  pt: { loading: 'Iniciando Hemi…', failed: 'Não foi possível iniciar o Hemi' },
}

/** Select supported startup copy; unsupported OS languages use English. */
function copyFor(locale) {
  return startupCopy[locale.toLowerCase().split('-')[0]] ?? startupCopy.en
}

/**
 * Supply Hemi loading copy only for the shell's explicit distribution marker.
 * @param {readonly string[]} argv Sandboxed preload arguments from the owning window.
 * @returns {{wordmark: string, loadingLabel: string, failedLabel: string, className: string} | undefined} Boot presentation, or native DSH defaults.
 */
export function hemiBootPresentation(argv) {
  if (!argv.includes(`--dsh-desktop-product=${hemiDesktopIdentity.distributionId}`)) return undefined
  const prefix = '--dsh-desktop-locale='
  const copy = copyFor(argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? 'en')
  return { wordmark: 'Hemi', loadingLabel: copy.loading, failedLabel: copy.failed, className: 'hemi-startup' }
}

/**
 * Read the Hemi plugin's native startup contribution after the Host has booted.
 * @param {import('@deepseek-ai/cordis').Context} ctx Running Host context.
 * @returns {{mode: 'workspace', localePreference: string | null} | undefined} Generic shell preferences, or native DSH behavior.
 */
export function hemiDesktopStartup(ctx) {
  return ctx.get('hemiModelSettings')?.desktopStartup()
}

/** Package names this Hemi release preinstalls as profile bundles, in seeding order. */
export const hemiDesktopPreinstalledBundles: readonly ['dsh-pocket', 'dsh-mnemon']
/**
 * Select the preinstalled bundles into a profile's `dsh.profile.bundles` once, recording the
 * `hemiDesktop.preinstalledBundles` marker in the same atomic manifest write.
 * @param location - Profile package directory and absolute package.json path of the bundled dsh CLI installation.
 * @returns Resolves after recording newly handled names and selections in one atomic write; resolves without writing
 * when seeding is already recorded or the installation declares none of the packages.
 * @throws When the installation declares only some of the packages, a declared package is missing or not a loadable
 * bundle of the installation, or the profile manifest or its read fields are malformed; the profile stays unchanged.
 */
export function seedHemiDesktopBundles(location: { readonly profileDir: string; readonly installAnchor: string }): Promise<void>
/**
 * Record the preinstalled bundles as handled without changing the bundle selection; recovery calls this after
 * sanitizing so a recovery before the first launch preparation cannot lead to automatic re-seeding.
 * @param location - Profile package directory.
 * @returns Resolves after the single atomic marker write; resolves without writing when the profile manifest is
 * absent or already records both names.
 * @throws When the profile manifest or its read fields are malformed; the profile stays unchanged.
 */
export function markHemiDesktopBundlesSeeded(location: { readonly profileDir: string }): Promise<void>
/**
 * Stage every pinned third-party source distribution below a prepared runtime root, so the runtime inventory seals
 * the complete corresponding source next to each distributed package. Build-time only: verifies each recorded
 * archive digest and the installed package version before copying; never extracts, executes, or fetches.
 * @param runtimeDir - Prepared runtime root whose `node_modules` holds the installed packages.
 * @param sourcesRoot - Source distribution root; defaults to the `third-party/` source directory the bundled dsh CLI
 * carries beside its manifest.
 * @throws When the source root is unreadable or empty, a record or archive fails verification, an archive reference is
 * not a single file name inside its distribution, the installed package version does not match the pinned version, or a
 * distribution carries no LICENSE file.
 */
export function stageHemiDesktopPluginSources(runtimeDir: string, sourcesRoot?: string): void

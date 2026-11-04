/**
 * Hemi backup plugin entry: the host service owning the `hemiBackup` Remote
 * namespace, plus the engine constants consumers reference.
 *
 * @module @deepseek-ai/dsh-hemi-backup
 */

export { default } from './service.ts'
export { BACKUP_DIR_PREFIX, BACKUP_KIND, BACKUP_SCHEMA_VERSION, DEFAULT_CHUNK_BYTES } from './engine.ts'
export { DEFAULT_SKILL_MAX_BYTES } from './service.ts'

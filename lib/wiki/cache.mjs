/**
 * Cache read/write + atomic replace (BRIEF §4).
 *
 * Layout: `<workspace>/hsr-worldview-cache/<id>.json` plus `index.json`.
 * Rules that matter:
 *   - every write goes to `<file>.tmp` first and is then `rename`d into place;
 *   - a failed fetch/parse must NEVER clobber a good cache: the updater only
 *     calls `writeDataset` after a successful extraction, and index entries keep
 *     their previous `lastUpdated`/`count` while gaining `ok: false, error`;
 *   - `read`/`status` must work when the directory does not exist yet.
 *
 * @module dsh-history-fictionologists/lib/wiki/cache
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cache schema version — bump when the record layout changes. */
export const CACHE_SCHEMA = 1

/** `<cacheDir>/<id>.json` */
export function datasetPath(dir, id) {
  return join(dir, `${id}.json`)
}

/** `<cacheDir>/index.json` */
export function indexPath(dir) {
  return join(dir, 'index.json')
}

/** sha256 hex, first 16 chars (BRIEF §4 `pageSha`). */
export function sha16(text) {
  try {
    return createHash('sha256').update(typeof text === 'string' ? text : String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

function toErrorText(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/**
 * Read + parse a JSON file. Never throws.
 * @param {string} path
 * @returns {{ok: boolean, data: any, error?: string, missing?: boolean}}
 */
export function readJson(path) {
  try {
    if (!existsSync(path)) return { ok: false, data: null, missing: true, error: 'missing' }
    const raw = readFileSync(path, 'utf8')
    if (raw.trim().length === 0) return { ok: false, data: null, error: 'empty file' }
    return { ok: true, data: JSON.parse(raw), bytes: Buffer.byteLength(raw, 'utf8') }
  } catch (error) {
    return { ok: false, data: null, error: toErrorText(error) }
  }
}

/**
 * Atomic JSON write: `<path>.tmp` → `rename` (BRIEF §4).
 * On failure the previous file is left untouched.
 *
 * @param {string} path
 * @param {any} data
 * @returns {{ok: boolean, path: string, bytes?: number, error?: string}}
 */
export function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`
  let serialized
  try {
    serialized = `${JSON.stringify(data, null, 2)}\n`
  } catch (error) {
    return { ok: false, path, error: `not serializable: ${toErrorText(error)}` }
  }
  try {
    const dir = dirname(path)
    if (!ensureDir(dir)) return { ok: false, path, error: `cannot create directory ${dir}` }
    writeFileSync(tmp, serialized, 'utf8')
  } catch (error) {
    return { ok: false, path, error: `write failed: ${toErrorText(error)}` }
  }
  try {
    renameSync(tmp, path)
  } catch (error) {
    // Keep the tmp file for forensics; never destroy the existing good cache.
    return { ok: false, path, error: `rename failed: ${toErrorText(error)}` }
  }
  return { ok: true, path, bytes: Buffer.byteLength(serialized, 'utf8') }
}

/** Read one dataset record. */
export function readDataset(dir, id) {
  const result = readJson(datasetPath(dir, id))
  if (!result.ok) return { ok: false, data: null, error: result.error, missing: result.missing === true }
  return { ok: true, data: result.data, bytes: result.bytes }
}

/** Write one dataset record atomically. */
export function writeDataset(dir, id, record) {
  return writeJsonAtomic(datasetPath(dir, id), record)
}

/** An empty index — `read`/`status` work before the first update. */
export function emptyIndex() {
  return { schema: CACHE_SCHEMA, generatedAt: null, datasets: {} }
}

/** Read `index.json`; missing/corrupt files yield an empty index (never a throw). */
export function readIndex(dir) {
  const result = readJson(indexPath(dir))
  if (!result.ok) {
    return { ok: false, data: emptyIndex(), error: result.error, missing: result.missing === true }
  }
  const data = result.data !== null && typeof result.data === 'object' ? result.data : {}
  const datasets = data.datasets !== null && typeof data.datasets === 'object' ? data.datasets : {}
  return { ok: true, data: { schema: data.schema ?? CACHE_SCHEMA, generatedAt: data.generatedAt ?? null, datasets }, bytes: result.bytes }
}

/** Write `index.json` atomically. */
export function writeIndex(dir, index) {
  return writeJsonAtomic(indexPath(dir), index)
}

/** Dataset file existence + size (used to avoid skipping a missing cache file). */
export function datasetFileInfo(dir, id) {
  const path = datasetPath(dir, id)
  try {
    if (!existsSync(path)) return { exists: false, path }
    const stat = statSync(path)
    return { exists: true, path, bytes: stat.size, mtime: stat.mtime.toISOString() }
  } catch {
    return { exists: false, path }
  }
}

/** Remove a leftover `<file>.tmp` (best effort; never throws). */
export function cleanupTmp(dir, id) {
  try {
    const tmp = `${datasetPath(dir, id)}.tmp`
    if (existsSync(tmp)) rmSync(tmp, { force: true })
    return true
  } catch {
    return false
  }
}

/** Cache directory facts for diagnostics (`status`). */
export function describeCache(dir) {
  return { dir, exists: existsSync(dir), index: datasetFileInfo(dir, 'index') }
}

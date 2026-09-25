/**
 * User-canon layer（「用户设定补充」）。
 *
 * The user's own rulings about the setting — for example 「奥博洛斯早已四分五裂、被镇压，
 * 绝不能写成失踪待返」 — live in `<workspace>/hsr-worldview-cache/user-canon.json`.
 *
 * Why a SEPARATE file rather than an extra entry inside `aeons.json`:
 * `update()` rebuilds `<dataset>.json` atomically on every crawl (and `writeDataset`
 * replaces the whole record), so an override stored inside a dataset file would be
 * silently erased by the next `gs_update`. A sibling file is never touched by the
 * crawler, so the two layers stay independent: crawled facts vs. user rulings.
 *
 * Contract (mirrors the rest of the data layer — nothing here ever throws):
 *   - `readUserCanon` degrades to `{ count: 0, warnings: [...] }` on a missing,
 *     unparsable or hostile file;
 *   - `matchUserCanon` returns entries whose `dataset` scope covers the requested
 *     dataset, and — when a query is given — whose terms appear in the query or in the
 *     returned entry names. An EMPTY query means "everything scoped to this dataset",
 *     so a plain `gs_read('aeons')` always carries the relevant rulings;
 *   - returned items are plain JSON with no empty-string keys (the shell runs them
 *     through `canonical()` before they reach the host validator).
 *
 * @module dsh-history-fictionologists/lib/usercanon
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cacheDir } from './paths.js'

/** File name inside the cache directory. Must never collide with `<dataset>.json`. */
export const USER_CANON_FILE = 'user-canon.json'

/** Shape marker written by hand into the file; reported but never required. */
export const USER_CANON_SCHEMA = 'dsh-history-fictionologists/user-canon@1'

/** `<ws>/hsr-worldview-cache/user-canon.json` */
export function userCanonPath(workspace) {
  return join(cacheDir(workspace), USER_CANON_FILE)
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * Dataset scope comparison. The shell hands us an already-canonical id, but the file is
 * hand-written, so tolerate case/spacing and a singular/plural difference
 * (`aeon` vs `aeons`) without importing the wiki layer.
 */
const normId = (value) => text(value).toLowerCase().replace(/s$/, '')

/** Every string that can identify this ruling: explicit `match` terms + `name`. */
function termsOf(raw) {
  const terms = []
  const push = (value) => {
    const term = text(value)
    if (term.length > 0) terms.push(term)
  }
  if (Array.isArray(raw?.match)) for (const item of raw.match) push(item)
  else push(raw?.match)
  push(raw?.name)
  return [...new Set(terms)]
}

/** One raw entry → normalized entry, or `null` when it cannot be used. */
function normalizeEntry(raw, index) {
  if (raw === null || typeof raw !== 'object') return null
  const note = text(raw.note)
  if (note.length === 0) return null // a ruling without a note is noise, not canon
  return {
    id: text(raw.id) || `canon-${index + 1}`,
    dataset: normId(raw.dataset), // '' = applies to every dataset
    datasetLabel: text(raw.dataset), // as written, for display
    name: text(raw.name),
    status: text(raw.status),
    note,
    source: text(raw.source),
    affects: Array.isArray(raw.affects) ? raw.affects.map(text).filter((value) => value.length > 0) : [],
    terms: termsOf(raw),
  }
}

/** Canon record for "there is no user-canon file". */
function emptyCanon(path, exists) {
  return { ok: true, path, exists, count: 0, updatedAt: '', updatedBy: '', entries: [], warnings: [] }
}

/**
 * Read the user-canon file (no network, never throws).
 *
 * @param {string} workspace absolute workspace path
 * @returns {{ok: boolean, path: string, exists: boolean, count: number, updatedAt: string,
 *   updatedBy: string, entries: object[], warnings: string[]}}
 */
export function readUserCanon(workspace) {
  const path = userCanonPath(workspace)
  let exists = false
  let data = null
  try {
    exists = existsSync(path)
    if (!exists) return emptyCanon(path, false)
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      path,
      exists,
      count: 0,
      updatedAt: '',
      updatedBy: '',
      entries: [],
      warnings: [`${USER_CANON_FILE} 读取失败：${message}`],
    }
  }

  const warnings = []
  const list = Array.isArray(data?.entries) ? data.entries : Array.isArray(data) ? data : []
  if (!Array.isArray(data?.entries) && !Array.isArray(data)) {
    warnings.push(`${USER_CANON_FILE} 缺少 entries 数组，已按空处理`)
  }
  const entries = []
  for (let index = 0; index < list.length; index += 1) {
    const entry = normalizeEntry(list[index], index)
    if (entry !== null) entries.push(entry)
  }
  const dropped = list.length - entries.length
  if (dropped > 0) warnings.push(`${USER_CANON_FILE} 有 ${dropped} 条因缺少 note 被忽略`)

  return {
    ok: true,
    path,
    exists: true,
    count: entries.length,
    updatedAt: text(data?.updatedAt),
    updatedBy: text(data?.updatedBy),
    schema: text(data?.schema),
    entries,
    warnings,
  }
}

/** Does this ruling apply to the requested (canonical) dataset? Global rulings do. */
export function coversDataset(entry, dataset) {
  const scope = text(entry?.dataset)
  if (scope.length === 0 || scope === '*') return true
  const wanted = normId(dataset)
  return wanted.length > 0 && normId(scope) === wanted
}

/** Model-facing projection of a ruling: no empty-string keys, no internals (`terms`). */
function publicView(entry) {
  const scope = typeof entry.datasetLabel === 'string' && entry.datasetLabel.length > 0 ? entry.datasetLabel : '*'
  const view = { dataset: scope }
  for (const [key, value] of [
    ['name', entry.name],
    ['status', entry.status],
    ['note', entry.note],
    ['source', entry.source],
  ]) {
    if (value.length > 0) view[key] = value
  }
  return view
}

/**
 * Rulings that apply to one `gs_read` call.
 *
 * @param {object|null} canon result of `readUserCanon`
 * @param {{dataset?: string, query?: string, entries?: object[]}} [context]
 * @returns {object[]} model-facing items (possibly empty)
 */
export function matchUserCanon(canon, context = {}) {
  const source = canon !== null && typeof canon === 'object' && Array.isArray(canon.entries) ? canon.entries : []
  if (source.length === 0) return []
  const dataset = text(context.dataset)
  const query = text(context.query).toLowerCase()
  const returned = Array.isArray(context.entries) ? context.entries : []
  const haystack = returned
    .map((entry) => `${entry?.name ?? ''} ${entry?.content ?? ''}`.toLowerCase())
    .join('\n')

  const out = []
  for (const entry of source) {
    if (!coversDataset(entry, dataset)) continue
    if (query.length > 0) {
      const hit = entry.terms.some((term) => {
        const needle = term.toLowerCase()
        return needle.includes(query) || query.includes(needle) || haystack.includes(needle)
      })
      if (!hit) continue
    }
    out.push(publicView(entry))
  }
  return out
}

/** Compact summary for `gs_setup` (always schema-safe). */
export function summarizeUserCanon(canon) {
  if (canon === null || typeof canon !== 'object') return { count: 0, updatedAt: '', path: '' }
  return {
    count: Number.isFinite(canon.count) ? canon.count : 0,
    updatedAt: text(canon.updatedAt),
    path: text(canon.path),
  }
}

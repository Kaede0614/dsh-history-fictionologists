/**
 * Public wiki data API (BRIEF §4/§5/§9): `status` / `update` / `read` / `sampleAll`.
 *
 * Design rules:
 *   - nothing here ever throws: every function returns
 *     `{ ok, warnings, failed, … }` and degrades to the existing cache;
 *   - `update` is incremental by MediaWiki revision id: same revid ⇒ the dataset
 *     is `skipped` and its file is not rewritten;
 *   - a failed dataset keeps its previous cache file and only marks
 *     `ok: false, error` in `index.json`;
 *   - `status`/`read`/`sampleAll` work when the cache directory does not exist.
 *
 * @module dsh-history-fictionologists/lib/wiki/index
 */
import { existsSync } from 'node:fs'
import { cacheDir, resolveWorkspace } from '../paths.js'
import { CACHE_SCHEMA, datasetFileInfo, emptyIndex, readDataset, readIndex, sha16, writeDataset, writeIndex } from './cache.mjs'
import { createWikiClient } from './client.mjs'
import { DATASETS, getDataset, resolveDatasetId, unknownDatasetIds } from './datasets.mjs'
import { DETAIL_TITLE_EXTRACTORS, EXTRACTORS, extractDataset } from './extract.mjs'

/** Default `staleAfterDays` (BRIEF §7.2). */
const DEFAULT_STALE_DAYS = 7
/** `read` limits (BRIEF §7.4). */
const READ_DEFAULT_LIMIT = 20
const READ_MAX_LIMIT = 50
/** Single-entry content cap used by `read` (BRIEF §7.4). */
const CONTENT_LIMIT = 1500

function errorText(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

function toPositiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.trunc(n)
}

function staleDaysOf(cfg) {
  return toPositiveInt(cfg?.staleAfterDays, DEFAULT_STALE_DAYS)
}

function ageDays(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return Number.POSITIVE_INFINITY
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY
  return (Date.now() - time) / 86400000
}

/** Resolve workspace + cache dir without throwing. */
function resolveCacheDir(cfg) {
  const workspace = resolveWorkspace(cfg ?? {})
  return { workspace, dir: cacheDir(workspace) }
}

/** Index entry → status row, falling back to the dataset file when the index is silent. */
function statusRow(dataset, indexEntry, dir) {
  const file = datasetFileInfo(dir, dataset.id)
  let entry = indexEntry !== null && typeof indexEntry === 'object' ? indexEntry : null
  let fromFile = false
  if (entry === null && file.exists) {
    const record = readDataset(dir, dataset.id)
    if (record.ok && record.data !== null && typeof record.data === 'object') {
      entry = {
        lastUpdated: record.data.lastUpdated ?? null,
        count: Number.isFinite(record.data.count) ? record.data.count : Array.isArray(record.data.entries) ? record.data.entries.length : 0,
        revisionId: record.data.revisionId ?? null,
        pageSha: record.data.pageSha ?? null,
        ok: true,
      }
      fromFile = true
    }
  }
  const has = entry !== null
  const age = has && typeof entry.lastUpdated === 'string' ? ageDays(entry.lastUpdated) : null
  return {
    id: dataset.id,
    title: dataset.title,
    kind: dataset.kind,
    hasWikitext: dataset.needsWikitext === true,
    cached: has && file.exists,
    fileExists: file.exists,
    bytes: file.bytes ?? 0,
    count: has ? toPositiveInt(entry.count, 0) : 0,
    excludedCount: has ? toPositiveInt(entry.excludedCount, 0) : 0,
    lastUpdated: has ? (entry.lastUpdated ?? null) : null,
    revisionId: has && entry.revisionId !== undefined ? entry.revisionId : null,
    pageSha: has ? (entry.pageSha ?? null) : null,
    ok: has ? entry.ok !== false : false,
    error: has && typeof entry.error === 'string' && entry.error.length > 0 ? entry.error : null,
    fromIndexFileOnly: fromFile,
    ageDays: age !== null && Number.isFinite(age) ? Math.round(age * 10) / 10 : null,
  }
}

/**
 * Cache status (no network).
 *
 * @param {object} [cfg] plugin config (`workspace`, `staleAfterDays`, …)
 * @returns {{ok: boolean, cacheDir: string, workspace: string, hasCache: boolean,
 *   lastUpdated: string|null, stale: boolean, staleAfterDays: number,
 *   recommendation: 'update'|'use-cache', advice: string,
 *   datasets: object[], warnings: string[], failed: {id: string, error: string}[]}}
 */
export function status(cfg = {}) {
  const warnings = []
  const failed = []
  let workspace = ''
  let dir = ''
  try {
    const resolved = resolveCacheDir(cfg)
    workspace = resolved.workspace
    dir = resolved.dir
  } catch (error) {
    const message = `workspace resolution failed: ${errorText(error)}`
    return {
      ok: false,
      cacheDir: '',
      workspace: '',
      hasCache: false,
      lastUpdated: null,
      stale: true,
      staleAfterDays: staleDaysOf(cfg),
      recommendation: 'update',
      advice: '无法解析工作区，请检查 workspace 配置。',
      datasets: [],
      warnings: [message],
      failed: [{ id: '*', error: message }],
    }
  }

  let index = emptyIndex()
  const indexRead = readIndex(dir)
  if (indexRead.ok) index = indexRead.data
  else if (indexRead.missing !== true) warnings.push(`index.json unreadable: ${indexRead.error}`)

  const rows = DATASETS.map((dataset) => statusRow(dataset, index.datasets?.[dataset.id] ?? null, dir))
  for (const row of rows) if (row.ok === false && typeof row.error === 'string') failed.push({ id: row.id, error: row.error })

  const cached = rows.filter((row) => row.cached)
  const times = cached.map((row) => row.lastUpdated).filter((value) => typeof value === 'string')
  const lastUpdated = times.length > 0 ? times.sort().at(-1) : null
  const staleAfterDays = staleDaysOf(cfg)
  const hasCache = cached.length > 0
  const allFresh = hasCache && cached.every((row) => ageDays(row.lastUpdated) <= staleAfterDays)
  const stale = !allFresh
  const missingCount = rows.length - cached.length
  const recommendation = hasCache && allFresh ? 'use-cache' : 'update'
  const advice =
    recommendation === 'use-cache'
      ? `缓存完整且都在 ${staleAfterDays} 天内，可直接使用缓存。`
      : hasCache
        ? `有 ${cached.length}/${rows.length} 个数据集可用${missingCount > 0 ? `（缺 ${missingCount} 个）` : ''}，建议增量更新。`
        : '还没有缓存，先执行一次更新。'

  return {
    ok: failed.length === 0,
    cacheDir: dir,
    workspace,
    hasCache,
    lastUpdated,
    stale,
    staleAfterDays,
    recommendation,
    advice,
    datasets: rows,
    warnings,
    failed,
  }
}

/** Split an array into chunks of `size`. */
function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Build the cache record for one dataset (pure; no I/O). */
function buildRecord(dataset, { html, revid }, extractResult, wikitextByTitle, warnings) {
  const record = {
    dataset: dataset.id,
    title: dataset.title,
    url: dataset.url,
    lastUpdated: new Date().toISOString(),
    revisionId: revid ?? null,
    pageSha: sha16(html),
    count: extractResult.entries.length,
    excludedCount: extractResult.excludedCount,
    entries: extractResult.entries,
    warnings: [...warnings, ...extractResult.warnings],
  }
  if (extractResult.stats !== null && typeof extractResult.stats === 'object' && Object.keys(extractResult.stats).length > 0) {
    record.stats = extractResult.stats
  }
  if (dataset.needsWikitext === true) {
    record.detailCount = Object.keys(wikitextByTitle).length
  }
  return record
}

/**
 * Incremental update (network).
 *
 * @param {object} [cfg] plugin config
 * @param {{datasets?: string[], force?: boolean, onProgress?: Function, client?: object}} [options]
 * @returns {Promise<{ok: boolean, updated: string[], skipped: string[], failed: {id: string, error: string}[],
 *   counts: Record<string, number>, durationMs: number, cacheDir: string, lastUpdated: string|null, warnings: string[]}>}
 */
export async function update(cfg = {}, options = {}) {
  const startedAt = Date.now()
  const warnings = []
  const updated = []
  const skipped = []
  const failed = []

  let workspace = ''
  let dir = ''
  try {
    const resolved = resolveCacheDir(cfg)
    workspace = resolved.workspace
    dir = resolved.dir
  } catch (error) {
    const message = `workspace resolution failed: ${errorText(error)}`
    return { ok: false, updated, skipped, failed: [{ id: '*', error: message }], durationMs: Date.now() - startedAt, cacheDir: '', lastUpdated: null, warnings: [message] }
  }

  const requested = Array.isArray(options.datasets) && options.datasets.length > 0 ? options.datasets : DATASETS.map((dataset) => dataset.id)
  const unknown = unknownDatasetIds(requested)
  for (const id of unknown) failed.push({ id: String(id), error: 'unknown dataset id' })
  const ids = [...new Set(requested.map((id) => resolveDatasetId(id)).filter((id) => id !== null))]
  if (ids.length === 0) {
    return { ok: failed.length === 0, updated, skipped, failed, durationMs: Date.now() - startedAt, cacheDir: dir, lastUpdated: null, warnings }
  }

  const force = options.force === true
  const client = options.client ?? createWikiClient(cfg)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const report = (event) => {
    if (onProgress === null) return
    try {
      onProgress(event)
    } catch {
      /* progress callbacks must never break an update */
    }
  }

  const indexRead = readIndex(dir)
  const index = indexRead.ok ? indexRead.data : emptyIndex()
  if (indexRead.ok !== true && indexRead.missing !== true) warnings.push(`index.json unreadable: ${indexRead.error}`)
  index.schema = CACHE_SCHEMA

  for (const id of ids) {
    const dataset = getDataset(id)
    const previous = index.datasets?.[id] ?? null
    report({ phase: 'start', dataset: id, title: dataset.title })
    try {
      // 1. revision id (always fetched: it is what the next run short-circuits on)
      const revidResult = await client.revisionIds([dataset.title])
      let revid = null
      let revidWarning = null
      if (revidResult.ok) {
        const page = revidResult.pages.find((candidate) => candidate.title === dataset.title) ?? revidResult.pages[0] ?? null
        if (page === null) revidWarning = 'revision query returned no page'
        else if (page.missing === true) revidWarning = 'page reported missing by the API'
        else revid = page.revid ?? null
      } else {
        revidWarning = `revision id lookup failed: ${revidResult.error}`
      }

      // 2. short-circuit: unchanged revid + a real cache file ⇒ skip entirely
      const file = datasetFileInfo(dir, id)
      if (!force && revid !== null && previous !== null && previous.revisionId === revid && file.exists) {
        skipped.push(id)
        report({ phase: 'skipped', dataset: id, revisionId: revid })
        continue
      }

      // 3. rendered HTML
      const parsed = await client.parsePage(dataset.title)
      if (parsed.ok !== true) {
        throw new Error(parsed.error ?? 'parse failed')
      }
      report({ phase: 'fetched', dataset: id, bytes: parsed.bytes })

      // 4. detail-page wikitext (relics / light cones), batched at 50 titles
      const perDatasetWarnings = []
      if (revidWarning !== null) perDatasetWarnings.push(revidWarning)
      const wikitextByTitle = {}
      if (dataset.needsWikitext === true) {
        const scanner = DETAIL_TITLE_EXTRACTORS[id]
        const titles = typeof scanner === 'function' ? scanner(parsed.html) : []
        if (titles.length === 0) perDatasetWarnings.push('no detail page titles found on the list page')
        const unique = [...new Set(titles)]
        for (const batch of chunk(unique, 50)) {
          const result = await client.revisions(batch)
          if (result.ok !== true) {
            perDatasetWarnings.push(`detail wikitext batch failed (${batch.length} titles): ${result.error}`)
            continue
          }
          for (const page of result.pages) {
            if (page.missing === true) {
              perDatasetWarnings.push(`detail page missing: ${page.title}`)
              continue
            }
            if (typeof page.content === 'string' && page.content.length > 0) wikitextByTitle[page.title] = page.content
          }
          report({ phase: 'wikitext', dataset: id, titles: batch.length, received: result.pages.length })
        }
        if (Object.keys(wikitextByTitle).length === 0) {
          perDatasetWarnings.push('no detail wikitext received — entries kept with empty content')
        }
      }

      // 5. extract + atomic write
      const extractResult = extractDataset(id, {
        html: parsed.html,
        wikitextByTitle,
        ctx: { cfg, dataset, title: dataset.title, url: dataset.url },
      })
      const record = buildRecord(dataset, { html: parsed.html, revid }, extractResult, wikitextByTitle, perDatasetWarnings)
      const written = writeDataset(dir, id, record)
      if (written.ok !== true) throw new Error(`cache write failed: ${written.error}`)

      index.datasets[id] = {
        lastUpdated: record.lastUpdated,
        count: record.count,
        excludedCount: record.excludedCount,
        revisionId: record.revisionId,
        pageSha: record.pageSha,
        ok: true,
      }
      updated.push(id)
      report({ phase: 'updated', dataset: id, count: record.count, excludedCount: record.excludedCount, warnings: record.warnings })
    } catch (error) {
      const message = errorText(error)
      failed.push({ id, error: message })
      // Keep the old cache file untouched; only mark the failure in the index.
      index.datasets[id] = {
        ...(previous ?? {}),
        ok: false,
        error: message,
        lastUpdated: previous?.lastUpdated ?? null,
        count: previous?.count ?? 0,
      }
      report({ phase: 'failed', dataset: id, error: message })
    }
    index.generatedAt = new Date().toISOString()
    writeIndex(dir, index)
  }

  index.generatedAt = new Date().toISOString()
  const indexWrite = writeIndex(dir, index)
  if (indexWrite.ok !== true) warnings.push(`index.json write failed: ${indexWrite.error}`)

  const statusNow = status(cfg)
  // `counts` is a convenience map for the tool layer (`gs_update` render) and for
  // spot-checks: it never needs a second status() call to report entry counts.
  const countById = new Map(statusNow.datasets.map((row) => [row.id, row.count]))
  const counts = {}
  for (const id of ids) counts[id] = countById.get(id) ?? 0
  return {
    ok: failed.length === 0,
    updated,
    skipped,
    failed,
    counts,
    durationMs: Date.now() - startedAt,
    cacheDir: dir,
    workspace,
    lastUpdated: statusNow.lastUpdated ?? null,
    warnings,
  }
}

/** Does an entry match the free-text query (name/content, BRIEF §7.4)? */
function matches(entry, needle) {
  if (needle.length === 0) return true
  const haystack = `${entry?.name ?? ''}\n${entry?.content ?? ''}`
  return haystack.toLowerCase().includes(needle)
}

/**
 * Read a cached dataset with paging + keyword filter (no network).
 *
 * @param {object} [cfg]
 * @param {{dataset?: string, query?: string, limit?: number, offset?: number}} [options]
 * @returns {{ok: boolean, dataset: string, title: string, count: number, total: number,
 *   matched: number, offset: number, limit: number, entries: object[],
 *   warnings: string[], failed: {id: string, error: string}[]}}
 */
export function read(cfg = {}, options = {}) {
  const warnings = []
  const failed = []
  const id = typeof options.dataset === 'string' ? options.dataset.trim() : ''
  const limit = Math.min(toPositiveInt(options.limit, READ_DEFAULT_LIMIT), READ_MAX_LIMIT)
  const offset = Math.max(0, Number.isFinite(Number(options.offset)) ? Math.trunc(Number(options.offset)) : 0)
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : ''

  const shell = { dataset: id, title: '', count: 0, total: 0, matched: 0, offset, limit, entries: [] }
  if (id.length === 0) {
    return { ok: false, ...shell, warnings: ['dataset is required'], failed: [{ id: '', error: 'dataset is required' }] }
  }
  const canonical = resolveDatasetId(id)
  if (canonical === null) {
    return { ok: false, ...shell, warnings: [`unknown dataset: ${id}`], failed: [{ id, error: 'unknown dataset id' }] }
  }
  const dataset = getDataset(canonical)
  shell.dataset = canonical
  shell.title = dataset.title

  let dir = ''
  try {
    dir = resolveCacheDir(cfg).dir
  } catch (error) {
    const message = `workspace resolution failed: ${errorText(error)}`
    return { ok: false, ...shell, warnings: [message], failed: [{ id, error: message }] }
  }

  const record = readDataset(dir, canonical)
  if (record.ok !== true) {
    const message = record.missing === true ? `no cache for dataset ${canonical}` : `cache unreadable: ${record.error}`
    return { ok: false, ...shell, warnings: [message], failed: [{ id: canonical, error: message }] }
  }
  const data = record.data !== null && typeof record.data === 'object' ? record.data : {}
  const all = Array.isArray(data.entries) ? data.entries : []
  const filtered = query.length === 0 ? all : all.filter((entry) => matches(entry, query))
  const page = filtered.slice(offset, offset + limit).map((entry) => {
    const content = typeof entry?.content === 'string' ? entry.content : ''
    if (content.length <= CONTENT_LIMIT) return entry
    return { ...entry, content: content.slice(0, CONTENT_LIMIT), truncated: true }
  })

  if (Array.isArray(data.warnings)) warnings.push(...data.warnings.filter((warning) => typeof warning === 'string'))
  return {
    ok: true,
    dataset: canonical,
    title: data.title ?? dataset.title,
    count: all.length,
    total: all.length,
    matched: filtered.length,
    offset,
    limit,
    lastUpdated: data.lastUpdated ?? null,
    revisionId: data.revisionId ?? null,
    entries: page,
    warnings,
    failed,
  }
}

/** First entries of every dataset — the "what is in the cache" overview. */
export function sampleAll(cfg = {}) {
  const warnings = []
  const failed = []
  let dir = ''
  let workspace = ''
  try {
    const resolved = resolveCacheDir(cfg)
    workspace = resolved.workspace
    dir = resolved.dir
  } catch (error) {
    const message = `workspace resolution failed: ${errorText(error)}`
    return { ok: false, cacheDir: '', workspace: '', datasets: [], warnings: [message], failed: [{ id: '*', error: message }] }
  }

  const perDataset = toPositiveInt(cfg?.sampleSize, 2)
  const datasets = DATASETS.map((dataset) => {
    const record = readDataset(dir, dataset.id)
    if (record.ok !== true) {
      const message = record.missing === true ? 'not cached yet' : `cache unreadable: ${record.error}`
      failed.push({ id: dataset.id, error: message })
      return { id: dataset.id, title: dataset.title, count: 0, cached: false, samples: [] }
    }
    const data = record.data !== null && typeof record.data === 'object' ? record.data : {}
    const entries = Array.isArray(data.entries) ? data.entries : []
    const samples = entries.slice(0, perDataset).map((entry) => ({
      name: typeof entry?.name === 'string' ? entry.name : '',
      preview: typeof entry?.content === 'string' ? entry.content.slice(0, 80) : '',
    }))
    return {
      id: dataset.id,
      title: dataset.title,
      count: entries.length,
      cached: true,
      lastUpdated: data.lastUpdated ?? null,
      revisionId: data.revisionId ?? null,
      samples,
    }
  })

  return {
    ok: failed.length === 0,
    cacheDir: dir,
    workspace,
    hasCache: existsSync(dir),
    datasets,
    warnings,
    failed,
  }
}

/** Re-exported for the plugin shell and the offline tests. */
export { DATASETS, DATASET_IDS, getDataset } from './datasets.mjs'
export { API, PAGE_BASE, UA, WikiClient, createWikiClient } from './client.mjs'
export { CACHE_SCHEMA, sha16 } from './cache.mjs'
export { EXTRACTORS, extractDataset } from './extract.mjs'

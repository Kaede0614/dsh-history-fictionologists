/**
 * hsr-missions reader for dsh-history-fictionologists.
 *
 * Delivers the "story continuity" layer: what stories already exist in the
 * workspace, so a generated story/broadcast can avoid contradicting them.
 *
 * Design rules (see BRIEF §6):
 *   - pure ESM, node built-ins only, no third-party imports;
 *   - never throw: every failure comes back as `{ ok: false, warnings: [...] }`;
 *   - never emit `undefined` inside a returned object — the key is omitted
 *     (every result is passed through `prune()` as a last line of defence);
 *   - every returned string is bounded, and bounding is reported via
 *     `truncated: true` / `omitted: <n>` / `bounds`.
 *
 * Real workspace facts this module was written against (measured, see
 * `_evidence/missions-digest.txt`):
 *   - `<ws>/hsr-missions/sr-开拓续闻-完整/index.json` → `系列[]`: 7 series, 52 tasks;
 *   - `<series>/_index.json` → `任务[]` with `任务名称` / `文件` / `任务编号`;
 *   - single task JSON: `任务名称/任务描述/出场人物`(string, `、`-separated)/`前置任务`(array)/
 *     `后续任务`(array)/`剧情内容[{章节,文本}]`/`任务流程[]`/`剧情wiki原文`(huge, never surfaced);
 *   - `trailblaze_missions.json` → 13.9 MB, `acts[].series[].missions[]`, mission
 *     `meta.出场人物` is an ARRAY here (unlike the per-task files);
 *   - `books_without_amphoreus.json` → array of 498 books, `分卷[].内容` holds the body.
 *
 * @module dsh-history-fictionologists/lib/missions
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { missionsDir, resolveWorkspace } from './paths.js'

// ---------------------------------------------------------------- constants
/** Directory holding the 7-series 「开拓续闻」 corpus. */
const CONTINUATION_DIR = 'sr-开拓续闻-完整'
const TRAILBLAZE_FILE = 'trailblaze_missions.json'
const BOOKS_FILE = 'books_without_amphoreus.json'

const MISSION_PER_SERIES_DEFAULT = 40
const MISSION_DESCRIPTION_CHARS = 400
const SERIES_DESCRIPTION_CHARS = 200
const CHARACTERS_PER_MISSION = 16
const BOOK_DESCRIPTION_CHARS = 160
const BOOK_BODY_CHARS = 4000
const BOOK_BODY_BUDGET_CHARS = 32000
const CONFLICT_LIMIT_DEFAULT = 40
const CONFLICT_DESCRIPTION_CHARS = 220
const CONFLICT_CHARACTERS = 80
const MAX_BRIEF_CHARS = 12000
const MAX_SERIES_VIEW_CHARS = 16000
const MAX_SERIES_CHAPTERS = 30
const LOAD_SERIES_DESCRIPTION_CHARS = 240
const LOAD_SERIES_OBJECTIVE_CHARS = 300

// ------------------------------------------------------------------ helpers
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function str(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * Markup residue left in a handful of source fields (measured: 8 of 52
 * per-task `任务描述` values contain `<br>`). A WHITELIST of real HTML tag names
 * is used so that legitimate angle brackets in prose survive untouched.
 */
const HTML_TAG_RE = /<\/?(?:br|hr|p|div|span|b|i|u|s|em|strong|small|big|font|sup|sub|tt|ul|ol|li|table|thead|tbody|tr|td|th|a|img|center|code|pre|blockquote|nowiki|ref|ruby|rt|rb)\b[^>]{0,200}>/gi

/** Collapse every whitespace run (including newlines) into a single space. */
function oneLine(value) {
  return str(value).replace(HTML_TAG_RE, '').replace(/\s+/g, ' ').trim()
}

/** Bounded single-line string (the ellipsis counts towards `max`). */
function clip(value, max) {
  const text = oneLine(value)
  if (max <= 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= max) return { text, truncated: false }
  return { text: ellipsize(text, max), truncated: true }
}

/** Bounded string that keeps its newlines (book / broadcast bodies). */
function clipRaw(value, max) {
  const text = str(value).trim()
  if (max <= 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= max) return { text, truncated: false }
  return { text: ellipsize(text, max), truncated: true }
}

/** Cut to `max` chars INCLUDING the trailing ellipsis. */
function ellipsize(text, max) {
  if (text.length <= max) return text
  if (max <= 0) return ''
  if (max === 1) return '…'
  return `${text.slice(0, max - 1)}…`
}

/** First `maxSentences` sentences of a text, hard-capped at `max` chars. */
function firstSentences(value, maxSentences = 3, max = CONFLICT_DESCRIPTION_CHARS) {
  const text = oneLine(value)
  if (text.length === 0) return ''
  const parts = text.match(/[^。！？!?]*[。！？!?]+|[^。！？!?]+$/g) ?? [text]
  let out = ''
  for (const part of parts) {
    if (out.length + part.length > max) break
    out += part
    const ends = out.match(/[。！？!?]/g)
    if (ends !== null && ends.length >= maxSentences) break
  }
  if (out.length === 0) return ellipsize(text, max)
  if (out.length < text.length) return ellipsize(out, max)
  return out
}

/**
 * Split a character/name field into a list.
 * `出场人物` is a `、`-joined string in the per-task files and an array in
 * `trailblaze_missions.json`; both shapes land here.
 */
function splitNames(value, max = CHARACTERS_PER_MISSION) {
  const raw = Array.isArray(value) ? value : [value]
  const out = []
  for (const item of raw) {
    const text = str(item)
    if (text.length === 0) continue
    for (const part of text.split(/[、，,；;]/)) {
      const name = part.trim()
      if (name.length > 0 && !out.includes(name)) out.push(name)
    }
  }
  return out.slice(0, max)
}

function stringList(value, max = 40) {
  const raw = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
  const out = []
  for (const item of raw) {
    const text = oneLine(item)
    if (text.length > 0 && !out.includes(text)) out.push(text)
  }
  return out.slice(0, max)
}

function positiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function round(value) {
  return Math.round(value * 100) / 100
}

/** Recursively drop `undefined` keys so the result survives JSON round-trips. */
function prune(value) {
  if (Array.isArray(value)) return value.map((item) => prune(item))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = prune(item)
    }
    return out
  }
  return value
}

/** Read + parse a JSON file without ever throwing. */
function readJsonFile(file) {
  const started = performance.now()
  let text
  try {
    if (!existsSync(file)) {
      return { ok: false, error: `文件不存在：${file}`, readMs: round(performance.now() - started), parseMs: 0, totalMs: round(performance.now() - started) }
    }
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: `读取失败：${messageOf(error)}`, readMs: round(performance.now() - started), parseMs: 0, totalMs: round(performance.now() - started) }
  }
  const afterRead = performance.now()
  let bytes = 0
  try {
    bytes = statSync(file).size
  } catch {
    bytes = 0
  }
  try {
    const value = JSON.parse(text)
    const afterParse = performance.now()
    return {
      ok: true,
      value,
      bytes,
      readMs: round(afterRead - started),
      parseMs: round(afterParse - afterRead),
      totalMs: round(afterParse - started),
    }
  } catch (error) {
    return {
      ok: false,
      error: `JSON 解析失败：${messageOf(error)}`,
      bytes,
      readMs: round(afterRead - started),
      parseMs: round(performance.now() - afterRead),
      totalMs: round(performance.now() - started),
    }
  }
}

function workspaceOf(cfg) {
  const config = cfg !== null && typeof cfg === 'object' ? cfg : {}
  return resolveWorkspace(config)
}

function safeMissionsRoot(cfg) {
  try {
    return missionsDir(workspaceOf(cfg))
  } catch {
    return ''
  }
}

/** Locate `<ws>/hsr-missions/sr-开拓续闻-完整` (falls back to a sibling scan). */
function findContinuationRoot(missionsRoot, warnings) {
  const preferred = join(missionsRoot, CONTINUATION_DIR)
  if (existsSync(join(preferred, 'index.json'))) return preferred
  try {
    const hit = readdirSync(missionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.includes('开拓续闻'))
      .map((entry) => join(missionsRoot, entry.name))
      .find((dir) => existsSync(join(dir, 'index.json')))
    if (typeof hit === 'string' && hit !== preferred) {
      warnings.push(`未找到 ${CONTINUATION_DIR}，改用 ${hit}`)
      return hit
    }
  } catch {
    // missions root itself is missing — the preferred path is the honest answer
  }
  return preferred
}

/** `系列[]` of the top index (tolerates an English `series` key). */
function rawSeriesList(indexValue) {
  if (indexValue === null || typeof indexValue !== 'object') return []
  if (Array.isArray(indexValue['系列'])) return indexValue['系列']
  if (Array.isArray(indexValue.series)) return indexValue.series
  return []
}

function rawTaskList(indexValue) {
  if (indexValue === null || typeof indexValue !== 'object') return []
  if (Array.isArray(indexValue['任务'])) return indexValue['任务']
  if (Array.isArray(indexValue.missions)) return indexValue.missions
  return []
}

/** Normalise one top-index series entry. */
function normalizeSeriesEntry(item, seriesRoot) {
  const source = item !== null && typeof item === 'object' ? item : {}
  const name = oneLine(source['系列任务名'] ?? source.name)
  const region = oneLine(source['任务地区'] ?? source.region)
  const version = oneLine(source['所属版本'] ?? source.version)
  const dir = oneLine(source['目录'] ?? source.dir).replace(/[/\\]+$/, '') || name
  const rel = oneLine(source['索引'] ?? source.indexFile)
  const indexFile = rel.length > 0
    ? join(seriesRoot, ...rel.split('/').filter((part) => part.length > 0 && part !== '.'))
    : join(seriesRoot, dir, '_index.json')
  const declared = Number(source['任务数'] ?? source.missionCount)
  return {
    name,
    region,
    version,
    dir,
    indexFile,
    declared: Number.isFinite(declared) ? declared : 0,
  }
}

// ------------------------------------------------------------- mission files
/**
 * Read one series into rich internal records (used by `loadSeries` and
 * `conflictBrief`, never returned as-is).
 */
function readSeriesDetail(seriesRoot, entry, warnings) {
  const index = readJsonFile(entry.indexFile)
  if (!index.ok) {
    warnings.push(`系列「${entry.name}」索引读取失败：${index.error}`)
    return { missions: [], indexed: 0, ok: false }
  }
  const tasks = rawTaskList(index.value)
  const meta = index.value !== null && typeof index.value === 'object' ? index.value['系列'] : undefined
  const region = entry.region || oneLine(meta?.['任务地区'])
  const version = entry.version || oneLine(meta?.['所属版本'])
  const missions = []
  for (const task of tasks) {
    const source = task !== null && typeof task === 'object' ? task : {}
    const name = oneLine(source['任务名称'] ?? source.name)
    if (name.length === 0) continue
    const file = oneLine(source['文件'] ?? source.file)
    const number = oneLine(source['任务编号'] ?? source.number)
    const record = {
      name,
      number,
      file,
      region,
      version,
      description: oneLine(source['任务描述']),
      characters: splitNames(source['出场人物'], 24),
      pre: stringList(source['前置任务']),
      post: stringList(source['后续任务']),
      chapters: [],
      objective: '',
    }
    if (file.length > 0) {
      const detail = readJsonFile(join(seriesRoot, entry.dir, file))
      if (detail.ok && detail.value !== null && typeof detail.value === 'object') {
        const body = detail.value
        // The per-task file is authoritative; the series index is the fallback.
        const description = oneLine(body['任务描述'])
        if (description.length > 0) record.description = description
        const characters = splitNames(body['出场人物'], 24)
        if (characters.length > 0) record.characters = characters
        const pre = stringList(body['前置任务'])
        if (pre.length > 0) record.pre = pre
        const post = stringList(body['后续任务'])
        if (post.length > 0) record.post = post
        record.region = oneLine(body['任务地区']) || record.region
        record.version = oneLine(body['所属版本']) || record.version
        record.number = oneLine(body['任务编号']) || record.number
        record.chapters = (Array.isArray(body['剧情内容']) ? body['剧情内容'] : [])
          .map((chapter) => oneLine(chapter?.['章节']))
          .filter((title) => title.length > 0)
          .slice(0, MAX_SERIES_CHAPTERS)
        record.objective = stringList(body['任务流程'], 60).join(' → ')
      } else if (!detail.ok) {
        warnings.push(`任务「${name}」正文读取失败：${detail.error}`)
      }
    }
    missions.push(record)
  }
  return { missions, indexed: tasks.length, ok: true, region, version }
}

// ------------------------------------------------------------------ exports
/**
 * Cheap index scan: reads only `sr-开拓续闻-完整/index.json` plus each series
 * `_index.json` (+ one `existsSync` per mission file).
 *
 * @param {{workspace?: string}} [cfg]
 * @returns {{ok: boolean, root: string, seriesRoot: string,
 *   series: Array<{name: string, region: string, version: string, missionCount: number,
 *     filesOnDisk: number, missions: Array<{name: string, file?: string, number?: string,
 *     region: string, version: string, exists: boolean}>}>,
 *   counts: {series: number, missions: number, files: number, missingFiles: number, byRegion: Object},
 *   warnings: string[]}}
 */
export function scanMissions(cfg = {}) {
  try {
    return scanMissionsImpl(cfg)
  } catch (error) {
    return prune({
      ok: false,
      root: safeMissionsRoot(cfg),
      series: [],
      counts: { series: 0, missions: 0, files: 0, missingFiles: 0, byRegion: {} },
      warnings: [`scanMissions 异常：${messageOf(error)}`],
    })
  }
}

function scanMissionsImpl(cfg) {
  const ws = workspaceOf(cfg)
  const root = missionsDir(ws)
  const warnings = []
  const seriesRoot = findContinuationRoot(root, warnings)
  const index = readJsonFile(join(seriesRoot, 'index.json'))
  if (!index.ok) {
    warnings.push(`未读取到「开拓续闻」总索引：${index.error}`)
    return prune({
      ok: false,
      root,
      seriesRoot,
      series: [],
      counts: { series: 0, missions: 0, files: 0, missingFiles: 0, byRegion: {} },
      warnings,
    })
  }

  const rawSeries = rawSeriesList(index.value)
  if (rawSeries.length === 0) warnings.push('总索引存在，但没有任何系列条目')

  const series = []
  const byRegion = {}
  let missions = 0
  let files = 0
  let missingFiles = 0

  for (const item of rawSeries) {
    const entry = normalizeSeriesEntry(item, seriesRoot)
    if (entry.name.length === 0) {
      warnings.push('跳过一条没有系列名的索引记录')
      continue
    }
    const sub = readJsonFile(entry.indexFile)
    const list = []
    let declared = entry.declared
    if (sub.ok) {
      const tasks = rawTaskList(sub.value)
      const declaredValue = Number(sub.value?.['任务数'])
      if (Number.isFinite(declaredValue)) declared = declaredValue
      if (declared !== tasks.length) {
        warnings.push(`系列「${entry.name}」声明 ${declared} 个任务，索引实际列出 ${tasks.length} 个`)
      }
      let seriesMissing = 0
      for (const task of tasks) {
        const source = task !== null && typeof task === 'object' ? task : {}
        const name = oneLine(source['任务名称'] ?? source.name)
        if (name.length === 0) continue
        const file = oneLine(source['文件'] ?? source.file)
        const number = oneLine(source['任务编号'] ?? source.number)
        const exists = file.length > 0 && existsSync(join(seriesRoot, entry.dir, file))
        if (exists) files += 1
        else {
          missingFiles += 1
          seriesMissing += 1
        }
        list.push({
          name,
          file: file.length > 0 ? file : undefined,
          number: number.length > 0 ? number : undefined,
          region: entry.region,
          version: entry.version,
          exists,
        })
      }
      if (seriesMissing > 0 && seriesMissing === list.length) {
        warnings.push(`系列「${entry.name}」的 ${seriesMissing} 个任务文件在磁盘上都不存在（检查目录 ${entry.dir}）`)
      }
    } else {
      warnings.push(`系列「${entry.name}」索引读取失败：${sub.error}`)
    }

    const missionCount = sub.ok ? list.length : declared
    missions += missionCount
    if (entry.region.length > 0) byRegion[entry.region] = (byRegion[entry.region] ?? 0) + missionCount
    series.push({
      name: entry.name,
      region: entry.region,
      version: entry.version,
      missionCount,
      filesOnDisk: list.filter((mission) => mission.exists).length,
      missions: list,
    })
  }

  return prune({
    ok: series.length > 0,
    root,
    seriesRoot,
    series,
    counts: { series: series.length, missions, files, missingFiles, byRegion },
    warnings,
  })
}

/**
 * Compact catalog of `trailblaze_missions.json` (13.9 MB — read + parse is
 * allowed, but only `{ name, characters, description }` per mission escapes,
 * and each series is capped at `limit` missions, default 40).
 *
 * Every act/series NAME is always returned, even when its mission list is cut;
 * such a series carries `truncated: true` plus `omitted: <n>` (missions dropped
 * by `limit`). `truncated: true` WITHOUT `omitted` means only a string was
 * clipped (mission description > 400 chars or series description > 200 chars) —
 * see `counts.descriptionsTruncated` and `bounds`.
 *
 * @param {{workspace?: string}} [cfg]
 * @param {{act?: string, series?: string, limit?: number}} [options]
 *   `limit <= 0` means "no per-series cap"; omitted/NaN means the default 40.
 */
export function catalogTrailblaze(cfg = {}, options = {}) {
  try {
    return catalogTrailblazeImpl(cfg, options)
  } catch (error) {
    return prune({
      ok: false,
      file: join(safeMissionsRoot(cfg), TRAILBLAZE_FILE),
      acts: [],
      counts: { acts: 0, series: 0, missions: 0 },
      warnings: [`catalogTrailblaze 异常：${messageOf(error)}`],
    })
  }
}

function catalogTrailblazeImpl(cfg, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const ws = workspaceOf(cfg)
  const file = join(missionsDir(ws), TRAILBLAZE_FILE)
  const warnings = []
  const read = readJsonFile(file)
  const timings = { readMs: read.readMs ?? 0, parseMs: read.parseMs ?? 0, totalMs: read.totalMs ?? 0 }
  if (!read.ok) {
    warnings.push(`未读取到 ${TRAILBLAZE_FILE}：${read.error}`)
    return prune({
      ok: false,
      file,
      acts: [],
      counts: { acts: 0, series: 0, missions: 0, returnedMissions: 0, truncatedSeries: 0, omittedMissions: 0, descriptionsTruncated: 0 },
      timings,
      warnings,
    })
  }

  const data = read.value
  const rawActs = Array.isArray(data?.acts) ? data.acts : []
  if (rawActs.length === 0) {
    warnings.push(`${TRAILBLAZE_FILE} 里没有 acts 数组`)
    return prune({ ok: false, file, acts: [], counts: { acts: 0, series: 0, missions: 0 }, timings, warnings })
  }

  const actFilter = oneLine(opts.act)
  const seriesFilter = oneLine(opts.series)
  const limitValue = Number(opts.limit)
  const unlimited = Number.isFinite(limitValue) && limitValue <= 0
  const perSeries = unlimited
    ? 0
    : Number.isFinite(limitValue) && limitValue > 0
      ? Math.floor(limitValue)
      : MISSION_PER_SERIES_DEFAULT
  const cutoff = unlimited ? Number.MAX_SAFE_INTEGER : perSeries

  // Whole-file totals are always reported, filtered or not.
  let fileSeries = 0
  let fileMissions = 0
  for (const act of rawActs) {
    const list = Array.isArray(act?.series) ? act.series : []
    fileSeries += list.length
    for (const entry of list) fileMissions += Array.isArray(entry?.missions) ? entry.missions.length : 0
  }
  const declared = data !== null && typeof data === 'object' && data.stats !== null && typeof data.stats === 'object' ? data.stats : undefined
  if (declared !== undefined) {
    const mismatched = Number(declared.acts) !== rawActs.length
      || Number(declared.series) !== fileSeries
      || Number(declared.missions) !== fileMissions
    if (mismatched) {
      warnings.push(`文件 stats（${declared.acts}/${declared.series}/${declared.missions}）与实际结构（${rawActs.length}/${fileSeries}/${fileMissions}）不一致，以实际结构为准`)
    }
  }

  const acts = []
  let returnedSeries = 0
  let returnedMissions = 0
  let truncatedSeries = 0
  let omittedMissions = 0
  let descriptionsTruncated = 0
  let seriesDescriptionTruncated = 0

  for (const act of rawActs) {
    const actName = oneLine(act?.act)
    if (actName.length === 0) continue
    if (actFilter.length > 0 && !actName.includes(actFilter)) continue
    const outSeries = []
    for (const entry of Array.isArray(act.series) ? act.series : []) {
      const seriesName = oneLine(entry?.series)
      if (seriesName.length === 0) continue
      if (seriesFilter.length > 0 && !seriesName.includes(seriesFilter)) continue

      const all = Array.isArray(entry.missions) ? entry.missions : []
      const shown = all.slice(0, cutoff)
      const omitted = Math.max(0, all.length - shown.length)
      let seriesCut = false
      const missions = []
      for (const mission of shown) {
        const name = oneLine(mission?.name)
        if (name.length === 0) continue
        const characters = splitNames(mission?.meta?.['出场人物'])
        const description = clip(mission?.description, MISSION_DESCRIPTION_CHARS)
        if (description.truncated) {
          descriptionsTruncated += 1
          seriesCut = true
        }
        const item = { name }
        if (characters.length > 0) item.characters = characters
        if (description.text.length > 0) item.description = description.text
        missions.push(item)
      }
      const seriesDescription = clip(entry?.description, SERIES_DESCRIPTION_CHARS)
      if (seriesDescription.truncated) {
        seriesDescriptionTruncated += 1
        seriesCut = true
      }
      const seriesEntry = { series: seriesName }
      if (seriesDescription.text.length > 0) seriesEntry.description = seriesDescription.text
      seriesEntry.missionCount = all.length
      seriesEntry.returned = missions.length
      seriesEntry.truncated = omitted > 0 || seriesCut
      if (seriesEntry.truncated) truncatedSeries += 1
      if (omitted > 0) seriesEntry.omitted = omitted
      seriesEntry.missions = missions
      omittedMissions += omitted
      returnedSeries += 1
      returnedMissions += missions.length
      outSeries.push(seriesEntry)
    }
    if (outSeries.length > 0) acts.push({ act: actName, series: outSeries })
  }

  if (acts.length === 0) warnings.push(actFilter.length > 0 || seriesFilter.length > 0 ? '过滤条件没有命中任何 act/series' : '没有任何可返回的 act/series')

  const filter = {}
  if (actFilter.length > 0) filter.act = actFilter
  if (seriesFilter.length > 0) filter.series = seriesFilter
  filter.limit = perSeries

  return prune({
    ok: acts.length > 0,
    file,
    source: oneLine(data?.source) || undefined,
    generated: oneLine(data?.generated) || undefined,
    stats: { acts: rawActs.length, series: fileSeries, missions: fileMissions },
    excludedActs: stringList(data?.excluded_acts, 20),
    counts: {
      acts: acts.length,
      series: returnedSeries,
      missions: fileMissions,
      returnedMissions,
      truncatedSeries,
      omittedMissions,
      descriptionsTruncated,
    },
    filter,
    bounds: {
      missionsPerSeries: perSeries,
      missionDescriptionChars: MISSION_DESCRIPTION_CHARS,
      seriesDescriptionChars: SERIES_DESCRIPTION_CHARS,
      charactersPerMission: CHARACTERS_PER_MISSION,
    },
    timings,
    acts,
    warnings,
  })
}

/**
 * The 「书架」: 498 books, metadata only (no body text).
 *
 * @param {{workspace?: string}} [cfg]
 * @param {{limit?: number, query?: string}} [opts] optional convenience filters;
 *   without them every book in the file is returned.
 */
export function catalogBooks(cfg = {}, opts = {}) {
  try {
    return catalogBooksImpl(cfg, opts)
  } catch (error) {
    return prune({
      ok: false,
      file: join(safeMissionsRoot(cfg), BOOKS_FILE),
      count: 0,
      books: [],
      warnings: [`catalogBooks 异常：${messageOf(error)}`],
    })
  }
}

function catalogBooksImpl(cfg, opts) {
  const options = opts !== null && typeof opts === 'object' ? opts : {}
  const ws = workspaceOf(cfg)
  const file = join(missionsDir(ws), BOOKS_FILE)
  const warnings = []
  const read = readJsonFile(file)
  if (!read.ok) {
    warnings.push(`未读取到 ${BOOKS_FILE}：${read.error}`)
    return prune({ ok: false, file, count: 0, returned: 0, books: [], warnings })
  }
  const raw = Array.isArray(read.value) ? read.value : Array.isArray(read.value?.books) ? read.value.books : []
  if (raw.length === 0) {
    warnings.push(`${BOOKS_FILE} 里没有书籍数组`)
    return prune({ ok: false, file, count: 0, returned: 0, books: [], warnings })
  }

  const query = oneLine(options.query)
  const limitValue = Number(options.limit)
  const cap = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : Number.MAX_SAFE_INTEGER

  const books = []
  let descriptionTruncated = 0
  let skipped = 0
  for (const item of raw) {
    const source = item !== null && typeof item === 'object' ? item : {}
    const title = oneLine(source.title ?? source['名称'])
    if (title.length === 0) {
      skipped += 1
      continue
    }
    const type = oneLine(source['类型'])
    const region = oneLine(source['所属名称'])
    if (query.length > 0 && !title.includes(query) && !type.includes(query) && !region.includes(query)) continue
    if (books.length >= cap) continue
    const description = clip(source['描述'], BOOK_DESCRIPTION_CHARS)
    if (description.truncated) descriptionTruncated += 1
    const characters = oneLine(source['相关角色'])
    books.push({
      title,
      type: type.length > 0 ? type : undefined,
      region: region.length > 0 ? region : undefined,
      description: description.text.length > 0 ? description.text : undefined,
      characters: characters.length > 0 ? characters : undefined,
    })
  }
  if (skipped > 0) warnings.push(`跳过 ${skipped} 条没有书名的记录`)

  return prune({
    ok: books.length > 0,
    file,
    bytes: read.bytes,
    count: raw.length,
    returned: books.length,
    truncated: descriptionTruncated > 0 || (cap !== Number.MAX_SAFE_INTEGER && raw.length > books.length),
    bounds: { descriptionChars: BOOK_DESCRIPTION_CHARS, books: cap === Number.MAX_SAFE_INTEGER ? 0 : cap },
    books,
    warnings,
  })
}

/**
 * Bodies (`分卷[].内容`) of the named books.
 *
 * @param {{workspace?: string}} [cfg]
 * @param {string|string[]} titles exact names first, then substring matches
 * @param {{bodyChars?: number, totalChars?: number}} [opts]
 *   `bodyChars` default 4000 (per volume), `totalChars` default 32000 (whole call).
 */
export function booksByTitle(cfg = {}, titles, opts = {}) {
  try {
    return booksByTitleImpl(cfg, titles, opts)
  } catch (error) {
    return prune({
      ok: false,
      file: join(safeMissionsRoot(cfg), BOOKS_FILE),
      requested: [],
      matched: 0,
      books: [],
      warnings: [`booksByTitle 异常：${messageOf(error)}`],
    })
  }
}

function booksByTitleImpl(cfg, titles, opts) {
  const options = opts !== null && typeof opts === 'object' ? opts : {}
  const ws = workspaceOf(cfg)
  const file = join(missionsDir(ws), BOOKS_FILE)
  const warnings = []
  const wanted = (Array.isArray(titles) ? titles : titles === undefined || titles === null ? [] : [titles])
    .map((title) => oneLine(title))
    .filter((title) => title.length > 0)
  if (wanted.length === 0) {
    warnings.push('未提供书名（titles 为空）')
    return prune({ ok: false, file, requested: [], matched: 0, books: [], warnings })
  }
  const read = readJsonFile(file)
  if (!read.ok) {
    warnings.push(`未读取到 ${BOOKS_FILE}：${read.error}`)
    return prune({ ok: false, file, requested: wanted, matched: 0, books: [], warnings })
  }
  const raw = Array.isArray(read.value) ? read.value : Array.isArray(read.value?.books) ? read.value.books : []
  if (raw.length === 0) {
    warnings.push(`${BOOKS_FILE} 里没有书籍数组`)
    return prune({ ok: false, file, requested: wanted, matched: 0, books: [], warnings })
  }

  const bodyCap = positiveInt(options.bodyChars, BOOK_BODY_CHARS)
  const totalCap = positiveInt(options.totalChars, BOOK_BODY_BUDGET_CHARS)
  const catalogue = raw
    .map((item) => (item !== null && typeof item === 'object' ? { title: oneLine(item.title ?? item['名称']), item } : null))
    .filter((entry) => entry !== null && entry.title.length > 0)

  const books = []
  const missing = []
  const seen = new Set()
  let used = 0
  let anyTruncated = false

  for (const query of wanted) {
    const exact = catalogue.find((entry) => entry.title === query)
    const fuzzy = exact ?? catalogue.find((entry) => entry.title.includes(query)) ?? catalogue.find((entry) => query.includes(entry.title))
    if (fuzzy === undefined) {
      missing.push(query)
      continue
    }
    if (seen.has(fuzzy.title)) continue
    seen.add(fuzzy.title)

    const source = fuzzy.item
    const volumes = []
    let omittedVolumes = 0
    let bookTruncated = false
    for (const volume of Array.isArray(source['分卷']) ? source['分卷'] : []) {
      const volumeSource = volume !== null && typeof volume === 'object' ? volume : {}
      const body = str(volumeSource['内容'])
      const bodyChars = body.trim().length
      const remaining = totalCap - used
      if (bodyChars > 0 && remaining <= 0) {
        omittedVolumes += 1
        bookTruncated = true
        continue
      }
      const clipped = clipRaw(body, Math.min(bodyCap, Math.max(remaining, 0)))
      used += clipped.text.length
      if (clipped.truncated) bookTruncated = true
      const name = oneLine(volumeSource['名称'])
      const number = oneLine(volumeSource['卷数'])
      const acquire = oneLine(volumeSource['获取方式'])
      volumes.push({
        name: name.length > 0 ? name : undefined,
        number: number.length > 0 ? number : undefined,
        acquire: acquire.length > 0 ? acquire : undefined,
        chars: bodyChars,
        body: clipped.text,
        truncated: clipped.truncated,
      })
    }
    if (bookTruncated) anyTruncated = true
    const description = clip(source['描述'], BOOK_DESCRIPTION_CHARS)
    const characters = oneLine(source['相关角色'])
    const type = oneLine(source['类型'])
    const region = oneLine(source['所属名称'])
    books.push({
      title: fuzzy.title,
      type: type.length > 0 ? type : undefined,
      region: region.length > 0 ? region : undefined,
      description: description.text.length > 0 ? description.text : undefined,
      characters: characters.length > 0 ? characters : undefined,
      volumeCount: Array.isArray(source['分卷']) ? source['分卷'].length : 0,
      volumes,
      truncated: bookTruncated,
    })
  }
  if (missing.length > 0) warnings.push(`未匹配到：${missing.join(' / ')}`)
  if (anyTruncated) warnings.push(`正文已按每卷 ${bodyCap} 字 / 单次 ${totalCap} 字上限截断`)

  return prune({
    ok: books.length > 0,
    file,
    requested: wanted,
    matched: books.length,
    missing,
    totalChars: used,
    truncated: anyTruncated,
    bounds: { bodyChars: bodyCap, totalChars: totalCap },
    books,
    warnings,
  })
}

/**
 * Compact view of one 「开拓续闻」 series — names, descriptions, cast, chapter
 * TITLES and the objective steps. Dialogue text (`剧情内容[].文本`) and the raw
 * wikitext are deliberately never surfaced.
 *
 * @param {{workspace?: string}} [cfg]
 * @param {string} seriesName e.g. `狐斋志异`
 */
export function loadSeries(cfg = {}, seriesName) {
  try {
    return loadSeriesImpl(cfg, seriesName)
  } catch (error) {
    return prune({
      ok: false,
      series: oneLine(seriesName),
      missions: [],
      warnings: [`loadSeries 异常：${messageOf(error)}`],
    })
  }
}

function loadSeriesImpl(cfg, seriesName) {
  const wanted = oneLine(seriesName)
  const ws = workspaceOf(cfg)
  const root = missionsDir(ws)
  const warnings = []
  const seriesRoot = findContinuationRoot(root, warnings)
  const index = readJsonFile(join(seriesRoot, 'index.json'))
  if (!index.ok) {
    warnings.push(`未读取到「开拓续闻」总索引：${index.error}`)
    return prune({ ok: false, root, series: wanted, missions: [], warnings })
  }
  const entries = rawSeriesList(index.value).map((item) => normalizeSeriesEntry(item, seriesRoot))
  const available = entries.map((entry) => entry.name).filter((name) => name.length > 0)
  if (wanted.length === 0) {
    warnings.push('未指定系列名')
    return prune({ ok: false, root, series: '', available, missions: [], warnings })
  }
  const entry = entries.find((item) => item.name === wanted)
    ?? entries.find((item) => item.name.includes(wanted) || wanted.includes(item.name))
  if (entry === undefined) {
    warnings.push(`没有名为「${wanted}」的系列`)
    return prune({ ok: false, root, series: wanted, available, missions: [], warnings })
  }

  const detail = readSeriesDetail(seriesRoot, entry, warnings)
  if (!detail.ok) {
    return prune({ ok: false, root, series: entry.name, available, missions: [], warnings })
  }

  let clippedDescriptions = 0
  let clippedObjectives = 0
  const missions = detail.missions.map((record) => {
    const description = clip(record.description, LOAD_SERIES_DESCRIPTION_CHARS)
    if (description.truncated) clippedDescriptions += 1
    const objective = clip(record.objective, LOAD_SERIES_OBJECTIVE_CHARS)
    if (objective.truncated) clippedObjectives += 1
    const mission = { name: record.name }
    if (description.text.length > 0) mission.description = description.text
    if (record.characters.length > 0) mission.characters = record.characters
    if (record.chapters.length > 0) mission.chapters = record.chapters
    if (objective.text.length > 0) mission.objective = objective.text
    return mission
  })
  if (clippedDescriptions > 0) warnings.push(`${clippedDescriptions} 条任务描述被截断到 ${LOAD_SERIES_DESCRIPTION_CHARS} 字`)
  if (clippedObjectives > 0) warnings.push(`${clippedObjectives} 条任务流程被截断到 ${LOAD_SERIES_OBJECTIVE_CHARS} 字`)

  let truncated = clippedDescriptions > 0 || clippedObjectives > 0
  let shaped = missions
  const size = (value) => {
    try {
      return JSON.stringify(value).length
    } catch {
      return Number.MAX_SAFE_INTEGER
    }
  }
  // Safety net: the brief must stay pasteable even for a pathological series.
  if (size(missions) > MAX_SERIES_VIEW_CHARS) {
    for (const level of [1, 2, 3, 4]) {
      shaped = missions.map((mission) => {
        if (level === 1) return { ...mission, chapters: (mission.chapters ?? []).slice(0, 12) }
        if (level === 2) return { ...mission, description: (mission.description ?? '').slice(0, 120) }
        if (level === 3) return { ...mission, objective: (mission.objective ?? '').slice(0, 160) }
        return { name: mission.name }
      })
      truncated = true
      if (size(shaped) <= MAX_SERIES_VIEW_CHARS) break
    }
    warnings.push(`系列视图超出 ${MAX_SERIES_VIEW_CHARS} 字上限，已降级字段`)
  }

  return prune({
    ok: true,
    root,
    series: entry.name,
    region: detail.region || entry.region,
    version: detail.version || entry.version,
    missionCount: detail.missions.length,
    indexed: detail.indexed,
    truncated,
    bounds: {
      descriptionChars: LOAD_SERIES_DESCRIPTION_CHARS,
      objectiveChars: LOAD_SERIES_OBJECTIVE_CHARS,
      chaptersPerMission: MAX_SERIES_CHAPTERS,
    },
    missions: shaped,
    warnings,
  })
}

/**
 * The "avoid contradicting this" brief that feeds the storywriter prompt:
 * existing mission names, the places/cast/prerequisite chains read out of the
 * mission metadata, and 2–3 sentence descriptions of each mission.
 *
 * @param {{workspace?: string}} [cfg]
 * @param {{series?: string, query?: string, limit?: number}} [options]
 */
export function conflictBrief(cfg = {}, options = {}) {
  try {
    return conflictBriefImpl(cfg, options)
  } catch (error) {
    return prune({
      ok: false,
      series: '',
      brief: '',
      missions: [],
      places: [],
      characters: [],
      warnings: [`conflictBrief 异常：${messageOf(error)}`],
    })
  }
}

function conflictBriefImpl(cfg, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const wanted = oneLine(opts.series)
  const query = oneLine(opts.query)
  const limit = positiveInt(opts.limit, CONFLICT_LIMIT_DEFAULT)
  const warnings = []

  const scan = scanMissions(cfg)
  const root = scan.root ?? safeMissionsRoot(cfg)
  if (!scan.ok) {
    return prune({
      ok: false,
      root,
      series: wanted,
      brief: '',
      missions: [],
      places: [],
      characters: [],
      warnings: [...(scan.warnings ?? []), '没有可用的既有故事数据'],
    })
  }
  const allSeries = scan.series ?? []
  let selected = allSeries
  if (wanted.length > 0) {
    selected = allSeries.filter((item) => item.name === wanted)
    if (selected.length === 0) selected = allSeries.filter((item) => item.name.includes(wanted) || wanted.includes(item.name))
    if (selected.length === 0) {
      warnings.push(`没有名为「${wanted}」的系列`)
      return prune({
        ok: false,
        root,
        series: wanted,
        available: allSeries.map((item) => item.name),
        brief: '',
        missions: [],
        places: [],
        characters: [],
        warnings,
      })
    }
  }

  if (query.length > 0) {
    selected = selected.filter((item) => item.missions.some((mission) => mission.name.includes(query)))
    if (selected.length === 0) warnings.push(`关键词「${query}」没有命中任何系列`)
  }

  const seriesRoot = scan.seriesRoot ?? findContinuationRoot(root, warnings)
  // Prefer the real top-index entries (they carry the on-disk directory name).
  const topIndex = readJsonFile(join(seriesRoot, 'index.json'))
  const indexed = topIndex.ok
    ? rawSeriesList(topIndex.value).map((item) => normalizeSeriesEntry(item, seriesRoot)).filter((entry) => entry.name.length > 0)
    : []
  const records = []
  const places = []
  const characterCounts = new Map()
  const links = []
  for (const item of selected) {
    const entry = indexed.find((candidate) => candidate.name === item.name)
      ?? normalizeSeriesEntry({ 系列任务名: item.name, 任务地区: item.region, 所属版本: item.version }, seriesRoot)
    const detail = readSeriesDetail(seriesRoot, entry, warnings)
    for (const record of detail.missions) {
      if (query.length > 0 && !record.name.includes(query) && !record.description.includes(query)) continue
      if (record.region.length > 0 && !places.includes(record.region)) places.push(record.region)
      for (const name of record.characters) characterCounts.set(name, (characterCounts.get(name) ?? 0) + 1)
      for (const name of [...record.pre, ...record.post]) if (!links.includes(name)) links.push(name)
      records.push(record)
    }
  }
  if (records.length === 0) {
    return prune({
      ok: false,
      root,
      series: wanted || selected.map((item) => item.name).join(' / '),
      brief: '',
      missions: [],
      places,
      characters: [...characterCounts.keys()],
      warnings: [...warnings, '选中的系列里没有可用的任务记录'],
    })
  }

  const characters = [...characterCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .map(([name]) => name)
  const shown = records.slice(0, limit)
  const missionTitleSet = new Set(records.map((record) => record.name))
  const outsideLinks = links.filter((name) => !missionTitleSet.has(name))

  const missionItems = shown.map((record) => {
    const item = { name: record.name }
    if (record.region.length > 0) item.region = record.region
    if (record.characters.length > 0) item.characters = record.characters.slice(0, CHARACTERS_PER_MISSION)
    if (record.pre.length > 0) item.pre = record.pre
    if (record.post.length > 0) item.post = record.post
    const description = firstSentences(record.description, 3, CONFLICT_DESCRIPTION_CHARS)
    if (description.length > 0) item.description = description
    return item
  })

  const lines = []
  lines.push('## 既有故事避让清单（新故事不得与以下内容冲突）')
  lines.push('')
  lines.push(`- 系列：${selected.map((item) => item.name).join(' / ')}`)
  if (places.length > 0) lines.push(`- 涉及地区：${places.join(' / ')}`)
  const versions = [...new Set(selected.map((item) => item.version).filter((value) => value.length > 0))]
  if (versions.length > 0) lines.push(`- 版本：${versions.join(' / ')}`)
  lines.push(`- 既有任务：${records.length} 个${shown.length < records.length ? `（下方列出前 ${shown.length} 个）` : ''}`)
  if (characters.length > 0) lines.push(`- 已出场人物（${characters.length}）：${characters.slice(0, CONFLICT_CHARACTERS).join('、')}`)
  lines.push('')
  lines.push('### 既有任务名与事件线（不得复述、改写其结局，也不得让同名角色出现在矛盾的时间线上）')
  for (const item of missionItems) {
    const parts = [`- **${item.name}**`]
    const chain = []
    if (item.pre !== undefined) chain.push(`前置：${item.pre.join('、')}`)
    if (item.post !== undefined) chain.push(`后续：${item.post.join('、')}`)
    if (chain.length > 0) parts.push(`（${chain.join('｜')}）`)
    if (item.description !== undefined) parts.push(`—— ${item.description}`)
    lines.push(parts.join(''))
  }
  if (outsideLinks.length > 0 && shown.length >= records.length) {
    lines.push('')
    lines.push(`### 关联到本系列之外的任务名（世界观已存在，不可当作新事件）`)
    lines.push(`- ${outsideLinks.slice(0, 40).join('、')}`)
  }

  let brief = lines.join('\n')
  let truncated = shown.length < records.length
  if (brief.length > MAX_BRIEF_CHARS) {
    brief = `${brief.slice(0, MAX_BRIEF_CHARS - 1)}…`
    truncated = true
    warnings.push(`避让清单超出 ${MAX_BRIEF_CHARS} 字上限，已截断`)
  }

  return prune({
    ok: true,
    root,
    series: selected.length === 1 ? selected[0].name : selected.map((item) => item.name).join(' / '),
    places,
    characters: characters.slice(0, CONFLICT_CHARACTERS),
    characterCount: characters.length,
    missionCount: records.length,
    returned: missionItems.length,
    linkedMissions: links,
    linksOutsideSeries: outsideLinks,
    truncated,
    bounds: {
      limit,
      descriptionSentences: 3,
      descriptionChars: CONFLICT_DESCRIPTION_CHARS,
      briefChars: MAX_BRIEF_CHARS,
    },
    missions: missionItems,
    brief,
    warnings,
  })
}

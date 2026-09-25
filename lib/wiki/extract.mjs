/**
 * The 12 dataset extractors (BRIEF §3.3, selectors followed exactly).
 *
 * Contract — every extractor is exported as
 * `extract<Name>({ html, wikitextByTitle, ctx })` and returns
 * `{ entries, excludedCount, warnings, stats }`:
 *   - `html`             already-downloaded rendered HTML (never fetched here);
 *   - `wikitextByTitle`  `{ [pageTitle]: wikitext }` for the detail-page datasets;
 *   - `ctx`              optional context (cfg / dataset / logger), unused for parsing.
 *
 * No extractor performs I/O, throws, or emits `undefined` values, so their output
 * can be replayed offline from `_probe/html/*.html` and cached verbatim.
 *
 * @module dsh-history-fictionologists/lib/wiki/extract
 */
import {
  cellsOf,
  classText,
  classTexts,
  cleanText,
  dataParams,
  extractName,
  headings,
  omitUndefined,
  rowTag,
  s,
  sectionSlices,
  splitBlocks,
  stripPageChrome,
  tableById,
  tableRows,
} from './html.mjs'
import { field, templateFields, wikitextToText } from './wikitext.mjs'

/** Modes excluded from 方程/事件 (BRIEF §3.3). */
const HERO_MODE = '千面英雄'
/** Region whose consumables are excluded (BRIEF §3.3). */
const AMPHOREUS = '翁法罗斯'

/** Card grid selector: `<div class="divsort" data-param0..N>`. */
const DIVSORT_CARD = /<div\b[^>]*class="[^"]*\bdivsort\b[^"]*"[^>]*>/gi
/** Tab panel used by the 模拟宇宙 图鉴 sections. */
const RESP_TAB = /<div\b[^>]*class="[^"]*\bresp-tab-content\b[^"]*"[^>]*>/gi

/** text → cleaned plain text */
const text = (html) => cleanText(html)

/** Deep-copy dropping every `undefined` member: the DSH host rejects non-lossless JSON. */
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue
      out[key] = scrub(member)
    }
    return out
  }
  return value
}

function errorText(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return String(error)
}

/** Wrap an extractor body so it can only ever return a result object. */
function safe(id, run) {
  try {
    const result = run()
    return normalizeResult(result)
  } catch (error) {
    return {
      entries: [],
      excludedCount: 0,
      warnings: [`${id} extractor failed: ${errorText(error)}`],
      stats: {},
    }
  }
}

function normalizeResult(result) {
  const entries = Array.isArray(result?.entries) ? result.entries.filter((entry) => entry !== null && typeof entry === 'object') : []
  const warnings = Array.isArray(result?.warnings) ? result.warnings.filter((warning) => typeof warning === 'string' && warning.length > 0) : []
  const excludedCount = Number.isFinite(result?.excludedCount) ? Number(result.excludedCount) : 0
  const stats = result?.stats !== null && typeof result?.stats === 'object' ? result.stats : {}
  return { entries: scrub(entries), excludedCount, warnings, stats: scrub(stats) }
}

/**
 * Read the `id="CardSelectTr"` table and split it into header + data rows.
 * Rows are selected by the presence of `data-param1` (BRIEF §3.2/§3.3): the wiki
 * also emits nested tooltip rows without params, and those are not data.
 */
function scanTable(html) {
  const table = tableById(html, 'CardSelectTr')
  if (table.length === 0) return { rows: [], data: [], warnings: ['CardSelectTr table not found'] }
  const rows = tableRows(table)
  const data = []
  for (const row of rows) {
    const tag = rowTag(row)
    const params = dataParams(tag)
    if (s(params.param1).length === 0) continue
    data.push({ row, tag, params, cells: cellsOf(row) })
  }
  return { rows, data, warnings: [] }
}

/* ------------------------------------------------------------------ tables */

/** 方程一览 — filter: mode contains 千面英雄. */
export function extractEquations({ html } = {}) {
  return safe('equations', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 方程一览'], stats: {} }
    }
    const { rows, data, warnings } = scanTable(html)
    const entries = []
    let excludedCount = 0
    let skipped = 0
    for (const { params, cells } of data) {
      const modeCell = text(cells[2])
      const mode = s(params.param5) || modeCell
      if (mode.includes(HERO_MODE) || modeCell.includes(HERO_MODE)) {
        excludedCount += 1
        continue
      }
      const name = extractName(s(cells[1])) || extractName(s(cells[0]))
      if (name.length === 0) {
        skipped += 1
        continue
      }
      entries.push(
        omitUndefined({
          name,
          rarity: s(params.param1),
          pathPrimary: s(params.param2),
          pathSecondary: s(params.param3),
          mode,
          blessing: text(cells[3]),
          content: text(cells[4]),
          version: s(params.param4) || text(cells[5]),
        }),
      )
    }
    if (skipped > 0) warnings.push(`${skipped} 方程 rows had no resolvable name`)
    return {
      entries,
      excludedCount,
      warnings,
      stats: { totalRows: rows.length, dataRows: data.length, entries: entries.length },
    }
  })
}

/** 事件一览 — filter: mode contains 千面英雄 (multi-mode rows use includes). */
export function extractEvents({ html } = {}) {
  return safe('events', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 事件一览'], stats: {} }
    }
    const { rows, data, warnings } = scanTable(html)
    const entries = []
    let excludedCount = 0
    let skipped = 0
    for (const { params, cells } of data) {
      const modeCell = text(cells[2])
      const mode = s(params.param1) || modeCell
      if (mode.includes(HERO_MODE) || modeCell.includes(HERO_MODE)) {
        excludedCount += 1
        continue
      }
      const name = extractName(s(cells[1])) || extractName(s(cells[0]))
      if (name.length === 0) {
        skipped += 1
        continue
      }
      // `options` is the documented field (BRIEF §3.3); `content` mirrors it so the
      // generic reader/digest path (`query` matches name+content) works uniformly.
      const options = text(cells[3])
      entries.push(
        omitUndefined({
          name,
          mode,
          type: s(params.param2),
          options,
          content: options,
          version: s(params.param3) || text(cells[4]),
        }),
      )
    }
    if (skipped > 0) warnings.push(`${skipped} 事件 rows had no resolvable name`)
    return {
      entries,
      excludedCount,
      warnings,
      stats: { totalRows: rows.length, dataRows: data.length, entries: entries.length },
    }
  })
}

/** 奇物一览（差分） — no mode filter. */
export function extractCurios({ html } = {}) {
  return safe('curios', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 奇物一览（差分）'], stats: {} }
    }
    const { rows, data, warnings } = scanTable(html)
    const entries = []
    let skipped = 0
    for (const { params, cells } of data) {
      const name = extractName(s(cells[1])) || extractName(s(cells[0]))
      if (name.length === 0) {
        skipped += 1
        continue
      }
      entries.push(
        omitUndefined({
          name,
          mode: s(params.param1) || text(cells[2]),
          type: s(params.param2),
          tag: text(cells[3]) || s(params.param4),
          star: s(params.param6),
          acquire: text(cells[4]) || s(params.param3),
          content: text(cells[5]),
          version: s(params.param5) || text(cells[6]),
        }),
      )
    }
    if (skipped > 0) warnings.push(`${skipped} 奇物 rows had no resolvable name`)
    return {
      entries,
      excludedCount: 0,
      warnings,
      stats: { totalRows: rows.length, dataRows: data.length, entries: entries.length },
    }
  })
}

/** 消耗品筛选 — filter: `[3]` cell text === 翁法罗斯. */
export function extractConsumables({ html } = {}) {
  return safe('consumables', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 消耗品筛选'], stats: {} }
    }
    const { rows, data, warnings } = scanTable(html)
    const entries = []
    let excludedCount = 0
    let skipped = 0
    for (const { params, cells } of data) {
      const region = text(cells[3])
      if (region === AMPHOREUS) {
        excludedCount += 1
        continue
      }
      const name = extractName(s(cells[1])) || extractName(s(cells[0]))
      if (name.length === 0) {
        skipped += 1
        continue
      }
      entries.push(
        omitUndefined({
          name,
          rarity: s(params.param1),
          region,
          type: s(params.param2),
          tag: text(cells[4]),
          acquire: text(cells[5]) || s(params.param3),
          content: text(cells[6]),
          version: s(params.param5) || text(cells[7]),
        }),
      )
    }
    if (skipped > 0) warnings.push(`${skipped} 消耗品 rows had no resolvable name`)
    return {
      entries,
      excludedCount,
      warnings,
      stats: { totalRows: rows.length, dataRows: data.length, entries: entries.length },
    }
  })
}

/** 装饰一览 — no filter; content is column `[6]` 介绍. */
export function extractDecorations({ html } = {}) {
  return safe('decorations', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 装饰一览'], stats: {} }
    }
    const { rows, data, warnings } = scanTable(html)
    const entries = []
    let skipped = 0
    for (const { params, cells } of data) {
      const name = extractName(s(cells[1])) || extractName(s(cells[0]))
      if (name.length === 0) {
        skipped += 1
        continue
      }
      entries.push(
        omitUndefined({
          name,
          rarity: s(params.param1),
          type: s(params.param2) || text(cells[3]),
          acquire: s(params.param3) || text(cells[4]),
          effect: text(cells[5]),
          content: text(cells[6]),
          version: s(params.param4) || text(cells[7]),
        }),
      )
    }
    if (skipped > 0) warnings.push(`${skipped} 装饰 rows had no resolvable name`)
    return {
      entries,
      excludedCount: 0,
      warnings,
      stats: { totalRows: rows.length, dataRows: data.length, entries: entries.length },
    }
  })
}

/* ------------------------------------------------------------------- cards */

/**
 * The 6 遗器来历 slots (BRIEF §3.3): 4 隧洞 parts and 2 位面饰品 parts.
 * `<br>` becomes a newline and `<i>` citations stay as plain text.
 */
const RELIC_SLOTS = [
  { slot: '头部', name: '头部', description: '头部描述', story: '头部故事' },
  { slot: '手部', name: '手部', description: '手部描述', story: '手部故事' },
  { slot: '躯干', name: '躯干', description: '躯干描述', story: '躯干故事' },
  { slot: '脚部', name: '脚部', description: '脚部描述', story: '脚部故事' },
  { slot: '位面球', name: '位面球', description: '位面球描述', story: '位面球故事' },
  { slot: '连结绳', name: '连结绳', description: '连结绳描述', story: '连结绳故事' },
]

/** The card list of a `div.divsort` grid, with attrs and the reliable name. */
function scanCards(html, nameClass) {
  const { blocks, unbalanced } = splitBlocks(html, DIVSORT_CARD)
  const warnings = []
  if (unbalanced > 0) warnings.push(`${unbalanced} 卡片 div.divsort had no balanced closing tag`)
  const cards = blocks.map((block) => {
    const tag = (/^<div[^>]*>/i.exec(block) ?? [''])[0]
    return {
      block,
      tag,
      params: dataParams(tag),
      name: classText(block, nameClass) || extractName(block),
    }
  })
  return { cards, warnings }
}

/** Detail page titles of the relic sets (used by `update` to batch wikitext). */
export function relicDetailTitles(html) {
  return scanCards(typeof html === 'string' ? html : '', 'relicset-name')
    .cards.map((card) => card.name)
    .filter((name) => name.length > 0)
}

/** Detail page titles of the light cones. */
export function lightconeDetailTitles(html) {
  return scanCards(typeof html === 'string' ? html : '', 'weapon-name')
    .cards.map((card) => card.name)
    .filter((name) => name.length > 0)
}

/**
 * 遗器图鉴 — cards + `{{遗器套装}}` detail wikitext.
 * Sets whose story fields are all empty stay in `entries` with `empty: true`
 * (BRIEF §3.3: never error, e.g. 戏梦点星的伶人).
 */
export function extractRelics({ html, wikitextByTitle } = {}) {
  return safe('relics', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 遗器图鉴'], stats: {} }
    }
    const { cards, warnings } = scanCards(html, 'relicset-name')
    const wiki = wikitextByTitle !== null && typeof wikitextByTitle === 'object' ? wikitextByTitle : {}
    const entries = []
    let withoutWikitext = 0
    let withoutTemplate = 0
    let emptyContent = 0
    let duplicateNames = 0
    const seen = new Set()
    for (const card of cards) {
      const name = card.name
      if (name.length === 0) continue
      if (seen.has(name)) duplicateNames += 1
      seen.add(name)
      const wikitext = typeof wiki[name] === 'string' ? wiki[name] : ''
      const parsed = wikitext.length > 0 ? templateFields(wikitext, '遗器套装') : null
      if (wikitext.length === 0) withoutWikitext += 1
      else if (parsed === null) withoutTemplate += 1
      const fields = parsed === null ? null : parsed.fields
      const parts = []
      for (const spec of RELIC_SLOTS) {
        const slotName = wikitextToText(field(fields, spec.name))
        const description = wikitextToText(field(fields, spec.description))
        const story = wikitextToText(field(fields, spec.story))
        if (slotName.length === 0 && description.length === 0 && story.length === 0) continue
        parts.push(omitUndefined({ slot: spec.slot, name: slotName, description, story }))
      }
      const storyParts = parts.filter((part) => part.story.length > 0)
      const content = storyParts
        .map((part) => `【${part.slot}】${part.name.length > 0 ? `${part.name}\n` : ''}${part.story}`)
        .join('\n\n')
      const entry = omitUndefined({
        name,
        category: s(card.params.param1) || wikitextToText(field(fields, '类别')),
        acquire: s(card.params.param2) || wikitextToText(field(fields, '获取方式', '获取途径')),
        version: s(card.params.param3) || wikitextToText(field(fields, '实装版本')),
        parts,
        content,
      })
      if (content.length === 0) {
        entry.empty = true
        emptyContent += 1
      }
      entries.push(entry)
    }
    if (withoutWikitext > 0) warnings.push(`${withoutWikitext} 遗器套装 detail pages had no wikitext (entries kept with empty content)`)
    if (withoutTemplate > 0) warnings.push(`${withoutTemplate} 遗器套装 pages had no {{遗器套装}} template`)
    if (emptyContent > 0) warnings.push(`${emptyContent} 遗器套装 have no *故事 text (marked empty: true)`)
    if (duplicateNames > 0) warnings.push(`${duplicateNames} duplicate 遗器套装 card names`)
    return {
      entries,
      excludedCount: 0,
      warnings,
      stats: { cards: cards.length, entries: entries.length, withWikitext: cards.length - withoutWikitext, emptyContent },
    }
  })
}

/** 光锥图鉴 — cards + `{{光锥图鉴}}` field 光锥故事. */
export function extractLightcones({ html, wikitextByTitle } = {}) {
  return safe('lightcones', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 光锥图鉴'], stats: {} }
    }
    const { cards, warnings } = scanCards(html, 'weapon-name')
    const wiki = wikitextByTitle !== null && typeof wikitextByTitle === 'object' ? wikitextByTitle : {}
    const entries = []
    let withoutWikitext = 0
    let withoutTemplate = 0
    let withoutStory = 0
    for (const card of cards) {
      const name = card.name
      if (name.length === 0) continue
      const wikitext = typeof wiki[name] === 'string' ? wiki[name] : ''
      const parsed = wikitext.length > 0 ? templateFields(wikitext, '光锥图鉴') : null
      if (wikitext.length === 0) withoutWikitext += 1
      else if (parsed === null) withoutTemplate += 1
      const fields = parsed === null ? null : parsed.fields
      const content = wikitextToText(field(fields, '光锥故事'))
      if (content.length === 0) withoutStory += 1
      const entry = omitUndefined({
        name,
        rarity: s(card.params.param1) || wikitextToText(field(fields, '稀有度')),
        path: s(card.params.param2) || wikitextToText(field(fields, '命途')),
        acquire: s(card.params.param3) || wikitextToText(field(fields, '获取方式', '获取途径')),
        version: s(card.params.param4) || wikitextToText(field(fields, '实装版本')),
        content,
      })
      if (content.length === 0) entry.empty = true
      entries.push(entry)
    }
    if (withoutWikitext > 0) warnings.push(`${withoutWikitext} 光锥 detail pages had no wikitext (entries kept with empty content)`)
    if (withoutTemplate > 0) warnings.push(`${withoutTemplate} 光锥 pages had no {{光锥图鉴}} template`)
    if (withoutStory > 0) warnings.push(`${withoutStory} 光锥 have no 光锥故事 (marked empty: true)`)
    return {
      entries,
      excludedCount: 0,
      warnings,
      stats: { cards: cards.length, entries: entries.length, withWikitext: cards.length - withoutWikitext, withoutStory },
    }
  })
}

/* ---------------------------------------------------------------- sections */

/** Sections excluded from 星神 / 派系 / 专有名词 (BRIEF §3.3). */
const AEON_EXCLUDE = ['目录', '星神总览', '参考资料']
const FACTION_EXCLUDE = ['目录', '派系总览', '参考链接']
const TERM_EXCLUDE = ['目录']

const isExcluded = (title, list) => list.some((entry) => title.includes(entry))

/** 星神 — one entry per h2 chapter (18 measured), content from table.wikitable. */
export function extractAeons({ html } = {}) {
  return safe('aeons', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 星神'], stats: {} }
    }
    const slices = sectionSlices(html, { levels: [2] })
    const entries = []
    const warnings = []
    let excludedCount = 0
    let emptyCount = 0
    let unsplit = 0
    for (const slice of slices) {
      if (isExcluded(slice.title, AEON_EXCLUDE)) {
        excludedCount += 1
        continue
      }
      const content = cleanText(slice.html, { blocks: true })
      if (content.length === 0) {
        emptyCount += 1
        continue
      }
      const split = /^「([^」]+)」\s*[，,]\s*(.+)$/.exec(slice.title)
      if (split === null) unsplit += 1
      entries.push(
        omitUndefined({
          name: slice.title,
          path: split === null ? '' : split[1].trim(),
          aeon: split === null ? '' : split[2].trim(),
          content,
        }),
      )
    }
    if (emptyCount > 0) warnings.push(`${emptyCount} 星神 chapters had empty content and were dropped`)
    if (unsplit > 0) warnings.push(`${unsplit} 星神 chapter titles could not be split into path/aeon`)
    return {
      entries,
      excludedCount,
      warnings,
      stats: { headings: slices.length, entries: entries.length },
    }
  })
}

/** 派系 — h2 = 命途 (path), h3 = 派系; both are entries. */
export function extractFactions({ html } = {}) {
  return safe('factions', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 派系'], stats: {} }
    }
    // `ownLevels: [2]` keeps a 命途 heading's own text only — otherwise every
    // parent would repeat all of its child 派系 sections.
    const slices = sectionSlices(html, { levels: [2, 3], ownLevels: [2] })
    const entries = []
    const warnings = []
    let excludedCount = 0
    let emptyCount = 0
    for (const slice of slices) {
      const isPath = slice.level === 2
      if (isPath && isExcluded(slice.title, FACTION_EXCLUDE)) {
        excludedCount += 1
        continue
      }
      const content = cleanText(slice.html, { blocks: true })
      const entry = omitUndefined({
        name: slice.title,
        path: isPath ? slice.title : slice.parent,
        content,
      })
      if (content.length === 0) {
        entry.empty = true
        emptyCount += 1
      }
      entries.push(entry)
    }
    if (emptyCount > 0) warnings.push(`${emptyCount} 派系 sections (命途 headings) have no body text (marked empty: true)`)
    return {
      entries,
      excludedCount,
      warnings,
      stats: {
        headings: slices.length,
        entries: entries.length,
        paths: slices.filter((slice) => slice.level === 2).length - excludedCount,
        factions: slices.filter((slice) => slice.level === 3).length,
      },
    }
  })
}

/** 专有名词 — h2 = 分类 (category), h3 = 词条; both are entries. */
export function extractTerms({ html } = {}) {
  return safe('terms', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 专有名词'], stats: {} }
    }
    // `ownLevels: [2]` keeps a 分类 heading's own intro only — the 词条 h3 sections
    // carry the term text.
    const slices = sectionSlices(html, { levels: [2, 3], ownLevels: [2] })
    const entries = []
    const warnings = []
    let excludedCount = 0
    let emptyCount = 0
    for (const slice of slices) {
      const isCategory = slice.level === 2
      if (isCategory && isExcluded(slice.title, TERM_EXCLUDE)) {
        excludedCount += 1
        continue
      }
      const content = cleanText(slice.html, { blocks: true })
      const entry = omitUndefined({
        name: slice.title,
        category: isCategory ? slice.title : slice.parent,
        content,
      })
      if (content.length === 0) {
        entry.empty = true
        emptyCount += 1
      }
      entries.push(entry)
    }
    if (emptyCount > 0) warnings.push(`${emptyCount} 专有名词 sections have no body text (marked empty: true)`)
    return {
      entries,
      excludedCount,
      warnings,
      stats: {
        headings: slices.length,
        entries: entries.length,
        categories: slices.filter((slice) => slice.level === 2).length - excludedCount,
        terms: slices.filter((slice) => slice.level === 3).length,
      },
    }
  })
}

/* -------------------------------------------------------------- tab panels */

/** 模拟宇宙 — 开发日志 inside the 模拟宇宙图鉴 → 星神 tab panels. */
export function extractSimuniverse({ html } = {}) {
  return safe('simuniverse', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 模拟宇宙'], stats: {} }
    }
    const warnings = []
    const all = headings(html)
    const startIndex = all.findIndex((heading) => heading.level === 2 && heading.title.includes('模拟宇宙图鉴'))
    let region = ''
    if (startIndex < 0) {
      warnings.push('h2 「模拟宇宙图鉴」 not found — falling back to a whole-page scan')
    } else {
      const next = all.slice(startIndex + 1).find((heading) => heading.level === 2)
      region = html.slice(all[startIndex].end, next === undefined ? html.length : next.index)
    }

    const collect = (source) => {
      const { blocks } = splitBlocks(source, RESP_TAB)
      // Tab labels look like `存护<br />克里珀`; the last line is the aeon name.
      const labels = classTexts(source, 'tab-panel').map((label) => label.split('\n').pop().trim())
      const found = []
      blocks.forEach((block, index) => {
        for (const segment of block.split(/<hr\s*\/?>/i)) {
          const content = cleanText(segment, { blocks: true })
          const marker = /开发日志\s*(\d+)/.exec(content)
          if (marker === null) continue
          const link = /关联条目\s*[-—－–]?\s*[「【]([^」】]+)[」】]/.exec(content)
          const path = link === null ? (labels[index] ?? '') : link[1].trim()
          found.push(
            omitUndefined({
              name: path.length > 0 ? `开发日志 · ${path}` : `开发日志${marker[1]}`,
              path,
              index: Number(marker[1]),
              content,
            }),
          )
        }
      })
      return found
    }

    let entries = region.length > 0 ? collect(region) : []
    if (entries.length === 0) {
      warnings.push('no 开发日志 segment inside the 模拟宇宙图鉴 region — falling back to a whole-page scan')
      entries = collect(html)
    }
    if (entries.length === 0) {
      warnings.push('no 开发日志 segment found on the page at all')
    }
    return {
      entries,
      excludedCount: 0,
      warnings,
      stats: { regionChars: region.length, entries: entries.length },
    }
  })
}

/* -------------------------------------------------------------------- page */

/** 星际和平播报 — whole page + one entry per h4 chapter; keeps 女声/男声/（音乐）. */
export function extractBroadcast({ html } = {}) {
  return safe('broadcast', () => {
    if (typeof html !== 'string' || html.length === 0) {
      return { entries: [], excludedCount: 0, warnings: ['no html supplied for 星际和平播报'], stats: {} }
    }
    const warnings = []
    const body = stripPageChrome(html)
    const raw = cleanText(body, { blocks: true })
    const entries = []
    if (raw.length > 0) entries.push({ name: '全文', content: raw })
    const slices = sectionSlices(html, { levels: [4] })
    for (const slice of slices) {
      const content = cleanText(slice.html, { blocks: true })
      if (content.length === 0) continue
      entries.push(omitUndefined({ name: slice.title, content }))
    }
    if (slices.length === 0) warnings.push('no h4 chapter found on 星际和平播报')
    if (raw.length === 0) warnings.push('page body text is empty after chrome removal')
    return {
      entries,
      excludedCount: 0,
      warnings,
      stats: { chapters: slices.length, rawChars: raw.length, entries: entries.length },
    }
  })
}

/* --------------------------------------------------------------- registry */

/** id → extractor (BRIEF §2 order). */
export const EXTRACTORS = {
  relics: extractRelics,
  lightcones: extractLightcones,
  consumables: extractConsumables,
  decorations: extractDecorations,
  aeons: extractAeons,
  factions: extractFactions,
  terms: extractTerms,
  simuniverse: extractSimuniverse,
  curios: extractCurios,
  events: extractEvents,
  equations: extractEquations,
  broadcast: extractBroadcast,
}

/** Detail-title scanners for the wikitext-backed datasets. */
export const DETAIL_TITLE_EXTRACTORS = {
  relics: relicDetailTitles,
  lightcones: lightconeDetailTitles,
}

/**
 * Run one extractor by dataset id.
 *
 * @param {string} id
 * @param {{html?: string, wikitextByTitle?: Record<string, string>, ctx?: object}} input
 */
export function extractDataset(id, input = {}) {
  const extractor = EXTRACTORS[id]
  if (typeof extractor !== 'function') {
    return { entries: [], excludedCount: 0, warnings: [`unknown dataset id: ${s(id)}`], stats: {} }
  }
  return extractor(input)
}

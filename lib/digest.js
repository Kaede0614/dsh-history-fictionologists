/**
 * Model-facing material digests for dsh-history-fictionologists.
 *
 * Four digests feed the `/gs` prompt pipeline (BRIEF §6 + §8):
 *   - `equationNameDigest`  — how the game names things (macro concept × mundane object);
 *   - `missionDigest`       — "已发生故事" so a new story does not collide with them;
 *   - `bookDigest`          — the 「书架」 writing style;
 *   - `broadcastDigest`     — the 星际和平播报 speaker-line format + real excerpts.
 *
 * Every digest returns `{ ok, markdown, warnings, truncated }`; `markdown` is
 * ready to paste into a prompt and never exceeds ~12000 chars. Failures never
 * throw and never return an empty-but-successful markdown: a short bracketed
 * note explains what is missing and which tool fixes it.
 *
 * @module dsh-history-fictionologists/lib/digest
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { cacheDir, missionsDir, resolveWorkspace } from './paths.js'
import { catalogBooks, loadSeries, scanMissions } from './missions.js'

// ---------------------------------------------------------------- constants
const EQUATIONS_FILE = 'equations.json'
const BROADCAST_FILE = 'broadcast.json'
const BOOKS_FILE = 'books_without_amphoreus.json'

const MAX_MARKDOWN = 12000
const EQUATION_NAMES_DEFAULT = 160
const EQUATION_EXAMPLES_DEFAULT = 12
const EQUATION_EXAMPLE_CHARS = 70
const MISSION_DIGEST_LIMIT_DEFAULT = 40
const MISSION_LINE_CHARS = 96
const BOOK_DIGEST_LIMIT_DEFAULT = 25
const BOOK_LINE_CHARS = 120
const BROADCAST_EXCERPT_CHARS = 900
const BROADCAST_EXCERPTS = 3

/** BRIEF §8 功能 3 — the broadcast format, verbatim. */
const FORMAT_TEMPLATE = [
  '（音乐）',
  '',
  '女声：这里是星际和平播报，观众朋友们晚上好。',
  '男声：晚上好。',
  '',
  '女声：第一条消息。……',
  '男声：第二条消息。……',
  '',
  '女声：本次播报到此结束，请在指定时间收听下一周期的星际和平播报。',
  '（音乐）',
].join('\n')

// ------------------------------------------------------------------ helpers
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function str(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return String(value)
}

/** Markup residue guard — same whitelist as lib/missions.js. */
const HTML_TAG_RE = /<\/?(?:br|hr|p|div|span|b|i|u|s|em|strong|small|big|font|sup|sub|tt|ul|ol|li|table|thead|tbody|tr|td|th|a|img|center|code|pre|blockquote|nowiki|ref|ruby|rt|rb)\b[^>]{0,200}>/gi

function oneLine(value) {
  return str(value).replace(HTML_TAG_RE, '').replace(/\s+/g, ' ').trim()
}

function clip(value, max) {
  const text = oneLine(value)
  if (max <= 0) return { text: '', truncated: text.length > 0 }
  if (text.length <= max) return { text, truncated: false }
  return { text: ellipsize(text, max), truncated: true }
}

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

/** First sentence (or two) of a description, bounded. */
function firstSentence(value, max) {
  const text = oneLine(value)
  if (text.length === 0) return ''
  const match = /^[^。！？!?]*[。！？!?]/.exec(text)
  const head = match === null ? text : match[0]
  return ellipsize(head, max)
}

function positiveInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.floor(n), min), max)
}

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

function workspaceOf(cfg) {
  const config = cfg !== null && typeof cfg === 'object' ? cfg : {}
  return resolveWorkspace(config)
}

function safeCacheDir(cfg) {
  try {
    return cacheDir(workspaceOf(cfg))
  } catch {
    return ''
  }
}

function readJsonFile(file) {
  try {
    if (!existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
    const value = JSON.parse(readFileSync(file, 'utf8'))
    let bytes = 0
    try {
      bytes = statSync(file).size
    } catch {
      bytes = 0
    }
    return { ok: true, value, bytes }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/** Human-readable "why is this digest empty" line, still safe to paste. */
function unavailable(what, reason, fix) {
  return `（本插件当前没有可用的${what}素材：${reason}${fix === undefined ? '' : `。${fix}`}）`
}

function finalize(sections, warnings, extras = {}) {
  let markdown = sections.filter((section) => typeof section === 'string' && section.length > 0).join('\n\n')
  let truncated = false
  if (markdown.length > MAX_MARKDOWN) {
    markdown = `${markdown.slice(0, MAX_MARKDOWN - 1)}…`
    truncated = true
    warnings.push(`素材超过 ${MAX_MARKDOWN} 字上限，已截断`)
  }
  return prune({ ok: true, ...extras, markdown, truncated, warnings })
}

function groupCounts(items, keyOf) {
  const map = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (key.length === 0) continue
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
}

function formatCounts(pairs, max = 12) {
  return pairs.slice(0, max).map(([key, count]) => `${key} ${count}`).join(' · ')
}

// ----------------------------------------------------------- equation digest
/**
 * Naming-logic digest from `hsr-worldview-cache/equations.json` (BRIEF §3.3).
 * Degrades to a warning note when the cache does not exist yet.
 *
 * @param {{workspace?: string}} [cfg]
 * @param {{limit?: number, examples?: number}} [options]
 *   `limit` caps the names listed per path group (default 160),
 *   `examples` is clamped to 10–15 worked examples (default 12).
 */
export function equationNameDigest(cfg = {}, options = {}) {
  try {
    return equationNameDigestImpl(cfg, options)
  } catch (error) {
    return {
      ok: false,
      markdown: unavailable('方程命名', `生成摘要时出错（${messageOf(error)}）`),
      truncated: false,
      warnings: [`equationNameDigest 异常：${messageOf(error)}`],
    }
  }
}

function equationNameDigestImpl(cfg, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const warnings = []
  const dir = safeCacheDir(cfg)
  const file = join(dir, EQUATIONS_FILE)
  const read = readJsonFile(file)
  if (!read.ok) {
    warnings.push(`方程缓存不可用：${read.error}`)
    return {
      ok: false,
      markdown: unavailable('方程命名', read.error, '请先运行 gs_update 抓取「方程一览」数据集'),
      truncated: false,
      warnings,
    }
  }

  const root = read.value
  const rawEntries = Array.isArray(root) ? root : Array.isArray(root?.entries) ? root.entries : []
  if (rawEntries.length === 0) {
    warnings.push('方程缓存里没有 entries 数组')
    return {
      ok: false,
      markdown: unavailable('方程命名', '缓存文件里没有 entries', '请运行 gs_update 重新抓取'),
      truncated: false,
      warnings,
    }
  }
  const entries = []
  for (const item of rawEntries) {
    const source = item !== null && typeof item === 'object' ? item : {}
    const name = oneLine(source.name ?? source['名称'])
    if (name.length === 0) continue
    entries.push({
      name,
      rarity: oneLine(source.rarity ?? source['稀有度']),
      primary: oneLine(source.pathPrimary ?? source['主要命途'] ?? source['主命途']),
      secondary: oneLine(source.pathSecondary ?? source['次要命途'] ?? source['次命途']),
      blessing: oneLine(source.blessing ?? source['需要祝福']),
      content: oneLine(source.content ?? source['效果'] ?? source['内容']),
      mode: oneLine(source.mode ?? source['模式']),
    })
  }
  if (entries.length === 0) {
    warnings.push('方程缓存里的条目都缺少名称')
    return {
      ok: false,
      markdown: unavailable('方程命名', '缓存条目缺少 name 字段', '请运行 gs_update 重新抓取'),
      truncated: false,
      warnings,
    }
  }

  const limit = positiveInt(opts.limit, EQUATION_NAMES_DEFAULT)
  const exampleCount = Math.min(clampInt(opts.examples, EQUATION_EXAMPLES_DEFAULT, 10, 15), entries.length)
  const excludedCount = Number(root?.excludedCount)
  const modes = groupCounts(entries, (entry) => entry.mode)
  const rarities = groupCounts(entries, (entry) => entry.rarity)
  const paths = groupCounts(entries, (entry) => entry.primary)
  const lengths = groupCounts(entries, (entry) => String(entry.name.length))
  const lengthPairs = lengths.map(([key, value]) => [Number(key), value]).sort((a, b) => a[0] - b[0])
  const shortest = lengthPairs.length > 0 ? lengthPairs[0][0] : 0
  const longest = lengthPairs.length > 0 ? lengthPairs[lengthPairs.length - 1][0] : 0
  const commonest = lengthPairs.length > 0
    ? lengthPairs.reduce((best, pair) => (pair[1] > best[1] ? pair : best), lengthPairs[0])[0]
    : 0
  const suffixes = groupCounts(entries, (entry) => (entry.name.length >= 2 ? entry.name.slice(-1) : ''))
  const graftNames = entries.filter((entry) => entry.name.includes('的')).length

  const byPath = new Map()
  for (const entry of entries) {
    const key = entry.primary.length > 0 ? entry.primary : '未标注'
    if (!byPath.has(key)) byPath.set(key, [])
    byPath.get(key).push(entry)
  }
  const pathOrder = [...byPath.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-Hans-CN'))

  const sections = []
  sections.push('## 方程命名逻辑（现实素材，勿凭空编造）')
  sections.push([
    `- 条目：${entries.length} 条（来源 ${EQUATIONS_FILE}${Number.isFinite(excludedCount) ? `，缓存记录 excludedCount=${excludedCount}` : ''}）`,
    modes.length > 0 ? `- 模式：${formatCounts(modes, 6)}` : '',
    rarities.length > 0 ? `- 稀有度：${formatCounts(rarities, 6)}` : '',
    paths.length > 0 ? `- 主命途：${formatCounts(paths, 12)}` : '',
    lengthPairs.length > 0
      ? `- 名称长度：${shortest}–${longest} 字（${lengths.slice(0, 8).map(([key, value]) => `${key}字 ${value}`).join(' · ')}）`
      : '',
  ].filter((line) => line.length > 0).join('\n'))

  sections.push([
    '### 命名公式（从实测名称归纳）',
    '1. 名称 =〈宏大概念〉×〈俗世载体〉的硬嫁接：命途给出哲学概念（虚无 / 欢愉 / 繁育 / 记忆 / 智识…），名称给出极其日常的载体（奶奶 / 船长 / 大剧院 / 车轮 / 出租屋）。',
    `2. 名称极短：${shortest}–${longest} 字，以 ${commonest} 字为主；几乎不用「的」（仅 ${graftNames} 条）。`,
    suffixes.length > 0
      ? `3. 高频结尾（职业 / 身份后缀）：${formatCounts(suffixes, 8)} —— 先定一个「俗世身份」，再把它塞进宏大机制里。`
      : '3. 高频以职业 / 身份后缀收尾（…者 / …人 / …师 / …侠）。',
    '4. 稀有度越高，名称越靠近「概念本身的具象化」（4 星多为机构或概念实体），1 星最俗、最像身边小人物。',
    '5. 结构上先写「配方」再写名称：需要祝福用〈命途×数量〉叠加，如「虚无×6 / 欢愉×4」——概念越宏大，占位越多。',
    '6. 效果正文 100–200 字，用最严肃的机制语言描述最离谱的意象（见下方范例）。',
  ].join('\n'))

  const groupLines = ['### 按主命途分组（名称【稀有度·次命途】）']
  let listed = 0
  for (const [path, list] of pathOrder) {
    if (listed >= limit) break
    const room = limit - listed
    const shown = list.slice(0, room)
    const secondaries = [...new Set(list.map((entry) => entry.secondary).filter((value) => value.length > 0))]
    const names = shown.map((entry) => {
      const tags = [entry.rarity, entry.secondary].filter((value) => value.length > 0).join('·')
      return tags.length > 0 ? `${entry.name}【${tags}】` : entry.name
    })
    listed += shown.length
    const head = `- **${path}**（${list.length} 条${secondaries.length > 0 ? `；次命途：${secondaries.slice(0, 8).join('/')}` : ''}）：`
    groupLines.push(`${head}${names.join('、')}${list.length > shown.length ? ' …' : ''}`)
  }
  if (listed < limit) groupLines.push('')
  sections.push(groupLines.filter((line) => line.length > 0).join('\n'))

  // Worked examples: one per primary path first, then the most conceptual rarities.
  const picked = []
  const seen = new Set()
  const push = (entry) => {
    if (entry === undefined || seen.has(entry.name) || picked.length >= exampleCount) return
    seen.add(entry.name)
    picked.push(entry)
  }
  for (const [path] of pathOrder) {
    if (picked.length >= exampleCount) break
    push(entries.find((entry) => (entry.primary.length > 0 ? entry.primary : '未标注') === path))
  }
  for (const rarity of ['4星', '3星', '2星', '1星']) {
    for (const entry of entries) {
      if (picked.length >= exampleCount) break
      if (entry.rarity === rarity) push(entry)
    }
  }
  for (const entry of entries) push(entry)

  const exampleLines = [`### 嫁接范例（${picked.length} 条：宏大概念 × 俗世载体）`]
  picked.forEach((entry, index) => {
    const concept = [entry.primary, entry.secondary].filter((value) => value.length > 0).join(' / ') || '未标注'
    const recipe = entry.blessing.length > 0 ? `配方 ${entry.blessing}` : '配方未记录'
    const effect = clip(entry.content, EQUATION_EXAMPLE_CHARS)
    const tag = entry.rarity.length > 0 ? `${entry.rarity} · ` : ''
    exampleLines.push(`${index + 1}. ${tag}${concept}｜${recipe} → 「${entry.name}」${effect.text.length > 0 ? `：${effect.text}` : ''}`)
  })
  sections.push(exampleLines.join('\n'))

  return finalize(sections, warnings, {
    file,
    count: entries.length,
    examples: picked.length,
    paths: pathOrder.map(([path, list]) => ({ path, count: list.length })),
  })
}

// ------------------------------------------------------------ mission digest
/**
 * "已发生故事" digest: series → mission names + one-line descriptions.
 * Also backs the `gs_missions` tool, hence `{ series, query, limit }` and the
 * `seriesCount` / `missionCount` totals.
 *
 * @param {{workspace?: string}} [cfg]
 * @param {{series?: string, query?: string, limit?: number}} [options]
 */
export function missionDigest(cfg = {}, options = {}) {
  try {
    return missionDigestImpl(cfg, options)
  } catch (error) {
    return {
      ok: false,
      markdown: unavailable('既有故事', `生成摘要时出错（${messageOf(error)}）`),
      seriesCount: 0,
      missionCount: 0,
      truncated: false,
      warnings: [`missionDigest 异常：${messageOf(error)}`],
    }
  }
}

function missionDigestImpl(cfg, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const warnings = []
  const wanted = oneLine(opts.series)
  const query = oneLine(opts.query)
  const limit = positiveInt(opts.limit, MISSION_DIGEST_LIMIT_DEFAULT)

  const scan = scanMissions(cfg)
  if (!scan.ok) {
    warnings.push(...(scan.warnings ?? []))
    return {
      ok: false,
      markdown: unavailable('既有故事（hsr-missions）', (scan.warnings ?? []).join('；') || '未读取到数据', '请检查工作区里的 hsr-missions 目录'),
      seriesCount: 0,
      missionCount: 0,
      truncated: false,
      warnings,
    }
  }

  let selected = scan.series ?? []
  if (wanted.length > 0) {
    selected = selected.filter((item) => item.name === wanted)
    if (selected.length === 0) selected = (scan.series ?? []).filter((item) => item.name.includes(wanted) || wanted.includes(item.name))
    if (selected.length === 0) {
      const available = (scan.series ?? []).map((item) => item.name)
      warnings.push(`没有名为「${wanted}」的系列`)
      return {
        ok: false,
        markdown: unavailable(`系列「${wanted}」`, '系列名不匹配', `可用系列：${available.join(' / ')}`),
        available,
        seriesCount: 0,
        missionCount: 0,
        truncated: false,
        warnings,
      }
    }
  }

  const sections = []
  const details = []
  let totalMissions = 0
  let returned = 0
  let anyTruncated = false
  for (const item of selected) {
    const detail = loadSeries(cfg, item.name)
    if (!detail.ok) {
      warnings.push(...(detail.warnings ?? []))
      const names = (item.missions ?? []).map((mission) => mission.name)
      details.push({ name: item.name, region: item.region, version: item.version, missions: names.map((name) => ({ name })) })
      totalMissions += names.length
      continue
    }
    let missions = detail.missions ?? []
    if (query.length > 0) {
      missions = missions.filter((mission) => mission.name.includes(query)
        || str(mission.description).includes(query)
        || (mission.characters ?? []).some((name) => name.includes(query)))
    }
    totalMissions += missions.length
    details.push({ name: item.name, region: detail.region ?? item.region, version: detail.version ?? item.version, missions })
  }

  sections.push('## 已发生故事（避免与下列内容冲突）')
  sections.push([
    `- 数据：hsr-missions / sr-开拓续闻-完整（${selected.length} 个系列，${totalMissions} 个任务）`,
    '- 用法：新故事可以复用世界观名词与既有角色，但不得复述下列任务的事件、改写其结局，也不得让同名角色出现在矛盾的时间线上。',
  ].join('\n'))

  for (const detail of details) {
    const head = [`### ${detail.name}`]
    const meta = [detail.region, detail.version].filter((value) => typeof value === 'string' && value.length > 0)
    if (meta.length > 0) head.push(`（${meta.join(' · ')}，${detail.missions.length} 个任务）`)
    else head.push(`（${detail.missions.length} 个任务）`)
    const lines = [head.join('')]
    if (returned >= limit) {
      lines.push(`- …（${detail.missions.length} 个任务，因上限 ${limit} 未列出）`)
      anyTruncated = true
      sections.push(lines.join('\n'))
      continue
    }
    let shownHere = 0
    for (const mission of detail.missions) {
      if (returned >= limit) break
      const summary = firstSentence(mission.description ?? mission.objective, MISSION_LINE_CHARS)
      lines.push(summary.length > 0 ? `- **${mission.name}** —— ${summary}` : `- **${mission.name}**`)
      returned += 1
      shownHere += 1
    }
    if (shownHere < detail.missions.length) {
      lines.push(`- …（本系列另有 ${detail.missions.length - shownHere} 个任务未列出）`)
      anyTruncated = true
    }
    sections.push(lines.join('\n'))
  }
  if (returned >= limit && details.reduce((n, detail) => n + detail.missions.length, 0) > returned) anyTruncated = true
  if (anyTruncated) warnings.push(`条目上限 ${limit}，已省略部分任务`)

  return finalize(sections, warnings, {
    seriesCount: selected.length,
    missionCount: totalMissions,
    returned,
    limit,
    ...(anyTruncated ? { truncatedByLimit: true } : {}),
  })
}

// --------------------------------------------------------------- book digest
/**
 * 「书架」 style digest: title + 类型 + 描述 of N books (default 25), picked
 * round-robin across 类型 so every kind of in-world document shows up.
 *
 * @param {{workspace?: string}} [cfg]
 * @param {{limit?: number}} [options]
 */
export function bookDigest(cfg = {}, options = {}) {
  try {
    return bookDigestImpl(cfg, options)
  } catch (error) {
    return {
      ok: false,
      markdown: unavailable('书架', `生成摘要时出错（${messageOf(error)}）`),
      truncated: false,
      warnings: [`bookDigest 异常：${messageOf(error)}`],
    }
  }
}

function bookDigestImpl(cfg, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  const warnings = []
  const limit = positiveInt(opts.limit, BOOK_DIGEST_LIMIT_DEFAULT)
  const catalogue = catalogBooks(cfg)
  if (!catalogue.ok) {
    warnings.push(...(catalogue.warnings ?? []))
    return {
      ok: false,
      markdown: unavailable('书架', (catalogue.warnings ?? []).join('；') || '未读取到书目', `请检查 ${BOOKS_FILE}`),
      truncated: false,
      warnings,
    }
  }

  const books = catalogue.books ?? []
  const groups = new Map()
  for (const book of books) {
    const key = typeof book.type === 'string' && book.type.length > 0 ? book.type : '未分类'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(book)
  }
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'zh-Hans-CN'))
  const picked = []
  for (let index = 0; picked.length < limit; index += 1) {
    let added = false
    for (const [, list] of order) {
      if (index >= list.length) continue
      picked.push(list[index])
      added = true
      if (picked.length >= limit) break
    }
    if (!added) break
  }

  const typeCounts = groupCounts(books, (book) => str(book.type))
  const regionCounts = groupCounts(books, (book) => str(book.region))
  const sections = []
  sections.push('## 「书架」风格素材（现实素材，勿凭空编造）')
  sections.push([
    `- 书目：${catalogue.count} 本（来源 ${BOOKS_FILE}），本条摘要节选 ${picked.length} 本`,
    typeCounts.length > 0 ? `- 类型分布：${formatCounts(typeCounts, 12)}` : '',
    regionCounts.length > 0 ? `- 地区分布：${formatCounts(regionCounts, 8)}` : '',
  ].filter((line) => line.length > 0).join('\n'))

  sections.push([
    '### 风格要点（从实测书目归纳）',
    '1. 标题是「世界内文档」的抬头：机构公文（〈「黑塔」资产定损清单〉）、通俗读物、私人信件、磁带转录、石碑铭文——先决定「这是什么文书」，再写内容。',
    '2. 文体由类型决定：资料/信件/便条用第一人称或公文口吻；磁带、录像带用逐字记录；书籍可以像科普或传记。',
    '3. 荒诞来自「极认真的格式 × 极不合理的内容」：工整的编号、定损程度、保险金额，配「功能倒错，性状颠倒」这种一本正经的判定。',
    '4. 描述（卡片摘要）用一句话交代「谁写的、写了什么、离谱在哪」，不加评论、不玩梗。',
    '5. 篇幅可长可短：正文可以是一份完整清单，也可以只有两三行残句。',
  ].join('\n'))

  const lines = ['### 书目样例（标题｜类型｜地区｜相关角色）']
  for (const book of picked) {
    const meta = [book.type, book.region, book.characters].filter((value) => typeof value === 'string' && value.length > 0)
    lines.push(`- **${book.title}**${meta.length > 0 ? `｜${meta.join('｜')}` : ''}`)
    const description = clip(book.description, BOOK_LINE_CHARS)
    if (description.text.length > 0) lines.push(`  > ${description.text}`)
  }
  sections.push(lines.join('\n'))

  return finalize(sections, warnings, {
    file: catalogue.file,
    count: catalogue.count,
    returned: picked.length,
    types: typeCounts.map(([type, count]) => ({ type, count })),
  })
}

// ---------------------------------------------------------- broadcast digest
/**
 * 星际和平播报 digest from `hsr-worldview-cache/broadcast.json`: the speaker
 * line convention, real excerpts and the exact `formatTemplate` of BRIEF §8.
 *
 * @param {{workspace?: string}} [cfg]
 */
export function broadcastDigest(cfg = {}) {
  try {
    return broadcastDigestImpl(cfg)
  } catch (error) {
    return {
      ok: false,
      markdown: unavailable('播报格式', `生成摘要时出错（${messageOf(error)}）`),
      formatTemplate: FORMAT_TEMPLATE,
      truncated: false,
      warnings: [`broadcastDigest 异常：${messageOf(error)}`],
    }
  }
}

function broadcastDigestImpl(cfg) {
  const warnings = []
  const file = join(safeCacheDir(cfg), BROADCAST_FILE)
  const read = readJsonFile(file)
  if (!read.ok) {
    warnings.push(`播报缓存不可用：${read.error}`)
    return {
      ok: false,
      markdown: unavailable('播报格式', read.error, '请先运行 gs_update 抓取「星际和平播报」数据集'),
      formatTemplate: FORMAT_TEMPLATE,
      truncated: false,
      warnings,
    }
  }

  const root = read.value
  const rawText = typeof root?.raw === 'string' ? root.raw : ''
  let entries = []
  if (Array.isArray(root?.entries)) entries = root.entries
  else if (Array.isArray(root?.items)) entries = root.items
  else if (Array.isArray(root?.segments)) entries = root.segments
  else if (Array.isArray(root)) entries = root
  const segments = []
  for (const item of entries) {
    const source = item !== null && typeof item === 'object' ? item : {}
    const name = oneLine(source.name ?? source['名称'])
    const content = str(source.content ?? source['内容']).trim()
    if (content.length === 0) continue
    segments.push({ name: name.length > 0 ? name : '全文', content })
  }
  if (segments.length === 0 && rawText.trim().length > 0) segments.push({ name: '全文', content: rawText.trim() })
  if (segments.length === 0) {
    warnings.push('播报缓存里既没有 entries 也没有 raw 文本')
    return {
      ok: false,
      markdown: unavailable('播报格式', '缓存文件里没有可用的播报文本', '请运行 gs_update 重新抓取'),
      formatTemplate: FORMAT_TEMPLATE,
      truncated: false,
      warnings,
    }
  }

  const all = segments.map((segment) => segment.content).join('\n')
  const count = (pattern) => (all.match(pattern) ?? []).length
  const speakers = {
    music: count(/（音乐）/g),
    female: count(/(?:^|[\n\r])\s*女声\s*[:：]/g),
    male: count(/(?:^|[\n\r])\s*男声\s*[:：]/g),
  }

  const SPEAKER_LINE = /(?:^|[\n\r])\s*(?:女声|男声)\s*[:：]/
  const excerpts = []
  const seen = new Set()
  // Speaker segments first — a page-chrome segment must never outrank real播报.
  for (const segment of segments) {
    if (excerpts.length >= BROADCAST_EXCERPTS) break
    if (seen.has(segment.name) || !SPEAKER_LINE.test(segment.content)) continue
    seen.add(segment.name)
    excerpts.push(segment)
  }
  for (const segment of segments) {
    if (excerpts.length >= BROADCAST_EXCERPTS) break
    if (seen.has(segment.name)) continue
    seen.add(segment.name)
    excerpts.push(segment)
  }
  if (excerpts.length > 0 && !SPEAKER_LINE.test(excerpts[0].content)) {
    warnings.push('播报缓存里没有检测到「女声：/男声：」说话人行，片段可能包含页面噪声')
  }

  let anyTruncated = false
  const excerptBlocks = []
  for (const segment of excerpts) {
    const clipped = clipRaw(segment.content, BROADCAST_EXCERPT_CHARS)
    if (clipped.truncated) anyTruncated = true
    excerptBlocks.push(`**〈${segment.name}〉**\n${clipped.text}`)
  }
  if (anyTruncated) warnings.push(`真实片段已按 ${BROADCAST_EXCERPT_CHARS} 字上限截断`)

  const sections = []
  sections.push('## 星际和平播报 · 格式与语调（现实素材）')
  sections.push([
    '- 说话人一律「女声：」「男声：」（全角冒号），一行一句，交替播报；旁白、音乐提示用全角括号「（音乐）」。',
    '- 每条新闻一段，不加 Markdown 标题、不加序号前缀；结尾固定为「本次播报到此结束，请在指定时间收听下一周期的星际和平播报。」',
    `- 实测统计：${segments.length} 段文本；女声 ${speakers.female} 次 · 男声 ${speakers.male} 次 · （音乐）${speakers.music} 次。`,
    '- 语调：一本正经的官方播报腔，内容可以离谱，措辞必须像新闻稿（机构名、纪年、公告动词）。',
  ].join('\n'))
  sections.push(['### 必须逐字照用的格式模板', '```text', FORMAT_TEMPLATE, '```'].join('\n'))
  sections.push(['### 真实片段（照抄语感，不要照抄内容）', excerptBlocks.join('\n\n')].join('\n'))

  return finalize(sections, warnings, {
    file,
    formatTemplate: FORMAT_TEMPLATE,
    entryCount: segments.length,
    excerptTruncated: anyTruncated,
    speakers,
    excerpts: excerpts.map((segment) => ({ name: segment.name, chars: segment.content.length })),
  })
}

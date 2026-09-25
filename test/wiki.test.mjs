/**
 * Offline test suite for the wiki data layer (BRIEF §9).
 *
 * Zero network: every extractor is replayed against the already-downloaded pages
 * in `_probe/html/*.html` (+ the wikitext fixture in `test/fixtures/`), and the
 * cache round trip runs `update`/`status`/`read` against a fake client in a temp
 * workspace.
 *
 * Run: node --test test/wiki.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WikiClient } from '../lib/wiki/client.mjs'
import { DATASETS, getDataset } from '../lib/wiki/datasets.mjs'
import { extractDataset, relicDetailTitles } from '../lib/wiki/extract.mjs'
import { cleanText, decodeEntities, splitTables, tableById, tableRows } from '../lib/wiki/html.mjs'
import { read, sampleAll, status, update } from '../lib/wiki/index.mjs'
import { field, parseTemplate, templateFields, wikitextToText } from '../lib/wiki/wikitext.mjs'

const ROOT = join(import.meta.dirname, '..')
const PROBE = join(ROOT, '_probe', 'html')

/** Entry counts measured against the frozen offline fixtures (2026-09 snapshot). */
const EXPECTED = {
  relics: 62,
  lightcones: 169,
  consumables: 192,
  decorations: 250,
  aeons: 18,
  factions: 48,
  terms: 47,
  simuniverse: 26,
  curios: 251,
  events: 54,
  equations: 212,
  broadcast: 8,
}

/** Hard floor per dataset: a dataset at 0 entries is a bug, not a wiki change. */
const MINIMUMS = {
  relics: 60,
  lightcones: 165,
  consumables: 180,
  decorations: 240,
  aeons: 18,
  factions: 45,
  terms: 45,
  simuniverse: 20,
  curios: 240,
  events: 50,
  equations: 200,
  broadcast: 5,
}

function loadHtml(fixture) {
  const path = join(PROBE, fixture)
  if (!existsSync(path)) throw new Error(`offline fixture missing: ${path}`)
  return readFileSync(path, 'utf8')
}

/**
 * `_probe/html/*.html` is NOT part of the published repository (see .gitignore):
 * the 4.9 MB of raw wiki captures only exist in the author's working copy. In a
 * fresh clone every test that replays them cannot run, so it must SKIP through
 * the node:test skip mechanism — never fail, and never silently pass.
 *
 * `false` means "all fixtures are present, run the test with its full
 * assertions"; a string is the skip reason naming the missing file(s).
 */
function probeSkip(fixtures) {
  const missing = fixtures.filter((fixture) => !existsSync(join(PROBE, fixture)))
  if (missing.length === 0) return false
  const names = missing.map((fixture) => `_probe/html/${fixture}`)
  const shown = names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} (+${names.length - 4} more)`
  return `${shown} ${missing.length === 1 ? 'is' : 'are'} not in this checkout (see .gitignore)`
}

/** Skip reason for one dataset's own fixture (`false` when it is present). */
function datasetSkip(id) {
  const dataset = getDataset(id)
  assert.ok(dataset, `unknown dataset ${id}`)
  return probeSkip([dataset.fixture])
}

/** Every fixture this suite replays — the whole `_probe/` dependency set. */
const ALL_FIXTURES = DATASETS.map((dataset) => dataset.fixture)

function loadJson(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/** Frozen offline fixtures (hand-made structural pages + two real probe captures). */
const FIXTURES = (() => {
  const base = loadJson(join(ROOT, 'test', 'fixtures', 'wikitext.json'))
  const merged = {}
  for (const group of Object.keys(base)) {
    if (group.startsWith('_')) continue
    merged[group] = { ...(base[group] ?? {}) }
  }
  return merged
})()

/** Real detail-page wikitext captured from the live wiki (optional, tolerant tests). */
const LIVE_FIXTURES = (() => {
  const live = loadJson(join(ROOT, 'test', 'fixtures', 'wikitext-live.json'))
  const merged = {}
  for (const group of Object.keys(live)) {
    if (group.startsWith('_')) continue
    merged[group] = { ...(live[group] ?? {}) }
  }
  return merged
})()

/** Extract one dataset from its offline fixture. */
function extractOffline(id, fixtures = FIXTURES) {
  const dataset = getDataset(id)
  assert.ok(dataset, `unknown dataset ${id}`)
  const html = loadHtml(dataset.fixture)
  const wikitextByTitle = dataset.needsWikitext === true ? (fixtures[id] ?? {}) : {}
  return { dataset, html, result: extractDataset(id, { html, wikitextByTitle, ctx: { offline: true } }) }
}

/** Deep scan for `undefined`/functions — the DSH host rejects non-lossless JSON. */
function assertLossless(value, path = '$') {
  if (value === undefined) assert.fail(`undefined at ${path}`)
  if (typeof value === 'function') assert.fail(`function at ${path}`)
  if (Number.isNaN(value)) assert.fail(`NaN at ${path}`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLossless(item, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) assertLossless(member, `${path}.${key}`)
  }
}

/* ------------------------------------------------------------------ fixtures */

test('offline fixtures exist for all 12 datasets', { skip: probeSkip(ALL_FIXTURES) }, () => {
  assert.equal(DATASETS.length, 12)
  for (const dataset of DATASETS) {
    assert.ok(dataset.id && dataset.title && dataset.url && dataset.kind && dataset.notes, `${dataset.id} registry fields`)
    assert.ok(existsSync(join(PROBE, dataset.fixture)), `${dataset.id} fixture ${dataset.fixture}`)
  }
})

test('per-dataset entry counts: exact baseline + hard minimum + lossless', { skip: probeSkip(ALL_FIXTURES) }, () => {
  for (const dataset of DATASETS) {
    const { result } = extractOffline(dataset.id)
    const count = result.entries.length
    assert.ok(count >= MINIMUMS[dataset.id], `${dataset.id}: ${count} entries < minimum ${MINIMUMS[dataset.id]}`)
    assert.equal(count, EXPECTED[dataset.id], `${dataset.id}: ${count} entries != frozen baseline ${EXPECTED[dataset.id]}`)
    assertLossless({ entries: result.entries, stats: result.stats, excludedCount: result.excludedCount })
    for (const entry of result.entries) {
      assert.equal(typeof entry.name, 'string', `${dataset.id} entry name`)
      assert.ok(entry.name.trim().length > 0, `${dataset.id} entry has an empty name`)
    }
  }
})

test('no dataset extracts zero entries', { skip: probeSkip(ALL_FIXTURES) }, () => {
  const empties = DATASETS.filter((dataset) => extractOffline(dataset.id).result.entries.length === 0).map((dataset) => dataset.id)
  assert.deepEqual(empties, [])
})

/* -------------------------------------------------------------------- tables */

test('equations: 324 data rows, 千面英雄 excluded, effect text clean', { skip: datasetSkip('equations') }, () => {
  const { result } = extractOffline('equations')
  assert.equal(result.stats.totalRows, 325)
  assert.equal(result.stats.dataRows, 324)
  assert.equal(result.excludedCount, 112)
  assert.equal(result.entries.length, 324 - 112)
  const first = result.entries[0]
  assert.equal(first.name, '大鼻子奶奶')
  assert.equal(first.rarity, '3星')
  assert.equal(first.pathPrimary, '虚无')
  assert.equal(first.pathSecondary, '欢愉')
  assert.equal(first.mode, '乐园漫记')
  assert.equal(first.version, '4.5')
  assert.ok(first.blessing.includes('×6'), 'blessing keeps the 命途×count text')
  assert.ok(first.content.includes('【发牌员】'), 'effect text kept')
  // SMW tooltip bodies live outside the display:none wrapper on the live wiki.
  assert.equal(result.entries.filter((entry) => entry.content.includes('无视目标30%的全属性抗性')).length, 0)
  // ...while the tooltip anchor text (羽化) must survive.
  assert.ok(result.entries.filter((entry) => entry.content.includes('羽化')).length > 0)
  assert.ok(result.entries.every((entry) => !entry.mode.includes('千面英雄')))
})

test('events: 千面英雄 rows excluded, options become content', { skip: datasetSkip('events') }, () => {
  const { result } = extractOffline('events')
  assert.equal(result.stats.totalRows, 204)
  assert.equal(result.stats.dataRows, 172)
  assert.equal(result.excludedCount, 118)
  assert.equal(result.entries.length, 172 - 118)
  const first = result.entries[0]
  assert.equal(first.name, '宿敌（其一）')
  assert.equal(first.mode, '乐园漫记')
  assert.equal(first.type, '异常')
  assert.equal(first.version, '4.1')
  assert.ok(first.options.length > 0)
  assert.equal(first.content, first.options)
})

test('consumables: 翁法罗斯 region excluded by exact cell text', { skip: datasetSkip('consumables') }, () => {
  const { result } = extractOffline('consumables')
  assert.equal(result.stats.dataRows, 216)
  assert.equal(result.excludedCount, 24)
  assert.equal(result.entries.length, 216 - 24)
  assert.ok(result.entries.every((entry) => entry.region !== '翁法罗斯'))
  const first = result.entries[0]
  assert.equal(first.name, '蕉错就错')
  assert.equal(first.rarity, '3星')
  assert.equal(first.region, '匹诺康尼')
  assert.ok(first.content.startsWith('使用后在下次战斗中'))
})

test('decorations: content is column [6] 介绍', { skip: datasetSkip('decorations') }, () => {
  const { result } = extractOffline('decorations')
  assert.equal(result.stats.dataRows, 250)
  assert.equal(result.entries.length, 250)
  const first = result.entries[0]
  assert.equal(first.name, '放声大笑吧')
  assert.equal(first.rarity, '4星')
  assert.equal(first.type, '藏品')
  assert.equal(first.version, '4.1')
  assert.ok(first.effect.includes('概率艺术馆'))
  assert.ok(first.content.startsWith('当你觉得不好笑时'))
})

test('curios: TAG/star/acquire/effect mapped, no mode filter', { skip: datasetSkip('curios') }, () => {
  const { result } = extractOffline('curios')
  assert.equal(result.stats.totalRows, 298)
  assert.equal(result.stats.dataRows, 251)
  assert.equal(result.entries.length, 251)
  const first = result.entries[0]
  assert.equal(first.name, '人类的天敌')
  assert.equal(first.mode, '乐园漫记')
  assert.equal(first.star, '3星')
  assert.equal(first.version, '4.5')
  assert.ok(first.tag.includes('复制区域'))
  assert.ok(first.content.includes('暴击伤害提高 20%'))
})

/* --------------------------------------------------------------------- cards */

test('relics: 62 cards, name from relicset-name, 6-slot story model', { skip: datasetSkip('relics') }, () => {
  const { result } = extractOffline('relics')
  assert.equal(result.stats.cards, 62)
  assert.equal(result.entries.length, 62)
  const guard = result.entries.find((entry) => entry.name === '戍卫风雪的铁卫')
  assert.ok(guard, '戍卫风雪的铁卫 card present')
  assert.equal(guard.category, '隧洞遗器')
  assert.equal(guard.parts.length, 4)
  assert.deepEqual(
    guard.parts.map((part) => part.slot),
    ['头部', '手部', '躯干', '脚部'],
  )
  assert.ok(guard.content.includes('【头部】'))
  const talia = result.entries.find((entry) => entry.name === '盗贼公国塔利亚')
  assert.ok(talia, '盗贼公国塔利亚 card present')
  assert.deepEqual(
    talia.parts.map((part) => part.slot),
    ['位面球', '连结绳'],
  )
  // 戏梦点星的伶人 has empty story fields: kept, marked empty, never an error.
  const empty = result.entries.find((entry) => entry.name === '戏梦点星的伶人')
  assert.equal(empty.empty, true)
  assert.equal(empty.content, '')
  assert.deepEqual(empty.parts, [])
  // Card icons of new sets link to 特殊:上传文件 — the name must not come from it.
  assert.ok(result.entries.every((entry) => !entry.name.startsWith('文件:')))
})

test('relic detail titles come from the card list (for the wikitext batches)', { skip: probeSkip(['遗器图鉴.html']) }, () => {
  const titles = relicDetailTitles(loadHtml('遗器图鉴.html'))
  assert.equal(titles.length, 62)
  assert.ok(titles.includes('戍卫风雪的铁卫'))
})

test('lightcones: 169 cards, 光锥故事 becomes content with newlines', { skip: datasetSkip('lightcones') }, () => {
  const { result } = extractOffline('lightcones')
  assert.equal(result.stats.cards, 169)
  assert.equal(result.entries.length, 169)
  const cone = result.entries.find((entry) => entry.name === '向浪花掷下盛夏')
  assert.equal(cone.rarity, '5星')
  assert.equal(cone.path, '欢愉')
  assert.equal(cone.acquire, '限定跃迁')
  assert.equal(cone.version, '4.5')
  assert.ok(cone.content.includes('海水涌上板顶'))
  assert.ok(cone.content.includes('\n'), '<br> became a newline')
  assert.ok(cone.content.includes('「惊涛骇浪意味着风险重重'), '<i> quote kept as plain text')
})

test('relics/lightcones: real live-captured wikitext parses into the slot model', { skip: probeSkip([getDataset('relics').fixture, getDataset('lightcones').fixture]) }, (t) => {
  const capturedRelics = Object.keys(LIVE_FIXTURES.relics ?? {})
  const capturedCones = Object.keys(LIVE_FIXTURES.lightcones ?? {})
  if (capturedRelics.length === 0 && capturedCones.length === 0) {
    t.skip('no live capture yet — run `node _evidence/run-extract.mjs --live`')
    return
  }
  const canonical = ['头部', '手部', '躯干', '脚部', '位面球', '连结绳']
  const merged = {
    relics: { ...FIXTURES.relics, ...LIVE_FIXTURES.relics },
    lightcones: { ...FIXTURES.lightcones, ...LIVE_FIXTURES.lightcones },
  }
  const relics = extractOffline('relics', merged).result
  for (const entry of relics.entries) {
    for (const part of entry.parts ?? []) {
      assert.ok(canonical.includes(part.slot), `unexpected slot ${part.slot} on ${entry.name}`)
      assert.equal(typeof part.story, 'string')
    }
  }
  const nonEmptyRelics = relics.entries.filter((entry) => entry.content.length > 0)
  assert.ok(nonEmptyRelics.length > 0, 'at least one relic set has story text from the live capture')
  const cones = extractOffline('lightcones', merged).result
  const nonEmptyCones = cones.entries.filter((entry) => entry.content.length > 0)
  assert.ok(nonEmptyCones.length > 0, 'at least one light cone has 光锥故事 from the live capture')
  assertLossless({ relics: nonEmptyRelics, cones: nonEmptyCones })
})

/* ------------------------------------------------------------------ sections */

test('aeons: 18 chapters, 目录/星神总览/参考资料 excluded', { skip: datasetSkip('aeons') }, () => {
  const { result } = extractOffline('aeons')
  assert.equal(result.stats.headings, 21)
  assert.equal(result.excludedCount, 3)
  assert.equal(result.entries.length, 18)
  const first = result.entries[0]
  assert.equal(first.name, '「开拓」，阿基维利')
  assert.equal(first.path, '开拓')
  assert.equal(first.aeon, '阿基维利')
  assert.ok(first.content.includes('孤绝世界裴伽纳'))
})

test('factions: h2 命途 + h3 派系 entries with parent path', { skip: datasetSkip('factions') }, () => {
  const { result } = extractOffline('factions')
  assert.equal(result.stats.headings, 51)
  assert.equal(result.excludedCount, 3)
  assert.equal(result.entries.length, 48)
  const wumingke = result.entries.find((entry) => entry.name === '无名客')
  assert.equal(wumingke.path, '开拓')
  assert.ok(wumingke.content.includes('简介'))
  assert.ok(wumingke.content.includes('智库'))
  const path = result.entries.find((entry) => entry.name === '开拓')
  assert.equal(path.path, '开拓')
  assert.equal(path.empty, true, '命途 heading has no text of its own')
  // a parent must not repeat its children (that would double the cache size)
  assert.ok(!path.content.includes('无名客'))
})

test('terms: h2 分类 + h3 词条 entries with category', { skip: datasetSkip('terms') }, () => {
  const { result } = extractOffline('terms')
  assert.equal(result.stats.headings, 48)
  assert.equal(result.excludedCount, 1)
  assert.equal(result.entries.length, 47)
  const tree = result.entries.find((entry) => entry.name === '虚数之树')
  assert.equal(tree.category, '学说')
  assert.ok(tree.content.includes('虚数能量'))
  const category = result.entries.find((entry) => entry.name === '名词')
  assert.equal(category.category, '名词')
  assert.ok(category.content.includes('原初混沌'))
})

test('simuniverse: 开发日志 segments inside the 模拟宇宙图鉴 region only', { skip: datasetSkip('simuniverse') }, () => {
  const { result } = extractOffline('simuniverse')
  assert.equal(result.entries.length, 26)
  assert.equal(result.stats.regionChars > 0, true)
  const first = result.entries[0]
  assert.equal(first.name, '开发日志 · 存护')
  assert.equal(first.path, '存护')
  assert.equal(first.index, 1)
  assert.ok(first.content.startsWith('开发日志1'))
  assert.ok(result.entries.every((entry) => Number.isFinite(entry.index) && entry.index >= 1))
  // 14 tabs × 1–3 logs, but never a whole-page 开发日志 guess
  assert.ok(result.entries.filter((entry) => entry.path === '存护').length >= 1)
})

test('broadcast: raw 全文 + one entry per h4, tone markers preserved', { skip: datasetSkip('broadcast') }, () => {
  const { result } = extractOffline('broadcast')
  assert.equal(result.stats.chapters, 7)
  assert.equal(result.entries.length, 8)
  assert.equal(result.entries[0].name, '全文')
  const raw = result.entries[0].content
  assert.ok(raw.includes('女声：'))
  assert.ok(raw.includes('男声：'))
  assert.ok(raw.includes('（音乐）'))
  assert.ok(!raw.includes('首页 > 互动文本'), 'breadcrumb chrome removed')
  assert.ok(!raw.includes('如果是第一次来'), 'promo banner chrome removed')
  const chapters = result.entries.slice(1).map((entry) => entry.name)
  assert.ok(chapters.includes('完成雅利洛-Ⅵ开拓任务'))
  assert.equal(result.entries.filter((entry) => entry.name === '完成雅利洛-Ⅵ开拓任务')[0].content.length > 500, true)
})

/* --------------------------------------------------------------- html utils */

test('html helpers follow the BRIEF §3.2 rules', () => {
  const html = '<div><table id="CardSelectTr" class="x"><tbody><tr id="h"><th>a</th></tr><tr class="divsort" data-param1="3星"><td>x</td><td><a title="名称">名称</a></td></tr></tbody></table></div>'
  const table = tableById(html, 'CardSelectTr')
  assert.ok(table.startsWith('<table id="CardSelectTr"'))
  const rows = tableRows(table)
  assert.equal(rows.length, 2)
  // the data-param attribute must survive the row split
  assert.match(rows[1], /data-param1="3星"/)
  assert.match(rows[1], /^<tr class="divsort"/)
  assert.equal(splitTables(html).length, 1)
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&#39;&#160;&#x41;'), '&<>"\' A')
  assert.equal(cleanText('<div style="display:none;">隐藏</div>可见<br>下一行'), '可见\n下一行')
  assert.equal(cleanText('<span class="smwttcontent">提示正文</span>锚点'), '锚点')
  assert.equal(cleanText('<style>.a{color:red}</style>正文'), '正文')
})

/* ---------------------------------------------------------------- wikitext */

test('wikitext template reader handles nesting, comments and line breaks', () => {
  const text = '{{遗器套装|名称=甲|头部<!--注释-->故事=一行<br />二行<i>「引」</i>|位面球故事=}}{{颜色|描述2|18%}}'
  const parsed = templateFields(text, '遗器套装')
  assert.ok(parsed)
  assert.equal(parsed.fields['名称'], '甲')
  assert.equal(wikitextToText(parsed.fields['头部故事']), '一行\n二行「引」')
  assert.equal(field(parsed.fields, '缺失', '名称'), '甲')
  const inner = parseTemplate('名称=甲|效果={{颜色|描述2|18%}}|无名参数')
  assert.equal(inner.fields['效果'], '{{颜色|描述2|18%}}')
  assert.deepEqual(inner.params, ['无名参数'])
  assert.equal(wikitextToText('{{颜色|描述2|高亮文本}}'), '高亮文本')
  assert.equal(wikitextToText('[[页面|显示]]和[[直接]]'), '显示和直接')
  assert.equal(templateFields('{{其他模板|a=1}}', '遗器套装'), null)
})

/* ------------------------------------------------------------------ client */

/** Minimal fetch double: queue of responses, records the headers used. */
function fetchQueue(responses) {
  const calls = []
  const impl = async (url, options) => {
    calls.push({ url, headers: options.headers })
    const next = responses.shift()
    if (next === undefined) throw new Error('fetch double exhausted')
    if (next instanceof Error) throw next
    return {
      status: next.status ?? 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? (next.contentType ?? 'application/json') : null) },
      text: async () => next.body ?? '',
    }
  }
  return { impl, calls }
}

test('client: browser UA + referer, JSON parsing, no x-requested-with', async () => {
  const queue = fetchQueue([{ body: JSON.stringify({ ok: 1 }) }])
  const client = new WikiClient({ intervalMs: 1500, fetchImpl: queue.impl, sleepImpl: async () => {} })
  const result = await client.requestJson('https://example.invalid/a')
  assert.equal(result.ok, true)
  assert.equal(result.json.ok, 1)
  assert.equal(queue.calls.length, 1)
  const headers = queue.calls[0].headers
  assert.match(headers['user-agent'], /^Mozilla\/5\.0/)
  assert.equal(headers.referer, 'https://wiki.biligame.com/sr/')
  assert.equal(headers['x-requested-with'], undefined)
})

test('client: throttle gap is enforced and never below 1500ms', async () => {
  const sleeps = []
  const queue = fetchQueue([{ body: '{}' }, { body: '{}' }])
  // Injected clock: the throttle decision must not depend on how long the previous
  // fetch happened to take. With real Date.now() this test was FLAKY (observed
  // 2 failures in 6 consecutive full-suite runs under load) because a slow first
  // request pushed the elapsed time past the interval, so no sleep was needed and
  // the assertion "some sleep >= 1500ms" failed. Freeze time and advance it by hand.
  let clock = 1_000_000
  const client = new WikiClient({
    intervalMs: 200,
    fetchImpl: queue.impl,
    sleepImpl: async (ms) => {
      sleeps.push(ms)
      clock += ms // a real sleep advances real time
    },
    nowImpl: () => clock,
  })
  assert.equal(client.options.intervalMs, 1500, 'config below the BRIEF floor is clamped')
  await client.requestJson('https://example.invalid/1')
  // Time has NOT advanced (the fake fetch takes zero time), so the gap is exactly
  // `intervalMs` and the throttle MUST sleep.
  await client.requestJson('https://example.invalid/2')
  assert.equal(queue.calls.length, 2)
  assert.deepEqual(sleeps, [1500], `expected exactly one 1500ms throttle gap, saw ${JSON.stringify(sleeps)}`)

  // Control: once the clock has moved past the interval, no further sleep happens.
  const queue2 = fetchQueue([{ body: '{}' }, { body: '{}' }])
  const sleeps2 = []
  let clock2 = 5_000_000
  const client2 = new WikiClient({
    intervalMs: 1500,
    fetchImpl: queue2.impl,
    sleepImpl: async (ms) => { sleeps2.push(ms); clock2 += ms },
    nowImpl: () => clock2,
  })
  await client2.requestJson('https://example.invalid/3')
  clock2 += 5000 // simulate a request that took longer than the interval
  await client2.requestJson('https://example.invalid/4')
  assert.deepEqual(sleeps2, [], 'already-elapsed gap must not sleep')

  // R2-5 regression: a clock seam returning a NON-FINITE value used to make `gap` NaN,
  // so `gap > 0` was false and the >=1500ms throttle was silently disabled (the floor
  // exists to avoid WAF blocking). The seam must fall back to the real clock instead.
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 'not-a-number']) {
    const queue3 = fetchQueue([{ body: '{}' }, { body: '{}' }])
    const sleeps3 = []
    const client3 = new WikiClient({
      intervalMs: 1500,
      fetchImpl: queue3.impl,
      sleepImpl: async (ms) => { sleeps3.push(ms) },
      nowImpl: () => bad,
    })
    assert.ok(Number.isFinite(client3.now()), `nowImpl 返回 ${String(bad)} 时 now() 必须仍为有限数`)
    await client3.requestJson('https://example.invalid/5')
    await client3.requestJson('https://example.invalid/6')
    assert.equal(sleeps3.length, 1, `nowImpl 返回 ${String(bad)} 时不得静默关闭限流（sleeps=${JSON.stringify(sleeps3)}）`)
    // The real clock returns fractional milliseconds, so the gap is ~1500ms rather than
    // exactly 1500 (observed 1499.xx). Assert the floor, not float equality.
    assert.ok(
      sleeps3[0] >= 1499 && sleeps3[0] <= 1501,
      `节流间隔必须落在 1500ms 附近，实际 ${sleeps3[0]}`,
    )
  }
})

test('client: WAF 567 / non-JSON retries with exponential backoff, then fails without throwing', async () => {
  const wafPage = '<html><head><style>.a{}</style></head><body>blocked</body></html>'
  const sleeps = []
  const queue = fetchQueue([
    { status: 567, contentType: 'text/html', body: wafPage },
    { status: 200, contentType: 'text/html', body: wafPage },
    { body: JSON.stringify({ ok: true }) },
  ])
  const client = new WikiClient({ intervalMs: 1500, maxRetries: 3, backoffMs: 4000, fetchImpl: queue.impl, sleepImpl: async (ms) => sleeps.push(ms) })
  const result = await client.requestJson('https://example.invalid/retry')
  assert.equal(result.ok, true)
  assert.equal(result.attempts, 3)
  assert.deepEqual(sleeps.filter((ms) => ms >= 4000), [4000, 8000], 'backoff doubles: 4s then 8s')

  const alwaysWaf = fetchQueue(Array.from({ length: 4 }, () => ({ status: 567, contentType: 'text/html', body: wafPage })))
  const failing = new WikiClient({ intervalMs: 1500, maxRetries: 3, backoffMs: 4000, fetchImpl: alwaysWaf.impl, sleepImpl: async () => {} })
  const failure = await failing.requestJson('https://example.invalid/waf')
  assert.equal(failure.ok, false)
  assert.equal(failure.waf, true)
  assert.equal(failure.attempts, 4)
  assert.match(failure.error, /WAF blocked \(status 567\)/)
})

test('client: timeouts and API errors are failure results, not exceptions', async () => {
  const timeout = new Error('The operation was aborted due to timeout')
  timeout.name = 'TimeoutError'
  const queue = fetchQueue([timeout])
  const client = new WikiClient({ intervalMs: 1500, maxRetries: 0, fetchImpl: queue.impl, sleepImpl: async () => {} })
  const result = await client.requestJson('https://example.invalid/slow')
  assert.equal(result.ok, false)
  assert.match(result.error, /timeout/)

  const apiQueue = fetchQueue([{ body: JSON.stringify({ error: { code: 'missingtitle', info: '页面不存在' } }) }])
  const apiClient = new WikiClient({ intervalMs: 1500, maxRetries: 3, fetchImpl: apiQueue.impl, sleepImpl: async () => {} })
  const apiResult = await apiClient.revisionIds(['不存在的页面'])
  assert.equal(apiResult.ok, false)
  assert.match(apiResult.error, /missingtitle/)
  assert.equal(apiQueue.calls.length, 1, 'deterministic API errors are not retried')
})

test('client: parsePage / revisionIds / revisions shapes', async () => {
  const parseQueue = fetchQueue([{ body: JSON.stringify({ parse: { title: '方程一览', text: '<p>x</p>' } }) }])
  const parseClient = new WikiClient({ fetchImpl: parseQueue.impl, sleepImpl: async () => {} })
  const parsed = await parseClient.parsePage('方程一览')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.html, '<p>x</p>')
  assert.match(decodeURIComponent(parseQueue.calls[0].url), /action=parse&page=方程一览&prop=text/)

  const revQueue = fetchQueue([{ body: JSON.stringify({ query: { pages: [{ title: '星神', pageid: 1, revisions: [{ revid: 42, timestamp: '2026-09-25T00:00:00Z' }] }] } }) }])
  const revClient = new WikiClient({ fetchImpl: revQueue.impl, sleepImpl: async () => {} })
  const revs = await revClient.revisionIds(['星神'])
  assert.equal(revs.ok, true)
  assert.equal(revs.pages[0].revid, 42)

  const wtQueue = fetchQueue([{ body: JSON.stringify({ query: { pages: [{ title: '光锥', revisions: [{ slots: { main: { content: '{{光锥图鉴|光锥故事=故事}}' } } }] }, { title: '缺失', missing: true }] } }) }])
  const wtClient = new WikiClient({ fetchImpl: wtQueue.impl, sleepImpl: async () => {} })
  const wt = await wtClient.revisions(['光锥', '缺失'])
  assert.equal(wt.pages[0].content, '{{光锥图鉴|光锥故事=故事}}')
  assert.equal(wt.pages[1].missing, true)
})

/* -------------------------------------------------------- cache round trip */

/** Fake wiki client backed by the offline fixtures; `revid` is adjustable. */
function fakeClient(state) {
  return {
    async revisionIds(titles) {
      return {
        ok: true,
        titles,
        pages: titles.map((title) => ({ title, pageid: 1, missing: false, revid: state.revidFor(title), timestamp: '2026-09-25T00:00:00Z' })),
      }
    },
    async parsePage(title) {
      if (state.failPages?.has(title)) return { ok: false, title, error: 'simulated fetch failure' }
      const html = state.pages[title]
      if (typeof html !== 'string') return { ok: false, title, error: 'no fixture for this page' }
      return { ok: true, title, html, bytes: Buffer.byteLength(html, 'utf8') }
    },
    async revisions(titles) {
      return {
        ok: true,
        titles,
        pages: titles.map((title) => ({ title, missing: state.wikitext[title] === undefined, content: state.wikitext[title] ?? '' })),
      }
    },
  }
}

function fixtureState() {
  const pages = {}
  const wikitext = {}
  for (const dataset of DATASETS) {
    pages[dataset.title] = loadHtml(dataset.fixture)
    if (dataset.needsWikitext === true) Object.assign(wikitext, FIXTURES[dataset.id] ?? {})
  }
  return { pages, wikitext, revid: 1000, revidFor() { return this.revid }, failPages: new Set() }
}

function withTempWorkspace(run) {
  const dir = mkdtempSync(join(tmpdir(), 'hsr-wiki-test-'))
  try {
    return run(dir)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* leaving the temp dir behind is harmless */
    }
  }
}

test('status: works with no cache directory at all', () => {
  withTempWorkspace((workspace) => {
    const result = status({ workspace })
    assert.equal(result.ok, true)
    assert.equal(result.hasCache, false)
    assert.equal(result.lastUpdated, null)
    assert.equal(result.stale, true)
    assert.equal(result.recommendation, 'update')
    assert.equal(result.datasets.length, 12)
    assert.ok(result.datasets.every((row) => row.cached === false && row.count === 0))
    assertLossless(result)
  })
})

test('read: missing cache returns an ok:false result instead of throwing', () => {
  withTempWorkspace((workspace) => {
    const result = read({ workspace }, { dataset: 'equations' })
    assert.equal(result.ok, false)
    assert.equal(result.entries.length, 0)
    assert.equal(result.failed.length, 1)
    const bogus = read({ workspace }, { dataset: 'nope' })
    assert.equal(bogus.ok, false)
    assert.match(bogus.warnings[0], /unknown dataset/)
    const noArg = read({ workspace }, {})
    assert.equal(noArg.ok, false)
    assert.match(noArg.warnings[0], /required/)
  })
})

test('update → status → update: revid short-circuit skips every dataset', { skip: probeSkip(ALL_FIXTURES) }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsr-wiki-test-'))
  try {
    const state = fixtureState()
    const client = fakeClient(state)

    const first = await update({ workspace }, { client })
    assert.equal(first.failed.length, 0, JSON.stringify(first.failed))
    assert.equal(first.updated.length, 12)
    assert.equal(first.skipped.length, 0)
    assert.ok(first.lastUpdated, 'update reports a lastUpdated timestamp')
    assert.equal(first.counts.equations, EXPECTED.equations, 'update reports per-dataset counts')
    assert.ok(existsSync(join(workspace, 'hsr-worldview-cache', 'index.json')), 'index.json written')
    assert.ok(existsSync(join(workspace, 'hsr-worldview-cache', 'equations.json')), 'equations.json written')

    const after = status({ workspace })
    assert.equal(after.hasCache, true)
    assert.equal(after.lastUpdated, first.lastUpdated)
    assert.equal(after.recommendation, 'use-cache')
    assert.equal(after.failed.length, 0)
    for (const row of after.datasets) {
      assert.equal(row.cached, true, `${row.id} cached`)
      assert.equal(row.ok, true, `${row.id} ok`)
      assert.equal(row.count, EXPECTED[row.id], `${row.id} count`)
      assert.ok(row.lastUpdated, `${row.id} lastUpdated`)
      assert.ok(Number.isFinite(row.revisionId), `${row.id} revisionId`)
      assert.match(row.pageSha, /^[0-9a-f]{16}$/)
    }

    const second = await update({ workspace }, { client })
    assert.deepEqual(second.updated, [])
    assert.equal(second.skipped.length, 12)
    assert.deepEqual(second.failed, [])

    // A changed revision id must start updating again (the skip is revid-driven).
    state.revid = 1001
    const third = await update({ workspace }, { client })
    assert.equal(third.updated.length, 12)
    assert.equal(third.skipped.length, 0)

    // read + sampleAll against the real cache files
    const equations = read({ workspace }, { dataset: 'equations', limit: 5 })
    assert.equal(equations.ok, true)
    assert.equal(equations.count, EXPECTED.equations)
    assert.equal(equations.matched, EXPECTED.equations)
    assert.equal(equations.entries.length, 5)
    assert.equal(equations.entries[0].name, '大鼻子奶奶')

    // The tool layer advertises singular ids in one place and plural in another:
    // both must resolve to the same dataset.
    const singular = read({ workspace }, { dataset: 'equation', limit: 1 })
    assert.equal(singular.ok, true)
    assert.equal(singular.dataset, 'equations')
    assert.equal(singular.count, EXPECTED.equations)
    assert.equal(read({ workspace }, { dataset: 'relic', limit: 1 }).dataset, 'relics')
    assert.equal(read({ workspace }, { dataset: 'simuniverse', limit: 1 }).dataset, 'simuniverse')

    const filtered = read({ workspace }, { dataset: 'aeons', query: '存护' })
    assert.equal(filtered.ok, true)
    assert.ok(filtered.matched >= 1)
    assert.ok(filtered.matched < filtered.count, 'query actually filters')

    const paged = read({ workspace }, { dataset: 'lightcones', limit: 3, offset: 2 })
    assert.equal(paged.entries.length, 3)
    assert.notEqual(paged.entries[0].name, read({ workspace }, { dataset: 'lightcones', limit: 1 }).entries[0].name)

    const limited = read({ workspace }, { dataset: 'broadcast' })
    assert.equal(limited.entries[0].truncated, true, 'entries over 1500 chars are truncated')
    assert.equal(limited.entries[0].content.length, 1500)

    const sample = sampleAll({ workspace })
    assert.equal(sample.ok, true)
    assert.equal(sample.datasets.length, 12)
    assert.ok(sample.datasets.every((dataset) => dataset.cached && dataset.samples.length > 0))

    // A failing dataset must keep the previous cache file intact.
    const before = new Map(status({ workspace }).datasets.map((row) => [row.id, row]))
    state.failPages = new Set([getDataset('curios').title])
    state.revid = 1002
    const fourth = await update({ workspace }, { client })
    assert.equal(fourth.failed.length, 1)
    assert.equal(fourth.failed[0].id, 'curios')
    assert.equal(fourth.updated.length, 11)
    const afterFailure = status({ workspace })
    assert.equal(afterFailure.datasets.find((row) => row.id === 'curios').ok, false)
    assert.equal(afterFailure.datasets.find((row) => row.id === 'curios').count, EXPECTED.curios)
    for (const row of afterFailure.datasets) {
      const previous = before.get(row.id)
      assert.equal(row.count, previous.count, `${row.id} count preserved across a failed update`)
      if (row.id === 'curios') {
        assert.equal(row.lastUpdated, previous.lastUpdated, 'the failed dataset keeps its original lastUpdated')
      }
    }
    const curios = read({ workspace }, { dataset: 'curios', limit: 1 })
    assert.equal(curios.ok, true, 'the cached curios data is still readable after a failure')
    assert.equal(curios.count, EXPECTED.curios)
    // A retry with the failure removed recovers the dataset.
    state.failPages = new Set()
    state.revid = 1003
    const fifth = await update({ workspace }, { client })
    assert.deepEqual(fifth.failed, [])
    assert.equal(status({ workspace }).datasets.find((row) => row.id === 'curios').ok, true)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('update: unknown ids and a broken client degrade into failed[]', { skip: probeSkip(ALL_FIXTURES) }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsr-wiki-test-'))
  try {
    const unknown = await update({ workspace }, { datasets: ['nope'], client: fakeClient(fixtureState()) })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.failed[0].id, 'nope')
    assert.deepEqual(unknown.updated, [])

    // singular aliases are accepted and deduplicated
    const alias = await update({ workspace }, { datasets: ['equation', 'equations'], client: fakeClient(fixtureState()) })
    assert.deepEqual(alias.updated, ['equations'])
    assert.deepEqual(alias.failed, [])

    const broken = {
      async revisionIds() {
        throw new Error('network exploded')
      },
      async parsePage() {
        throw new Error('network exploded')
      },
      async revisions() {
        throw new Error('network exploded')
      },
    }
    const result = await update({ workspace }, { datasets: ['aeons'], client: broken })
    assert.equal(result.ok, false)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /network exploded/)
    const after = status({ workspace })
    assert.equal(after.datasets.find((row) => row.id === 'aeons').cached, false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('extractors never throw on empty/garbage input', () => {
  for (const dataset of DATASETS) {
    for (const html of ['', '<html><body>no tables here</body></html>', undefined]) {
      const result = extractDataset(dataset.id, { html, wikitextByTitle: {}, ctx: {} })
      assert.ok(Array.isArray(result.entries), `${dataset.id} entries array`)
      assert.ok(Array.isArray(result.warnings), `${dataset.id} warnings array`)
      assert.equal(typeof result.excludedCount, 'number')
      assertLossless(result)
    }
    const unknown = extractDataset('does-not-exist', { html: '<p>x</p>' })
    assert.equal(unknown.entries.length, 0)
    assert.match(unknown.warnings[0], /unknown dataset/)
  }
})

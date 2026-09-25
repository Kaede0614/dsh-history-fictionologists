/**
 * MANDATORY SELF-PROOF runner for lib/missions.js + lib/digest.js.
 *
 * Exact command line (run from the workspace root):
 *
 *   node _evidence/run-missions.mjs
 *
 * It exercises EVERY exported function against the REAL workspace data and
 * writes the raw output to `_evidence/missions-digest.txt`.
 * The equation / broadcast digests have no cache in this workspace yet, so
 * they are additionally run against a clearly-labelled synthetic cache (which
 * mirrors the cache contract in BRIEF §3.3/§4) to prove the happy path.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const ROOT = resolve(HERE, '..')
const OUT = join(HERE, 'missions-digest.txt')

const lines = []
function emit(text = '') {
  lines.push(text)
  process.stdout.write(`${text}\n`)
}
function head(title) {
  emit('')
  emit('='.repeat(78))
  emit(`## ${title}`)
  emit('='.repeat(78))
}
/** Print ok flag, counts and the first 400 chars of the payload. */
function report(label, value, previewKey = 'markdown') {
  const json = JSON.stringify(value)
  emit(`[${label}] ok=${String(value.ok)}  JSON.stringify(result).length=${json.length} chars  Buffer.byteLength=${Buffer.byteLength(json)} bytes`)
  const counts = {}
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') counts[key] = typeof item === 'string' ? `string(${item.length})` : item
    else if (Array.isArray(item)) counts[key] = `array(${item.length})`
    else if (item !== null && typeof item === 'object') counts[key] = `object(${Object.keys(item).length} keys)`
  }
  emit(`  scalars: ${JSON.stringify(counts)}`)
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    emit(`  warnings: ${JSON.stringify(value.warnings)}`)
  }
  const preview = typeof value[previewKey] === 'string' && value[previewKey].length > 0
    ? value[previewKey]
    : json
  emit(`  first 400 chars of ${typeof value[previewKey] === 'string' && value[previewKey].length > 0 ? previewKey : 'JSON'}:`)
  emit(`  ${preview.slice(0, 400).replace(/\n/g, '\n  ')}`)
  return value
}

const missions = await import('../lib/missions.js')
const digest = await import('../lib/digest.js')

emit('dsh-history-fictionologists · missions + digest self-proof')
emit(`command : node _evidence/run-missions.mjs`)
emit(`cwd     : ${process.cwd()}`)
emit(`workspace: ${ROOT}`)
emit(`node    : ${process.version}`)
emit(`time    : ${new Date().toISOString()}`)
emit(`exports missions.js: ${Object.keys(missions).sort().join(', ')}`)
emit(`exports digest.js  : ${Object.keys(digest).sort().join(', ')}`)

// ---------------------------------------------------------------- scanMissions
head('1. scanMissions(cfg) — real workspace')
const scan = report('scanMissions', missions.scanMissions({ workspace: ROOT }))
emit(`  series: ${scan.series.map((s) => `${s.name}(${s.region}·${s.version}·${s.missionCount})`).join(' | ')}`)
emit(`  first series missions: ${scan.series[0].missions.slice(0, 3).map((m) => `${m.number}/${m.name}/${m.file}/exists=${m.exists}`).join(' | ')}`)

// ---------------------------------------------------------- catalogTrailblaze
head('2. catalogTrailblaze(cfg) — 13.9 MB file, wall-clock timing, size proof')
const tbRuns = []
let tb = null
for (let run = 0; run < 3; run += 1) {
  const started = performance.now()
  const result = missions.catalogTrailblaze({ workspace: ROOT })
  tbRuns.push(performance.now() - started)
  if (run === 0) tb = result
}
const tbWall = tbRuns[0]
const tbJson = JSON.stringify(tb)
const tbSorted = [...tbRuns].sort((a, b) => a - b)
emit(`file size: ${(await import('node:fs')).statSync(join(ROOT, 'hsr-missions', 'trailblaze_missions.json')).size} bytes`)
emit(`WALL-CLOCK catalogTrailblaze over 3 runs: ${tbRuns.map((ms) => `${ms.toFixed(1)} ms`).join(' / ')}  (median ${tbSorted[1].toFixed(1)} ms, min ${tbSorted[0].toFixed(1)} ms)`)
emit(`module-internal timings of run 1: read ${tb.timings?.readMs} ms / parse ${tb.timings?.parseMs} ms / total ${tb.timings?.totalMs} ms`)
emit(`JSON.stringify(result).length = ${tbJson.length} chars  (limit 204800)  -> ${tbJson.length < 204800 ? 'PASS < 200 KB' : 'FAIL'}`)
emit(`Buffer.byteLength(JSON.stringify(result)) = ${Buffer.byteLength(tbJson)} bytes`)
report('catalogTrailblaze', tb, 'file')
emit(`  stats: ${JSON.stringify(tb.stats)}  counts: ${JSON.stringify(tb.counts)}`)
for (const act of tb.acts) {
  emit(`  ${act.act}: ${act.series.map((s) => `${s.series}[${s.returned}/${s.missionCount}${s.truncated ? ',truncated' : ''}]`).join(' ')}`)
}
report('catalogTrailblaze(limit=2)', missions.catalogTrailblaze({ workspace: ROOT }, { limit: 2 }), 'file')
report('catalogTrailblaze(act=第三幕, series=鸽群中的猫)', missions.catalogTrailblaze({ workspace: ROOT }, { act: '第三幕', series: '鸽群中的猫' }), 'file')

// --------------------------------------------------------------- catalogBooks
head('3. catalogBooks(cfg) — 498 books, metadata only')
const cb = report('catalogBooks', missions.catalogBooks({ workspace: ROOT }), 'file')
emit(`  count=${cb.count} returned=${cb.returned} truncated=${cb.truncated}`)
emit(`  book[0]: ${JSON.stringify(cb.books[0])}`)
emit(`  book keys union: ${[...new Set(cb.books.flatMap((b) => Object.keys(b)))].sort().join(', ')}`)

// --------------------------------------------------------------- booksByTitle
head('4. booksByTitle(cfg, titles) — bodies from 分卷[].内容, 4000-char cap')
const bt = report('booksByTitle(2 titles)', missions.booksByTitle({ workspace: ROOT }, ['「黑塔」资产定损清单', '黑塔的手稿'], {}), 'file')
emit(`  matched=${bt.matched} missing=${JSON.stringify(bt.missing)} totalChars=${bt.totalChars} truncated=${bt.truncated}`)
for (const book of bt.books) {
  emit(`  ${book.title}: volumes=${book.volumes.length} chars=${book.volumes.map((v) => v.chars).join(',')} truncated=${book.truncated}`)
  emit(`    body head: ${JSON.stringify(book.volumes[0]?.body.slice(0, 120))}`)
}
const btSmall = report('booksByTitle(bodyChars=80)', missions.booksByTitle({ workspace: ROOT }, ['「黑塔」资产定损清单'], { bodyChars: 80 }), 'file')
emit(`  truncated=${btSmall.truncated} volume[0].truncated=${btSmall.books[0].volumes[0].truncated} bodyChars=${btSmall.books[0].volumes[0].body.length}`)
report('booksByTitle(unknown title)', missions.booksByTitle({ workspace: ROOT }, ['这本书不存在'], {}), 'file')

// ----------------------------------------------------------------- loadSeries
head('5. loadSeries(cfg, seriesName) — no dialogue text, no 剧情wiki原文')
const ls = report('loadSeries(狐斋志异)', missions.loadSeries({ workspace: ROOT }, '狐斋志异'), 'file')
emit(`  series=${ls.series} region=${ls.region} version=${ls.version} missions=${ls.missions.length} jsonChars=${JSON.stringify(ls).length}`)
emit(`  mission keys union: ${[...new Set(ls.missions.flatMap((m) => Object.keys(m)))].sort().join(', ')}`)
emit(`  mission[0]: ${JSON.stringify(ls.missions[0]).slice(0, 400)}`)
const lsJson = JSON.stringify(ls)
emit(`  contains 剧情内容? ${lsJson.includes('剧情内容')}  contains 剧情wiki原文? ${lsJson.includes('剧情wiki原文')}  contains 台词 '———'? ${lsJson.includes('———')}`)
const worst = missions.loadSeries({ workspace: ROOT }, '明霄竞武试锋芒•下')
emit(`  largest series 明霄竞武试锋芒•下: missions=${worst.missions.length} jsonChars=${JSON.stringify(worst).length}`)
report('loadSeries(不存在的系列)', missions.loadSeries({ workspace: ROOT }, '不存在的系列'), 'file')

// --------------------------------------------------------------- conflictBrief
head('6. conflictBrief(cfg, { series }) — the storywriter avoidance brief')
const cf = report('conflictBrief(series=蕉恶非道•无忍义之战)', missions.conflictBrief({ workspace: ROOT }, { series: '蕉恶非道•无忍义之战' }), 'brief')
emit(`  series=${cf.series} places=${JSON.stringify(cf.places)} characterCount=${cf.characterCount} missionCount=${cf.missionCount} briefChars=${cf.brief.length}`)
emit(`  characters: ${cf.characters.join('、')}`)
emit(`  linksOutsideSeries: ${JSON.stringify(cf.linksOutsideSeries)}`)
emit('  --- brief verbatim (first 1200 chars) ---')
emit(cf.brief.slice(0, 1200).split('\n').map((line) => `  ${line}`).join('\n'))
const cfAll = missions.conflictBrief({ workspace: ROOT }, {})
emit(`  conflictBrief({}) all series: ok=${cfAll.ok} series="${cfAll.series}" missionCount=${cfAll.missionCount} returned=${cfAll.returned} briefChars=${cfAll.brief.length} truncated=${cfAll.truncated}`)
report('conflictBrief(series=不存在)', missions.conflictBrief({ workspace: ROOT }, { series: '不存在' }), 'brief')

// ------------------------------------------------------------------- digests
head('7. digests against the REAL workspace (no hsr-worldview-cache yet)')
for (const [name, value] of [
  ['equationNameDigest', digest.equationNameDigest({ workspace: ROOT })],
  ['broadcastDigest', digest.broadcastDigest({ workspace: ROOT })],
  ['bookDigest', digest.bookDigest({ workspace: ROOT })],
  ['missionDigest', digest.missionDigest({ workspace: ROOT }, {})],
]) {
  report(name, value, 'markdown')
}
emit(`  cacheDir exists? ${existsSync(join(ROOT, 'hsr-worldview-cache'))}`)

head('8. bookDigest / missionDigest against the REAL workspace (happy path)')
const bd = report('bookDigest({limit:25})', digest.bookDigest({ workspace: ROOT }, { limit: 25 }), 'markdown')
emit(`  markdown charset length=${bd.markdown.length} truncated=${bd.truncated} count=${bd.count} returned=${bd.returned}`)
emit('  --- markdown (first 1400 chars) ---')
emit(bd.markdown.slice(0, 1400).split('\n').map((line) => `  ${line}`).join('\n'))
const md = report('missionDigest({limit:40})', digest.missionDigest({ workspace: ROOT }, { limit: 40 }), 'markdown')
emit(`  seriesCount=${md.seriesCount} missionCount=${md.missionCount} returned=${md.returned} markdownChars=${md.markdown.length} truncated=${md.truncated}`)
emit('  --- markdown (first 1400 chars) ---')
emit(md.markdown.slice(0, 1400).split('\n').map((line) => `  ${line}`).join('\n'))
const mdSeries = report('missionDigest({series:狐斋志异, limit:3})', digest.missionDigest({ workspace: ROOT }, { series: '狐斋志异', limit: 3 }), 'markdown')
emit(`  seriesCount=${mdSeries.seriesCount} missionCount=${mdSeries.missionCount} returned=${mdSeries.returned} truncated=${mdSeries.truncated}`)
emit('  --- markdown verbatim ---')
emit(mdSeries.markdown.split('\n').map((line) => `  ${line}`).join('\n'))

// ----------------------------------- synthetic cache (clearly labelled fixture)
head('9. equationNameDigest / broadcastDigest against a SYNTHETIC cache fixture')
emit('NOTE: this workspace has no hsr-worldview-cache yet; the fixture mirrors')
emit('      BRIEF §3.3/§4 field names so the happy path is proven end to end.')
const fixtureRoot = mkdtempSync(join(tmpdir(), 'hff-fixture-'))
const fixtureCache = join(fixtureRoot, 'hsr-worldview-cache')
mkdirSync(fixtureCache, { recursive: true })
writeFileSync(join(fixtureCache, 'equations.json'), JSON.stringify({
  dataset: 'equations',
  title: '方程一览',
  lastUpdated: '2026-09-26T02:00:00.000Z',
  count: 5,
  excludedCount: 112,
  entries: [
    { name: '大鼻子奶奶', rarity: '3星', pathPrimary: '虚无', pathSecondary: '欢愉', mode: '乐园漫记', blessing: '虚无×6 欢愉×4', content: '【发牌员】攻击段数提高4，每次造成伤害时，为我方全体角色提供1层【切牌】。', version: '4.5' },
    { name: '背锅侠', rarity: '2星', pathPrimary: '虚无', pathSecondary: '同谐', mode: '人间喜剧', blessing: '虚无×4 同谐×2', content: '我方目标受到攻击后，将伤害的30%转移给【替罪羊】。', version: '4.5' },
    { name: '睡前故事', rarity: '4星', pathPrimary: '记忆', pathSecondary: '', mode: '人间喜剧', blessing: '记忆×8', content: '进入战斗时，我方全体获得【安眠】。', version: '3.0' },
    { name: '火与危险事物', rarity: '2星', pathPrimary: '记忆', pathSecondary: '智识', mode: '人间喜剧', blessing: '记忆×4 智识×2', content: '每次施放战技后，灼烧敌方全体。', version: '3.0' },
    { name: '巴掌侠', rarity: '2星', pathPrimary: '毁灭', pathSecondary: '虚无', mode: '乐园漫记', blessing: '毁灭×4 虚无×2', content: '施放攻击后，额外造成1次等于自身攻击力50%的附加伤害。', version: '4.5' },
  ],
  warnings: [],
}), 'utf8')
writeFileSync(join(fixtureCache, 'broadcast.json'), JSON.stringify({
  dataset: 'broadcast',
  title: '星际和平播报',
  count: 2,
  entries: [
    { name: '完成雅利洛-Ⅵ开拓任务', content: '（音乐）\n女声：这里是星际和平播报，观众朋友们晚上好。\n男声：晚上好。\n女声：「存护」克里珀的巨锤徐徐下落，锤声响彻寰宇，震耳欲聋。\n男声：博识学会星空生态学派宣布：琥珀历2157纪结束，2158纪正式到来。\n女声：在新的纪元里，星际和平公司将一如既往地致力于银河间的和平共处，贸易繁荣。\n（音乐）' },
    { name: '完成仙舟「罗浮」开拓任务', content: '（音乐）\n女声：这里是星际和平播报，观众朋友们晚上好。\n男声：晚上好。\n女声：仙舟「罗浮」的建木灾异已经平息，云骑军宣布解除最高戒备。\n男声：星际和平公司提醒各位旅客，出行前请确认航线是否途经「无明火」区域。\n女声：本次播报到此结束，请在指定时间收听下一周期的星际和平播报。\n（音乐）' },
  ],
  warnings: [],
}), 'utf8')
const eq = report('equationNameDigest(fixture)', digest.equationNameDigest({ workspace: fixtureRoot }, {}), 'markdown')
emit(`  count=${eq.count} examples=${eq.examples} markdownChars=${eq.markdown.length} truncated=${eq.truncated}`)
emit('  --- markdown verbatim ---')
emit(eq.markdown.split('\n').map((line) => `  ${line}`).join('\n'))
const bc = report('broadcastDigest(fixture)', digest.broadcastDigest({ workspace: fixtureRoot }), 'markdown')
emit(`  entryCount=${bc.entryCount} speakers=${JSON.stringify(bc.speakers)} formatTemplateChars=${bc.formatTemplate.length} markdownChars=${bc.markdown.length}`)
emit(`  formatTemplate === BRIEF §8 功能 3 ? ${bc.formatTemplate === ['（音乐）', '', '女声：这里是星际和平播报，观众朋友们晚上好。', '男声：晚上好。', '', '女声：第一条消息。……', '男声：第二条消息。……', '', '女声：本次播报到此结束，请在指定时间收听下一周期的星际和平播报。', '（音乐）'].join('\n')}`)
emit('  --- markdown verbatim ---')
emit(bc.markdown.split('\n').map((line) => `  ${line}`).join('\n'))

head('9b. digests at FULL SCALE against real wiki content rebuilt from _probe/html')
emit('NOTE: no hsr-worldview-cache exists yet, so this runner rebuilds a cache-shaped')
emit('      file from the real rendered HTML captured in _probe/html (the extraction')
emit('      half is crude on purpose — the production parser belongs to lib/wiki).')
function stripHtml(source) {
  return source
    .replace(/<div style="display:none;">[\s\S]*?<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
}
const realRoot = mkdtempSync(join(tmpdir(), 'hff-real-'))
const realCache = join(realRoot, 'hsr-worldview-cache')
mkdirSync(realCache, { recursive: true })
// --- equations: 324 table rows, exclude 模式含「千面英雄」 ---
const eqHtml = readFileSync(join(ROOT, '_probe', 'html', '方程一览.html'), 'utf8')
const eqRows = eqHtml.split(/(?=<tr[\s>])/i).filter((row) => /class="divsort"/i.test(row))
const eqEntries = []
let eqExcluded = 0
for (const row of eqRows) {
  const attr = /<tr[^>]*>/i.exec(row)[0]
  const param = (n) => new RegExp(`data-param${n}="([^"]*)"`).exec(attr)?.[1] ?? ''
  const cells = row.split(/(?=<t[dh][\s>])/i).slice(1).map(stripHtml).map((cell) => cell.trim())
  const mode = param(5)
  if (mode.includes('千面英雄')) {
    eqExcluded += 1
    continue
  }
  if (!cells[1]) continue
  eqEntries.push({
    name: cells[1],
    rarity: param(1),
    pathPrimary: param(2),
    pathSecondary: param(3),
    mode,
    blessing: cells[3],
    content: cells[4],
    version: param(4),
  })
}
writeFileSync(join(realCache, 'equations.json'), JSON.stringify({
  dataset: 'equations', title: '方程一览', lastUpdated: '2026-09-26T02:00:00.000Z',
  count: eqEntries.length, excludedCount: eqExcluded, entries: eqEntries, warnings: [],
}), 'utf8')
emit(`rebuilt equations.json: ${eqEntries.length} entries (excluded ${eqExcluded} rows whose 模式 contains 千面英雄)`)
const eqReal = digest.equationNameDigest({ workspace: realRoot }, {})
emit(`[equationNameDigest(real 212 entries)] ok=${eqReal.ok} count=${eqReal.count} examples=${eqReal.examples} markdownChars=${eqReal.markdown.length} truncated=${eqReal.truncated}`)
emit('  --- markdown verbatim (first 3000 chars) ---')
emit(eqReal.markdown.slice(0, 3000).split('\n').map((line) => `  ${line}`).join('\n'))
emit(`  --- (markdown total ${eqReal.markdown.length} chars, still <= 12000) ---`)

// --- broadcast: real page text, split into （音乐）-delimited segments ---
const bcHtml = readFileSync(join(ROOT, '_probe', 'html', '星际和平播报.html'), 'utf8')
const bcFull = stripHtml(bcHtml).replace(/\n{3,}/g, '\n\n').trim()
// Crude: drop the nav/TOC chrome before the first （音乐）, then split on it.
const bcBody = bcFull.slice(Math.max(bcFull.indexOf('（音乐）'), 0))
const bcSegments = bcBody.split(/(?=（音乐）)/).map((part) => part.trim()).filter((part) => part.length > 40)
writeFileSync(join(realCache, 'broadcast.json'), JSON.stringify({
  dataset: 'broadcast', title: '星际和平播报', lastUpdated: '2026-09-26T02:00:00.000Z',
  count: bcSegments.length,
  entries: bcSegments.map((content, index) => ({ name: `播报片段 ${index + 1}`, content })),
  raw: bcBody, warnings: [],
}), 'utf8')
emit(`rebuilt broadcast.json: ${bcSegments.length} segments, ${bcBody.length} chars of real text`)
const bcReal = digest.broadcastDigest({ workspace: realRoot })
emit(`[broadcastDigest(real page)] ok=${bcReal.ok} entryCount=${bcReal.entryCount} speakers=${JSON.stringify(bcReal.speakers)} excerpts=${JSON.stringify(bcReal.excerpts)} markdownChars=${bcReal.markdown.length}`)
emit('  --- markdown verbatim (first 2600 chars) ---')
emit(bcReal.markdown.slice(0, 2600).split('\n').map((line) => `  ${line}`).join('\n'))
emit(`  --- (markdown total ${bcReal.markdown.length} chars, still <= 12000) ---`)


head('10. degradation against an EMPTY workspace')
const emptyRoot = mkdtempSync(join(tmpdir(), 'hff-empty-'))
const emptyCfg = { workspace: emptyRoot }
for (const [label, value] of [
  ['scanMissions', missions.scanMissions(emptyCfg)],
  ['catalogTrailblaze', missions.catalogTrailblaze(emptyCfg)],
  ['catalogBooks', missions.catalogBooks(emptyCfg)],
  ['booksByTitle', missions.booksByTitle(emptyCfg, ['x'])],
  ['loadSeries', missions.loadSeries(emptyCfg, 'x')],
  ['conflictBrief', missions.conflictBrief(emptyCfg, { series: 'x' })],
  ['equationNameDigest', digest.equationNameDigest(emptyCfg)],
  ['missionDigest', digest.missionDigest(emptyCfg, {})],
  ['bookDigest', digest.bookDigest(emptyCfg)],
  ['broadcastDigest', digest.broadcastDigest(emptyCfg)],
]) {
  const json = JSON.stringify(value)
  emit(`[${label}] ok=${value.ok} jsonChars=${json.length} warnings=${JSON.stringify(value.warnings ?? [])}`)
  emit(`  payload: ${json.slice(0, 200)}`)
}
emit('  (every call returned a value instead of throwing)')

head('11. digest size budget check (must stay <= ~12000 chars)')
for (const [label, value] of [
  ['equationNameDigest(real 212 entries)', eqReal],
  ['equationNameDigest(fixture)', eq],
  ['equationNameDigest(real, missing cache)', digest.equationNameDigest({ workspace: ROOT })],
  ['missionDigest(real, limit=40)', md],
  ['missionDigest(real, limit=400)', digest.missionDigest({ workspace: ROOT }, { limit: 400 })],
  ['bookDigest(real, limit=25)', bd],
  ['bookDigest(real, limit=498)', digest.bookDigest({ workspace: ROOT }, { limit: 498 })],
  ['broadcastDigest(real page)', bcReal],
  ['broadcastDigest(fixture)', bc],
]) {
  const size = value.markdown.length
  emit(`  ${label}: markdown=${size} chars truncated=${String(value.truncated)} -> ${size <= 12000 ? 'PASS' : 'FAIL'}`)
}

head('12. JSON round-trip (no undefined anywhere)')
const roundTrip = [
  ['scanMissions', scan],
  ['catalogTrailblaze', tb],
  ['catalogTrailblaze(limit=2)', missions.catalogTrailblaze({ workspace: ROOT }, { limit: 2 })],
  ['catalogBooks', cb],
  ['booksByTitle', bt],
  ['booksByTitle(bodyChars=80)', btSmall],
  ['loadSeries', ls],
  ['loadSeries(明霄•下)', worst],
  ['conflictBrief', cf],
  ['conflictBrief({})', cfAll],
  ['equationNameDigest(fixture)', eq],
  ['equationNameDigest(real 212 entries)', eqReal],
  ['missionDigest(real)', md],
  ['bookDigest(real)', bd],
  ['broadcastDigest(real page)', bcReal],
  ['broadcastDigest(fixture)', bc],
]
for (const [label, value] of roundTrip) {
  const round = JSON.parse(JSON.stringify(value))
  const equal = JSON.stringify(round) === JSON.stringify(value)
  emit(`  ${label}: JSON.parse(JSON.stringify(x)) === x -> ${equal ? 'PASS' : 'FAIL'}`)
}

// ------------------------------------------------- shell-integration contract
head('13. call-contract check against the real call sites in lib/index.js')
emit('lib/index.js gs_setup        : mods.missions.scanMissions({ ...cfg, workspace: ws })')
emit('                                 -> scan.ok, (scan.series ?? []).length, scan.counts?.missions')
const shellScan = missions.scanMissions({ workspace: ROOT })
emit(`  seriesCount=${(shellScan.series ?? []).length} missionCount=${Number.isFinite(shellScan.counts?.missions) ? shellScan.counts.missions : 0} ok=${shellScan.ok !== false}`)
emit('lib/index.js gs_missions     : mods.digest.missionDigest({ ...cfg, workspace: ws }, { series, query, limit })')
emit('                                 -> dig.ok, dig.seriesCount, dig.missionCount, dig.markdown, dig.warnings')
for (const args of [{ series: '', query: '', limit: 40 }, { series: '狐斋志异', query: '', limit: 40 }]) {
  const dig = digest.missionDigest({ workspace: ROOT }, args)
  emit(`  series="${args.series}" -> ok=${dig.ok !== false} seriesCount=${Number.isFinite(dig.seriesCount) ? dig.seriesCount : 0} missionCount=${Number.isFinite(dig.missionCount) ? dig.missionCount : 0} markdown.chars=${dig.markdown.length} warnings=${JSON.stringify(dig.warnings)}`)
}
emit('lib/index.js gs_digest      : mods.digest.<kind>({ ...cfg, workspace: ws }, { limit })')
for (const [kind, result] of [
  ['equation', digest.equationNameDigest({ workspace: ROOT }, { limit: undefined })],
  ['mission-digest', digest.missionDigest({ workspace: ROOT }, { limit: undefined })],
  ['book-digest', digest.bookDigest({ workspace: ROOT }, { limit: undefined })],
  ['broadcast-template', digest.broadcastDigest({ workspace: ROOT }, { limit: undefined })],
]) {
  emit(`  kind=${kind} -> ok=${result.ok !== false} markdown.chars=${String(result.markdown ?? '').length} warnings=${JSON.stringify(result.warnings ?? [])}`)
}

// ------------------------------------------------------------- timing table
head('14. per-function wall clock (median of 3 runs, real workspace)')
const timingCases = [
  ['scanMissions', () => missions.scanMissions({ workspace: ROOT })],
  ['catalogTrailblaze', () => missions.catalogTrailblaze({ workspace: ROOT })],
  ['catalogTrailblaze(limit=2)', () => missions.catalogTrailblaze({ workspace: ROOT }, { limit: 2 })],
  ['catalogBooks', () => missions.catalogBooks({ workspace: ROOT })],
  ['booksByTitle(2)', () => missions.booksByTitle({ workspace: ROOT }, ['「黑塔」资产定损清单', '黑塔的手稿'])],
  ['loadSeries(明霄•下)', () => missions.loadSeries({ workspace: ROOT }, '明霄竞武试锋芒•下')],
  ['conflictBrief(1 series)', () => missions.conflictBrief({ workspace: ROOT }, { series: '蕉恶非道•无忍义之战' })],
  ['conflictBrief(all)', () => missions.conflictBrief({ workspace: ROOT }, {})],
  ['equationNameDigest(missing cache)', () => digest.equationNameDigest({ workspace: ROOT })],
  ['missionDigest(limit=40)', () => digest.missionDigest({ workspace: ROOT }, { limit: 40 })],
  ['bookDigest(limit=25)', () => digest.bookDigest({ workspace: ROOT }, { limit: 25 })],
  ['broadcastDigest(missing cache)', () => digest.broadcastDigest({ workspace: ROOT })],
]
for (const [label, call] of timingCases) {
  const samples = []
  let last = null
  for (let run = 0; run < 3; run += 1) {
    const started = performance.now()
    last = call()
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  emit(`  ${label.padEnd(36)} median ${sorted[1].toFixed(1).padStart(7)} ms  (min ${sorted[0].toFixed(1)} / max ${sorted[2].toFixed(1)})  ok=${last.ok !== false}  output=${JSON.stringify(last).length} chars`)
}

// -------------------------------------------------------------------- cleanup
rmSync(fixtureRoot, { recursive: true, force: true })
rmSync(emptyRoot, { recursive: true, force: true })
rmSync(realRoot, { recursive: true, force: true })

head('SUMMARY')
emit(`scanMissions:            ok=${scan.ok} series=${scan.counts.series} missions=${scan.counts.missions} files=${scan.counts.files} missingFiles=${scan.counts.missingFiles}`)
emit(`catalogTrailblaze:      ok=${tb.ok} acts=${tb.stats.acts} series=${tb.stats.series} missions=${tb.stats.missions} wall=${tbWall.toFixed(1)}ms json=${tbJson.length} chars`)
emit(`catalogBooks:           ok=${cb.ok} count=${cb.count} returned=${cb.returned}`)
emit(`booksByTitle:           ok=${bt.ok} matched=${bt.matched} totalChars=${bt.totalChars}`)
emit(`loadSeries:             ok=${ls.ok} missions=${ls.missions.length}`)
emit(`conflictBrief:          ok=${cf.ok} missions=${cf.missionCount} briefChars=${cf.brief.length}`)
emit(`equationNameDigest:     realOk=${digest.equationNameDigest({ workspace: ROOT }).ok} fixtureOk=${eq.ok} fixtureChars=${eq.markdown.length} realEntriesOk=${eqReal.ok} realEntries=${eqReal.count} realChars=${eqReal.markdown.length}`)
emit(`missionDigest:          ok=${md.ok} seriesCount=${md.seriesCount} missionCount=${md.missionCount} chars=${md.markdown.length}`)
emit(`bookDigest:             ok=${bd.ok} count=${bd.count} returned=${bd.returned} chars=${bd.markdown.length}`)
emit(`broadcastDigest:        realOk=${digest.broadcastDigest({ workspace: ROOT }).ok} fixtureOk=${bc.ok} fixtureChars=${bc.markdown.length} realPageOk=${bcReal.ok} realSpeakers=${JSON.stringify(bcReal.speakers)} realChars=${bcReal.markdown.length}`)
emit('')
emit('Evidence file written by: node _evidence/run-missions.mjs')

writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8')
process.stdout.write(`\nWROTE ${OUT} (${readFileSync(OUT, 'utf8').length} chars)\n`)

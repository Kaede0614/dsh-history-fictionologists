/**
 * node:test suite for lib/missions.js + lib/digest.js.
 *
 *   node --test test/missions.test.mjs
 *
 * Covers: real-workspace happy path, missing-directory degradation, truncation
 * limits and the "no undefined anywhere" JSON contract.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'

import {
  booksByTitle,
  catalogBooks,
  catalogTrailblaze,
  conflictBrief,
  loadSeries,
  scanMissions,
} from '../lib/missions.js'
import {
  bookDigest,
  broadcastDigest,
  equationNameDigest,
  missionDigest,
} from '../lib/digest.js'

const ROOT = resolve(import.meta.dirname, '..')
const CFG = { workspace: ROOT }
const MAX_JSON = 200 * 1024
const MAX_DIGEST = 12000

const BOOK_FILE = join(ROOT, 'hsr-missions', 'books_without_amphoreus.json')
const TRAILBLAZE_FILE = join(ROOT, 'hsr-missions', 'trailblaze_missions.json')
const CONTINUATION_INDEX = join(ROOT, 'hsr-missions', 'sr-开拓续闻-完整', 'index.json')
const CACHE_DIR = join(ROOT, 'hsr-worldview-cache')
const HAS_CACHE = existsSync(join(CACHE_DIR, 'equations.json'))

/**
 * The real game corpus under `hsr-missions/` is NOT part of the published
 * repository (see .gitignore): those ~20 MB of raw script JSON only exist in
 * the author's working copy. Every test that replays it must SKIP in a fresh
 * clone — through the node:test skip mechanism, so `node --test` reports it as
 * `skipped`; never by failing, and never by silently passing.
 *
 * `false` means "every file is present, run the test with its full assertions";
 * a string is the skip reason naming the missing file(s).
 */
function localDataSkip(files) {
  const missing = files.filter((file) => !existsSync(file))
  if (missing.length === 0) return false
  const names = missing.map((file) => file.slice(ROOT.length + 1).replace(/\\/g, '/'))
  const shown = names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} (+${names.length - 4} more)`
  return `${shown} ${missing.length === 1 ? 'is' : 'are'} not in this checkout (see .gitignore)`
}

/** What each failing-in-a-clone test group actually reads off the disk. */
const SCAN_SKIP = localDataSkip([CONTINUATION_INDEX])
const TRAILBLAZE_SKIP = localDataSkip([TRAILBLAZE_FILE])
const BOOKS_SKIP = localDataSkip([BOOK_FILE])
const BOOKS_AND_SCAN_SKIP = localDataSkip([CONTINUATION_INDEX, BOOK_FILE])
const REAL_WORKSPACE_SKIP = localDataSkip([CONTINUATION_INDEX, TRAILBLAZE_FILE, BOOK_FILE])

const tempDirs = []
function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'hff-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** The mandatory JSON contract: a round-trip must be a deep-equal no-op. */
function assertJsonSafe(value, label) {
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(value)),
    value,
    `${label}: JSON.parse(JSON.stringify(x)) must deep-equal x (undefined leaked?)`,
  )
}

function assertNoUndefined(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.notStrictEqual(item, undefined, `${path}.${key} is undefined`)
      assertNoUndefined(item, `${path}.${key}`)
    }
  }
}

function assertBoundedString(value, max, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(value.length <= max, `${label} must be <= ${max} chars, got ${value.length}`)
}

function assertWarnings(value, label) {
  assert.ok(Array.isArray(value.warnings), `${label}.warnings must be an array`)
  assert.ok(value.warnings.length > 0, `${label}.warnings must explain the failure`)
  for (const warning of value.warnings) assert.equal(typeof warning, 'string')
}

/** Digest fixture mirroring the cache contract (§3.3 equations entries). */
function writeEquationsFixture(dir) {
  const cache = join(dir, 'hsr-worldview-cache')
  mkdirSync(cache, { recursive: true })
  const entries = [
    { name: '睡前故事', rarity: '4星', pathPrimary: '记忆', pathSecondary: '', mode: '人间喜剧', blessing: '记忆×8', content: '进入战斗时，我方全体获得【安眠】。', version: '3.0' },
    { name: '可爱黑洞', rarity: '4星', pathPrimary: '虚无', pathSecondary: '', mode: '人间喜剧', blessing: '虚无×8', content: '敌方全体被【吞噬】，行动延后50%。', version: '3.0' },
    { name: '最后的子弹', rarity: '4星', pathPrimary: '巡猎', pathSecondary: '', mode: '乐园漫记', blessing: '巡猎×8', content: '首次击破弱点时，立即追加一次攻击。', version: '4.5' },
    { name: '大鼻子奶奶', rarity: '3星', pathPrimary: '虚无', pathSecondary: '欢愉', mode: '乐园漫记', blessing: '虚无×6 欢愉×4', content: '【发牌员】攻击段数提高4，每次造成伤害时为我方全体提供1层【切牌】。', version: '4.5' },
    { name: '狂猎团', rarity: '3星', pathPrimary: '巡猎', pathSecondary: '同谐', mode: '乐园漫记', blessing: '巡猎×6 同谐×3', content: '累计削减韧性后使敌方获得【逆会心】。', version: '4.5' },
    { name: '怒火船长', rarity: '3星', pathPrimary: '毁灭', pathSecondary: '智识', mode: '乐园漫记', blessing: '毁灭×6 智识×4', content: '行动序列上出现【磁暴】，吸收我方护盾。', version: '4.5' },
    { name: '黄昏金时大剧院', rarity: '3星', pathPrimary: '欢愉', pathSecondary: '繁育', mode: '乐园漫记', blessing: '欢愉×6 繁育×4', content: '每点充能使暴击伤害提高10%。', version: '4.5' },
    { name: '背锅侠', rarity: '2星', pathPrimary: '虚无', pathSecondary: '同谐', mode: '人间喜剧', blessing: '虚无×4 同谐×2', content: '受到的伤害转移给【替罪羊】。', version: '2.0' },
    { name: '巴掌侠', rarity: '2星', pathPrimary: '毁灭', pathSecondary: '虚无', mode: '乐园漫记', blessing: '毁灭×4 虚无×2', content: '施放攻击后额外造成一次附加伤害。', version: '4.5' },
    { name: '天体殡葬师', rarity: '2星', pathPrimary: '巡猎', pathSecondary: '记忆', mode: '乐园漫记', blessing: '巡猎×4 记忆×2', content: '击破敌方目标后，记录其【遗骸】。', version: '4.5' },
    { name: '火与危险事物', rarity: '2星', pathPrimary: '记忆', pathSecondary: '智识', mode: '人间喜剧', blessing: '记忆×4 智识×2', content: '每次施放战技后灼烧敌方全体。', version: '3.0' },
    { name: '肥皂车骑士', rarity: '1星', pathPrimary: '欢愉', pathSecondary: '', mode: '人间喜剧', blessing: '欢愉×3', content: '每回合开始时随机获得1个【笑料】。', version: '1.0' },
  ]
  writeFileSync(join(cache, 'equations.json'), JSON.stringify({
    dataset: 'equations',
    title: '方程一览',
    url: 'https://wiki.biligame.com/sr/方程一览',
    lastUpdated: '2026-09-26T02:00:00.000Z',
    revisionId: 12345,
    pageSha: 'abcdef0123456789',
    count: entries.length,
    excludedCount: 112,
    entries,
    warnings: [],
  }), 'utf8')
  return cache
}

/** Digest fixture mirroring the broadcast cache (§3.3: entries[] + raw). */
function writeBroadcastFixture(dir) {
  const cache = join(dir, 'hsr-worldview-cache')
  mkdirSync(cache, { recursive: true })
  const entries = [
    { name: '完成雅利洛-Ⅵ开拓任务', content: '（音乐）\n女声：这里是星际和平播报，观众朋友们晚上好。\n男声：晚上好。\n女声：「存护」克里珀的巨锤徐徐下落，锤声响彻寰宇。\n男声：博识学会星空生态学派宣布：琥珀历2157纪结束。\n（音乐）' },
    { name: '完成仙舟「罗浮」开拓任务', content: '（音乐）\n女声：这里是星际和平播报，观众朋友们晚上好。\n男声：晚上好。\n女声：仙舟「罗浮」的建木灾异已经平息，云骑军宣布解除最高戒备。\n男声：星际和平公司提醒各位旅客，出行前请确认航线。\n女声：本次播报到此结束，请在指定时间收听下一周期的星际和平播报。\n（音乐）' },
  ]
  writeFileSync(join(cache, 'broadcast.json'), JSON.stringify({
    dataset: 'broadcast',
    title: '星际和平播报',
    count: entries.length,
    entries,
    raw: entries.map((entry) => entry.content).join('\n\n'),
    warnings: [],
  }), 'utf8')
  return cache
}

// ---------------------------------------------------------------------------
describe('real workspace: happy path', () => {
  it('scanMissions indexes 7 series / 52 missions from the two index levels only', { skip: SCAN_SKIP }, () => {
    const result = scanMissions(CFG)
    assertJsonSafe(result, 'scanMissions')
    assertNoUndefined(result)
    assert.equal(result.ok, true)
    assert.equal(result.root, join(ROOT, 'hsr-missions'))
    assert.equal(result.counts.series, 7)
    assert.equal(result.counts.missions, 52)
    assert.equal(result.counts.files, 52)
    assert.equal(result.counts.missingFiles, 0)
    assert.equal(result.counts.byRegion['仙舟「罗浮」'], 32)
    assert.deepEqual(
      result.series.map((series) => series.name).sort(),
      ['亏成首富，从不要钱开始', '冬梦激醒', '庸与神的冠冕', '明霄竞武试锋芒•上', '明霄竞武试锋芒•下', '狐斋志异', '蕉恶非道•无忍义之战'].sort(),
    )
    for (const series of result.series) {
      assert.equal(typeof series.region, 'string')
      assert.equal(typeof series.version, 'string')
      assert.equal(series.missions.length, series.missionCount)
      for (const mission of series.missions) {
        assert.equal(typeof mission.name, 'string')
        assert.equal(mission.exists, true)
        assert.equal(mission.region, series.region)
        assert.equal(mission.version, series.version)
      }
    }
  })

  it('catalogTrailblaze parses the 13.9 MB file and returns a compact, bounded catalog', { skip: TRAILBLAZE_SKIP }, () => {
    const result = catalogTrailblaze(CFG)
    assertJsonSafe(result, 'catalogTrailblaze')
    assertNoUndefined(result)
    const json = JSON.stringify(result)
    assert.ok(
      json.length < MAX_JSON,
      `catalogTrailblaze JSON must stay under 200 KB, got ${json.length}`,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(result.stats, { acts: 5, series: 18, missions: 147 })
    assert.equal(result.acts.length, 5)
    assert.equal(result.filter.limit, 40)
    const seriesCount = result.acts.reduce((total, act) => total + act.series.length, 0)
    assert.equal(seriesCount, 18)
    for (const act of result.acts) {
      assert.equal(typeof act.act, 'string')
      for (const series of act.series) {
        assert.equal(typeof series.series, 'string')
        assert.equal(typeof series.missionCount, 'number')
        assert.equal(typeof series.truncated, 'boolean')
        for (const mission of series.missions) {
          const keys = Object.keys(mission).sort()
          for (const key of keys) assert.ok(['characters', 'description', 'name'].includes(key), `unexpected mission key ${key}`)
          // `characters` / `description` are omitted when the source field is empty.
          if ('characters' in mission) assert.ok(Array.isArray(mission.characters))
          assertBoundedString(mission.description ?? '', 400, `description of ${mission.name}`)
        }
      }
    }
    // No dialogue was smuggled into the catalog.
    for (const banned of ['"story"', '"summary"', '"objectives"', '剧情wiki原文']) {
      assert.ok(!json.includes(banned), `catalog must not contain ${banned}`)
    }
  })

  it('catalogTrailblaze honours act / series filters', { skip: TRAILBLAZE_SKIP }, () => {
    const byAct = catalogTrailblaze(CFG, { act: '第三幕' })
    assertJsonSafe(byAct, 'catalogTrailblaze(act)')
    assert.equal(byAct.acts.length, 1)
    assert.equal(byAct.acts[0].act, '第三幕•匹诺康尼')
    assert.equal(byAct.filter.act, '第三幕')

    const bySeries = catalogTrailblaze(CFG, { series: '鸽群中的猫' })
    assertJsonSafe(bySeries, 'catalogTrailblaze(series)')
    assert.equal(bySeries.acts.length, 1)
    assert.equal(bySeries.acts[0].series.length, 1)
    assert.equal(bySeries.acts[0].series[0].series, '鸽群中的猫')
    assert.equal(bySeries.acts[0].series[0].missionCount, 9)

    const miss = catalogTrailblaze(CFG, { act: '不存在的幕' })
    assertJsonSafe(miss, 'catalogTrailblaze(miss)')
    assert.equal(miss.ok, false)
    assertWarnings(miss, 'catalogTrailblaze(miss)')
  })

  it('catalogBooks returns 498 metadata-only entries and never a body', { skip: BOOKS_SKIP }, () => {
    const result = catalogBooks(CFG)
    assertJsonSafe(result, 'catalogBooks')
    assertNoUndefined(result)
    assert.equal(result.ok, true)
    assert.equal(result.count, 498)
    assert.equal(result.returned, 498)
    assert.equal(result.books.length, 498)
    assert.equal(existsSync(BOOK_FILE), true)
    const allowed = ['characters', 'description', 'region', 'title', 'type']
    for (const book of result.books) {
      for (const key of Object.keys(book)) assert.ok(allowed.includes(key), `unexpected book key ${key}`)
      assert.equal(typeof book.title, 'string')
      assert.ok(book.title.length > 0)
      assertBoundedString(book.description ?? '', 160, `description of ${book.title}`)
    }
    // Metadata only: no volume array, no body key on any entry.
    for (const book of result.books) {
      assert.ok(!('分卷' in book), 'catalogBooks must not carry 分卷')
      assert.ok(!('内容' in book), 'catalogBooks must not carry 内容 (body text)')
    }
  })

  it('booksByTitle returns real bodies, capped per volume', { skip: BOOKS_SKIP }, () => {
    const result = booksByTitle(CFG, ['「黑塔」资产定损清单', '黑塔的手稿'])
    assertJsonSafe(result, 'booksByTitle')
    assertNoUndefined(result)
    assert.equal(result.ok, true)
    assert.equal(result.matched, 2)
    assert.deepEqual(result.missing, [])
    assert.equal(result.books[0].title, '「黑塔」资产定损清单')
    assert.ok(result.books[0].volumes[0].body.includes('编号#3471'))
    assert.equal(result.books[1].volumes.length, 4)
    for (const book of result.books) {
      for (const volume of book.volumes) {
        assert.ok(volume.body.length <= 4000, `volume body must be capped at 4000 chars, got ${volume.body.length}`)
        assert.equal(typeof volume.truncated, 'boolean')
      }
    }
    const unknown = booksByTitle(CFG, ['这本不存在的书'])
    assertJsonSafe(unknown, 'booksByTitle(unknown)')
    assert.equal(unknown.ok, false)
    assert.deepEqual(unknown.missing, ['这本不存在的书'])
    assertWarnings(unknown, 'booksByTitle(unknown)')

    const none = booksByTitle(CFG, [])
    assertJsonSafe(none, 'booksByTitle(empty)')
    assert.equal(none.ok, false)
    assertWarnings(none, 'booksByTitle(empty)')
  })

  it('loadSeries returns a compact view with chapter titles but NO dialogue text', { skip: SCAN_SKIP }, () => {
    const result = loadSeries(CFG, '狐斋志异')
    assertJsonSafe(result, 'loadSeries')
    assertNoUndefined(result)
    assert.equal(result.ok, true)
    assert.equal(result.series, '狐斋志异')
    assert.equal(result.region, '仙舟「罗浮」')
    assert.equal(result.version, '1.5')
    assert.equal(result.missions.length, 9)
    const allowed = ['chapters', 'characters', 'description', 'name', 'objective']
    for (const mission of result.missions) {
      for (const key of Object.keys(mission)) assert.ok(allowed.includes(key), `unexpected mission key ${key}`)
      assert.ok(Array.isArray(mission.chapters))
      for (const chapter of mission.chapters) assert.equal(typeof chapter, 'string')
      assertBoundedString(mission.description ?? '', 240, `description of ${mission.name}`)
      assertBoundedString(mission.objective ?? '', 300, `objective of ${mission.name}`)
    }
    const json = JSON.stringify(result)
    for (const banned of ['剧情内容', '剧情wiki原文', '———', '文本']) {
      assert.ok(!json.includes(banned), `loadSeries must not leak ${banned}`)
    }
    const missing = loadSeries(CFG, '不存在的系列')
    assertJsonSafe(missing, 'loadSeries(missing)')
    assert.equal(missing.ok, false)
    assertWarnings(missing, 'loadSeries(missing)')
    assert.equal(missing.available.length, 7)

    const unnamed = loadSeries(CFG, '')
    assertJsonSafe(unnamed, 'loadSeries(empty)')
    assert.equal(unnamed.ok, false)
    assertWarnings(unnamed, 'loadSeries(empty)')
  })

  it('conflictBrief produces a model-facing avoidance brief', { skip: SCAN_SKIP }, () => {
    const result = conflictBrief(CFG, { series: '蕉恶非道•无忍义之战' })
    assertJsonSafe(result, 'conflictBrief')
    assertNoUndefined(result)
    assert.equal(result.ok, true)
    assert.equal(result.series, '蕉恶非道•无忍义之战')
    assert.deepEqual(result.places, ['匹诺康尼'])
    assert.equal(result.missionCount, 8)
    assert.equal(result.returned, 8)
    assert.ok(result.characters.includes('三月七'))
    assert.ok(result.brief.includes('既有故事避让清单'))
    assert.ok(result.brief.includes('一只安达鲁猴'))
    assertBoundedString(result.brief, MAX_DIGEST, 'conflictBrief.brief')
    for (const mission of result.missions) {
      assert.equal(typeof mission.name, 'string')
      assert.ok(Array.isArray(mission.characters))
      assertBoundedString(mission.description ?? '', 220, `brief description of ${mission.name}`)
    }
    const all = conflictBrief(CFG, {})
    assertJsonSafe(all, 'conflictBrief(all)')
    assert.equal(all.ok, true)
    assert.equal(all.missionCount, 52)
    assert.ok(all.truncated)
    assertBoundedString(all.brief, MAX_DIGEST, 'conflictBrief(all).brief')

    const unknown = conflictBrief(CFG, { series: '不存在的系列' })
    assertJsonSafe(unknown, 'conflictBrief(unknown)')
    assert.equal(unknown.ok, false)
    assertWarnings(unknown, 'conflictBrief(unknown)')
    assert.equal(unknown.available.length, 7)
  })

  it('missionDigest / bookDigest work on the real workspace', { skip: REAL_WORKSPACE_SKIP }, () => {
    const missions = missionDigest(CFG, { limit: 6 })
    assertJsonSafe(missions, 'missionDigest')
    assertNoUndefined(missions)
    assert.equal(missions.ok, true)
    assert.equal(missions.seriesCount, 7)
    assert.equal(missions.missionCount, 52)
    assert.equal(missions.returned, 6)
    assert.equal(missions.truncatedByLimit, true)
    assertBoundedString(missions.markdown, MAX_DIGEST, 'missionDigest.markdown')
    assert.ok(missions.markdown.includes('已发生故事'))

    // Markup residue from the source (8 of 52 `任务描述` carry `<br>`) must be cleaned.
    const full = missionDigest(CFG, { limit: 200 })
    assert.ok(!full.markdown.includes('<br>'), 'digest must not surface <br> residue')
    assert.ok(!/<[a-zA-Z/][^>]{0,40}>/.test(full.markdown), 'digest must not surface raw HTML tags')

    const one = missionDigest(CFG, { series: '狐斋志异', limit: 40 })
    assertJsonSafe(one, 'missionDigest(series)')
    assert.equal(one.seriesCount, 1)
    assert.equal(one.missionCount, 9)
    assert.equal(one.returned, 9)

    const unknown = missionDigest(CFG, { series: '不存在的系列' })
    assertJsonSafe(unknown, 'missionDigest(unknown)')
    assert.equal(unknown.ok, false)
    assertWarnings(unknown, 'missionDigest(unknown)')
    assert.ok(unknown.markdown.length > 0, 'failure markdown must still explain itself')

    const books = bookDigest(CFG, { limit: 8 })
    assertJsonSafe(books, 'bookDigest')
    assertNoUndefined(books)
    assert.equal(books.ok, true)
    assert.equal(books.count, 498)
    assert.equal(books.returned, 8)
    assert.equal(books.markdown.includes('书架'), true)
    assertBoundedString(books.markdown, MAX_DIGEST, 'bookDigest.markdown')
    assert.equal(books.types.length >= 1, true)

    const booksLarge = bookDigest(CFG, { limit: 498 })
    assertJsonSafe(booksLarge, 'bookDigest(498)')
    assert.equal(booksLarge.truncated, true)
    assertBoundedString(booksLarge.markdown, MAX_DIGEST, 'bookDigest(498).markdown')
  })

  it('equationNameDigest / broadcastDigest degrade on the real workspace', { skip: HAS_CACHE ? 'cache already exists' : false }, () => {
    const equations = equationNameDigest(CFG)
    assertJsonSafe(equations, 'equationNameDigest(missing cache)')
    assert.equal(equations.ok, false)
    assertWarnings(equations, 'equationNameDigest(missing cache)')
    assert.ok(equations.markdown.length > 0, 'must return an explanatory note, not empty markdown')

    const broadcast = broadcastDigest(CFG)
    assertJsonSafe(broadcast, 'broadcastDigest(missing cache)')
    assert.equal(broadcast.ok, false)
    assertWarnings(broadcast, 'broadcastDigest(missing cache)')
    assert.ok(broadcast.markdown.length > 0)
    // The format template is static knowledge, so it survives even without a cache.
    assert.ok(broadcast.formatTemplate.includes('（音乐）'))
    assert.ok(broadcast.formatTemplate.includes('女声：这里是星际和平播报'))
  })
})

// ---------------------------------------------------------------------------
describe('synthetic cache: digest happy path', () => {
  it('equationNameDigest groups by path with rarity and gives 10-15 worked examples', () => {
    const dir = tempWorkspace()
    writeEquationsFixture(dir)
    const result = equationNameDigest({ workspace: dir })
    assertJsonSafe(result, 'equationNameDigest(fixture)')
    assertNoUndefined(result)
    assert.equal(result.ok, true)
    assert.equal(result.count, 12)
    assert.ok(result.examples >= 10 && result.examples <= 15, `examples must be 10-15, got ${result.examples}`)
    assertBoundedString(result.markdown, MAX_DIGEST, 'equationNameDigest.markdown')
    assert.ok(result.markdown.includes('按主命途分组'))
    assert.ok(result.markdown.includes('虚无'))
    assert.ok(result.markdown.includes('大鼻子奶奶'))
    assert.ok(result.markdown.includes('【3星·欢愉】'))
    assert.ok(result.markdown.includes('嫁接范例'))
  })

  it('equationNameDigest survives a corrupt cache file', () => {
    const dir = tempWorkspace()
    mkdirSync(join(dir, 'hsr-worldview-cache'), { recursive: true })
    writeFileSync(join(dir, 'hsr-worldview-cache', 'equations.json'), '{ not json', 'utf8')
    const result = equationNameDigest({ workspace: dir })
    assertJsonSafe(result, 'equationNameDigest(corrupt)')
    assert.equal(result.ok, false)
    assertWarnings(result, 'equationNameDigest(corrupt)')
  })

  it('broadcastDigest prefers speaker segments over page chrome', () => {
    const dir = tempWorkspace()
    const cache = join(dir, 'hsr-worldview-cache')
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'broadcast.json'), JSON.stringify({
      dataset: 'broadcast',
      entries: [
        { name: '页面噪声', content: '编 刷 历 短 阅 首页 > 互动文本/星穹列车 > 星际和平播报\n目录\n1 完成雅利洛-Ⅵ开拓任务\n2 完成仙舟「罗浮」开拓任务' },
        { name: '完成雅利洛-Ⅵ开拓任务', content: '（音乐）\n女声：这里是星际和平播报，观众朋友们晚上好。\n男声：晚上好。\n（音乐）' },
        { name: '完成仙舟「罗浮」开拓任务', content: '（音乐）\n女声：仙舟「罗浮」的建木灾异已经平息。\n男声：公司提醒旅客确认航线。\n（音乐）' },
        { name: '匹诺康尼开拓任务起始', content: '（音乐）\n女声：盛会之星「匹诺康尼」向各派系发出邀约。\n男声：公司正在评估。\n（音乐）' },
      ],
      warnings: [],
    }), 'utf8')
    const result = broadcastDigest({ workspace: dir })
    assertJsonSafe(result, 'broadcastDigest(chrome)')
    assert.equal(result.ok, true)
    assert.equal(result.excerpts.length, 3)
    for (const excerpt of result.excerpts) {
      assert.notEqual(excerpt.name, '页面噪声', 'page chrome must not outrank real broadcast segments')
    }
    assert.ok(result.markdown.includes('女声：'))
    assert.ok(!result.markdown.includes('页面噪声'))
  })

  it('broadcastDigest warns when no speaker line exists at all', () => {
    const dir = tempWorkspace()
    const cache = join(dir, 'hsr-worldview-cache')
    mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, 'broadcast.json'), JSON.stringify({
      dataset: 'broadcast',
      entries: [{ name: '全文', content: '这是一段没有说话人标记的文本，长度足够但缺少女声和男声行。'.repeat(3) }],
      warnings: [],
    }), 'utf8')
    const result = broadcastDigest({ workspace: dir })
    assertJsonSafe(result, 'broadcastDigest(no speakers)')
    assert.equal(result.ok, true)
    assert.ok(result.warnings.some((warning) => warning.includes('说话人')))
    assert.equal(result.speakers.female, 0)
  })

  it('broadcastDigest returns the speaker template, stats and real excerpts', () => {
    const dir = tempWorkspace()
    writeBroadcastFixture(dir)
    const result = broadcastDigest({ workspace: dir })
    assertJsonSafe(result, 'broadcastDigest(fixture)')
    assertNoUndefined(result)
    assert.equal(result.ok, true)
    assert.equal(result.entryCount, 2)
    assert.ok(result.speakers.female > 0)
    assert.ok(result.speakers.male > 0)
    assert.ok(result.speakers.music > 0)
    assert.equal(result.excerpts.length, 2)
    assertBoundedString(result.markdown, MAX_DIGEST, 'broadcastDigest.markdown')
    assert.ok(result.markdown.includes('女声：'))
    assert.ok(result.markdown.includes('（音乐）'))
    assert.equal(
      result.formatTemplate,
      [
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
      ].join('\n'),
      'formatTemplate must match BRIEF §8 功能 3 verbatim',
    )
    assert.ok(result.markdown.includes(result.formatTemplate))
  })
})

// ---------------------------------------------------------------------------
describe('missing-directory degradation', () => {
  const empty = tempWorkspace()
  const cfg = { workspace: empty }
  const missing = { workspace: join(empty, 'does', 'not', 'exist') }

  it('scanMissions reports ok:false with the resolved root', () => {
    const result = scanMissions(cfg)
    assertJsonSafe(result, 'scanMissions(empty)')
    assertNoUndefined(result)
    assert.equal(result.ok, false)
    assert.equal(result.root, join(empty, 'hsr-missions'))
    assert.deepEqual(result.series, [])
    assert.equal(result.counts.missions, 0)
    assertWarnings(result, 'scanMissions(empty)')
  })

  it('every exported function degrades instead of throwing', () => {
    const calls = [
      ['scanMissions', () => scanMissions(cfg)],
      ['catalogTrailblaze', () => catalogTrailblaze(cfg)],
      ['catalogBooks', () => catalogBooks(cfg)],
      ['booksByTitle', () => booksByTitle(cfg, ['x'])],
      ['loadSeries', () => loadSeries(cfg, 'x')],
      ['conflictBrief', () => conflictBrief(cfg, { series: 'x' })],
      ['equationNameDigest', () => equationNameDigest(cfg)],
      ['missionDigest', () => missionDigest(cfg, {})],
      ['bookDigest', () => bookDigest(cfg)],
      ['broadcastDigest', () => broadcastDigest(cfg)],
    ]
    for (const [label, call] of calls) {
      const result = call()
      assert.equal(typeof result, 'object', `${label} must return an object`)
      assert.equal(result.ok, false, `${label}.ok must be false on an empty workspace`)
      assertWarnings(result, label)
      assertJsonSafe(result, `${label}(empty)`)
      assertNoUndefined(result, `$${label}`)
    }
  })

  it('a completely absent workspace path is also tolerated', () => {
    for (const call of [
      () => scanMissions(missing),
      () => catalogTrailblaze(missing),
      () => catalogBooks(missing),
      () => booksByTitle(missing, ['x']),
      () => loadSeries(missing, 'x'),
      () => conflictBrief(missing, { series: 'x' }),
      () => equationNameDigest(missing),
      () => missionDigest(missing, {}),
      () => bookDigest(missing),
      () => broadcastDigest(missing),
    ]) {
      const result = call()
      assert.equal(result.ok, false)
      assertJsonSafe(result, 'absent workspace')
    }
  })

  it('copes with garbage cfg values instead of throwing', (t) => {
    // Junk cfg values resolve without touching the workspace corpus, so this
    // half keeps running in every checkout — including a fresh clone.
    for (const cfgValue of [{}, { workspace: '' }, { workspace: 42 }]) {
      const result = scanMissions(cfgValue)
      assertJsonSafe(result, `scanMissions(${JSON.stringify(cfgValue)})`)
      assert.equal(typeof result.ok, 'boolean')
    }
    // The rest asserts against the real hsr-missions corpus, which is not part
    // of the repository: SKIP it there instead of failing.
    if (REAL_WORKSPACE_SKIP !== false) {
      t.skip(REAL_WORKSPACE_SKIP)
      return
    }
    assert.equal(catalogTrailblaze(CFG, null).ok, true)
    assert.equal(catalogBooks(CFG, null).ok, true)
    assert.equal(conflictBrief(CFG, null).ok, true)
    assert.equal(missionDigest(CFG, null).ok, true)
    assert.equal(bookDigest(CFG, null).ok, true)
  })
})

// ---------------------------------------------------------------------------
describe('truncation limits', () => {
  it('catalogTrailblaze caps each series but keeps every act/series name', { skip: TRAILBLAZE_SKIP }, () => {
    const result = catalogTrailblaze(CFG, { limit: 2 })
    assertJsonSafe(result, 'catalogTrailblaze(limit=2)')
    assertNoUndefined(result)
    assert.equal(result.acts.length, 5)
    const seriesCount = result.acts.reduce((total, act) => total + act.series.length, 0)
    assert.equal(seriesCount, 18, 'every act/series name must survive the limit')
    let limited = 0
    for (const act of result.acts) {
      for (const series of act.series) {
        assert.ok(series.missions.length <= 2)
        assert.equal(series.returned, series.missions.length)
        if (series.missionCount > 2) {
          limited += 1
          assert.equal(series.truncated, true)
          assert.equal(series.omitted, series.missionCount - series.missions.length)
        }
      }
    }
    assert.ok(limited >= 16, `most series should be limited, got ${limited}`)
    assert.equal(result.counts.omittedMissions, 147 - result.counts.returnedMissions)
    const unlimited = catalogTrailblaze(CFG, { limit: 0 })
    assertJsonSafe(unlimited, 'catalogTrailblaze(limit=0)')
    assert.equal(unlimited.filter.limit, 0)
    assert.equal(unlimited.counts.returnedMissions, 147)
    assert.equal(unlimited.counts.omittedMissions, 0)
  })

  it('booksByTitle caps the body per volume and in total', { skip: BOOKS_SKIP }, () => {
    const perVolume = booksByTitle(CFG, ['「黑塔」资产定损清单'], { bodyChars: 50 })
    assertJsonSafe(perVolume, 'booksByTitle(bodyChars=50)')
    assert.equal(perVolume.truncated, true)
    assert.equal(perVolume.bounds.bodyChars, 50)
    assert.ok(perVolume.books[0].volumes[0].body.length <= 50)
    assert.equal(perVolume.books[0].volumes[0].truncated, true)
    assert.equal(perVolume.books[0].volumes[0].chars, 855)

    const total = booksByTitle(CFG, ['黑塔的手稿', '科员们的留言便条'], { totalChars: 200 })
    assertJsonSafe(total, 'booksByTitle(totalChars=200)')
    assert.equal(total.truncated, true)
    assert.ok(total.totalChars <= 200, `totalChars must respect the budget, got ${total.totalChars}`)
    assert.ok(total.books.some((book) => book.truncated))
  })

  it('catalogBooks / conflictBrief honour limit and mark truncation', { skip: BOOKS_AND_SCAN_SKIP }, () => {
    const books = catalogBooks(CFG, { limit: 3 })
    assertJsonSafe(books, 'catalogBooks(limit=3)')
    assert.equal(books.count, 498)
    assert.equal(books.returned, 3)
    assert.equal(books.truncated, true)
    assert.equal(books.bounds.books, 3)

    const brief = conflictBrief(CFG, { series: '蕉恶非道•无忍义之战', limit: 3 })
    assertJsonSafe(brief, 'conflictBrief(limit=3)')
    assert.equal(brief.returned, 3)
    assert.equal(brief.missionCount, 8)
    assert.equal(brief.truncated, true)
    assert.equal(brief.bounds.limit, 3)
    assertBoundedString(brief.brief, MAX_DIGEST, 'conflictBrief(limit=3).brief')

    const searched = conflictBrief(CFG, { series: '蕉恶非道•无忍义之战', query: '猴' })
    assertJsonSafe(searched, 'conflictBrief(query)')
    assert.equal(searched.ok, true)
    assert.ok(searched.missionCount < 8)
  })

  it('loadSeries keeps a whole series inside its own size budget', { skip: SCAN_SKIP }, () => {
    const result = loadSeries(CFG, '明霄竞武试锋芒•下')
    assertJsonSafe(result, 'loadSeries(明霄•下)')
    assert.equal(result.ok, true)
    assert.equal(result.missionCount, 14)
    assert.ok(JSON.stringify(result).length <= 16000, `series view too large: ${JSON.stringify(result).length}`)
    assert.equal(result.bounds.descriptionChars, 240)
  })

  it('every digest markdown stays inside the 12000-char budget', () => {
    const dir = tempWorkspace()
    writeEquationsFixture(dir)
    writeBroadcastFixture(dir)
    const digests = [
      equationNameDigest({ workspace: dir }, { limit: 1000, examples: 15 }),
      missionDigest(CFG, { limit: 1000 }),
      bookDigest(CFG, { limit: 498 }),
      broadcastDigest({ workspace: dir }),
      bookDigest(CFG),
      missionDigest(CFG, {}),
    ]
    for (const digest of digests) {
      assertJsonSafe(digest, 'digest budget')
      assertBoundedString(digest.markdown, MAX_DIGEST, 'digest.markdown')
    }
  })
})

// ---------------------------------------------------------------------------
describe('no undefined in any returned object', () => {
  const empty = tempWorkspace()
  const dir = tempWorkspace()
  writeEquationsFixture(dir)
  writeBroadcastFixture(dir)

  const results = [
    ['scanMissions', scanMissions(CFG)],
    ['catalogTrailblaze', catalogTrailblaze(CFG)],
    ['catalogTrailblaze(limit=1)', catalogTrailblaze(CFG, { limit: 1 })],
    ['catalogTrailblaze(act)', catalogTrailblaze(CFG, { act: '第二幕' })],
    ['catalogBooks', catalogBooks(CFG)],
    ['catalogBooks(limit)', catalogBooks(CFG, { limit: 2 })],
    ['booksByTitle', booksByTitle(CFG, ['黑塔情诗'])],
    ['booksByTitle(empty)', booksByTitle(CFG, [])],
    ['loadSeries', loadSeries(CFG, '庸与神的冠冕')],
    ['loadSeries(missing)', loadSeries(CFG, 'x')],
    ['conflictBrief', conflictBrief(CFG, { series: '冬梦激醒' })],
    ['conflictBrief(all)', conflictBrief(CFG, {})],
    ['equationNameDigest', equationNameDigest({ workspace: dir })],
    ['equationNameDigest(missing)', equationNameDigest({ workspace: empty })],
    ['missionDigest', missionDigest(CFG, { limit: 3 })],
    ['bookDigest', bookDigest(CFG, { limit: 3 })],
    ['broadcastDigest', broadcastDigest({ workspace: dir })],
    ['broadcastDigest(missing)', broadcastDigest({ workspace: empty })],
  ]

  for (const [label, value] of results) {
    it(`${label} is JSON-round-trip identical`, () => {
      assertJsonSafe(value, label)
      assertNoUndefined(value)
      assert.ok(!Object.keys(value).includes('undefined'))
    })
  }
})

/**
 * 星球列表（「星球制造机」的参考底本 + 增量列表）。
 *
 * 用户提供的 27 颗星球是**原始列表**（baseline），像 `user-canon.json` 一样以常量形式
 * 固化在本模块里，而不是散在工作区某个文件里。理由是这套数据的契约：
 *
 *   - `gs_update` 每次抓取都会原子重建 `<dataset>.json`，所以任何放在缓存目录里、
 *     由抓取流程管理的文件都可能被覆盖 —— 这与 `usercanon.mjs` 的取舍完全一致；
 *   - 用户明确要求「重制星球列表到原始」必须**可靠**：原始副本一旦只存在于工作区，
 *     用户手滑删掉、或下一次生成写坏了它，就再也回不来了。常量是唯一不会丢的副本。
 *
 * 增量的新星球写在 `<workspace>/hsr-worldview-cache/planet-list.json`
 * （`added[]` 只装生成出来并被用户确认保留的星球；绝不重复原始列表里的名字）。
 * 「重置」= 原子改写该文件并把 `added` 清空、把 `baseline` 快照重新抄一遍。
 *
 * 契约（与其余数据层一致，任何函数都不抛异常）：
 *   - 读：文件缺失/损坏/字段类型不对 → 退回原始列表，并在 `warnings` 里如实说明；
 *   - 写：`readJson`/`writeJsonAtomic`（先写 `.tmp` 再 rename，失败保留旧文件）；
 *   - 去重：按名字规整（trim + 折叠空白 + 小写）判定，重名一律以原始列表为准；
 *   - 上限：`added` 最多 `MAX_ADDED` 条，越界当场拒绝而不是静默丢弃。
 *
 * @module dsh-history-fictionologists/lib/planets
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { cacheDir } from './paths.js'
import { readJson, writeJsonAtomic } from './wiki/cache.mjs'

/** 增量文件；必须避开 `<dataset>.json` 的命名空间（与 `user-canon.json` 同一规矩）。 */
export const PLANET_LIST_FILE = 'planet-list.json'

/** 手写进文件的形状标记；读到时只做报告，不做校验。 */
export const PLANET_LIST_SCHEMA = 'dsh-history-fictionologists/planet-list@1'

/** 单次批量新增的上限（防止模型一次塞进一部长篇）。 */
export const MAX_BATCH = 20

/** 增量列表的总上限；到顶后 `addPlanets` 拒绝写入并提示先重置。 */
export const MAX_ADDED = 200

/** 名字上限（星球名不会是长句）。 */
const MAX_NAME = 60

/** 描述上限：原始列表里最长的一条约 60 字，200 字留足余量。 */
const MAX_DESCRIPTION = 400

/**
 * 原始星球列表的**逐字底本**（用户原文，`名字 (English)\t描述` 每行一条）。
 *
 * 保留这份纯文本有两个用途：
 *   1. `gs_planet_reset` 把它整体写回工作区文件，人工核对时与用户原文一眼可比；
 *   2. `test/planets.test.mjs` 断言「常量条目」与「底本文本」逐条一致，
 *      任何人改了一边忘了另一边，测试就会红。
 *
 * 不要重排、不要改标点 —— 这是用户设定。
 */
export const PLANET_BASELINE_SOURCE = `阿丽万塔 (Arivanta)	受三颗卫星影响，引力时刻以波德函数形式变化，发展出了独特的生态系统，特产“换境树”。
阿图因 (Attouine)	在游戏地点列表中被归类为“未知/其他地点”。
螺丝星	机械族聚集的星球，濒临死寂，居民利用行星物质建造了环绕母星的生存家园。
盗贼公国塔利亚 (Thalassa)	废土朋克风格的“繁星垃圾场”，地表遍布核辐射与荒原，但地下世界却很繁华。
庇尔波因特 (Pier Point)	“公司”总部所在地，是「存护」星神旗下最强势力的中心，贸易昌盛。
萨尔索图星	行星核心正在冷却，自转减速，生物只能在晨昏线附近的移动城市“风滚草”中生存。
伊须磨洲	第一艘坠毁仙舟「岱舆」的坠落点，当地居民是受仙舟文明启迪的双栖智能生物。
翁瓦克星	充满雨林的小型行星，有能“打印”物种的神树「西斯腾」，但每60年一次的“魔王”轮回会重置文明。
江户星 / 江户城 (Edo Star)	日本风情的星球，在委托任务中被提及，角色“花火”疑似出身于此，背景中有霓虹灯与天守阁元素。
朋克洛德 (Punklorde)	由数据和文字构建的虚拟星球，现实与虚构的边界模糊，是角色“银狼”的出身地。
阿德利文 (Adlivun)	「毁灭」星神纳努克的故乡，在虫灾和机械战争中毁灭。名字源于因纽特神话中的死后世界。
露莎卡星 (Lushaka)	完全由液态水构成的海洋星球，是列车组“钟表匠”米哈伊尔的故乡。
湛蓝星	黑塔空间站就漂浮在其轨道上，星球本身的危机已被黑塔解决，因此没有开拓的必要。
出云国 (Izumo)	在相关攻略中被提及为“尚未开放”的背景地区，与江户星并列。
常磐国	角色“平田平次”的故乡，一个动画文化盛行的国度。
天马星间公国	存在“二足步行者奴役四足步行者”的风习，曾是原始博士“人类退化实验”的目标。
纽罗尼奥尼 (Neuronneon)	“公司”旗下的工业行星，大气污染极其严重，需要佩戴特制面具才能外出。
巴克斯-II (Bacchus-II)	信仰「毁灭」星神纳努克的星球，有将次子献祭给纳努克的风习。
农場星	导致“普曼”这种生物过度繁殖的源头星球。
诺曼斯兰德 (Normansland)	被称为“无人之地”的极寒星球，是角色“阮·梅”立志学习生命学的契机。
迪梅德星 (Dimaid)	在拍卖会上被“假面愚者”玩弄的星球。
忒修斯-VIII (Toste-VIII)	曾遭受“忌物”入侵，星历8098年被仙舟「青丘军」讨伐。
特洛维斯星系 (Troveth)	因卡芙卡在此制造了著名的“特洛维斯星系失踪事件”而被提及。
新伯利恒 (New Eden / New Bethlehem)	被“绝灭大君”风焰毁灭，因大量辐射而玻璃化。
哈特雷维尼亚 (Hatrevinia)	与“阿登”一同被绝灭大君风焰摧毁、玻璃化，被称为“玻璃光带”，现为悲悼伶人剧团支部。
巴兰萨熔炉 (Balansa Furnace)	加工“共感觉信标”的工业行星，曾遭绝灭大君“铁墓”袭击而瘫痪。
日耀-XIII (Sunburst-XIII)	曾因「丰饶」的侵略而濒临崩溃的星球之一。`

/**
 * 星球「出处」分类 —— 决定参考时该把它当**已探访的世界**还是**文本提及的背景地名**。
 *   - `visited`     列车/开拓者抵达过、有实地设定
 *   - `mentioned`   仅在任务文本、角色对话、道具来历里被提及
 *   - `ruined`      已毁灭/玻璃化/瘫痪/失去开拓意义
 *   - `unknown`     官方归入「未知/其他地点」
 *   - `other`       兜底
 */
export const PLANET_SOURCES = ['visited', 'mentioned', 'ruined', 'unknown', 'other']

/**
 * 把底本文本解析成条目数组。
 *
 * 每行格式：`名字 (English)\t描述`；英文名缺失时只有名字。制表符缺失的行整行当名字、
 * 描述留空（并计数），以免一条手写笔误让整份列表消失。
 *
 * @param {string} source
 * @returns {{name: string, en: string, description: string}[]}
 */
export function parseBaseline(source = PLANET_BASELINE_SOURCE) {
  const out = []
  for (const rawLine of String(source ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const tab = line.indexOf('\t')
    const left = (tab >= 0 ? line.slice(0, tab) : line).trim()
    const description = (tab >= 0 ? line.slice(tab + 1) : '').trim()
    if (left.length === 0) continue
    const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(left)
    const name = (match ? match[1] : left).trim()
    const en = (match ? match[2] : '').trim()
    if (name.length === 0) continue
    out.push({ name, en, description })
  }
  return out
}

/**
 * 逐条人工标注的「出处」。键必须是原始列表里的名字（与常量一起被测试校验）。
 *
 * 必须声明在 `PLANETS` **之前**：`PLANETS` 的初始化会调用 `classifyPlanet`，
 * 而 `const` 在暂时性死区里（实测报 `Cannot access ... before initialization`）。
 */
const PLANET_SOURCE_LABELS = {
  '阿丽万塔': 'visited',
  '阿图因': 'unknown',
  '螺丝星': 'visited',
  '盗贼公国塔利亚': 'visited',
  '庇尔波因特': 'visited',
  '萨尔索图星': 'visited',
  '伊须磨洲': 'mentioned',
  '翁瓦克星': 'mentioned',
  '江户星 / 江户城': 'mentioned',
  '朋克洛德': 'visited',
  '阿德利文': 'ruined',
  '露莎卡星': 'mentioned',
  '湛蓝星': 'visited',
  '出云国': 'mentioned',
  '常磐国': 'mentioned',
  '天马星间公国': 'mentioned',
  '纽罗尼奥尼': 'mentioned',
  '巴克斯-II': 'mentioned',
  '农場星': 'mentioned',
  '诺曼斯兰德': 'mentioned',
  '迪梅德星': 'mentioned',
  '忒修斯-VIII': 'mentioned',
  '特洛维斯星系': 'mentioned',
  '新伯利恒': 'ruined',
  '哈特雷维尼亚': 'ruined',
  '巴兰萨熔炉': 'ruined',
  '日耀-XIII': 'ruined',
}

/** `PLANET_SOURCE_LABELS` 的键集合（导出供测试与文档核对条数）。 */
export const PLANET_SOURCE_KEYS = Object.freeze(Object.keys(PLANET_SOURCE_LABELS))

/**
 * 原始列表的权威形态：解析 + 补上「出处」分类 + 冻结。模块加载时算一次。
 *
 * `source` 字段是**本插件加的标注**（用户原文没有），只用于给模型分组参考，
 * 不改变任何一条的描述文本。逐条与原文的对应关系由测试锁死。
 */
export const PLANETS = Object.freeze(
  parseBaseline().map((entry) =>
    Object.freeze({
      ...entry,
      source: classifyPlanet(entry.name),
      origin: 'baseline',
    }),
  ),
)

/** 按名字取「出处」标注；未标注者归 `other`。 */
function classifyPlanet(name) {
  const value = PLANET_SOURCE_LABELS[String(name ?? '').trim()]
  return PLANET_SOURCES.includes(value) ? value : 'other'
}

/** `<ws>/hsr-worldview-cache/planet-list.json` */
export function planetListPath(workspace) {
  return join(cacheDir(workspace), PLANET_LIST_FILE)
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/**
 * 名字规整：折叠空白 + 小写。
 * 只用 ASCII 空白（`\s` 在 JS 里也匹配全角空格与换行，会把 `巴克斯-II` 这类名字折坏）。
 */
const normName = (value) => text(value).replace(/[ \t\u3000]+/g, ' ').toLowerCase()

/**
 * 名字是否「属于原始列表」。
 *
 * 规则刻意保守：**精确匹配**，外加一条「去掉空格后相同」的容错
 * （`江户星/江户城` 与 `江户星 / 江户城` 视为同一颗）。不做前缀/子串匹配——
 * `江户星` 与 `江户星 / 江户城` 是同一个实体，但 `螺丝星` 与 `螺丝星二号` 不是。
 */
function sameName(a, b) {
  const left = normName(a)
  const right = normName(b)
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  return left.replace(/ /g, '') === right.replace(/ /g, '')
}

/**
 * 名字是否已在原始列表中。
 *
 * 同时比对**星球名**与**英文名**，且都不区分大小写。理由（来自 0.3.0 的独立复核实测）：
 * 只按中文名精确比对时，`ARIVANTA` / `arivanta` 会绕过防线成为一颗「新星球」，
 * 而它显然是用户列表里的「阿丽万塔 (Arivanta)」。英文名的比对是**保守**的
 * ——宁可把 `Attouine` 这样的写法判成重名并请模型换一个，也不要放进一颗同义星球。
 *
 * 口径（复核 R-6 要求写清）：英文名走的是同一条 `sameName`（小写化 + 折叠空白 +
 * 「去空格后相同」），所以 `Edo  Star` / `EDOSTAR` 都会判成「江户星 / 江户城」。
 * 方向是**多拒不可少拒**——不会覆写任何原始设定，最坏情况是让模型换个名字。
 */
export function isBaselineName(name) {
  return baselineCollision(text(name)) !== null
}

/**
 * 这个候选与原始列表的哪一部分相撞？
 * @param {string} name 候选星球名
 * @param {string} [en] 候选英文名（复核 R-3：`en` 也不能绕过防线）
 * @returns {{field: 'name'|'en', planet: object}|null}
 */
export function baselineCollision(name, en = '') {
  const wanted = text(name)
  const wantedEn = text(en)
  if (wanted.length === 0 && wantedEn.length === 0) return null
  for (const planet of PLANETS) {
    if (wanted.length > 0 && sameName(planet.name, wanted)) return { field: 'name', planet }
    if (wanted.length > 0 && sameName(planet.en, wanted)) return { field: 'name', planet }
    // 候选的 en 撞上原始列表的名字或英文名 → 同样是同一颗星球（R-3）。
    if (wantedEn.length > 0 && (sameName(planet.name, wantedEn) || sameName(planet.en, wantedEn))) {
      return { field: 'en', planet }
    }
  }
  return null
}

/** 描述长度上限内的规整文本。 */
function normDescription(value) {
  const raw = typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : ''
  return raw.trim().slice(0, MAX_DESCRIPTION)
}

/**
 * 把文件里的一条 `added` 规整成内部形态；不可用时返回 `null`。
 *
 * `nameTruncated`：超过 `MAX_NAME` 的名字会被截断（复核 R-4：静默截断 → 现在会带着
 * `nameTruncated` 标记返回，由 `addPlanets` 写进 `warnings` 让模型转告用户）。
 */
function normalizeAdded(raw, index) {
  if (raw === null || typeof raw !== 'object') return null
  const name = text(raw.name)
  if (name.length === 0) return null
  const description = normDescription(raw.description ?? raw.summary ?? raw.简介)
  const en = text(raw.en ?? raw.english ?? raw.英文名)
  const source = PLANET_SOURCES.includes(raw.source) ? raw.source : 'other'
  const nameTruncated = name.length > MAX_NAME
  return {
    name: name.slice(0, MAX_NAME),
    en: en.slice(0, MAX_NAME),
    description,
    source,
    origin: 'added',
    id: text(raw.id) || `added-${index + 1}`,
    addedAt: text(raw.addedAt),
    nameTruncated,
  }
}

/** 「没有增量文件」时的规范记录。 */
function emptyRecord(path, exists) {
  return {
    ok: true,
    path,
    exists,
    schema: PLANET_LIST_SCHEMA,
    updatedAt: '',
    added: [],
    dropped: 0,
    warnings: [],
  }
}

/**
 * 读增量文件（本地、不联网、绝不抛异常）。
 *
 * @param {string} workspace 绝对工作区路径
 * @returns {{ok: boolean, path: string, exists: boolean, added: object[], updatedAt: string,
 *   dropped: number, warnings: string[]}}
 */
export function readPlanetRecord(workspace) {
  const path = planetListPath(workspace)
  let exists = false
  try {
    exists = existsSync(path)
  } catch {
    exists = false
  }
  if (!exists) return emptyRecord(path, false)

  const result = readJson(path)
  if (!result.ok) {
    return {
      ...emptyRecord(path, true),
      ok: false,
      warnings: [`${PLANET_LIST_FILE} 读取失败（${result.error ?? '未知原因'}），已退回原始星球列表`],
    }
  }
  const data = result.data !== null && typeof result.data === 'object' ? result.data : null
  if (data === null) {
    return {
      ...emptyRecord(path, true),
      ok: false,
      warnings: [`${PLANET_LIST_FILE} 顶层不是对象，已退回原始星球列表`],
    }
  }

  const warnings = []
  const rawList = Array.isArray(data.added) ? data.added : Array.isArray(data) ? data : []
  if (!Array.isArray(data.added) && !Array.isArray(data)) {
    warnings.push(`${PLANET_LIST_FILE} 缺少 added 数组，已按空列表处理`)
  }

  const added = []
  const seen = new Set(PLANETS.map((planet) => normName(planet.name).replace(/ /g, '')))
  let dropped = 0
  for (let index = 0; index < rawList.length; index += 1) {
    const entry = normalizeAdded(rawList[index], index)
    if (entry === null) {
      dropped += 1
      continue
    }
    const key = normName(entry.name).replace(/ /g, '')
    // 重名 → 原始列表优先；增量内部的重复保留第一条。
    if (seen.has(key)) {
      dropped += 1
      continue
    }
    seen.add(key)
    added.push(entry)
  }
  if (dropped > 0) warnings.push(`${PLANET_LIST_FILE} 有 ${dropped} 条因重名或字段非法被忽略`)

  return {
    ok: true,
    path,
    exists: true,
    schema: text(data.schema) || PLANET_LIST_SCHEMA,
    updatedAt: text(data.updatedAt),
    added: added.slice(0, MAX_ADDED),
    dropped,
    warnings,
  }
}

/**
 * 合并视图：原始列表在前（保持用户顺序），增量在后（按加入顺序）。
 *
 * @param {string} workspace
 * @returns {{planets: object[], baselineCount: number, addedCount: number, total: number,
 *   path: string, exists: boolean, updatedAt: string, ok: boolean, warnings: string[]}}
 */
export function listPlanets(workspace) {
  const record = readPlanetRecord(workspace)
  const baseline = PLANETS.map((planet) => ({
    name: planet.name,
    en: planet.en,
    description: planet.description,
    source: planet.source,
    origin: 'baseline',
  }))
  const added = record.added.map((entry) => ({
    name: entry.name,
    en: entry.en,
    description: entry.description,
    source: entry.source,
    origin: 'added',
    addedAt: entry.addedAt,
  }))
  return {
    ok: record.ok !== false,
    path: record.path,
    exists: record.exists,
    updatedAt: record.updatedAt,
    baselineCount: baseline.length,
    addedCount: added.length,
    total: baseline.length + added.length,
    planets: [...baseline, ...added],
    warnings: record.warnings,
  }
}

/**
 * 把新星球并入增量列表（原子写）。
 *
 * 判定顺序（**原始列表永远优先**）：
 *   1. 名字命中原始列表 → 计入 `rejected`（绝不覆写用户的原始设定）；
 *   2. 名字命中已有增量 → 计入 `updated`，用新描述替换旧描述（允许模型自我修正）；
 *   3. 全新名字 → 计入 `added`，写入新条目。
 * 同一次调用内重名 → 只取最后一次（并计数）。
 *
 * @param {string} workspace
 * @param {{planets?: object[]}} input
 * @returns {{ok: boolean, path: string, added: object[], updated: object[], rejected: object[],
 *   overflow: {count: number, names: string[]}, total: number, addedCount: number,
 *   baselineCount: number, bytes: number, error?: string, warnings: string[]}}
 *
 * `overflow` 是复核 R-1 的修复：单次超过 `MAX_BATCH` 的候选此前被**静默丢弃**，
 * 而 `ok` 仍是 true，模型会据此向用户谎报「都加进去了」。现在它们出现在这里与
 * `warnings` 里，但不落盘。
 */
export function addPlanets(workspace, input = {}) {
  const path = planetListPath(workspace)
  const record = readPlanetRecord(workspace)
  const warnings = [...record.warnings]
  const rawList = Array.isArray(input?.planets) ? input.planets : []
  const rejected = []
  const accepted = []
  let invalidCount = 0
  let duplicateInBatch = 0

  for (const raw of rawList) {
    const entry = normalizeAdded(raw, accepted.length)
    if (entry === null || entry.name.length === 0) {
      invalidCount += 1
      continue
    }
    const collision = baselineCollision(entry.name, entry.en)
    if (collision !== null) {
      // 说清是撞「星球名」还是撞「英文名」、撞的是哪一颗：模型要向用户解释为什么被拒。
      const where = collision.field === 'en' ? '英文名' : collision.planet.name === entry.name ? '星球名' : '英文名'
      rejected.push({
        name: entry.name,
        reason: `与原始星球列表中的「${collision.planet.name}」${where}相同（大小写与空格不敏感），拒绝覆写`,
      })
      continue
    }
    const index = accepted.findIndex((item) => sameName(item.name, entry.name))
    if (index >= 0) {
      duplicateInBatch += 1
      accepted[index] = entry
      continue
    }
    accepted.push(entry)
  }

  if (invalidCount > 0) warnings.push(`有 ${invalidCount} 条候选缺少可用的 name，已忽略`)
  if (duplicateInBatch > 0) warnings.push(`本次入参有 ${duplicateInBatch} 条重名，已按最后一条合并`)

  const truncated = accepted.filter((entry) => entry.nameTruncated === true)
  if (truncated.length > 0) {
    // 复核 R-4：此前是静默截断（200 字的名字变成 60 字而 ok=true、warnings=[]）。
    warnings.push(`有 ${truncated.length} 条候选的星球名超过 ${MAX_NAME} 字，已截断：${truncated.slice(0, 3).map((e) => e.name).join('、')}`)
  }

  // 复核 R-1：此前超出 MAX_BATCH 的候选被**静默丢弃**——不进 added/updated/rejected、
  // 不落盘，而 ok 仍是 true，于是模型会向用户复述「都加进去了」。现在显式报告。
  const batch = accepted.slice(0, MAX_BATCH)
  const overflowEntries = accepted.slice(MAX_BATCH)
  const overflow = {
    count: overflowEntries.length,
    names: overflowEntries.map((entry) => entry.name),
  }
  if (overflow.count > 0) {
    warnings.push(
      `单次最多并入 ${MAX_BATCH} 颗星球：本次有 ${overflow.count} 颗被丢弃，未写入列表（${overflow.names.slice(0, 5).join('、')}${overflow.count > 5 ? ' 等' : ''}）。`
      + '请分多次调用，或先告知用户这些星球没有并入。',
    )
  }

  const existing = record.added.slice()
  const byKey = new Map(existing.map((entry) => [normName(entry.name).replace(/ /g, ''), entry]))
  const added = []
  const updated = []
  const stampNow = new Date().toISOString()
  for (const entry of batch) {
    const key = normName(entry.name).replace(/ /g, '')
    const previous = byKey.get(key)
    const next = { ...entry, addedAt: previous?.addedAt || stampNow }
    if (previous) {
      // 沿用原 id 与 addedAt，只刷新描述/出处。
      next.id = previous.id
      updated.push(next)
    } else {
      added.push(next)
    }
    byKey.set(key, next)
  }

  const merged = [...existing.map((entry) => byKey.get(normName(entry.name).replace(/ /g, '')) ?? entry)]
  for (const entry of added) merged.push(entry)

  if (merged.length > MAX_ADDED) {
    return {
      ok: false,
      path,
      added: [],
      updated: [],
      rejected,
      overflow,
      total: PLANETS.length + existing.length,
      addedCount: existing.length,
      baselineCount: PLANETS.length,
      bytes: 0,
      error: `增量列表已达上限 ${MAX_ADDED} 条，请先重置星球列表再并入`,
      warnings,
    }
  }

  if (added.length === 0 && updated.length === 0) {
    // 没有变化就不写盘（保持文件 mtime 有意义），并说清是「没东西可写」还是「全被拒绝」。
    // `ok` 必须为 false：调用方（模型）要靠它判断「用户看到的星球并没有进列表」。
    const emptyInput = rawList.length === 0
    return {
      ok: false,
      path,
      added: [],
      updated: [],
      rejected,
      overflow,
      total: PLANETS.length + existing.length,
      addedCount: existing.length,
      baselineCount: PLANETS.length,
      bytes: 0,
      error: emptyInput
        ? 'planets 为空，没有可并入的内容'
        : rejected.length > 0
          ? '全部候选都与原始星球列表重名，已拒绝覆写'
          : '没有可并入的有效条目',
      warnings,
    }
  }

  const payload = {
    schema: PLANET_LIST_SCHEMA,
    updatedAt: stampNow,
    updatedBy: 'dsh-history-fictionologists',
    baselineCount: PLANETS.length,
    addedCount: merged.length,
    baseline: PLANETS.map((planet) => ({
      name: planet.name,
      en: planet.en,
      description: planet.description,
      source: planet.source,
    })),
    added: merged.map((entry) => ({
      id: entry.id,
      name: entry.name,
      en: entry.en,
      description: entry.description,
      source: entry.source,
      addedAt: entry.addedAt,
    })),
  }
  const written = writeJsonAtomic(path, payload)
  if (written.ok !== true) {
    return {
      ok: false,
      path,
      added: [],
      updated: [],
      rejected,
      overflow,
      total: PLANETS.length + existing.length,
      addedCount: existing.length,
      baselineCount: PLANETS.length,
      bytes: 0,
      error: written.error ?? '写盘失败',
      warnings,
    }
  }
  return {
    ok: true,
    path,
    added: added.map(publicPlanet),
    updated: updated.map(publicPlanet),
    rejected,
    overflow,
    total: PLANETS.length + merged.length,
    addedCount: merged.length,
    baselineCount: PLANETS.length,
    bytes: Number.isFinite(written.bytes) ? written.bytes : 0,
    warnings,
  }
}

/**
 * 重置到用户给出的原始列表：清空增量。
 *
 * 实现上不是「删文件」——那样会留下一个既非原始、又无迹可查的状态；
 * 而是把原始列表快照重新原子写一遍（`added: []`），让文件本身就是「原始」的证据。
 * 文件原本不存在时也照样写一份，`removed: 0`、`created: true`。
 *
 * @param {string} workspace
 * @returns {{ok: boolean, path: string, removed: number, created: boolean, total: number,
 *   baselineCount: number, bytes: number, error?: string, warnings: string[]}}
 */
export function resetPlanets(workspace) {
  const path = planetListPath(workspace)
  const record = readPlanetRecord(workspace)
  const warnings = [...record.warnings]
  const payload = {
    schema: PLANET_LIST_SCHEMA,
    updatedAt: new Date().toISOString(),
    updatedBy: 'dsh-history-fictionologists',
    baselineCount: PLANETS.length,
    addedCount: 0,
    baseline: PLANETS.map((planet) => ({
      name: planet.name,
      en: planet.en,
      description: planet.description,
      source: planet.source,
    })),
    added: [],
  }
  const written = writeJsonAtomic(path, payload)
  if (written.ok !== true) {
    return {
      ok: false,
      path,
      removed: 0,
      created: false,
      total: PLANETS.length,
      baselineCount: PLANETS.length,
      bytes: 0,
      error: written.error ?? '写盘失败',
      warnings,
    }
  }
  return {
    ok: true,
    path,
    removed: record.added.length,
    created: record.exists !== true,
    total: PLANETS.length,
    baselineCount: PLANETS.length,
    bytes: Number.isFinite(written.bytes) ? written.bytes : 0,
    warnings,
  }
}

/**
 * 删除增量文件（仅测试/维护用；`gs_planet_reset` 不调用它）。
 * @param {string} workspace
 * @returns {boolean} 是否真的删掉了文件
 */
export function removePlanetFile(workspace) {
  try {
    const path = planetListPath(workspace)
    if (!existsSync(path)) return false
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

/** 模型可见投影：不留空字符串键，不暴露内部 id。 */
function publicPlanet(entry) {
  const view = { name: entry.name, origin: entry.origin, source: entry.source }
  if (entry.en.length > 0) view.en = entry.en
  if (entry.description.length > 0) view.description = entry.description
  if (entry.addedAt && entry.addedAt.length > 0) view.addedAt = entry.addedAt
  return view
}

/** `gs_setup` 用的一行摘要。 */
export function summarizePlanets(workspace) {
  const view = listPlanets(workspace)
  return {
    baselineCount: view.baselineCount,
    addedCount: view.addedCount,
    total: view.total,
    path: view.path,
    exists: view.exists,
    updatedAt: view.updatedAt,
  }
}

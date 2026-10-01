/**
 * 「虚构差分方程」（功能 5）——规则、校验与渲染。
 *
 * 与「神人制造机」同构、同版式：产出的是**方程名称 + 详细设定**，不是游戏机制。
 * 区别只有一条：叙事对象必须是五类主题之一，且各主题配比大致均衡。
 *
 * 本模块是纯函数集合（除 `readExistingEquationNames` 读一个缓存文件）：
 *   - 与 `lib/planets.mjs` 同构，工具层只做参数搬运与错误兜底；
 *   - 校验逻辑放在这里而不是工具里，是为了让 `test/` 能离线直接断言规则。
 *
 * 规则口径（用户评审历次修订，见 docs/fiction-equation.md）：
 *   1. 五类主题：人物 / 生物 / 装置场所 / 概念事件 / 派系机构；每类不得为 0；
 *      单类不超过 2 条，但**生物类豁免**——条数不设上限（2026-09-30 用户口径）；
 *   2. 名字 2–8 字；生物类名字不少于 3 字；
 *   3. 生物类不得沿用既有构词（蠧役 / 残嗣 / 虫帝 …），不得雷同禁用字；
 *   4. 生物类内部：只剩「虫类不超过四成」一条（提示级）；
 *      **鱼类 / 鸟类的比例不再有任何约束**（2026-09-30 用户口径，删除鱼鸟比重限制）；
 *   5. 生僻字（虫鱼鸟旁的生僻字与菌类字）整批最多 1 条；
 *   6. 星神纪律：星神、令使、绝灭大君不出场；
 *   7. 正文不写游戏机制语言（方括号符号、百分比、暴击、护盾、战技点…）。
 *
 * @module dsh-history-fictionologists/lib/equations
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 五个叙事对象类别（顺序即报告与配额表的顺序）。 */
export const EQUATION_TOPICS = [
  '人物·职业/身份',
  '生物·物种/衍生体',
  '装置·器物/场所',
  '抽象概念·现象/事件',
  '派系·机构/组织',
]

/**
 * 允许的命途（含未被「方程一览」用作主命途但世界观存在的贪饕 / 均衡 / 开拓 / 终末）。
 * 「贪饕」由用户评审放开（2026-09-30），随 **0.6.0** 发版：
 * 既有 212 条方程无一条以此为主命途，需可书写吞噬 / 饥饿 / 永无餍足题材；
 * 加命途不等于放宽星神纪律——「奥博洛斯」仍在 STAR_GUARDIAN_TERMS 黑名单内，
 * 那位吞噬者只能以旧传闻 / 遗物 / 过期教条出场。
 */
export const EQUATION_PATHS = [
  '欢愉', '智识', '繁育', '毁灭', '虚无', '巡猎', '记忆', '存护', '丰饶', '同谐', '贪饕', '均衡', '开拓', '终末',
]

/** 单类上限（本批 ≥ 5 条时生效；生物类不受此限，见 BIO_TOPIC）。 */
export const MAX_PER_TOPIC = 2
/** 每批同类上限的生效门槛。 */
export const RATIO_ENFORCE_MIN = 5
/**
 * 生物类主题标签：本批**唯一豁免「单类 ≤2」**的类别，条数不设上限
 * （2026-09-30 用户口径：删除对生物类词条出现次数的限制）。
 */
export const BIO_TOPIC = '生物·物种/衍生体'
/** 生物类内部：虫类占比上限（提示级）。 */
export const MAX_BUG_RATIO = 0.4
/** 生僻字条数上限。 */
export const MAX_RARE_CHARS = 1

/** 详细设定字数区间（「神人制造机」为 100–200，这里放宽到 120–220）。 */
export const DETAIL_RANGE = [120, 220]
export const MAX_NAME_LENGTH = 8
export const MIN_BIO_NAME_LENGTH = 3

export const STAR_GUARDIAN_TERMS = [
  '星神', '令使', '绝灭大君', '纳努克', '阿哈', '岚', '药师', '克里珀', '浮黎', '博识尊',
  '希佩', '伊德莉拉', '阿基维利', '奥博洛斯', '塔伊兹育罗斯', '太一', '迷思',
]

/** 游戏机制语言：与「名称 + 详细设定」的口径冲突，出现即拒绝。 */
export const MECHANIC_TERMS = [
  '【', '】', '星级', '乐园漫记', '人间喜剧', '暴击', '护盾', '战技点', '终结技',
  '持续伤害', '基础伤害', '叠加', '削韧', '弱点击破', '临界回响', '回合', '命中', '抵抗',
]

/** 生物类：既有 31 条生物方程的构词，沿用即视为雷同。 */
const BIO_BANNED_CHARS = ['蠧', '役', '嗣', '虫', '蟐', '螟', '蟒', '蚁', '蠕', '孽', '骃', '蠹']
const BIO_BANNED_WORDS = [
  '王虫', '虫帝', '巨人', '粒子群', '幽灵', '罪灵', '造翼者', '慧骃', '聚合者',
  '模因', '视肉', '幻造物', '换心魔', '残嗣',
]
/** 生僻字：**批级 FAIL**（`errors`，不是 warnings），整批最多 MAX_RARE_CHARS 条。 */
const BIO_RARE_CHARS = [
  '蜉', '蛉', '蟓', '蜢', '蜱', '螨', '蚧', '蛞', '蝓', '螽', '蠃', '蜮', '蛭', '蚴',
  '蛹', '蛄', '蟏', '蛸', '鲎', '鳐', '鲼', '鳚', '鳅', '鳉', '鲴', '鲻', '鱵', '鰕', '菌',
]
/** 虫类词根：用于四成占比检查。 */
const BIO_BUG_WORDS = [
  '虫', '蟓', '蛾', '蜉', '蛉', '蜢', '蜱', '螨', '蚧', '蛭', '蚴', '蛹', '蛄', '蟏', '蛸',
  '蚁', '蟐', '螟', '蠕',
]
/** 鱼类词根：**只用于报告里的构成统计**，不再参与任何比例判定。 */
const FISH_WORDS = [
  '鱼', '鳗', '鳝', '鲇', '鲫', '鲈', '鲍', '鲎', '鳐', '鲼', '鳚', '鳅', '鳉', '鲴', '鲻',
  '鱵', '鰕', '鲤', '鲛', '鲸',
]
/** 鸟类词根：**只用于报告里的构成统计**，不再参与任何比例判定。 */
const BIRD_WORDS = [
  '鸥', '隼', '鸡', '鸭', '鹅', '鹤', '鹭', '鸦', '雀', '燕', '鹃', '鸢', '雕', '鸮', '雁', '鹰', '鸻',
]

const countChars = (text) => String(text ?? '').replace(/\s/g, '').length
const pick = (list, name) => list.filter((term) => String(name).includes(term))
const asArray = (value) => (Array.isArray(value) ? value : [])

/** 主题统计（逐类条数）。 */
export function topicCounts(entries) {
  const counts = Object.fromEntries(EQUATION_TOPICS.map((topic) => [topic, 0]))
  for (const entry of asArray(entries)) {
    if (Object.prototype.hasOwnProperty.call(counts, entry?.topic)) counts[entry.topic] += 1
  }
  return counts
}

/** 生物类构成（鱼类 / 鸟类 / 虫类 各自的条目名）。 */
export function bioBreakdown(entries) {
  const bios = asArray(entries).filter((entry) => entry?.topic === '生物·物种/衍生体')
  const namesOf = (words) => bios.filter((entry) => pick(words, entry?.name).length > 0).map((entry) => String(entry.name))
  return { total: bios.length, fish: namesOf(FISH_WORDS), birds: namesOf(BIRD_WORDS), bugs: namesOf(BIO_BUG_WORDS) }
}

/**
 * 从缓存里取既有方程名称，用于重名检查。
 * 缓存缺失或损坏时返回空集合 + 一条 warning（不抛错）。
 *
 * @param {string} ws 工作区
 * @returns {{names: Set<string>, warnings: string[]}}
 */
export function readExistingEquationNames(ws) {
  const warnings = []
  const file = join(ws, 'hsr-worldview-cache', 'equations.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const names = asArray(raw?.entries).map((entry) => String(entry?.name ?? '')).filter((name) => name.length > 0)
    if (names.length === 0) warnings.push('缓存里的既有方程名称为空，本次未做重名检查')
    return { names: new Set(names), warnings }
  } catch (error) {
    warnings.push(`未能读取既有方程名（${String(error?.message ?? error)}）：本次跳过重名检查`)
    return { names: new Set(), warnings }
  }
}

/**
 * 校验一批虚构方程草稿。
 *
 * @param {{
 *   entries?: object[],
 *   existingNames?: Set<string>|string[],
 *   skipRatio?: boolean,
 * }} input
 *   `skipRatio` 只跳过**批级**配比检查（每类 ≥1、单类 ≤2），用于「只验证一类」的专项批次
 *   （例如专门试生物命名）；逐条规则始终生效。
 * @returns {{
 *   ok: boolean,
 *   accepted: object[],
 *   rejected: {name: string, reason: string}[],
 *   warnings: string[],
 *   counts: Record<string, number>,
 *   bio: {total: number, fish: string[], birds: string[], bugs: string[]},
 *   errors: string[],
 * }}
 */
export function validateFictionEquations(input = {}) {
  const drafts = asArray(input.entries)
  const existing = input.existingNames instanceof Set
    ? input.existingNames
    : new Set(asArray(input.existingNames).map((name) => String(name)))

  const warnings = []
  const errors = []
  const rejected = []
  const accepted = []

  if (drafts.length === 0) {
    return {
      ok: false, accepted: [], rejected: [], warnings, counts: topicCounts([]), bio: bioBreakdown([]),
      errors: ['entries 为空，没有可保存的方程'],
    }
  }

  // 批内重名（同一名字出现两次：第二条被拒）
  const seen = new Set()

  drafts.forEach((draft, index) => {
    const name = String(draft?.name ?? '').trim()
    const topic = String(draft?.topic ?? '').trim()
    const primary = String(draft?.pathPrimary ?? '').trim()
    const secondary = String(draft?.pathSecondary ?? '').trim()
    const detail = String(draft?.detail ?? '').trim()
    const hooks = String(draft?.hooks ?? '').trim()
    const label = name.length > 0 ? name : `第 ${index + 1} 条`
    const problems = []
    const notes = []
    const chars = countChars(detail)

    if (name.length === 0) problems.push('缺方程名称')
    else if (name.length > MAX_NAME_LENGTH) problems.push(`名称 ${name.length} 字，超过上限 ${MAX_NAME_LENGTH}`)
    if (!EQUATION_TOPICS.includes(topic)) problems.push(`主题类别非法：${topic || '(空)'}`)
    if (!EQUATION_PATHS.includes(primary)) problems.push(`主命途非法：${primary || '(空)'}`)
    if (secondary.length > 0 && !EQUATION_PATHS.includes(secondary)) problems.push(`次命途非法：${secondary}`)
    if (secondary.length > 0 && secondary === primary) problems.push('主次命途相同')
    if (chars < DETAIL_RANGE[0] || chars > DETAIL_RANGE[1]) {
      problems.push(`详细设定 ${chars} 字，超出 ${DETAIL_RANGE[0]}–${DETAIL_RANGE[1]}`)
    }
    if (hooks.length === 0) problems.push('缺「可能的故事方向」')
    if (existing.has(name)) problems.push('与既有「方程一览」重名')
    if (seen.has(name)) problems.push('本批次内名称重复')
    const guardian = pick(STAR_GUARDIAN_TERMS, `${name}${detail}${hooks}`)
    if (guardian.length > 0) problems.push(`出现星神/令使相关词：${guardian.join('、')}`)
    const mechanics = pick(MECHANIC_TERMS, `${name}${detail}${hooks}`)
    if (mechanics.length > 0) problems.push(`出现游戏机制语言：${mechanics.join('、')}`)

    if (topic === '生物·物种/衍生体') {
      const bannedChars = pick(BIO_BANNED_CHARS, name)
      const bannedWords = pick(BIO_BANNED_WORDS, name)
      if (bannedChars.length > 0 || bannedWords.length > 0) {
        problems.push(`生物名与既有构词雷同：${[...bannedChars, ...bannedWords].join('、')}`)
      }
      if (name.length > 0 && name.length < MIN_BIO_NAME_LENGTH) {
        problems.push(`生物名不足 ${MIN_BIO_NAME_LENGTH} 字：${name}`)
      }
      if (pick(BIO_RARE_CHARS, name).length > 0) notes.push('含生僻字（整批建议最多 1 条）')
      if (pick(BIO_BUG_WORDS, name).length > 0) notes.push('虫类命名（本批生物条目中建议不超过四成）')
    }
    // 「视角词」提示只对人物类有意义：生物 / 装置 / 概念 / 派系条目本来就不必出现
    // 「他」「他们」——对它们报这条等于每批刷一屏无效提示，反而淹掉真正的提示。
    if (topic === '人物·职业/身份' && !/他|他们|它|当地|工作|人/.test(detail)) {
      notes.push('人物条目里没有出现「人/他们/工作」等视角词，可能写成了百科条目')
    }

    if (problems.length > 0) {
      rejected.push({ name: label, reason: problems.join('；') })
      return
    }
    seen.add(name)
    accepted.push({
      name, topic, pathPrimary: primary,
      ...(secondary.length > 0 ? { pathSecondary: secondary } : {}),
      detail, hooks, chars,
    })
    warnings.push(...notes.map((note) => `${name}：${note}`))
  })

  // 配比与生物构成（只统计被接受的条目，避免「靠被拒条目凑数」）
  const counts = topicCounts(accepted)
  const bio = bioBreakdown(accepted)

  if (bio.total > 0) {
    // 生物构成只剩「虫类 ≤ 四成」这一条，且仍按「提示」定级：它是风格偏好，不是能一票否决的硬约束。
    // 鱼 / 鸟的比例原有两条提示（鱼鸟合计 ≥ 2 条、鸟类 ≤ 1 条），2026-09-30 按用户口径**整条删除**：
    // 这两条等于把生物配额钉死在「一条鱼 + 一只鸟」上，用户判定「鱼和鸟实在太多了」。
    // 现在鱼类 / 鸟类只做统计呈现，不再产生任何 warning。
    if (bio.bugs.length / bio.total > MAX_BUG_RATIO) {
      warnings.push(`生物条目中虫类 ${bio.bugs.length}/${bio.total} 条，超过四成（${bio.bugs.join('、')}）`)
    }
  }
  const rareCount = asArray(accepted)
    .filter((entry) => entry.topic === '生物·物种/衍生体' && pick(BIO_RARE_CHARS, entry.name).length > 0)
    .length
  if (rareCount > MAX_RARE_CHARS) {
    errors.push(`含生僻字的生物名 ${rareCount} 条，超过上限 ${MAX_RARE_CHARS}`)
  }

  if (accepted.length >= RATIO_ENFORCE_MIN && input.skipRatio !== true) {
    for (const topic of EQUATION_TOPICS) {
      if (counts[topic] === 0) errors.push(`类别「${topic}」为 0 条（软约束：不许空类）`)
      // 生物类豁免单类上限（2026-09-30 用户口径）；其余四类仍受 MAX_PER_TOPIC 约束。
      else if (topic !== BIO_TOPIC && counts[topic] > MAX_PER_TOPIC) errors.push(`类别「${topic}」有 ${counts[topic]} 条，超过单类上限 ${MAX_PER_TOPIC}`)
    }
  }

  return {
    // `ok` = 「这批数据可用」：至少有一条通过、且没有批级错误。
    // 逐条被拒**不算**批级失败——规格明确是「只写入通过的条目」，
    // 所以 ok=true 配非空 rejected 是合法状态：调用方必须照实说「哪几条没写进去」。
    // （只有一条都没通过时 ok=false，工具层据此拒绝写盘。）
    ok: errors.length === 0 && accepted.length > 0,
    accepted,
    rejected,
    warnings,
    counts,
    bio,
    errors,
  }
}

/**
 * 渲染成品 markdown（与 `gs_save` 的 front-matter 风格一致）。
 *
 * @param {{title?: string, entries?: object[], createdAt?: string, checkPath?: string}} input
 * @returns {string}
 */
export function renderEquationsMarkdown(input = {}) {
  const title = String(input.title ?? '虚构差分方程')
  const entries = asArray(input.entries)
  const lines = []
  lines.push('---')
  lines.push('kind: equations')
  lines.push(`title: ${JSON.stringify(title)}`)
  lines.push(`createdAt: ${String(input.createdAt ?? new Date().toISOString())}`)
  lines.push('generator: dsh-history-fictionologists')
  lines.push('---')
  lines.push('')
  lines.push(`# ${title}`)
  lines.push('')
  lines.push('> 版式与「神人制造机」逐字一致：`## 名称` + 〔主题类别〕命途归属 + 详细设定 + 可能的故事方向；叙事对象覆盖五类主题。')
  lines.push('')
  for (const entry of entries) {
    lines.push(`## ${entry.name}`)
    lines.push('')
    lines.push(
      `〔${entry.topic}〕命途归属：〈${entry.pathPrimary}〉`
      + (entry.pathSecondary ? `/〈${entry.pathSecondary}〉` : ''),
    )
    lines.push('')
    lines.push(`详细设定：${entry.detail}`)
    lines.push('')
    lines.push(`可能的故事方向：${entry.hooks}`)
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push(
    input.checkPath
      ? `本次自检记录：\`${input.checkPath}\`（同批 rejected 条目不会写入本文件）。`
      : '本批经 validateFictionEquations 校验后写入（rejected 条目不写入）。',
  )
  return `${lines.join('\n')}\n`
}

/**
 * 渲染自检记录（与 `scripts/check-fiction-equations-v2.mjs` 的报告同构，便于对照）。
 *
 * @param {{title?: string, validation: object, createdAt?: string, source?: string}} input
 * @returns {string}
 */
export function renderEquationsCheckReport(input = {}) {
  const validation = input.validation ?? {}
  const counts = validation.counts ?? {}
  const bio = validation.bio ?? { total: 0, fish: [], birds: [], bugs: [] }
  const lines = []
  lines.push('# 虚构差分方程 · 自检报告（生成时自动产出）')
  lines.push('')
  lines.push(`- 标题：${String(input.title ?? '（未命名）')}`)
  lines.push(`- 时间：${String(input.createdAt ?? new Date().toISOString())}`)
  if (input.source) lines.push(`- 来源：${String(input.source)}`)
  lines.push(`- 结果：${validation.ok ? '通过' : '未通过'}｜通过 ${asArray(validation.accepted).length} 条｜拒收 ${asArray(validation.rejected).length} 条`)
  lines.push('')
  lines.push('## 主题配比')
  lines.push('')
  lines.push('| 类别 | 条数 |')
  lines.push('| --- | --- |')
  for (const topic of EQUATION_TOPICS) lines.push(`| ${topic} | ${counts[topic] ?? 0} |`)
  lines.push('')
  if (bio.total > 0) {
    lines.push('## 生物类构成')
    lines.push('')
    lines.push(`- 鱼类 ${bio.fish.length} 条（${bio.fish.join('、') || '无'}）；鸟类 ${bio.birds.length} 条（${bio.birds.join('、') || '无'}）；虫类 ${bio.bugs.length} 条（${bio.bugs.join('、') || '无'}）`)
    lines.push('- 鱼类 / 鸟类只做统计呈现，**比例不作判定**；生物构成里仅「虫类 ≤ 四成」仍是提示级口径。')
    lines.push('')
  }
  if (asArray(validation.rejected).length > 0) {
    lines.push('## 被拒条目')
    lines.push('')
    for (const item of validation.rejected) lines.push(`- ${item.name}：${item.reason}`)
    lines.push('')
  }
  if (asArray(validation.errors).length > 0) {
    lines.push('## 未通过项')
    lines.push('')
    for (const item of validation.errors) lines.push(`- ${item}`)
    lines.push('')
  }
  if (asArray(validation.warnings).length > 0) {
    lines.push('## 提示')
    lines.push('')
    for (const item of validation.warnings) lines.push(`- ${item}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** 供测试与工具层共用的规则快照。 */
export function describeEquationRules() {
  return {
    topics: [...EQUATION_TOPICS],
    paths: [...EQUATION_PATHS],
    maxPerTopic: MAX_PER_TOPIC,
    /** 不受 maxPerTopic 约束的类别（当前只有生物类：条数不设上限）。 */
    maxPerTopicExempt: [BIO_TOPIC],
    ratioEnforceMin: RATIO_ENFORCE_MIN,
    detailRange: [...DETAIL_RANGE],
    minBioNameLength: MIN_BIO_NAME_LENGTH,
    maxNameLength: MAX_NAME_LENGTH,
    maxBugRatio: MAX_BUG_RATIO,
    maxRareChars: MAX_RARE_CHARS,
  }
}

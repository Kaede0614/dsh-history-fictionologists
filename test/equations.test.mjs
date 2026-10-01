/**
 * 「虚构差分方程」（功能 5）的规则与落盘测试。
 *
 * 分两层：
 *   1. 纯函数层——直接断言 `lib/equations.mjs` 的校验规则（不碰磁盘、不碰宿主）；
 *   2. 工具层——用 mock ctx 调 `gs_equation_save`，断言落盘、拒收、降级三条路径。
 *
 * 规则口径见 docs/fiction-equation.md（用户评审 2026-09-29 / 2026-09-30 历次修订）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')

/**
 * 测试用临时目录。
 *
 * 刻意放在**工作区内部**而不是系统 temp：受限沙箱下 Node 对系统 temp 的
 * mkdtemp 会 EPERM（Windows ACL 沙箱只放行工作区），工作区内则稳定可用。
 */
const TMP_ROOT = join(ROOT, '.tmp-tests')
function makeTmpDir(prefix) {
  mkdirSync(TMP_ROOT, { recursive: true })
  return mkdtempSync(join(TMP_ROOT, prefix))
}

async function loadEquations() {
  return import(pathToFileURL(join(ROOT, 'lib', 'equations.mjs')).href)
}

async function loadPlugin() {
  return import(pathToFileURL(join(ROOT, 'lib', 'shell.js')).href)
}

function makeCtx() {
  const record = { tools: [], sections: [], commands: [], logs: [] }
  const ctx = {
    logger: () => ({ info: () => {}, warn: (m) => record.logs.push(String(m)), error: () => {}, debug: () => {} }),
    effect(callback) {
      const dispose = callback()
      return dispose
    },
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { section: (section) => { record.sections.push(section); return () => {} } },
    tools: { register: (tool) => { record.tools.push(tool); return () => {} } },
    commands: { register: (definition) => { record.commands.push(definition); return () => {} } },
  }
  return { ctx, record }
}

const assertLossless = (value, label) => {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: 返回值含 undefined/不可序列化内容`)
}
const clamp = (text, n) => {
  let out = text
  while (out.replace(/\s/g, '').length < n) out += '补齐字数。'
  return out
}

/**
 * 一个可落盘的最小合法批次：**6 条**。
 *
 * 默认条数 6 只是配额习惯（人物 1 / 生物 2 / 装置 1 / 概念 1 / 派系 1）；
 * 规则上 5 条同样合法（每类各 1 条）。2026-09-30 起**生物类条数不设上限**、
 * 鱼 / 鸟的比例也不再有任何约束，所以配额表只剩「每类 ≥1、非生物类 ≤2」两条硬约束。
 */
const VALID_FIVE = [
  { name: '守秤员', topic: '人物·职业/身份', pathPrimary: '均衡', pathSecondary: '存护', detail: clamp('他在度量衡总署校正标准质量，自己却没有一杆秤。', 130), hooks: '库里一台天平开始自己报数。' },
  { name: '返航鳗', topic: '生物·物种/衍生体', pathPrimary: '记忆', pathSecondary: '巡猎', detail: clamp('银色鳗鱼随船远航，靠记住港口水面的形状认路。', 130), hooks: '港口改建之后整群鳗再也没有回来。' },
  { name: '滤膜鸥', topic: '生物·物种/衍生体', pathPrimary: '巡猎', pathSecondary: '存护', detail: clamp('海鸟翼下的膜能把空气中的水分子滤出来，飞过留下白色尾迹。', 130), hooks: '一群滤膜鸥往同一条线飞，尽头没有海。' },
  { name: '失物保管处', topic: '装置·器物/场所', pathPrimary: '记忆', detail: clamp('边缘货栈专门收送不到的东西，编号按最后经手人。', 130), hooks: '一件不可归还的货物被人认领了。' },
  { name: '同一秒', topic: '抽象概念·现象/事件', pathPrimary: '虚无', detail: clamp('整个星域每隔几年同时失去同一段记忆。', 130), hooks: '下一次停顿提前了，而且被拍到了。' },
  { name: '熄灯委员会', topic: '派系·机构/组织', pathPrimary: '毁灭', detail: clamp('一个半正式部门，业务是把亮得过分的星球的光源熄掉。', 130), hooks: '一颗星球主动申请被熄灯。' },
]

// ---------------------------------------------------------------------------
// 1. 纯函数层
// ---------------------------------------------------------------------------

test('六条批次（人物 1 / 生物 2 / 装置 1 / 概念 1 / 派系 1）通过校验', async () => {
  const { validateFictionEquations, EQUATION_TOPICS } = await loadEquations()
  const result = validateFictionEquations({ entries: VALID_FIVE })
  assert.equal(result.ok, true, result.errors.join('；'))
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.rejected, [])
  assert.equal(result.accepted.length, 6)
  assert.equal(result.counts['人物·职业/身份'], 1)
  assert.equal(result.counts['生物·物种/衍生体'], 2)
  assert.equal(result.counts['装置·器物/场所'], 1)
  assert.equal(result.counts['抽象概念·现象/事件'], 1)
  assert.equal(result.counts['派系·机构/组织'], 1)
  // 每条都必须落在五类之一，且计数之和等于通过条数
  const total = EQUATION_TOPICS.reduce((sum, topic) => sum + (result.counts[topic] ?? 0), 0)
  assert.equal(total, result.accepted.length)
})

test('配额：5 条批次（每类各 1 条）合法，且不再提示鱼鸟偏少', async () => {
  const { validateFictionEquations } = await loadEquations()
  const five = [VALID_FIVE[0], VALID_FIVE[1], VALID_FIVE[3], VALID_FIVE[4], VALID_FIVE[5]]
  const result = validateFictionEquations({ entries: five })
  assert.equal(result.ok, true, `5 条（每类 1 条、生物 1 条）应当通过：${result.errors.join('；')}`)
  assert.deepEqual(result.errors, [])
  assert.ok(
    !result.warnings.some((line) => line.includes('鱼类与鸟类')),
    `鱼鸟限制已删除，不该再出现相关提示：${result.warnings.join('；')}`,
  )
})

test('配比：单类超过 2 条被拒', async () => {
  const { validateFictionEquations } = await loadEquations()
  const entries = [
    ...VALID_FIVE,
    { ...VALID_FIVE[0], name: '记账员' },
    { ...VALID_FIVE[0], name: '验秤员' },
    { ...VALID_FIVE[0], name: '过磅员' },
  ]
  const result = validateFictionEquations({ entries })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((line) => line.includes('单类上限')), `应当报单类超限：${result.errors.join('；')}`)
})

test('配比：某类为 0 条被拒', async () => {
  const { validateFictionEquations } = await loadEquations()
  const entries = [
    ...Array.from({ length: 4 }, (_, i) => ({ ...VALID_FIVE[0], name: `人物${i}` })),
    VALID_FIVE[1],
    VALID_FIVE[2],
    VALID_FIVE[3],
    VALID_FIVE[4],
  ]
  const result = validateFictionEquations({ entries })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((line) => line.includes('人物·职业/身份') && line.includes('超过单类上限')))
})

test('少于 5 条时配比检查不生效（允许单类专项批次）', async () => {
  const { validateFictionEquations } = await loadEquations()
  const result = validateFictionEquations({ entries: [
    { ...VALID_FIVE[0] },
    { ...VALID_FIVE[0], name: '复核员' },
  ] })
  assert.equal(result.ok, true, `两条人物条目应当放行：${result.errors.join('；')}`)
})

test('生物名不足 3 字被拒；非生物名只受 8 字上限约束', async () => {
  const { validateFictionEquations } = await loadEquations()
  const shortBio = validateFictionEquations({ entries: [{ ...VALID_FIVE[1], name: '鲎灯' }] })
  assert.equal(shortBio.ok, false)
  assert.ok(shortBio.rejected[0].reason.includes('不足 3 字'))

  const shortHuman = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], name: '守秤' }] })
  assert.equal(shortHuman.ok, true, '人物类 2 字名应当放行')

  const longName = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], name: '非常非常非常长的方程名称' }] })
  assert.equal(longName.ok, false)
  assert.ok(longName.rejected[0].reason.includes('超过上限 8'))
})

test('生物类：沿用既有构词（蠧役 / 虫帝 / 巨人 …）被拒', async () => {
  const { validateFictionEquations } = await loadEquations()
  for (const name of ['纺囊蠧役', '蛰虫帝', '冰霜巨人', '孕灾残嗣']) {
    const result = validateFictionEquations({ entries: [{ ...VALID_FIVE[1], name }] })
    assert.equal(result.ok, false, `${name} 应当被拒`)
    assert.ok(result.rejected[0].reason.includes('雷同'), `${name} 的拒绝理由应提到雷同`)
  }
})

test('生物类：虫类超过四成被提示（warnings，不是 errors）', async () => {
  const { validateFictionEquations } = await loadEquations()
  const bugs = ['蝉蜕衣', '蚜灯蛾', '蚝壳蛆', '蜡线蜻', '窑温蛀'].map((name) => ({ ...VALID_FIVE[1], name }))
  // 只验证生物命名：跳过批级配比（5 条同类本来就会被「单类 ≤2」拦下，那是配比规则的事）
  const result = validateFictionEquations({ entries: bugs, skipRatio: true })
  assert.equal(result.ok, true, `四成是提示级，不应拒绝整批：${result.errors.join('；')}`)
  assert.ok(result.warnings.some((line) => line.includes('虫类')), `应当有虫类提示：${result.warnings.join('；')}`)
})

test('生物类：鱼类 / 鸟类比例不再判定（2026-09-30 删除鱼鸟比重限制）', async () => {
  const { validateFictionEquations } = await loadEquations()
  const noFishNoBird = validateFictionEquations({ skipRatio: true, entries: [
    { ...VALID_FIVE[1], name: '滤光囊' },
    { ...VALID_FIVE[1], name: '夜航丝' },
    { ...VALID_FIVE[1], name: '盐晶苔' },
    { ...VALID_FIVE[1], name: '里脊云' },
    { ...VALID_FIVE[1], name: '风坠羽' },
  ] })
  assert.equal(noFishNoBird.ok, true, `全是非鱼非鸟的生物也应放行：${noFishNoBird.errors.join('；')}`)
  assert.ok(
    !noFishNoBird.warnings.some((line) => line.includes('鱼类与鸟类')),
    `不该再提示鱼鸟偏少：${noFishNoBird.warnings.join('；')}`,
  )

  const tooManyBirds = validateFictionEquations({ skipRatio: true, entries: [
    { ...VALID_FIVE[1], name: '滤膜鸥' },
    { ...VALID_FIVE[1], name: '雾行隼' },
    { ...VALID_FIVE[1], name: '浅滩灯笼' },
    { ...VALID_FIVE[1], name: '滤光囊' },
    { ...VALID_FIVE[1], name: '里脊云' },
  ] })
  assert.equal(tooManyBirds.ok, true, `鸟类偏多也应放行：${tooManyBirds.errors.join('；')}`)
  assert.ok(
    !tooManyBirds.warnings.some((line) => line.includes('鸟类')),
    `不该再提示鸟类偏多：${tooManyBirds.warnings.join('；')}`,
  )
})

test('配额：生物类条数不设上限（单类 ≤2 只约束其余四类）', async () => {
  const { validateFictionEquations } = await loadEquations()
  const entries = [
    VALID_FIVE[0],                                   // 人物 1
    { ...VALID_FIVE[1], name: '滞纳鲤' },             // 生物 4 条
    { ...VALID_FIVE[1], name: '值夜鸮' },
    { ...VALID_FIVE[1], name: '补票鳝' },
    { ...VALID_FIVE[1], name: '盐晶苔' },
    VALID_FIVE[3], VALID_FIVE[4], VALID_FIVE[5],      // 装置 / 概念 / 派系 各 1
  ]
  const result = validateFictionEquations({ entries })
  assert.equal(result.ok, true, `生物 4 条不该再被单类上限拦下：${result.errors.join('；')}`)
  assert.equal(result.counts['生物·物种/衍生体'], 4)
  assert.ok(
    !result.errors.some((line) => line.includes('生物·物种/衍生体') && line.includes('超过单类上限')),
    `生物类已豁免单类上限：${result.errors.join('；')}`,
  )
  assert.equal(result.bio.total, 4)
})

test('星神纪律：星神 / 令使相关词被拒', async () => {
  const { validateFictionEquations } = await loadEquations()
  const result = validateFictionEquations({ entries: [
    { ...VALID_FIVE[0], detail: clamp('据说星神在此地留下了一枚脚印，令使每年来看一次。', 130) },
  ] })
  assert.equal(result.ok, false)
  assert.ok(result.rejected[0].reason.includes('星神'))
})

test('正文不写游戏机制：方括号符号与机制术语被拒', async () => {
  const { validateFictionEquations } = await loadEquations()
  for (const detail of [
    clamp('施放终结技后，为我方全体提供一层【切牌】，每层使行动提前 5%。', 130),
    clamp('该效果最多叠加 3 层，暴击伤害提高 40%。', 130),
  ]) {
    const result = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], detail }] })
    assert.equal(result.ok, false, `机制语言应当被拒：${detail.slice(0, 20)}`)
    assert.ok(result.rejected[0].reason.includes('游戏机制'), result.rejected[0].reason)
  }
})

test('详细设定字数与故事方向是硬约束', async () => {
  const { validateFictionEquations } = await loadEquations()
  const tooShort = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], detail: '太短了。' }] })
  assert.equal(tooShort.ok, false)
  assert.ok(tooShort.rejected[0].reason.includes('超出 120–220'))

  const noHooks = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], hooks: '' }] })
  assert.equal(noHooks.ok, false)
  assert.ok(noHooks.rejected[0].reason.includes('可能的故事方向'))
})

test('重名：与既有方程同名被拒（existingNames 由调用方注入）', async () => {
  const { validateFictionEquations } = await loadEquations()
  const result = validateFictionEquations({ entries: [VALID_FIVE[0]], existingNames: new Set(['守秤员']) })
  assert.equal(result.ok, false)
  assert.ok(result.rejected[0].reason.includes('重名'))
})

test('主题或命途非法被拒', async () => {
  const { validateFictionEquations, EQUATION_PATHS } = await loadEquations()
  const badTopic = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], topic: '人物' }] })
  assert.equal(badTopic.ok, false)
  assert.ok(badTopic.rejected[0].reason.includes('主题类别非法'))

  // 造一个**确实不在白名单里**的命途（白名单里有「均衡」，不能拿它当反例）
  const fakePath = '财富'
  assert.ok(!EQUATION_PATHS.includes(fakePath), '反例必须真的不在命途白名单里')
  const badPath = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], pathPrimary: fakePath }] })
  assert.equal(badPath.ok, false)
  assert.ok(badPath.rejected[0].reason.includes('主命途非法'))

  const badSecondary = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], pathSecondary: fakePath }] })
  assert.equal(badSecondary.ok, false)
  assert.ok(badSecondary.rejected[0].reason.includes('次命途非法'))

  const samePath = validateFictionEquations({ entries: [{ ...VALID_FIVE[0], pathSecondary: '均衡' }] })
  assert.equal(samePath.ok, false)
  assert.ok(samePath.rejected[0].reason.includes('主次命途相同'))
})

/**
 * 「贪饕」是 2026-09-30 用户评审放宽的命途（0.6.0 生效）：既有 212 条方程里
 * 没有一条以它为主命途，放开是为了能写吞噬 / 饥饿 / 永无餍足题材。
 * 它只加白名单，**不放宽星神纪律**——「奥博洛斯」仍在拒收词表里。
 */
test('命途白名单：贪饕可用作主 / 次命途，但不是放宽星神纪律的借口', async () => {
  const { validateFictionEquations, EQUATION_PATHS } = await loadEquations()
  assert.ok(EQUATION_PATHS.includes('贪饕'), '贪饕必须在命途白名单里')

  const asPrimary = validateFictionEquations({
    skipRatio: true,
    entries: [{ ...VALID_FIVE[0], pathPrimary: '贪饕', pathSecondary: '存护' }],
  })
  assert.equal(asPrimary.ok, true, `贪饕作主命途应当通过：${asPrimary.errors.join('；')}`)

  const asSecondary = validateFictionEquations({
    skipRatio: true,
    entries: [{ ...VALID_FIVE[0], pathPrimary: '均衡', pathSecondary: '贪饕' }],
  })
  assert.equal(asSecondary.ok, true, `贪饕作次命途应当通过：${asSecondary.errors.join('；')}`)

  const named = validateFictionEquations({
    skipRatio: true,
    entries: [{ ...VALID_FIVE[0], pathPrimary: '贪饕', detail: clamp('据说奥博洛斯会回来把这条街吃干净。', 130) }],
  })
  assert.equal(named.ok, false, '贪饕命途不等于可以点名星神')
  assert.ok(named.rejected[0].reason.includes('星神'), named.rejected[0].reason)
})

test('空批次被拒，且不抛错', async () => {
  const { validateFictionEquations } = await loadEquations()
  const result = validateFictionEquations({})
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0)
  assert.deepEqual(result.accepted, [])
})

test('只在被接受的条目上统计配比（被拒条目不会凑数）', async () => {
  const { validateFictionEquations } = await loadEquations()
  const before = [...VALID_FIVE]
  const entries = [...before, { ...VALID_FIVE[1], name: '鲎灯' }] // 末条因生物名不足 3 字被拒
  const result = validateFictionEquations({ entries })
  assert.equal(result.rejected.length, 1)
  assert.equal(result.bio.total, 2, '被拒的生物条目不应计入生物构成')
  assert.equal(result.counts['生物·物种/衍生体'], 2, '生物类计数应等于被接受的条数')
  assert.equal(result.counts['人物·职业/身份'], 1)
  assert.ok(
    result.warnings.every((line) => !line.startsWith('鲎灯：')),
    '被拒条目不应产生「提示」级别的条目级告警',
  )
})

test('成品 markdown 含 front-matter、主题标签与四段式字段', async () => {
  const { renderEquationsMarkdown, renderEquationsCheckReport, validateFictionEquations } = await loadEquations()
  const validation = validateFictionEquations({ entries: VALID_FIVE })
  const markdown = renderEquationsMarkdown({ title: '虚构差分方程·测试批', entries: validation.accepted, createdAt: '2026-09-29T00:00:00.000Z' })
  assert.match(markdown, /^---\nkind: equations\n/)
  assert.match(markdown, /## 守秤员/)
  assert.match(markdown, /〔人物·职业\/身份〕命途归属：〈均衡〉\/〈存护〉/)
  assert.match(markdown, /详细设定：/)
  assert.match(markdown, /可能的故事方向：/)

  const report = renderEquationsCheckReport({ title: '虚构差分方程·测试批', validation })
  assert.match(report, /主题配比/)
  assert.match(report, /人物·职业\/身份 \| 1/)
})

test('readExistingEquationNames：缓存缺失时降级为「跳过重名检查」而不是抛错', async () => {
  const { readExistingEquationNames } = await loadEquations()
  const empty = makeTmpDir('hsf-eq-nocache-')
  try {
    const result = readExistingEquationNames(empty)
    assert.deepEqual([...result.names], [])
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /跳过重名检查/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('readExistingEquationNames：缓存损坏时不抛错', async () => {
  const { readExistingEquationNames } = await loadEquations()
  const ws = makeTmpDir('hsf-eq-badcache-')
  try {
    writeFileSync(join(ws, 'hsr-worldview-cache.json'), '{ not json', 'utf8')
    const result = readExistingEquationNames(ws)
    assert.deepEqual([...result.names], [])
    assert.equal(result.warnings.length, 1)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. 工具层
// ---------------------------------------------------------------------------

async function callSave(entries, extra = {}) {
  const mod = await loadPlugin()
  const ws = makeTmpDir('hsf-eq-save-')
  const { ctx, record } = makeCtx()
  await mod.apply(ctx, { workspace: ws, ...(extra.config ?? {}) })
  const tool = record.tools.find((t) => t.name === 'gs_equation_save')
  assert.ok(tool, 'gs_equation_save 必须注册')
  const value = await tool.execute({ title: '虚构差分方程·测试批', entries }, { signal: AbortSignal.timeout(20_000) })
  return { value, ws, tool, mod }
}

test('gs_equation_save 落盘：目录自动创建、写成品与自检记录', async () => {
  const { value, ws } = await callSave(VALID_FIVE)
  try {
    assertLossless(value, 'gs_equation_save')
    assert.equal(value.saved, true, value.error ?? '')
    assert.ok(existsSync(value.path), '成品文件应存在')
    assert.ok(value.path.includes(join('hsr-stories', 'equations')), '成品应写入 hsr-stories/equations')
    assert.ok(existsSync(value.checkPath), '自检记录应存在')
    assert.ok(value.checkPath.endsWith('-equations.md'))
    assert.ok(value.path !== value.checkPath, '成品与自检记录不得是同一个文件')
    assert.equal(value.accepted.length, 6)
    assert.deepEqual(value.rejected, [])
    // counts 必须把五类键全部带上（output.schema 是 additionalProperties:false 的固定键集）
    assert.deepEqual(Object.keys(value.counts).sort(), [...value.rules.topics].sort())
    assert.equal(value.counts['生物·物种/衍生体'], 2)
    assert.equal(value.bio.total, 2)
    assert.deepEqual(value.bio.fish, ['返航鳗'])
    assert.deepEqual(value.bio.birds, ['滤膜鸥'])
    const text = readFileSync(value.path, 'utf8')
    assert.match(text, /kind: equations/)
    assert.match(text, /## 熄灯委员会/)
    const report = readFileSync(value.checkPath, 'utf8')
    assert.match(report, /自检报告/)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('gs_equation_save 拒收：非法条目不入盘，rejected 逐条给原因', async () => {
  const entries = [
    ...VALID_FIVE.slice(0, 4),
    { ...VALID_FIVE[1], name: '鲎灯' },
    { ...VALID_FIVE[0], name: '守秤员', detail: clamp('重复的名字。', 130) },
  ]
  const { value, ws } = await callSave(entries)
  try {
    assertLossless(value, 'gs_equation_save(partial)')
    assert.equal(value.saved, true, '通过 4 条 + 生物 2 条应当仍然落盘')
    assert.equal(value.rejected.length, 2, `应有两条被拒：${JSON.stringify(value.rejected)}`)
    assert.ok(value.rejected.some((item) => item.reason.includes('不足 3 字')))
    assert.ok(value.rejected.some((item) => item.reason.includes('本批次内名称重复')))
    const text = readFileSync(value.path, 'utf8')
    assert.ok(!text.includes('鲎灯'), '被拒条目不得写入成品')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('gs_equation_save 未通过配比时不写盘并给出 errors', async () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ ...VALID_FIVE[0], name: `人物${i}` }))
  const { value, ws } = await callSave(entries)
  try {
    assertLossless(value, 'gs_equation_save(blocked)')
    assert.equal(value.saved, false)
    assert.equal(value.path, '')
    assert.ok(value.errors.some((line) => line.includes('超过单类上限')), value.errors.join('；'))
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('gs_equation_save 尊重 saveOutputs=false（只校验不写盘）', async () => {
  const { value, ws } = await callSave(VALID_FIVE, { config: { saveOutputs: false } })
  try {
    assert.equal(value.saved, false)
    assert.match(value.error ?? '', /saveOutputs/)
    assert.equal(value.accepted.length, 6, '关闭落盘也应给出校验结果')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('gs_equation_save 的 output.schema 必填键与真实返回值一致', async () => {
  const { value, ws, tool } = await callSave(VALID_FIVE)
  try {
    const schema = tool.output.schema
    // defineTool 把逐属性的 `required: true` 规整成 JSON Schema 的 required 数组。
    const required = Array.isArray(schema.required) ? [...schema.required].sort() : []
    assert.ok(required.length > 0, 'output.schema 必须声明 required 数组')
    for (const key of required) {
      assert.ok(key in value, `返回值缺少必填键 ${key}`)
    }
    // 失败分支与成功分支的键集必须一致，否则宿主会以 invalid output 拒掉整次调用
    const blocked = await tool.execute({ title: '批次', entries: [{ ...VALID_FIVE[0], name: '太短' }] }, { signal: AbortSignal.timeout(20_000) })
    assertLossless(blocked, 'gs_equation_save(blocked-branch)')
    for (const key of required) {
      assert.ok(key in blocked, `失败分支缺少必填键 ${key}`)
    }
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('系统提示与 /gs 协议都带上了功能 5 的口径', async () => {
  const mod = await loadPlugin()
  const ws = makeTmpDir('hsf-eq-prompt-')
  const { ctx, record } = makeCtx()
  await mod.apply(ctx, { workspace: ws })
  try {
    const section = record.sections[0].text
    assert.match(section, /功能 5 · 虚构差分方程/)
    assert.match(section, /每类不得为 0 条/)
    assert.match(section, /生物类不受条数限制/)
    assert.doesNotMatch(section, /鱼类与鸟类不少于/, '鱼鸟比重限制已删除，系统提示不该再写')
    assert.match(section, /gs_equation_save/)

    const followed = []
    await mod.__internals.runGsCommand(
      { rawInput: '', attachments: [], agent: { followup: (message) => followed.push(message) } },
      {
        cfg: { ...mod.__internals.DEFAULTS, workspace: ws },
        workspace: () => ws,
        logger: { warn: () => {}, info: () => {} },
        createUserMessage: (input) => input,
      },
    )
    const protocol = followed[0].content[0].text
    assert.match(protocol, /5\) 虚构差分方程/)
    assert.match(protocol, /功能 5：一次生成 6 条全新方程/)
    assert.match(protocol, /gs_equation_save/)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

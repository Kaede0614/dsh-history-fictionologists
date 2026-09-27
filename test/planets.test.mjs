/**
 * 「星球制造机」契约测试（离线，无宿主、无网络）。
 *
 * 覆盖四层：
 *   1. 原始星球列表 —— 与用户原文逐字一致、条数正确、每条都有出处标注；
 *   2. 数据层（`lib/planets.mjs`）—— 读取降级、重名规则、原子写、重置、上限；
 *   3. 工具层 —— 三个 gs_planet* 工具的入参/返回/渲染与无损 JSON；
 *   4. /gs 协议 —— 第 1 步出现功能 4，收尾必须依次问「并入」与「重置」两件事。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')

const planetsMod = await import(pathToFileURL(join(ROOT, 'lib', 'planets.mjs')).href)
const shellMod = await import(pathToFileURL(join(ROOT, 'lib', 'shell.js')).href)

/** Minimal Cordis context double (mirrors test/plugin.test.mjs). */
function makeCtx() {
  const record = { effects: [], sections: [], tools: [], commands: [], logs: [] }
  const logger = (scope) => ({
    scope,
    info: (msg) => record.logs.push({ level: 'info', msg: String(msg) }),
    warn: (msg) => record.logs.push({ level: 'warn', msg: String(msg) }),
    error: (msg) => record.logs.push({ level: 'error', msg: String(msg) }),
    debug: () => {},
  })
  const ctx = {
    logger,
    effect(callback, label) {
      record.effects.push(label ?? 'unnamed')
      return callback()
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    systemPrompt: { section: (section) => (record.sections.push(section), () => {}) },
    tools: { register: (tool) => (record.tools.push(tool), () => {}) },
    commands: { register: (definition) => (record.commands.push(definition), () => {}) },
  }
  return { ctx, record }
}

async function boot(workspace) {
  const { ctx, record } = makeCtx()
  await shellMod.apply(ctx, { workspace })
  return record
}

const toolOf = (record, name) => record.tools.find((tool) => tool.name === name)

/** The host requires lossless JSON: JSON round-trip must be deep-equal. */
function assertLossless(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: 返回值含 undefined/不可序列化内容`)
}

/** 独立复刻宿主对 tool output 的校验口径（与 test/host-validator.test.mjs 同源规则的最小版）。 */
function assertSchemaShape(schema, value, path = '$') {
  const type = schema.type
  if (type === 'object') {
    assert.equal(typeof value, 'object', `${path} 应为对象`)
    assert.ok(value !== null && !Array.isArray(value), `${path} 不应为 null/数组`)
    for (const key of schema.required ?? []) {
      assert.ok(key in value, `${path} 缺少必填键 ${key}`)
    }
    for (const [key, item] of Object.entries(value)) {
      const sub = schema.properties?.[key]
      if (sub === undefined) {
        assert.equal(schema.additionalProperties, true, `${path}.${key} 未在 schema 中声明且 additionalProperties=false`)
        continue
      }
      if (item === undefined) continue
      assertSchemaShape(sub, item, `${path}.${key}`)
    }
    return
  }
  if (type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应为数组`)
    for (let index = 0; index < value.length; index += 1) {
      assertSchemaShape(schema.items, value[index], `${path}[${index}]`)
    }
    return
  }
  if (type === 'string') {
    assert.equal(typeof value, 'string', `${path} 应为字符串`)
    return
  }
  if (type === 'number') {
    assert.equal(typeof value, 'number', `${path} 应为数字`)
    return
  }
  if (type === 'boolean') {
    assert.equal(typeof value, 'boolean', `${path} 应为布尔`)
  }
}

function withWorkspace(fn) {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-planets-'))
  return Promise.resolve(fn(workspace)).finally(() => rmSync(workspace, { recursive: true, force: true }))
}

/**
 * 本地复刻 shell 内部的 `textOf()`（它没有导出）。
 * 存在的意义：断言「render 的实际返回是内容块数组」，而不是拿纯函数字符串当数组用——
 * 后者正是写测试时踩到的坑（字符串 `[0]` 取到的是首字符，`.text` 为 undefined）。
 */
function textOfForTest(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

// ---------------------------------------------------------------------------
// 1. 原始列表
// ---------------------------------------------------------------------------
test('原始星球列表与用户原文逐字一致（27 颗）', () => {
  const parsed = planetsMod.parseBaseline()
  assert.equal(parsed.length, 27, '用户给出的列表是 27 条')
  assert.equal(planetsMod.PLANETS.length, 27)

  // 每条都必须能在底本文本里找到「名字 + 描述」的逐字原文。
  for (const planet of planetsMod.PLANETS) {
    assert.ok(planet.name.length > 0, '星球名不可为空')
    assert.ok(planet.description.length > 0, `${planet.name} 缺描述`)
    const line = planetsMod.PLANET_BASELINE_SOURCE.split(/\r?\n/)
      .find((item) => item.startsWith(`${planet.name} `) || item.startsWith(`${planet.name}\t`))
    assert.ok(line !== undefined, `${planet.name} 不在底本里（常量与原文不一致）`)
    assert.ok(line.includes(planet.description), `${planet.name} 的描述与原文不一致`)
  }

  // 抽查三条最容易被回写改坏的：引号、全角斜杠、非 ASCII 破折号。
  const byName = Object.fromEntries(planetsMod.PLANETS.map((planet) => [planet.name, planet]))
  assert.equal(byName['江户星 / 江户城'].en, 'Edo Star')
  assert.match(byName['阿丽万塔'].description, /“换境树”/)
  assert.match(byName['盗贼公国塔利亚'].description, /“繁星垃圾场”/)
  assert.equal(byName['日耀-XIII'].en, 'Sunburst-XIII')
})

test('每条星球都有合法的「出处」标注（键集合与条目一一对应）', () => {
  assert.equal(planetsMod.PLANET_SOURCE_KEYS.length, 27, '出处标注必须覆盖 27 颗')
  const names = new Set(planetsMod.PLANETS.map((planet) => planet.name))
  for (const key of planetsMod.PLANET_SOURCE_KEYS) {
    assert.ok(names.has(key), `出处标注 ${key} 在原始列表里不存在（改名后忘了同步）`)
  }
  for (const planet of planetsMod.PLANETS) {
    assert.ok(planetsMod.PLANET_SOURCES.includes(planet.source), `${planet.name} 的 source 非法：${planet.source}`)
  }
  // 毁灭/玻璃化/瘫痪的那五颗必须归 ruined，防止以后有人顺手改错。
  const ruined = planetsMod.PLANETS.filter((planet) => planet.source === 'ruined').map((planet) => planet.name)
  assert.deepEqual(ruined, ['阿德利文', '新伯利恒', '哈特雷维尼亚', '巴兰萨熔炉', '日耀-XIII'])
})

test('底本解析容错：缺制表符的行当纯名字，不整份丢掉', () => {
  const parsed = planetsMod.parseBaseline('甲星 (Alpha)\t描述一\n乙星\n\n丙星\t描述三')
  assert.deepEqual(parsed, [
    { name: '甲星', en: 'Alpha', description: '描述一' },
    { name: '乙星', en: '', description: '' },
    { name: '丙星', en: '', description: '描述三' },
  ])
})

// ---------------------------------------------------------------------------
// 2. 数据层
// ---------------------------------------------------------------------------
test('无增量文件时 listPlanets 返回纯原始列表', async () => {
  await withWorkspace((workspace) => {
    const view = planetsMod.listPlanets(workspace)
    assert.equal(view.ok, true)
    assert.equal(view.exists, false)
    assert.equal(view.baselineCount, 27)
    assert.equal(view.addedCount, 0)
    assert.equal(view.total, 27)
    assert.deepEqual(view.warnings, [])
    assert.equal(view.path, join(workspace, 'hsr-worldview-cache', 'planet-list.json'))
  })
})

test('addPlanets：新星球入列，重名拒绝原始列表，重名更新增量条目', async () => {
  await withWorkspace((workspace) => {
    const first = planetsMod.addPlanets(workspace, {
      planets: [
        { name: '洛珂萨', en: 'Loxa', description: '当铺星', source: 'mentioned' },
        { name: '螺丝星', description: '试图覆写原始列表' },
      ],
    })
    assert.equal(first.ok, true)
    assert.deepEqual(first.added.map((p) => p.name), ['洛珂萨'])
    assert.equal(first.rejected.length, 1)
    assert.equal(first.rejected[0].name, '螺丝星')
    assert.match(first.rejected[0].reason, /原始星球列表/)
    assert.equal(first.addedCount, 1)
    assert.equal(first.total, 28)
    assert.ok(first.bytes > 0, '写盘应报告字节数')

    // 落盘文件：既有人类可读的 baseline 快照，也有 added 增量。
    const raw = JSON.parse(readFileSync(join(workspace, 'hsr-worldview-cache', 'planet-list.json'), 'utf8'))
    assert.equal(raw.schema, planetsMod.PLANET_LIST_SCHEMA)
    assert.equal(raw.baseline.length, 27)
    assert.equal(raw.added.length, 1)
    assert.equal(raw.added[0].name, '洛珂萨')

    // 第二次：同名 → 更新描述而不是再插一条。
    const second = planetsMod.addPlanets(workspace, {
      planets: [{ name: '洛珂萨', description: '当铺星（修订）', source: 'mentioned' }],
    })
    assert.deepEqual(second.added, [])
    assert.deepEqual(second.updated.map((p) => p.name), ['洛珂萨'])
    assert.equal(second.addedCount, 1)
    assert.equal(second.total, 28)
    const view = planetsMod.listPlanets(workspace)
    assert.equal(view.addedCount, 1)
    assert.equal(view.planets.at(-1).description, '当铺星（修订）')

    // 全被拒绝时不写盘（bytes 0）且 ok=false。
    const third = planetsMod.addPlanets(workspace, { planets: [{ name: '螺丝星', description: 'x' }] })
    assert.equal(third.ok, false)
    assert.equal(third.bytes, 0)
    assert.equal(third.addedCount, 1)
  })
})

test('addPlanets：名字容错判定（空格差异算同一颗，前缀不算，英文名大小写也算同一颗）', async () => {
  await withWorkspace((workspace) => {
    const result = planetsMod.addPlanets(workspace, {
      planets: [
        { name: '江户星/江户城', description: '去掉空格后与原始列表同名的写法' },
        { name: '螺丝星二号', description: '前缀相同但不是同一颗' },
      ],
    })
    assert.deepEqual(result.rejected.map((r) => r.name), ['江户星/江户城'])
    assert.deepEqual(result.added.map((p) => p.name), ['螺丝星二号'])
  })
})

/**
 * 0.3.0 独立复核（reviewer-adversarial B3）实测的缺口：只按中文名比对时，
 * `ARIVANTA` 会被当成一颗「新星球」。英文名的大小写变体必须同样被拒绝。
 */
test('addPlanets：英文名的大小写变体也算重名（reviewer B3 回归）', async () => {
  await withWorkspace((workspace) => {
    const result = planetsMod.addPlanets(workspace, {
      planets: [
        { name: 'ARIVANTA', description: '英文名大写变体' },
        { name: 'arivanta', description: '英文名小写变体' },
        { name: ' Attouine ', description: '英文名带空格变体' },
        { name: '洛珂萨', en: 'Loxa', description: '真正的新星球' },
      ],
    })
    assert.deepEqual(result.rejected.map((r) => r.name), ['ARIVANTA', 'arivanta', 'Attouine'])
    assert.deepEqual(result.added.map((p) => p.name), ['洛珂萨'], '合法的新星球仍必须写进去')

    // 前缀/近似但不同的英文名不算重名：不能把防线做得过宽。
    const near = planetsMod.addPlanets(workspace, { planets: [{ name: 'Arivantu', description: '拼写相近但不是同一颗' }] })
    assert.deepEqual(near.added.map((p) => p.name), ['Arivantu'])

    // 复核 R-3：候选的 `en` 字段同样不能撞原始列表（否则列表里会出现两条 Arivanta）。
    const viaEn = planetsMod.addPlanets(workspace, { planets: [{ name: '洛珂萨二号', en: 'Arivanta', description: '英文名撞原始列表' }] })
    assert.deepEqual(viaEn.added, [])
    assert.deepEqual(viaEn.rejected.map((r) => r.name), ['洛珂萨二号'])
    assert.match(viaEn.rejected[0].reason, /阿丽万塔/)
  })
})

/**
 * 复核 R-1（medium）：单次超过 MAX_BATCH 的候选此前被**静默丢弃**——不进
 * added/updated/rejected、不落盘，而 `ok` 仍是 true，模型会据此告诉用户「都加进去了」。
 * 现在必须出现在结构化的 `overflow` 里，并在 warnings 里点名。
 */
test('addPlanets：超出单次上限的候选进入 overflow，不再静默丢弃（R-1 回归）', async () => {
  await withWorkspace((workspace) => {
    const count = planetsMod.MAX_BATCH + 5
    const planets = Array.from({ length: count }, (_, index) => ({ name: `批次星${index}`, description: 'x' }))
    const result = planetsMod.addPlanets(workspace, { planets })
    assert.equal(result.ok, true)
    assert.equal(result.added.length, planetsMod.MAX_BATCH)
    assert.equal(result.overflow.count, 5, '被丢弃的 5 条必须在 overflow 里')
    assert.deepEqual(result.overflow.names, ['批次星20', '批次星21', '批次星22', '批次星23', '批次星24'])
    assert.ok(result.warnings.some((w) => w.includes('被丢弃')), `warnings 必须点名：${JSON.stringify(result.warnings)}`)

    // 落盘只有 20 条：overflow 里的名字确实没进列表。
    const view = planetsMod.listPlanets(workspace)
    assert.equal(view.addedCount, planetsMod.MAX_BATCH)
    const names = new Set(view.planets.map((p) => p.name))
    for (const dropped of result.overflow.names) assert.ok(!names.has(dropped), `${dropped} 不应在列表里`)
  })
})

/** 复核 R-4：超长名字此前静默截断（200 字 → 60 字，`ok=true`、`warnings=[]`）。 */
test('addPlanets：超长名字截断必须留下 warnings（R-4 回归）', async () => {
  await withWorkspace((workspace) => {
    const result = planetsMod.addPlanets(workspace, { planets: [{ name: '长'.repeat(200), description: 'x' }] })
    assert.equal(result.ok, true)
    assert.equal(result.added[0].name.length, 60)
    assert.ok(result.warnings.some((w) => w.includes('截断')), `warnings 必须说明截断：${JSON.stringify(result.warnings)}`)
  })
})

test('addPlanets：同批次重名只留最后一条；缺 name 的条目被忽略', async () => {
  await withWorkspace((workspace) => {
    const result = planetsMod.addPlanets(workspace, {
      planets: [
        { name: '重复星', description: '第一版' },
        { name: '重复星', description: '第二版' },
        { description: '没有名字' },
        'not-an-object',
      ],
    })
    assert.deepEqual(result.added.map((p) => p.name), ['重复星'])
    assert.equal(result.added[0].description, '第二版')
    assert.ok(result.warnings.some((w) => w.includes('重名')), '重名必须出现在 warnings 里')
    assert.ok(result.warnings.some((w) => w.includes('name')), '缺 name 必须出现在 warnings 里')
  })
})

test('addPlanets：空数组不写盘，返回 ok=false 与原因', async () => {
  await withWorkspace((workspace) => {
    const result = planetsMod.addPlanets(workspace, { planets: [] })
    assert.equal(result.ok, false)
    assert.equal(result.addedCount, 0)
    assert.equal(result.bytes, 0)
    assert.equal(existsSync(join(workspace, 'hsr-worldview-cache', 'planet-list.json')), false)
  })
})

test('resetPlanets：清空增量并重建原始快照；文件不存在时 created=true', async () => {
  await withWorkspace((workspace) => {
    const empty = planetsMod.resetPlanets(workspace)
    assert.equal(empty.ok, true)
    assert.equal(empty.removed, 0)
    assert.equal(empty.created, true)
    assert.equal(empty.total, 27)
    assert.equal(planetsMod.listPlanets(workspace).exists, true)

    planetsMod.addPlanets(workspace, { planets: [{ name: '洛珂萨', description: 'x' }, { name: '阿蒙提斯', description: 'y' }] })
    assert.equal(planetsMod.listPlanets(workspace).addedCount, 2)

    const reset = planetsMod.resetPlanets(workspace)
    assert.equal(reset.ok, true)
    assert.equal(reset.removed, 2)
    assert.equal(reset.created, false)
    const view = planetsMod.listPlanets(workspace)
    assert.equal(view.addedCount, 0)
    assert.equal(view.total, 27)
    assert.deepEqual(view.planets.map((p) => p.name), planetsMod.PLANETS.map((p) => p.name))
    const raw = JSON.parse(readFileSync(join(workspace, 'hsr-worldview-cache', 'planet-list.json'), 'utf8'))
    assert.deepEqual(raw.added, [])
    assert.equal(raw.baseline.length, 27)
  })
})

test('读取降级：坏 JSON / 顶层不是对象 / added 不是数组 / 重复与非法条目', async () => {
  await withWorkspace((workspace) => {
    const dir = join(workspace, 'hsr-worldview-cache')
    const file = join(dir, 'planet-list.json')

    // 坏 JSON
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '{ this is not json', 'utf8')
    const broken = planetsMod.listPlanets(workspace)
    assert.equal(broken.ok, false)
    assert.equal(broken.baselineCount, 27, '读坏了也必须退回原始列表')
    assert.ok(broken.warnings.some((w) => w.includes('读取失败')))

    // 顶层是数组（旧写法）→ 仍然可用
    writeFileSync(file, JSON.stringify([{ name: '甲星', description: 'd' }]), 'utf8')
    assert.equal(planetsMod.listPlanets(workspace).addedCount, 1)

    // added 不是数组
    writeFileSync(file, JSON.stringify({ schema: 'x', added: 'nope' }), 'utf8')
    const badShape = planetsMod.listPlanets(workspace)
    assert.equal(badShape.addedCount, 0)
    assert.ok(badShape.warnings.some((w) => w.includes('added')))

    // 与原始列表重名 + 条目内重名 + 空对象 → 全部计入 dropped 且不污染列表
    writeFileSync(file, JSON.stringify({
      added: [
        { name: '螺丝星', description: '与原始列表重名' },
        { name: '乙星', description: 'ok' },
        { name: '乙星', description: '重复' },
        { description: '无名字' },
        null,
      ],
    }), 'utf8')
    const view = planetsMod.listPlanets(workspace)
    assert.equal(view.addedCount, 1)
    assert.equal(view.planets.at(-1).name, '乙星')
    assert.ok(view.warnings.some((w) => w.includes('忽略')))
  })
})

test('MAX_ADDED 上限：到顶后拒绝写入并给出可执行的提示', async () => {
  await withWorkspace((workspace) => {
    const batch = Array.from({ length: planetsMod.MAX_ADDED }, (_, index) => ({ name: `填充星-${index}`, description: 'x' }))
    // MAX_ADDED 是 200 > MAX_BATCH 20，所以分十批灌满。
    for (let index = 0; index < batch.length; index += planetsMod.MAX_BATCH) {
      const slice = batch.slice(index, index + planetsMod.MAX_BATCH)
      const result = planetsMod.addPlanets(workspace, { planets: slice })
      assert.equal(result.ok, true, `第 ${index / planetsMod.MAX_BATCH} 批应写入成功`)
    }
    assert.equal(planetsMod.listPlanets(workspace).addedCount, planetsMod.MAX_ADDED)

    const overflow = planetsMod.addPlanets(workspace, { planets: [{ name: '再来一颗', description: 'x' }] })
    assert.equal(overflow.ok, false)
    assert.match(overflow.error, /上限/)
    assert.equal(planetsMod.listPlanets(workspace).addedCount, planetsMod.MAX_ADDED, '超限时不得写入')
  })
})

// ---------------------------------------------------------------------------
// 3. 工具层
// ---------------------------------------------------------------------------
test('apply 注册三个星球工具，且输出 schema 形状合法', async () => {
  await withWorkspace(async (workspace) => {
    const record = await boot(workspace)
    const names = record.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, [
      'gs_digest', 'gs_missions', 'gs_planet_reset', 'gs_planet_save', 'gs_planets',
      'gs_read', 'gs_save', 'gs_setup', 'gs_update',
    ])
    for (const name of ['gs_planets', 'gs_planet_save', 'gs_planet_reset']) {
      const tool = toolOf(record, name)
      assert.ok(tool.description.includes('星球'), `${name} 的描述必须提到星球`)
      assert.equal(tool.output.schema.additionalProperties, false)
    }
  })
})

test('gs_planets：默认返回 27 颗 + 流程说明；source/query 过滤生效', async () => {
  await withWorkspace(async (workspace) => {
    const record = await boot(workspace)
    const tool = toolOf(record, 'gs_planets')

    const all = await tool.execute({}, {})
    assertLossless(all, 'gs_planets')
    assertSchemaShape(tool.output.schema, all)
    assert.equal(all.ok, true)
    assert.equal(all.total, 27)
    assert.equal(all.matched, 27)
    assert.equal(all.planets[0].name, '阿丽万塔')
    assert.equal(all.planets[0].origin, 'baseline')
    assert.match(all.guidance, /gs_planet_save/)
    assert.match(all.guidance, /gs_planet_reset/)
    assert.ok(!('en' in all.planets.find((p) => p.name === '螺丝星')), '没有英文名的条目不得出现空字符串键')

    const ruined = await tool.execute({ source: 'ruined' }, {})
    assert.equal(ruined.matched, 5)
    assert.deepEqual(ruined.planets.map((p) => p.name), ['阿德利文', '新伯利恒', '哈特雷维尼亚', '巴兰萨熔炉', '日耀-XIII'])

    const queried = await tool.execute({ query: '银狼' }, {})
    assert.equal(queried.matched, 1)
    assert.equal(queried.planets[0].name, '朋克洛德')

    const bogus = await tool.execute({ source: '不存在的出处' }, {})
    assert.equal(bogus.matched, 27, '非法 source 视为不过滤，而不是返回空')

    const rendered = tool.output.render({}, all)
    assert.ok(Array.isArray(rendered) && rendered[0].text.includes('原始 27 颗'))
  })
})

test('gs_planet_save：并入 → 列表增长；重名 → rejected 并写进 warnings', async () => {
  await withWorkspace(async (workspace) => {
    const record = await boot(workspace)
    const save = toolOf(record, 'gs_planet_save')
    const list = toolOf(record, 'gs_planets')

    const saved = await save.execute({
      planets: [
        { name: '洛珂萨', en: 'Loxa', description: '记忆当通货的当铺星', source: 'mentioned' },
        { name: '螺丝星', description: '撞名' },
      ],
    }, {})
    assertLossless(saved, 'gs_planet_save')
    assertSchemaShape(save.output.schema, saved)
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.added.map((p) => p.name), ['洛珂萨'])
    assert.deepEqual(saved.rejected.map((r) => r.name), ['螺丝星'])
    assert.equal(saved.addedCount, 1)
    assert.equal(saved.total, 28)
    assert.ok(saved.warnings.some((w) => w.includes('拒绝')), '部分写入必须显式提示')

    const after = await list.execute({}, {})
    assert.equal(after.total, 28)
    assert.equal(after.addedCount, 1)
    assert.equal(after.planets.at(-1).origin, 'added')
    assert.equal(after.planets.at(-1).name, '洛珂萨')

    const empty = await save.execute({ planets: [] }, {})
    assert.equal(empty.ok, false)
    assert.match(empty.error, /为空/)
    assertLossless(empty, 'gs_planet_save(empty)')

    const rendered = save.output.render({}, saved)
    assert.ok(rendered[0].text.includes('洛珂萨'))
    assert.ok(rendered[0].text.includes('没有被并入列表') || rendered[0].text.includes('没有**并入'))
  })
})

test('gs_planet_reset：无 confirm 只报告状态、绝不改文件；confirm=true 才清空', async () => {
  await withWorkspace(async (workspace) => {
    const record = await boot(workspace)
    const save = toolOf(record, 'gs_planet_save')
    const reset = toolOf(record, 'gs_planet_reset')

    await save.execute({ planets: [{ name: '洛珂萨', description: 'x' }] }, {})

    const guarded = await reset.execute({}, {})
    assertLossless(guarded, 'gs_planet_reset(guarded)')
    assertSchemaShape(reset.output.schema, guarded)
    assert.equal(guarded.ok, true)
    assert.equal(guarded.reset, false)
    assert.equal(guarded.removed, 0)
    assert.match(guarded.message, /confirm/)
    assert.equal(planetsMod.listPlanets(workspace).addedCount, 1, '无 confirm 时不得动文件')

    const done = await reset.execute({ confirm: true }, {})
    assertLossless(done, 'gs_planet_reset(confirm)')
    assert.equal(done.ok, true)
    assert.equal(done.reset, true)
    assert.equal(done.removed, 1)
    assert.equal(done.total, 27)
    assert.equal(planetsMod.listPlanets(workspace).addedCount, 0)

    const again = await reset.execute({ confirm: true }, {})
    assert.equal(again.reset, true)
    assert.equal(again.removed, 0)

    const rendered = reset.output.render({}, done)
    assert.ok(rendered[0].text.includes('已重置'))
  })
})

test('gs_setup 报告星球列表；planets 子模块缺失时不抛异常', async () => {
  await withWorkspace(async (workspace) => {
    const record = await boot(workspace)
    const setup = toolOf(record, 'gs_setup')
    const value = await setup.execute({}, {})
    assertLossless(value, 'gs_setup')
    assertSchemaShape(setup.output.schema, value)
    assert.equal(value.planets.baselineCount, 27)
    assert.equal(value.planets.addedCount, 0)
    assert.equal(value.planets.exists, false)
    assert.match(setup.output.render({}, value)[0].text, /星球列表：原始 27 颗/)

    // 降级：planets 子模块为 null → 三个工具都返回合法值而不是抛错。
    const restore = shellMod.__internals.stubSubmodules({ planets: null })
    try {
      const planets = await toolOf(record, 'gs_planets').execute({}, {})
      assertLossless(planets, 'gs_planets(degraded)')
      assertSchemaShape(toolOf(record, 'gs_planets').output.schema, planets)
      assert.equal(planets.ok, false)
      assert.equal(planets.baselineCount, 27, '内置常量仍可作为兜底返回')
      assert.ok(planets.warnings.length > 0)
      assert.equal(planets.planets[0].name, '阿丽万塔', '降级兜底返回的条目也必须是模型可读的原始列表')
      assert.equal(planets.matched, 27)

      const save = await toolOf(record, 'gs_planet_save').execute({ planets: [{ name: '甲星' }] }, {})
      assertLossless(save, 'gs_planet_save(degraded)')
      assertSchemaShape(toolOf(record, 'gs_planet_save').output.schema, save)
      assert.equal(save.ok, false)

      const reset = await toolOf(record, 'gs_planet_reset').execute({ confirm: true }, {})
      assertLossless(reset, 'gs_planet_reset(degraded)')
      assertSchemaShape(toolOf(record, 'gs_planet_reset').output.schema, reset)
      assert.equal(reset.ok, false)

      const setupValue = await toolOf(record, 'gs_setup').execute({}, {})
      assertLossless(setupValue, 'gs_setup(degraded)')
      assert.equal(typeof setupValue.planets.baselineCount, 'number')
    } finally {
      restore()
    }
  })
})

test('renderSetup 对手工构造的旧值（无 planets 键）不抛异常', () => {
  const value = {
    ok: true,
    cacheDir: 'C:/x',
    workspace: 'C:/x',
    hasCache: false,
    recommendation: 'update',
    advice: 'a',
    staleAfterDays: 7,
    recentGuardDays: 7,
    datasets: [],
    missions: { ok: false, seriesCount: 0, missionCount: 0 },
    userCanon: { count: 0, path: 'p' },
    warnings: [],
  }
  // renderSetup 本身是纯函数、返回字符串；`textOf()` 才是把它包成内容块的那一层。
  const text = shellMod.__internals.renderSetup(value)
  assert.equal(typeof text, 'string')
  assert.match(text, /星球列表：未知/)

  // 经 textOf 包装后的形状（工具 render 的真实返回）也必须是数组。
  const block = textOfForTest(text)
  assert.ok(Array.isArray(block) && typeof block[0].text === 'string')
})

// ---------------------------------------------------------------------------
// 4. /gs 协议与系统提示
// ---------------------------------------------------------------------------
test('/gs 协议：第 1 步有四个功能，收尾依次问「并入」与「重置」', async () => {
  await withWorkspace(async (workspace) => {
    const { ctx } = makeCtx()
    await shellMod.apply(ctx, { workspace })
    const followed = []
    const result = await shellMod.__internals.runGsCommand(
      {
        commandId: 'test-planets',
        rawInput: '',
        attachments: [],
        signal: AbortSignal.timeout(20_000),
        agent: { followup: (message) => followed.push(message) },
      },
      {
        cfg: { ...shellMod.__internals.DEFAULTS, workspace },
        workspace: () => workspace,
        logger: { warn: () => {}, info: () => {} },
        createUserMessage: (input) => ({ kind: 'user-message', ...input }),
      },
    )
    assert.equal(result.kind, 'success')
    assert.equal(followed.length, 1)
    const text = followed[0].content[0].text

    assert.match(text, /四个选项逐字为/)
    assert.match(text, /4\) 星球制造机/)
    assert.match(text, /· 功能 4：先 gs_planets/)
    assert.match(text, /① 生成结束后用 ask_user_question 问/)
    assert.match(text, /gs_planet_save/)
    assert.match(text, /② 紧接着再问一次/)
    assert.match(text, /gs_planet_reset\(confirm=true\)/)
    assert.match(text, /星球列表：原始 27 颗/)
    assert.ok(!/三个选项逐字为/.test(text), '旧的三选项文案必须消失')
    assertLossless(result, '/gs result(planets)')
  })
})

test('系统提示总则：包含星球制造机格式与两问纪律', () => {
  const guide = shellMod.__internals.STYLE_GUIDE
  assert.match(guide, /\*\*星球制造机\*\*/)
  assert.match(guide, /【星域名（English Name）】/)
  assert.match(guide, /gs_planet_save/)
  assert.match(guide, /gs_planet_reset/)
  assert.match(guide, /四个功能的输出格式/)
  assert.match(guide, /星神纪律（四个功能共同适用/)
})

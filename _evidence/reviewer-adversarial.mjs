/**
 * 独立复核 · item B / C / D / F —— 攻击「原始列表优先」「重置确认」两道防线。
 *
 * 姿势与作者不同：
 *   - 从**部署位置**（junction 目标）import，即 DSH 真正加载的那一份；
 *   - 每个攻击用例前把增量文件删掉（工具层 workspace 由 apply 固定，不能 per-case 换目录）；
 *   - 每个用例都核对「文件里的 baseline 描述有没有被改掉」——这是最严重的一类缺陷，
 *     作者脚本只断言 `rejected` 里有撞名项，没有逐条核对 baseline 是否被覆写；
 *   - 重置防线按题目要求做**字节长度 + mtime + sha256** 三重复核。
 *
 * 只读被测实现；只写自己的临时目录。用法：node _evidence/reviewer-adversarial.mjs
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PLANETS } from '../lib/planets.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME
const DEPLOY = join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-history-fictionologists')
const ENTRY = join(DEPLOY, 'lib', 'shell.js')

const mod = await import(pathToFileURL(ENTRY).href)
const { optionalImport } = await import(pathToFileURL(join(DEPLOY, 'lib', 'resolve.js')).href)
const toolsMod = await optionalImport('@deepseek-ai/dsh-tools')
const validate = toolsMod?.validateJsonSchemaValue ?? null

function makeCtx() {
  const record = { tools: [], commands: [], sections: [] }
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (cb) => cb(),
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { section: (s) => (record.sections.push(s), () => {}) },
    tools: { register: (t) => (record.tools.push(t), () => {}) },
    commands: { register: (c) => (record.commands.push(c), () => {}) },
  }
  return { ctx, record }
}

const { ctx, record } = makeCtx()
// 注意：工具层的 workspace 由 apply 的 config 决定，**不能**用 cwd——否则会往仓库里写
// planet-list.json（复核者的硬约束是只读被测实现）。这里用一次性临时目录。
const MODULE_WS = mkdtempSync(join(tmpdir(), 'hsf-review-module-'))
mod.apply(ctx, { workspace: MODULE_WS })

const tool = (name) => {
  const found = record.tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} 未注册`)
  return found
}

const newWs = () => mkdtempSync(join(tmpdir(), 'hsf-review-'))
const listFile = (ws) => join(ws, 'hsr-worldview-cache', 'planet-list.json')
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
const fileFacts = (path) => {
  if (!existsSync(path)) return { exists: false }
  const stat = statSync(path)
  return { exists: true, bytes: stat.size, mtimeMs: stat.mtimeMs, sha: hashOf(path) }
}
const isLossless = (value) => JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
const hasNull = (value) => {
  if (value === null) return true
  if (Array.isArray(value)) return value.some(hasNull)
  if (typeof value === 'object' && value !== undefined) return Object.values(value).some(hasNull)
  return false
}
/**
 * 把 MODULE_WS 的增量列表清空（删掉增量文件 = 回到纯原始列表）。
 * 注：**不能**用 `__internals.resetPlanets` —— 部署位置的 `__internals` 里没有这个键
 * （实测 `Object.keys(mod.__internals)` 只有 28 个键，不含 resetPlanets）。
 */
const freshState = () => rmSync(listFile(MODULE_WS), { force: true })

/** 部署位置的 baseline 描述（逐条），用于检测「原始描述被覆写」。 */
const BASELINE_DESC = new Map(PLANETS.map((p) => [p.name, p.description]))
const overwrittenNames = (ws) => {
  const raw = JSON.parse(readFileSync(listFile(ws), 'utf8'))
  const bad = []
  for (const entry of raw.baseline) {
    if (BASELINE_DESC.get(entry.name) !== entry.description) bad.push(entry.name)
  }
  return bad
}

const results = []
const findings = []

async function saveCase(label, planets, { seed = null } = {}) {
  freshState()
  if (seed) {
    const seeded = await tool('gs_planet_save').execute({ planets: seed }, {})
    if (seeded.ok !== true) throw new Error(`seed 失败：${JSON.stringify(seeded).slice(0, 200)}`)
  }
  let value
  let threw = null
  try {
    value = await tool('gs_planet_save').execute({ planets }, {})
  } catch (error) {
    threw = `${error?.code ?? error?.name}: ${error?.message}`
  }
  const file = fileFacts(listFile(MODULE_WS))
  const overwritten = file.exists ? overwrittenNames(MODULE_WS) : []
  const violations = threw ? null : validate(tool('gs_planet_save').output.schema, value, 'value')
  const row = {
    label,
    ok: threw ? '(throw)' : value.ok,
    added: threw ? '-' : value.added.map((p) => p.name),
    updated: threw ? '-' : value.updated.map((p) => p.name),
    rejected: threw ? '-' : value.rejected.map((r) => r.name),
    error: threw ?? value.error ?? '',
    lossless: threw ? null : isLossless(value),
    nullKeys: threw ? null : hasNull(value),
    schemaViolations: violations,
    overwritten,
    file,
  }
  results.push(row)
  if (overwritten.length > 0) findings.push(`BLOCKER: ${label} 覆写了原始描述：${overwritten.join('、')}`)
  if (row.lossless === false) findings.push(`HIGH: ${label} 返回值不是 lossless JSON`)
  if (row.nullKeys === true) findings.push(`HIGH: ${label} 返回值含 null 值（宿主会拒）`)
  if (violations && violations.length > 0) findings.push(`HIGH: ${label} 被宿主校验拒绝：${violations.join('; ')}`)
  return row
}

const line = (row) =>
  `  ok=${String(row.ok).padEnd(6)} added=${JSON.stringify(row.added)} updated=${JSON.stringify(row.updated)} `
  + `rejected=${JSON.stringify(row.rejected)} lossless=${row.lossless} null=${row.nullKeys} 覆盖=${JSON.stringify(row.overwritten)}`
  + (row.error ? ` error=${row.error}` : '')

console.log(`部署位置：${ENTRY}`)
console.log(`宿主机校验器：${validate ? 'validateJsonSchemaValue 可用' : '不可用（无法做 D 项）'}`)
console.log(`原始列表条数（部署位置）：${PLANETS.length}`)

// ---------------------------------------------------------------------------
// B. 重名与覆写防线
// ---------------------------------------------------------------------------
console.log('\n=== B. 重名 / 覆写防线（进 added 还是 rejected？ok 真假？是 lossless JSON 吗？有没有覆写原始描述？）===')

const cases = [
  ['B1 全角空格写原始名', [{ name: '螺丝星\u3000', description: '全角空格尾随' }]],
  ['B2 多余空格写原始名', [{ name: '  螺丝星  ', description: '前后空格' }]],
  ['B3 ASCII 大小写改写', [{ name: 'ARIVANTA', description: '大写 ASCII 变体' }]],
  ['B4 全角空格夹在名字中间', [{ name: '螺丝\u3000星', description: '中间全角空格' }]],
  ['B5 江户星/江户城（无空格）', [{ name: '江户星/江户城', description: '无空格写法' }]],
  ['B6 江户星（前缀）', [{ name: '江户星', description: '前缀写法' }]],
  ['B7 江户星 / 江户城（原文写法）', [{ name: '江户星 / 江户城', description: '原文写法' }]],
  ['B8 空 name', [{ name: '', description: '空名字' }]],
  ['B9 name 只有空白', [{ name: '   ', description: '纯空白名字' }]],
  ['B10 超长 name（200 字）', [{ name: '长'.repeat(200), description: '超长名字' }]],
  ['B11 超长 description（2000 字）', [{ name: '复核超长描述星', description: '描'.repeat(2000) }]],
  ['B12 缺 description', [{ name: '复核无描述星' }]],
  ['B13 planets 混入非对象', [{ name: '复核正常星', description: '正常' }, 'not-an-object', 42, null, []]],
  ['B14 planets 全是非对象', [null, undefined, 7, 'x']],
  ['B15 一次调用同名两次', [{ name: '复核重复星', description: '第一版' }, { name: '复核重复星', description: '第二版' }]],
  ['B16 一次调用全是被拒的原始名', [{ name: '螺丝星' }, { name: '湛蓝星' }]],
  ['B17 planets 不是数组（字符串）', '洛珂萨'],
  ['B18 planets 为空数组', []],
  ['B19 planets 缺失', undefined],
  ['B20 螺丝星 + 正常星各一', [{ name: '螺丝星', description: '撞名' }, { name: '复核混装星', description: '正常' }]],
]

for (const [label, planets] of cases) {
  const row = await saveCase(label, planets)
  console.log(`${label}\n${line(row)}`)
}

// 覆写专测：先写入一颗新星球，再用各种写法试图「更新」成原始名
{
  const row = await saveCase('B21 先并入新星球，再试图用原始名覆写', [{ name: '螺丝星', description: '试图覆写原始描述' }], {
    seed: [{ name: '复核暂存星', description: '先垫一条增量' }],
  })
  console.log(`B21 先并入新星球，再试图用原始名覆写\n${line(row)}`)
}

// 增量内部更新（同名更新描述）
{
  freshState()
  const first = await tool('gs_planet_save').execute({ planets: [{ name: '复核更新星', description: '第一版描述' }] }, {})
  const second = await tool('gs_planet_save').execute({ planets: [{ name: '复核更新星', description: '第二版描述' }] }, {})
  const raw = JSON.parse(readFileSync(listFile(MODULE_WS), 'utf8'))
  const entry = raw.added.find((a) => a.name === '复核更新星')
  const row = {
    label: 'B22 增量同名更新（应进 updated 而非 added）',
    ok: second.ok,
    added: second.added.map((p) => p.name),
    updated: second.updated.map((p) => p.name),
    rejected: second.rejected.map((r) => r.name),
    error: '',
    lossless: isLossless(second),
    nullKeys: hasNull(second),
    schemaViolations: validate(tool('gs_planet_save').output.schema, second, 'value'),
    overwritten: overwrittenNames(MODULE_WS),
    file: fileFacts(listFile(MODULE_WS)),
  }
  results.push(row)
  console.log(`${row.label}\n${line(row)}\n  文件里该条描述=${JSON.stringify(entry?.description)} 第一次 added=${JSON.stringify(first.added.map((p) => p.name))}`)
  if (entry?.description !== '第二版描述') findings.push('MEDIUM: 增量同名更新没有写进新描述')
}

// 上限：MAX_ADDED = 200
{
  freshState()
  const twoHundred = Array.from({ length: 200 }, (_, i) => ({ name: `复核批量星${i}`, description: `第${i}颗` }))
  const okFill = await tool('gs_planet_save').execute({ planets: twoHundred.slice(0, 20) }, {})
  const batches = []
  for (let i = 20; i < 200; i += 20) {
    batches.push(await tool('gs_planet_save').execute({ planets: twoHundred.slice(i, i + 20) }, {}))
  }
  const overflow = await tool('gs_planet_save').execute({ planets: [{ name: '复核溢出星' }] }, {})
  const raw = JSON.parse(readFileSync(listFile(MODULE_WS), 'utf8'))
  console.log('\nB23 上限测试（MAX_ADDED=200）')
  console.log(`  首20条 ok=${okFill.ok} addedCount=${okFill.addedCount}；后续9批 ok=${batches.map((b) => b.ok).join(',')}`)
  console.log(`  第201条：ok=${overflow.ok} error=${JSON.stringify(overflow.error)} addedCount=${overflow.addedCount} 文件 added.length=${raw.added.length}`)
  console.log(`  第201条 lossless=${isLossless(overflow)} schemaViolations=${JSON.stringify(validate(tool('gs_planet_save').output.schema, overflow, 'value'))}`)
  if (raw.added.length !== 200) findings.push(`HIGH: 增量上限未生效，文件 added.length=${raw.added.length}`)
  if (overflow.ok !== false) findings.push(`MEDIUM: 超上限时 ok 仍为 ${overflow.ok}（模型会以为写入成功）`)
}

// 批次上限 MAX_BATCH = 20
{
  freshState()
  const twentyFive = Array.from({ length: 25 }, (_, i) => ({ name: `复核批次星${i}`, description: `第${i}颗` }))
  const value = await tool('gs_planet_save').execute({ planets: twentyFive }, {})
  const raw = JSON.parse(readFileSync(listFile(MODULE_WS), 'utf8'))
  const batchViolations = validate(tool('gs_planet_save').output.schema, value, 'value')
  console.log('\nB24 单次 25 条（MAX_BATCH=20）')
  console.log(`  ok=${value.ok} added=${value.added.length} updated=${value.updated.length} addedCount=${value.addedCount} 文件 added.length=${raw.added.length}`)
  console.log(`  warnings=${JSON.stringify(value.warnings)}`)
  console.log(`  lossless=${isLossless(value)} schemaViolations=${JSON.stringify(batchViolations)}`)
  if (batchViolations.length > 0) findings.push(`HIGH: B24 返回值被宿主校验拒绝：${batchViolations.join('; ')}`)
  if (raw.added.length !== 20) {
    findings.push(`MEDIUM: MAX_BATCH=20 未生效：一次 25 条实际落盘 ${raw.added.length} 条；warnings=${JSON.stringify(value.warnings)}`)
  }
  const nameSet = new Set(value.added.map((p) => p.name))
  const missing = twentyFive.map((p) => p.name).filter((n) => !nameSet.has(n) && !raw.added.some((a) => a.name === n))
  console.log(`  未出现在返回值也不在文件里的候选：${JSON.stringify(missing)}`)
  if (missing.length > 0) findings.push(`MEDIUM: B24 有 ${missing.length} 条候选既不在 added 也不在文件里（静默丢弃）`)
}

// ---------------------------------------------------------------------------
// C. 重置防线
// ---------------------------------------------------------------------------
console.log('\n=== C. gs_planet_reset 确认防线 ===')
{
  freshState()
  const seeded = await tool('gs_planet_save').execute({ planets: [{ name: '复核重置星A' }, { name: '复核重置星B' }] }, {})
  if (seeded.ok !== true) throw new Error(`C 段铺垫失败：${JSON.stringify(seeded).slice(0, 200)}`)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const before = fileFacts(listFile(MODULE_WS))
  const beforeRaw = JSON.parse(readFileSync(listFile(MODULE_WS), 'utf8'))
  console.log(`  重置前：bytes=${before.bytes} mtime=${before.mtimeMs} sha=${before.sha} added=${beforeRaw.added.length} baseline=${beforeRaw.baseline.length}`)

  const guarded = await tool('gs_planet_reset').execute({}, {})
  await new Promise((resolve) => setTimeout(resolve, 25))
  const after = fileFacts(listFile(MODULE_WS))
  const afterRaw = JSON.parse(readFileSync(listFile(MODULE_WS), 'utf8'))
  console.log(`  gs_planet_reset({}) → ok=${guarded.ok} reset=${guarded.reset} removed=${guarded.removed} message=${JSON.stringify(guarded.message)}`)
  console.log(`  重置后：bytes=${after.bytes} mtime=${after.mtimeMs} sha=${after.sha} added=${afterRaw.added.length}`)
  const unchanged = before.bytes === after.bytes && before.mtimeMs === after.mtimeMs && before.sha === after.sha
  console.log(`  文件未变（bytes && mtime && sha 三者全等）=${unchanged}`)
  if (!unchanged) findings.push('BLOCKER: 不带 confirm 的 gs_planet_reset 改动了文件')

  const explicitFalse = await tool('gs_planet_reset').execute({ confirm: false }, {})
  await new Promise((resolve) => setTimeout(resolve, 25))
  const afterFalse = fileFacts(listFile(MODULE_WS))
  console.log(`  gs_planet_reset({confirm:false}) → reset=${explicitFalse.reset}；文件未变=${afterFalse.sha === before.sha && afterFalse.mtimeMs === before.mtimeMs}`)
  if (!(afterFalse.sha === before.sha && afterFalse.mtimeMs === before.mtimeMs)) findings.push('BLOCKER: confirm:false 改动了文件')

  const done = await tool('gs_planet_reset').execute({ confirm: true }, {})
  const cleared = JSON.parse(readFileSync(listFile(MODULE_WS), 'utf8'))
  console.log(`  gs_planet_reset({confirm:true}) → ok=${done.ok} reset=${done.reset} removed=${done.removed} total=${done.total} bytes=${done.bytes}`)
  console.log(`  文件：added.length=${cleared.added.length} baseline.length=${cleared.baseline.length} schema=${cleared.schema}`)
  if (cleared.added.length !== 0) findings.push('BLOCKER: confirm:true 之后 added 未清空')
  if (cleared.baseline.length !== 27) findings.push('BLOCKER: confirm:true 之后 baseline 不是 27 条')
  if (done.removed !== 2) findings.push(`MEDIUM: removed=${done.removed}（期望 2）`)
  const violations = validate(tool('gs_planet_reset').output.schema, done, 'value')
  console.log(`  宿主校验 violations=${JSON.stringify(violations)} lossless=${isLossless(done)}`)
  if (violations.length > 0) findings.push(`HIGH: reset 返回值被宿主拒绝：${violations.join('; ')}`)
  const reread = await tool('gs_planets').execute({}, {})
  console.log(`  重置后 gs_planets：baselineCount=${reread.baselineCount} addedCount=${reread.addedCount} total=${reread.total}`)
  if (reread.addedCount !== 0) findings.push('BLOCKER: 重置后 gs_planets 仍报出增量')

  const again = await tool('gs_planet_reset').execute({ confirm: true }, {})
  console.log(`  再次 confirm:true → reset=${again.reset} removed=${again.removed}（幂等）`)
  if (again.removed !== 0) findings.push('LOW: 二次重置 removed 不为 0')
}

// 重置一个不存在文件的目录（created 分支）
{
  freshState()
  const done = await tool('gs_planet_reset').execute({ confirm: true }, {})
  const facts = fileFacts(listFile(MODULE_WS))
  console.log(`\nC2 目录里没有 planet-list.json 时 confirm:true → ok=${done.ok} created=${done.created} removed=${done.removed} total=${done.total}`)
  console.log(`  文件已创建=${facts.exists} bytes=${facts.bytes}`)
  const violations = validate(tool('gs_planet_reset').output.schema, done, 'value')
  if (violations.length > 0) findings.push(`HIGH: C2 返回值被宿主拒绝：${violations.join('; ')}`)
  if (done.created !== true) findings.push('LOW: 文件原本不存在时 created 不为 true')
}

// ---------------------------------------------------------------------------
// D. 宿主校验器：边界路径
// ---------------------------------------------------------------------------
console.log('\n=== D. 宿主校验器：边界路径（含嵌套 undefined / null）===')
{
  freshState()
  const run = async (label, toolName, value) => {
    const violations = validate(tool(toolName).output.schema, value, 'value')
    const row = { label, toolName, violations, lossless: isLossless(value), nullKeys: hasNull(value) }
    console.log(`  ${label}: violations=${JSON.stringify(violations)} lossless=${row.lossless} nullKeys=${row.nullKeys}`)
    if (violations.length > 0) findings.push(`HIGH: D 项 ${label} 被宿主校验拒绝：${violations.join('; ')}`)
    if (row.lossless === false) findings.push(`HIGH: D 项 ${label} 不是 lossless JSON`)
    if (row.nullKeys) findings.push(`HIGH: D 项 ${label} 含 null 值`)
    return row
  }

  const allRejected = await tool('gs_planet_save').execute({ planets: [{ name: '螺丝星' }] }, {})
  await run('D1 gs_planet_save 全被拒绝', 'gs_planet_save', allRejected)
  console.log(`     error=${JSON.stringify(allRejected.error)} render=${JSON.stringify(tool('gs_planet_save').output.render({}, allRejected)[0].text.slice(0, 80))}`)

  const empty = await tool('gs_planet_save').execute({ planets: [] }, {})
  await run('D2 gs_planet_save planets=[]', 'gs_planet_save', empty)

  const restore = mod.__internals.stubSubmodules({ planets: null })
  try {
    const degraded = await tool('gs_planets').execute({}, {})
    await run('D3 gs_planets 子模块缺失', 'gs_planets', degraded)
    console.log(`     ok=${degraded.ok} baselineCount=${degraded.baselineCount} matched=${degraded.matched} warnings=${JSON.stringify(degraded.warnings)}`)
    const degradedSave = await tool('gs_planet_save').execute({ planets: [{ name: '退化星' }] }, {})
    await run('D4 gs_planet_save 子模块缺失', 'gs_planet_save', degradedSave)
    const degradedReset = await tool('gs_planet_reset').execute({}, {})
    await run('D5 gs_planet_reset 子模块缺失（无 confirm）', 'gs_planet_reset', degradedReset)
    const degradedResetConfirm = await tool('gs_planet_reset').execute({ confirm: true }, {})
    await run('D6 gs_planet_reset 子模块缺失（confirm:true）', 'gs_planet_reset', degradedResetConfirm)
    const degradedSetup = await tool('gs_setup').execute({}, {})
    await run('D7 gs_setup 子模块缺失', 'gs_setup', degradedSetup)
    console.log(`     gs_setup.planets=${JSON.stringify(degradedSetup.planets)}`)
  } finally {
    restore()
  }

  const zero = await tool('gs_planets').execute({ query: '绝对不存在的星球名' }, {})
  await run('D8 gs_planets 命中 0 条', 'gs_planets', zero)
  const zeroText = tool('gs_planets').output.render({ query: '绝对不存在的星球名' }, zero)[0].text
  console.log(`     命中 0 条：matched=${zero.matched} planets=${JSON.stringify(zero.planets)} render 长度=${zeroText.length} 含 guidance=${zeroText.includes('星球制造机流程')}`)

  const saveCheck = await tool('gs_planet_save').execute({ planets: [{ name: '复核渲染星' }] }, {})
  const afterSave = await tool('gs_planets').execute({}, {})
  await run('D9 gs_planets 并入「缺 description」后', 'gs_planets', afterSave)
  const afterText = tool('gs_planets').output.render({}, afterSave)[0].text
  const addedRow = afterSave.planets.find((p) => p.name === '复核渲染星')
  console.log(`     新增条目=${JSON.stringify(addedRow)} render 含该名字=${afterText.includes('复核渲染星')} saveCheck.ok=${saveCheck.ok}`)
  if (!addedRow) findings.push('MEDIUM: D9 并入的星球没出现在 gs_planets 里')

  const ws4 = newWs()
  mkdirSync(join(ws4, 'hsr-worldview-cache'), { recursive: true })
  writeFileSync(join(ws4, 'hsr-worldview-cache', 'planet-list.json'), '{ this is not json', 'utf8')
  const viaInternals = mod.__internals.listPlanets(ws4)
  console.log(`  D10 损坏 planet-list.json：listPlanets → ok=${viaInternals.ok} baselineCount=${viaInternals.baselineCount} addedCount=${viaInternals.addedCount} warnings=${JSON.stringify(viaInternals.warnings)}`)
  if (viaInternals.baselineCount !== 27) findings.push('HIGH: 损坏文件时未退回 27 颗原始列表')

  const ws5 = newWs()
  mkdirSync(join(ws5, 'hsr-worldview-cache'), { recursive: true })
  writeFileSync(join(ws5, 'hsr-worldview-cache', 'planet-list.json'), '42', 'utf8')
  const scalar = mod.__internals.listPlanets(ws5)
  console.log(`  D11 顶层是标量 42：ok=${scalar.ok} baselineCount=${scalar.baselineCount} warnings=${JSON.stringify(scalar.warnings)}`)
  if (scalar.baselineCount !== 27) findings.push('HIGH: 顶层标量时未退回 27 颗原始列表')

  const ws6 = newWs()
  mkdirSync(join(ws6, 'hsr-worldview-cache'), { recursive: true })
  writeFileSync(join(ws6, 'hsr-worldview-cache', 'planet-list.json'), JSON.stringify({ added: 'not-an-array' }), 'utf8')
  const badAdded = mod.__internals.listPlanets(ws6)
  console.log(`  D12 added 不是数组：ok=${badAdded.ok} addedCount=${badAdded.addedCount} warnings=${JSON.stringify(badAdded.warnings)}`)
  if (badAdded.addedCount !== 0) findings.push('HIGH: added 不是数组时没有按空列表处理')

  const ws7 = newWs()
  mkdirSync(join(ws7, 'hsr-worldview-cache'), { recursive: true })
  writeFileSync(join(ws7, 'hsr-worldview-cache', 'planet-list.json'), JSON.stringify({ added: [{ name: '螺丝星', description: '文件里试图覆写' }, null, { name: '' }, { name: '合法星', description: 'ok' }] }), 'utf8')
  const mixed = mod.__internals.listPlanets(ws7)
  console.log(`  D13 文件里混入撞名/null/空名：addedCount=${mixed.addedCount} added=${JSON.stringify(mixed.planets.filter((p) => p.origin === 'added').map((p) => p.name))} warnings=${JSON.stringify(mixed.warnings)}`)
  if (mixed.planets.some((p) => p.origin === 'added' && p.name === '螺丝星')) findings.push('BLOCKER: 直接改文件可以绕过「原始列表优先」写入撞名条目')
  const afterRead = JSON.parse(readFileSync(join(ws7, 'hsr-worldview-cache', 'planet-list.json'), 'utf8'))
  console.log(`     读完之后文件里的 added.length=${afterRead.added.length}（读取不应改写文件）`)
}

// ---------------------------------------------------------------------------
// F. 名字容错判定
// ---------------------------------------------------------------------------
console.log('\n=== F. 名字容错判定（独立构造）===')
{
  const probes = [
    ['F1 螺丝星二号（不得当作 螺丝星）', { name: '螺丝星二号', description: '前缀陷阱' }, 'added'],
    ['F2 江户星（不得当作 江户星 / 江户城）', { name: '江户星', description: '前缀陷阱' }, 'added'],
    ['F3 江户星 / 江户城（原文写法，必须被拒）', { name: '江户星 / 江户城', description: '原文撞名' }, 'rejected'],
    ['F4 江户星/江户城（无空格，必须被拒）', { name: '江户星/江户城', description: '容错撞名' }, 'rejected'],
    ['F5 螺丝星（必须被拒）', { name: '螺丝星', description: '精确撞名' }, 'rejected'],
  ]
  for (const [label, entry, expect] of probes) {
    freshState()
    const value = await tool('gs_planet_save').execute({ planets: [entry] }, {})
    const landed = value.added.map((p) => p.name)
    const rejected = value.rejected.map((r) => r.name)
    const actual = landed.length > 0 ? 'added' : 'rejected'
    const verdict = actual === expect ? 'OK' : 'MISMATCH'
    console.log(`  ${label}: 期望=${expect} 实际=${actual} ${verdict}（added=${JSON.stringify(landed)} rejected=${JSON.stringify(rejected)}）`)
    if (verdict === 'MISMATCH') findings.push(`HIGH: F 项 ${label} 期望 ${expect} 实际 ${actual}`)
  }
  // 独立实现一遍同义判定规则（与 lib/planets.mjs 的 normName/sameName 同规则）
  const same = (a, b) => {
    const n = (s) => String(s ?? '').trim().replace(/[ \t\u3000]+/g, ' ').toLowerCase()
    const l = n(a)
    const r = n(b)
    if (l.length === 0 || r.length === 0) return false
    return l === r || l.replace(/ /g, '') === r.replace(/ /g, '')
  }
  const matrix = [
    ['江户星 / 江户城', '江户星 / 江户城', true],
    ['江户星 / 江户城', '江户星/江户城', true],
    ['江户星 / 江户城', '江户星', false],
    ['螺丝星', '螺丝星二号', false],
    ['螺丝星二号', '螺丝星', false],
    ['  螺丝星  ', '螺丝星', true],
    ['螺丝星', '螺丝星\u3000', true],
    ['螺丝星', '', false],
  ]
  for (const [a, b, expect] of matrix) {
    const got = same(a, b)
    console.log(`  独立判定 sameName(${JSON.stringify(a)}, ${JSON.stringify(b)}) 期望=${expect} 实际=${got} ${got === expect ? 'OK' : 'MISMATCH'}`)
    if (got !== expect) findings.push(`HIGH: F 项 sameName 判定不符：${a} vs ${b} 期望 ${expect} 实际 ${got}`)
  }
  const { isBaselineName } = await import(pathToFileURL(join(DEPLOY, 'lib', 'planets.mjs')).href)
  // 注意：lib/planets.mjs 在复核过程中被改动过 —— isBaselineName 现在**同时**比对中文名与
  // 英文名（不区分大小写）。下面这组探针是新口径下的攻击面（ASCII 英文名是否被当作重名）。
  const enProbes = [
    ['arivanta', true],
    ['ARIVANTA', true],
    ['Arivanta ', true],
    ['  arivanta  ', true],
    ['EDOSTAR', false],
    ['Edo Star', true],
    ['edo star', true],
    ['Edo  Star', false],
    ['edo', false],
    ['star', false],
    ['Lushaka', true],
    ['Toste-VIII', true],
    ['toste-viii', true],
    ['Toste-viii', true],
    ['Sunburst-XIII', true],
    ['sunburst-xiii', true],
    ['', false],
  ]
  for (const [name, expect] of enProbes) {
    const got = isBaselineName(name)
    console.log(`  被测 isBaselineName(${JSON.stringify(name)}) = ${got}（期望 ${expect}）${got === expect ? 'OK' : 'MISMATCH'}`)
    if (got !== expect) findings.push(`F 项 isBaselineName(${JSON.stringify(name)}) 期望 ${expect} 实际 ${got}`)
  }
  // 通过工具入口再验一遍两道防线在新口径下是否仍然有效
  freshState()
  const enSave = await tool('gs_planet_save').execute({ planets: [{ name: 'arivanta', description: '英文名撞名' }] }, {})
  console.log(`  工具入口 gs_planet_save({name:'arivanta'}) → ok=${enSave.ok} added=${JSON.stringify(enSave.added.map((p) => p.name))} rejected=${JSON.stringify(enSave.rejected.map((r) => r.name))}`)
  if (enSave.added.length > 0) findings.push("HIGH: 工具入口仍可写入 name:'arivanta'（原始列表阿丽万塔的英文名）")
  freshState()
  const enSave2 = await tool('gs_planet_save').execute({ planets: [{ name: '洛珂萨', en: 'Arivanta', description: '用 en 字段撞名' }] }, {})
  console.log(`  工具入口 gs_planet_save({name:'洛珂萨', en:'Arivanta'}) → ok=${enSave2.ok} added=${JSON.stringify(enSave2.added.map((p) => p.name))} rejected=${JSON.stringify(enSave2.rejected.map((r) => r.name))}`)
  if (enSave2.added.length > 0) findings.push("MEDIUM: en 字段写成原始英文名时不被视为重名（name 是新的，描述可自称是同一颗）")
}

console.log('\n=== 汇总 ===')
console.log(`用例数：${results.length}`)
console.log(`findings：${findings.length}`)
for (const f of findings) console.log(`  - ${f}`)
if (findings.length === 0) console.log('  （无）')

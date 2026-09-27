/**
 * 0.3.0 星球制造机 —— 从**部署位置**驱动的端到端接线取证。
 *
 * 与前几个 _evidence 脚本的分工：
 *   - `test/planets.test.mjs` 从**源码目录** import，证明契约；
 *   - 本脚本从 `~/.dsh/profiles/web/node_modules/dsh-history-fictionologists`
 *     （即 DSH 实际加载的那个 junction 目标）import，证明「装上去的那份」确实带这三个能力，
 *     并在一个临时工作区里把「生成→并入→重置」按用户要求的顺序整条走完。
 *
 * 不需要网络，也不会碰用户自己的工作区（workspace 是 mkdtemp）。
 *
 * 用法：node _evidence/planet-tools-deploy.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = process.env.USERPROFILE || process.env.HOME
const DEPLOY = join(HOME, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-history-fictionologists')
const ENTRY = join(DEPLOY, 'lib', 'shell.js')

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

const toolOf = (record, name) => {
  const tool = record.tools.find((t) => t.name === name)
  assert.ok(tool, `tool ${name} 未注册`)
  return tool
}

function assertLossless(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: 返回值不是 lossless JSON`)
}

console.log(`部署位置：${ENTRY}`)
assert.ok(existsSync(ENTRY), `部署位置不存在：${ENTRY}（profile 里没有装本插件？）`)

const ws = mkdtempSync(join(tmpdir(), 'hsf-deploy-'))
console.log(`临时工作区：${ws}`)

const mod = await import(pathToFileURL(ENTRY).href)
const { ctx, record } = makeCtx()
mod.apply(ctx, { workspace: ws })
console.log(`注册的工具：${record.tools.map((t) => t.name).join(', ')}`)
console.log(`注册的命令：${record.commands.map((c) => c.name).join(', ')}`)
console.log(`系统提示段落：${record.sections.length}（order=${record.sections[0]?.order}）`)
for (const name of ['gs_planets', 'gs_planet_save', 'gs_planet_reset']) {
  assert.ok(record.tools.some((t) => t.name === name), `${name} 未注册`)
}

// ---- 1. gs_setup 报告星球列表状态 ---------------------------------------
{
  const value = await toolOf(record, 'gs_setup').execute({}, {})
  assertLossless(value, 'gs_setup')
  console.log(`\n[1] gs_setup.planets = ${JSON.stringify(value.planets)}`)
  assert.equal(value.planets.baselineCount, 27)
  assert.equal(value.planets.addedCount, 0)
  assert.equal(value.planets.exists, false)
}

// ---- 2. gs_planets 返回参考底本 -----------------------------------------
{
  const value = await toolOf(record, 'gs_planets').execute({}, {})
  assertLossless(value, 'gs_planets')
  console.log(`\n[2] gs_planets: ok=${value.ok} 原始=${value.baselineCount} 已并入=${value.addedCount} 返回=${value.matched}`)
  console.log(`    前三条：${value.planets.slice(0, 3).map((p) => `${p.name}(${p.source})`).join(' / ')}`)
  console.log(`    已毁的：${value.planets.filter((p) => p.source === 'ruined').map((p) => p.name).join('、')}`)
  console.log(`    render 前 160 字：${toolOf(record, 'gs_planets').output.render({}, value)[0].text.slice(0, 160).replace(/\n/g, ' ⏎ ')}`)
  assert.equal(value.total, 27)
}

// ---- 3. 模拟功能 4：生成 → 询问①「加入」→ gs_planet_save ----------------
{
  const generated = [
    { name: '洛珂萨', en: 'Loxa', description: '信用点失效后改用「记忆」当通货的当铺星。', source: 'mentioned' },
    { name: '图恩加', en: 'Tunga', description: '厄兆先锋建在银河边缘的守望要塞，全民四班倒。', source: 'mentioned' },
    { name: '螺丝星', description: '故意与原始列表重名，应当被拒绝。' },
  ]
  const value = await toolOf(record, 'gs_planet_save').execute({ planets: generated }, {})
  assertLossless(value, 'gs_planet_save')
  console.log(`\n[3] gs_planet_save: ok=${value.ok} 新并入=${JSON.stringify(value.added.map((p) => p.name))}`)
  console.log(`    拒绝=${JSON.stringify(value.rejected)}`)
  console.log(`    现有：原始 ${value.baselineCount} + 新增 ${value.addedCount} = ${value.total}（写盘 ${value.bytes} 字节）`)
  assert.deepEqual(value.added.map((p) => p.name), ['洛珂萨', '图恩加'])
  assert.deepEqual(value.rejected.map((r) => r.name), ['螺丝星'])
}

// ---- 4. 落盘文件真的在，且能被再读回来 ----------------------------------
{
  const file = join(ws, 'hsr-worldview-cache', 'planet-list.json')
  assert.ok(existsSync(file), 'planet-list.json 未写盘')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  console.log(`\n[4] 落盘：${file}`)
  console.log(`    schema=${raw.schema} baseline=${raw.baseline.length} added=${raw.added.length}`)
  assert.equal(raw.baseline.length, 27)
  assert.equal(raw.added.length, 2)

  const again = await toolOf(record, 'gs_planets').execute({ source: 'mentioned' }, {})
  console.log(`    gs_planets(source=mentioned)：返回 ${again.matched} 条，含新增 ${again.planets.filter((p) => p.origin === 'added').map((p) => p.name).join('、')}`)
  assert.equal(again.total, 29)
}

// ---- 5. 模拟询问②：先不带 confirm（必须什么都不做），再带 confirm 重置 ---
{
  const guarded = await toolOf(record, 'gs_planet_reset').execute({}, {})
  assertLossless(guarded, 'gs_planet_reset(guarded)')
  console.log(`\n[5] gs_planet_reset(无 confirm): reset=${guarded.reset} 已并入仍为 ${guarded.total - guarded.baselineCount}`)
  assert.equal(guarded.reset, false)

  const afterGuard = await toolOf(record, 'gs_planets').execute({}, {})
  assert.equal(afterGuard.addedCount, 2, '无 confirm 时不得改动文件')

  const done = await toolOf(record, 'gs_planet_reset').execute({ confirm: true }, {})
  assertLossless(done, 'gs_planet_reset(confirm)')
  console.log(`    gs_planet_reset(confirm=true): reset=${done.reset} 清除=${done.removed} 现有=${done.total}`)
  assert.equal(done.reset, true)
  assert.equal(done.removed, 2)
  assert.equal(done.total, 27)

  const after = await toolOf(record, 'gs_planets').execute({}, {})
  assert.equal(after.addedCount, 0, '重置后必须回到纯原始列表')
  console.log(`    重置后：原始=${after.baselineCount} 已并入=${after.addedCount}`)
}

// ---- 6. /gs 协议文本（模型实际会收到的那份） ----------------------------
{
  const followed = []
  const result = await mod.__internals.runGsCommand(
    {
      commandId: 'evidence-planets',
      rawInput: '',
      attachments: [],
      signal: AbortSignal.timeout(20_000),
      agent: { followup: (message) => followed.push(message) },
    },
    {
      cfg: { ...mod.__internals.DEFAULTS, workspace: ws },
      workspace: () => ws,
      logger: { warn: () => {}, info: () => {} },
      createUserMessage: (input) => ({ kind: 'user-message', ...input }),
    },
  )
  assert.equal(result.kind, 'success')
  const text = followed[0].content[0].text
  const wanted = ['4) 星球制造机', '· 功能 4：先 gs_planets', '① 生成结束后用 ask_user_question 问', '② 紧接着再问一次', 'gs_planet_reset(confirm=true)']
  console.log('\n[6] /gs 协议文本关键行：')
  for (const needle of wanted) {
    console.log(`    ${text.includes(needle) ? 'YES' : 'NO '} ${needle}`)
    assert.ok(text.includes(needle), `协议文本缺少：${needle}`)
  }
  console.log(`    协议文本长度：${text.length} 字符；系统提示 STYLE_GUIDE：${mod.__internals.STYLE_GUIDE.length} 字符`)
}

console.log('\nALL PLANET DEPLOY CHECKS PASSED')
rmSync(ws, { recursive: true, force: true })

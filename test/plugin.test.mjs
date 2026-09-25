/**
 * Plugin-shell contract tests: a mock Cordis context that records every
 * registration, plus behavioural checks on the /gs handler and each tool.
 *
 * These run WITHOUT the host (no DSH process) and WITHOUT the network, so they
 * are the fastest signal that the plugin contract itself is intact.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')

/** Minimal Cordis context double: effect() runs immediately and hands back a disposer. */
function makeCtx() {
  const record = {
    effects: [],
    sections: [],
    tools: [],
    commands: [],
    logs: [],
    disposers: [],
  }
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
      const dispose = callback()
      record.disposers.push(dispose)
      return dispose
    },
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    systemPrompt: {
      section(section) {
        record.sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        record.tools.push(tool)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        record.commands.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, record }
}

async function loadPlugin() {
  // On Windows a bare absolute path is rejected by the ESM loader: use a file URL.
  // The shell lives at lib/shell.js (package.json `main`); see that file's header.
  return import(pathToFileURL(join(ROOT, 'lib', 'shell.js')).href)
}

/** The host requires lossless JSON: JSON round-trip must be deep-equal. */
function assertLossless(value, label) {
  const round = JSON.parse(JSON.stringify(value))
  assert.deepEqual(round, value, `${label}: 返回值含 undefined/不可序列化内容`)
}

test('plugin module exposes the required contract', async () => {
  const mod = await loadPlugin()
  assert.equal(mod.name, 'dsh-history-fictionologists')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组')
  for (const service of ['commands', 'tools', 'systemPrompt']) {
    assert.ok(mod.inject.includes(service), `inject 缺少 ${service}`)
  }
  assert.equal(typeof mod.apply, 'function')
  // Config must be a Schemastery schema or undefined — never a plain object.
  if (mod.Config !== undefined) {
    assert.equal(typeof mod.Config['~standard']?.validate, 'function', 'Config 不是标准 schema（会导致整棵插件树崩）')
  }
})

test('apply registers /gs, six tools and one prompt section', async () => {
  const mod = await loadPlugin()
  const { ctx, record } = makeCtx()
  await mod.apply(ctx, { workspace: mkdtempSync(join(tmpdir(), 'hsf-ws-')) })

  assert.equal(record.commands.length, 1, '应当只注册一个命令')
  const cmd = record.commands[0]
  assert.equal(cmd.name, 'gs')
  assert.equal(typeof cmd.handler, 'function')
  assert.equal(typeof cmd.description, 'string')
  assert.ok(cmd.description.length > 0)
  assert.ok(cmd.input === undefined || typeof cmd.input.hint === 'string')

  const names = record.tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['gs_digest', 'gs_missions', 'gs_read', 'gs_save', 'gs_setup', 'gs_update'])

  assert.equal(record.sections.length, 1)
  const section = record.sections[0]
  assert.equal(section.name, 'plugin:history-fictionologists:style')
  assert.ok(Number.isFinite(section.order))
  assert.equal(section.interpolate, false, '风格文本含 {{ }} 风险，必须关闭插值')
  assert.match(section.text, /方程一览/)
  assert.match(section.text, /本次播报到此结束/)
  assert.match(section.text, /星神不出场/, '系统提示段落必须带上星神纪律')

  // every registered tool must carry a描述 and a well-formed output schema
  for (const tool of record.tools) {
    assert.ok(typeof tool.description === 'string' && tool.description.length > 10, `${tool.name} 缺 description`)
    assert.ok(tool.output && typeof tool.output.schema === 'object', `${tool.name} 缺 output.schema`)
    assert.ok(tool.output.schema.additionalProperties !== undefined, `${tool.name} 的 output.schema 必须显式 additionalProperties`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} 缺 execute`)
  }
})

test('gs_setup reports a usable state before any cache exists', async () => {
  const mod = await loadPlugin()
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-empty-'))
  const { ctx, record } = makeCtx()
  await mod.apply(ctx, { workspace })
  const tool = record.tools.find((t) => t.name === 'gs_setup')
  const value = await tool.execute({}, { signal: AbortSignal.timeout(20_000) })
  assertLossless(value, 'gs_setup')
  assert.equal(value.ok, true)
  assert.equal(value.hasCache, false)
  assert.equal(value.recommendation, 'update')
  assert.ok(value.cacheDir.startsWith(workspace))
  assert.ok(Array.isArray(value.warnings))
  rmSync(workspace, { recursive: true, force: true })
})

test('gs_read degrades cleanly with no cache', async () => {
  const mod = await loadPlugin()
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-noc-'))
  const { ctx, record } = makeCtx()
  await mod.apply(ctx, { workspace })
  const tool = record.tools.find((t) => t.name === 'gs_read')
  const value = await tool.execute({ dataset: 'equations' }, { signal: AbortSignal.timeout(20_000) })
  assertLossless(value, 'gs_read')
  assert.equal(value.dataset, 'equations')
  assert.ok(Array.isArray(value.entries))
  const rendered = tool.output.render({}, value)
  assert.ok(Array.isArray(rendered) && typeof rendered[0].text === 'string')
  rmSync(workspace, { recursive: true, force: true })
})

test('gs_save writes a markdown file, gs_save honours saveOutputs=false', async () => {
  const mod = await loadPlugin()
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-save-'))
  {
    const { ctx, record } = makeCtx()
    await mod.apply(ctx, { workspace })
    const save = record.tools.find((t) => t.name === 'gs_save')
    const value = await save.execute({ kind: 'story', title: '测试/标题:带非法字符', content: '# 正文\n\n内容' }, {})
    assertLossless(value, 'gs_save')
    assert.equal(value.saved, true)
    assert.ok(existsSync(value.path), '落盘文件应存在')
    assert.ok(value.path.includes('hsr-stories'), 'story 应写入 hsr-stories')
    assert.ok(value.bytes > 0)
  }
  {
    const { ctx, record } = makeCtx()
    await mod.apply(ctx, { workspace, saveOutputs: false })
    const save = record.tools.find((t) => t.name === 'gs_save')
    const value = await save.execute({ kind: 'broadcast', title: 'x', content: 'y' }, {})
    assertLossless(value, 'gs_save(disabled)')
    assert.equal(value.saved, false)
  }
  rmSync(workspace, { recursive: true, force: true })
})

test('unknown gs_digest kind is rejected without throwing', async () => {
  const mod = await loadPlugin()
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-dig-'))
  const { ctx, record } = makeCtx()
  await mod.apply(ctx, { workspace })
  const digest = record.tools.find((t) => t.name === 'gs_digest')
  const value = await digest.execute({ kind: 'nope' }, {})
  assertLossless(value, 'gs_digest')
  assert.equal(value.ok, false)
  assert.ok(value.warnings.length > 0)
  rmSync(workspace, { recursive: true, force: true })
})

test('/gs handler hands the three-step protocol to the agent', async () => {
  const mod = await loadPlugin()
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-gs-'))
  const { ctx } = makeCtx()
  await mod.apply(ctx, { workspace })

  const followed = []
  const invocation = {
    commandId: 'test-command',
    rawInput: '  欢愉命途的荒诞点子  ',
    attachments: [],
    signal: AbortSignal.timeout(20_000),
    agent: {
      followup: (message) => followed.push(message),
    },
  }
  const result = await mod.__internals.runGsCommand(invocation, {
    cfg: { ...mod.__internals.DEFAULTS, workspace },
    workspace: () => workspace,
    logger: { warn: () => {}, info: () => {} },
    createUserMessage: (input) => ({ kind: 'user-message', ...input }),
  })

  assert.equal(result.kind, 'success')
  assert.ok(typeof result.text === 'string' && result.text.length > 0)
  assert.equal(followed.length, 1, '协议应通过 agent.followup 交给模型')
  const message = followed[0]
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-history-fictionologists')
  const text = message.content[0].text
  assert.match(text, /第 1 步 · 功能选择/)
  assert.match(text, /第 2 步 · 世界观数据更新策略/)
  assert.match(text, /第 3 步 · 执行所选功能/)
  assert.match(text, /神人制造机/)
  assert.match(text, /构史文集/)
  assert.match(text, /星际构史播报/)
  assert.match(text, /ask_user_question/)
  assert.match(text, /欢愉命途的荒诞点子/)
  assertLossless(result, '/gs result')
  rmSync(workspace, { recursive: true, force: true })
})

test('/gs handler degrades to returning the protocol when followup is unavailable', async () => {
  const mod = await loadPlugin()
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-gs2-'))
  const { ctx } = makeCtx()
  await mod.apply(ctx, { workspace })
  const result = await mod.__internals.runGsCommand(
    { rawInput: '', attachments: [], signal: AbortSignal.timeout(20_000) },
    {
      cfg: { ...mod.__internals.DEFAULTS, workspace },
      workspace: () => workspace,
      logger: { warn: () => {}, info: () => {} },
      createUserMessage: null,
    },
  )
  assert.equal(result.kind, 'success')
  assert.match(result.text, /第 1 步/)
  rmSync(workspace, { recursive: true, force: true })
})

test('lossless helper strips nested undefined', async () => {
  const mod = await loadPlugin()
  const { lossless } = mod.__internals
  const value = lossless({ a: 1, b: undefined, c: { d: undefined, e: [1, undefined, { f: undefined, g: 2 }] } })
  assert.deepEqual(value, { a: 1, c: { e: [1, { g: 2 }] } })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('lossless helper drops non-finite numbers (NaN/Infinity stringify to null)', async () => {
  const mod = await loadPlugin()
  const { lossless } = mod.__internals
  const value = lossless({ age: Number.NaN, big: Number.POSITIVE_INFINITY, small: Number.NEGATIVE_INFINITY, ok: 0 })
  assert.deepEqual(value, { ok: 0 })
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  // the real bug this guards: Math.round(NaN) previously reached a tool result
  assert.deepEqual(JSON.parse(JSON.stringify(lossless({ ageDays: Math.round(Number.NaN) }))), {})
})

/**
 * 星神纪律是用户在评审里明确要求的产品规则：神人制造机写的是「神人自己的事」，
 * 星神不得作为出场角色，已陨/失踪者（贪饕、繁育…）绝不写成在世。
 * 它必须出现在两个模型可见面上：系统提示段落 + /gs 注入的协议文本。
 */
test('星神纪律完整落在风格总则里（四条规则 + 点名已消亡星神）', async () => {
  const mod = await loadPlugin()
  const guide = mod.__internals.STYLE_GUIDE

  assert.match(guide, /### 星神纪律/)
  assert.match(guide, /星神不出场/)
  assert.match(guide, /命途只是标签，不是靠山/)
  assert.match(guide, /已陨\/失踪\/消亡的星神一律不得写成在世/)
  assert.match(guide, /贪饕（奥博洛斯）/, '贪饕必须被点名为不得写成在世')
  assert.match(guide, /繁育（塔伊兹育罗斯）/)
  assert.match(guide, /神人自己才是主角/)
  assert.match(guide, /命途归属只是气质标签/, '格式块后要有一句「星神不出场」的提醒')
})

test('/gs 协议把星神纪律一并交给模型', async () => {
  const mod = await loadPlugin()
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-gs-discipline-'))
  const { ctx } = makeCtx()
  await mod.apply(ctx, { workspace })

  const followed = []
  const result = await mod.__internals.runGsCommand(
    { commandId: 'test-gs-discipline', rawInput: '', attachments: [], signal: AbortSignal.timeout(20_000),
      agent: { followup: (message) => followed.push(message) } },
    {
      cfg: { ...mod.__internals.DEFAULTS, workspace },
      workspace: () => workspace,
      logger: { warn: () => {}, info: () => {} },
      createUserMessage: (input) => ({ kind: 'user-message', ...input }),
    },
  )

  assert.equal(result.kind, 'success')
  assert.equal(followed.length, 1)
  const text = followed[0].content[0].text
  assert.match(text, /星神纪律/)
  assert.match(text, /星神与令使不得作为出场角色/)
  assert.match(text, /命途归属只作气质标签/)
  assert.ok(!/再 gs_read 取星神\//.test(text), '功能 1 不应再把「星神」列为取材主角')
  rmSync(workspace, { recursive: true, force: true })
})

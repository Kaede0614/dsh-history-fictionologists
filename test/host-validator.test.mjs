/**
 * Host-validator conformance tests.
 *
 * The mock-ctx suite proves registration and behaviour, but it CANNOT catch a
 * result that violates `output.schema`: only the host validates that. So these
 * tests call the exact validator the DSH tool registry uses —
 * `validateJsonSchemaValue` from `@deepseek-ai/dsh-tools`, the function behind
 * `createSuccessResult` -> `ToolOutputError`.
 *
 * IMPORTANT: that function returns an ARRAY OF VIOLATION STRINGS
 * (`@returns All violations in walk order; empty means valid`). An earlier version
 * of this file asserted `result.valid !== false`, which is vacuously true for an
 * empty AND a non-empty array — it would have passed with violations present.
 * The assertion is now equality against `[]`, and the meta-test below proves the
 * assertion can actually fail.
 *
 * Regressions guarded here:
 *   - `gs_setup` used to return `lastUpdated: null` / `error: null` while its schema
 *     types those keys as `string` -> every call failed with "returned invalid output"
 *   - non-finite config values used to drop REQUIRED keys (`staleAfterDays`)
 *   - a multi-line title used to inject YAML keys into a saved file's front-matter
 *
 * This file is fully OFFLINE.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { optionalImport } from '../lib/resolve.js'

const ROOT = join(import.meta.dirname, '..')
const SHELL_PATH = join(ROOT, 'lib', 'shell.js')

/** Load the plugin shell plus the host's validator. */
async function harness(config) {
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const { ctx, record } = makeCtx()
  mod.apply(ctx, config)
  const toolsMod = await optionalImport('@deepseek-ai/dsh-tools')
  return { mod, record, validate: toolsMod?.validateJsonSchemaValue ?? null }
}

/**
 * Mock Cordis context whose registrations return REAL unregister functions, so a
 * broken or missing disposer chain is observable (the older mock returned `() => {}`,
 * which made that whole class untestable).
 */
function makeCtx() {
  const record = { tools: [], commands: [], sections: [], live: new Set(), disposers: [] }
  const live = record.live
  const track = (kind, item) => {
    const key = `${kind}:${item?.name ?? kind}`
    live.add(key)
    return () => live.delete(key)
  }
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (cb) => {
      const dispose = cb()
      record.disposers.push(dispose)
      return dispose
    },
    on: () => () => {},
    get: () => undefined,
    systemPrompt: {
      section: (s) => {
        record.sections.push(s)
        return track('section', s)
      },
    },
    tools: {
      register: (t) => {
        record.tools.push(t)
        return track('tool', t)
      },
    },
    commands: {
      register: (c) => {
        record.commands.push(c)
        return track('command', c)
      },
    },
  }
  return { ctx, record }
}

const outputSchemaOf = (tool) => tool.output.schema

/** All violations the host would report for one tool result (empty array = valid). */
function violationsOf(validate, tool, value) {
  return validate(outputSchemaOf(tool), value, 'value')
}

/** True when any nested value is literally null. */
function hasNullValue(value) {
  if (value === null) return true
  if (Array.isArray(value)) return value.some(hasNullValue)
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasNullValue)
  return false
}

test('host validateJsonSchemaValue is resolvable (test is meaningful)', async () => {
  const toolsMod = await optionalImport('@deepseek-ai/dsh-tools')
  assert.ok(toolsMod, '@deepseek-ai/dsh-tools must resolve for conformance testing')
  assert.equal(typeof toolsMod.validateJsonSchemaValue, 'function')
})

test('meta: the validator returns violation ARRAYS, and our assertion can fail', async () => {
  const { validate } = await harness({ workspace: mkdtempSync(join(tmpdir(), 'hsf-meta-')) })
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { ok: { type: 'boolean' }, n: { type: 'number' } },
    required: ['ok', 'n'],
  }
  assert.deepEqual(validate(schema, { ok: true, n: 1 }, 'value'), [], 'a valid value has no violations')
  assert.ok(validate(schema, { ok: true, n: 'x' }, 'value').length > 0, 'wrong type must produce a violation')
  assert.ok(validate(schema, { ok: true, n: 1, extra: 2 }, 'value').length > 0, 'extra key must produce a violation')
  assert.ok(validate(schema, { ok: true }, 'value').length > 0, 'missing required key must produce a violation')
  // The vacuous assertion this file used to make would have passed all four:
  const vacuous = (r) => r === undefined || r === null || r.valid !== false
  assert.equal(vacuous(validate(schema, { ok: true, n: 'x' }, 'value')), true, 'documents why the old assertion was useless')
})

test('gs_setup result passes the host validator with NO cache', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-empty-'))
  const { record, validate } = await harness({ workspace })
  const tool = record.tools.find((t) => t.name === 'gs_setup')
  const value = await tool.execute({}, {})
  // The historical bug: `lastUpdated: null` / `error: null` while the schema types
  // those keys as `string`, so the host rejected every call.
  assert.ok(!hasNullValue(value), `gs_setup 含 null 值：${JSON.stringify(value).slice(0, 400)}`)
  assert.deepEqual(violationsOf(validate, tool, value), [], `gs_setup 被宿主校验拒绝：${JSON.stringify(value).slice(0, 400)}`)
  rmSync(workspace, { recursive: true, force: true })
})

test('every tool result passes the host validator (degraded paths included)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-all-'))
  const { record, validate } = await harness({ workspace, requestIntervalMs: 1 })
  const calls = [
    ['gs_setup', {}],
    ['gs_read', { dataset: 'equations' }],
    ['gs_read', { dataset: 'no-such-dataset' }],
    ['gs_read', { dataset: 'equations', limit: 3, offset: 5 }],
    ['gs_missions', { limit: 3 }],
    ['gs_missions', { series: '不存在的系列' }],
    ['gs_digest', { kind: 'equation' }],
    ['gs_digest', { kind: 'mission-digest' }],
    ['gs_digest', { kind: 'book-digest' }],
    ['gs_digest', { kind: 'broadcast-template' }],
    ['gs_digest', { kind: 'nope' }],
    ['gs_save', { kind: 'story', title: 'host-validator', content: 'body' }],
    ['gs_save', { kind: 'inspiration', title: '..\\..\\evil', content: 'x' }],
    ['gs_save', { kind: 'bogus', title: '', content: '' }],
    // OFFLINE: the wiki submodule is stubbed out, so this exercises the shell's
    // wiki-unavailable degraded branch (all 7 required keys present) with no I/O.
    ['gs_update', { datasets: ['aeons'] }],
  ]
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const restore = mod.__internals.stubSubmodules({ wiki: null })
  try {
    for (const [name, args] of calls) {
      const tool = record.tools.find((t) => t.name === name)
      assert.ok(tool, `${name} not registered`)
      const value = await tool.execute(args, {})
      assert.ok(!hasNullValue(value), `${name}(${JSON.stringify(args)}) 含 null 值：${JSON.stringify(value).slice(0, 300)}`)
      assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${name} 不是 lossless JSON`)
      const violations = violationsOf(validate, tool, value)
      assert.deepEqual(violations, [], `${name}(${JSON.stringify(args)}) 被宿主校验拒绝：${violations.join('; ')}`)
      const rendered = tool.output.render(args, value)
      assert.ok(Array.isArray(rendered) && typeof rendered[0].text === 'string', `${name} render 未产出文本块`)
    }
  } finally {
    restore()
  }
  rmSync(workspace, { recursive: true, force: true })
})

test('non-finite config values cannot drop a required key (F2 regression)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-nan-'))
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const { record, validate } = await harness({ workspace, staleAfterDays: bad, recentGuardDays: bad })
    const tool = record.tools.find((t) => t.name === 'gs_setup')
    const value = await tool.execute({}, {})
    assert.equal(typeof value.staleAfterDays, 'number', `staleAfterDays 不是有限数：${value.staleAfterDays}`)
    assert.ok(Number.isFinite(value.staleAfterDays), 'staleAfterDays 必须有限')
    assert.ok(Number.isFinite(value.recentGuardDays), 'recentGuardDays 必须有限')
    assert.deepEqual(violationsOf(validate, tool, value), [], `NaN 配置下 gs_setup 被拒绝：${JSON.stringify(value)}`)
  }
  rmSync(workspace, { recursive: true, force: true })
})

test('gs_update counts never list an unrequested dataset (F5 regression)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-counts-'))
  const { record, validate } = await harness({ workspace })
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const tool = record.tools.find((t) => t.name === 'gs_update')
  // Fake wiki: requesting ONLY `aeons`, and that request FAILS. The old derivation
  // used `wanted.size === 0` as its "no filter" sentinel, which is also the value
  // here — so it reported every dataset in the index, including unrequested ones.
  const restoreCounts = mod.__internals.stubSubmodules({
    wiki: {
      update: async () => ({ ok: false, updated: [], skipped: [], failed: [{ id: 'aeons', error: 'boom' }], warnings: [] }),
      status: async () => ({
        lastUpdated: null,
        datasets: [
          { id: 'equations', title: '方程一览', count: 212, ok: true },
          { id: 'aeons', title: '星神', count: 18, ok: true },
        ],
      }),
    },
  })
  try {
    const value = await tool.execute({ datasets: ['aeons'] }, {})
    assert.deepEqual(violationsOf(validate, tool, value), [], `gs_update 被拒绝：${JSON.stringify(value)}`)
    const ids = value.counts.map((c) => c.id)
    assert.deepEqual(ids, ['aeons'], `counts 只能含请求的数据集，实际：${JSON.stringify(ids)}`)
    assert.equal(value.ok, false)
    assert.deepEqual(value.failed, [{ id: 'aeons', error: 'boom' }])

    // R2-2 regression: the data layer accepts SINGULAR aliases and reports canonical
    // plural ids back, so a raw-string comparison emptied `counts` for alias requests.
    const alias = await tool.execute({ datasets: ['equation'] }, {})
    assert.deepEqual(
      alias.counts.map((c) => c.id), ['equations'],
      `singular alias 也必须拿到 counts，实际：${JSON.stringify(alias.counts)}`,
    )
    const mixed = await tool.execute({ datasets: ['equation', 'equations'] }, {})
    assert.deepEqual(mixed.counts.map((c) => c.id), ['equations'], '重复/混合别名不得重复计数')

    // R3-1 regression: the data layer's resolver also TRIMS and LOWERCASES, so the
    // shell's normalization must match it exactly or these three forms lose counts.
    for (const spelling of ['Equations', ' equations ', 'EQUATION']) {
      const spaced = await tool.execute({ datasets: [spelling] }, {})
      assert.deepEqual(
        spaced.counts.map((c) => c.id), ['equations'],
        `${JSON.stringify(spelling)} 也必须拿到 counts，实际：${JSON.stringify(spaced.counts)}`,
      )
    }
    // an unknown id must stay unmatched (no false positive from normalization)
    const unknown = await tool.execute({ datasets: ['nope'] }, {})
    assert.deepEqual(unknown.counts, [], `未知 id 不得匹配任何数据集，实际：${JSON.stringify(unknown.counts)}`)

    // hostile submodule shapes must degrade, not throw (F9)
    const restoreHostile = mod.__internals.stubSubmodules({
      wiki: { update: async () => ({ failed: { nope: true } }), status: async () => null },
    })
    try {
      const hostile = await tool.execute({}, {})
      assert.deepEqual(violationsOf(validate, tool, hostile), [], `非数组成员 failed 下 gs_update 被拒绝`)
      assert.ok(Array.isArray(hostile.failed) && hostile.failed.length === 0)
      assert.deepEqual(hostile.counts, [])
    } finally {
      restoreHostile()
    }
  } finally {
    restoreCounts()
  }
  rmSync(workspace, { recursive: true, force: true })
})

test('gs_save escapes the title so it cannot inject YAML front-matter keys (F6 regression)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-yaml-'))
  const { record } = await harness({ workspace })
  const tool = record.tools.find((t) => t.name === 'gs_save')
  const hostile = 'Real Title\ninjected: true\n---'
  const value = await tool.execute({ kind: 'story', title: hostile, content: 'body\n' }, {})
  assert.equal(value.saved, true)
  const file = readFileSync(value.path, 'utf8')
  // The front matter is the region between the opening `---` and the first
  // standalone `---` delimiter. Extract it before asserting anything about it,
  // otherwise the delimiter glued to an escaped title satisfies a naive search.
  assert.ok(file.startsWith('---\n'), 'front-matter 必须以 --- 开头')
  const end = file.indexOf('\n---\n', 4)
  assert.ok(end > 0, 'front-matter 必须有结束分隔符')
  const front = file.slice(4, end + 1)
  assert.ok(!/^injected:/m.test(front), `front-matter 被注入了键：\n${front}`)
  assert.ok(/^createdAt: /m.test(front), `createdAt 必须在 front-matter 内：\n${front}`)
  assert.ok(/^generator: /m.test(front), `generator 必须在 front-matter 内：\n${front}`)
  assert.ok(front.includes('\\n'), '标题中的换行必须被转义为 \\n')
  // and the body must still be exactly what the caller passed
  const body = file.slice(end + 5)
  assert.equal(body, 'body\n')
  rmSync(workspace, { recursive: true, force: true })
})

test('command definition contains no null-valued keys', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-cmd-'))
  const { record } = await harness({ workspace })
  const cmd = record.commands[0]
  assert.ok(!hasNullValue(cmd), `命令定义含 null：${JSON.stringify(cmd)}`)
  rmSync(workspace, { recursive: true, force: true })
})

test('gs_setup handles malformed / future / hostile status shapes offline (F7, F8, F9)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-status-'))
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const { record, validate } = await harness({ workspace })
  const tool = record.tools.find((t) => t.name === 'gs_setup')
  const restoreBase = mod.__internals.stubSubmodules({ wiki: null })
  let restoreCase = null
  const withWiki = (status) => {
    if (restoreCase !== null) restoreCase()
    restoreCase = mod.__internals.stubSubmodules({ wiki: { status: async () => status } })
  }
  const future = new Date(Date.now() + 2 * 86400000).toISOString()
  const cases = [
    ['unparsable timestamp', { lastUpdated: 'not-a-date', datasets: [{ id: 'aeons', title: '星神', count: 18, ok: true, lastUpdated: 'not-a-date' }] }],
    ['future timestamp', { lastUpdated: future, datasets: [{ id: 'aeons', title: '星神', count: 18, ok: true, lastUpdated: future }] }],
    ['null status', null],
    ['non-array datasets', { lastUpdated: '2026-01-01T00:00:00.000Z', datasets: { nope: true } }],
    ['null dataset element', { lastUpdated: '2026-01-01T00:00:00.000Z', datasets: [null] }],
  ]
  try {
    for (const [label, status] of cases) {
      withWiki(status)
      const value = await tool.execute({}, {})
      const violations = violationsOf(validate, tool, value)
      assert.deepEqual(violations, [], `${label}: 被宿主校验拒绝：${violations.join('; ')}`)
      assert.ok(Number.isFinite(value.staleAfterDays) && Number.isFinite(value.recentGuardDays), `${label}: 必填数字键必须有限`)
      if (value.ageDays !== undefined) {
        assert.ok(value.ageDays >= 0, `${label}: ageDays 不得为负，实际 ${value.ageDays}`)
      }
      if (label === 'unparsable timestamp') {
        assert.equal('lastUpdated' in value, false, `${label}: 不可解析的时间戳不应出现在结果里（键应缺失，而不是空串）`)
        assert.match(value.advice, /不可解析|未知/, `${label}: advice 必须承认新鲜度未知，实际「${value.advice}」`)
        assert.ok(value.warnings.some((w) => /无法解析/.test(w)), `${label}: 应有告警`)
      }
    }
  } finally {
    if (restoreCase !== null) restoreCase()
    restoreBase()
  }
  rmSync(workspace, { recursive: true, force: true })
})

test('unload disposes every registration; a reload leaves the registry consistent', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-lifecycle-'))
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const { ctx, record } = makeCtx()
  mod.apply(ctx, { workspace })
  assert.equal(record.tools.length, 6)
  assert.equal(record.sections.length, 1)
  assert.equal(record.commands.length, 1)
  assert.equal(record.live.size, 8, `应有 8 个生效注册，实际 ${JSON.stringify([...record.live])}`)

  for (const dispose of record.disposers) dispose?.()
  assert.deepEqual([...record.live], [], '卸载后不应残留任何注册')
  // double-dispose must be safe
  for (const dispose of record.disposers) dispose?.()

  // reload (the host's recovery path) must return to exactly one registration set
  const second = makeCtx()
  mod.apply(second.ctx, { workspace })
  assert.equal(second.record.tools.length, 6, '重载不得重复注册')
  assert.equal(second.record.commands.length, 1)
  assert.equal(second.record.sections.length, 1)
  rmSync(workspace, { recursive: true, force: true })
})

test('canonical() strips null keys at every depth but keeps null array items meaningful', async () => {
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const { canonical } = mod.__internals
  assert.deepEqual(canonical({ a: null, b: 1, c: { d: null, e: 2 } }), { b: 1, c: { e: 2 } })
  // array elements are values, not keys: a real null stays
  assert.deepEqual(canonical({ list: [null, 1] }), { list: [null, 1] })
})

test('the stub seam restores the real submodules (no cross-test leakage, no pinned degradation)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-hv-seam-'))
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const { record } = await harness({ workspace })
  const setup = record.tools.find((t) => t.name === 'gs_setup')

  // real submodules resolve here (the plugin package ships them)
  mod.__internals.resetSubmodules()
  const real = await setup.execute({}, {})
  assert.equal(real.ok, true)
  assert.equal(real.datasets.length, 12, '真实子模块应报出 12 个数据集')

  // R2-3 regression: the seam returns a restore() closure, and restoring MUST clear
  // the load latch. Restoring only the handles left `loaded === true` with a null
  // handle, pinning the plugin into the degraded state for the rest of the process
  // even though the real module is on disk.
  const restore = mod.__internals.stubSubmodules({
    wiki: { status: async () => ({ lastUpdated: null, datasets: [{ id: 'fake', title: 'fake', count: 1, ok: true }] }) },
  })
  try {
    const stubbed = await setup.execute({}, {})
    assert.deepEqual(stubbed.datasets.map((d) => d.id), ['fake'], 'stub 应生效')
  } finally {
    restore()
  }

  const restored = await setup.execute({}, {})
  assert.equal(restored.datasets.length, 12, 'restore() 后必须回到真实子模块（否则测试间会互相污染）')

  // the footgun itself: stub to null, restore, and confirm we are NOT stuck in the
  // degraded state (this is exactly what a handle-only restore used to break).
  // R3-2: the restore must be in `finally`, otherwise a throwing assertion leaves the
  // null-wiki stub installed and leaks into a sibling file under --test-isolation=none.
  const restoreNull = mod.__internals.stubSubmodules({ wiki: null })
  try {
    const degraded = await setup.execute({}, {})
    assert.ok(degraded.warnings.some((w) => /子模块不可用/.test(w)), 'null wiki 应进入降级分支')
  } finally {
    restoreNull()
  }
  const afterNull = await setup.execute({}, {})
  assert.equal(afterNull.datasets.length, 12, 'restore() 不能把插件钉死在降级状态')

  // R3-4: nested stubs must unwind LIFO — an inner restore must NOT cancel an outer stub.
  const restoreOuter = mod.__internals.stubSubmodules({
    wiki: { status: async () => ({ lastUpdated: null, datasets: [{ id: 'outer', title: 'outer', count: 1, ok: true }] }) },
  })
  try {
    const restoreInner = mod.__internals.stubSubmodules({
      wiki: { status: async () => ({ lastUpdated: null, datasets: [{ id: 'inner', title: 'inner', count: 1, ok: true }] }) },
    })
    const inner = await setup.execute({}, {})
    assert.deepEqual(inner.datasets.map((d) => d.id), ['inner'], '内层 stub 应生效')
    restoreInner()
    const outer = await setup.execute({}, {})
    assert.deepEqual(outer.datasets.map((d) => d.id), ['outer'], '内层还原不得取消外层 stub（LIFO 可组合）')
  } finally {
    restoreOuter()
  }
  const afterNested = await setup.execute({}, {})
  assert.equal(afterNested.datasets.length, 12, '逐层还原后必须回到真实子模块')
  rmSync(workspace, { recursive: true, force: true })
})

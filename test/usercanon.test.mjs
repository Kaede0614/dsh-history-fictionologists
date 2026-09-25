/**
 * User-canon layer（「用户设定补充」）tests.
 *
 * The layer exists because the user's own rulings must survive crawls and must reach
 * the model: `hsr-worldview-cache/user-canon.json` is authored by hand, while
 * `update()` rewrites `<dataset>.json` atomically on every crawl.
 *
 * Fully OFFLINE: the shell integration test stubs the wiki submodule.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { cacheDir } from '../lib/paths.js'
import {
  USER_CANON_FILE,
  matchUserCanon,
  readUserCanon,
  summarizeUserCanon,
  userCanonPath,
} from '../lib/usercanon.mjs'

const ROOT = join(import.meta.dirname, '..')
const SHELL_PATH = join(ROOT, 'lib', 'shell.js')

/** Write a user-canon file into a fresh workspace; returns that workspace. */
function workspaceWithCanon(payload, { raw = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-canon-'))
  mkdirSync(cacheDir(workspace), { recursive: true })
  writeFileSync(
    userCanonPath(workspace),
    raw ? String(payload) : JSON.stringify(payload, null, 2),
    'utf8',
  )
  return workspace
}

const ruling = (over = {}) => ({
  dataset: 'aeons',
  match: ['贪饕', '奥博洛斯'],
  name: '「贪饕」，奥博洛斯',
  status: '已镇压（不得写成在世）',
  note: '奥博洛斯早已四分五裂、被镇压，不得写成失踪待返或即将归来。',
  source: '用户评审（测试）',
  ...over,
})

/** Minimal Cordis ctx double (registration recording only). */
function makeCtx() {
  const record = { tools: [], sections: [] }
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    effect: (cb) => cb(),
    on: () => () => {},
    get: () => undefined,
    systemPrompt: { section: (s) => { record.sections.push(s); return () => {} } },
    tools: { register: (t) => { record.tools.push(t); return () => {} } },
    commands: { register: () => () => {} },
  }
  return { ctx, record }
}

test('a missing user-canon file is not an error (and is not created)', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hsf-canon-none-'))
  const canon = readUserCanon(workspace)
  assert.equal(canon.ok, true)
  assert.equal(canon.exists, false)
  assert.equal(canon.count, 0)
  assert.deepEqual(canon.entries, [])
  assert.deepEqual(canon.warnings, [])
  assert.deepEqual(matchUserCanon(canon, { dataset: 'aeons' }), [])
  assert.deepEqual(summarizeUserCanon(canon), { count: 0, updatedAt: '', path: canon.path })
  rmSync(workspace, { recursive: true, force: true })
})

test('a corrupt user-canon file degrades to count 0 plus a warning (never throws)', () => {
  const workspace = workspaceWithCanon('{ not json at all', { raw: true })
  const canon = readUserCanon(workspace)
  assert.equal(canon.ok, false)
  assert.equal(canon.count, 0)
  assert.deepEqual(canon.entries, [])
  assert.ok(canon.warnings.some((w) => w.includes('读取失败')), `应带读取失败告警：${JSON.stringify(canon.warnings)}`)
  rmSync(workspace, { recursive: true, force: true })
})

test('entries without a note are dropped, and a bare array is accepted', () => {
  const workspace = workspaceWithCanon([
    ruling(),
    { dataset: 'aeons', name: '没写 note 的条目' },
    null,
    'not-an-object',
  ])
  const canon = readUserCanon(workspace)
  assert.equal(canon.ok, true)
  assert.equal(canon.count, 1, '只有带 note 的那条应当生效')
  assert.ok(canon.warnings.some((w) => /3 条因缺少 note/.test(w)), `应报告被丢弃的条数：${JSON.stringify(canon.warnings)}`)
  rmSync(workspace, { recursive: true, force: true })
})

test('scope: dataset-scoped rulings stay in their dataset, "*" applies everywhere', () => {
  const workspace = workspaceWithCanon({
    updatedAt: '2026-09-26T00:00:00.000Z',
    entries: [ruling(), ruling({ dataset: '*', match: ['通用'], name: '通用裁定', note: '对全部数据集生效。' })],
  })
  const canon = readUserCanon(workspace)
  assert.equal(canon.count, 2)

  const aeons = matchUserCanon(canon, { dataset: 'aeons' })
  assert.deepEqual(aeons.map((item) => item.name), ['「贪饕」，奥博洛斯', '通用裁定'])

  const equations = matchUserCanon(canon, { dataset: 'equations' })
  assert.deepEqual(equations.map((item) => item.name), ['通用裁定'], '数据集限定条目不得外溢')

  // singular alias must resolve to the same scope
  assert.equal(matchUserCanon(canon, { dataset: 'aeon' }).length, 2)
  rmSync(workspace, { recursive: true, force: true })
})

test('query matching: by term, by returned entry name, and empty query means "all scoped"', () => {
  const workspace = workspaceWithCanon({ entries: [ruling()] })
  const canon = readUserCanon(workspace)

  assert.equal(matchUserCanon(canon, { dataset: 'aeons', query: '贪饕' }).length, 1, 'query 命中 match 关键词')
  assert.equal(matchUserCanon(canon, { dataset: 'aeons', query: '奥博洛斯' }).length, 1)
  assert.equal(matchUserCanon(canon, { dataset: 'aeons', query: '药师' }).length, 0, '无关 query 不应带出')
  assert.equal(matchUserCanon(canon, { dataset: 'aeons', query: '' }).length, 1, '空 query 必须带出该数据集的全部裁定')
  // the ruling also applies when the returned entries mention the term
  const viaEntries = matchUserCanon(canon, {
    dataset: 'aeons',
    query: '某个别的关键词',
    entries: [{ name: '「贪饕」，奥博洛斯', content: '诸界渴饮者…' }],
  })
  assert.equal(viaEntries.length, 1, '返回条目命中关键词时也应带出裁定')
  rmSync(workspace, { recursive: true, force: true })
})

test('the published file never collides with a crawler-owned dataset file', () => {
  const workspace = join(ROOT, 'hsr-worldview-cache')
  const canonPath = userCanonPath(join(ROOT))
  assert.equal(canonPath, join(workspace, USER_CANON_FILE))
  // update() overwrites `<dataset>.json`; a ruling stored there would be erased.
  assert.ok(!/^(aeons|factions|terms|relics|lightcones|equations|events|curios|consumables|decorations|simuniverse|broadcast)\.json$/.test(USER_CANON_FILE))
})

test('the shipped user-canon.json parses and its 贪饕 ruling covers gs_read(aeons)', () => {
  const canon = readUserCanon(ROOT)
  assert.equal(canon.exists, true, '仓库应自带 hsr-worldview-cache/user-canon.json')
  assert.equal(canon.ok, true)
  assert.ok(canon.count >= 1, `应至少有一条裁定，实际 ${canon.count}`)
  const items = matchUserCanon(canon, { dataset: 'aeons' })
  const greed = items.find((item) => (item.name ?? '').includes('奥博洛斯'))
  assert.ok(greed, `星神数据集应带出贪饕裁定：${JSON.stringify(items)}`)
  assert.match(greed.note, /镇压/)
  assert.equal(greed.dataset, 'aeons', '对外的 scope 保留用户写法')
})

test('gs_read carries user canon in the result AND the rendered text', async () => {
  const mod = await import(pathToFileURL(SHELL_PATH).href)
  const workspace = workspaceWithCanon({ entries: [ruling()] })
  const { ctx, record } = makeCtx()
  await mod.apply(ctx, { workspace })

  const read = record.tools.find((tool) => tool.name === 'gs_read')
  const setup = record.tools.find((tool) => tool.name === 'gs_setup')
  assert.ok(read && setup, 'gs_read / gs_setup 必须注册')

  const restore = mod.__internals.stubSubmodules({
    // Echo the REQUESTED canonical dataset, like the real data layer does: the shell
    // scopes user canon by the dataset the read actually reports.
    wiki: {
      read: async (_cfg, options) => ({
        ok: true,
        dataset: options?.dataset ?? '',
        title: '星神',
        total: 18,
        matched: 18,
        entries: [],
      }),
    },
  })
  try {
    const value = await read.execute({ dataset: 'aeons' }, {})
    assert.equal(Array.isArray(value.userCanon), true, 'gs_read 必须带上 userCanon')
    assert.equal(value.userCanon.length, 1)
    assert.match(value.userCanon[0].note, /四分五裂/)
    const rendered = read.output.render({ dataset: 'aeons' }, value)
    const text = rendered.map((block) => block.text).join('')
    assert.match(text, /用户设定补充（优先于上方缓存文本，冲突时以此为准）/)
    assert.match(text, /奥博洛斯/)

    // a different dataset must not inherit the aeons-scoped ruling
    const other = await read.execute({ dataset: 'equations' }, {})
    assert.equal('userCanon' in other, false, '无关数据集不应带出 userCanon 键')

    // the ruling is still delivered when the dataset has no cache at all
    const restoreNull = mod.__internals.stubSubmodules({ wiki: null })
    try {
      const degraded = await read.execute({ dataset: 'aeons' }, {})
      assert.equal(degraded.ok, false)
      assert.equal(degraded.userCanon?.length, 1, '无 wiki 子模块时也要交付用户裁定')
    } finally {
      restoreNull()
    }
  } finally {
    restore()
  }

  const setupValue = await setup.execute({}, {})
  assert.deepEqual(Object.keys(setupValue.userCanon).sort(), ['count', 'path', 'updatedAt'])
  assert.ok(Number.isFinite(setupValue.userCanon.count))
  const setupText = setup.output.render({}, setupValue).map((block) => block.text).join('')
  assert.match(setupText, new RegExp(`用户设定补充：${setupValue.userCanon.count} 条`))
  assert.match(setupText, /优先级高于缓存/)
  rmSync(workspace, { recursive: true, force: true })
})

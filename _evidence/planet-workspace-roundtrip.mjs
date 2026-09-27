/**
 * 真实工作区往返：用**用户自己的工作区**（含真实中文缓存目录、真实 junction 权限）
 * 跑一次「并入 → 读回 → 重置」，验证星球列表文件在真机路径上能建、能读、能清。
 *
 * 结束状态 = 文件回到「原始 27 颗、added 为空」，即与用户从未并入过完全等价；
 * 脚本最后会自己核对这一点，不满足就报失败。
 *
 * 用法：node _evidence/planet-workspace-roundtrip.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'shell.js')).href)

const record = { tools: [] }
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  effect: (cb) => cb(),
  on: () => () => {},
  get: () => undefined,
  systemPrompt: { section: () => () => {} },
  tools: { register: (t) => (record.tools.push(t), () => {}) },
  commands: { register: () => () => {} },
}

// workspace = 仓库本身（插件用 hsr-worldview-cache 作为缓存目录的标记目录）
mod.apply(ctx, { workspace: ROOT })
const toolOf = (name) => {
  const tool = record.tools.find((t) => t.name === name)
  assert.ok(tool, `${name} 未注册`)
  return tool
}

const file = join(ROOT, 'hsr-worldview-cache', 'planet-list.json')
console.log(`工作区：${ROOT}`)
console.log(`星球列表文件：${file}`)
console.log(`文件是否已存在：${existsSync(file)}（存在则说明这台机器之前并入过）`)

const before = await toolOf('gs_planets').execute({}, {})
console.log(`\n[0] 并入前：原始=${before.baselineCount} 已并入=${before.addedCount}`)

const sample = [
  { name: '复核临时星', en: 'Review Temp', description: '往返验证用的临时星球，脚本结束时会重置掉。', source: 'other' },
]
const saved = await toolOf('gs_planet_save').execute({ planets: sample }, {})
console.log(`\n[1] 并入：ok=${saved.ok} 新增=${JSON.stringify(saved.added.map((p) => p.name))} 写盘=${saved.bytes} 字节`)
assert.equal(saved.ok, true)
assert.deepEqual(saved.added.map((p) => p.name), ['复核临时星'])
assert.ok(existsSync(file), '文件应已建好')
console.log(`    文件大小 ${statSync(file).size} 字节`)

const reread = await toolOf('gs_planets').execute({ query: '复核临时星' }, {})
console.log(`\n[2] 读回：matched=${reread.matched} origin=${reread.planets[0]?.origin} source=${reread.planets[0]?.source}`)
assert.equal(reread.matched, 1)
assert.equal(reread.planets[0].origin, 'added')

const raw = JSON.parse(readFileSync(file, 'utf8'))
console.log(`    文件内：baseline=${raw.baseline.length} added=${raw.added.length} schema=${raw.schema}`)

const reset = await toolOf('gs_planet_reset').execute({ confirm: true }, {})
console.log(`\n[3] 重置：reset=${reset.reset} 清除=${reset.removed} 现有=${reset.total}`)
assert.equal(reset.reset, true)
assert.equal(reset.removed, 1)
assert.equal(reset.total, 27)

const after = await toolOf('gs_planets').execute({}, {})
const rawAfter = JSON.parse(readFileSync(file, 'utf8'))
console.log(`\n[4] 结束状态：原始=${after.baselineCount} 已并入=${after.addedCount} 文件内 added=${rawAfter.added.length}`)
assert.equal(after.addedCount, 0)
assert.equal(rawAfter.added.length, 0)
assert.equal(rawAfter.baseline.length, 27)

console.log('\nREAL WORKSPACE ROUNDTRIP OK（结束状态 = 纯原始 27 颗）')
void mkdtempSync // 保留 import 以便将来扩展；本脚本不需要临时目录
void tmpdir

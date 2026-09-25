// End-to-end wiring check: drive gs_setup / gs_update / gs_read / gs_digest /
// gs_missions / gs_save through the plugin's OWN tool definitions (mock ctx),
// against the REAL wiki, in a throwaway workspace.
//
// This is the integration seam: it runs lib/index.js's tools exactly as the
// model would call them, so a shape mismatch between shell and submodules fails here.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')

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

function assertLossless(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: 返回值不是 lossless JSON`)
}

function toolOf(record, name) {
  const tool = record.tools.find((t) => t.name === name)
  assert.ok(tool, `tool ${name} not registered`)
  return tool
}

const ws = mkdtempSync(join(tmpdir(), 'hsf-e2e-'))
const mod = await import(pathToFileURL(join(ROOT, 'lib', 'shell.js')).href)
const { ctx, record } = makeCtx()
mod.apply(ctx, { workspace: ws, requestIntervalMs: 1500 })

console.log('workspace:', ws)
console.log('registered tools:', record.tools.map((t) => t.name).join(', '))

// ---- 1. gs_setup with an empty cache: must recommend update ---------------
{
  const value = await toolOf(record, 'gs_setup').execute({}, {})
  assertLossless(value, 'gs_setup(empty)')
  console.log(`\n[1] gs_setup(empty): ok=${value.ok} hasCache=${value.hasCache} recommendation=${value.recommendation} datasets=${value.datasets.length}`)
  console.log('    advice:', value.advice)
  console.log('    missions:', JSON.stringify(value.missions))
}

// ---- 2. gs_update on two datasets against the REAL wiki -------------------
{
  const value = await toolOf(record, 'gs_update').execute({ datasets: ['aeons', 'factions'] }, { signal: AbortSignal.timeout(180_000) })
  assertLossless(value, 'gs_update')
  console.log(`\n[2] gs_update: ok=${value.ok} updated=${JSON.stringify(value.updated)} skipped=${JSON.stringify(value.skipped)} failed=${JSON.stringify(value.failed)}`)
  console.log(`    counts=${JSON.stringify(value.counts)} durationMs=${value.durationMs}`)
  assert.equal(value.failed.length, 0, `update failed: ${JSON.stringify(value.failed)}`)
  assert.ok(value.updated.includes('aeons'), 'aeons should have been updated')
}

// ---- 3. gs_setup now reports cache and derives counts --------------------
{
  const value = await toolOf(record, 'gs_setup').execute({}, {})
  assertLossless(value, 'gs_setup(cached)')
  const aeons = value.datasets.find((d) => d.id === 'aeons')
  console.log(`\n[3] gs_setup(cached): hasCache=${value.hasCache} lastUpdated=${value.lastUpdated} ageDays=${value.ageDays} recommendation=${value.recommendation}`)
  console.log(`    aeons: count=${aeons.count} ok=${aeons.ok}`)
  assert.ok(aeons.count > 0, 'aeons count should be positive after update')
}

// ---- 4. gs_read returns real content ------------------------------------
{
  const value = await toolOf(record, 'gs_read').execute({ dataset: 'factions', query: '假面愚者', limit: 2 }, {})
  assertLossless(value, 'gs_read')
  console.log(`\n[4] gs_read(factions, query=假面愚者): total=${value.total} matched=${value.matched} returned=${value.entries.length}`)
  for (const entry of value.entries) console.log(`    - ${entry.name}: ${entry.content.slice(0, 90).replace(/\n/g, ' ')}…`)
}

// ---- 5. gs_digest over the real cache -----------------------------------
for (const kind of ['equation', 'broadcast-template']) {
  const value = await toolOf(record, 'gs_digest').execute({ kind }, {})
  assertLossless(value, `gs_digest(${kind})`)
  console.log(`\n[5] gs_digest(${kind}): ok=${value.ok} markdownLen=${value.markdown.length} warnings=${JSON.stringify(value.warnings).slice(0, 140)}`)
}

// ---- 6. gs_missions + a real digest ------------------------------------
{
  const value = await toolOf(record, 'gs_missions').execute({ limit: 12 }, {})
  assertLossless(value, 'gs_missions')
  console.log(`\n[6] gs_missions: ok=${value.ok} series=${value.seriesCount} missions=${value.missionCount} markdownLen=${value.markdown.length}`)
}

// ---- 7. gs_save writes to the throwaway workspace ----------------------
{
  const value = await toolOf(record, 'gs_save').execute({ kind: 'broadcast', title: '接线自检', content: '（音乐）\n\n女声：这里是星际和平播报。' }, {})
  assertLossless(value, 'gs_save')
  assert.equal(value.saved, true)
  assert.ok(existsSync(value.path))
  console.log(`\n[7] gs_save: ${value.path} (${value.bytes} bytes)`)
}

// ---- 8. second update must short-circuit on revid ---------------------
{
  const value = await toolOf(record, 'gs_update').execute({ datasets: ['aeons', 'factions'] }, { signal: AbortSignal.timeout(120_000) })
  assertLossless(value, 'gs_update(2nd)')
  console.log(`\n[8] gs_update(2nd): updated=${JSON.stringify(value.updated)} skipped=${JSON.stringify(value.skipped)} failed=${JSON.stringify(value.failed)}`)
  assert.deepEqual(value.updated, [], 'second update must skip (revid unchanged)')
  assert.deepEqual(value.skipped.sort(), ['aeons', 'factions'])
}

console.log('\nALL WIRING CHECKS PASSED')
rmSync(ws, { recursive: true, force: true })

// Independent spot-check of the wiki data layer against the REAL wiki.
// Uses a throwaway temp workspace so it cannot disturb the test instance.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = join(import.meta.dirname, '..')
const wiki = await import(pathToFileURL(join(ROOT, 'lib', 'wiki', 'index.mjs')).href)

const ws = mkdtempSync(join(tmpdir(), 'hsf-spotcheck-'))
const cfg = { workspace: ws, requestIntervalMs: 2000, requestTimeoutMs: 30000, maxRetries: 3, userAgent: undefined }
console.log('temp workspace:', ws)

const which = process.argv.slice(2)
const datasets = which.length > 0 ? which : ['aeons']

console.log(`\n=== update(${datasets.join(',')}) ===`)
const t0 = Date.now()
const result = await wiki.update(cfg, { datasets })
console.log('ms:', Date.now() - t0)
console.log('updated:', JSON.stringify(result.updated))
console.log('skipped:', JSON.stringify(result.skipped))
console.log('failed:', JSON.stringify(result.failed))
console.log('counts:', JSON.stringify(result.counts))
console.log('warnings:', JSON.stringify(result.warnings ?? []))

console.log('\n=== status() ===')
const status = await wiki.status(cfg)
console.log('lastUpdated:', status.lastUpdated)
for (const d of status.datasets) {
  console.log(`  ${d.id.padEnd(14)} count=${String(d.count).padStart(4)} ok=${d.ok} lastUpdated=${d.lastUpdated ?? '-'}${d.error ? ` error=${d.error}` : ''}`)
}

console.log('\n=== read() first entry of each updated dataset ===')
for (const id of datasets) {
  const read = await wiki.read(cfg, { dataset: id, limit: 1 })
  const first = read.entries?.[0]
  console.log(`\n-- ${id}: total=${read.total} matched=${read.matched} ok=${read.ok}`)
  if (first) {
    console.log(`   name: ${first.name}`)
    console.log(`   content: ${String(first.content).slice(0, 300).replace(/\n/g, ' ⏎ ')}`)
  } else {
    console.log('   (no entries)')
  }
}

console.log('\n=== second update() must short-circuit on revid ===')
const again = await wiki.update(cfg, { datasets })
console.log('updated:', JSON.stringify(again.updated), 'skipped:', JSON.stringify(again.skipped), 'failed:', JSON.stringify(again.failed))

rmSync(ws, { recursive: true, force: true })
console.log('\n(cleaned temp workspace)')

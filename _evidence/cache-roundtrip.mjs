/**
 * Evidence runner for BRIEF §4/§9.5: cache round trip.
 *
 *   node _evidence/cache-roundtrip.mjs
 *
 * 1. `update()` — full incremental fetch, writes <workspace>/hsr-worldview-cache/
 * 2. `status()` — must show lastUpdated + counts for every dataset
 * 3. `update()` again — every dataset must be reported as `skipped` (revid short-circuit)
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { read, sampleAll, status, update } from '../lib/wiki/index.mjs'

const ROOT = 'C:/Users/masha/Desktop/hsr-history-fictionologists'
const lines = []
const log = (message = '') => {
  lines.push(message)
  console.log(message)
}

const cfg = {
  workspace: ROOT,
  requestIntervalMs: 2000,
  requestTimeoutMs: 30000,
  maxRetries: 3,
}

log('# cache-roundtrip')
log(`# argv=${JSON.stringify(process.argv)}`)
log(`# cwd=${process.cwd()}`)
log(`# node=${process.version}  time=${new Date().toISOString()}`)
log(`# cfg=${JSON.stringify(cfg)}`)
log('')

log('## status() BEFORE any update (cache dir may not exist)')
const before = status(cfg)
log(JSON.stringify({ ok: before.ok, cacheDir: before.cacheDir, hasCache: before.hasCache, lastUpdated: before.lastUpdated, stale: before.stale, recommendation: before.recommendation, advice: before.advice }, null, 2))
log('')

log('## update() #1 — full incremental fetch')
const t0 = Date.now()
const first = await update(cfg, {
  onProgress: (event) => {
    const extra = event.count !== undefined ? ` count=${event.count} excluded=${event.excludedCount}` : event.error !== undefined ? ` error=${event.error}` : ''
    log(`   [progress] ${event.phase} ${event.dataset}${extra}`)
  },
})
log('')
log(`result: ${JSON.stringify({ ok: first.ok, updated: first.updated, skipped: first.skipped, failed: first.failed, durationMs: first.durationMs, cacheDir: first.cacheDir, lastUpdated: first.lastUpdated, warnings: first.warnings }, null, 2)}`)
log(`wall clock: ${Date.now() - t0}ms`)
log('')

log('## status() AFTER update #1')
const after = status(cfg)
log(`ok=${after.ok} hasCache=${after.hasCache} lastUpdated=${after.lastUpdated} stale=${after.stale} staleAfterDays=${after.staleAfterDays} recommendation=${after.recommendation}`)
log('id           count  excluded  revisionId  pageSha           lastUpdated               ok')
for (const row of after.datasets) {
  log(
    `${row.id.padEnd(12)} ${String(row.count).padStart(5)}  ${String(row.excludedCount ?? '-').padStart(8)}  ${String(row.revisionId ?? '-').padStart(10)}  ${String(row.pageSha ?? '-').padEnd(16)}  ${String(row.lastUpdated ?? '-').padEnd(24)}  ${row.ok}`,
  )
}
log(`failed[]: ${JSON.stringify(after.failed)}`)
log('')

log('## read() / sampleAll() over the fresh cache')
const equations = read(cfg, { dataset: 'equations', limit: 2 })
log(`read equations: ok=${equations.ok} count=${equations.count} matched=${equations.matched} entries=${equations.entries.length} first="${equations.entries[0]?.name}"`)
const searched = read(cfg, { dataset: 'terms', query: '虚数之树', limit: 3 })
log(`read terms query=虚数之树: matched=${searched.matched} names=${JSON.stringify(searched.entries.map((entry) => entry.name))}`)
const sample = sampleAll(cfg)
for (const dataset of sample.datasets) {
  log(`sample ${dataset.id.padEnd(12)} count=${String(dataset.count).padStart(5)} first="${dataset.samples[0]?.name ?? ''}" preview="${(dataset.samples[0]?.preview ?? '').slice(0, 60)}"`)
}
log('')

log('## update() #2 — must skip every dataset via the revision id short-circuit')
const second = await update(cfg)
log(`result: ${JSON.stringify({ ok: second.ok, updated: second.updated, skipped: second.skipped, failed: second.failed, durationMs: second.durationMs, lastUpdated: second.lastUpdated }, null, 2)}`)
const finalStatus = status(cfg)
const onlySkipped = second.updated.length === 0 && second.skipped.length === 12 && second.failed.length === 0
const timestampsPreserved = finalStatus.datasets.every((row) => row.lastUpdated === after.datasets.find((other) => other.id === row.id)?.lastUpdated)
log('')
log(`VERDICT skipped-all-12=${onlySkipped} lastUpdated-preserved=${timestampsPreserved}`)
log(`final lastUpdated=${finalStatus.lastUpdated}`)

writeFileSync(join(ROOT, '_evidence/cache-roundtrip.txt'), `${lines.join('\n')}\n`, 'utf8')
console.log(`\nwrote ${join(ROOT, '_evidence/cache-roundtrip.txt')}`)

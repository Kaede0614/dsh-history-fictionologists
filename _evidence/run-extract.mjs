/**
 * Evidence runner: replay the ALREADY DOWNLOADED pages through the extractors.
 *
 *   node _evidence/run-extract.mjs            # offline, from _probe/html/*.html
 *   node _evidence/run-extract.mjs --live     # live wiki (throttled, writes _evidence/live-extract.txt)
 *
 * Offline mode never touches the network: it reads `_probe/html/<fixture>.html`
 * plus the hand-made wikitext fixture in `test/fixtures/` (the live run fetches
 * the real detail-page wikitext instead).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATASETS } from '../lib/wiki/datasets.mjs'
import { DETAIL_TITLE_EXTRACTORS, extractDataset } from '../lib/wiki/extract.mjs'
import { WikiClient } from '../lib/wiki/client.mjs'

const ROOT = 'C:/Users/masha/Desktop/hsr-history-fictionologists'
const LIVE = process.argv.includes('--live')
const CAPTURE = LIVE && !process.argv.includes('--no-capture')
const lines = []
const log = (message = '') => {
  lines.push(message)
  console.log(message)
}

/** Real wikitext captured this run, for `test/fixtures/wikitext-live.json`. */
const captured = { _note: '', relics: {}, lightcones: {} }
captured._note =
  'Real detail-page wikitext captured from wiki.biligame.com by _evidence/run-extract.mjs --live. ' +
  'Only pages whose titles also exist in the frozen _probe/html card lists are captured, so the offline replay stays reproducible.'

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return null
  }
}

function readJson(path) {
  const raw = readText(path)
  if (raw === null) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function firstPreview(entries) {
  const first = entries[0] ?? null
  if (first === null) return '(no entries)'
  const content = typeof first.content === 'string' ? first.content : ''
  return `name="${first.name ?? ''}" content[0:80]="${content.slice(0, 80).replace(/\n/g, '⏎')}"`
}

function reportDataset(dataset, result, extra = '') {
  const { entries, excludedCount, warnings, stats } = result
  log(
    `${dataset.id.padEnd(12)} entries=${String(entries.length).padStart(4)}  excluded=${String(excludedCount).padStart(4)}  ` +
      `stats=${JSON.stringify(stats)}  ${extra}`,
  )
  log(`             first: ${firstPreview(entries)}`)
  for (const warning of warnings) log(`             warn: ${warning}`)
}

/** Does the parsed output survive a JSON round trip unchanged (lossless)? */
function lossless(value) {
  try {
    return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value)
  } catch {
    return false
  }
}

async function main() {
  log(`# run-extract  mode=${LIVE ? 'LIVE' : 'OFFLINE'}`)
  log(`# cwd=${process.cwd()}`)
  log(`# argv=${JSON.stringify(process.argv)}`)
  log(`# node=${process.version}  time=${new Date().toISOString()}`)
  log('')

  const fixtures = {
    ...readJson(join(ROOT, 'test/fixtures/wikitext.json')),
    ...readJson(join(ROOT, 'test/fixtures/wikitext-live.json')),
  }
  const htmlByFixture = new Map()
  const client = LIVE ? new WikiClient({ intervalMs: 2000, timeoutMs: 30000, maxRetries: 3 }) : null
  const totals = []

  for (const dataset of DATASETS) {
    let html = null
    let wikitextByTitle = {}
    let source = ''

    if (LIVE) {
      const parsed = await client.parsePage(dataset.title)
      if (parsed.ok !== true) {
        log(`${dataset.id.padEnd(12)} FETCH FAILED: ${parsed.error}`)
        totals.push({ id: dataset.id, entries: 0, excluded: 0, error: parsed.error })
        continue
      }
      html = parsed.html
      source = `live ${parsed.bytes}B attempts=${parsed.attempts} ms=${parsed.ms}`
      if (dataset.needsWikitext === true) {
        const titles = [...new Set(DETAIL_TITLE_EXTRACTORS[dataset.id](html))]
        // Capture only titles present in the frozen offline fixture, and only when
        // the live wikitext actually carries the story field.
        const offlineTitles = new Set(DETAIL_TITLE_EXTRACTORS[dataset.id](readText(join(ROOT, '_probe/html', dataset.fixture)) ?? ''))
        log(`${dataset.id.padEnd(12)} detail pages=${titles.length} → ${Math.ceil(titles.length / 50)} wikitext batch(es)`)
        let capturedHere = 0
        for (let i = 0; i < titles.length; i += 50) {
          const batch = titles.slice(i, i + 50)
          const result = await client.revisions(batch)
          if (result.ok !== true) {
            log(`             wikitext batch failed: ${result.error}`)
            continue
          }
          for (const page of result.pages) {
            if (page.missing === true) continue
            if (typeof page.content !== 'string' || page.content.length === 0) continue
            wikitextByTitle[page.title] = page.content
            if (CAPTURE && capturedHere < 3 && offlineTitles.has(page.title) && /故事\s*=\s*\S/.test(page.content)) {
              captured[dataset.id][page.title] = page.content
              capturedHere += 1
            }
          }
          log(`             wikitext batch ${i / 50 + 1}: requested=${batch.length} got=${result.pages.length} missing=${result.pages.filter((p) => p.missing === true).length}`)
        }
      }
    } else {
      const path = join(ROOT, '_probe/html', dataset.fixture)
      html = htmlByFixture.get(path) ?? readText(path)
      if (html !== null) htmlByFixture.set(path, html)
      source = `offline ${dataset.fixture} ${html === null ? 'MISSING' : `${Buffer.byteLength(html, 'utf8')}B`}`
      if (dataset.needsWikitext === true) {
        wikitextByTitle = fixtures[dataset.id] ?? {}
        source += ` + fixture(${Object.keys(wikitextByTitle).length} pages)`
      }
    }

    const result = extractDataset(dataset.id, { html: html ?? '', wikitextByTitle, ctx: { live: LIVE, dataset } })
    reportDataset(dataset, result, source)
    if (!lossless(result.entries)) log(`             !! entries are NOT JSON-lossless`)
    totals.push({
      id: dataset.id,
      title: dataset.title,
      entries: result.entries.length,
      excluded: result.excludedCount,
      stats: result.stats,
      warnings: result.warnings.length,
      lossless: lossless(result.entries),
      first: result.entries[0]?.name ?? null,
    })
    log('')
  }

  log('==== SUMMARY ====')
  for (const row of totals) {
    log(
      `${row.id.padEnd(12)} ${String(row.entries).padStart(4)} entries  excluded=${String(row.excluded ?? 0).padStart(4)}  ` +
        `first="${row.first ?? ''}"  lossless=${row.lossless ?? false}  ${row.error ? `ERROR=${row.error}` : ''}`,
    )
  }
  log(`zero-entry datasets: ${totals.filter((row) => row.entries === 0).map((row) => row.id).join(',') || '(none)'}`)
  if (client !== null) log(`live client stats: ${JSON.stringify(client.stats)}`)

  if (LIVE) {
    const target = join(ROOT, '_evidence/live-extract.txt')
    writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
    console.log(`\nwrote ${target}`)
    if (CAPTURE) {
      const capturedCount = Object.keys(captured.relics).length + Object.keys(captured.lightcones).length
      if (capturedCount > 0) {
        const fixturePath = join(ROOT, 'test/fixtures/wikitext-live.json')
        writeFileSync(fixturePath, `${JSON.stringify(captured, null, 2)}\n`, 'utf8')
        console.log(`wrote ${fixturePath} (${Object.keys(captured.relics).length} relics + ${Object.keys(captured.lightcones).length} lightcones captured live)`)
      } else {
        console.log('no live wikitext captured for the offline fixture set')
      }
    }
  } else {
    const target = join(ROOT, '_evidence/offline-extract.txt')
    writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
    console.log(`\nwrote ${target}`)
  }
}

await main()

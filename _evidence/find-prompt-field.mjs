// What does a request/header record actually contain, and where does the plugin's
// section live inside it?
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESS = 'C:\\Users\\masha\\hsr-fictionologists-testhome\\sessions'
const files = []
const walk = (d, n = 0) => {
  if (n > 3) return
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = join(d, e.name)
    if (e.isDirectory()) walk(f, n + 1)
    else files.push(f)
  }
}
walk(SESS)
const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const decode = (b) => {
  if (!b.subarray(0, 4).equals(M)) return b.toString('utf8')
  const starts = []
  let i = b.indexOf(M)
  while (i >= 0) { starts.push(i); i = b.indexOf(M, i + 4) }
  let t = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : b.length
    try { t += zstdDecompressSync(b.subarray(starts[k], end)).toString('utf8') } catch {}
  }
  return t
}

const MARKER = '虚构史学家'
for (const f of files.sort()) {
  const text = decode(readFileSync(f))
  if (!text.includes(MARKER)) continue
  const lines = text.split('\n').filter((l) => l.startsWith('{'))
  console.log(`\n### ${f.split('\\').slice(-2).join('\\')}  jsonl records=${lines.length}`)
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch (e) { console.log('  unparsable line:', e.message.slice(0, 60)); continue }
    const json = JSON.stringify(rec)
    const type = rec.type ?? '(no type)'
    const hasMarker = json.includes(MARKER)
    if (!hasMarker) continue
    console.log(`  record type=${type} seq=${rec.seq} chars=${json.length}`)
    // walk the tree for the marker and report the path
    const hits = []
    const walkObj = (node, path) => {
      if (typeof node === 'string') {
        if (node.includes(MARKER)) hits.push(`${path} (string, ${node.length} chars)`)
        return
      }
      if (Array.isArray(node)) { node.forEach((v, i) => walkObj(v, `${path}[${i}]`)); return }
      if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walkObj(v, path === '' ? k : `${path}.${k}`)
      }
    }
    walkObj(rec, '')
    for (const h of hits.slice(0, 12)) console.log('    marker at:', h)
    if (type === 'request/header') {
      console.log('    data keys:', Object.keys(rec.data ?? {}).join(', '))
      console.log('    header keys:', Object.keys(rec.data?.header ?? {}).join(', '))
    }
  }
}

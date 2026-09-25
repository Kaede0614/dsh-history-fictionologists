import { readFileSync } from 'node:fs'

const P = 'C:\\Users\\masha\\Desktop\\hsr-history-fictionologists\\_probe\\html\\'
const html = readFileSync(P + '方程一览.html', 'utf8')
const rows = html.split(/(?=<tr[\s>])/i).filter((r) => /class="divsort"/i.test(r))
console.log('divsort rows=', rows.length)
function strip(s) {
  return s
    .replace(/<div style="display:none;">[\s\S]*?<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').trim()
}
for (const r of rows.slice(0, 6)) {
  const attr = /<tr[^>]*>/i.exec(r)[0]
  const cells = r.split(/(?=<t[dh][\s>])/i).slice(1).map((c) => strip(c))
  console.log('---')
  console.log('attr:', attr.replace(/\s+/g, ' ').slice(0, 300))
  console.log('cells:', JSON.stringify(cells.map((c) => c.slice(0, 90))))
}
// distribute rarity / paths
const dist = new Map()
for (const r of rows) {
  const attr = /<tr[^>]*>/i.exec(r)[0]
  const p1 = /data-param1="([^"]*)"/.exec(attr)?.[1]
  const p2 = /data-param2="([^"]*)"/.exec(attr)?.[1]
  const p3 = /data-param3="([^"]*)"/.exec(attr)?.[1]
  const k = `${p1} | ${p2} | ${p3}`
  dist.set(k, (dist.get(k) || 0) + 1)
}
console.log('\nrarity|primary|secondary distinct=', dist.size)
console.log([...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k} => ${v}`).join('\n'))

// blessing examples
console.log('\n需要祝福 samples:')
for (const r of rows.slice(0, 10)) {
  const cells = r.split(/(?=<t[dh][\s>])/i).slice(1).map((c) => strip(c))
  console.log(' name=', cells[1], '| blessing=', JSON.stringify(cells[3]?.slice(0, 120)))
}

console.log('\n=== broadcast html ===')
const bc = readFileSync(P + '星际和平播报.html', 'utf8')
const text = strip(bc)
console.log(text.slice(0, 2500))

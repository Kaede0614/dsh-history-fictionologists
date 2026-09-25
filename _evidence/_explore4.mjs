import { readFileSync } from 'node:fs'
const P = 'C:\\Users\\masha\\Desktop\\hsr-history-fictionologists\\_probe\\html\\方程一览.html'
const html = readFileSync(P, 'utf8')
const rows = html.split(/(?=<tr[\s>])/i).filter((r) => /class="divsort"/i.test(r))
function strip(s) {
  return s
    .replace(/<div style="display:none;">[\s\S]*?<\/div>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#160;|&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
const items = []
for (const r of rows) {
  const attr = /<tr[^>]*>/i.exec(r)[0]
  const g = (n) => new RegExp(`data-param${n}="([^"]*)"`).exec(attr)?.[1] ?? ''
  const cells = r.split(/(?=<t[dh][\s>])/i).slice(1).map(strip)
  items.push({ name: cells[1], mode: g(5), rarity: g(1), p1: g(2), p2: g(3), version: g(4), blessing: cells[3], content: cells[4] })
}
const modes = new Map()
for (const it of items) modes.set(it.mode, (modes.get(it.mode) || 0) + 1)
console.log('modes:', [...modes.entries()])
const kept = items.filter((it) => !it.mode.includes('千面英雄'))
console.log('kept=', kept.length, 'after exclude')
const rar = new Map()
for (const it of kept) rar.set(it.rarity, (rar.get(it.rarity) || 0) + 1)
console.log('rarity:', [...rar.entries()])
const paths = new Map()
for (const it of kept) paths.set(it.p1, (paths.get(it.p1) || 0) + 1)
console.log('primary paths:', [...paths.entries()].sort((a, b) => b[1] - a[1]))
console.log('\nnames by rarity:')
for (const rar2 of ['4星', '3星', '2星', '1星']) {
  const ns = kept.filter((k) => k.rarity === rar2).map((k) => k.name)
  console.log(rar2, `(${ns.length})`, ns.join(' / '))
}
console.log('\nname length dist:', JSON.stringify([...kept.reduce((m, k) => m.set(k.name.length, (m.get(k.name.length) || 0) + 1), new Map())].sort((a, b) => a[0] - b[0])))
console.log('\nblessing formats sample:', JSON.stringify(kept.slice(0, 3).map((k) => k.blessing)))
console.log('content len avg:', Math.round(kept.reduce((n, k) => n + k.content.length, 0) / kept.length))
console.log('names with 的:', kept.filter((k) => k.name.includes('的')).length)

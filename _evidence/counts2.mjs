// Scratch 2: precise row classification (offline)
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = 'C:/Users/masha/Desktop/hsr-history-fictionologists/_probe/html'
const load = (n) => readFile(join(DIR, `${n}.html`), 'utf8')

function splitTables(html) {
  const res = []
  let i = 0
  while (res.length < 80) {
    const s = html.indexOf('<table', i)
    if (s < 0) break
    let depth = 0
    let j = s
    while (j < html.length) {
      const open = html.indexOf('<table', j + 1)
      const close = html.indexOf('</table>', j + 1)
      if (close < 0) { j = html.length; break }
      if (open >= 0 && open < close) { depth++; j = open } else {
        if (depth === 0) { j = close + 8; break }
        depth--; j = close
      }
    }
    res.push(html.slice(s, j))
    i = j
  }
  return res
}

function rowsWithDepth(table) {
  const re = /<table\b[^>]*>|<\/table>|<tr[\s>]/gi
  const marks = []
  let m
  let depth = 0
  while ((m = re.exec(table))) {
    const tok = m[0]
    if (tok.startsWith('</')) depth--
    else if (/^<tr/i.test(tok)) marks.push({ idx: m.index, depth: depth + 1 })
    else depth++
  }
  return marks.map((mk, i) => ({ depth: mk.depth, html: table.slice(mk.idx, i + 1 < marks.length ? marks[i + 1].idx : table.length) }))
}

const plain = (s) => s
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const cells = (r) => r.split(/(?=<t[dh][\s>])/i).slice(1)
const param = (r, n) => new RegExp(`data-param${n}="([^"]*)"`).exec(r)?.[1]

for (const f of ['方程一览', '事件一览', '奇物一览_差分_', '消耗品筛选', '装饰一览']) {
  const html = await load(f)
  const t = splitTables(html).find((x) => /id="CardSelectTr"/.test(x))
  const all = rowsWithDepth(t)
  const maxDepth = Math.max(...all.map((r) => r.depth))
  const nestedTables = (t.match(/<table\b/gi) ?? []).length
  const data = all.filter((r) => /data-param1=/.test(/^<tr[^>]*>/.exec(r.html)[0]))
  const nonData = all.filter((r) => !data.includes(r))
  console.log(`\n=== ${f}: rows=${all.length} maxDepth=${maxDepth} tablesInChunk=${nestedTables} dataRows=${data.length} nonData=${nonData.length}`)
  nonData.slice(0, 6).forEach((r) => console.log(`   NON: depth${r.depth} ${plain(r.html).slice(0, 90)}`))
  console.log('   depths of data rows:', [...new Set(data.map((d) => d.depth))].join(','))
  if (f === '事件一览') {
    const hero = data.filter((r) => (param(r.html, 1) ?? '').includes('千面英雄'))
    const heroAny = data.filter((r) => r.html.includes('千面英雄'))
    console.log(`   dataRows=${data.length} heroInParam1=${hero.length} heroAnywhere=${heroAny.length} => entries=${data.length - hero.length}`)
    const modeCount = new Map()
    for (const r of data) modeCount.set(param(r.html, 1), (modeCount.get(param(r.html, 1)) ?? 0) + 1)
    console.log('   modes(param1):', [...modeCount.entries()].map(([k, v]) => `${k}=${v}`).join(' | '))
    const cellMode = data.filter((r) => (cells(r.html)[2] ?? '').includes('千面英雄')).length
    console.log(`   heroInCell2=${cellMode}`)
  }
  if (f === '方程一览') {
    const hero = data.filter((r) => (param(r.html, 5) ?? '').includes('千面英雄'))
    const heroCell = data.filter((r) => (cells(r.html)[2] ?? '').includes('千面英雄'))
    console.log(`   dataRows=${data.length} heroParam5=${hero.length} heroCell2=${heroCell.length} => entries=${data.length - hero.length}`)
  }
  if (f === '消耗品筛选') {
    const exact = data.filter((r) => plain(cells(r.html)[3] ?? '') === '翁法罗斯')
    console.log(`   dataRows=${data.length} amphExactCell3=${exact.length} => entries=${data.length - exact.length}`)
    const c = cells(data[0].html)
    console.log('   cell0:', JSON.stringify(plain(c[0]).slice(0, 60)), 'cell3:', JSON.stringify(plain(c[3])))
    console.log('   data0 attrs:', /^<tr[^>]*>/.exec(data[0].html)[0])
  }
  if (f === '奇物一览_差分_') {
    const modeCount = new Map()
    for (const r of data) modeCount.set(param(r.html, 1), (modeCount.get(param(r.html, 1)) ?? 0) + 1)
    console.log('   modes(param1):', [...modeCount.entries()].map(([k, v]) => `${k}=${v}`).join(' | '))
    const c = cells(data[0].html)
    console.log('   data0 cells:', c.map((x, i) => `[${i}]"${plain(x).slice(0, 30)}"`).join(' '))
  }
  if (f === '装饰一览') {
    const c = cells(data[0].html)
    console.log('   data0 cells:', c.map((x, i) => `[${i}]"${plain(x).slice(0, 30)}"`).join(' '))
    console.log('   data0 attrs:', /^<tr[^>]*>/.exec(data[0].html)[0])
  }
}

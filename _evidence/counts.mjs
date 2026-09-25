// Scratch: verify row/param counts per list table (offline, read-only on _probe)
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

/** rows with the <table> nesting depth at which each row sits */
function rowsWithDepth(table) {
  const out = []
  const re = /<table\b[^>]*>|<\/table>|<tr[\s>]/gi
  let m
  let depth = 0
  let lastRowStart = -1
  while ((m = re.exec(table))) {
    const tok = m[0]
    if (tok.startsWith('</')) depth--
    else if (tok.toLowerCase().startsWith('<tr')) {
      // row start; record
      out.push({ idx: m.index, depth, chunkStart: lastRowStart })
      lastRowStart = m.index
    } else depth++
  }
  const rows = []
  for (let i = 0; i < out.length; i++) {
    const start = out[i].idx
    const end = i + 1 < out.length ? out[i + 1].idx : table.length
    rows.push({ depth: out[i].depth, html: table.slice(start, end) })
  }
  return rows
}

const files = ['方程一览', '事件一览', '奇物一览_差分_', '消耗品筛选', '装饰一览']
for (const f of files) {
  const html = await load(f)
  const t = splitTables(html).find((x) => /id="CardSelectTr"/.test(x))
  if (!t) { console.log(`${f}: NO TABLE`); continue }
  const raw = t.split(/(?=<tr[\s>])/i).slice(1)
  const deep = rowsWithDepth(t)
  const flatParam = raw.filter((r) => /^<tr[^>]*data-param1/.test(r)).length
  const deepRows = deep.filter((r) => r.depth === 0)
  const deepParam = deepRows.filter((r) => /^<tr[^>]*data-param1/.test(r.html)).length
  const deepNestedParam = deep.filter((r) => r.depth > 0 && /^<tr[^>]*data-param1/.test(r.html)).length
  const hero = deepRows.filter((r) => /^<tr[^>]*data-param1="[^"]*千面英雄/.test(r.html)).length
  const heroAny = deepRows.filter((r) => /^<tr[^>]*data-param1="[^"]*千面英雄/.test(r.html) || r.html.includes('千面英雄')).length
  const amph = deepRows.filter((r) => {
    const cells = r.html.split(/(?=<t[dh][\s>])/i).slice(1)
    return cells[3] !== undefined && /^\s*翁法罗斯\s*$/.test(cells[3].replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim())
  }).length
  const amphAny = deepRows.filter((r) => r.html.includes('翁法罗斯')).length
  console.log(`${f}: flatRows=${raw.length} flatParamRows=${flatParam} | depth0Rows=${deepRows.length} depth0ParamRows=${deepParam} nestedParamRows=${deepNestedParam} | heroParam1=${hero} heroAny=${heroAny} | amphCell3exact=${amph} amphAny=${amphAny}`)
  // sample attrs of a couple of data rows
  const sample = deepRows.filter((r) => /^<tr[^>]*data-param1/.test(r.html)).slice(0, 1)[0]
  if (sample) console.log('   sample attrs:', /^<tr[^>]*>/.exec(sample.html)[0])
  const cellsOf = (r) => r.split(/(?=<t[dh][\s>])/i).slice(1)
  if (sample) {
    const cs = cellsOf(sample.html)
    console.log('   cellCount:', cs.length, cs.map((c, i) => `[${i}]len${c.length}`).join(' '))
  }
}
// curios: mode distribution
{
  const html = await load('奇物一览_差分_')
  const t = splitTables(html).find((x) => /id="CardSelectTr"/.test(x))
  const deepRows = rowsWithDepth(t).filter((r) => r.depth === 0 && /^<tr[^>]*data-param1/.test(r.html))
  const modes = new Map()
  for (const r of deepRows) {
    const m = /data-param1="([^"]*)"/.exec(r.html)[1]
    modes.set(m, (modes.get(m) ?? 0) + 1)
  }
  console.log('curios modes:', [...modes.entries()].map(([k, v]) => `${k}=${v}`).join(' '))
}
// events: mode distribution over data rows
{
  const html = await load('事件一览')
  const t = splitTables(html).find((x) => /id="CardSelectTr"/.test(x))
  const deepRows = rowsWithDepth(t).filter((r) => r.depth === 0 && /^<tr[^>]*data-param1/.test(r.html))
  const modes = new Map()
  for (const r of deepRows) {
    const m = /data-param1="([^"]*)"/.exec(r.html)[1]
    modes.set(m, (modes.get(m) ?? 0) + 1)
  }
  console.log('events modes:', [...modes.entries()].map(([k, v]) => `${k}=${v}`).join(' '))
}
// equations mode distribution + name cells
{
  const html = await load('方程一览')
  const t = splitTables(html).find((x) => /id="CardSelectTr"/.test(x))
  const deepRows = rowsWithDepth(t).filter((r) => r.depth === 0 && /^<tr[^>]*data-param1/.test(r.html))
  const modes = new Map()
  for (const r of deepRows) {
    const m = /data-param5="([^"]*)"/.exec(r.html)?.[1] ?? 'NONE'
    modes.set(m, (modes.get(m) ?? 0) + 1)
  }
  console.log('equations param5:', [...modes.entries()].map(([k, v]) => `${k}=${v}`).join(' '))
}

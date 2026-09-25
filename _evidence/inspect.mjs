// Scratch: structural inspection of _probe/html/*.html (read-only, writes _evidence/inspect.txt)
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = 'C:/Users/masha/Desktop/hsr-history-fictionologists/_probe/html'
const out = []
const log = (s = '') => out.push(s)

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
const rows = (t) => t.split(/(?=<tr[\s>])/i).slice(1)
const cells = (r) => r.split(/(?=<t[dh][\s>])/i).slice(1)
const plain = (s) => s.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&#160;|&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
const load = (n) => readFile(join(DIR, `${n}.html`), 'utf8')

// 1. equations: effect cell (cell[4]) raw + cleaned
{
  const html = await load('方程一览')
  const t = splitTables(html).find((x) => x.includes('id="CardSelectTr"'))
  const rs = rows(t).filter((r) => /^<tr[^>]*data-param1/.test(r))
  log(`### equations dataRows=${rs.length}`)
  const r = rs[0]
  log(`attrs=${/^<tr[^>]*>/.exec(r)[0]}`)
  const cs = cells(r)
  log(`cellCount=${cs.length}`)
  cs.forEach((c, i) => log(`  [${i}] rawLen=${c.length} cleaned="${plain(c).slice(0, 120)}"`))
  log(`--- cell[4] RAW (first 2500) ---`)
  log(cs[4].slice(0, 2500))
  log(`--- cell[1] RAW ---`)
  log(cs[1].slice(0, 800))
}

// 2. relics / lightcones cards
for (const [name, cls] of [['遗器图鉴', 'divsort'], ['光锥图鉴', 'divsort']]) {
  const html = await load(name)
  const parts = html.split(/(?=<div class="divsort")/i).slice(1)
  log(`\n### ${name} divsortChunks=${parts.length}`)
  log(`chunk0 head: ${parts[0].slice(0, 260)}`)
  // balanced slice
  const bal = []
  for (const p of parts) {
    let depth = 0, i = 0, end = p.length
    const re = /<div[\s>]|<\/div>/gi
    let m
    while ((m = re.exec(p))) {
      if (m[0].startsWith('</')) { depth--; if (depth === 0) { end = m.index + m[0].length; break } } else depth++
    }
    bal.push(p.slice(0, end))
  }
  log(`balanced[0] len=${bal[0].length}`)
  const m = /class="rel[^"]*name"[\s\S]{0,400}|class="weapon-name"[\s\S]{0,400}/.exec(bal[0])
  log(`nameBlock: ${m ? m[0].slice(0, 400) : 'NONE'}`)
  log(`nameBlock all: ${(bal[0].match(/<div class="(relicset-name|weapon-name)">[\s\S]*?<\/div>/g) ?? []).join(' || ')}`)
  log(`attr tags: ${/^<div[^>]*>/.exec(bal[0])[0]}`)
}

// 3. aeons: h2 sections + wikitable inside first god
{
  const html = await load('星神')
  const hs = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], raw: m[2], idx: m.index, end: m.index + m[0].length }))
  log(`\n### 星神 headings=${hs.length}`)
  for (const h of hs.slice(0, 4)) log(`  h${h.level} id=${/id="([^"]*)"/.exec(h.raw)?.[1]} title="${plain(h.raw)}" idx=${h.idx}`)
  const sec = html.slice(hs[2].end, hs[3].idx)
  log(`--- section 「开拓」 len=${sec.length} ---`)
  log(sec.slice(0, 2400))
}

// 4. factions: h3 section + h2 section raw
{
  const html = await load('派系')
  const hs = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], raw: m[2], idx: m.index, end: m.index + m[0].length, title: plain(m[2]) }))
  log(`\n### 派系 headings=${hs.length} h2=${hs.filter((h) => h.level === 2).length} h3=${hs.filter((h) => h.level === 3).length} h4=${hs.filter((h) => h.level === 4).length}`)
  const i = hs.findIndex((h) => h.title === '无名客')
  const sec = html.slice(hs[i].end, hs[i + 1].idx)
  log(`--- 无名客 section len=${sec.length} ---`)
  log(sec.slice(0, 2000))
  const j = hs.findIndex((h) => h.title === '开拓')
  const sec2 = html.slice(hs[j].end, hs[j + 1].idx)
  log(`--- 开拓(h2) section len=${sec2.length} ---`)
  log(sec2.slice(0, 800))
}

// 5. terms: h3 section + h2 section raw
{
  const html = await load('专有名词')
  const hs = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], idx: m.index, end: m.index + m[0].length, title: plain(m[2]) }))
  log(`\n### 专有名词 headings=${hs.length} h2=${hs.filter((h) => h.level === 2).length} h3=${hs.filter((h) => h.level === 3).length}`)
  const i = hs.findIndex((h) => h.title === '虚数之树')
  log(`--- 虚数之树 len=${html.slice(hs[i].end, hs[i + 1].idx).length} ---`)
  log(html.slice(hs[i].end, hs[i + 1].idx).slice(0, 1400))
  const j = hs.findIndex((h) => h.title === '名词')
  log(`--- 名词(h2) len=${html.slice(hs[j].end, hs[j + 1].idx).length} ---`)
  log(html.slice(hs[j].end, hs[j + 1].idx).slice(0, 600))
}

// 6. broadcast: h4 sections
{
  const html = await load('星际和平播报')
  const hs = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], idx: m.index, end: m.index + m[0].length, title: plain(m[2]) }))
  log(`\n### 播报 headings=${hs.map((h) => 'h' + h.level + ':' + h.title).join(' | ')}`)
  const h4s = hs.filter((h) => h.level === 4)
  log(`h4 count=${h4s.length}`)
  log(`--- h4[0] section raw len=${html.slice(h4s[0].end, h4s[1].idx).length} ---`)
  log(html.slice(h4s[0].end, h4s[0].end + 1800))
  log(`--- tail of last h4 section (300) ---`)
  log(html.slice(html.length - 400))
}

// 7. simuniverse: h2 模拟宇宙图鉴 boundaries
{
  const html = await load('模拟宇宙')
  const hs = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({ level: +m[1], idx: m.index, end: m.index + m[0].length, title: plain(m[2]) }))
  log(`\n### 模拟宇宙 headings=${hs.map((h) => 'h' + h.level + ':' + h.title).join(' | ')}`)
  const i = hs.findIndex((h) => h.level === 2 && h.title.includes('模拟宇宙图鉴'))
  const nextH2 = hs.slice(i + 1).find((h) => h.level === 2)
  const sec = html.slice(hs[i].end, nextH2 ? nextH2.idx : html.length)
  log(`section len=${sec.length} respTabCount=${(sec.match(/resp-tab-content/g) ?? []).length} hr=${(sec.match(/<hr\s*\/?>/g) ?? []).length} kaifa=${(sec.match(/开发日志\d+/g) ?? []).length}`)
  log(`kaifa total on page=${(html.match(/开发日志\d+/g) ?? []).length}`)
  const stari = sec.indexOf('id="星神"')
  const sub = sec.slice(stari, stari + 3000)
  log(`--- 星神 subsection head ---`)
  log(sub)
}
const target = 'C:/Users/masha/Desktop/hsr-history-fictionologists/_evidence/inspect.txt'
await writeFile(target, out.join('\n'), 'utf8')
console.log(`wrote ${target} chars=${out.join('\n').length}`)

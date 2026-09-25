import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WS = 'C:\\Users\\masha\\Desktop\\hsr-history-fictionologists'
const S = join(WS, 'hsr-missions', 'sr-开拓续闻-完整')
const f = join(S, '狐斋志异', '01_游园惊梦.json')
const m = JSON.parse(readFileSync(f, 'utf8'))
console.log('bytes=', statSync(f).size)
console.log('keys:', Object.keys(m))
for (const [k, v] of Object.entries(m)) {
  const t = Array.isArray(v) ? `array(${v.length})` : typeof v
  let extra = ''
  if (typeof v === 'string') extra = JSON.stringify(v.slice(0, 120))
  if (Array.isArray(v) && v.length && typeof v[0] === 'object') extra = 'elemKeys=' + JSON.stringify(Object.keys(v[0]))
  if (Array.isArray(v) && v.length && typeof v[0] !== 'object') extra = JSON.stringify(v.slice(0, 12))
  console.log(' ', k, '=>', t, extra)
}
console.log('章节 sample:', JSON.stringify(m['剧情内容'].slice(0, 3).map((c) => ({ 章节: c['章节'], 文本len: c['文本'].length, head: c['文本'].slice(0, 60) }))))
const emptyCh = m['剧情内容'].filter((c) => !c['章节']).length
console.log('empty 章节 count=', emptyCh)

// field coverage across all missions
const dirs = readdirSync(S).filter((d) => !d.startsWith('_') && statSync(join(S, d)).isDirectory())
const fieldCount = new Map()
const chapterTitleSamples = []
let missions = 0
for (const d of dirs) {
  for (const file of readdirSync(join(S, d))) {
    if (file === '_index.json' || !file.endsWith('.json')) continue
    const j = JSON.parse(readFileSync(join(S, d, file), 'utf8'))
    missions++
    for (const k of Object.keys(j)) fieldCount.set(k, (fieldCount.get(k) || 0) + 1)
    if (chapterTitleSamples.length < 2) chapterTitleSamples.push(j['剧情内容'].map((c) => c['章节']).slice(0, 8))
  }
}
console.log('missions scanned=', missions)
console.log('field coverage:', JSON.stringify([...fieldCount.entries()].sort((a, b) => b[1] - a[1])))
console.log('chapter titles sample:', JSON.stringify(chapterTitleSamples, null, 1))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WS = 'C:\\Users\\masha\\Desktop\\hsr-history-fictionologists'
const M = join(WS, 'hsr-missions')

const t0 = performance.now()
const tb = JSON.parse(readFileSync(join(M, 'trailblaze_missions.json'), 'utf8'))
console.log('PARSE trailblaze ms=', Math.round(performance.now() - t0))
console.log('top keys:', Object.keys(tb))
console.log('stats:', JSON.stringify(tb.stats))
console.log('excluded_acts:', JSON.stringify(tb.excluded_acts))
console.log('acts:', tb.acts.map((a) => a.act))
console.log('act0 keys:', Object.keys(tb.acts[0]))
console.log('act0.series[0] keys:', Object.keys(tb.acts[0].series[0]))
console.log('act0.series[0] series=', tb.acts[0].series[0].series, '| desc=', tb.acts[0].series[0].description)
console.log('act0.series[0].mission0 keys:', Object.keys(tb.acts[0].series[0].missions[0]))
console.log('act0.series[0].meta:', JSON.stringify(tb.acts[0].series[0].missions[0].meta))
let totalMissions = 0
let totalSeries = 0
for (const a of tb.acts) {
  totalMissions += a.series.reduce((n, s) => n + s.missions.length, 0)
  totalSeries += a.series.length
}
console.log('recount: acts=', tb.acts.length, 'series=', totalSeries, 'missions=', totalMissions)
console.log('missions per act:', tb.acts.map((a) => a.series.reduce((n, s) => n + s.missions.length, 0)))
console.log('series-per-act:', tb.acts.map((a) => a.series.map((s) => s.series + '(' + s.missions.length + ')')))

console.log('\n--- adventure ---')
const adv = JSON.parse(readFileSync(join(M, 'adventure_other_tasks_full.json'), 'utf8'))
console.log('keys:', Object.keys(adv), 'chapterCount=', adv.chapterCount, 'taskCount=', adv.taskCount)
console.log('chapters:', adv.chapters.map((c) => c.chapter + '/' + c.taskCount))

console.log('\n--- books ---')
const books = JSON.parse(readFileSync(join(M, 'books_without_amphoreus.json'), 'utf8'))
console.log('length=', books.length, 'isArray=', Array.isArray(books))
const types = new Map()
const regions = new Map()
for (const b of books) {
  types.set(b['类型'], (types.get(b['类型']) || 0) + 1)
  regions.set(b['所属名称'], (regions.get(b['所属名称']) || 0) + 1)
}
console.log('类型 counts:', JSON.stringify([...types.entries()].sort((a, b) => b[1] - a[1])))
console.log('region count:', regions.size)
const charShapes = new Set(books.map((b) => Array.isArray(b['相关角色']) ? 'array' : typeof b['相关角色']))
console.log('相关角色 shapes:', [...charShapes])
console.log('book0 相关角色:', JSON.stringify(books[0]['相关角色']))
console.log('book0 分卷 len:', books[0]['分卷'].length)
const volKeys = new Set()
for (const b of books) for (const v of b['分卷'] || []) for (const k of Object.keys(v)) volKeys.add(k)
console.log('分卷 keys union:', [...volKeys])
let withBody = 0
let totalBody = 0
let maxBody = 0
for (const b of books) for (const v of b['分卷'] || []) { if (typeof v['内容'] === 'string' && v['内容'].length) { withBody++; totalBody += v['内容'].length; maxBody = Math.max(maxBody, v['内容'].length) } }
console.log('vols with body=', withBody, 'total chars=', totalBody, 'max body=', maxBody)
let emptyDesc = 0
for (const b of books) if (!b['描述'] || !String(b['描述']).trim()) emptyDesc++
console.log('books with empty 描述=', emptyDesc)
console.log('empty 类型 count=', books.filter((b) => !b['类型']).length)

console.log('\n--- missions dir listing ---')
import { readdirSync } from 'node:fs'
console.log(readdirSync(join(M, 'sr-开拓续闻-完整')).join(' | '))

/** Scratch: spot-check individual entries for text-quality regressions. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATASETS } from '../lib/wiki/datasets.mjs'
import { extractDataset } from '../lib/wiki/extract.mjs'

const ROOT = 'C:/Users/masha/Desktop/hsr-history-fictionologists'
const load = (name) => readFileSync(join(ROOT, '_probe/html', name), 'utf8')
const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/wikitext.json'), 'utf8'))

const relics = extractDataset('relics', { html: load('遗器图鉴.html'), wikitextByTitle: fixture.relics })
const cones = extractDataset('lightcones', { html: load('光锥图鉴.html'), wikitextByTitle: fixture.lightcones })
const equations = extractDataset('equations', { html: load('方程一览.html') })
const broadcast = extractDataset('broadcast', { html: load('星际和平播报.html') })

const show = (label, value, limit = 400) => console.log(`\n--- ${label} ---\n${String(value).slice(0, limit)}`)

const guard = relics.entries.find((entry) => entry.name === '戍卫风雪的铁卫')
show('relics/戍卫风雪的铁卫', JSON.stringify(guard, null, 2), 1400)
const talia = relics.entries.find((entry) => entry.name === '盗贼公国塔利亚')
show('relics/盗贼公国塔利亚 parts', JSON.stringify(talia.parts, null, 2), 900)
const empty = relics.entries.find((entry) => entry.name === '戏梦点星的伶人')
show('relics/戏梦点星的伶人', JSON.stringify(empty, null, 2), 400)
const cone = cones.entries.find((entry) => entry.name === '向浪花掷下盛夏')
show('lightcones/向浪花掷下盛夏', JSON.stringify(cone, null, 2), 900)

const withTooltipAnchor = equations.entries.filter((entry) => entry.content.includes('羽化'))
show('equations rows whose effect mentions 羽化 (anchor text kept)', withTooltipAnchor.length, 100)
const poisoned = equations.entries.filter((entry) => entry.content.includes('无视目标30%的全属性抗性'))
show('equations rows containing the SMW tooltip BODY (must be 0)', poisoned.length, 100)
const cssLeak = equations.entries.filter((entry) => entry.content.includes('background-image') || entry.name.includes('{'))
show('equations rows leaking CSS (must be 0)', cssLeak.length, 100)

const heroRows = equations.entries.filter((entry) => entry.mode.includes('千面英雄') || entry.content.includes('千面英雄'))
show('equations entries still carrying 千面英雄 (must be 0)', heroRows.length, 100)

show('broadcast 全文 head', broadcast.entries[0].content.slice(0, 300), 320)
show('broadcast chapter names', broadcast.entries.map((entry) => `${entry.name}(${entry.content.length})`).join(' | '), 500)
show('broadcast keeps 女声/男声/（音乐）', [broadcast.entries[0].content.includes('女声：'), broadcast.entries[0].content.includes('男声：'), broadcast.entries[0].content.includes('（音乐）')].join(','), 100)

const missingName = []
for (const dataset of DATASETS) {
  const html = dataset.needsWikitext ? load(dataset.fixture) : load(dataset.fixture)
  const wikitextByTitle = dataset.needsWikitext ? (fixture[dataset.id] ?? {}) : {}
  const result = extractDataset(dataset.id, { html, wikitextByTitle })
  const bad = result.entries.filter((entry) => typeof entry.name !== 'string' || entry.name.length === 0)
  missingName.push(`${dataset.id}:${bad.length}`)
}
show('entries without a name per dataset', missingName.join(' '), 300)

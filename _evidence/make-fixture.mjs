/**
 * Scratch: build `test/fixtures/wikitext.json` for the offline extractor replay.
 *
 * The two real pages (向浪花掷下盛夏 / 戏梦点星的伶人) are copied verbatim out of
 * `_probe/wikitext.txt` (captured from the live API). The remaining entries are
 * hand-made structural fixtures and are labelled `[fixture]` inside the text so
 * they can never be mistaken for wiki content. `test/fixtures/wikitext-live.json`
 * (written by real captures) overrides these keys when present.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = 'C:/Users/masha/Desktop/hsr-history-fictionologists'
const probe = readFileSync(`${ROOT}/_probe/wikitext.txt`, 'utf8')

/** Pull `## <title> missing=… bytes=…\n<wikitext>` blocks out of the probe dump. */
function extractProbePages(text) {
  const out = {}
  const re = /##\s+(\S+)\s+missing=(\w+)\s+bytes=(\d+)\n([\s\S]*?)(?=\n={20,}|$)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const [, title, missing, bytes, body] = m
    if (missing !== 'false') continue
    out[title] = { wikitext: body.replace(/\s+$/, ''), bytes: Number(bytes) }
  }
  return out
}

const pages = extractProbePages(probe)
console.log('probe pages:', Object.keys(pages).map((t) => `${t}(${pages[t].bytes}B)`).join(', '))
if (Object.keys(pages).length !== 2) throw new Error('expected 2 real probe pages')

const FIXTURE = '[fixture]'
const relicHandMade = (name, category, slots, version) => {
  const lines = [
    '{{遗器套装',
    `|名称=${name}`,
    `|类别=${category}`,
    `|两件套效果=${FIXTURE} 两件套效果文本`,
    `|四件套效果=${FIXTURE} 四件套效果文本`,
    '|获取方式=侵蚀隧洞',
    '|获取途径=[[侵蚀隧洞]]',
    `|实装版本=${version}`,
    '|TAG=',
  ]
  for (const slot of slots) lines.push(`|${slot}=${FIXTURE} ${slot}装备名`)
  for (const slot of slots) lines.push(`|${slot}描述=${FIXTURE} ${slot}描述文本`)
  for (const slot of slots) {
    lines.push(
      `|${slot}故事=${FIXTURE} ${slot}故事第一行<!-- 行内注释 --><br />${slot}故事第二行<br /><i>「${FIXTURE} ${slot}引文」</i><br />${slot}故事第三行，含{{颜色|描述2|高亮文本}}。`,
    )
  }
  lines.push('}}')
  return lines.join('\n')
}

const fixture = {
  _note:
    'Offline wikitext fixtures for test/wiki.test.mjs. 向浪花掷下盛夏 / 戏梦点星的伶人 are verbatim copies from _probe/wikitext.txt (real API capture). ' +
    'Entries whose text contains [fixture] are hand-made structural fixtures. test/fixtures/wikitext-live.json (real captures) overrides these keys when present.',
  relics: {
    '戏梦点星的伶人': pages['戏梦点星的伶人'].wikitext,
    '戍卫风雪的铁卫': relicHandMade('戍卫风雪的铁卫', '隧洞遗器', ['头部', '手部', '躯干', '脚部'], '1.0'),
    '盗贼公国塔利亚': relicHandMade('盗贼公国塔利亚', '位面饰品', ['位面球', '连结绳'], '1.4'),
  },
  lightcones: {
    向浪花掷下盛夏: pages['向浪花掷下盛夏'].wikitext,
    你将起身歌唱:
      '{{光锥图鉴<!-- 本段为备注信息，以下请在=后填写对应数据-->\n|名称=你将起身歌唱\n|稀有度=5星\n|命途=同谐\n|获取方式=限定跃迁\n|实装版本=3.0\n|光锥故事=' +
      `${FIXTURE} 第一行文本<br /><br /><i>「${FIXTURE} 引文」</i><br />第二行文本，含{{颜色|描述2|高亮}}。\n}}`,
  },
}

writeFileSync(`${ROOT}/test/fixtures/wikitext.json`, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
console.log('wrote test/fixtures/wikitext.json')
for (const [group, entries] of Object.entries(fixture)) {
  if (group.startsWith('_')) continue
  for (const [title, text] of Object.entries(entries)) {
    console.log(`  ${group}/${title}: ${Buffer.byteLength(text, 'utf8')}B hand-made=${text.includes(FIXTURE)}`)
  }
}

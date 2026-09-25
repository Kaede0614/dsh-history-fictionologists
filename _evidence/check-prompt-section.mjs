// Definitive check: is the plugin's style section inside the assembled system prompt
// that the model actually receives? Parses real session-log records instead of
// substring arithmetic (the previous approach compared indices in the wrong order).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESS = process.argv[2] ?? 'C:\\Users\\masha\\hsr-fictionologists-testhome\\sessions'
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
function decode(b) {
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

const MARKER = '## 虚构史学家（/gs）语言风格总则'
let found = null
for (const f of files.sort()) {
  for (const line of decode(readFileSync(f)).split('\n')) {
    if (!line.startsWith('{')) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    // The host materializes an injected prompt section as a durable system message;
    // that record is what proves the guidance actually reaches the model.
    const text = record?.data?.message?.content?.[0]?.text
    if (typeof text !== 'string' || !text.includes(MARKER)) continue
    found = { file: f.split('\\').slice(-2).join('\\'), record, prompt: text }
    break
  }
  if (found) break
}

if (!found) {
  console.log('NO record carries the section — the prompt section is NOT reaching the model.')
  process.exit(1)
}

const { prompt, record } = found
console.log(`log: ${found.file}`)
console.log(`record type=${record.type} seq=${record.seq} role=${record?.data?.message?.role} chars=${prompt.length}`)

// Which tools were in the request that preceded this message?
let tools = []
for (const f of files.sort()) {
  for (const line of decode(readFileSync(f)).split('\n')) {
    if (!line.startsWith('{')) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type === 'request/header' && Array.isArray(rec?.data?.header?.tools)) {
      tools = rec.data.header.tools.map((t) => t?.name).filter((n) => typeof n === 'string' && n.startsWith('gs_'))
    }
  }
}
console.log(`gs_* tools in the request tool list: ${tools.length > 0 ? tools.join(', ') : '(none found)'}`)

console.log('\nchecks (inside the injected prompt text):')
for (const [label, ok] of [
  ['section heading', prompt.includes(MARKER)],
  ['style rule (用最严肃的格式包装最离谱的内容)', prompt.includes('用最严肃的格式包装最离谱的内容')],
  ['feature 1 block 【灵感名称】/命途归属/详细设定/可能的故事方向',
    ['【灵感名称】', '命途归属', '详细设定', '可能的故事方向'].every((s) => prompt.includes(s))],
  ['feature 2 (构史文集 + 荒诞但不轻浮 + 2000 字)', prompt.includes('构史文集') && prompt.includes('荒诞但不轻浮') && prompt.includes('2000')],
  ['feature 3 (女声/男声/（音乐）/本次播报到此结束/800–1200)',
    ['女声：', '男声：', '（音乐）', '本次播报到此结束', '800–1200'].every((s) => prompt.includes(s))],
  ['范围约束（不得凭空编造与既有设定冲突的事实）', prompt.includes('不得凭空编造与既有设定冲突的事实')],
]) console.log(`  ${ok ? 'YES' : 'NO '}  ${label}`)

const at = prompt.indexOf(MARKER)
console.log('\n--- verbatim excerpt from the injected prompt text ---')
console.log(prompt.slice(at, at + 620))

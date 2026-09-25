// Where exactly does the style material appear — the system prompt, or only tool docs?
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESS = 'C:\\Users\\masha\\hsr-fictionologists-testhome\\sessions'
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
const decode = (b) => {
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

let best = ''
let bestFile = ''
for (const f of files) {
  const t = decode(readFileSync(f))
  if (t.length > best.length) { best = t; bestFile = f }
}
console.log('log:', bestFile.split('\\').slice(-2).join('\\'), 'chars:', best.length)

for (const needle of ['虚构史学家', '语言风格总则', '【灵感名称】', 'system-prompt', 'systemPrompt']) {
  const at = best.indexOf(needle)
  console.log(`\n--- "${needle}" first at ${at} ---`)
  if (at >= 0) console.log(best.slice(Math.max(0, at - 260), at + 420).replace(/\\n/g, '\n'))
}

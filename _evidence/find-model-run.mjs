// Which session log contains the model's gs_setup call, and what did the host echo back?
import { readdirSync, readFileSync, statSync } from 'node:fs'
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

for (const f of files.sort((a, b) => statSync(b).size - statSync(a).size)) {
  const text = decode(readFileSync(f))
  const hits = ['gs_setup', '接线自检', 'cacheDir', 'invalid output'].filter((k) => text.includes(k))
  if (hits.length === 0) continue
  console.log(`\n### ${f.split('\\').slice(-1)[0]}  chars=${text.length}  hits=${hits.join(', ')}`)
  // print every line that mentions the interesting pieces
  for (const line of text.split('\n')) {
    if (/gs_setup|接线自检|cacheDir|invalid output|hsr-worldview-cache/.test(line)) {
      console.log('   ', line.slice(0, 400))
    }
  }
}

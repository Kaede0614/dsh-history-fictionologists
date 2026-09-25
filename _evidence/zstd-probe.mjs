// Can Node decompress the host's multi-frame zstd session logs directly?
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const SESSIONS = 'C:\\Users\\masha\\hsr-fictionologists-testhome\\sessions'
const files = []
const walk = (dir, depth = 0) => {
  if (depth > 3) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, depth + 1)
    else if (entry.name.endsWith('.zstd')) files.push(full)
  }
}
walk(SESSIONS)
files.sort((a, b) => statSync(b).size - statSync(a).size)
console.log('zstd files:', files.length)
console.log('zstdDecompressSync available:', typeof zlib.zstdDecompressSync)

const biggest = files[0]
console.log('biggest:', biggest.split('\\').slice(-2).join('\\'), statSync(biggest).size, 'bytes')
const buf = readFileSync(biggest)
console.log('magic:', buf.subarray(0, 4).toString('hex'))

try {
  const out = zlib.zstdDecompressSync(buf)
  const text = out.toString('utf8')
  console.log('decompressed chars:', text.length)
  const marker = /接线自检/.test(text)
  console.log('contains 接线自检 marker:', marker)
  console.log('contains gs_setup:', /gs_setup/.test(text))
  console.log('contains cacheDir:', /cacheDir/.test(text))
  console.log('first 400 chars:', text.slice(0, 400).replace(/\n/g, ' | '))
} catch (error) {
  console.log('single-frame decompress failed:', error.message)
  // try frame-by-frame
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let idx = buf.indexOf(MAGIC)
  while (idx >= 0) {
    starts.push(idx)
    idx = buf.indexOf(MAGIC, idx + 4)
  }
  console.log('frames found:', starts.length)
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      text += zlib.zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8')
    } catch (frameError) {
      console.log(`frame ${i} failed: ${frameError.message}`)
    }
  }
  console.log('frame-by-frame chars:', text.length, '| marker:', /接线自检/.test(text), '| gs_setup:', /gs_setup/.test(text))
}

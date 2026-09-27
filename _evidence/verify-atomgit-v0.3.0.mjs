// Independent check of the AtomGit v0.3.0 release: query the API for the release/asset,
// then download the attachment from the PUBLIC url and compare bytes with the local build.
// The token is read from .atomgit-token and never printed.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const API = 'https://api.atomgit.com/api/v5'
const WEB = 'https://atomgit.com'
const REPO = 'Scombriformes/dsh-history-fictionologists'
const TAG = 'v0.3.0'
const NAME = 'dsh-history-fictionologists-0.3.0.tgz'

let token = ''
try {
  token = readFileSync(join(ROOT, '.atomgit-token'), 'utf8').trim()
} catch {
  token = process.env.ATOMGIT_TOKEN ?? ''
}
if (!token) { console.log('no atomgit token available'); process.exit(1) }
if (token.includes('=')) token = token.slice(token.indexOf('=') + 1).trim()

const res = await fetch(`${API}/repos/${REPO}/releases/tags/${encodeURIComponent(TAG)}`, {
  headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' },
})
console.log('GET release ->', res.status)
let body = null
if (res.ok) {
  const rel = await res.json()
  body = rel
  console.log('name        :', rel.name ?? rel.tag_name)
  console.log('tag         :', rel.tag_name, '| status:', rel.release_status ?? '(none)')
  console.log('body        :', (rel.body ?? '').length, 'chars | first line:', (rel.body ?? '').split('\n')[0])
  const assets = rel.assets ?? rel.attach_files ?? []
  console.log('assets      :', assets.map((a) => `${a.name ?? a.file_name} id=${a.id} url=${a.browser_download_url ?? a.download_url ?? '-'}`).join(', ') || '(none)')
}

const local = readFileSync(join(ROOT, NAME))
const localHash = createHash('sha256').update(local).digest('hex')
const url = `${WEB}/${REPO}/releases/download/${encodeURIComponent(TAG)}/${NAME}`
const dl = await fetch(url, { headers: { 'user-agent': 'dsh-probe' } })
const bytes = Buffer.from(await dl.arrayBuffer())
const remoteHash = createHash('sha256').update(bytes).digest('hex')
console.log(`\nlocal      : ${local.length} bytes sha256 ${localHash.toUpperCase()}`)
console.log(`downloaded : ${bytes.length} bytes sha256 ${remoteHash.toUpperCase()} (HTTP ${dl.status})`)
console.log(`VERDICT: ${local.length === bytes.length && localHash === remoteHash ? 'BYTE-FOR-BYTE MATCH' : 'MISMATCH'}`)

// and the branch must carry the same main as GitHub
console.log(`\nrelease page: ${WEB}/${REPO}/releases/tag/${TAG}`)
console.log('body present:', body !== null)

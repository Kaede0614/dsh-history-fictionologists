/**
 * Measure, don't guess: which factor made GitHub answer 403 on the v0.3.0 asset upload?
 *
 * Two candidates were on the table after the failed publish run:
 *   (1) the HOST — the script posts to api.github.com, but release assets are documented
 *       to live on uploads.github.com;
 *   (2) the METHOD — `scripts/release.mjs` passed its log label `POST_BINARY` straight
 *       into `client.request()`, and the client sends the method verbatim, so the wire
 *       request was literally `POST_BINARY /repos/…/assets HTTP/1.1`.
 *
 * This probe varies one factor at a time through the real client
 * (`lib/release-kit.mjs`), logs the URL/status GitHub actually returned, and deletes the
 * probe assets it created (`upload-host-probe-*`). The real tarball asset is left alone.
 *
 * Run:  node _evidence/github-upload-host-probe.mjs <release-id>
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGitHubClient } from '../lib/release-kit.mjs'

const ROOT = join(import.meta.dirname, '..')
const REPO = 'Kaede0614/dsh-history-fictionologists'
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

function gitCredentialFill() {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['credential', 'fill'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('error', reject)
    p.on('close', () => resolve(out))
    p.stdin.end('protocol=https\nhost=github.com\n\n')
  })
}

const releaseId = Number(process.argv[2] ?? 0)
if (!releaseId) {
  console.error('usage: node _evidence/github-upload-host-probe.mjs <release-id>')
  process.exit(2)
}

const cred = await gitCredentialFill()
const token = (cred.split(/\r?\n/).find((line) => line.startsWith('password=')) ?? '').slice('password='.length)
if (!token) {
  console.error('no GitHub token in the git credential manager')
  process.exit(2)
}

const tarball = readFileSync(join(ROOT, 'dsh-history-fictionologists-0.3.0.tgz'))
const small = Buffer.from('probe')

/** Records the request that actually went on the wire, without changing it. */
function loggingFetch(log) {
  return async (url, init = {}) => {
    const res = await fetch(url, init)
    const text = await res.text()
    log.push(
      `${String(init.method).padEnd(12)} ${url.replace(/^https:\/\//, '').slice(0, 78)}` +
        ` -> ${res.status}${text.includes('Access to this site has been restricted') ? ' BLOCK-PAGE' : ''}`,
    )
    return { status: res.status, headers: res.headers, text: async () => text }
  }
}

/**
 * One case, using the real client. `method` is passed through verbatim on purpose:
 * that is exactly how the defect reached the network.
 */
async function run(label, { method, host, body, name }) {
  const log = []
  const client = createGitHubClient({ token, fetchImpl: loggingFetch(log) })
  const extra = { rawBody: body, headers: { 'content-type': 'application/octet-stream' } }
  const path = `/repos/${REPO}/releases/${releaseId}/assets?name=${name}`
  // Host is chosen by the client's two configurations, not by the caller: `upload: true`
  // means uploads.github.com, a plain call means api.github.com.
  const res = await client.request(method, path, undefined, host === 'uploads' ? { ...extra, upload: true } : extra)
  console.log(`${label}`)
  for (const line of log) console.log(`  ${line}`)
  return { status: res.status, id: res.data?.id ?? null }
}

const cases = {}
cases.a = await run('A) method POST        + uploads.github.com + real tarball', { method: 'POST', host: 'uploads', body: tarball, name: 'dsh-history-fictionologists-0.3.0.tgz' })
cases.b = await run('B) method POST        + uploads.github.com + 5 bytes', { method: 'POST', host: 'uploads', body: small, name: 'upload-host-probe-b.txt' })
cases.c = await run('C) method POST        + api.github.com     + 5 bytes', { method: 'POST', host: 'api', body: small, name: 'upload-host-probe-c.txt' })
cases.d = await run('D) method POST_BINARY + uploads.github.com + 5 bytes', { method: 'POST_BINARY', host: 'uploads', body: small, name: 'upload-host-probe-d.txt' })
cases.e = await run('E) method POST_BINARY + api.github.com     + 5 bytes', { method: 'POST_BINARY', host: 'api', body: small, name: 'upload-host-probe-e.txt' })

console.log('\nRIDGE — same token, same release, one factor at a time')
console.log(`  POST        + uploads.github.com : ${cases.a.status} / ${cases.b.status}   (tarball / 5 bytes)`)
console.log(`  POST        + api.github.com     : ${cases.c.status}`)
console.log(`  POST_BINARY + uploads.github.com : ${cases.d.status}`)
console.log(`  POST_BINARY + api.github.com     : ${cases.e.status}`)
console.log(`  tarball asset id (keep): ${cases.a.id}`)

// cleanup: remove everything this probe created except the real tarball asset
const listed = await fetch(`${API}/repos/${REPO}/releases/${releaseId}/assets`, {
  headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-probe' },
})
const assets = listed.ok ? await listed.json() : []
for (const asset of assets) {
  if (!String(asset.name).startsWith('upload-host-probe-')) continue
  const del = await fetch(`${API}/repos/${REPO}/releases/assets/${asset.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-probe' },
  })
  console.log(`cleanup: DELETE ${asset.name} (${asset.id}) -> ${del.status}`)
}
console.log('assets left:', (assets.filter((a) => !String(a.name).startsWith('upload-host-probe-')).map((a) => `${a.name} ${a.size}B`).join(', ')) || '(none)')

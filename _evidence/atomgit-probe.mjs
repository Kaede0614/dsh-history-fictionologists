/**
 * Read-only probes against api.atomgit.com — the evidence behind docs/atomgit-description.md.
 *
 * Touches nothing: every call here is a GET, and the one token-dependent call only reads
 * `/user`. Run it to re-derive the platform facts the release toolchain is built on:
 *
 *   node _evidence/atomgit-probe.mjs > _evidence/atomgit-probe.txt
 *
 * It reads the token from `.atomgit-token` (or %ATOMGIT_TOKEN%) and **never prints any part
 * of it** — not even a prefix, because this report is committed to the repository.
 *
 * Why the transport matters: "this repository does not exist" answers 404 over Node's
 * `fetch`, 403 over `git ls-remote`, and 401 through PowerShell's web cmdlets. The release
 * scripts use `fetch`, so this probe uses `fetch` too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseAtomgitSlug, resolveAtomgitToken } from '../lib/atomgit-kit.mjs'

const ROOT = join(import.meta.dirname, '..')
const API = 'https://api.atomgit.com/api/v5'
const OWNER = 'Scombriformes'
const ABSENT = `${OWNER}/definitely-not-real-xyz`

const { token, source } = resolveAtomgitToken({ root: ROOT })
const authed = token === null ? {} : { 'PRIVATE-TOKEN': token }

console.log(`api        ${API}`)
console.log(`token      ${token === null ? 'NONE' : `found via ${source}, ${token.length} characters (content never printed)`}`)
console.log('')

async function probe(label, path, headers = {}) {
  let line
  try {
    const response = await fetch(`${API}${path}`, { headers })
    const text = await response.text()
    const body = text.replace(/\s+/g, ' ').slice(0, 150)
    line = `${String(response.status).padEnd(4)} ${body}`
  } catch (error) {
    line = `THREW ${error instanceof Error ? error.message : String(error)}`
  }
  console.log(`${label.padEnd(42)} -> ${line}`)
}

console.log('--- anonymous (no token) ---')
await probe(`GET /users/${OWNER}`, `/users/${OWNER}`)
await probe(`GET /repos/${ABSENT}`, `/repos/${ABSENT}`)
await probe(`GET /repos/${ABSENT}/branches`, `/repos/${ABSENT}/branches`)

if (token !== null) {
  console.log('')
  console.log('--- with PRIVATE-TOKEN ---')
  await probe('GET /user', '/user', authed)
  await probe(`GET /repos/${ABSENT}`, `/repos/${ABSENT}`, authed)
  await probe(`GET /repos/${ABSENT}/branches`, `/repos/${ABSENT}/branches`, authed)
  await probe(`GET /repos/${ABSENT}/releases`, `/repos/${ABSENT}/releases`, authed)
  await probe(`GET /repos/${ABSENT}/releases/tags/v0.2.1`, `/repos/${ABSENT}/releases/tags/v0.2.1`, authed)
}

console.log('')
console.log('--- slug guard (must NOT accept a GitHub URL) ---')
for (const value of [
  'https://atomgit.com/Scombriformes/dsh-history-fictionologists.git',
  'git@atomgit.com:Scombriformes/dsh-history-fictionologists.git',
  'Scombriformes/dsh-history-fictionologists',
  'https://github.com/Kaede0614/dsh-history-fictionologists.git',
]) {
  console.log(`${String(parseAtomgitSlug(value)).padEnd(44)} <- ${value}`)
}

// A non-zero exit is not an error here: the probes are expected to answer 401/403/404 when
// the token is absent or unscoped. This line only exists so the report states its conclusion.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
console.log('')
console.log(`probe complete for ${pkg.name}@${pkg.version}; no writes were attempted.`)

/**
 * Release automation helper for dsh-history-fictionologists.
 *
 * WHY THIS EXISTS — the machine this project is developed on has neither the GitHub
 * CLI nor a usable `npm`:
 *   - `gh` is absent from PATH entirely, so `gh release create` cannot run;
 *   - `npm` exists only as `npm.ps1` (blocked by the PowerShell execution policy) plus
 *     `npm.cmd`, which dies with EPERM when it tries to write `%LOCALAPPDATA%\npm-cache`.
 *
 * Both are environmental, not project, problems — and both have the same answer: do the
 * work with `node`, which is always present, against the GitHub REST API directly over
 * `fetch` (verified working on this host). So this module packs the tarball itself and
 * talks to api.github.com itself; `gh` and `npm` are never invoked. Binary release assets
 * go to `uploads.github.com` — see `DEFAULT_UPLOAD_API` for the measured reason.
 *
 * Everything here is PURE or INJECTABLE so it can be unit-tested offline: the tarball
 * builder/reader touch only the given root, and every network call takes a `fetchImpl`.
 *
 * @module dsh-history-fictionologists/lib/release-kit
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

/** api.github.com root (overridable for tests / GitHub Enterprise). */
export const DEFAULT_API = 'https://api.github.com'

/**
 * Uploads host for release assets — a DIFFERENT host from the REST API, and that is not
 * cosmetic.
 *
 * MEASURED 2026-09-27 on v0.3.0, same token, same release, same bytes:
 *   POST https://api.github.com/repos/<o>/<r>/releases/<id>/assets?name=…   -> 403
 *        (an HTML page: "Access to this site has been restricted.", `Forbidden · GitHub`)
 *   POST https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets?name=… -> 201 Created
 * The 403 is indistinguishable from a token/scope problem in a bare status-code dump — the
 * token had `repo` scope and had just PATCHed the release successfully with the same client.
 * So binary assets MUST go to this host, never to the API root.
 */
export const DEFAULT_UPLOAD_API = 'https://uploads.github.com'

/** Header the GitHub API rejects requests without. */
export const USER_AGENT = 'dsh-history-fictionologists-release'

// ---------------------------------------------------------------------------
// repository / token resolution
// ---------------------------------------------------------------------------

/**
 * Parse a GitHub repository reference into `owner/repo`.
 *
 * Accepts every form this project uses: the `repository.url` field in package.json
 * (`git+https://github.com/o/r.git`), a bare `https://` or `git@` clone URL, the
 * `github:o/r` shorthand the README recommends, or a plain `o/r` slug.
 *
 * @param {string} value
 * @returns {string|null} `owner/repo`, or null when it cannot be determined
 */
export function parseRepoSlug(value) {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (text.length === 0) return null

  text = text.replace(/^git\+/, '')
  const shorthand = /^github:([^/\s]+)\/([^/\s#?]+)$/.exec(text)
  if (shorthand) return clean(`${shorthand[1]}/${shorthand[2]}`)

  const scp = /^[^@\s]+@[^:\s]+:([^/\s]+)\/([^/\s#?]+)$/.exec(text)
  if (scp) return clean(`${scp[1]}/${scp[2]}`)

  const url = /^(?:https?|git|ssh):\/\/[^/\s]+\/([^/\s]+)\/([^/\s#?]+)$/.exec(text)
  if (url) return clean(`${url[1]}/${url[2]}`)

  const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(text)
  if (bare) return clean(`${bare[1]}/${bare[2]}`)

  return null
}

function clean(slug) {
  const stripped = slug.replace(/\.git$/i, '')
  return /^[^/]+\/[^/]+$/.test(stripped) ? stripped : null
}

/**
 * Resolve a GitHub token from the environment, then from a local file.
 *
 * Priority: `GH_TOKEN` → `GITHUB_TOKEN` → `<root>/.gh-token` (gitignored). The file
 * route exists because this project's shell cannot persist environment variables for
 * the user's own terminal, and because pasting a token into a file is less error-prone
 * than a 40-character inline env assignment.
 *
 * The value is never logged by this module.
 *
 * @param {{root?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {{token: string|null, source: string}}
 */
export function resolveToken({ root = '.', env = process.env } = {}) {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) {
      return { token: value.trim(), source: `env:${name}` }
    }
  }
  try {
    const raw = readFileSync(join(root, '.gh-token'), 'utf8')
    // Tolerate the trailing newline every editor adds, a `GH_TOKEN=...` paste, a shell
    // `export GH_TOKEN=...` paste, and comments.
    for (const line of raw.split(/\r?\n/)) {
      const text = line.replace(/^\s*(?:export\s+)?(?:GH_TOKEN|GITHUB_TOKEN)\s*=\s*/, '').trim()
      if (text.length > 0 && !text.startsWith('#')) return { token: text, source: '.gh-token' }
    }
  } catch {
    // No file is the normal state on a fresh clone; fall through.
  }
  return { token: null, source: 'none' }
}

// ---------------------------------------------------------------------------
// package metadata
// ---------------------------------------------------------------------------

/**
 * Read `package.json` and derive the release facts from it.
 * @param {string} root
 * @returns {{name: string, version: string, tag: string, files: string[], description: string, repository: string|null, tarballName: string}}
 */
export function readPackageFacts(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const name = typeof pkg.name === 'string' ? pkg.name : ''
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  if (name.length === 0 || version.length === 0) {
    throw new Error('package.json is missing a usable "name" or "version"')
  }
  return {
    name,
    version,
    tag: `v${version}`,
    files: Array.isArray(pkg.files) ? pkg.files : [],
    description: typeof pkg.description === 'string' ? pkg.description : '',
    repository: parseRepoSlug(pkg.repository?.url ?? pkg.repository ?? ''),
    // npm names the tarball after the package name, scoped names with `/` → `-`.
    tarballName: `${name.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`,
  }
}

// ---------------------------------------------------------------------------
// release notes
// ---------------------------------------------------------------------------

/**
 * Extract one `## <version> ...` section from a CHANGELOG, stopping at the next
 * same-or-higher-level heading. Returns null when the version has no section — a
 * release without notes should fail loudly rather than publish an empty body.
 *
 * @param {string} changelog
 * @param {string} version
 * @returns {string|null}
 */
export function extractChangelogSection(changelog, version) {
  if (typeof changelog !== 'string' || typeof version !== 'string') return null
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(version)}(?:\\s|$)`).test(line))
  if (start === -1) return null
  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) break
    body.push(lines[i])
  }
  const text = body.join('\n').trim()
  return text.length > 0 ? text : null
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Resolve the release body for a version.
 *
 * Priority: explicit `--notes` text → explicit `--notes-file` → the hand-written
 * `docs/release-notes-v<version>.md` (then without the `v`) → the CHANGELOG section.
 *
 * @param {{root: string, version: string, notes?: string|null, notesFile?: string|null}} options
 * @returns {{body: string|null, source: string, warnings: string[]}}
 */
export function resolveReleaseNotes({ root, version, notes = null, notesFile = null }) {
  const warnings = []
  if (typeof notes === 'string' && notes.trim().length > 0) {
    return { body: notes.trim(), source: 'inline', warnings }
  }
  if (typeof notesFile === 'string' && notesFile.length > 0) {
    try {
      return { body: readFileSync(join(root, notesFile), 'utf8').trim(), source: notesFile, warnings }
    } catch (error) {
      warnings.push(`could not read --notes-file ${notesFile}: ${error.message}`)
    }
  }
  for (const candidate of [`docs/release-notes-v${version}.md`, `docs/release-notes-${version}.md`]) {
    try {
      const body = readFileSync(join(root, candidate), 'utf8').trim()
      if (body.length > 0) return { body, source: candidate, warnings }
    } catch {
      // try the next candidate
    }
  }
  try {
    const section = extractChangelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version)
    if (section !== null) return { body: section, source: `CHANGELOG.md § ${version}`, warnings }
  } catch (error) {
    warnings.push(`could not read CHANGELOG.md: ${error.message}`)
  }
  return { body: null, source: 'none', warnings }
}

// ---------------------------------------------------------------------------
// tarball: build (pure node, no npm) and read back (for verification)
// ---------------------------------------------------------------------------

const ALWAYS_SKIP = new Set(['node_modules', '.git', '.hg', '.svn'])
const SKIP_FILE = /(?:\.tgz|\.bak|\.orig|\.log|npm-debug\.log.*)$/i
const SKIP_FILE_ALWAYS = new Set(['.DS_Store', 'Thumbs.db', 'Desktop.ini', '.gitignore'])

/**
 * Expand a package.json `files` whitelist into a sorted list of archive-relative
 * paths (npm semantics: a directory entry includes everything below it; a file entry
 * includes that file). Directory entries are excluded — `tar` recreates them.
 *
 * @param {string} root
 * @param {string[]} patterns
 * @returns {{entries: string[], warnings: string[]}}
 */
export function collectPackEntries(root, patterns) {
  const entries = new Set()
  const warnings = []
  const walk = (rel) => {
    let stat
    try {
      stat = statSync(join(root, rel))
    } catch {
      warnings.push(`whitelist entry not found: ${rel}`)
      return
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (ALWAYS_SKIP.has(child.name)) continue
        walk(posix.join(rel, child.name))
      }
      return
    }
    if (!stat.isFile()) return
    if (SKIP_FILE.test(rel)) return
    if (SKIP_FILE_ALWAYS.has(posix.basename(rel))) return
    entries.add(rel)
  }
  for (const pattern of patterns) {
    const rel = String(pattern).replace(/^\.\//, '').replace(/\/+$/, '')
    if (rel.length === 0) continue
    walk(rel)
  }
  return { entries: [...entries].sort(), warnings }
}

/**
 * Build a gzipped tarball in memory from explicit entries.
 *
 * Written by hand rather than shelling out to `tar`/`npm pack` because both are
 * environment-dependent here, and because a deterministic archive is easier to verify.
 *
 * @param {string} root
 * @param {string[]} entries archive-relative paths
 * @returns {Buffer} tgz bytes
 */
export function buildTarball(root, entries) {
  const blocks = []
  for (const rel of entries) {
    const content = readFileSync(join(root, rel))
    blocks.push(tarHeader({ name: rel, size: content.length }), content, paddingFor(content.length))
  }
  // A tar stream ends with two zero blocks.
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

/**
 * Read a gzipped tarball back into `{name, size, content}` records.
 *
 * Used by the tests (and by `--verify`) to prove the archive this module writes is one
 * it — and anything else — can actually read.
 *
 * @param {Buffer} buffer
 * @returns {{name: string, size: number, content: Buffer}[]}
 */
export function readTarball(buffer) {
  const tar = gunzipSync(buffer)
  const out = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = parseInt(readString(header, 124, 12).trim() || '0', 8)
    const typeFlag = String.fromCharCode(header[156])
    const full = prefix.length > 0 ? `${prefix}/${name}` : name
    const start = offset + 512
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      out.push({ name: full, size, content: tar.subarray(start, start + size) })
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  return out
}

function readString(buffer, offset, length) {
  const slice = buffer.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8').trim()
}

function paddingFor(size) {
  const remainder = size % 512
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(512 - remainder)
}

function tarHeader({ name, size, mtime = 0 }) {
  const header = Buffer.alloc(512)
  const write = (text, offset, length) => {
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > length) throw new Error(`tar field too long (${bytes.length} > ${length}): ${text}`)
    bytes.copy(header, offset)
  }
  write(name, 0, 100) // ustar supports 100-byte names; paths here are far shorter.
  write('0000644\0', 100, 8) // mode
  write('0000000\0', 108, 8) // uid
  write('0000000\0', 116, 8) // gid
  write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12)
  write(`${Math.floor(mtime).toString(8).padStart(11, '0')}\0`, 136, 12)
  header.write('        ', 148, 8, 'ascii') // checksum placeholder = 8 spaces
  write('0', 156, 1) // type flag: regular file
  write('ustar\0', 257, 6) // magic + version
  write('00', 263, 2)
  write('root', 265, 32)
  write('root', 297, 32)

  let sum = 0
  for (const byte of header) sum += byte
  write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return header
}

// ---------------------------------------------------------------------------
// repo metadata, sourced from the hand-maintained doc
// ---------------------------------------------------------------------------

/**
 * Read the About description and topic list out of `docs/github-description.md`, so the
 * repository settings and the documentation cannot drift apart.
 *
 * The topic block is recognised by SHAPE (a fenced list of bare topic names), not by
 * block index — indexing would silently sync the wrong block the moment the doc is
 * reordered, which is exactly the kind of quiet corruption that is hard to notice.
 *
 * @param {string} root
 * @returns {{description: string|null, topics: string[]|null}}
 */
export function readRepoMeta(root) {
  let text
  try {
    text = readFileSync(join(root, 'docs', 'github-description.md'), 'utf8')
  } catch {
    return { description: null, topics: null }
  }
  const blocks = [...text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((match) => match[1].trim())
  const topicsBlock = blocks.find((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return lines.length >= 5 && lines.every((line) => /^[a-z0-9][a-z0-9-]*$/.test(line))
  })
  return {
    description: blocks[0] ?? null,
    topics: topicsBlock ? topicsBlock.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : null,
  }
}

// ---------------------------------------------------------------------------
// GitHub REST client (fetch injected, so tests never touch the network)
// ---------------------------------------------------------------------------

/**
 * Create a thin GitHub REST client.
 *
 * @param {{token: string, api?: string, uploadApi?: string, fetchImpl?: typeof fetch}} options
 * @returns {{request: (method: string, path: string, body?: unknown, extra?: object) => Promise<{status: number, data: any, headers: Headers}>}}
 */
export function createGitHubClient({
  token,
  api = DEFAULT_API,
  uploadApi = DEFAULT_UPLOAD_API,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')
  const base = api.replace(/\/+$/, '')
  const uploadBase = uploadApi.replace(/\/+$/, '')

  async function request(method, path, body = undefined, extra = {}) {
    // `extra.upload` routes to the uploads host (release assets); an already-absolute path
    // is used verbatim, so callers can point at either host explicitly.
    const target = /^https?:\/\//i.test(path)
      ? path
      : `${extra.upload === true ? uploadBase : base}${path}`
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      'x-github-api-version': '2022-11-28',
      ...(extra.headers ?? {}),
    }
    if (typeof token === 'string' && token.length > 0) headers.authorization = `Bearer ${token}`
    let payload
    if (extra.rawBody !== undefined) {
      // Binary uploads (release assets) must NOT be JSON-encoded, and must not carry a
      // caller-supplied content-length: fetch computes the correct one itself.
      payload = extra.rawBody
      headers['content-type'] = headers['content-type'] ?? 'application/octet-stream'
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const response = await fetchImpl(target, { method, headers, body: payload })
    const text = await response.text()
    let data = null
    if (text.length > 0) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { message: text }
      }
    }
    return { status: response.status, data, headers: response.headers }
  }

  return { request }
}

/**
 * Turn an API failure into an actionable message.
 *
 * The token case is called out separately because "no token" and "token lacks scope"
 * look identical in a bare 401/403 dump, and the fix differs.
 *
 * @param {string} what
 * @param {{status: number, data: any}} response
 * @returns {Error}
 */
export function describeApiFailure(what, response) {
  const message = typeof response?.data?.message === 'string' ? response.data.message : ''
  const status = response?.status ?? 0
  if (status === 401) {
    return new Error(
      `${what} failed: 401 Unauthorized — the token is missing, expired or malformed. ` +
        `Create one at https://github.com/settings/tokens (classic, scope "repo") ` +
        `and put it in .gh-token or %GH_TOKEN%. ${message}`,
    )
  }
  if (status === 403 || status === 404) {
    return new Error(
      `${what} failed: ${status} — the token lacks the required scope, or it cannot see the ` +
        `repository. For a private repo the classic "repo" scope is required; for a public repo ` +
        `"public_repo" is enough. ${message}`,
    )
  }
  return new Error(`${what} failed: HTTP ${status}${message.length > 0 ? ` — ${message}` : ''}`)
}

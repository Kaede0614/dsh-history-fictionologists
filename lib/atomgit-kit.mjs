/**
 * AtomGit (atomgit.com) release helper — the second distribution platform.
 *
 * WHY THIS EXISTS — AtomGit is the domestic mirror of this plugin's GitHub home, and its
 * API is *not* "GitHub's with a different host bolted on". Four differences were measured
 * against the live platform (probes recorded in docs/atomgit-description.md), and each one
 * breaks a naive port of `lib/release-kit.mjs`:
 *
 *   1. Auth is the GitLab-style `PRIVATE-TOKEN` header. `Authorization: Bearer` is also
 *      documented, but the header form is the one the platform's own examples lead with.
 *   2. A release has no numeric `id` in the API responses — every follow-up call addresses
 *      it by `tag_name`.
 *   3. There is no `POST /releases/:id/assets`. Attachments go through a signed two-step:
 *      `GET /releases/:tag/upload_url?file_name=…` returns an object-storage URL plus a set
 *      of `x-obs-*` headers that must be replayed verbatim on the `PUT`.
 *   4. Overwriting an attachment with the same file name does not work (the previously
 *      linked object stays on the release), so an existing asset must be DELETEd first.
 *
 * Everything here is PURE or INJECTABLE so it can be unit-tested offline: every network
 * call takes a `fetchImpl`, and nothing in this module touches the network by itself.
 *
 * @module dsh-history-fictionologists/lib/atomgit-kit
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** api.atomgit.com root. Overridable for tests; not for GitCode, which is a different host. */
export const DEFAULT_ATOMGIT_API = 'https://api.atomgit.com/api/v5'

/** Where humans read the repository, and where release asset downloads resolve. */
export const ATOMGIT_WEB = 'https://atomgit.com'

/** Hosts whose clone URLs this module will accept. A GitHub URL must never be mistaken for one. */
export const ATOMGIT_HOSTS = ['atomgit.com', 'gitcode.com']

/** Where a user creates the classic personal access token this toolchain needs. */
export const ATOMGIT_TOKEN_URL = 'https://atomgit.com/setting/token-classic'

/**
 * Scopes a classic token must carry for this toolchain to work.
 *
 * MEASURED, not guessed: a token created without ticking any scope box answers
 * `no scopes:read_user` on `/user` and `CH.00000403 apig token has not permission to
 * request url` on every repository endpoint. Both look like "wrong token" in a bare 403
 * dump, so the required list is spelled out in the error message instead.
 */
export const ATOMGIT_SCOPES = ['api', 'read_user', 'read_repository', 'write_repository']

/** The gitignored file a token can be pasted into, so it never has to live in the environment. */
export const TOKEN_FILE = '.atomgit-token'

const SEGMENT = /^[A-Za-z0-9._-]+$/
const BARE_SLUG = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/

// ---------------------------------------------------------------------------
// repository / token resolution
// ---------------------------------------------------------------------------

/**
 * Parse an AtomGit repository reference into `owner/repo`.
 *
 * Accepts `git+https://atomgit.com/o/r.git`, plain `https://`, `git@atomgit.com:o/r.git`,
 * the `atomgit:o/r` shorthand, or a bare `o/r`. A URL on any OTHER host returns null rather
 * than a slug: silently publishing a GitHub remote's contents to an AtomGit repo of the same
 * name is exactly the mistake this guard exists to prevent.
 *
 * @param {string} value
 * @returns {string|null} `owner/repo`, or null when it cannot be determined
 */
export function parseAtomgitSlug(value) {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (text.length === 0) return null
  text = text.replace(/^git\+/, '')

  const shorthand = /^(?:atomgit|gitcode):([^/\s]+)\/([^/\s#?]+)$/.exec(text)
  if (shorthand) return slug(shorthand[1], shorthand[2])

  const scp = /^[^@\s]+@([^:\s]+):([^/\s]+)\/([^/\s#?]+)$/.exec(text)
  if (scp) return isAtomgitHost(scp[1]) ? slug(scp[2], scp[3]) : null

  const url = /^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?([^/\s:]+)(?::\d+)?\/([^/\s]+)\/([^/\s#?]+)$/.exec(text)
  if (url) return isAtomgitHost(url[1]) ? slug(url[2], url[3]) : null

  const bare = BARE_SLUG.exec(text)
  if (bare) return slug(bare[1], bare[2])

  return null
}

function isAtomgitHost(host) {
  const text = String(host).toLowerCase()
  return ATOMGIT_HOSTS.some((known) => text === known || text.endsWith(`.${known}`))
}

function slug(owner, repo) {
  const o = String(owner ?? '').trim()
  const r = String(repo ?? '')
    .trim()
    .replace(/\.git$/i, '')
  return SEGMENT.test(o) && SEGMENT.test(r) ? `${o}/${r}` : null
}

/** `owner/repo` → `{ owner, repo }`, or null when malformed. */
export function splitSlug(value) {
  const slugValue = parseAtomgitSlug(value)
  if (slugValue === null) return null
  const [owner, repo] = slugValue.split('/')
  return { owner, repo }
}

/**
 * Resolve an AtomGit token from the environment, then from a local file.
 *
 * Priority: `ATOMGIT_TOKEN` → `ATOMGIT_ACCESS_TOKEN` → `<root>/.atomgit-token` (gitignored).
 * The file route mirrors `resolveToken` in release-kit.mjs: this project's shell cannot
 * persist environment variables for the user's own terminal, and pasting a token into a file
 * is less error-prone than an inline env assignment.
 *
 * The value is never logged by this module.
 *
 * @param {{root?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {{token: string|null, source: string}}
 */
export function resolveAtomgitToken({ root = '.', env = process.env } = {}) {
  for (const name of ['ATOMGIT_TOKEN', 'ATOMGIT_ACCESS_TOKEN']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim().length > 0) {
      return { token: value.trim(), source: `env:${name}` }
    }
  }
  try {
    const raw = readFileSync(join(root, TOKEN_FILE), 'utf8')
    // Tolerate the trailing newline every editor adds, a `ATOMGIT_TOKEN=…` paste and comments.
    for (const line of raw.split(/\r?\n/)) {
      // Tolerate the trailing newline every editor adds, a `ATOMGIT_TOKEN=…` paste, a shell
      // `export ATOMGIT_TOKEN=…` paste, and comments. A leading `export ` that is not stripped
      // makes the whole line the token, which then fails as a misleading "token is malformed".
      const text = line.replace(/^\s*(?:export\s+)?(?:ATOMGIT_TOKEN|ATOMGIT_ACCESS_TOKEN)\s*=\s*/, '').trim()
      if (text.length > 0 && !text.startsWith('#')) return { token: text, source: TOKEN_FILE }
    }
  } catch {
    // No file is the normal state before the first release; fall through.
  }
  return { token: null, source: 'none' }
}

// ---------------------------------------------------------------------------
// request bodies
// ---------------------------------------------------------------------------

/**
 * Build the create/update payload for a release.
 *
 * Two sources disagree about PATCH, and one body satisfies both: the official schema for
 * `PATCH /releases/:tag` lists only `name` and `body` as required (plus optional
 * `release_status`), while a community measurement against the live platform reports
 * `PARAMETER_ERROR must not be blank` when a partial body is sent. So the caller sends the
 * same complete body for create and update. `tag_name` is redundant on PATCH (the tag is in
 * the path) but harmless there, and required on POST.
 *
 * @param {{tag: string, name: string, body: string, targetCommitish?: string|null, prerelease?: boolean, draft?: boolean}} input
 * @returns {{tag_name: string, name: string, body: string, target_commitish?: string, release_status: string}}
 */
export function buildAtomgitReleaseBody({ tag, name, body, targetCommitish = null, prerelease = false, draft = false }) {
  const payload = { tag_name: String(tag), name: String(name), body: String(body) }
  if (typeof targetCommitish === 'string' && targetCommitish.length > 0) {
    payload.target_commitish = targetCommitish
  }
  // AtomGit models "prerelease" as a status string. A draft has no first-class flag here, so
  // the caller must not silently pretend otherwise — see the warning the CLI prints.
  payload.release_status = prerelease || draft ? 'pre' : 'latest'
  return payload
}

/**
 * Build the payload for creating a repository in a user's or organisation's namespace.
 *
 * `public` is an integer on this platform (0/1), not a boolean.
 *
 * @param {{name: string, description?: string, isPublic?: boolean, defaultBranch?: string}} input
 */
export function buildCreateRepoBody({ name, description = '', isPublic = true, defaultBranch = 'main' }) {
  return {
    name,
    path: name,
    description,
    public: isPublic ? 1 : 0,
    has_issues: true,
    has_wiki: true,
    auto_init: false,
    default_branch: defaultBranch,
    repository_type: 'code',
  }
}

/** Where a release attachment can be downloaded from once it is linked. */
export function releaseDownloadUrl({ repo, tag, fileName }) {
  return `${ATOMGIT_WEB}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`
}

/**
 * Find one entry of a release's `assets` array by exact file name.
 *
 * `assets` also carries auto-generated source archives (`v1.2.3.tar.gz`, `…zip`, …) which have
 * no id and cannot be deleted; only the uploaded attachment matters here.
 *
 * @param {unknown} release
 * @param {string} fileName
 * @returns {any|null}
 */
export function findAssetByName(release, fileName) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return assets.find((asset) => asset?.name === fileName) ?? null
}

/** Normalise a release's assets for reporting, dropping the source-archive noise. */
export function normalizeAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  return assets
    .filter((asset) => asset?.type !== 'source')
    .map((asset) => ({
      id: asset?.id ?? null,
      name: typeof asset?.name === 'string' ? asset.name : '',
      url: typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null,
    }))
}

// ---------------------------------------------------------------------------
// AtomGit REST client (fetch injected, so tests never touch the network)
// ---------------------------------------------------------------------------

/**
 * Create a thin AtomGit REST client.
 *
 * @param {{token?: string, api?: string, fetchImpl?: typeof fetch}} options
 * @returns {{request: (method: string, path: string, body?: unknown, extra?: object) => Promise<{status: number, data: any, headers: Headers}>, base: string}}
 */
export function createAtomgitClient({ token = '', api = DEFAULT_ATOMGIT_API, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')
  const base = String(api).replace(/\/+$/, '')

  async function request(method, path, body = undefined, extra = {}) {
    const headers = { accept: 'application/json', ...(extra.headers ?? {}) }
    // The GitLab-style header, not `Authorization: Bearer`: measured working against
    // api.atomgit.com and the form the platform's own examples use.
    if (typeof token === 'string' && token.length > 0) headers['PRIVATE-TOKEN'] = token
    let payload
    if (extra.rawBody !== undefined) {
      // Binary bodies (the signed OBS upload) must not be JSON-encoded, and must not carry a
      // caller-supplied content-length: fetch computes the correct one itself.
      payload = extra.rawBody
      headers['content-type'] = headers['content-type'] ?? 'application/octet-stream'
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const response = await fetchImpl(`${base}${path}`, { method, headers, body: payload })
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

  return { request, base }
}

/**
 * The headers the platform marks required on the `upload_url` response.
 *
 * All four are `required` in the official schema. Replaying them is not optional: measured
 * behaviour is that the object store either rejects the write or takes it *without firing
 * the callback that links the object to the release*, in which case the attachment simply
 * never appears. That is the silent failure this list exists to refuse.
 */
export const REQUIRED_UPLOAD_HEADERS = ['x-obs-meta-project-id', 'x-obs-acl', 'x-obs-callback', 'content-type']

/** 2xx, and nothing else. A 3xx is not a successful upload even though `>= 400` would say so. */
export function isSuccessStatus(status) {
  return status >= 200 && status < 300
}

/**
 * Render a signed-upload payload for an error message without leaking the signature.
 *
 * The `url` is a pre-signed object-storage URL: it carries `AccessKeyId` and `Signature`
 * in its query string and grants short-lived write access to one object. CI logs are not
 * the place for it.
 */
function describeSignedPayload(data) {
  if (data === null || typeof data !== 'object') return JSON.stringify(data)
  const { url, ...rest } = data
  let shown = url
  if (typeof url === 'string' && url.length > 0) {
    try {
      const parsed = new URL(url)
      shown = `${parsed.origin}${parsed.pathname}?<signature redacted>`
    } catch {
      shown = '<unparseable url>'
    }
  }
  return JSON.stringify({ ...rest, url: shown })
}

/**
 * Upload one release attachment via the platform's signed two-step.
 *
 * Step 1 asks the API for a pre-signed object-storage URL and the header set that goes with
 * it. Step 2 PUTs the bytes to that URL with those headers replayed *verbatim*.
 *
 * Does NOT throw on a failed PUT: the caller needs the response body (an OBS XML error such
 * as `<Code>SignatureDoesNotMatch</Code>` is the only useful diagnostic) and the fact that
 * the previous attachment may already have been deleted. `ok` says whether it succeeded.
 *
 * @param {{client: {request: Function}, fetchImpl?: typeof fetch, repo: string, tag: string, fileName: string, bytes: Buffer}} options
 * @returns {Promise<{ok: boolean, status: number, data: any, url: string, signedUrl: string, headers: object}>} `url` is the public download link
 */
export async function uploadReleaseAsset({ client, fetchImpl = globalThis.fetch, repo, tag, fileName, bytes }) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')
  const path = `/repos/${repo}/releases/${encodeURIComponent(tag)}/upload_url?file_name=${encodeURIComponent(fileName)}`
  const signed = await client.request('GET', path)
  if (!isSuccessStatus(signed.status)) throw describeAtomgitFailure('requesting the upload URL', signed)

  const signedUrl = signed?.data?.url
  const headers = signed?.data?.headers
  if (typeof signedUrl !== 'string' || signedUrl.length === 0) {
    throw new Error(`upload_url for ${fileName} returned no url: ${describeSignedPayload(signed.data)}`)
  }
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`upload_url for ${fileName} returned no headers: ${describeSignedPayload(signed.data)}`)
  }
  const lowered = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  const missing = REQUIRED_UPLOAD_HEADERS.filter((name) => {
    const value = lowered.get(name)
    return typeof value !== 'string' || value.length === 0
  })
  if (missing.length > 0) {
    throw new Error(
      `upload_url for ${fileName} is missing required header(s): ${missing.join(', ')}. ` +
        'Refusing to upload: without them the object store rejects the write, or accepts it ' +
        'without linking the object to the release (the attachment then never appears).',
    )
  }

  const response = await fetchImpl(signedUrl, { method: 'PUT', headers: { ...headers }, body: bytes })
  let data = null
  try {
    const text = await response.text()
    if (text.length > 0) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { message: text }
      }
    }
  } catch {
    // Some object stores close the stream on a 2xx; the status is what matters.
  }
  return {
    ok: isSuccessStatus(response.status),
    status: response.status,
    data,
    url: releaseDownloadUrl({ repo, tag, fileName }),
    signedUrl,
    headers,
  }
}

/**
 * Turn an API failure into an actionable message.
 *
 * The 401 and 403 cases are called out separately, and 403 carries the scope list, because
 * "no token", "token with no scopes" and "token without write access" are indistinguishable
 * in a bare status dump while their fixes differ. Both phrasings below are taken from real
 * responses measured on this platform (`no scopes:read_user`,
 * `CH.00000403 apig token has not permission to request url`).
 *
 * A 404 here is a genuine "not found" for the `fetch` transport and for the sub-resources
 * this toolchain uses — measured, not assumed (`_evidence/atomgit-probe.txt`):
 * an anonymous `GET /repos/<owner>/<repo>` answers `401 {"message":"401 Unauthorized"}`,
 * while `GET /repos/<owner>/<repo>/branches` answers
 * `404 {"error_message":"Project not found:…"}`. That is exactly why the repository
 * existence probe in `scripts/release-atomgit.mjs` asks for `/branches` and not the bare
 * repository: only the sub-resource distinguishes "absent" from "not authenticated".
 * The `git` transport answers 403 for the same absent project, so it is never parsed here.
 *
 * @param {string} what
 * @param {{status: number, data: any}} response
 * @returns {Error}
 */
export function describeAtomgitFailure(what, response) {
  const status = response?.status ?? 0
  const message = typeof response?.data?.message === 'string' ? response.data.message : ''
  const detail = message.length > 0 ? ` ${message}` : ''
  if (status === 401) {
    return new Error(
      `${what} failed: 401 Unauthorized — the token is missing, expired or malformed. ` +
        `Create a classic token at ${ATOMGIT_TOKEN_URL} with the scopes ` +
        `${ATOMGIT_SCOPES.join(', ')}, then put it in ${TOKEN_FILE} or %ATOMGIT_TOKEN%.${detail}`,
    )
  }
  if (status === 403) {
    return new Error(
      `${what} failed: 403 Forbidden — the token is accepted but lacks the permission this call ` +
        `needs. A classic token created with no scope boxes ticked fails exactly like this; it must ` +
        `carry ${ATOMGIT_SCOPES.join(', ')}.${detail}`,
    )
  }
  if (status === 404) {
    return new Error(
      `${what} failed: 404 Not Found — the owner/name is misspelled, the repository does not exist, ` +
        `or the release tag is not there yet. A private repository the token cannot see also answers 404.${detail}`,
    )
  }
  return new Error(`${what} failed: HTTP ${status}${message.length > 0 ? ` — ${message}` : ''}`)
}

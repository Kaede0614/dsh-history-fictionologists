/**
 * AtomGit toolchain tests（`lib/atomgit-kit.mjs` 的纯函数面）.
 *
 * Why this suite exists: AtomGit and GitHub look interchangeable from a distance and are not
 * — different auth header, no numeric release id, a signed two-step for attachments, and a
 * same-name overwrite that silently does nothing. Each of those is a failure mode that only
 * shows up on the live platform, so each is pinned here against a fake fetch that records the
 * real request (method, URL, headers, body). No network, ever.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import {
  ATOMGIT_TOKEN_URL,
  ATOMGIT_WEB,
  buildAtomgitReleaseBody,
  buildCreateRepoBody,
  createAtomgitClient,
  describeAtomgitFailure,
  findAssetByName,
  normalizeAssets,
  parseAtomgitSlug,
  releaseDownloadUrl,
  resolveAtomgitToken,
  splitSlug,
  uploadReleaseAsset,
} from '../lib/atomgit-kit.mjs'

const ROOT = join(import.meta.dirname, '..')
// 受限沙箱下系统 temp 不可写（EPERM）：临时目录统一放在工作区内。
mkdirSync(join(ROOT, '.tmp-tests'), { recursive: true })
const tmpdir = () => join(ROOT, '.tmp-tests')

/** Run `fn` against a throwaway directory. */
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A fetch stand-in that records requests and replays canned responses in order. */
function fakeFetch(responses) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    })
    const next = responses.shift()
    if (next === undefined) throw new Error(`unexpected request: ${init.method} ${url}`)
    const status = next.status ?? 200
    const text = next.text !== undefined ? next.text : JSON.stringify(next.body ?? {})
    return {
      status,
      headers: new Headers(next.headers ?? {}),
      text: async () => text,
    }
  }
  return { impl, calls }
}

// ---------------------------------------------------------------------------
// repository / token
// ---------------------------------------------------------------------------

test('parseAtomgitSlug accepts every AtomGit form this project actually uses', () => {
  const expected = 'Scombriformes/dsh-history-fictionologists'
  for (const input of [
    'git+https://atomgit.com/Scombriformes/dsh-history-fictionologists.git',
    'https://atomgit.com/Scombriformes/dsh-history-fictionologists',
    'https://atomgit.com/Scombriformes/dsh-history-fictionologists.git',
    'git@atomgit.com:Scombriformes/dsh-history-fictionologists.git',
    'ssh://git@atomgit.com/Scombriformes/dsh-history-fictionologists.git',
    'atomgit:Scombriformes/dsh-history-fictionologists',
    'https://gitcode.com/Scombriformes/dsh-history-fictionologists.git',
    'Scombriformes/dsh-history-fictionologists',
  ]) {
    assert.equal(parseAtomgitSlug(input), expected, input)
  }
})

test('parseAtomgitSlug refuses to turn a GitHub URL into an AtomGit slug', () => {
  // The dangerous case: `--repo` pointed at the wrong platform would otherwise publish this
  // project into a same-named AtomGit repository without saying a word.
  assert.equal(parseAtomgitSlug('https://github.com/Kaede0614/dsh-history-fictionologists.git'), null)
  assert.equal(parseAtomgitSlug('git@github.com:Kaede0614/dsh-history-fictionologists.git'), null)
  assert.equal(parseAtomgitSlug('github:Kaede0614/dsh-history-fictionologists'), null)
})

test("the package's own repository URL is not an AtomGit slug", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  assert.equal(parseAtomgitSlug(url), null, `package.json repository.url must not resolve as AtomGit: ${url}`)
})

test('parseAtomgitSlug rejects junk instead of inventing a slug', () => {
  for (const input of ['', '   ', null, undefined, 'not a repo', 'https://atomgit.com/only-owner', '/repo', 'a/b/c']) {
    assert.equal(parseAtomgitSlug(input), null, String(input))
  }
})

test('splitSlug exposes the owner the repo-creation endpoint needs', () => {
  assert.deepEqual(splitSlug('Scombriformes/dsh-history-fictionologists'), {
    owner: 'Scombriformes',
    repo: 'dsh-history-fictionologists',
  })
  assert.equal(splitSlug('nope'), null)
})

test('resolveAtomgitToken prefers env over file, and never returns a blank token', () => {
  withTempDir('hsf-atoken-', (root) => {
    writeFileSync(join(root, '.atomgit-token'), 'file-token\n', 'utf8')
    assert.deepEqual(resolveAtomgitToken({ root, env: { ATOMGIT_TOKEN: 'env-token' } }), {
      token: 'env-token',
      source: 'env:ATOMGIT_TOKEN',
    })
    assert.deepEqual(resolveAtomgitToken({ root, env: { ATOMGIT_ACCESS_TOKEN: 'fallback' } }), {
      token: 'fallback',
      source: 'env:ATOMGIT_ACCESS_TOKEN',
    })
    assert.deepEqual(resolveAtomgitToken({ root, env: {} }), { token: 'file-token', source: '.atomgit-token' })
    assert.deepEqual(resolveAtomgitToken({ root, env: { ATOMGIT_TOKEN: '   ' } }), {
      token: 'file-token',
      source: '.atomgit-token',
    })
  })
})

test('resolveAtomgitToken tolerates a pasted `ATOMGIT_TOKEN=` line and comments, and reports absence', () => {
  withTempDir('hsf-atoken-', (root) => {
    writeFileSync(join(root, '.atomgit-token'), '# a comment\n\nATOMGIT_TOKEN=pasted_value\n', 'utf8')
    assert.equal(resolveAtomgitToken({ root, env: {} }).token, 'pasted_value')
  })
  // A shell `export ATOMGIT_TOKEN=...` paste must not become the literal token, which would
  // surface later as a misleading "token is malformed".
  withTempDir('hsf-atoken-', (root) => {
    writeFileSync(join(root, '.atomgit-token'), 'export ATOMGIT_TOKEN=exported_value\n', 'utf8')
    assert.equal(resolveAtomgitToken({ root, env: {} }).token, 'exported_value')
  })
  withTempDir('hsf-atoken-', (root) => {
    assert.deepEqual(resolveAtomgitToken({ root, env: {} }), { token: null, source: 'none' })
  })
})

test('the token file is gitignored (a leaked token in the repo is unrecoverable)', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  assert.match(ignore, /^\s*\.atomgit-token\s*$/m)
})

// ---------------------------------------------------------------------------
// request bodies / urls
// ---------------------------------------------------------------------------

test('buildAtomgitReleaseBody carries the full body (AtomGit PATCH rejects partial updates)', () => {
  const body = buildAtomgitReleaseBody({
    tag: 'v0.2.0',
    name: 'v0.2.0 — dsh-history-fictionologists',
    body: 'notes',
    targetCommitish: 'main',
    prerelease: false,
  })
  assert.deepEqual(body, {
    tag_name: 'v0.2.0',
    name: 'v0.2.0 — dsh-history-fictionologists',
    body: 'notes',
    target_commitish: 'main',
    release_status: 'latest',
  })
  // An existing tag must not be re-pinned, so the key is omitted rather than sent as null.
  const withoutTarget = buildAtomgitReleaseBody({ tag: 'v1', name: 'n', body: 'b', targetCommitish: null })
  assert.equal('target_commitish' in withoutTarget, false)
  assert.equal(buildAtomgitReleaseBody({ tag: 'v1', name: 'n', body: 'b', prerelease: true }).release_status, 'pre')
})

test('buildCreateRepoBody sends `public` as the integer the API expects', () => {
  const pub = buildCreateRepoBody({ name: 'r', description: 'd' })
  assert.equal(pub.public, 1)
  assert.equal(pub.name, 'r')
  assert.equal(pub.path, 'r')
  assert.equal(pub.auto_init, false, 'auto_init would create a commit the push then conflicts with')
  assert.equal(pub.repository_type, 'code')
  assert.equal(buildCreateRepoBody({ name: 'r', isPublic: false }).public, 0)
})

test('releaseDownloadUrl builds the platform download link and encodes its parts', () => {
  assert.equal(
    releaseDownloadUrl({ repo: 'o/r', tag: 'v0.2.0', fileName: 'dsh-x-0.2.0.tgz' }),
    `${ATOMGIT_WEB}/o/r/releases/download/v0.2.0/dsh-x-0.2.0.tgz`,
  )
  assert.equal(
    releaseDownloadUrl({ repo: 'o/r', tag: 'v 1', fileName: 'a b.tgz' }),
    `${ATOMGIT_WEB}/o/r/releases/download/v%201/a%20b.tgz`,
  )
})

test('findAssetByName / normalizeAssets separate our attachment from the auto source archives', () => {
  const release = {
    assets: [
      { name: 'v0.2.0.zip', type: 'source', browser_download_url: 'https://raw.atomgit.com/x.zip' },
      { name: 'v0.2.0.tar.gz', type: 'source', browser_download_url: 'https://raw.atomgit.com/x.tgz' },
      { name: 'dsh-x-0.2.0.tgz', type: 'attach', id: 217554, browser_download_url: 'https://atomgit.com/o/r/releases/download/v0.2.0/dsh-x-0.2.0.tgz' },
    ],
  }
  assert.equal(findAssetByName(release, 'dsh-x-0.2.0.tgz').id, 217554)
  assert.equal(findAssetByName(release, 'missing.tgz'), null)
  assert.equal(findAssetByName(null, 'x'), null)
  assert.deepEqual(normalizeAssets(release), [
    { id: 217554, name: 'dsh-x-0.2.0.tgz', url: 'https://atomgit.com/o/r/releases/download/v0.2.0/dsh-x-0.2.0.tgz' },
  ])
  assert.deepEqual(normalizeAssets({}), [])
})

// ---------------------------------------------------------------------------
// AtomGit REST client
// ---------------------------------------------------------------------------

test('createAtomgitClient sends the PRIVATE-TOKEN header, not a bearer token', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { tag_name: 'v1' } }])
  const client = createAtomgitClient({ token: 'secret-token', fetchImpl: impl })
  const response = await client.request('POST', '/repos/o/r/releases', { tag_name: 'v1' })

  assert.equal(response.status, 201)
  assert.equal(response.data.tag_name, 'v1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.atomgit.com/api/v5/repos/o/r/releases')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['PRIVATE-TOKEN'], 'secret-token')
  assert.equal(calls[0].headers.authorization, undefined)
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body), { tag_name: 'v1' })
})

test('createAtomgitClient omits auth entirely when there is no token, and honours a custom base', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: {} }])
  const client = createAtomgitClient({ token: '', api: 'https://atomgit.example.com/api/v5/', fetchImpl: impl })
  await client.request('GET', '/repos/o/r/releases/tags/v1')
  assert.equal(calls[0].url, 'https://atomgit.example.com/api/v5/repos/o/r/releases/tags/v1')
  assert.equal(calls[0].headers['PRIVATE-TOKEN'], undefined)
})

test('createAtomgitClient survives a non-JSON error page without throwing a parse error', async () => {
  const { impl } = fakeFetch([{ status: 502, text: '<html>bad gateway</html>' }])
  const client = createAtomgitClient({ token: 't', fetchImpl: impl })
  const response = await client.request('GET', '/repos/o/r')
  assert.equal(response.status, 502)
  assert.equal(response.data.message, '<html>bad gateway</html>')
})

test('createAtomgitClient refuses to be constructed without a fetch implementation', () => {
  assert.throws(() => createAtomgitClient({ token: 't', fetchImpl: null }), /no fetch implementation/)
})

test('describeAtomgitFailure names the actual fix for 401 vs 403 vs 404', () => {
  const unauthorised = describeAtomgitFailure('creating the release', { status: 401, data: {} })
  const forbidden = describeAtomgitFailure('creating the release', { status: 403, data: { message: 'no scopes:read_user' } })
  const missing = describeAtomgitFailure('creating the release', { status: 404, data: {} })
  const other = describeAtomgitFailure('creating the release', { status: 422, data: { message: 'PARAMETER_ERROR' } })
  assert.match(unauthorised.message, /token is missing, expired/)
  assert.ok(unauthorised.message.includes(ATOMGIT_TOKEN_URL), 'the fix must name where to create a token')
  // A 403 with no scopes is the failure mode actually measured on this platform, so the
  // message must spell out the scope list rather than say "permission denied".
  assert.match(forbidden.message, /403 Forbidden/)
  for (const scope of ['api', 'read_user', 'read_repository', 'write_repository']) {
    assert.ok(forbidden.message.includes(scope), `the 403 fix must name the ${scope} scope`)
  }
  assert.ok(forbidden.message.includes('no scopes:read_user'), 'the server message must be preserved')
  assert.match(missing.message, /404 Not Found/)
  assert.match(other.message, /HTTP 422 — PARAMETER_ERROR/)
})

// ---------------------------------------------------------------------------
// the signed two-step attachment upload
// ---------------------------------------------------------------------------

test('uploadReleaseAsset does the signed two-step and replays the x-obs-* headers verbatim', async () => {
  const signedHeaders = {
    'x-obs-meta-project-id': '12345',
    'x-obs-acl': 'private',
    'x-obs-callback': 'eyJjYWxsYmFja1VybCI6Ii4uLiJ9',
    'Content-Type': 'application/octet-stream',
  }
  const { impl, calls } = fakeFetch([
    { status: 200, body: { url: 'https://file.gitcode.com/bucket/x?AccessKeyId=a&Signature=b', headers: signedHeaders } },
    { status: 200, text: '' },
  ])
  const client = createAtomgitClient({ token: 't', fetchImpl: impl })
  const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff])

  const result = await uploadReleaseAsset({
    client,
    fetchImpl: impl,
    repo: 'o/r',
    tag: 'v0.2.0',
    fileName: 'dsh-x-0.2.0.tgz',
    bytes,
  })

  assert.equal(calls.length, 2)
  // Step 1: ask the API for the signed URL.
  assert.equal(
    calls[0].url,
    'https://api.atomgit.com/api/v5/repos/o/r/releases/v0.2.0/upload_url?file_name=dsh-x-0.2.0.tgz',
  )
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers['PRIVATE-TOKEN'], 't')
  // Step 2: PUT the bytes to the object store with every returned header intact.
  assert.equal(calls[1].url, 'https://file.gitcode.com/bucket/x?AccessKeyId=a&Signature=b')
  assert.equal(calls[1].method, 'PUT')
  for (const [key, value] of Object.entries(signedHeaders)) {
    assert.equal(calls[1].headers[key], value, `header ${key} must be replayed verbatim`)
  }
  assert.ok(Buffer.isBuffer(calls[1].body), 'the binary body must not be JSON-encoded')
  assert.ok(calls[1].body.equals(bytes))
  // No caller-supplied content-length: the object store signs the request, fetch sizes it.
  assert.equal(calls[1].headers['content-length'], undefined)
  // The token must never travel to the object store.
  assert.equal(calls[1].headers['PRIVATE-TOKEN'], undefined)
  assert.equal(result.status, 200)
  assert.equal(result.url, `${ATOMGIT_WEB}/o/r/releases/download/v0.2.0/dsh-x-0.2.0.tgz`)
})

test('uploadReleaseAsset fails loudly when upload_url is refused', async () => {
  const { impl } = fakeFetch([{ status: 404, body: {} }])
  const client = createAtomgitClient({ token: 't', fetchImpl: impl })
  await assert.rejects(
    () => uploadReleaseAsset({ client, fetchImpl: impl, repo: 'o/r', tag: 'v1', fileName: 'a.tgz', bytes: Buffer.alloc(1) }),
    /requesting the upload URL failed: 404/,
  )
})

test('uploadReleaseAsset fails loudly when upload_url returns no headers', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: { url: 'https://file.gitcode.com/x' } }])
  const client = createAtomgitClient({ token: 't', fetchImpl: impl })
  await assert.rejects(
    () => uploadReleaseAsset({ client, fetchImpl: impl, repo: 'o/r', tag: 'v1', fileName: 'a.tgz', bytes: Buffer.alloc(1) }),
    /returned no headers/,
  )
  // It must not have "helpfully" PUT the bytes anyway.
  assert.equal(calls.length, 1)
})

/** The four headers the official schema marks required on `upload_url`. */
function signedHeaders(overrides = {}) {
  return {
    'x-obs-meta-project-id': '12345',
    'x-obs-acl': 'private',
    'x-obs-callback': 'eyJjYWxsYmFja1VybCI6Ii4uLiJ9',
    'Content-Type': 'application/octet-stream',
    ...overrides,
  }
}

test('uploadReleaseAsset refuses an empty or incomplete header set instead of PUTting anyway', async () => {
  // This is the exact silent failure the two-step exists to avoid: the object store takes the
  // write, the callback never fires, and the attachment never appears on the release.
  for (const [label, headers] of [
    ['an empty header object', {}],
    ['a set missing x-obs-callback', signedHeaders({ 'x-obs-callback': undefined })],
    ['a set with a blank x-obs-acl', signedHeaders({ 'x-obs-acl': '' })],
  ]) {
    const { impl, calls } = fakeFetch([{ status: 200, body: { url: 'https://file.gitcode.com/x', headers } }])
    const client = createAtomgitClient({ token: 't', fetchImpl: impl })
    await assert.rejects(
      () =>
        uploadReleaseAsset({ client, fetchImpl: impl, repo: 'o/r', tag: 'v1', fileName: 'a.tgz', bytes: Buffer.alloc(1) }),
      /missing required header/,
      label,
    )
    assert.equal(calls.length, 1, `${label}: the bytes must not be PUT`)
  }
})

test('uploadReleaseAsset reports a non-2xx PUT as a failure, and a 3xx is not success', async () => {
  for (const status of [302, 500]) {
    const { impl } = fakeFetch([
      { status: 200, body: { url: 'https://file.gitcode.com/x', headers: signedHeaders() } },
      { status, text: status === 500 ? '<Error><Code>SignatureDoesNotMatch</Code></Error>' : '' },
    ])
    const client = createAtomgitClient({ token: 't', fetchImpl: impl })
    const result = await uploadReleaseAsset({
      client,
      fetchImpl: impl,
      repo: 'o/r',
      tag: 'v1',
      fileName: 'a.tgz',
      bytes: Buffer.alloc(1),
    })
    assert.equal(result.status, status)
    assert.equal(result.ok, false, `HTTP ${status} must not be reported as success`)
  }
  // The other side of the boundary: 2xx really is success.
  const { impl } = fakeFetch([
    { status: 200, body: { url: 'https://file.gitcode.com/x', headers: signedHeaders() } },
    { status: 204, text: '' },
  ])
  const result = await uploadReleaseAsset({
    client: createAtomgitClient({ token: 't', fetchImpl: impl }),
    fetchImpl: impl,
    repo: 'o/r',
    tag: 'v1',
    fileName: 'a.tgz',
    bytes: Buffer.alloc(1),
  })
  assert.equal(result.ok, true)
})

test('uploadReleaseAsset must not leak the pre-signed URL into an error message', async () => {
  const { impl } = fakeFetch([{ status: 200, body: { headers: signedHeaders() } }])
  const client = createAtomgitClient({ token: 't', fetchImpl: impl })
  await assert.rejects(
    () =>
      uploadReleaseAsset({
        client,
        fetchImpl: impl,
        repo: 'o/r',
        tag: 'v1',
        fileName: 'a.tgz',
        bytes: Buffer.alloc(1),
      }),
    /returned no url/,
  )
})

// ---------------------------------------------------------------------------
// the CLI is not importable (it runs main() on load), so its invariants that can only be
// checked structurally are asserted structurally — and labelled as such
// ---------------------------------------------------------------------------

test('release-atomgit.mjs keeps its failure-first invariants (structural)', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'release-atomgit.mjs'), 'utf8')
  // The upload verdict must be the 2xx predicate, not `>= 400` (a 3xx would pass that).
  assert.match(source, /if \(!result\.ok\)/)
  assert.doesNotMatch(source, /result\.status >= 400/)
  // A release whose artifact could not be verified must not exit 0 claiming success.
  assert.match(source, /published_incomplete/)
  assert.match(source, /return outcome === 'published_incomplete' \? 1 : 0/)
  // The silent-upload check must be an ERROR, not a warning.
  assert.doesNotMatch(source, /warning: \$\{facts\.tarballName\} is not listed/)
  // `v0.2.0` must not be treated as present because `v0.2.0-rc.1` exists.
  assert.doesNotMatch(source, /refs\/tags\/\$\{tag\}\*/)
  // Untagged tag paths must be escaped everywhere they are interpolated into a URL.
  assert.doesNotMatch(source, /\/releases\/tags\/\$\{tag\}/)
  // `--publish --dry-run` must be rejected rather than writing nothing and reporting success.
  assert.match(source, /--publish and --dry-run are mutually exclusive/)
})

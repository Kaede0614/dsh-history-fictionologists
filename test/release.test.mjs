/**
 * Release toolchain tests（`lib/release-kit.mjs` + `scripts/release.mjs` 的纯函数面）.
 *
 * Why this suite exists: the project must be releasable from a machine that has neither
 * `gh` nor a usable `npm`, so the packing and publishing paths are hand-written Node.
 * Hand-written tar/gzip and hand-written REST calls are exactly the kind of thing that
 * "works" until a stranger runs `dsh plugin add`, so each layer is asserted here:
 * the tgz is read back byte-for-byte, and the HTTP layer is driven with a fake fetch
 * that records the real request (method, URL, body) — no network, ever.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildTarball,
  collectPackEntries,
  createGitHubClient,
  describeApiFailure,
  extractChangelogSection,
  parseRepoSlug,
  readPackageFacts,
  readRepoMeta,
  readTarball,
  resolveReleaseNotes,
  resolveToken,
} from '../lib/release-kit.mjs'

const ROOT = join(import.meta.dirname, '..')

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

test('parseRepoSlug accepts every form this project actually uses', () => {
  const expected = 'Kaede0614/dsh-history-fictionologists'
  for (const input of [
    'git+https://github.com/Kaede0614/dsh-history-fictionologists.git',
    'https://github.com/Kaede0614/dsh-history-fictionologists',
    'https://github.com/Kaede0614/dsh-history-fictionologists.git',
    'git@github.com:Kaede0614/dsh-history-fictionologists.git',
    'github:Kaede0614/dsh-history-fictionologists',
    'ssh://git@github.com/Kaede0614/dsh-history-fictionologists.git',
    'Kaede0614/dsh-history-fictionologists',
  ]) {
    assert.equal(parseRepoSlug(input), expected, input)
  }
})

test('parseRepoSlug rejects junk instead of inventing a slug', () => {
  for (const input of ['', '   ', null, undefined, 'not a repo', 'https://github.com/only-owner', '/repo', 'a/b/c']) {
    assert.equal(parseRepoSlug(input), null, String(input))
  }
})

test('resolveToken prefers env over file, and never returns a blank token', () => {
  withTempDir('hsf-token-', (root) => {
    writeFileSync(join(root, '.gh-token'), 'file-token\n', 'utf8')
    assert.deepEqual(resolveToken({ root, env: { GH_TOKEN: 'env-token' } }), {
      token: 'env-token',
      source: 'env:GH_TOKEN',
    })
    assert.deepEqual(resolveToken({ root, env: { GITHUB_TOKEN: 'fallback' } }), {
      token: 'fallback',
      source: 'env:GITHUB_TOKEN',
    })
    assert.deepEqual(resolveToken({ root, env: {} }), { token: 'file-token', source: '.gh-token' })
    assert.deepEqual(resolveToken({ root, env: { GH_TOKEN: '   ' } }), {
      token: 'file-token',
      source: '.gh-token',
    })
  })
})

test('resolveToken tolerates a pasted `GH_TOKEN=` line and comments, and reports absence', () => {
  withTempDir('hsf-token-', (root) => {
    writeFileSync(join(root, '.gh-token'), '# a comment\n\nGH_TOKEN=ghp_pasted_value\n', 'utf8')
    assert.equal(resolveToken({ root, env: {} }).token, 'ghp_pasted_value')
  })
  // A shell `export GH_TOKEN=...` paste must not become the literal token.
  withTempDir('hsf-token-', (root) => {
    writeFileSync(join(root, '.gh-token'), 'export GH_TOKEN=ghp_exported_value\n', 'utf8')
    assert.equal(resolveToken({ root, env: {} }).token, 'ghp_exported_value')
  })
  withTempDir('hsf-token-', (root) => {
    assert.deepEqual(resolveToken({ root, env: {} }), { token: null, source: 'none' })
  })
})

// ---------------------------------------------------------------------------
// package facts / notes
// ---------------------------------------------------------------------------

test('readPackageFacts derives the tag and npm-style tarball name', () => {
  const facts = readPackageFacts(ROOT)
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(facts.name, 'dsh-history-fictionologists')
  // 与 package.json 同步断言版本，而不是钉死一个字面量：后者每次定版都会红一次
  // （0.3.0 定版时就真的红了），而它的价值本来只是「tag/tarball 名派生正确」。
  assert.equal(facts.version, pkg.version)
  assert.equal(facts.tag, `v${pkg.version}`)
  assert.equal(facts.tarballName, `dsh-history-fictionologists-${pkg.version}.tgz`)
  assert.equal(facts.repository, 'Kaede0614/dsh-history-fictionologists')
  assert.ok(facts.files.includes('lib'), 'whitelist must include lib/')
})

test('readPackageFacts throws on a package.json without name/version', () => {
  withTempDir('hsf-pkg-', (root) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }), 'utf8')
    assert.throws(() => readPackageFacts(root), /missing a usable/)
  })
})

test('extractChangelogSection stops at the next `##` heading', () => {
  const changelog = [
    '# CHANGELOG',
    '',
    '## 0.2.0 — 2026-09-26',
    '',
    'new stuff',
    '',
    '### 新增',
    '',
    '- a bullet',
    '',
    '## 0.1.0 — 2026-09-01',
    '',
    'old stuff',
  ].join('\n')
  assert.equal(extractChangelogSection(changelog, '0.2.0'), 'new stuff\n\n### 新增\n\n- a bullet')
  assert.equal(extractChangelogSection(changelog, '0.1.0'), 'old stuff')
  assert.equal(extractChangelogSection(changelog, '9.9.9'), null)
  // `0.2.0` must not match a `0.2.0-rc.1` heading, and vice versa.
  assert.equal(extractChangelogSection('## 0.2.0-rc.1\n\nbody', '0.2.0'), null)
})

test('resolveReleaseNotes prefers inline, then file, then docs/release-notes, then CHANGELOG', () => {
  withTempDir('hsf-notes-', (root) => {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'CHANGELOG.md'), '## 1.0.0\n\nfrom changelog\n', 'utf8')

    assert.equal(resolveReleaseNotes({ root, version: '1.0.0', notes: 'inline' }).source, 'inline')
    assert.equal(resolveReleaseNotes({ root, version: '1.0.0' }).source, 'CHANGELOG.md § 1.0.0')

    writeFileSync(join(root, 'docs', 'release-notes-v1.0.0.md'), 'from doc\n', 'utf8')
    assert.equal(resolveReleaseNotes({ root, version: '1.0.0' }).source, 'docs/release-notes-v1.0.0.md')

    writeFileSync(join(root, 'extra.md'), 'from explicit file\n', 'utf8')
    const explicit = resolveReleaseNotes({ root, version: '1.0.0', notesFile: 'extra.md' })
    assert.equal(explicit.source, 'extra.md')
    assert.equal(explicit.body, 'from explicit file')
  })
})

test('resolveReleaseNotes returns null (never an empty release body) when there are no notes', () => {
  withTempDir('hsf-notes-', (root) => {
    const result = resolveReleaseNotes({ root, version: '3.3.3' })
    assert.equal(result.body, null)
    assert.equal(result.source, 'none')
  })
})

test('resolveReleaseNotes warns instead of throwing on an unreadable --notes-file', () => {
  withTempDir('hsf-notes-', (root) => {
    writeFileSync(join(root, 'CHANGELOG.md'), '## 1.0.0\n\nfallback\n', 'utf8')
    const result = resolveReleaseNotes({ root, version: '1.0.0', notesFile: 'nope.md' })
    assert.equal(result.body, 'fallback')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /could not read --notes-file nope\.md/)
  })
})

// ---------------------------------------------------------------------------
// tarball
// ---------------------------------------------------------------------------

test('collectPackEntries expands the whitelist and skips build junk', () => {
  withTempDir('hsf-pack-', (root) => {
    mkdirSync(join(root, 'lib', 'wiki'), { recursive: true })
    writeFileSync(join(root, 'lib', 'shell.js'), 'shell', 'utf8')
    writeFileSync(join(root, 'lib', 'wiki', 'index.mjs'), 'wiki', 'utf8')
    writeFileSync(join(root, 'lib', 'shell.js.bak'), 'backup', 'utf8')
    writeFileSync(join(root, 'lib', 'debug.log'), 'log', 'utf8')
    writeFileSync(join(root, 'lib', '.DS_Store'), 'junk', 'utf8')
    mkdirSync(join(root, 'lib', 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'lib', 'node_modules', 'dep.js'), 'dep', 'utf8')
    writeFileSync(join(root, 'NOTICE'), 'notice', 'utf8')

    const { entries, warnings } = collectPackEntries(root, ['lib', 'NOTICE'])
    assert.deepEqual(entries, ['NOTICE', 'lib/shell.js', 'lib/wiki/index.mjs'])
    assert.deepEqual(warnings, [])
  })
})

test('collectPackEntries warns about a whitelist entry that does not exist', () => {
  withTempDir('hsf-pack-', (root) => {
    const { entries, warnings } = collectPackEntries(root, ['lib'])
    assert.deepEqual(entries, [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /whitelist entry not found: lib/)
  })
})

test('buildTarball → readTarball round-trips content byte-for-byte', () => {
  withTempDir('hsf-tar-', (root) => {
    mkdirSync(join(root, 'lib'), { recursive: true })
    const big = Buffer.alloc(1500, 7) // spans more than one 512-byte block
    writeFileSync(join(root, 'lib', 'big.bin'), big)
    writeFileSync(join(root, 'lib', 'small.txt'), 'hello 虚构史学家', 'utf8')

    const tgz = buildTarball(root, ['lib/big.bin', 'lib/small.txt'])
    // gzip magic, so a plain tar is not silently accepted.
    assert.equal(tgz[0], 0x1f)
    assert.equal(tgz[1], 0x8b)

    const read = readTarball(tgz)
    assert.deepEqual(
      read.map((entry) => entry.name),
      ['lib/big.bin', 'lib/small.txt'],
    )
    assert.equal(read[0].size, 1500)
    assert.ok(read[0].content.equals(big))
    assert.equal(read[1].content.toString('utf8'), 'hello 虚构史学家')
    // The reader must stop exactly at the end-of-archive blocks.
    assert.equal(read.length, 2)
  })
})

test('a tarball built from the real whitelist is readable and covers the package', () => {
  const facts = readPackageFacts(ROOT)
  const { entries } = collectPackEntries(ROOT, facts.files)
  const tgz = buildTarball(ROOT, entries)
  const read = readTarball(tgz)

  assert.equal(read.length, entries.length)
  assert.ok(read.some((entry) => entry.name === 'lib/shell.js'))
  assert.ok(read.some((entry) => entry.name === 'package.json') === false, 'package.json is added by npm, not the whitelist')
  assert.ok(read.some((entry) => entry.name === 'cordis.patch.yml'))
  // Every archived entry must equal the file on disk — this is the check the release
  // script performs before uploading, asserted here so a regression fails offline.
  for (const entry of read) {
    assert.ok(entry.content.equals(readFileSync(join(ROOT, entry.name))), entry.name)
  }
})

// ---------------------------------------------------------------------------
// repo metadata
// ---------------------------------------------------------------------------

test('readRepoMeta pulls the About text and the topic list from the real doc', () => {
  const meta = readRepoMeta(ROOT)
  assert.ok(meta.description.startsWith('基于《崩坏：星穹铁道》官方世界观的 DSH 二创插件'), meta.description)
  // GitHub caps topics at 20 and requires lowercase/digits/hyphens.
  assert.ok(meta.topics.length > 0 && meta.topics.length <= 20, `topic count: ${meta.topics?.length}`)
  assert.ok(meta.topics.includes('dsh-plugin'))
  assert.ok(meta.topics.includes('honkai-star-rail'))
  for (const topic of meta.topics) assert.match(topic, /^[a-z0-9][a-z0-9-]*$/)
})

test('readRepoMeta reports absence instead of throwing', () => {
  withTempDir('hsf-meta-', (root) => {
    assert.deepEqual(readRepoMeta(root), { description: null, topics: null })
  })
})

// ---------------------------------------------------------------------------
// GitHub REST client
// ---------------------------------------------------------------------------

test('createGitHubClient sends auth, API version and a JSON body', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { id: 42 } }])
  const client = createGitHubClient({ token: 'secret-token', fetchImpl: impl })
  const response = await client.request('POST', '/repos/o/r/releases', { tag_name: 'v1' })

  assert.equal(response.status, 201)
  assert.equal(response.data.id, 42)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/releases')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.authorization, 'Bearer secret-token')
  assert.equal(calls[0].headers['x-github-api-version'], '2022-11-28')
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body), { tag_name: 'v1' })
})

test('createGitHubClient uploads binary assets untouched (the release-asset path)', async () => {
  const gzipBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00])
  const { impl, calls } = fakeFetch([{ status: 201, body: { id: 7 } }])
  const client = createGitHubClient({ token: 't', fetchImpl: impl })
  await client.request('POST', '/repos/o/r/releases/1/assets?name=a.tgz', undefined, {
    rawBody: gzipBytes,
    headers: { 'content-type': 'application/octet-stream' },
    upload: true,
  })

  assert.equal(calls[0].headers['content-type'], 'application/octet-stream')
  assert.ok(Buffer.isBuffer(calls[0].body), 'binary body must not be JSON-encoded')
  assert.ok(calls[0].body.equals(gzipBytes))
  // No caller-supplied content-length: fetch must compute it.
  assert.equal(calls[0].headers['content-length'], undefined)
})

// Regression for a defect found on the v0.3.0 publish run (2026-09-27), not by reasoning:
// with a `repo`-scoped token that had just PATCHed the release successfully, posting the
// tarball to the API root answered `403` with an HTML block page ("Access to this site has
// been restricted.") — indistinguishable from a scope problem — while the same bytes to
// uploads.github.com answered `201`. The API root must therefore never receive asset bytes.
test('release assets go to uploads.github.com, never to the API root', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { id: 7 } }])
  const client = createGitHubClient({ token: 't', fetchImpl: impl })
  await client.request('POST', '/repos/o/r/releases/1/assets?name=a.tgz', undefined, {
    rawBody: Buffer.from('x'),
    upload: true,
  })

  assert.equal(calls[0].url, 'https://uploads.github.com/repos/o/r/releases/1/assets?name=a.tgz')
  assert.ok(!calls[0].url.startsWith('https://api.github.com/'), 'the uploads host is not optional')
})

test('the upload host is overridable (GitHub Enterprise) and absolute paths win', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: {} }, { status: 201, body: {} }])
  const client = createGitHubClient({
    token: 't',
    api: 'https://ghe.example.com/api/v3',
    uploadApi: 'https://ghe.example.com/uploads',
    fetchImpl: impl,
  })
  await client.request('POST', '/repos/o/r/releases/1/assets?name=a.tgz', undefined, {
    rawBody: Buffer.from('x'),
    upload: true,
  })
  await client.request('POST', 'https://elsewhere.example.com/repos/o/r/releases/1/assets', undefined, {
    rawBody: Buffer.from('x'),
    upload: true,
  })

  assert.equal(calls[0].url, 'https://ghe.example.com/uploads/repos/o/r/releases/1/assets?name=a.tgz')
  assert.equal(calls[1].url, 'https://elsewhere.example.com/repos/o/r/releases/1/assets')
})

test('non-upload calls still go to the API root even when the uploads host is configured', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: {} }])
  const client = createGitHubClient({ token: 't', fetchImpl: impl })
  await client.request('GET', '/repos/o/r/releases/tags/v1')
  assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/releases/tags/v1')
})

// Regression for the OTHER half of the same v0.3.0 defect (measured): the log label
// `POST_BINARY` had leaked into the call as the HTTP method, so the wire request was
// `POST_BINARY /repos/…/assets HTTP/1.1` and GitHub answered `403` with a block page —
// on both hosts, which is why the 403 looked like a token problem. The verb check makes
// that mistake a local error instead of a mis-attributed server response.
test('a non-HTTP method is refused locally instead of being sent (the POST_BINARY trap)', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: {} }])
  const client = createGitHubClient({ token: 't', fetchImpl: impl })
  await assert.rejects(
    () => client.request('POST_BINARY', '/repos/o/r/releases/1/assets?name=a.tgz', undefined, { rawBody: Buffer.from('x') }),
    /not an HTTP method/,
  )
  assert.equal(calls.length, 0, 'nothing may reach the network with a bogus verb')
})

test('createGitHubClient survives a non-JSON error page without throwing a parse error', async () => {
  const { impl } = fakeFetch([{ status: 502, text: '<html>bad gateway</html>' }])
  const client = createGitHubClient({ token: 't', fetchImpl: impl })
  const response = await client.request('GET', '/repos/o/r')
  assert.equal(response.status, 502)
  assert.equal(response.data.message, '<html>bad gateway</html>')
})

test('describeApiFailure names the actual fix for 401 vs 403', () => {
  const unauthorised = describeApiFailure('creating the release', { status: 401, data: {} })
  const forbidden = describeApiFailure('creating the release', { status: 403, data: { message: 'Forbidden' } })
  const other = describeApiFailure('creating the release', { status: 422, data: { message: 'Validation Failed' } })
  assert.ok(unauthorised instanceof Error)
  assert.match(unauthorised.message, /token is missing, expired/)
  assert.match(forbidden.message, /lacks the required scope/)
  assert.match(other.message, /HTTP 422 — Validation Failed/)
})

test('createGitHubClient honours a custom API base and omits auth when the token is empty', async () => {
  const { impl, calls } = fakeFetch([{ status: 200, body: {} }])
  const client = createGitHubClient({ token: '', api: 'https://ghe.example.com/api/v3/', fetchImpl: impl })
  await client.request('GET', '/repos/o/r/releases/tags/v1')
  assert.equal(calls[0].url, 'https://ghe.example.com/api/v3/repos/o/r/releases/tags/v1')
  assert.equal(calls[0].headers.authorization, undefined)
})

test('createGitHubClient refuses to be constructed without a fetch implementation', () => {
  assert.throws(() => createGitHubClient({ token: 't', fetchImpl: null }), /no fetch implementation/)
})

/**
 * Publish a release — no `gh`, no `npm`, network via Node's `fetch`.
 *
 * This is the command-side counterpart of `lib/release-kit.mjs`; read that module's
 * header for why the toolchain is written this way. In short: on this machine `gh` is
 * not installed at all and `npm.cmd` dies with EPERM writing its cache, so a release
 * script that shells out to either one cannot run. `node` always can.
 *
 * Usage:
 *   node scripts/release.mjs                 # verify + build tarball, change nothing
 *   node scripts/release.mjs --dry-run       # print every planned API call
 *   node scripts/release.mjs --publish       # push the tag, create/update the Release
 *   node scripts/release.mjs --publish --sync-meta
 *
 * Flags:
 *   --publish          actually write to GitHub (default: plan only)
 *   --dry-run          print the plan without any write (implied when --publish is absent)
 *   --repo o/r         override the repository (default: git remote "origin")
 *   --tag vX.Y.Z       override the tag (default: v<package.json version>)
 *   --notes "..."      inline release body
 *   --notes-file f.md  release body from a file
 *   --draft            create the Release as a draft
 *   --prerelease       mark the Release as a prerelease
 *   --no-asset         do not attach the tarball
 *   --skip-tag-push    do not push the tag (use when it is already on the remote)
 *   --sync-meta        also sync repo description + topics from docs/github-description.md
 *   --allow-dirty      proceed even with uncommitted changes
 *   --keep             keep the generated tarball (default: keep only when publishing)
 *   --json             machine-readable plan/result
 *   --help
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildTarball,
  collectPackEntries,
  createGitHubClient,
  DEFAULT_UPLOAD_API,
  describeApiFailure,
  parseRepoSlug,
  readPackageFacts,
  readRepoMeta,
  readTarball,
  resolveReleaseNotes,
  resolveToken,
} from '../lib/release-kit.mjs'

const ROOT = join(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// tiny CLI plumbing
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  'publish', 'dry-run', 'draft', 'prerelease', 'no-asset', 'skip-tag-push',
  'sync-meta', 'allow-dirty', 'keep', 'json', 'help',
])
const VALUE_FLAGS = new Set(['repo', 'tag', 'notes', 'notes-file'])

function parseArgs(argv) {
  const flags = {}
  const errors = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      errors.push(`unexpected argument: ${arg}`)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true
      continue
    }
    if (!VALUE_FLAGS.has(name)) {
      errors.push(`unknown flag: --${name}`)
      continue
    }
    if (inlineValue !== undefined) {
      flags[name] = inlineValue
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      errors.push(`--${name} needs a value`)
      continue
    }
    flags[name] = next
    i += 1
  }
  return { flags, errors }
}

const HELP = `Publish a GitHub release without gh or npm.

  node scripts/release.mjs [--publish] [--dry-run] [--repo o/r] [--tag vX.Y.Z]
                           [--notes "text"] [--notes-file path] [--draft]
                           [--prerelease] [--no-asset] [--skip-tag-push]
                           [--sync-meta] [--allow-dirty] [--keep] [--json]

Without --publish nothing is written: the script verifies the tree, builds the
tarball and prints exactly which API calls --publish would make.
Run "node scripts/release.mjs --dry-run" to see every endpoint it would touch.`

// ---------------------------------------------------------------------------
// git helpers — subprocess stdout is captured through a FILE DESCRIPTOR
//
// Two environment constraints shape this:
//   1. Under the DSH file sandbox a child process cannot open a named pipe, so
//      `spawnSync(..., {stdio:'pipe'})` fails with EPERM.
//   2. `cmd.exe /s /c "... > \"file\""` is not a safe substitute: `/s` strips the outer
//      quotes, so the redirect target arrives mangled and git dies with "The filename,
//      directory name, or volume label syntax is incorrect" — observed here, silently
//      reporting HEAD/branch/dirty as unknown.
// Passing a real file descriptor is the one form that works in every mode: no pipe, no
// shell parsing.
// ---------------------------------------------------------------------------

/**
 * Run git, capturing combined stdout+stderr into a temp file via a file descriptor.
 * @param {string[]} args
 * @returns {{ok: boolean, text: string}}
 */
function captureGit(args) {
  const scratch = mkdtempSync(join(tmpdir(), 'hsf-git-'))
  const outFile = join(scratch, 'out.txt')
  let fd
  try {
    fd = openSync(outFile, 'w')
    const result = spawnSync('git', args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
    return { ok: !result.error && result.status === 0, text: readFileSync(outFile, 'utf8') }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // already closed by the child on some platforms; nothing to do
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** `owner/repo` from the origin remote, or null. */
function repoFromGit() {
  const { ok, text } = captureGit(['config', '--get', 'remote.origin.url'])
  return ok ? parseRepoSlug(text.trim()) : null
}

/**
 * Does the tag exist on the remote, and which commit does it peel to?
 *
 * The glob query is deliberately followed by an EXACT ref match: `git ls-remote refs/tags/v0.2.0*`
 * also returns `refs/tags/v0.2.0-rc.1` (measured), so trusting the raw line count would report
 * `v0.2.0` as "already on the remote" when only the rc exists.
 */
function remoteTagState(tag) {
  const ref = `refs/tags/${tag}`
  const { ok, text } = captureGit(['ls-remote', '--tags', 'origin', `${ref}*`])
  // A failed `ls-remote` (offline, or the tag genuinely absent) must not be mistaken for
  // "no such tag" when publishing — the caller reports this as unknown, not absent.
  if (!ok) return { exists: false, peeled: null, known: false }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{7,40}\s/.test(line))
  const exact = lines.filter((line) => {
    const name = line.split(/\s+/)[1] ?? ''
    return name === ref || name === `${ref}^{}`
  })
  if (exact.length === 0) return { exists: false, peeled: null, known: true }
  const peeledLine = exact.find((line) => (line.split(/\s+/)[1] ?? '') === `${ref}^{}`)
  const peeled = peeledLine ? peeledLine.split(/\s+/)[0] : null
  return { exists: true, peeled, known: true }
}

/** Local HEAD that --publish would tag. */
function localHead() {
  const { ok, text } = captureGit(['rev-parse', 'HEAD'])
  const hash = text.trim().split(/\s+/)[0] ?? ''
  return ok && /^[0-9a-f]{7,40}$/.test(hash) ? hash : null
}

function isDirty() {
  const { ok, text } = captureGit(['status', '--porcelain'])
  return !ok || text.trim().length > 0
}

function currentBranch() {
  const { ok, text } = captureGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = text.trim()
  return ok && branch.length > 0 ? branch : null
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { flags, errors } = parseArgs(process.argv.slice(2))
  const json = flags.json === true
  const written = []
  const log = (text) => {
    written.push(text)
    if (!json) console.log(text)
  }

  if (flags.help === true) {
    console.log(HELP)
    return 0
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`)
    console.error(`\n${HELP}`)
    return 2
  }
  if (flags.publish === true && flags['dry-run'] === true) {
    // Without this guard the run writes nothing (every write is gated on `dryRun`) but still
    // reports PUBLISHED, because the result string only looked at `willPublish`.
    console.error('error: --publish and --dry-run are mutually exclusive (--dry-run writes nothing).')
    return 2
  }

  const facts = readPackageFacts(ROOT)
  const tag = typeof flags.tag === 'string' ? flags.tag : facts.tag
  const repo =
    (typeof flags.repo === 'string' ? parseRepoSlug(flags.repo) : null) ?? repoFromGit() ?? facts.repository
  const willPublish = flags.publish === true
  const dryRun = flags['dry-run'] === true || !willPublish
  const wantAsset = flags['no-asset'] !== true
  const syncMeta = flags['sync-meta'] === true

  if (repo === null) {
    console.error('error: cannot determine the repository. Pass --repo owner/name.')
    return 2
  }

  // ---- notes -------------------------------------------------------------
  const notes = resolveReleaseNotes({
    root: ROOT,
    version: facts.version,
    notes: typeof flags.notes === 'string' ? flags.notes : null,
    notesFile: typeof flags['notes-file'] === 'string' ? flags['notes-file'] : null,
  })
  for (const warning of notes.warnings) log(`warning: ${warning}`)
  if (notes.body === null) {
    console.error(
      `error: no release notes found for ${facts.version}. Provide --notes/--notes-file, or add ` +
        `docs/release-notes-v${facts.version}.md.`,
    )
    return 2
  }

  // ---- tree state --------------------------------------------------------
  const head = localHead()
  const dirty = isDirty()
  const branch = currentBranch()
  const tagState = remoteTagState(tag)

  log(`package      ${facts.name}@${facts.version}`)
  log(`repository   ${repo}`)
  if (tagState.known) {
    log(`tag          ${tag}${tagState.exists ? '  (already on the remote)' : '  (not on the remote yet)'}`)
  } else {
    log(`tag          ${tag}  (remote state UNKNOWN — git ls-remote failed; check your network)`)
  }
  log(`branch       ${branch ?? '(unknown)'}  HEAD ${head ? head.slice(0, 8) : '(unknown)'}`)
  log(`notes        ${notes.source} (${notes.body.length} chars)`)
  log(`mode         ${willPublish ? 'PUBLISH (writes to GitHub)' : 'PLAN ONLY (nothing will be written)'}`)
  if (dirty) log('warning: working tree has uncommitted changes')

  if (willPublish && dirty && flags['allow-dirty'] !== true) {
    console.error('\nerror: refusing to publish from a dirty tree. Commit first, or pass --allow-dirty.')
    return 1
  }
  if (willPublish && !tagState.known) {
    console.error(
      `\nerror: cannot tell whether ${tag} already exists on the remote (git ls-remote failed). ` +
        'Refusing to publish blind — re-run when the network is up.',
    )
    return 1
  }
  if (willPublish && tagState.exists && tagState.peeled !== null && head !== null && tagState.peeled !== head) {
    log(
      `warning: remote tag ${tag} points at ${tagState.peeled.slice(0, 8)}, but HEAD is ` +
        `${head.slice(0, 8)}. The Release will describe the tagged commit, not the current tree. ` +
        'Use --tag to pick another tag.',
    )
  }

  // ---- tarball -----------------------------------------------------------
  const { entries, warnings: entryWarnings } = collectPackEntries(ROOT, facts.files)
  for (const warning of entryWarnings) log(`warning: ${warning}`)
  const tarball = buildTarball(ROOT, entries)

  // Read our own archive back before offering it to anyone: a corrupt tgz would
  // otherwise only be discovered by a user running `dsh plugin add`.
  const readBack = readTarball(tarball)
  if (readBack.length !== entries.length) {
    console.error(`error: archive holds ${readBack.length} entries, expected ${entries.length}`)
    return 1
  }
  for (const entry of readBack) {
    const onDisk = statSync(join(ROOT, entry.name)).size
    if (entry.size !== onDisk || !entry.content.equals(readFileSync(join(ROOT, entry.name)))) {
      console.error(`error: archive entry ${entry.name} does not match the file on disk`)
      return 1
    }
  }
  log(
    `tarball      ${facts.tarballName} — ${entries.length} files, ${(tarball.length / 1024).toFixed(1)} kB ` +
      `(read-back verified byte-for-byte against disk)`,
  )

  const assetPath = join(ROOT, facts.tarballName)
  const keep = flags.keep === true || willPublish
  writeFileSync(assetPath, tarball)

  // This repository's suite contains byte-for-byte assertions against its own source
  // (see .gitattributes), so a CRLF-contaminated artifact is a real defect, not a style
  // nit. `core.autocrlf=true` is set globally on the reference machine, which makes this
  // worth checking on every release rather than trusting the checkout.
  const crlfFiles = []
  for (const entry of readBack) {
    if (/\.(?:js|mjs|json|md|yml|yaml|txt)$/i.test(entry.name) && entry.content.includes(0x0d)) {
      crlfFiles.push(entry.name)
    }
  }
  if (crlfFiles.length > 0) {
    log(
      `warning: ${crlfFiles.length} text file(s) in the archive contain CR bytes ` +
        `(core.autocrlf?): ${crlfFiles.slice(0, 5).join(', ')}${crlfFiles.length > 5 ? ' …' : ''}`,
    )
  }

  // ---- credentials -------------------------------------------------------
  const tokenInfo = resolveToken({ root: ROOT })
  const client = createGitHubClient({ token: tokenInfo.token ?? '', fetchImpl: globalThis.fetch })
  const plan = []
  const api = async (method, path, body, extra) => {
    // `POST_BINARY` is a LOG LABEL, never the wire method: sending it verbatim as the HTTP
    // verb is exactly what produced the 403 on the v0.3.0 run (the client now refuses it).
    const label = extra?.rawBody !== undefined ? 'POST_BINARY' : method
    plan.push(`${label} ${path}`)
    if (dryRun) {
      const bodyLabel = body === undefined ? '' : `  ${JSON.stringify(body).slice(0, 140)}`
      log(`would  ${label.padEnd(6)} ${path}${bodyLabel}`)
      return { status: 0, data: null }
    }
    const response = await client.request(method, path, body, extra)
    log(`       ${label.padEnd(6)} ${path} -> ${response.status}`)
    return response
  }

  if (willPublish && tokenInfo.token === null) {
    console.error(
      '\nerror: no GitHub token found.\n' +
        '  Create a classic token with the "repo" scope at https://github.com/settings/tokens\n' +
        `  then either set GH_TOKEN=... or write it into ${join(ROOT, '.gh-token')} (gitignored).`,
    )
    return 1
  }
  log(`token        ${tokenInfo.token === null ? 'NONE (plan only)' : `found via ${tokenInfo.source}`}`)

  // ---- tag ---------------------------------------------------------------
  if (!tagState.exists) {
    const message = `Release ${tag}`
    if (dryRun) {
      log(`would  git tag -a ${tag} -m "${message}"`)
      log(`would  git push origin ${tag}`)
    } else if (flags['skip-tag-push'] !== true) {
      const created = captureGit(['tag', '-a', tag, '-m', message])
      if (!created.ok) {
        console.error(`error: git tag ${tag} failed:\n${created.text.trim()}`)
        return 1
      }
      const pushed = captureGit(['push', 'origin', tag])
      if (!pushed.ok) {
        console.error(`error: git push origin ${tag} failed:\n${pushed.text.trim()}`)
        return 1
      }
      log(`       pushed tag ${tag}`)
    }
  }

  // ---- release -----------------------------------------------------------
  // Title mirrors the existing release convention (`v0.2.0 — <project name>`).
  const releaseBody = {
    tag_name: tag,
    name: `${tag} — ${facts.name}`,
    body: notes.body,
    draft: flags.draft === true,
    prerelease: flags.prerelease === true,
  }

  let releaseId = null
  if (dryRun) {
    log(`would  GET    /repos/${repo}/releases/tags/${tag}   (update if it exists)`)
    log(`would  POST   /repos/${repo}/releases   ${JSON.stringify({ ...releaseBody, body: `${notes.body.slice(0, 40)}…` })}`)
    if (wantAsset) {
      // The uploads host is part of the plan, not an implementation detail: posting the same
      // bytes to the API root is what produced the 403 on v0.3.0 (see DEFAULT_UPLOAD_API).
      log(`would  POST_BINARY ${DEFAULT_UPLOAD_API}/repos/${repo}/releases/<new id>/assets?name=${facts.tarballName}  (${(tarball.length / 1024).toFixed(1)} kB)`)
    }
    releaseId = 0
  } else {
    const existing = await client.request('GET', `/repos/${repo}/releases/tags/${tag}`)
    plan.push(`GET /repos/${repo}/releases/tags/${tag}`)
    if (existing.status === 200) {
      releaseId = existing.data.id
      const updated = await api('PATCH', `/repos/${repo}/releases/${releaseId}`, releaseBody)
      if (updated.status >= 400) throw describeApiFailure('updating the release', updated)
    } else if (existing.status === 404) {
      const created = await api('POST', `/repos/${repo}/releases`, releaseBody)
      if (created.status >= 400) throw describeApiFailure('creating the release', created)
      releaseId = created.data.id
    } else {
      throw describeApiFailure('looking up the release', existing)
    }
  }

  // ---- asset -------------------------------------------------------------
  if (wantAsset && !dryRun) {
    const listed = await client.request('GET', `/repos/${repo}/releases/${releaseId}/assets`)
    if (listed.status >= 400) throw describeApiFailure('listing release assets', listed)
    const clash = (listed.data ?? []).find((asset) => asset.name === facts.tarballName)
    if (clash) {
      const removed = await api('DELETE', `/repos/${repo}/releases/assets/${clash.id}`)
      if (removed.status >= 400) throw describeApiFailure('deleting the previous asset', removed)
    }
    const uploadPath = `/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(facts.tarballName)}`
    const upload = await api('POST', uploadPath, undefined, {
      rawBody: tarball,
      headers: { 'content-type': 'application/octet-stream' },
      upload: true,
    })
    if (upload.status >= 400) throw describeApiFailure('uploading the tarball', upload)
    log(`       uploaded ${facts.tarballName} (${(tarball.length / 1024).toFixed(1)} kB)`)
  }

  // ---- repo metadata -----------------------------------------------------
  if (syncMeta) {
    const meta = readRepoMeta(ROOT)
    if (meta.description === null && meta.topics === null) {
      log('warning: --sync-meta found nothing to sync in docs/github-description.md')
    }
    if (meta.description !== null) {
      const patched = await api('PATCH', `/repos/${repo}`, {
        description: meta.description,
        homepage: `https://github.com/${repo}#readme`,
      })
      if (!dryRun && patched.status >= 400) throw describeApiFailure('updating the repo description', patched)
    }
    if (meta.topics !== null) {
      const topics = await api('PUT', `/repos/${repo}/topics`, { names: meta.topics })
      if (!dryRun && topics.status >= 400) throw describeApiFailure('updating topics', topics)
      log(`       topics -> ${meta.topics.join(', ')}`)
    }
  }

  // ---- verification ------------------------------------------------------
  let verified = null
  if (!dryRun) {
    const check = await client.request('GET', `/repos/${repo}/releases/tags/${tag}`)
    if (check.status !== 200) {
      throw describeApiFailure('verifying the published release', check)
    }
    const assets = (check.data.assets ?? []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
    }))
    verified = { tag, url: check.data.html_url, draft: check.data.draft, assets }
    log(`\nverified     ${check.data.html_url}`)
    for (const asset of assets) log(`             ${asset.name}  ${asset.size} bytes`)
    if (wantAsset && !assets.some((asset) => asset.name === facts.tarballName)) {
      log(`warning: ${facts.tarballName} is not attached to the release`)
    }
  }

  log(`\nRESULT: ${willPublish ? 'PUBLISHED' : 'PLAN OK (nothing written)'}  [${plan.length} API steps]`)
  log(`tarball: ${keep ? assetPath : 'removed (pass --keep to keep it)'}`)

  if (json) {
    console.log(
      JSON.stringify(
        {
          result: willPublish ? 'published' : 'plan',
          repo,
          tag,
          version: facts.version,
          notesSource: notes.source,
          tarball: { name: facts.tarballName, bytes: tarball.length, entries: entries.length },
          plan,
          verified,
        },
        null,
        2,
      ),
    )
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })

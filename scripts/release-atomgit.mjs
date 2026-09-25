/**
 * Publish a release to AtomGit (atomgit.com) — no `gh`, no `npm`, network via Node's `fetch`.
 *
 * This is the AtomGit counterpart of `scripts/release.mjs`; read `lib/atomgit-kit.mjs` for the
 * four platform differences that make it more than a host swap. In short: `PRIVATE-TOKEN`
 * auth, releases addressed by tag (no numeric id), attachments uploaded through a signed
 * two-step, and same-name attachments that cannot be overwritten.
 *
 * Usage:
 *   node scripts/release-atomgit.mjs                       # verify + build tarball, change nothing
 *   node scripts/release-atomgit.mjs --repo Scombriformes/dsh-history-fictionologists
 *   node scripts/release-atomgit.mjs --publish --create-repo
 *   node scripts/release-atomgit.mjs --publish             # repo already exists: push + release
 *
 * Flags:
 *   --publish            actually write to AtomGit (default: plan only)
 *   --dry-run            print the plan without any write (implied when --publish is absent)
 *   --repo o/r           override the repository (default: git remote "atomgit")
 *   --git-remote name    which git remote to push through (default: atomgit)
 *   --create-repo        create the repository through the API when it does not exist
 *   --tag vX.Y.Z         override the tag (default: v<package.json version>)
 *   --notes "..."        inline release body
 *   --notes-file f.md    release body from a file
 *   --prerelease         mark the Release as a prerelease (release_status: pre)
 *   --no-asset           do not attach the tarball
 *   --no-push-branch     do not push the branch (only the tag)
 *   --skip-tag-push      do not push the tag (use when it is already on the remote)
 *   --no-verify-download download the uploaded asset back and compare it byte-for-byte
 *   --allow-dirty        proceed even with uncommitted changes
 *   --keep               label the generated tarball as intentional (it is always left on disk;
 *                        *.tgz is gitignored, and this project never deletes files)
 *   --json               machine-readable plan/result
 *   --help
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import {
  buildTarball,
  collectPackEntries,
  readPackageFacts,
  readTarball,
  resolveReleaseNotes,
} from '../lib/release-kit.mjs'

const ROOT = join(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// tiny CLI plumbing
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set([
  'publish', 'dry-run', 'create-repo', 'prerelease', 'draft', 'no-asset', 'no-push-branch',
  'skip-tag-push', 'no-verify-download', 'allow-dirty', 'keep', 'json', 'help',
])
const VALUE_FLAGS = new Set(['repo', 'git-remote', 'tag', 'notes', 'notes-file'])

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

const HELP = `Publish an AtomGit release without gh or npm.

  node scripts/release-atomgit.mjs [--publish] [--dry-run] [--repo o/r]
                                   [--git-remote name] [--create-repo] [--tag vX.Y.Z]
                                   [--notes "text"] [--notes-file path] [--prerelease]
                                   [--no-asset] [--no-push-branch] [--skip-tag-push]
                                   [--no-verify-download] [--allow-dirty] [--keep] [--json]

Without --publish nothing is written: the script verifies the tree, builds the tarball and
prints exactly which API calls --publish would make.

Auth: put a classic token (${ATOMGIT_TOKEN_URL}) in \`.atomgit-token\` or %ATOMGIT_TOKEN%.
The token is never printed, and never reaches git's command line.`

// ---------------------------------------------------------------------------
// git helpers — subprocess stdout is captured through a FILE DESCRIPTOR
//
// Same two environment constraints as scripts/release.mjs, and the same answer:
//   1. Under the DSH file sandbox a child process cannot open a named pipe, so
//      `spawnSync(..., {stdio:'pipe'})` fails with EPERM.
//   2. `cmd.exe /s /c "... > \\"file\\""` is not a safe substitute: `/s` strips the outer
//      quotes and git dies with "The filename, directory name, or volume label syntax is
//      incorrect", silently reporting HEAD/branch/dirty as unknown.
// A real file descriptor is the one form that works in every mode.
// ---------------------------------------------------------------------------

/**
 * Run git, capturing combined stdout+stderr into a temp file via a file descriptor.
 * @param {string[]} args
 * @param {{env?: Record<string, string|undefined>}} [options]
 * @returns {{ok: boolean, text: string}}
 */
function captureGit(args, { env } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'hsf-git-'))
  const outFile = join(scratch, 'out.txt')
  let fd
  try {
    fd = openSync(outFile, 'w')
    const result = spawnSync('git', args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: env ?? process.env,
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

/**
 * Arguments that make git authenticate with the token without the token touching argv.
 *
 * An empty `credential.helper` first clears any inherited helper — on this machine Git
 * Credential Manager does not recognise atomgit.com and would otherwise fall back to
 * prompting — and the shell-form helper then answers from the environment variable.
 */
function credentialArgs() {
  return [
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!f() { echo username=oauth2; echo password=$HSF_ATOMGIT_TOKEN; }; f',
  ]
}

function gitEnv(token) {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', HSF_ATOMGIT_TOKEN: token ?? '' }
}

/** `owner/repo` from the configured atomgit remote, or null. */
function repoFromGit(remote) {
  const { ok, text } = captureGit(['remote', 'get-url', remote])
  return ok ? parseAtomgitSlug(text.trim()) : null
}

/** Does the named remote exist at all? */
function remoteExists(remote) {
  return captureGit(['remote', 'get-url', remote]).ok
}

/**
 * Does the tag exist on the remote, and which commit does it peel to?
 *
 * The glob query is deliberately followed by an EXACT ref match. `git ls-remote refs/tags/v0.2.0*`
 * also returns `refs/tags/v0.2.0-rc.1` (measured), so trusting the raw line count would report
 * `v0.2.0` as "already on the remote" when only the rc exists — the script would then skip
 * pushing it and let the server create the tag at the default branch tip, while logging that
 * it was already there.
 */
function remoteTagState(remote, tag) {
  const ref = `refs/tags/${tag}`
  const { ok, text } = captureGit(['ls-remote', '--tags', remote, `${ref}*`])
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

/** Is a local tag already defined, and which commit does it point at? */
function localTagState(tag) {
  const { ok, text } = captureGit(['rev-parse', '--verify', `refs/tags/${tag}`])
  const hash = text.trim().split(/\s+/)[0] ?? ''
  if (!ok || !/^[0-9a-f]{7,40}$/.test(hash)) return { exists: false, commit: null }
  const peeled = captureGit(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])
  const commit = peeled.text.trim().split(/\s+/)[0] ?? ''
  return { exists: true, commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : hash }
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

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
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
  if (flags.draft === true) {
    console.error('error: AtomGit has no draft releases (release_status is only pre|latest). Use --prerelease.')
    return 2
  }

  const remote = typeof flags['git-remote'] === 'string' ? flags['git-remote'] : 'atomgit'
  const facts = readPackageFacts(ROOT)
  const tag = typeof flags.tag === 'string' ? flags.tag : facts.tag
  const repo =
    (typeof flags.repo === 'string' ? parseAtomgitSlug(flags.repo) : null) ?? repoFromGit(remote)
  const willPublish = flags.publish === true
  const dryRun = flags['dry-run'] === true || !willPublish
  const wantAsset = flags['no-asset'] !== true
  const wantDownloadCheck = flags['no-verify-download'] !== true
  const createRepo = flags['create-repo'] === true

  if (repo === null) {
    console.error(
      `error: cannot determine the AtomGit repository.\n` +
        `  Pass --repo owner/name, or add the remote:\n` +
        `    git remote add ${remote} ${ATOMGIT_WEB}/<owner>/<name>.git`,
    )
    return 2
  }
  const parts = splitSlug(repo)
  if (parts === null) {
    console.error(`error: unusable repository slug: ${repo}`)
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
  const remotePresent = remoteExists(remote)
  const tagState = remotePresent ? remoteTagState(remote, tag) : { exists: false, peeled: null, known: false }
  const localTag = localTagState(tag)

  log(`package      ${facts.name}@${facts.version}`)
  log(`repository   ${repo}  (${ATOMGIT_WEB}/${repo})`)
  if (!remotePresent) {
    log(`git remote   ${remote}  (MISSING — --publish would add ${ATOMGIT_WEB}/${repo}.git)`)
    // Saying "git ls-remote failed" here would contradict the line above: there is no remote
    // to ask yet, which is a different situation from a network failure.
    log(`tag          ${tag}  (remote state UNKNOWN — the remote does not exist yet)`)
  } else if (tagState.known) {
    log(`tag          ${tag}${tagState.exists ? '  (already on the remote)' : '  (not on the remote yet)'}`)
  } else {
    log(`tag          ${tag}  (remote state UNKNOWN — git ls-remote failed; check your network)`)
  }
  log(`branch       ${branch ?? '(unknown)'}  HEAD ${head ? head.slice(0, 8) : '(unknown)'}`)
  if (localTag.exists) {
    log(`local tag    ${tag} -> ${localTag.commit ? localTag.commit.slice(0, 8) : '(unresolved)'}`)
  }
  log(`notes        ${notes.source} (${notes.body.length} chars)`)
  log(`mode         ${willPublish ? 'PUBLISH (writes to AtomGit)' : 'PLAN ONLY (nothing will be written)'}`)
  if (dirty) log('warning: working tree has uncommitted changes')

  if (willPublish && dirty && flags['allow-dirty'] !== true) {
    console.error('\nerror: refusing to publish from a dirty tree. Commit first, or pass --allow-dirty.')
    return 1
  }
  if (willPublish && remotePresent && !tagState.known) {
    console.error(
      `\nerror: cannot tell whether ${tag} already exists on ${remote} (git ls-remote failed). ` +
        'Refusing to publish blind — re-run when the network is up.',
    )
    return 1
  }
  if (localTag.exists && head !== null && localTag.commit !== null && localTag.commit !== head) {
    log(
      `warning: local tag ${tag} points at ${localTag.commit.slice(0, 8)}, but HEAD is ${head.slice(0, 8)}. ` +
        'The Release will describe the tagged commit, not the current tree.',
    )
  }
  // The remote check matters more than the local one: "the tag is already on the remote at an
  // older commit and I have no local copy of it" is the common case, and it used to be silent.
  if (tagState.exists && tagState.peeled !== null && head !== null && tagState.peeled !== head) {
    log(
      `warning: remote tag ${tag} points at ${tagState.peeled.slice(0, 8)}, but HEAD is ${head.slice(0, 8)}. ` +
        'The Release will describe the tagged commit, not the current tree. Use --tag to pick another tag.',
    )
  }

  // ---- tarball -----------------------------------------------------------
  const { entries, warnings: entryWarnings } = collectPackEntries(ROOT, facts.files)
  for (const warning of entryWarnings) log(`warning: ${warning}`)
  const tarball = buildTarball(ROOT, entries)

  // Read our own archive back before offering it to anyone: a corrupt tgz would otherwise
  // only be discovered by a user running `dsh plugin add`.
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
  const tarballSha = sha256(tarball)
  log(
    `tarball      ${facts.tarballName} — ${entries.length} files, ${(tarball.length / 1024).toFixed(1)} kB, ` +
      `sha256 ${tarballSha.slice(0, 16)}… (read-back verified byte-for-byte against disk)`,
  )

  const assetPath = join(ROOT, facts.tarballName)
  const keep = flags.keep === true || willPublish
  writeFileSync(assetPath, tarball)

  // This repository's suite contains byte-for-byte assertions against its own source (see
  // .gitattributes), so a CRLF-contaminated artifact is a real defect, not a style nit.
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
  const tokenInfo = resolveAtomgitToken({ root: ROOT })
  const client = createAtomgitClient({ token: tokenInfo.token ?? '', fetchImpl: globalThis.fetch })
  const plan = []
  // In plan mode nothing is executed, so the plan has to be recorded here rather than by
  // `api()` — otherwise `--dry-run` reports "[0 API steps]" for a plan it just printed.
  const would = (text) => {
    plan.push(text)
    log(`would  ${text}`)
  }
  const api = async (method, path, body, extra) => {
    plan.push(`${method} ${path}`)
    if (dryRun) {
      const label = body === undefined ? '' : `  ${JSON.stringify(body).slice(0, 140)}`
      log(`would  ${method.padEnd(6)} ${path}${label}`)
      return { status: 0, data: null }
    }
    const response = await client.request(method, path, body, extra)
    log(`       ${method.padEnd(6)} ${path} -> ${response.status}`)
    return response
  }

  if (willPublish && tokenInfo.token === null) {
    console.error(
      '\nerror: no AtomGit token found.\n' +
        `  Create a classic token at ${ATOMGIT_TOKEN_URL} (repository read/write)\n` +
        `  then either set ATOMGIT_TOKEN=... or write it into ${join(ROOT, '.atomgit-token')} (gitignored).`,
    )
    return 1
  }
  log(`token        ${tokenInfo.token === null ? 'NONE (plan only)' : `found via ${tokenInfo.source}`}`)

  // ---- remote ------------------------------------------------------------
  const remoteUrl = `${ATOMGIT_WEB}/${repo}.git`
  if (!remotePresent) {
    if (dryRun) {
      log(`would  git remote add ${remote} ${remoteUrl}`)
    } else {
      const added = captureGit(['remote', 'add', remote, remoteUrl])
      if (!added.ok) {
        console.error(`error: git remote add ${remote} failed:\n${added.text.trim()}`)
        return 1
      }
      log(`       added git remote ${remote} -> ${remoteUrl}`)
    }
  }

  // ---- repository --------------------------------------------------------
  let repoCreated = null
  if (createRepo) {
    if (dryRun) {
      log(`would  GET    /repos/${repo}/branches   (existence probe)`)
      log(`would  POST   /orgs/${parts.owner}/repos   ${JSON.stringify(buildCreateRepoBody({ name: parts.repo, description: facts.description }))}`)
    } else {
      const probe = await api('GET', `/repos/${repo}/branches`)
      if (probe.status === 200) {
        repoCreated = false
        log(`       repository already exists`)
      } else if (probe.status === 404) {
        const created = await api('POST', `/orgs/${parts.owner}/repos`, buildCreateRepoBody({
          name: parts.repo,
          description: facts.description,
        }))
        if (created.status >= 400) {
          // 409 is the documented code for "a resource with that name already exists". 400 is
          // "a required attribute is missing" and must NOT be swallowed as "already exists" —
          // that would hide a malformed request behind an unrelated push error further down.
          const message = typeof created.data?.message === 'string' ? created.data.message : ''
          if (created.status === 409 || created.status === 422) {
            repoCreated = false
            log(`warning: repository creation answered ${created.status} (${message}) — assuming it exists`)
          } else {
            throw describeAtomgitFailure('creating the repository', created)
          }
        } else {
          repoCreated = true
          log(`       created repository ${repo}`)
        }
      } else {
        throw describeAtomgitFailure('probing the repository', probe)
      }
    }
  }

  // ---- branch + tag ------------------------------------------------------
  if (flags['no-push-branch'] !== true && branch !== null) {
    if (dryRun) {
      would(`git push ${remote} ${branch}`)
    } else {
      const pushed = captureGit([...credentialArgs(), 'push', remote, branch], { env: gitEnv(tokenInfo.token) })
      if (!pushed.ok) {
        console.error(`error: git push ${remote} ${branch} failed:\n${pushed.text.trim()}`)
        return 1
      }
      log(`       pushed branch ${branch}`)
    }
  }

  if (!tagState.exists) {
    const message = `Release ${tag}`
    if (dryRun) {
      if (!localTag.exists) log(`would  git tag -a ${tag} -m "${message}"`)
      log(`would  git push ${remote} ${tag}`)
    } else if (flags['skip-tag-push'] !== true) {
      if (!localTag.exists) {
        const created = captureGit(['tag', '-a', tag, '-m', message])
        if (!created.ok) {
          console.error(`error: git tag ${tag} failed:\n${created.text.trim()}`)
          return 1
        }
      }
      const pushed = captureGit([...credentialArgs(), 'push', remote, tag], { env: gitEnv(tokenInfo.token) })
      if (!pushed.ok) {
        console.error(`error: git push ${remote} ${tag} failed:\n${pushed.text.trim()}`)
        return 1
      }
      log(`       pushed tag ${tag}`)
    } else if (!localTag.exists) {
      // Refusing here rather than continuing: with no tag anywhere, the release would be
      // created against a tag the server invents at the default branch tip, and the log
      // would never say so.
      console.error(
        `\nerror: --skip-tag-push was given, but ${tag} exists neither locally nor on ${remote}.\n` +
          '  Nothing would create the tag, so the Release would be attached to a tag the server\n' +
          '  invents at the default branch tip. Drop --skip-tag-push.',
      )
      return 1
    }
  }

  // ---- release -----------------------------------------------------------
  const body = buildAtomgitReleaseBody({
    tag,
    name: `${tag} — ${facts.name}`,
    body: notes.body,
    // Only pin the target when the tag does not exist yet; an existing tag speaks for itself.
    targetCommitish: tagState.exists ? null : branch ?? head ?? null,
    prerelease: flags.prerelease === true,
  })

  if (dryRun) {
    would(`GET    /repos/${repo}/releases/tags/${encodeURIComponent(tag)}   (PATCH it if it exists, else POST below)`)
    would(`POST   /repos/${repo}/releases   ${JSON.stringify({ ...body, body: `${notes.body.slice(0, 40)}…` })}`)
  } else {
    const existing = await api('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    if (existing.status === 200) {
      const updated = await api('PATCH', `/repos/${repo}/releases/${encodeURIComponent(tag)}`, body)
      if (updated.status >= 400) throw describeAtomgitFailure('updating the release', updated)
    } else if (existing.status === 404) {
      const created = await api('POST', `/repos/${repo}/releases`, body)
      if (created.status >= 400) throw describeAtomgitFailure('creating the release', created)
    } else {
      throw describeAtomgitFailure('looking up the release', existing)
    }
  }

  // ---- asset -------------------------------------------------------------
  let uploaded = null
  let replacedAssetId = null
  if (wantAsset) {
    if (dryRun) {
      // Printed in execution order, not in the order the code happens to be laid out: a plan
      // that misrepresents the sequence is worse than no plan.
      would(`GET    /repos/${repo}/releases/tags/${encodeURIComponent(tag)}   (look for a same-name attachment)`)
      would(`DELETE /repos/${repo}/releases/${tag}/attach_files/<id>   (only if one exists)`)
      would(`GET    /repos/${repo}/releases/${tag}/upload_url?file_name=${facts.tarballName}`)
      would(`PUT    <signed object-storage url>  (${(tarball.length / 1024).toFixed(1)} kB, x-obs-* headers replayed)`)
    } else {
      const current = await client.request('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
      plan.push(`GET /repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
      if (current.status !== 200) throw describeAtomgitFailure('reading the release before uploading', current)
      const clash = findAssetByName(current.data, facts.tarballName)
      if (clash) {
        // Same-name overwrite is a no-op on this platform: the old object stays linked. The
        // only way to publish a corrected tarball under the same name is delete-then-upload.
        if (clash.id === undefined || clash.id === null) {
          throw new Error(
            `the release already carries ${facts.tarballName} but the asset has no id, so it cannot be ` +
              'replaced automatically. Delete it in the web UI and re-run.',
          )
        }
        const removed = await api('DELETE', `/repos/${repo}/releases/${encodeURIComponent(tag)}/attach_files/${clash.id}`)
        if (removed.status >= 400) throw describeAtomgitFailure('deleting the previous attachment', removed)
        replacedAssetId = clash.id
      }
      const result = await uploadReleaseAsset({
        client,
        fetchImpl: globalThis.fetch,
        repo,
        tag,
        fileName: facts.tarballName,
        bytes: tarball,
      })
      plan.push(`PUT <signed url for ${facts.tarballName}>`)
      if (!result.ok) {
        // Report the object store's own body (an OBS `<Code>SignatureDoesNotMatch</Code>` is the
        // only real diagnostic) AND the fact that the previous attachment was already deleted,
        // which leaves the release with no artifact at all until this is re-run.
        const detail = result.data === null ? '' : ` Response: ${JSON.stringify(result.data).slice(0, 400)}`
        const remediation =
          replacedAssetId === null
            ? ''
            : `\n  NOTE: attachment id ${replacedAssetId} had already been deleted from this release,\n` +
              '  so that release currently has no artifact under this file name. Re-run to upload again.'
        throw new Error(
          `uploading ${facts.tarballName} failed: HTTP ${result.status} on the signed object-storage ` +
            `URL (non-2xx). Check that every x-obs-* header returned by upload_url was sent back verbatim.${detail}${remediation}`,
        )
      }
      uploaded = { name: facts.tarballName, bytes: tarball.length, sha256: tarballSha, url: result.url }
      log(`       uploaded ${facts.tarballName} (${(tarball.length / 1024).toFixed(1)} kB)`)
    }
  }

  // ---- verification ------------------------------------------------------
  //
  // This is the LAST line of defence against the platform's silent failure mode: the object
  // store accepts a write whose callback never fires, so the upload "succeeds" and the
  // attachment never appears. A warning here would be worthless — the whole point is that a
  // release is not "published" until the artifact is demonstrably downloadable and identical.
  let verified = null
  let complete = true
  if (!dryRun) {
    plan.push(`GET /repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    const check = await client.request('GET', `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    if (check.status !== 200) throw describeAtomgitFailure('verifying the published release', check)
    const assets = normalizeAssets(check.data)
    verified = {
      tag,
      url: `${ATOMGIT_WEB}/${repo}/releases/tag/${tag}`,
      status: check.data.release_status ?? null,
      assets,
      ok: true,
      download: null,
    }
    log(`\nverified     ${verified.url}`)
    for (const asset of assets) log(`             ${asset.name}  id=${asset.id}`)

    const attached = assets.find((asset) => asset.name === facts.tarballName)
    if (wantAsset && attached === undefined) {
      complete = false
      verified.ok = false
      log(
        `ERROR        ${facts.tarballName} is NOT listed on the release, although the upload reported ` +
          'success. The object store almost certainly took the write without linking it.',
      )
    }

    // The API saying "one asset named X" is not the same as "the bytes a user would download
    // are the bytes we built". Download it back and hash it.
    if (wantAsset && attached !== undefined && wantDownloadCheck) {
      const downloadUrl = releaseDownloadUrl({ repo, tag, fileName: facts.tarballName })
      try {
        const response = await globalThis.fetch(downloadUrl, { redirect: 'follow' })
        if (response.status !== 200) {
          complete = false
          verified.ok = false
          log(
            `ERROR        the published artifact could not be downloaded back for verification — ` +
              `${downloadUrl} answered HTTP ${response.status}. Treat the release as unverified ` +
              '(pass --no-verify-download to accept that explicitly).',
          )
        } else {
          const bytes = Buffer.from(await response.arrayBuffer())
          const downloaded = sha256(bytes)
          const matches = downloaded === tarballSha
          log(
            `download     ${downloadUrl}\n` +
              `             ${bytes.length} bytes, sha256 ${downloaded.slice(0, 16)}… ` +
              `${matches ? 'MATCHES the built tarball' : 'DIFFERS from the built tarball'}`,
          )
          verified.download = { url: downloadUrl, bytes: bytes.length, sha256: downloaded, matches }
          if (!matches) {
            complete = false
            verified.ok = false
            log(`ERROR        the downloadable bytes differ from the built tarball (${tarballSha.slice(0, 16)}…).`)
          }
        }
      } catch (error) {
        complete = false
        verified.ok = false
        log(
          `ERROR        download check failed — ${error instanceof Error ? error.message : String(error)}. ` +
            'The attachment may be fine; this script cannot prove it, so it will not claim success.',
        )
      }
    }
  }

  const outcome = !willPublish ? 'plan' : complete ? 'published' : 'published_incomplete'
  const outcomeText =
    outcome === 'plan'
      ? 'PLAN OK (nothing written)'
      : outcome === 'published'
        ? 'PUBLISHED (artifact verified end-to-end)'
        : 'PUBLISHED INCOMPLETE — see the ERROR lines above'
  log(`\nRESULT: ${outcomeText}  [${plan.length} API steps]`)
  // The tarball is always left on disk (this project does not delete files); `*.tgz` is
  // gitignored, so saying "removed" here — as the first draft did — would have been a lie.
  log(
    `tarball: ${assetPath}` +
      (keep ? '  (kept)' : '  (plan-mode build, left on disk — *.tgz is gitignored)'),
  )
  if (repoCreated !== null) log(`repo created: ${repoCreated}`)
  if (replacedAssetId !== null) log(`replaced attachment id: ${replacedAssetId}`)

  if (json) {
    console.log(
      JSON.stringify(
        {
          result: outcome,
          platform: 'atomgit',
          repo,
          tag,
          version: facts.version,
          notesSource: notes.source,
          tarball: { name: facts.tarballName, bytes: tarball.length, entries: entries.length, sha256: tarballSha },
          repoCreated,
          uploaded,
          plan,
          verified,
        },
        null,
        2,
      ),
    )
  }
  // A release whose artifact could not be verified is a failure, not a success with a note.
  return outcome === 'published_incomplete' ? 1 : 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`\nerror: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })

/**
 * Reproducible end-to-end verification of `/gs` against an ISOLATED dsh web instance.
 *
 *   1. builds a throwaway DSH_HOME + web profile whose bundle stack includes this plugin
 *   2. boots `dsh --profile web --port <port> --no-open`
 *   3. authenticates with the printed launch token (mints the signed session cookie)
 *   4. creates a real session, lists commands (is /gs discoverable?), executes `/gs`
 *   5. tears the instance down — killing ONLY its own process tree
 *
 * It NEVER touches the user's own ~/.dsh instance, and never kills a node process it
 * did not spawn (a previous PowerShell version of this script did, and killed the
 * user's live web instance; do not regress that).
 *
 * Usage: node _evidence/verify-gs-e2e.mjs [--port 3081] [--keep] [--package <spec>]
 *                                          [--home <dir>] [--ws <dir>]
 *
 *   --package <spec>  what the isolated profile should depend on.
 *                     Default: `link:<repo root>` (source tree — the historical mode).
 *                     Pass a packaged artifact to verify the RELEASE artifact instead:
 *                       --package C:\path\dsh-history-fictionologists-0.2.0.tgz
 *                       --package github:Kaede0614/dsh-history-fictionologists
 *                     In this mode the script runs the real `dsh plugin add` first,
 *                     which is the step that catches a broken `files` whitelist or
 *                     `exports` map ("works from source, broken as a package").
 *   --home <dir>      isolated DSH_HOME to use (default: the long-standing test home).
 *                     Point a package-mode run at a FRESH dir so it cannot inherit a
 *                     stale junction, and so no existing test artifact is deleted.
 *   --ws <dir>        workspace the isolated instance runs in.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = join(import.meta.dirname, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', '3081'))
const KEEP = args.includes('--keep')
const PLUGIN_NAME = 'dsh-history-fictionologists'
// `--package` switches the isolated profile from the source tree to a packaged
// artifact. The default is byte-for-byte the old behaviour, so this script's own
// previous evidence stays comparable.
const PACKAGE_SPEC = argOf('--package', `link:${ROOT.replace(/\\/g, '/')}`)
const FROM_LINK = PACKAGE_SPEC.startsWith('link:')

const TEST_HOME = argOf('--home', 'C:\\Users\\masha\\hsr-fictionologists-testhome')
const TEST_WS = argOf('--ws', 'C:\\Users\\masha\\hsr-fictionologists-testws')
const PROFILE = join(TEST_HOME, 'profiles', 'web')
const DSH_CMD = join(process.env.APPDATA, 'npm', 'dsh.cmd')

const log = (...parts) => console.log(...parts)
let child = null

// --------------------------------------------------------------------------
// 1. isolated home + profile
// --------------------------------------------------------------------------
log('== 1. isolated home + web profile ==')
log(`   package under test: ${PACKAGE_SPEC}`)
mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
mkdirSync(TEST_WS, { recursive: true })
const credSource = join(homedir(), '.dsh', '.credentials.yaml')
const credTarget = join(TEST_HOME, '.credentials.yaml')
if (existsSync(credSource) && !existsSync(credTarget)) copyFileSync(credSource, credTarget)

// the junction is created by _evidence/setup-testhome.ps1; recreate it if missing
if (FROM_LINK) {
  const link = join(PROFILE, 'node_modules', PLUGIN_NAME)
  if (!existsSync(link)) {
    log('   (junction missing — run _evidence/setup-testhome.ps1 first, or `dsh plugin add link:...`)')
  }
} else {
  // Package mode: this is checklist item #1 ("does it install at all?"), driven through
  // the REAL CLI rather than a hand-made junction — it is the step that fails when the
  // `files` whitelist drops a module or `exports` points at a path that is not packed.
  log(`   installing with the real CLI: dsh plugin --profile web add ${PACKAGE_SPEC}`)
  const added = spawnSync(DSH_CMD, ['plugin', '--profile', 'web', 'add', PACKAGE_SPEC], {
    cwd: PROFILE,
    env: { ...process.env, DSH_HOME: TEST_HOME, NODE_NO_WARNINGS: '1' },
    encoding: 'utf8',
    windowsHide: true,
    shell: true,
  })
  const addLog = `${added.stdout ?? ''}\n${added.stderr ?? ''}`
  const addLogPath = join(TEST_HOME, 'plugin-add.log')
  writeFileSync(addLogPath, addLog, 'utf8')
  if (added.status !== 0) {
    throw new Error(`dsh plugin add ${PACKAGE_SPEC} failed (exit ${added.status}); log: ${addLogPath}\n${addLog.slice(-2000)}`)
  }
  log(`   installed (exit 0); raw log kept at ${addLogPath}`)

  // Item #3 ("does it actually load from the DEPLOYED location?"). The host importing it
  // during boot already covers this, but an explicit import from the installed path also
  // names the missing module if the pack was incomplete.
  const deployed = join(PROFILE, 'node_modules', PLUGIN_NAME)
  const deployedModules = [
    'lib/shell.js', 'lib/resolve.js', 'lib/paths.js', 'lib/missions.js',
    'lib/digest.js', 'lib/usercanon.mjs', 'lib/wiki/index.mjs', 'lib/wiki/cache.mjs',
    'lib/wiki/client.mjs', 'lib/wiki/datasets.mjs', 'lib/wiki/extract.mjs',
    'lib/wiki/html.mjs', 'lib/wiki/wikitext.mjs',
  ]
  // Guard against this hand-written list going stale: if `lib/` gains a module and the
  // list is not updated, the packed-artifact check would silently stop covering it.
  const sourceModuleCount = readdirSync(join(ROOT, 'lib'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|mjs)$/.test(entry.name)).length
  if (sourceModuleCount !== deployedModules.length) {
    throw new Error(`lib/ contains ${sourceModuleCount} modules but this check lists ${deployedModules.length} — update deployedModules`)
  }
  for (const relative of deployedModules) {
    const absolute = join(deployed, relative)
    if (!existsSync(absolute)) throw new Error(`packed artifact is missing ${relative} (deployed at ${deployed})`)
    await import(pathToFileURL(absolute).href)
  }
  log(`   all ${deployedModules.length} modules imported from the deployed path (${deployed})`)
}

const profilePackage = FROM_LINK
  ? {
      name: 'dsh-profile-web',
      private: true,
      dependencies: { [PLUGIN_NAME]: PACKAGE_SPEC },
    }
  : JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))

writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({
  ...profilePackage,
  private: true,
  dsh: {
    ...(profilePackage.dsh ?? {}),
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_NAME],
      patchReload: 'live',
    },
  },
}, null, 2)}\n`, 'utf8')

writeFileSync(join(PROFILE, 'cordis.patch.yml'), [
  '# Isolated verification instance: the plugin reads the test workspace.',
  '- id: dsh-history-fictionologists',
  '  config:',
  `    workspace: ${TEST_WS}`,
  '    requestIntervalMs: 2000',
  '',
].join('\n'), 'utf8')

// --------------------------------------------------------------------------
// 2. boot
// --------------------------------------------------------------------------
log(`== 2. boot isolated web instance on port ${PORT} ==`)
const dshRoot = join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh')
// A .cmd shim cannot be spawned directly on Windows without a shell (EINVAL), so
// run the shim through a shell. Arguments here are all locally controlled constants
// (no user input), and Node 24's DEP0190 warning about unescaped args is accepted.
child = spawn(DSH_CMD, ['--profile', 'web', '--port', String(PORT), '--no-open'], {
  cwd: TEST_WS,
  env: {
    ...process.env,
    DSH_HOME: TEST_HOME,
    NODE_PATH: [join(process.env.APPDATA, 'npm', 'node_modules'), join(dshRoot, 'node_modules')].join(';'),
    // silence Node 24's DEP0190 notice for `shell: true` (see below); the instance
    // output is what this script parses.
    NODE_NO_WARNINGS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  shell: true,
})

let output = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => { output += chunk })
child.stderr.on('data', (chunk) => { output += chunk })

async function waitForToken(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = /token=([A-Za-z0-9_\-]+)/.exec(output)
    if (match) return match[1]
    if (child.exitCode !== null) break
    await sleep(500)
  }
  return null
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function teardown() {
  if (child === null || child.pid === undefined) return
  log('== teardown ==')
  // Kill by PID and by "who owns the TEST port". `taskkill /T` alone proved
  // insufficient: with `shell: true` the direct child is cmd.exe, and it is not
  // guaranteed to have the node grandchild in its live tree by the time teardown
  // runs — an orphaned instance then holds the port and breaks the next run.
  // Both steps are scoped to this instance; never sweep `node.exe` wholesale,
  // which would kill the user's own dsh instance.
  try {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch { /* already gone */ }
  child = null
  const owner = portOwner(PORT)
  if (owner !== null) {
    log(`   killing test-port owner pid ${owner}`)
    try {
      spawn('taskkill', ['/PID', String(owner), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch { /* already gone */ }
  }
}

/** PID listening on `port`, or null. Windows-only, and never touches other ports. */
function portOwner(port) {
  const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || typeof result.stdout !== 'string') return null
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
    if (match !== null && Number(match[1]) === port) return Number(match[2])
  }
  return null
}

try {
  const token = await waitForToken()
  if (token === null) throw new Error(`the instance never printed a token. output: ${output.slice(-600)}`)
  log('   token acquired')

  // ------------------------------------------------------------------------
  // 3. authenticate: token -> signed cookie
  // ------------------------------------------------------------------------
  log('== 3. authenticate (token -> signed cookie) ==')
  const base = `http://127.0.0.1:${PORT}`
  const authResponse = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const setCookie = authResponse.headers.getSetCookie?.() ?? []
  const rawCookie = setCookie.find((c) => c.toLowerCase().startsWith('dsh-auth-'))
  if (rawCookie === undefined) throw new Error(`no auth cookie in response (status ${authResponse.status})`)
  const cookie = rawCookie.split(';')[0]
  log('   cookie acquired')

  let rpcSeq = 0
  async function rpc(method, payload) {
    rpcSeq += 1
    const body = { type: 'client-request', rpcId: `verify-${rpcSeq}`, method, payload }
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new Error(`${method}: non-JSON response (status ${response.status}): ${text.slice(0, 300)}`)
    }
    return json
  }

  // ------------------------------------------------------------------------
  // 4. create a session, then ask the registry for this agent's commands
  // ------------------------------------------------------------------------
  log('== 4. commands/list — is /gs registered and discoverable? ==')
  const created = await rpc('session/create', { args: { request: { cwd: TEST_WS } } })
  const sessionId = created?.result?.value?.sessionId
  if (!sessionId) throw new Error(`session/create failed: ${JSON.stringify(created)}`)
  log(`   session: ${sessionId}`)

  const listed = await rpc('commands/list', { args: { agentId: sessionId } })
  const names = (listed?.result?.value ?? []).map((c) => c.name)
  log(`   commands: ${names.join(', ')}`)
  if (!names.includes('gs')) throw new Error(`/gs is NOT exposed by commands/list: ${JSON.stringify(listed)}`)
  const gs = listed.result.value.find((c) => c.name === 'gs')
  log(`   /gs definition: ${JSON.stringify(gs)}`)

  // ------------------------------------------------------------------------
  // 5. execute /gs
  // ------------------------------------------------------------------------
  log("== 5. commands/execute '/gs' ==")
  const executed = await rpc('commands/execute', {
    args: { agentId: sessionId, line: '/gs', submittedAttachments: [] },
  })
  const result = executed?.result?.value?.result
  log(`   result: ${JSON.stringify(result)}`)
  if (result?.kind !== 'success') throw new Error(`/gs did not return a success result: ${JSON.stringify(executed)}`)
  if (typeof result.text !== 'string' || result.text.length === 0) throw new Error('/gs returned no text')

  // ------------------------------------------------------------------------
  // 6. optional model-in-the-loop: make the real host actually CALL a gs_* tool.
  //
  // Opt-in (`--model`) and expected to FAIL inside an isolated DSH_HOME: the launch
  // token and the model route belong to the user's own instance, and an isolated
  // home has neither, so the prompt is accepted and then never reaches a model (the
  // session log stays empty for the whole timeout — observed, not assumed).
  //
  // The contract it targets is already covered two other ways:
  //   - offline but using the HOST's own validator: test/host-validator.test.mjs
  //   - live, in the instance the user actually runs: the model called `gs_setup`
  //     there and the host accepted the result (that call is what first exposed the
  //     `lastUpdated: null` schema bug this plugin now guards against).
  // ------------------------------------------------------------------------
  if (args.includes('--model')) {
    log('== 6. model-in-the-loop: ask the model to call gs_setup ==')
    const marker = '接线自检'
    const submitted = await rpc('session/prompt', {
      args: {
        request: {
          requestId: `verify-prompt-${Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{
            type: 'text',
            text: `只做一件事：调用 gs_setup，然后在回复里原样写出它返回的 cacheDir 字段值，并在开头写上「${marker}」。不要调用其他工具，不要解释。`,
          }],
          clientTimeZone: 'Asia/Shanghai',
        },
      },
    })
    const accepted = submitted?.result?.ok === true
    log(`   prompt accepted: ${accepted}${accepted ? '' : ` (${JSON.stringify(submitted).slice(0, 240)})`}`)
    if (!accepted) throw new Error(`session/prompt was not accepted: ${JSON.stringify(submitted)}`)

    const found = await waitForSessionRecord(marker, 180_000)
    log(`   session log: gs_setup tool activity found = ${found.gsSetup}`)
    log(`   session log: marker text present        = ${found.marker}`)
    log(`   session log: cache directory echoed     = ${found.cacheDir}`)
    log(`   session log: invalid-output error       = ${found.invalidOutput}`)
    if (found.invalidOutput) throw new Error('the host rejected a gs_* tool result (see the session log above)')
    if (!found.gsSetup) throw new Error('the model never called gs_setup (see the session log excerpt above)')
  } else {
    log('== 6. model-in-the-loop skipped (pass --model to enable; needs a usable model route) ==')
  }

  log('\nRESULT: PASS — /gs is registered, discoverable by the Web client, and executes in the real host.')
} finally {
  if (!KEEP) teardown()
  else log('(--keep: leaving the instance running)')
}

/**
 * Poll the instance's session logs for evidence that the model called `gs_setup`
 * and that the host accepted the result.
 */
async function waitForSessionRecord(marker, timeoutMs) {
  const sessionsDir = join(TEST_HOME, 'sessions')
  const deadline = Date.now() + timeoutMs
  let excerpt = ''
  while (Date.now() < deadline) {
    excerpt = readSessionText(sessionsDir)
    const state = {
      gsSetup: /gs_setup/.test(excerpt),
      marker: excerpt.includes(marker),
      cacheDir: /hsr-worldview-cache/.test(excerpt),
      invalidOutput: /invalid output|INVALID_TOOL_OUTPUT|ToolOutputError/i.test(excerpt),
    }
    if (state.invalidOutput || (state.gsSetup && state.marker && state.cacheDir)) return state
    await sleep(2000)
  }
  log(`   (timed out after ${timeoutMs} ms; last log chars: ${excerpt.length})`)
  return {
    gsSetup: /gs_setup/.test(excerpt),
    marker: excerpt.includes(marker),
    cacheDir: /hsr-worldview-cache/.test(excerpt),
    invalidOutput: /invalid output|INVALID_TOOL_OUTPUT|ToolOutputError/i.test(excerpt),
  }
}

/** Concatenate every session log this isolated instance wrote (multi-frame zstd). */
function readSessionText(dir) {
  let text = ''
  const walk = (current, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else {
        try {
          text += decodeSessionFile(readFileSync(full))
        } catch { /* unreadable file: skip */ }
      }
    }
  }
  walk(dir, 0)
  return text
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decode a session log: the format is multi-frame zstd, and a single
 * `zstdDecompressSync` call only returns the FIRST frame (199 chars of header in
 * practice). Split on the zstd magic and decode frame by frame.
 */
function decodeSessionFile(buffer) {
  if (!buffer.subarray(0, 4).equals(ZSTD_MAGIC)) return buffer.toString('utf8')
  const starts = []
  let idx = buffer.indexOf(ZSTD_MAGIC)
  while (idx >= 0) {
    starts.push(idx)
    idx = buffer.indexOf(ZSTD_MAGIC, idx + 4)
  }
  let text = ''
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(starts[i], end)).toString('utf8')
    } catch { /* a truncated trailing frame is expected on a live session */ }
  }
  return text
}

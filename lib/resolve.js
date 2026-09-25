/**
 * Optional-dependency resolution for dsh-history-fictionologists.
 *
 * DSH ships `@deepseek-ai/*` packages inside its own dependency tree, and this
 * plugin is linked into a profile (junction / pnpm link) rather than vendored
 * under the profile's `node_modules`. A bare `import('@deepseek-ai/x')` from the
 * plugin file therefore fails, and a silent try/catch downgrade looks exactly
 * like "the tool was never registered". So every optional import goes through
 * this multi-base chain.
 *
 * Design rules (from the dsh plugin contract):
 *   - `@deepseek-ai/*` is ALWAYS optional: never a hard import.
 *   - A failed resolution returns `null`; callers must degrade loudly (log +
 *     degraded behaviour), never crash the whole plugin tree.
 *   - `Config` must be `undefined` when Schemastery cannot be resolved. A plain
 *     object there makes the host call `undefined['~standard'].validate` and
 *     take down the entire plugin tree.
 *
 * @module dsh-history-fictionologists/lib/resolve
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const cache = new Map()
const missing = new Set()

/** `C:\Users\x` → `C:/Users/x` so pathToFileURL produces a usable file URL. */
function toPosix(p) {
  return p.replace(/\\/g, '/')
}

/** Build `file:///C:/a/b/_` style base URLs that `createRequire` accepts. */
function requireBases() {
  const bases = [import.meta.url]
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = extractProfileName(process.argv)
  const push = (dir) => {
    if (typeof dir === 'string' && dir.length > 0) bases.push(pathToFileURL(join(toPosix(dir), '_')).href)
  }
  push(process.cwd())
  push(home)
  if (profile !== null) push(join(home, 'profiles', profile))
  push(join(home, 'profiles', 'node_modules'))
  // Global npm install: <npm-root>/node_modules/@deepseek-ai/dsh/node_modules
  const guessedRoot = guessGlobalDshRoot()
  if (guessedRoot !== null) {
    push(guessedRoot)
    push(join(guessedRoot, 'node_modules'))
  }
  return bases
}

/** Resolve `--profile <name>` / `--profile=<name>` from argv, else the only profile dir. */
function extractProfileName(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile' && typeof argv[i + 1] === 'string') return argv[i + 1]
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length)
  }
  // dsh is spawned as `<dsh>/lib/bin.js <command> ...`; env carries the profile sometimes.
  return process.env.DSH_PROFILE && process.env.DSH_PROFILE.length > 0 ? process.env.DSH_PROFILE : null
}

/**
 * Best-effort location of the `@deepseek-ai/dsh` package's own `node_modules`,
 * derived from `process.argv[1]` (`.../node_modules/@deepseek-ai/dsh/lib/bin.js`).
 */
function guessGlobalDshRoot() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return null
  const marker = `${join('node_modules', '@deepseek-ai', 'dsh')}`
  const posix = toPosix(entry)
  const idx = posix.toLowerCase().indexOf(toPosix(marker).toLowerCase())
  if (idx < 0) return null
  return posix.slice(0, idx) + toPosix(marker) + '/node_modules'
}

/**
 * Import one optional ESM/CJS specifier, trying every base in the chain.
 *
 * @param {string} specifier - package specifier, e.g. `@deepseek-ai/dsh-tools`.
 * @returns {Promise<any|null>} the module namespace, or null when unresolvable.
 */
export async function optionalImport(specifier) {
  if (cache.has(specifier)) return cache.get(specifier)
  if (missing.has(specifier)) return null
  for (const base of requireBases()) {
    try {
      const resolved = createRequire(base).resolve(specifier)
      const mod = await import(pathToFileURL(toPosix(resolved)).href)
      cache.set(specifier, mod)
      return mod
    } catch {
      // try the next base
    }
  }
  missing.add(specifier)
  return null
}

/**
 * Import one optional specifier and return its `default` export.
 * Handles the Schemastery shape (`lib/index.mjs` re-exports a CJS default).
 *
 * @param {string} specifier
 * @returns {Promise<any|null>}
 */
export async function optionalDefault(specifier) {
  const mod = await optionalImport(specifier)
  if (mod === null) return null
  return mod.default ?? mod
}

/** Resolve a subpath export of an optional package (e.g. dsh-commands/brand). */
export async function optionalSubpath(pkg, subpath) {
  const mod = await optionalImport(`${pkg}/${subpath}`)
  return mod ?? null
}

/** True when the specifier can be resolved right now (useful for diagnostics). */
export function canResolve(specifier) {
  for (const base of requireBases()) {
    try {
      createRequire(base).resolve(specifier)
      return true
    } catch {
      // next
    }
  }
  return false
}

/** Diagnostics for `--dump-config`-adjacent troubleshooting and the test suite. */
export function resolutionReport() {
  return {
    bases: requireBases(),
    dshRoot: guessGlobalDshRoot(),
    profile: extractProfileName(process.argv),
    checked: ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-commands'],
    resolvable: Object.fromEntries(
      ['@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-commands'].map((s) => [
        s,
        canResolve(s),
      ]),
    ),
  }
}

/** Test seam: forget memoized results so a test can re-resolve. */
export function resetResolveCache() {
  cache.clear()
  missing.clear()
}

export { dirname }

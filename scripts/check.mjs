/**
 * Portable project check: syntax-check every module, then run the offline suite.
 *
 * Exists as a plain Node script rather than an npm-script chain because `npm` is not
 * always runnable on this machine (only `npm.ps1` is on PATH, and the PowerShell
 * execution policy blocks it), while `node` always is. `npm test` previously pointed
 * at a glob (`node --test test/*.test.mjs`) that Node does NOT expand when it arrives
 * as an argument — it failed with `Cannot find module ...\test`. Bare `node --test`
 * auto-discovers `test/**` and works on Node 22 and 24.
 *
 * Usage: node scripts/check.mjs
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** Every module the plugin loads at runtime, in dependency order. */
function collectModules() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      // Recurse into EVERY subdirectory, not just `./wiki`: a future lib/<other>/
      // module must not be silently skipped (review R3-3).
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (/\.(js|mjs)$/.test(entry.name)) files.push(full)
    }
  }
  walk(join(ROOT, 'lib'))
  return files.sort()
}

const modules = collectModules()
console.log(`-- syntax check (${modules.length} modules) --`)
let syntaxFailures = 0
for (const file of modules) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true })
  const rel = file.slice(ROOT.length + 1)
  if (result.status === 0) {
    console.log(`  OK    ${rel}  (${statSync(file).size} bytes)`)
  } else {
    syntaxFailures += 1
    console.log(`  FAIL  ${rel}`)
    console.log(String(result.stderr).split('\n').slice(0, 6).join('\n'))
  }
}

console.log('\n-- offline test suite (node --test, auto-discovery) --')
const tests = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
const summary = String(tests.stdout)
  .split('\n')
  .filter((line) => /^ℹ (tests|pass|fail|skipped|duration_ms)/.test(line))
  .join('\n')
console.log(summary.length > 0 ? summary : '(no summary line parsed)')
if (tests.status !== 0) {
  console.log('\n-- failing test detail --')
  console.log(String(tests.stdout).split('\n').filter((l) => /^✖/.test(l)).slice(0, 20).join('\n'))
}

const failed = syntaxFailures > 0 || tests.status !== 0
console.log(`\nRESULT: ${failed ? 'FAIL' : 'PASS'} (syntax failures: ${syntaxFailures}, test exit: ${tests.status})`)
process.exit(failed ? 1 : 0)

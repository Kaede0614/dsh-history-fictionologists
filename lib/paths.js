/**
 * Workspace/path resolution for dsh-history-fictionologists.
 *
 * The plugin must work in three setups without configuration:
 *   1. the DSH session working directory IS the data workspace;
 *   2. the workspace is passed explicitly through plugin config;
 *   3. neither — then fall back to walking up from this file.
 *
 * Never throw from these helpers: a missing directory is reported, not raised.
 *
 * @module dsh-history-fictionologists/lib/paths
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // <root>/lib

/** Markers that identify a directory as "the HSR data workspace". */
const WORKSPACE_MARKERS = ['hsr-missions', 'hsr-worldview-cache']

function looksLikeWorkspace(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false
  try {
    return WORKSPACE_MARKERS.some((marker) => existsSync(join(dir, marker)))
  } catch {
    return false
  }
}

/** Walk up from this file looking for the package root (dir containing package.json). */
function packageRoot() {
  let dir = HERE
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return resolve(HERE, '..')
}

/**
 * Resolve the workspace directory.
 *
 * Priority: explicit config → env overrides → cwd (when it looks right) → walk
 * up from the package → cwd as the last resort.
 *
 * @param {{workspace?: string}} [config]
 * @returns {string} absolute path (always non-empty, may not exist)
 */
export function resolveWorkspace(config = {}) {
  const explicit = typeof config.workspace === 'string' ? config.workspace.trim() : ''
  if (explicit.length > 0) return isAbsolute(explicit) ? resolve(explicit) : resolve(process.cwd(), explicit)

  for (const envName of ['DSH_HISTORY_FICTIONOLOGISTS_WORKSPACE', 'DSH_WORKSPACE']) {
    const value = process.env[envName]
    if (typeof value === 'string' && value.trim().length > 0) return resolve(value.trim())
  }

  const cwd = process.cwd()
  if (looksLikeWorkspace(cwd)) return cwd

  // Walk up from cwd as well: a session may be opened in a subdirectory.
  let dir = cwd
  for (let i = 0; i < 5; i += 1) {
    if (looksLikeWorkspace(dir)) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }

  const pkg = packageRoot()
  if (looksLikeWorkspace(pkg)) return pkg

  return cwd
}

/** `<ws>/hsr-missions` */
export function missionsDir(ws) {
  return join(ws, 'hsr-missions')
}

/** `<ws>/hsr-worldview-cache` */
export function cacheDir(ws) {
  return join(ws, 'hsr-worldview-cache')
}

/** `<ws>/hsr-stories` */
export function storiesDir(ws) {
  return join(ws, 'hsr-stories')
}

/** `<ws>/hsr-broadcasts` */
export function broadcastsDir(ws) {
  return join(ws, 'hsr-broadcasts')
}

/** `<ws>/hsr-stories/inspirations` */
export function inspirationsDir(ws) {
  return join(storiesDir(ws), 'inspirations')
}

/**
 * Create every directory this plugin writes to.
 * @param {string} ws
 * @returns {{created: string[], failed: {path: string, error: string}[]}}
 */
export function ensureOutputDirs(ws) {
  const created = []
  const failed = []
  for (const dir of [cacheDir(ws), storiesDir(ws), broadcastsDir(ws), inspirationsDir(ws)]) {
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
        created.push(dir)
      }
    } catch (error) {
      failed.push({ path: dir, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { created, failed }
}

/** Path facts for diagnostics (never throws). */
export function describePaths(config = {}) {
  const ws = resolveWorkspace(config)
  const dirs = {
    workspace: ws,
    missions: missionsDir(ws),
    cache: cacheDir(ws),
    stories: storiesDir(ws),
    broadcasts: broadcastsDir(ws),
  }
  return {
    ...dirs,
    exists: Object.fromEntries(Object.entries(dirs).map(([key, value]) => [key, existsSync(value)])),
  }
}

export { existsSync, mkdirSync }

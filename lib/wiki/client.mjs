/**
 * HTTP client for wiki.biligame.com (BRIEF §3.1).
 *
 * Measured facts this module encodes:
 *   - the endpoint is MediaWiki 1.37 + SMW at `/sr/api.php`;
 *   - the WAF blocks bursts: 12 back-to-back requests → the last 6 answered
 *     `status 567` with an inline-CSS HTML error page (**not** JSON);
 *   - therefore: >= `requestIntervalMs` between adjacent requests, exponential
 *     backoff retry (4s/8s/16s, 3 retries), then a `null`-ish failure result that
 *     the caller can fall back to cache for — never a thrown error;
 *   - headers are exactly `user-agent` + `referer` + `accept` + `accept-language`
 *     (no `x-requested-with`: it was observed on both successes and failures, so
 *     it only adds variance);
 *   - one request times out after 30s via `AbortSignal.timeout`.
 *
 * @module dsh-history-fictionologists/lib/wiki/client
 */
import { setTimeout as sleepDefault } from 'node:timers/promises'

/** Browser UA (BRIEF 附录 A) — required, the WAF rejects non-browser agents. */
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** MediaWiki API endpoint (BRIEF 附录 A). */
export const API = 'https://wiki.biligame.com/sr/api.php'

/** Human-readable page base (BRIEF 附录 A). */
export const PAGE_BASE = 'https://wiki.biligame.com/sr/'

/** MediaWiki hard limit for `titles=` on a normal account. */
export const MAX_TITLES_PER_QUERY = 50

/** Defaults; every one of them is overridable through plugin Config (BRIEF §7.2). */
export const CLIENT_DEFAULTS = Object.freeze({
  intervalMs: 2000,
  timeoutMs: 30000,
  maxRetries: 3,
  backoffMs: 4000,
  userAgent: UA,
  referer: PAGE_BASE,
})

const NON_JSON_SNIPPET = 120

/** `['a', undefined, '  b ']` → `['a', 'b']` */
function normalizeTitles(titles) {
  const list = Array.isArray(titles) ? titles : [titles]
  return list
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function toErrorText(error, timeoutMs) {
  if (error && typeof error === 'object') {
    if (error.name === 'TimeoutError') return `timeout after ${timeoutMs}ms`
    if (error.name === 'AbortError') return `aborted after ${timeoutMs}ms`
    if (typeof error.message === 'string' && error.message.length > 0) return error.message
  }
  return String(error)
}

function looksLikeWafPage(body) {
  if (typeof body !== 'string') return false
  return /<style[\s\S]*?<\/style>/i.test(body) && !/^\s*[[{]/.test(body)
}

/**
 * A throttled, retrying, never-throwing MediaWiki client.
 *
 * Every method resolves to `{ ok: true, ... }` or `{ ok: false, error, ... }`.
 * Callers (extractors / cache updater) decide whether a failure means "keep the
 * old cache" — the client itself never throws and never retries forever.
 */
export class WikiClient {
  #lastRequestAt = 0
  #chain = Promise.resolve()
  #requests = 0
  #retries = 0
  #failures = 0
  /** Injected clock seam, or null to use the real clock. Guarded per call by `#now()`. */
  #nowImpl = null

  /**
   * @param {object} [options]
   * @param {number} [options.intervalMs] minimum gap between adjacent requests
   * @param {number} [options.timeoutMs] per-request timeout
   * @param {number} [options.maxRetries] retries after the first attempt
   * @param {number} [options.backoffMs] first backoff step (doubles each retry)
   * @param {string} [options.userAgent]
   * @param {string} [options.referer]
   * @param {Function} [options.fetchImpl] test seam
   * @param {Function} [options.sleepImpl] test seam
   * @param {Function} [options.nowImpl] test seam for the clock
   * @param {Function} [options.onRequest] progress hook `({url, attempt, status, ms, ok})`
   */
  constructor(options = {}) {
    const merged = { ...CLIENT_DEFAULTS }
    for (const [key, value] of Object.entries(options ?? {})) {
      if (value !== undefined && value !== null) merged[key] = value
    }
    // BRIEF §3.1 demands >= 1500ms; the configured value wins above that floor.
    merged.intervalMs = Math.max(1500, toNumber(merged.intervalMs, CLIENT_DEFAULTS.intervalMs))
    merged.timeoutMs = Math.max(1000, toNumber(merged.timeoutMs, CLIENT_DEFAULTS.timeoutMs))
    merged.maxRetries = Math.max(0, Math.trunc(toNumber(merged.maxRetries, CLIENT_DEFAULTS.maxRetries)))
    merged.backoffMs = Math.max(0, toNumber(merged.backoffMs, CLIENT_DEFAULTS.backoffMs))
    merged.fetchImpl = merged.fetchImpl ?? globalThis.fetch
    merged.sleepImpl = merged.sleepImpl ?? ((ms) => sleepDefault(ms))
    this.options = merged
    // Clock seam. Without it the throttle decision depends on how long the previous
    // fetch happened to take, which makes any timing assertion flaky under load.
    //
    // Guarded per call rather than probed once: a seam returning a non-finite value
    // makes `gap` NaN, `gap > 0` false, and silently disables the >=1500ms floor that
    // exists to avoid WAF blocking (review R2-5). Production never passes `nowImpl`,
    // but the fallback belongs here for symmetry with `toNumber` on the other tunables.
    this.#nowImpl = typeof merged.nowImpl === 'function' ? merged.nowImpl : null
  }

  /** Current time from the injected seam, falling back to the real clock when unusable. */
  #now() {
    if (this.#nowImpl === null) return Date.now()
    const value = Number(this.#nowImpl())
    return Number.isFinite(value) ? value : Date.now()
  }

  /** Clock accessor (kept public for diagnostics; always finite). */
  now() {
    return this.#now()
  }

  /** Request/retry/failure counters for diagnostics. */
  get stats() {
    return { requests: this.#requests, retries: this.#retries, failures: this.#failures }
  }

  /** Wait until at least `intervalMs` has passed since the previous request start. */
  async #waitTurn() {
    const gap = this.options.intervalMs - (this.now() - this.#lastRequestAt)
    if (this.#lastRequestAt > 0 && gap > 0) await this.options.sleepImpl(gap)
    this.#lastRequestAt = this.now()
  }

  /** One network round trip. Never throws. */
  async #once(url) {
    const { timeoutMs, userAgent, referer } = this.options
    const started = this.now()
    try {
      const response = await this.options.fetchImpl(url, {
        headers: {
          'user-agent': userAgent,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          referer,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const status = response.status
      const contentType = response.headers?.get?.('content-type') ?? ''
      const body = await response.text()
      return { status, contentType, body, ms: this.now() - started }
    } catch (error) {
      return { status: 0, contentType: '', body: '', ms: this.now() - started, error: toErrorText(error, timeoutMs) }
    }
  }

  /**
   * Throttled GET returning parsed JSON.
   *
   * @param {string} url
   * @returns {Promise<{ok: boolean, status?: number, json?: any, error?: string, waf?: boolean, attempts?: number, ms?: number, apiError?: any}>}
   */
  async requestJson(url) {
    const run = this.#chain.then(
      () => this.#attempt(url, true),
      () => this.#attempt(url, true),
    )
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #attempt(url, wantJson) {
    const { maxRetries, backoffMs, onRequest } = this.options
    let last = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        this.#retries += 1
        await this.options.sleepImpl(backoffMs * 2 ** (attempt - 1))
      }
      await this.#waitTurn()
      this.#requests += 1
      const raw = await this.#once(url)
      const report = (ok, error) => {
        if (typeof onRequest === 'function') {
          try {
            onRequest({ url, attempt: attempt + 1, status: raw.status, ms: raw.ms, ok, error })
          } catch {
            /* a progress hook must never break the fetch */
          }
        }
      }

      if (raw.error) {
        last = { status: 0, error: raw.error }
        report(false, raw.error)
        continue
      }
      if (raw.status === 567 || raw.status === 429) {
        last = { status: raw.status, waf: true, error: `WAF blocked (status ${raw.status})` }
        report(false, last.error)
        continue
      }
      if (raw.status >= 500) {
        last = { status: raw.status, error: `server error (status ${raw.status})` }
        report(false, last.error)
        continue
      }

      let parsed = null
      let parseError = null
      try {
        parsed = JSON.parse(raw.body)
      } catch (error) {
        parseError = error
      }
      if (parseError !== null) {
        const waf = raw.status === 567 || looksLikeWafPage(raw.body)
        const snippet = raw.body.replace(/\s+/g, ' ').slice(0, NON_JSON_SNIPPET)
        last = {
          status: raw.status,
          waf,
          error: `non-JSON response (status ${raw.status}, ${raw.contentType || 'no content-type'}, ${raw.body.length} bytes): ${snippet}`,
        }
        report(false, last.error)
        continue
      }
      if (parsed && parsed.error) {
        // A well-formed API error is deterministic: retrying only wastes WAF budget.
        const code = parsed.error.code ?? 'unknown'
        const info = parsed.error.info ?? ''
        const result = { ok: false, status: raw.status, ms: raw.ms, attempts: attempt + 1, apiError: parsed.error, error: `api error ${code}: ${info}` }
        report(false, result.error)
        return result
      }
      // `wantJson` is always true today; the flag keeps the method reusable.
      const result = { ok: true, status: raw.status, ms: raw.ms, attempts: attempt + 1, bytes: raw.body.length, json: wantJson ? parsed : null }
      report(true, null)
      return result
    }
    this.#failures += 1
    return { ok: false, attempts: maxRetries + 1, ...(last ?? { status: 0, error: 'request failed' }) }
  }

  /**
   * `action=parse&prop=text` — rendered HTML for a list page.
   * @param {string} title
   */
  async parsePage(title) {
    const clean = normalizeTitles([title])[0]
    if (clean === undefined) return { ok: false, title: '', error: 'empty page title' }
    const url =
      `${API}?action=parse&page=${encodeURIComponent(clean)}&prop=text` +
      '&format=json&formatversion=2&disablelimitreport=1&disableeditsection=1'
    const res = await this.requestJson(url)
    if (!res.ok) {
      return { ok: false, title: clean, url, status: res.status, waf: res.waf === true, error: res.error }
    }
    const html = res.json?.parse?.text
    if (typeof html !== 'string' || html.length === 0) {
      return {
        ok: false,
        title: clean,
        url,
        status: res.status,
        error: `parse.text missing (keys: ${Object.keys(res.json?.parse ?? {}).join(',') || 'none'})`,
      }
    }
    return { ok: true, title: clean, url, html, bytes: Buffer.byteLength(html, 'utf8'), ms: res.ms, attempts: res.attempts }
  }

  /**
   * `action=query&rvprop=ids|timestamp` — cheap revision ids for the cache
   * short-circuit (BRIEF §4).
   *
   * @param {string|string[]} titles
   */
  async revisionIds(titles) {
    const list = normalizeTitles(titles)
    if (list.length === 0) return { ok: false, titles: [], pages: [], error: 'no titles' }
    const url =
      `${API}?action=query&prop=revisions&rvprop=ids%7Ctimestamp&format=json&formatversion=2&titles=` +
      encodeURIComponent(list.join('|'))
    const res = await this.requestJson(url)
    if (!res.ok) {
      return { ok: false, titles: list, url, status: res.status, waf: res.waf === true, error: res.error, pages: [] }
    }
    const rawPages = Array.isArray(res.json?.query?.pages) ? res.json.query.pages : []
    const pages = rawPages.map((page) => ({
      title: page.title,
      pageid: page.pageid ?? null,
      missing: page.missing === true,
      revid: page.revisions?.[0]?.revid ?? null,
      timestamp: page.revisions?.[0]?.timestamp ?? null,
    }))
    return { ok: true, titles: list, url, pages, ms: res.ms, attempts: res.attempts }
  }

  /**
   * `action=query&prop=revisions&rvprop=content` — raw wikitext for detail pages.
   * Callers must batch at `MAX_TITLES_PER_QUERY`; this method slices defensively
   * and reports the discarded titles instead of silently dropping them.
   *
   * @param {string|string[]} titles
   */
  async revisions(titles) {
    const all = normalizeTitles(titles)
    if (all.length === 0) return { ok: false, titles: [], pages: [], error: 'no titles' }
    const list = all.slice(0, MAX_TITLES_PER_QUERY)
    const truncated = all.slice(MAX_TITLES_PER_QUERY)
    const params = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      format: 'json',
      formatversion: '2',
      titles: list.join('|'),
    })
    const url = `${API}?${params}`
    const res = await this.requestJson(url)
    if (!res.ok) {
      return { ok: false, titles: list, url, status: res.status, waf: res.waf === true, error: res.error, pages: [], truncated }
    }
    const rawPages = Array.isArray(res.json?.query?.pages) ? res.json.query.pages : []
    const pages = rawPages.map((page) => ({
      title: page.title,
      pageid: page.pageid ?? null,
      missing: page.missing === true,
      revid: page.revisions?.[0]?.revid ?? null,
      timestamp: page.revisions?.[0]?.timestamp ?? null,
      content: page.revisions?.[0]?.slots?.main?.content ?? '',
    }))
    return {
      ok: true,
      titles: list,
      url,
      pages,
      truncated,
      normalized: res.json?.query?.normalized ?? [],
      redirects: res.json?.query?.redirects ?? [],
      ms: res.ms,
      attempts: res.attempts,
    }
  }
}

/** Guard against `NaN` sneaking in from hand-edited Config. */
function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Build a client from plugin Config field names (BRIEF §7.2).
 *
 * @param {object} [cfg]
 * @returns {WikiClient}
 */
export function createWikiClient(cfg = {}) {
  if (cfg && cfg.client instanceof WikiClient) return cfg.client
  return new WikiClient({
    intervalMs: cfg.requestIntervalMs,
    timeoutMs: cfg.requestTimeoutMs,
    maxRetries: cfg.maxRetries,
    userAgent: typeof cfg.userAgent === 'string' && cfg.userAgent.trim().length > 0 ? cfg.userAgent : undefined,
    log: cfg.log,
  })
}

/**
 * Generic HTML helpers (BRIEF §3.2) — zero dependencies, regex + balanced scans.
 *
 * Everything here is deliberately string-based: the wiki emits hand-written
 * MediaWiki/HTML (unclosed `<p>`, tooltip spans outside hidden divs, duplicated
 * `data-param` rows) that a strict parser would reject, and the plugin must not
 * pull in a third-party DOM library (§0).
 *
 * @module dsh-history-fictionologists/lib/wiki/html
 */

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'param', 'track'])

/** Named entities seen on this wiki plus the handful worth decoding. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  times: '×',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}

/** `&amp;` / `&#160;` / `&#x27;` → decoded text (NBSP is normalized to a space). */
export function decodeEntities(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      if (code === 0xa0) return ' '
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()]
    return named === undefined ? match : named
  })
}

/** Remove `<!-- … -->` (used by both HTML and wikitext paths). */
export function stripComments(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * Index just past the `</tag>` that closes the element whose content starts at
 * `from`. Nested same-name tags are counted. Returns -1 when unbalanced.
 *
 * @param {string} html
 * @param {number} from index right after the opening tag
 * @param {string} tag lowercase tag name
 */
export function matchClose(html, from, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi')
  re.lastIndex = Math.max(0, from)
  let depth = 1
  let m
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith('</')) {
      depth -= 1
      if (depth === 0) return m.index + m[0].length
    } else if (!VOID_TAGS.has(tag)) {
      depth += 1
    }
  }
  return -1
}

/**
 * Remove every element of `tag` whose opening tag matches `test`.
 * Hidden SMW tooltips and `<style>` blocks are stripped this way.
 *
 * @param {string} html
 * @param {string} tag
 * @param {(openTag: string, innerHtml: string) => boolean} test
 */
export function removeElements(html, tag, test) {
  if (typeof html !== 'string' || html.length === 0) return ''
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  let out = ''
  let cursor = 0
  let m
  while ((m = openRe.exec(html)) !== null) {
    if (m.index < cursor) continue
    const inner = m.index + m[0].length
    const end = matchClose(html, inner, tag)
    if (end < 0) continue
    let hit = false
    try {
      hit = test(m[0], html.slice(inner, end - `</${tag}>`.length)) === true
    } catch {
      hit = false
    }
    if (!hit) continue
    out += html.slice(cursor, m.index)
    cursor = end
    openRe.lastIndex = end
  }
  return out + html.slice(cursor)
}

/**
 * Split a page into balanced top-level `<table>…</table>` chunks.
 * Nested tables stay inside their parent chunk.
 *
 * @param {string} html
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitTables(html, limit = 400) {
  const text = typeof html === 'string' ? html : ''
  const out = []
  let cursor = 0
  while (out.length < limit) {
    const start = text.indexOf('<table', cursor)
    if (start < 0) break
    const end = matchClose(text, start + '<table'.length, 'table')
    if (end < 0) {
      out.push(text.slice(start))
      break
    }
    out.push(text.slice(start, end))
    cursor = end
  }
  return out
}

/**
 * First table whose chunk satisfies `matcher`.
 * @param {string} html
 * @param {(table: string) => boolean} matcher
 */
export function findTable(html, matcher) {
  for (const table of splitTables(html)) {
    try {
      if (matcher(table)) return table
    } catch {
      /* a bad matcher must not abort the scan */
    }
  }
  return ''
}

/** Table carrying `id="<id>"` (e.g. `CardSelectTr`). */
export function tableById(html, id) {
  const needle = `id="${id}"`
  return findTable(html, (table) => {
    const open = /<table[^>]*>/i.exec(table)
    return open !== null && open[0].includes(needle)
  })
}

/**
 * Row split — BRIEF §3.2 mandates lookahead splitting so that `data-param*`
 * attributes survive (`split(/<tr[^>]*>/)` loses them; that was a real bug).
 *
 * The first element is the header/prefix and is dropped with `slice(1)`.
 *
 * @param {string} table
 * @returns {string[]}
 */
export function tableRows(table) {
  if (typeof table !== 'string' || table.length === 0) return []
  return table.split(/(?=<tr[\s>])/i).slice(1)
}

/** The `<tr …>` opening tag of a row (empty string when absent). */
export function rowTag(row) {
  const m = /<tr[^>]*>/i.exec(typeof row === 'string' ? row : '')
  return m === null ? '' : m[0]
}

/**
 * Cell split — BRIEF §3.2. The first element is the `<tr …>` tag itself.
 * @param {string} row
 * @returns {string[]}
 */
export function cellsOf(row) {
  if (typeof row !== 'string' || row.length === 0) return []
  return row.split(/(?=<t[dh][\s>])/i).slice(1)
}

/** All attributes of a tag as a plain object (`class="a b"` → `{class: 'a b'}`). */
export function attrsOf(tag) {
  const out = {}
  if (typeof tag !== 'string') return out
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g
  let m
  while ((m = re.exec(tag)) !== null) {
    const name = (m[1] ?? m[3] ?? '').toLowerCase()
    if (name.length === 0) continue
    out[name] = m[2] ?? m[4] ?? ''
  }
  return out
}

/** One attribute value, or `''`. */
export function attrOf(tag, name) {
  return attrsOf(tag)[String(name).toLowerCase()] ?? ''
}

/**
 * `data-param1..N` of a `<tr>`/`<div>` tag → `{ param1: '3星', … }`.
 * Non-numeric keys are ignored; missing indices are absent (never `undefined`).
 */
export function dataParams(tag) {
  const out = {}
  const re = /data-param(\d+)\s*=\s*"([^"]*)"/gi
  let m
  while ((m = re.exec(typeof tag === 'string' ? tag : '')) !== null) {
    out[`param${Number(m[1])}`] = m[2]
  }
  return out
}

/** First `<a … title="…">` value inside `html`. */
export function firstLinkTitle(html) {
  if (typeof html !== 'string') return ''
  const re = /<a\b[^>]*\btitle\s*=\s*"([^"]*)"/gi
  const m = re.exec(html)
  return m === null ? '' : decodeEntities(m[1]).trim()
}

/** Does this attribute blob carry the class token? */
function hasClassToken(attrs, token) {
  const m = /\bclass\s*=\s*"([^"]*)"/i.exec(attrs ?? '')
  if (m === null) return false
  return m[1].split(/\s+/).includes(token)
}

/** Build the element descriptor for an open-tag match. */
function describeElement(html, tag, open, start) {
  const inner = start + open.length
  const end = VOID_TAGS.has(tag) ? inner : matchClose(html, inner, tag)
  const closeLength = VOID_TAGS.has(tag) ? 0 : `</${tag}>`.length
  return {
    tag,
    open,
    start,
    end: end < 0 ? html.length : end,
    inner: end < 0 ? html.slice(inner) : html.slice(inner, end - closeLength),
  }
}

/**
 * Find the first element carrying a class token.
 * @param {string} html
 * @param {string} className
 * @returns {{tag: string, open: string, start: number, end: number, inner: string}|null}
 */
export function elementByClass(html, className) {
  if (typeof html !== 'string' || html.length === 0) return null
  const token = String(className)
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    if (!hasClassToken(m[2], token)) continue
    return describeElement(html, m[1].toLowerCase(), m[0], m.index)
  }
  return null
}

/** Text inside every element carrying `className` (in document order). */
export function classTexts(html, className) {
  const out = []
  if (typeof html !== 'string' || html.length === 0) return out
  const token = String(className)
  const re = /<([a-z][a-z0-9]*)\b([^>]*)>/gi
  let m
  let cursor = 0
  while ((m = re.exec(html)) !== null) {
    if (m.index < cursor) continue
    if (!hasClassToken(m[2], token)) continue
    const found = describeElement(html, m[1].toLowerCase(), m[0], m.index)
    if (found.end <= found.start) continue
    const text = cleanText(found.inner)
    if (text.length > 0) out.push(text)
    cursor = found.end
    re.lastIndex = found.end
  }
  return out
}

/** Text of the first element carrying `className`. */
export function classText(html, className) {
  const found = elementByClass(html, className)
  return found === null ? '' : cleanText(found.inner)
}

/**
 * Text cleaner — BRIEF §3.2 steps 1–5, plus two additions forced by real data:
 *
 *   - `<style>`/`<script>` bodies (the curio/equation icon cells inline whole
 *     stylesheets — leaving them in poisons every "content" field);
 *   - `<span class="smwttcontent">…</span>` (SMW hover tooltips). BRIEF §3.2 only
 *     mentions the `display:none` wrapper, but on the live wiki the tooltip body
 *     of `<span class="smw-highlighter" data-title="羽化">` sits *outside* any
 *     hidden div, so stripping tags alone splices tooltip prose into the effect
 *     text.
 *
 * @param {string} html
 * @param {{blocks?: boolean}} [options] `blocks: true` also turns block-level
 *   closers (`</p>`, `</li>`, `</dd>`, `</tr>`, `</div>`, headings…) into `\n`,
 *   which is what the speech-script pages (播报/星神/派系) need to stay readable.
 * @returns {string}
 */
export function cleanText(html, options = {}) {
  if (html === null || html === undefined) return ''
  let s = String(html)
  if (s.length === 0) return ''
  s = stripComments(s)
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
  // 1. SMW tooltip overlays
  s = removeElements(s, 'div', (open) => /style\s*=\s*"[^"]*display\s*:\s*none/i.test(open))
  s = removeElements(s, 'span', (open) => /class\s*=\s*"[^"]*smwttcontent/i.test(open))
  s = removeElements(s, 'span', (open) => /class\s*=\s*"[^"]*smwtticon/i.test(open))
  s = removeElements(s, 'span', (open) => /class\s*=\s*"[^"]*mw-editsection/i.test(open))
  // 2. line breaks
  s = s.replace(/<br\s*\/?>/gi, '\n')
  if (options.blocks === true) {
    s = s.replace(/<\/(p|li|dd|dt|dl|ul|ol|tr|td|th|div|h[1-6]|table|center|blockquote|section|figcaption)\s*>/gi, '\n')
    s = s.replace(/<hr\s*\/?>/gi, '\n')
  }
  // 3. remaining tags
  s = s.replace(/<[^>]*>/g, '')
  s = s.replace(/&#160;|&nbsp;|&ensp;|&emsp;|&thinsp;/gi, ' ')
  // 4. entities
  s = decodeEntities(s)
  // 5. whitespace: squeeze runs, keep single \n
  s = s.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}

/**
 * Name extraction priority — BRIEF §3.2:
 *   `<a title>` > `class="equation-title"` / `relicset-name` / `weapon-name` > text.
 *
 * @param {string} html
 * @param {{classNames?: string[]}} [options]
 */
export function extractName(html, options = {}) {
  const classNames = Array.isArray(options.classNames) ? options.classNames : ['equation-title', 'relicset-name', 'weapon-name', 'curio-title']
  const link = firstLinkTitle(html)
  if (link.length > 0) return link
  for (const className of classNames) {
    const text = classText(html, className)
    if (text.length > 0) return text
  }
  return cleanText(html)
}

/**
 * Split a page into balanced blocks starting at `startRe` matches
 * (used for the `<div class="divsort">` relic/light-cone cards).
 *
 * @param {string} html
 * @param {RegExp} startRe must match the whole opening tag of the block
 * @param {{limit?: number}} [options]
 * @returns {{blocks: string[], unbalanced: number}}
 */
export function splitBlocks(html, startRe, options = {}) {
  const text = typeof html === 'string' ? html : ''
  const limit = options.limit ?? 5000
  const re = new RegExp(startRe.source, startRe.flags.includes('g') ? startRe.flags : `${startRe.flags}g`)
  const blocks = []
  let unbalanced = 0
  let m
  let lastEnd = 0
  while ((m = re.exec(text)) !== null && blocks.length < limit) {
    const tagMatch = /^<([a-z][a-z0-9]*)/i.exec(m[0])
    const tag = tagMatch === null ? 'div' : tagMatch[1].toLowerCase()
    const innerStart = m.index + m[0].length
    let end = VOID_TAGS.has(tag) ? innerStart : matchClose(text, innerStart, tag)
    if (end < 0) {
      unbalanced += 1
      end = re.lastIndex = nextBlockBoundary(text, re, innerStart)
    } else {
      re.lastIndex = end
    }
    blocks.push(text.slice(m.index, end))
    lastEnd = end
  }
  void lastEnd
  return { blocks, unbalanced }
}

/** Where the next block starts (or EOF) — keeps an unbalanced block from eating the rest. */
function nextBlockBoundary(text, re, from) {
  re.lastIndex = from
  const m = re.exec(text)
  return m === null ? text.length : m.index
}

/**
 * Heading list with section boundaries.
 *
 * @param {string} html
 * @returns {{level: number, title: string, id: string, index: number, end: number}[]}
 */
export function headings(html) {
  const text = typeof html === 'string' ? html : ''
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi
  const out = []
  let m
  while ((m = re.exec(text)) !== null) {
    const inner = m[2]
    const headline = elementByClass(inner, 'mw-headline')
    out.push({
      level: Number(m[1]),
      title: cleanText(inner),
      id: attrOf(headline === null ? (/(<span[^>]*>)/i.exec(inner) ?? [''])[0] : headline.open, 'id'),
      index: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/**
 * Section slices for the heading levels requested. A section runs from the end
 * of its heading to the next heading whose level is <= its own — except for the
 * levels listed in `ownLevels`, which stop at the next heading of *any* level
 * (their own text only, so a parent does not repeat its children).
 *
 * @param {string} html
 * @param {{levels?: number[], ownLevels?: number[]}} [options]
 * @returns {{level: number, title: string, id: string, parent: string, start: number, end: number, html: string}[]}
 */
export function sectionSlices(html, options = {}) {
  const levels = Array.isArray(options.levels) ? options.levels : [2, 3]
  const ownLevels = Array.isArray(options.ownLevels) ? options.ownLevels : []
  const text = typeof html === 'string' ? html : ''
  const all = headings(text)
  const out = []
  const stack = []
  for (let i = 0; i < all.length; i += 1) {
    const heading = all[i]
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1].title : ''
    stack.push(heading)
    if (!levels.includes(heading.level)) continue
    let end = text.length
    if (ownLevels.includes(heading.level)) {
      end = i + 1 < all.length ? all[i + 1].index : text.length
    } else {
      for (let j = i + 1; j < all.length; j += 1) {
        if (all[j].level <= heading.level) {
          end = all[j].index
          break
        }
      }
    }
    out.push({
      level: heading.level,
      title: heading.title,
      id: heading.id,
      parent,
      start: heading.end,
      end,
      html: text.slice(heading.end, end),
    })
  }
  return out
}

/**
 * Drop page chrome that pollutes full-page text: the sticky TOC, breadcrumb
 * edit bar, edit-section links and the "第一次来" banner.
 *
 * @param {string} html
 */
export function stripPageChrome(html) {
  let s = typeof html === 'string' ? html : ''
  s = removeElements(s, 'div', (open) => /\bid\s*=\s*"(toc|bread-edit|noscrolltoc)"/i.test(open))
  s = removeElements(s, 'div', (open) => /class\s*=\s*"[^"]*(bread-edit|toc-sticky|toc\b)/i.test(open))
  // The breadcrumb bar itself is an anonymous styled div holding `首页 > …`.
  s = removeElements(s, 'div', (open, inner) => /title="首页"/.test(inner ?? '') && (inner ?? '').length < 4000)
  s = removeElements(s, 'span', (open) => /class\s*=\s*"[^"]*mw-editsection/i.test(open))
  s = removeElements(s, 'center', (open, inner) => /第一次来|WIKI功能|Ctrl\+D/i.test(inner ?? ''))
  return s
}

/** Balanced block for the element starting at `start` (open tag included). */
export function blockAt(html, start, tag = 'div') {
  const text = typeof html === 'string' ? html : ''
  const openRe = new RegExp(`^<${tag}\\b[^>]*>`, 'i')
  const m = openRe.exec(text.slice(start))
  if (m === null) return ''
  const end = matchClose(text, start + m[0].length, tag)
  return end < 0 ? text.slice(start) : text.slice(start, end)
}

/** `undefined`/`null` → `''`, everything else stringified. */
export function s(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/** Drop keys whose value is `undefined` — the DSH host rejects non-lossless JSON. */
export function omitUndefined(object) {
  const out = {}
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

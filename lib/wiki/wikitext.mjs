/**
 * Wikitext template helpers (BRIEF §3.3 detail pages).
 *
 * The wiki's detail pages are one big `{{模板|字段=值}}` call, e.g.
 * `{{遗器套装|名称=…|头部故事=…}}` and `{{光锥图鉴|…|光锥故事=…}}`. Values may
 * span lines, contain nested templates (`{{颜色|描述2|18%}}`), wikilinks,
 * `<!-- -->` comments and raw `<br>`/`<i>` markup.
 *
 * Everything here is pure text processing — no network, fully offline-testable.
 *
 * @module dsh-history-fictionologists/lib/wiki/wikitext
 */
import { decodeEntities, omitUndefined, stripComments } from './html.mjs'

/** Split `text` on `separator` only at brace/bracket depth 0. */
function splitTopLevel(text, separator = '|') {
  const out = []
  let depthCurly = 0
  let depthSquare = 0
  let current = ''
  for (let i = 0; i < text.length; i += 1) {
    const two = text.slice(i, i + 2)
    if (two === '{{') {
      depthCurly += 1
      current += two
      i += 1
      continue
    }
    if (two === '}}') {
      depthCurly -= 1
      current += two
      i += 1
      continue
    }
    if (two === '[[') {
      depthSquare += 1
      current += two
      i += 1
      continue
    }
    if (two === ']]') {
      depthSquare -= 1
      current += two
      i += 1
      continue
    }
    if (text[i] === separator && depthCurly === 0 && depthSquare === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += text[i]
  }
  out.push(current)
  return out
}

/** Index of the first `=` at depth 0, or -1. */
function topLevelEquals(part) {
  let depthCurly = 0
  let depthSquare = 0
  for (let i = 0; i < part.length; i += 1) {
    const two = part.slice(i, i + 2)
    if (two === '{{' || two === '[[') {
      depthCurly += two === '{{' ? 1 : 0
      depthSquare += two === '[[' ? 1 : 0
      i += 1
      continue
    }
    if (two === '}}' || two === ']]') {
      depthCurly -= two === '}}' ? 1 : 0
      depthSquare -= two === ']]' ? 1 : 0
      i += 1
      continue
    }
    if (part[i] === '=' && depthCurly === 0 && depthSquare === 0) return i
  }
  return -1
}

/**
 * Locate the first `{{name|…}}` call and return its raw text plus balanced body.
 *
 * @param {string} text
 * @param {string} name template name, e.g. `遗器套装` (case-insensitive)
 * @returns {{name: string, raw: string, body: string, start: number, end: number}|null}
 */
export function findTemplate(text, name) {
  const source = typeof text === 'string' ? stripComments(text) : ''
  if (source.length === 0 || typeof name !== 'string' || name.length === 0) return null
  const needle = `{{${name}`
  const lower = source.toLowerCase()
  const target = needle.toLowerCase()
  let from = 0
  while (from < source.length) {
    const start = lower.indexOf(target, from)
    if (start < 0) return null
    const after = source[start + needle.length]
    if (after === undefined || after === '|' || after === '}' || after === '\n' || after === ' ' || after === '\t') {
      let depth = 0
      let end = -1
      for (let i = start; i < source.length - 1; i += 1) {
        const two = source.slice(i, i + 2)
        if (two === '{{') {
          depth += 1
          i += 1
          continue
        }
        if (two === '}}') {
          depth -= 1
          i += 1
          if (depth === 0) {
            end = i + 1
            break
          }
        }
      }
      if (end < 0) return null
      const raw = source.slice(start, end)
      return { name, raw, body: raw.slice(2, -2), start, end }
    }
    from = start + needle.length
  }
  return null
}

/**
 * Parse a template body (`名称=x|头部=…`) into ordered params + named fields.
 *
 * @param {string} body
 * @returns {{fields: Record<string, string>, params: string[], order: string[]}}
 */
export function parseTemplate(body) {
  const fields = {}
  const params = []
  const order = []
  if (typeof body !== 'string' || body.length === 0) return { fields, params, order }
  const parts = splitTopLevel(body, '|')
  // The template name itself is `parts[0]`.
  for (const part of parts.slice(1)) {
    const eq = topLevelEquals(part)
    if (eq < 0) {
      params.push(part)
      continue
    }
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1)
    if (key.length === 0) {
      params.push(value)
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(fields, key)) order.push(key)
    fields[key] = value
  }
  return { fields, params, order }
}

/**
 * `{{name|…}}` → `{ name, fields, params, order, raw }` (null when absent).
 *
 * @param {string} text
 * @param {string} name
 */
export function templateFields(text, name) {
  const found = findTemplate(text, name)
  if (found === null) return null
  const parsed = parseTemplate(found.body)
  return { name, raw: found.raw, body: found.body, fields: parsed.fields, params: parsed.params, order: parsed.order }
}

/** First non-empty field among `keys`. */
export function field(fields, ...keys) {
  if (fields === null || typeof fields !== 'object') return ''
  for (const key of keys) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return ''
}

/** The last non-empty positional param of a template call (its "display text"). */
function displayOf(parts) {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const value = parts[i].trim()
    if (value.length > 0) return value
  }
  return ''
}

/** Replace the innermost `{{…}}` calls until none are left. */
function collapseTemplates(text) {
  let s = text
  let guard = 0
  while (s.includes('{{') && guard < 5000) {
    guard += 1
    let replaced = false
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_match, inner) => {
      replaced = true
      const parts = String(inner).split('|')
      // Skip the template name and named params; only positional args display.
      const positional = parts.slice(1).filter((part) => topLevelEquals(part) < 0)
      return displayOf(positional)
    })
    if (!replaced) break
  }
  return s
}

/**
 * Wikitext value → plain text (BRIEF §3.3 "遗器来历"):
 *   - `<!-- -->` stripped;
 *   - nested templates collapsed to their display argument
 *     (`{{颜色|描述2|18%}}` → `18%`);
 *   - `[[a|b]]` → `b`, `[[a]]` → `a`;
 *   - `<br>` → newline;
 *   - `<i>`/`<b>`/`<big>`/`<span>` unwrapped (the citation inside `<i>` is kept
 *     as ordinary text);
 *   - entities decoded, whitespace squeezed (single `\n` kept).
 *
 * @param {string} value
 * @returns {string}
 */
export function wikitextToText(value) {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (s.length === 0) return ''
  s = stripComments(s)
  s = collapseTemplates(s)
  s = s.replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, '$2')
  s = s.replace(/\[\[([^\]]+)\]\]/g, '$1')
  s = s.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]*)\]/g, '$2')
  s = s.replace(/\[(https?:\/\/[^\s\]]+)\]/g, '')
  s = s.replace(/'''([^']*)'''/g, '$1')
  s = s.replace(/''([^']*)''/g, '$1')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/?(?:i|b|big|small|span|div|p|center|font|u|s|sub|sup|code|nowiki|poem|blockquote|dl|dt|dd|li|ul|ol)\b[^>]*>/gi, '')
  s = s.replace(/<[^>]*>/g, '')
  s = s.replace(/&#160;|&nbsp;/gi, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ')
  s = s.replace(/ *\n */g, '\n')
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}

/**
 * Convenience: `templateFields(text, name)` → `wikitextToText(fields[key])`.
 *
 * @param {string} text
 * @param {string} name template name
 * @param {string[]} keys candidate field names, first non-empty wins
 */
export function templateFieldText(text, name, ...keys) {
  const parsed = templateFields(text, name)
  if (parsed === null) return ''
  return wikitextToText(field(parsed.fields, ...keys))
}

/**
 * Every `{{name|…}}` call in a page, in document order.
 *
 * @param {string} text
 * @param {string} name
 * @returns {string[]} raw template texts
 */
export function allTemplates(text, name) {
  const source = typeof text === 'string' ? stripComments(text) : ''
  const out = []
  let cursor = 0
  for (let guard = 0; guard < 200; guard += 1) {
    const found = findTemplate(source.slice(cursor), name)
    if (found === null) break
    out.push(found.raw)
    cursor += found.end
  }
  return out
}

/** Lossless-value guard used by the extractors. */
export { omitUndefined }

/**
 * 最硬的一条证据：把用户**原文**从会话记录里挖出来，与 `PLANET_BASELINE_SOURCE` 逐字符比对。
 *
 * 为什么值得单独写一个脚本：`test/planets.test.mjs` 只能证明「常量与同一文件里的底本文本一致」——
 * 如果当初抄写时就把某一行抄错了，那条断言照样通过。这里读的是**用户真正发来的那条消息**
 * （本机 DSH 的会话记录 `session.v4.jsonl.zstd`），所以它能抓到抄写错误。
 *
 * 用法：
 *   node _evidence/planet-baseline-vs-user-text.mjs             # 自动找最近一次含星球列表的会话
 *   node _evidence/planet-baseline-vs-user-text.mjs <会话文件路径>
 *
 * 只读，不写任何东西；解压失败或找不到原文都会明确报失败，不会静默通过。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { PLANET_BASELINE_SOURCE, PLANETS } from '../lib/planets.mjs'

const SESSIONS = join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'sessions')

/** 用户原文里的「锚点」：列表的第一行与最后一行（任一条缺失即判定为没找到原文）。
 *
 * ⚠️ 口径提醒（独立复核者指出，属**已知假阴性风险**）：用户若改写了第一颗或最后一颗星球的名字，
 * 本脚本会报「找不到原文」而不是「不一致」。它不会给出假阳性（比对本身是逐行严格的），
 * 但要判断「用户是否改过列表」时，应改用复核者的脚本
 * `_evidence/reviewer-baseline-check.mjs`（它不依赖任何原文片段当锚点）。 */
const FIRST = '阿丽万塔 (Arivanta)'
const LAST = '日耀-XIII (Sunburst-XIII)'

/**
 * 会话记录是**多帧 zstd**（实测：`zstdDecompressSync` 只解出第一帧 234 字符，
 * 而整个文件 789 KB）——所以必须逐帧解压并拼接，否则会得出「没找到用户原文」的假阴性。
 */
function decompressAllFrames(path) {
  let buffer = readFileSync(path)
  const parts = []
  let frames = 0
  while (buffer.length > 0) {
    try {
      parts.push(zstdDecompressSync(buffer))
    } catch (error) {
      if (frames === 0) throw error
      break // 余下的不是可解帧：保留已解出的部分，交给下面的锚点判定
    }
    frames += 1
    // 重新定位下一帧的魔数（28 b5 2f fd）；解压 API 不告诉我们第一帧消耗了多少字节。
    const next = buffer.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4)
    if (next < 0) break
    buffer = buffer.subarray(next)
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.jsonl.zstd')) yield full
  }
}

/**
 * 会话记录是 JSONL：每行一个事件（`{type, seq, time, data}`）。用户消息的事件类型是
 * `user/message`，文本在 `data.content[].text` 里，且换行/制表符是 **JSON 转义**过的。
 *
 * 踩过的两个坑（都实测过）：
 *   1. 直接对整份文本 `indexOf('阿丽万塔')`，切到的是**原始 JSON 字符串**——`\t` 还是两个字符，
 *      比对必然 1 行对 27 行；
 *   2. 事件里没有 `role` 字段（那是 `data.content[].type` 与事件 `type: "user/message"`），
 *      按 `role === 'user'` 过滤会得到 0 条。
 */
function userMessagesFrom(text) {
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed[0] !== '{') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (event?.type !== 'user/message') continue
    const content = event?.data?.content
    if (!Array.isArray(content)) continue
    const joined = content
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n')
    if (joined.length > 0) out.push(joined)
  }
  return out
}

/** 从一条用户消息里切出星球列表区段（从 FIRST 到 LAST 所在行）。 */
function extractBlock(text) {
  const start = text.indexOf(FIRST)
  if (start < 0) return null
  const end = text.indexOf(LAST, start)
  if (end < 0) return null
  const lineEnd = text.indexOf('\n', end)
  const block = text.slice(start, lineEnd < 0 ? undefined : lineEnd)
  return block.trim()
}

/** 逐行规整：去掉行尾空白与 \r，保留制表符与正文（用户原文的制表符是分隔符）。 */
const normalize = (text) => text.split(/\r?\n/).map((line) => line.replace(/\s+$/, '')).filter((line) => line.length > 0)

const explicit = process.argv[2]
const candidates = explicit !== undefined  ? [explicit]
  : [...walk(SESSIONS)].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

console.log(`会话根目录：${SESSIONS}`)
console.log(`候选会话文件：${candidates.length} 个${explicit ? '（指定）' : '（按修改时间倒序）'}`)

let userBlock = null
let source = null
for (const file of candidates) {
  let text
  try {
    const result = decompressAllFrames(file)
    text = result.text
  } catch (error) {
    console.log(`  跳过（解压失败）：${file} —— ${error?.message ?? error}`)
    continue
  }
  const block = userMessagesFrom(text)
    .map((message) => extractBlock(message))
    .find((candidate) => typeof candidate === 'string' && candidate.length > 0)
  if (typeof block === 'string') {
    userBlock = block
    source = file
    break
  }
}

// `undefined`（find 没命中）也必须在同一处拦住：只判 `!== null` 时它会被放行，
// 然后在 `normalize()` 里炸成 TypeError——那是脚本自己的缺陷，不是被测对象的证据。
assert.ok(typeof userBlock === 'string' && userBlock.length > 0, '在所有会话记录里都没找到用户原文（锚点行缺失）——不能判定通过')
console.log(`\n找到用户原文：${source}`)
console.log(`原文行数：${normalize(userBlock).length}`)

const expected = normalize(PLANET_BASELINE_SOURCE)
const actual = normalize(userBlock)

console.log(`PLANET_BASELINE_SOURCE 行数：${expected.length}`)

let mismatches = 0
const max = Math.max(expected.length, actual.length)
for (let index = 0; index < max; index += 1) {
  if (expected[index] !== actual[index]) {
    mismatches += 1
    if (mismatches <= 5) {
      console.log(`\n[差异 ${mismatches}] 第 ${index + 1} 行`)
      console.log(`  用户原文：${JSON.stringify(actual[index] ?? '(无)')}`)
      console.log(`  插件底本：${JSON.stringify(expected[index] ?? '(无)')}`)
    }
  }
}

console.log(`\n不一致行数：${mismatches}`)
console.log(`常量条数：${PLANETS.length}`)

assert.equal(actual.length, 27, `用户原文应为 27 行，实际 ${actual.length}`)
assert.equal(mismatches, 0, `PLANET_BASELINE_SOURCE 与用户原文有 ${mismatches} 行不一致`)
assert.equal(PLANETS.length, 27)

console.log('\nBASELINE MATCHES THE USER MESSAGE VERBATIM (27/27 lines)')

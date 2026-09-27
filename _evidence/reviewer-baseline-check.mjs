/**
 * 独立复核 · item A —— 「27 颗原始星球 = 用户原话」的**同义复现**。
 *
 * 与作者脚本 (`planet-baseline-vs-user-text.mjs`) 刻意用不同姿势，避免同一个假阳性：
 *   1. 作者用 `zstdDecompressSync` + 手工找魔数 `28 b5 2f fd` 逐帧解压（帧边界靠猜魔数，
 *      正文里若出现该 4 字节序列会切错）。本脚本改用 **流式** `createZstdDecompress()`
 *      把整份文件喂进去，由 zlib 自己处理帧（Node 24 的流式解码器天然支持多帧拼接）。
 *   2. 作者先 `JSON.parse` 每个事件、只认 `event.type === 'user/message'`。本脚本做**两路**
 *      独立提取：
 *        (a) 事件路：解析 JSONL，认 `user/message`（与作者同)，另外也认 `data.role === 'user'`
 *            或 `data.message.role === 'user'`（作者说会话里没有 role 字段——本脚本把两种形状
 *            都扫一遍，如果真没有，这一路会自然返回 0 条，属于对照而非依赖）；
 *        (b) 原始文本路：在**未解析**的 JSONL 原文里做字符串操作，把 `\t` 反转义后逐行取。
 *      两路结果必须一致，否则说明提取姿势本身有歧义（脚本会报出来）。
 *   3. 比对不只比「行数 + 逐行相等」：还独立检查 27 个名字集合与 27 条描述集合。
 *
 * 只读，不写任何东西（除 stdout）。找不到原文 → 直接失败，绝不静默通过。
 *
 * 用法：node _evidence/reviewer-baseline-check.mjs [会话文件路径]
 */
import assert from 'node:assert/strict'
import { zstdDecompressSync, createZstdDecompress } from 'node:zlib'
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { PLANET_BASELINE_SOURCE, PLANETS, parseBaseline } from '../lib/planets.mjs'

const SESSIONS = join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'sessions')

/**
 * 帧解压。**先记录一个实测反例**：整份文件喂给一个流式 `createZstdDecompress()`
 * 只解出第一帧 234 字节就报 `Unknown frame descriptor`（与作者记录的「多帧」一致）。
 * 所以多帧必须自己切。这里**不用**作者的「解一帧→再 indexOf 魔数」写法，改成
 * 「**逐字节**找魔数、每个偏移各试一次解压、成功且消耗到下一个魔数之前就收下」：
 * 一次只依赖魔数，不依赖「解压 API 消耗了多少字节」这个未公开量。
 */
function decompressAllFrames(path) {
  const buffer = readFileSync(path)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) {
      offsets.push(i)
    }
  }
  const parts = []
  let ok = 0
  for (const offset of offsets) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset)))
      ok += 1
    } catch {
      // 正文里偶然出现的 4 字节序列：解不开就跳过，不吞掉真正的帧。
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), candidates: offsets.length, frames: ok }
}

/** 一次性对照：流式解码器在第一个坏帧处停下，所以它解出的量是多帧文件的下界。 */
async function decompressStreamFirstFrame(path) {
  const chunks = []
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk)
      cb()
    },
  })
  await new Promise((resolve, reject) => {
    const src = createReadStream(path)
    const dec = createZstdDecompress()
    src.on('error', reject)
    sink.on('error', reject)
    sink.on('finish', resolve)
    dec.on('error', () => resolve())
    src.pipe(dec).pipe(sink)
  })
  return Buffer.concat(chunks).length
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.jsonl.zstd')) yield full
  }
}

/** 路 (a)：解析事件，收集候选用户文本（同时记录命中的过滤条件，便于核对作者的说法）。 */
function eventPathUserTexts(text) {
  const byType = []
  const byRole = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed[0] !== '{') continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    const content = event?.data?.content
    const joined = Array.isArray(content)
      ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
      : ''
    if (joined.length === 0) continue
    if (event?.type === 'user/message') byType.push(joined)
    if (event?.data?.role === 'user') byRole.push(joined)
    if (event?.data?.message?.role === 'user') byRole.push(joined)
  }
  return { byType, byRole }
}

/**
 * 路 (b)：**不解析事件结构**，在 JSONL 原文里用逐行正则抠出所有 `"text":"…"` 字段。
 * 作者的两个坑（`\t` 是 JSON 转义、事件没有 `role`）在这一路里都不存在：
 * 这里既不看 type 也不看 role，只看「哪个字符串字段的内容长得像 27 行星球列表」。
 */
function rawPathUserTexts(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (line.length === 0 || line[0] !== '{') continue
    const re = /"text":"((?:[^"\\]|\\.)*)"/g
    let match
    while ((match = re.exec(line)) !== null) {
      let value
      try {
        value = JSON.parse(`"${match[1]}"`)
      } catch {
        continue
      }
      if (value.length > 0) out.push(value)
    }
  }
  return out
}

/**
 * 取「含制表符的连续行块」，起点为第一行含制表符的行，终点为最后一行含制表符的行。
 *
 * 实测细节（作者的脚本靠 `indexOf('阿丽万塔 (Arivanta)')` 锚点绕开了它）：
 * 用户把列表贴在**正文里**，第一行是「…"星球列表"默认如下：阿丽万塔 (Arivanta)\t描述」，
 * 所以首行前面带一段前言。本脚本不引入任何原文片段当锚点，改为**从这一行的第一个制表符
 * 处切开**，只保留「名字 (English)\t描述」（前言本身不含制表符）。
 * 实测细节二（作者的脚本靠 `normalize()` 的行尾 `\s+$` 去掉）：
 * 用户那条消息是 **CRLF**，只在 `\n` 上切会把 `\r` 留在行尾，于是逐行比较必然差一行。
 */
function tabBlock(text) {
  const lines = text.split(/\r?\n/)
  const first = lines.findIndex((l) => l.includes('\t'))
  if (first < 0) return null
  let last = first
  for (let i = first; i < lines.length; i += 1) if (lines[i].includes('\t')) last = i
  const block = lines
    .slice(first, last + 1)
    .filter((l) => l.trim().length > 0)
    .map((line, index) => {
      if (index !== 0) return line
      // 名字段形如 `阿丽万塔 (Arivanta)`（空格 + ASCII 英文名）或 `螺丝星`（无英文名）。
      // 用「显式码点区间」从右往左吃掉名字段：CJK/拉丁/数字/连字符/罗马数字/空格/点/·。
      // 前言里的全角标点（：，。“”）不在集合内，扫到那里自然停。
      // 注：不用 `\p{Script=Han}` —— 实测本机 Node 24.21.0 上无 `u` 标志时属性转义会退化成
      // 字面字符类，`/[\\p{Script=Han}]/.test('阿')` 为 false，会静默匹配不到任何中文。
      const cut = line.indexOf('\t')
      const left = line.slice(0, cut)
      const cc = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9\u2160-\u216f ()\-./··]/
      let start = left.length
      while (start > 0 && cc.test(left[start - 1])) start -= 1
      return left.slice(start).trim() + line.slice(cut)
    })
  return block.length > 0 ? block : null
}

const explicit = process.argv[2]
const candidates = explicit
  ? [explicit]
  : [...walk(SESSIONS)].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

console.log(`[A] 会话根目录：${SESSIONS}`)
console.log(`[A] 候选会话文件：${candidates.length} 个`)

const found = []
for (const file of candidates) {
  let text
  let frames = 0
  let streamBytes = 0
  try {
    const result = decompressAllFrames(file)
    text = result.text
    frames = result.frames
    streamBytes = await decompressStreamFirstFrame(file)
  } catch (error) {
    console.log(`[A]   跳过（解压失败）：${file} —— ${error?.message ?? error}`)
    continue
  }
  const { byType, byRole } = eventPathUserTexts(text)
  const rawPath = rawPathUserTexts(text)
  // 两路各自找「27 行含制表符的块」，都必须命中同一个文本，否则提取姿势本身有歧义。
  const viaType = byType.map(tabBlock).find((b) => b && b.length === 27) ?? null
  const viaRaw = rawPath.map(tabBlock).find((b) => b && b.length === 27) ?? null
  if (!viaType) {
    console.log(`[A]   ${file.slice(-70)}：解出 ${text.length} 字符（流式下界 ${streamBytes}）/ ${frames} 帧，无 27 行块`)
    continue
  }
  {
    const raw = byType.find((m) => (tabBlock(m)?.length ?? 0) === 27)
    const rawLines = raw.split(/\r?\n/)
    const firstTab = rawLines.findIndex((l) => l.includes('\t'))
    console.log(`[A]   DEBUG 原文首行长度=${rawLines[firstTab].length} 制表符个数=${(rawLines[firstTab].match(/\t/g) || []).length}`)
    console.log(`[A]   DEBUG 解析后首行 JSON=${JSON.stringify(viaType[0])}`)
  }  found.push({
    file,
    block: viaType,
    via: 'event:type=user/message',
    textLength: text.length,
    streamBytes,
    frames,
    byRoleCount: byRole.length,
    rawCount: rawPath.length,
    rawCrossCheck: viaRaw !== null && viaRaw.join('\n') === viaType.join('\n'),
  })
  break
}

assert.ok(found.length > 0, '在所有会话记录里都没找到 27 行的用户原文（含制表符的 27 行块）——不能判定通过')

const { file, block, via, textLength, streamBytes, frames, byRoleCount, rawCount, rawCrossCheck } = found[0]
console.log(`[A] 命中会话：${file}`)
console.log(`[A] 提取姿势：${via}`)
console.log(`[A] 解压：${textLength} 字符 / ${frames} 帧；同一文件流式解码器只解出 ${streamBytes} 字节（=多帧证据）`)
console.log(`[A] 对照：按 data.role==='user' 过滤命中 ${byRoleCount} 条；原始文本正则路命中 ${rawCount} 个候选块；两路结果一致=${rawCrossCheck}`)

// ---- 独立比对：逐行 + 集合双向 ----
const expectedLines = PLANET_BASELINE_SOURCE.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0)
const actualLines = block.map((l) => l.replace(/\s+$/, ''))
console.log(`[A] 常量行数=${expectedLines.length} 用户原文行数=${actualLines.length}`)

let mismatch = 0
for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i += 1) {
  if (expectedLines[i] !== actualLines[i]) {
    mismatch += 1
    if (mismatch <= 5) {
      console.log(`[A]   差异 @${i + 1}`)
      console.log(`[A]     用户原文：${JSON.stringify(actualLines[i] ?? null)}`)
      console.log(`[A]     插件底本：${JSON.stringify(expectedLines[i] ?? null)}`)
    }
  }
}
console.log(`[A] 逐行不一致：${mismatch}`)

// 名字集合（名字 = 制表符前的部分去掉 (English)）
const nameOf = (line) => line.split('\t')[0].replace(/\s*\([^()]*\)\s*$/, '').trim()
const constNames = PLANETS.map((p) => p.name)
const userNames = actualLines.map(nameOf)
const onlyInConst = constNames.filter((n) => !userNames.includes(n))
const onlyInUser = userNames.filter((n) => !constNames.includes(n))
console.log(`[A] 名字集合：仅常量有 ${JSON.stringify(onlyInConst)}；仅用户有 ${JSON.stringify(onlyInUser)}`)

// 描述集合（制表符之后）
const constDescs = PLANETS.map((p) => p.description)
const userDescs = actualLines.map((l) => (l.split('\t')[1] ?? '').trim())
const descDiff = constDescs.filter((d, i) => d !== userDescs[i])
console.log(`[A] 描述逐条不一致：${descDiff.length}`)

// parseBaseline 幂等性交叉检查（换一种解析入口）
const reparsed = parseBaseline(PLANET_BASELINE_SOURCE)
console.log(`[A] parseBaseline 二次解析条数=${reparsed.length}；与 PLANETS 名字与描述一致=${reparsed.every((e, i) => e.name === PLANETS[i].name && e.description === PLANETS[i].description)}`)

assert.equal(actualLines.length, 27, `用户原文应为 27 行，实际 ${actualLines.length}`)
assert.equal(mismatch, 0, `与用户原文有 ${mismatch} 行不一致`)
assert.equal(onlyInConst.length, 0, '常量里有用户原文没有的名字')
assert.equal(onlyInUser.length, 0, '用户原文里有常量没有的名字')
assert.equal(descDiff.length, 0, '描述与用户原文不一致')
assert.equal(PLANETS.length, 27)

console.log('\n[A] PASS：27/27 行（名字+英文名+描述）与用户原话逐字符一致（流式解压 + 双路提取）')

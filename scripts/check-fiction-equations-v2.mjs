// 虚构差分方程 · 纸面/离线自检（薄封装，ESM）
//
// 规则本体在 `lib/equations.mjs` —— 本脚本只负责读候选文件、调用校验、写报告。
// 这样「模型在对话里生成」与「工具落盘」用的是同一套规则，不会出现两份口径漂移。
//
// 用法:
//   node scripts/check-fiction-equations-v2.mjs [候选 json] [--allow-single-topic]
//   --allow-single-topic  跳过批级配比检查（只验证单一类别，例如生物命名专项）
// 退出码: 0 = 全通过；1 = 有 FAIL
//
// 候选 JSON 结构（与 gs_equation_save 的入参一致）:
//   { "title"?: string, "entries": [ { name, topic, pathPrimary, pathSecondary?, detail, hooks } ] }
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  readExistingEquationNames,
  renderEquationsCheckReport,
  validateFictionEquations,
} from '../lib/equations.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ws = parse(HERE).dir
const probeDir = join(ws, '_probe')

const args = process.argv.slice(2)
const skipRatio = args.includes('--allow-single-topic')
const rawPath = args.find((a) => !a.startsWith('--')) || join(probeDir, 'fiction-v2-equations.json')

const raw = JSON.parse(readFileSync(rawPath, 'utf8').replace(/^\uFEFF/, ''))
const entries = Array.isArray(raw.entries) ? raw.entries : []

const existing = readExistingEquationNames(ws)
const validation = validateFictionEquations({ entries, existingNames: existing.names, skipRatio })
const report = renderEquationsCheckReport({
  title: raw.title || basename(rawPath),
  validation,
  source: `scripts/check-fiction-equations-v2.mjs（候选：${basename(rawPath)}）`,
})

const outPath = join(probeDir, 'fiction-v2-check.md')
writeFileSync(outPath, report, 'utf8')

console.log(report.split('\n').slice(0, 14).join('\n'))
if (existing.warnings.length > 0) console.log('缓存警告: ' + existing.warnings.join('；'))
if (validation.errors.length > 0) console.log('未通过项: ' + validation.errors.join('；'))
if (validation.rejected.length > 0) {
  console.log('被拒条目: ' + validation.rejected.map((r) => `${r.name}（${r.reason}）`).join('；'))
}
console.log('报告: ' + outPath)
process.exit(validation.ok ? 0 : 1)

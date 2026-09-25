// Final requirements audit: every item from the user's original request, checked
// against the artifacts on disk. Read-only.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel, needle) => existsSync(join(ROOT, rel)) && read(rel).includes(needle)

const pkg = JSON.parse(read('package.json'))
const cacheFiles = existsSync(join(ROOT, 'hsr-worldview-cache'))
  ? readdirSync(join(ROOT, 'hsr-worldview-cache')).filter((f) => f.endsWith('.json'))
  : []
const index = cacheFiles.includes('index.json') ? JSON.parse(read('hsr-worldview-cache/index.json')) : null

const checks = [
  ['插件名 dsh-history-fictionologists', pkg.name === 'dsh-history-fictionologists'],
  ['bundle 清单 (dsh.bundle.patch)', pkg.dsh?.bundle?.patch === './cordis.patch.yml'],
  ['注册进 profile bundles', read('../../.dsh/profiles/web/package.json').includes('dsh-history-fictionologists')],
  ['触发命令 /gs', has('lib/shell.js', "name: 'gs'")],
  ['第 1 步：功能选择（三选一）', has('lib/shell.js', '第 1 步 · 功能选择')],
  ['第 2 步：Y/N 数据更新策略', has('lib/shell.js', '第 2 步 · 世界观数据更新策略')],
  ['第 3 步：执行所选功能', has('lib/shell.js', '第 3 步 · 执行所选功能')],
  ['缓存较新时先确认一句', has('lib/shell.js', '数据较新，确认需要重新抓取吗？')],
  ['功能 1 神人制造机：5 段式格式', has('lib/shell.js', '【灵感名称】') && has('lib/shell.js', '命途归属') && has('lib/shell.js', '可能的故事方向')],
  ['功能 1 条数 3–5', has('lib/shell.js', '（3–5 条）')],
  ['功能 2 构史文集：默认 2000 字', has('lib/shell.js', 'defaultStoryWords: 2000')],
  ['功能 2 参考「书架」风格', has('lib/digest.js', '书架')],
  ['功能 3 播报：固定格式（音乐/女声/男声/结束语）',
    has('lib/shell.js', '（音乐）') && has('lib/shell.js', '女声：') && has('lib/shell.js', '男声：') && has('lib/shell.js', '本次播报到此结束')],
  ['功能 3 篇幅 800–1200 字 / 3–5 条', has('lib/shell.js', '800–1200')],
  ['风格总则：用最严肃的格式包装最离谱的内容', has('lib/shell.js', '用最严肃的格式包装最离谱的内容')],
  ['风格总则：不得凭空编造与既有设定冲突', has('lib/shell.js', '不得凭空编造与既有设定冲突的事实')],
  ['12 个数据源都在登记表里',
    ['relics', 'lightcones', 'consumables', 'decorations', 'aeons', 'factions', 'terms', 'simuniverse', 'curios', 'events', 'equations', 'broadcast']
      .every((id) => has('lib/wiki/datasets.mjs', `'${id}'`) || has('lib/wiki/datasets.mjs', `"${id}"`))],
  ['过滤：消耗品排除翁法罗斯', has('lib/wiki/extract.mjs', '翁法罗斯')],
  ['过滤：事件与方程排除千面英雄', has('lib/wiki/extract.mjs', '千面英雄')],
  ['缓存目录按类别分文件', cacheFiles.filter((f) => f !== 'index.json').length === 12],
  ['每个缓存文件带 lastUpdated', index !== null && Object.values(index.datasets ?? {}).every((d) => typeof d.lastUpdated === 'string')],
  ['增量：revid 短路', has('lib/wiki/index.mjs', 'revisionId')],
  ['抓取限流 ≥1500ms', has('lib/wiki/client.mjs', 'Math.max(1500')],
  ['WAF 非 JSON 识别 + 退避重试', has('lib/wiki/client.mjs', '567') && has('lib/wiki/client.mjs', 'backoffMs')],
  ['失败回退缓存并明确告知', has('lib/shell.js', '更新失败，已使用缓存数据')],
  ['hsr-missions 已发生故事避让', has('lib/digest.js', '已发生故事') && has('lib/missions.js', 'scanMissions')],
  ['成品落盘 hsr-stories / hsr-broadcasts', has('lib/shell.js', "kind === 'broadcast' ? broadcastsDir(ws)")],
  ['版权说明（非营利性二创）', has('lib/shell.js', '非营利性二创')],
  ['README 有触发方式/更新方式/缓存目录', has('README.md', '## 怎么触发') && has('README.md', '## 缓存目录')],
  ['BRIEF 勘误表', has('BRIEF.md', '勘误')],
  ['独立复核报告存在', existsSync(join(ROOT, '_evidence/review-shell.md'))],
  ['端到端验证脚本 + 输出', existsSync(join(ROOT, '_evidence/verify-gs-e2e.mjs')) && existsSync(join(ROOT, '_evidence/verify-gs-e2e.txt'))],
  ['提示词注入证据', existsSync(join(ROOT, '_evidence/prompt-section-injection.txt'))],
]

let pass = 0
for (const [label, ok] of checks) {
  if (ok) pass += 1
  console.log(`  ${ok ? 'OK  ' : 'MISS'}  ${label}`)
}
console.log(`\nAUDIT: ${pass} / ${checks.length}`)
if (pass !== checks.length) process.exit(1)

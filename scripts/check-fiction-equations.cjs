// 虚构差分方程 · 生成后自检（机制 B）
// 用法: node scripts/check-fiction-equations.cjs [候选 json 路径]
// 默认候选: _probe/fiction-demo-equations.json；报告写到 _probe/fiction-demo-check.md
// 检查：重名 / 结构 / 方括号符号合法性 / 星神与令使 / 篇幅 / 主题配比
// 退出码：0 = 全通过；1 = 有 FAIL
const fs = require('fs');
const path = require('path');

const ws = path.parse(__dirname).dir;
const probeDir = path.join(ws, '_probe');
const rawPath = process.argv[2] || path.join(probeDir, 'fiction-demo-equations.json');
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const entries = raw.entries || [];

const official = JSON.parse(fs.readFileSync(path.join(ws, 'hsr-worldview-cache', 'equations.json'), 'utf8')).entries;
const officialNames = new Set(official.map(e => e.name));

// 既有 48 个符号 = 唯一合法符号集（最小版：不允许自造新符号）
const legalSymbols = new Set();
for (const e of official) for (const m of e.content.matchAll(/【([^】]+)】/g)) legalSymbols.add(m[1]);

const PATHS = ['欢愉', '智识', '繁育', '毁灭', '虚无', '巡猎', '记忆', '存护', '丰饶', '同谐'];
const TOPICS = ['人物·职业/身份', '生物·物种/衍生体', '装置·器物/场所', '抽象概念·现象/事件', '派系·机构/组织'];
const WORD_RANGE = { '1星': [40, 80], '2星': [60, 110], '3星': [90, 150], '4星': [60, 120] };
const BANNED = ['星神', '令使', '绝灭大君', '纳努克', '阿哈', '岚', '药师', '克里珀', '浮黎', '博识尊', '希佩', '伊德莉拉', '阿基维利', '奥博洛斯', '塔伊兹育罗斯', '太一', '迷思', 'Ⅸ'];

const rows = [];
const counts = {};
let fail = 0;

for (const e of entries) {
  const problems = [];
  const warns = [];
  const text = String(e.content || '');
  const chars = text.replace(/\s/g, '').length;

  // 1) 重名
  if (officialNames.has(e.name)) problems.push(`名称与既有方程重名：${e.name}`);
  const dupInBatch = entries.filter(x => x.name === e.name).length > 1;
  if (dupInBatch) problems.push('本批次内名称重复');

  // 2) 结构
  if (!/^[1-4]星$/.test(e.rarity || '')) problems.push(`星级非法：${e.rarity}`);
  if (!PATHS.includes(e.pathPrimary)) problems.push(`主命途非法：${e.pathPrimary}`);
  if (!PATHS.includes(e.pathSecondary)) problems.push(`次命途非法：${e.pathSecondary}`);
  if (e.pathPrimary === e.pathSecondary) problems.push('主次命途相同');
  const blessingLines = String(e.blessing || '').split('\n').filter(Boolean);
  const needLines = e.rarity === '4星' ? 1 : 2;
  if (blessingLines.length !== needLines) warns.push(`配方行数 ${blessingLines.length}（同星级常见为 ${needLines}；仅作提示）`);
  for (const l of blessingLines) {
    if (!/^[^\d]+×\d+$/.test(l)) problems.push(`配方格式异常：${l}`);
    const p = l.split('×')[0];
    if (!PATHS.includes(p)) problems.push(`配方命途非法：${p}`);
  }
  // 4 星模板
  if (e.rarity === '4星' && !/消耗100点能量施放技能与命途「.+」产生临界回响/.test(text)) {
    problems.push('4 星缺「消耗100点能量…临界回响」模板句');
  }
  // 命途需在正文有挂点（4 星由模板句承担）
  if (e.rarity !== '4星' && !text.includes(e.pathPrimary) && !text.includes(e.pathSecondary)) {
    warns.push('正文未出现主/次命途字样（既有 1–3 星多数也不出现，仅记录）');
  }

  // 3) 方括号符号
  const used = [...text.matchAll(/【([^】]+)】/g)].map(m => m[1]);
  const unknown = [...new Set(used.filter(s => !legalSymbols.has(s)))];
  if (unknown.length) problems.push(`自造符号：${unknown.join('、')}`);
  if (!used.length) warns.push('未使用任何方括号符号');

  // 4) 星神与令使
  const hit = BANNED.filter(b => e.name.includes(b) || text.includes(b));
  if (hit.length) problems.push(`出现星神/令使相关词：${hit.join('、')}`);

  // 5) 篇幅
  const [lo, hi] = WORD_RANGE[e.rarity] || [40, 200];
  if (chars < lo || chars > hi) warns.push(`正文 ${chars} 字，超出同星级常见区间 ${lo}–${hi}`);

  // 6) 机制语言
  if (!/%|点/.test(text)) warns.push('无百分比/数值表达，机制感偏弱');

  counts[e.topic] = (counts[e.topic] || 0) + 1;
  if (problems.length) fail++;
  rows.push({ e, chars, used: [...new Set(used)], problems, warns });
}

// 7) 主题配比（生物类豁免单类上限：2026-09-30 用户口径，条数不设上限）
const BIO_TOPIC = '生物·物种/衍生体';
const ratioProblems = [];
for (const t of TOPICS) {
  const n = counts[t] || 0;
  if (n === 0) ratioProblems.push(`类别 ${t} 为 0 条（软约束：不许空类）`);
  if (n > 2 && t !== BIO_TOPIC && entries.length >= 5) ratioProblems.push(`类别 ${t} 有 ${n} 条，超过单类上限 2（软约束）`);
}
if (entries.some(e => !TOPICS.includes(e.topic))) ratioProblems.push('存在未归类的主题标签');

const L = [];
L.push('# 虚构差分方程 · 自检报告');
L.push('');
L.push(`- 候选文件：\`${path.basename(rawPath)}\``);
L.push(`- 条目：${entries.length} 条；重名比对基准：既有方程 ${official.length} 条`);
L.push(`- 合法符号集：既有 ${legalSymbols.size} 个方括号符号`);
L.push(`- 结果：${fail === 0 && ratioProblems.length === 0 ? '**全部通过**' : `**${fail} 条有 FAIL 级问题**`}`);
L.push('');
L.push('## 主题配比');
L.push('');
L.push('| 类别 | 条数 |');
L.push('| --- | --- |');
for (const t of TOPICS) L.push(`| ${t} | ${counts[t] || 0} |`);
L.push('');
L.push('## 逐条');
L.push('');
for (const r of rows) {
  L.push(`### ${r.e.name} · ${r.e.rarity} · ${r.e.pathPrimary}/${r.e.pathSecondary} · 〔${r.e.topic}〕`);
  L.push('');
  L.push(`- 配方：${String(r.e.blessing).split('\n').filter(Boolean).join(' + ')}`);
  L.push(`- 正文 ${r.chars} 字；使用符号：${r.used.length ? r.used.join('、') : '（无）'}`);
  L.push(`- FAIL：${r.problems.length ? r.problems.join('；') : '无'}`);
  L.push(`- 提示：${r.warns.length ? r.warns.join('；') : '无'}`);
  L.push('');
}
if (ratioProblems.length) {
  L.push('## 配比问题');
  L.push('');
  for (const p of ratioProblems) L.push(`- FAIL：${p}`);
  L.push('');
}

const outPath = path.join(probeDir, 'fiction-demo-check.md');
fs.writeFileSync(outPath, L.join('\n'), 'utf8');
console.log(L.slice(0, 16).join('\n'));
if (ratioProblems.length) console.log('配比问题: ' + ratioProblems.join('；'));
console.log('报告: ' + outPath);
process.exit(fail === 0 && ratioProblems.length === 0 ? 0 : 1);

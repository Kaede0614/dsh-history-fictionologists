/**
 * The 12-dataset registry (BRIEF §2/§3). Fixed order, fixed ids.
 *
 * `kind` describes how the page is structured, which decides which extractor
 * family runs:
 *   - `table`    : one `id="CardSelectTr"` table of `<tr class="divsort" data-param*>`
 *   - `cards`    : a grid of `<div class="divsort" data-param*>` cards (no table rows)
 *   - `sections` : `<h2>`/`<h3>` sections
 *   - `tabs`     : `resp-tab-content` tab panels inside one `<h2>` section
 *   - `page`     : the whole rendered page
 *
 * `needsWikitext` marks datasets whose content lives on per-item detail pages
 * that are fetched with `action=query&prop=revisions` (BRIEF §3.1 method 2).
 *
 * @module dsh-history-fictionologists/lib/wiki/datasets
 */
import { PAGE_BASE } from './client.mjs'

/** Wiki page URL as stored in the cache record (BRIEF §4 uses the raw title). */
const pageUrl = (title) => `${PAGE_BASE}${title}`

/**
 * @typedef {object} DatasetSpec
 * @property {string} id        stable dataset id used for `<id>.json` and tool args
 * @property {string} title     wiki page title
 * @property {string} url       human-readable page URL
 * @property {'table'|'cards'|'sections'|'tabs'|'page'} kind
 * @property {string} notes     what is extracted and which filter applies
 * @property {string} extractor exported extractor name in `extract.mjs`
 * @property {boolean} [needsWikitext] detail pages must be fetched as wikitext
 * @property {string} [fixture] offline HTML fixture inside `_probe/html/`
 */

/** @type {DatasetSpec[]} */
export const DATASETS = [
  {
    id: 'relics',
    title: '遗器图鉴',
    url: pageUrl('遗器图鉴'),
    kind: 'cards',
    extractor: 'extractRelics',
    needsWikitext: true,
    fixture: '遗器图鉴.html',
    notes:
      '卡片 div.divsort（列表页没有表格行）：data-param1=类别 data-param2=获取方式 data-param3=版本。' +
      '名称必须取 relicset-name 内的 <a title>（新套装的卡片里第一个 <a> 指向不存在的 特殊:上传文件）。' +
      '详情 = {{遗器套装}} 的 6 个 *故事 字段（隧洞 头部/手部/躯干/脚部，位面 位面球/连结绳）；空故事保留条目并标记 empty。',
  },
  {
    id: 'lightcones',
    title: '光锥图鉴',
    url: pageUrl('光锥图鉴'),
    kind: 'cards',
    extractor: 'extractLightcones',
    needsWikitext: true,
    fixture: '光锥图鉴.html',
    notes:
      '卡片 div.divsort：data-param1=稀有度 data-param2=命途 data-param3=获取方式 data-param4=版本。' +
      '名称取 weapon-name 内的 <a title>；详情 = {{光锥图鉴}} 的 光锥故事（含 <br> 与 <i> 引文）。',
  },
  {
    id: 'consumables',
    title: '消耗品筛选',
    url: pageUrl('消耗品筛选'),
    kind: 'table',
    extractor: 'extractConsumables',
    fixture: '消耗品筛选.html',
    notes:
      'CardSelectTr 表格：列 [1]名称 [3]所属地区 [4]TAG [5]获取途径 [6]说明(介绍) [7]所需材料；' +
      'data-param1=稀有度 data-param2=类型 data-param3=获取方式 data-param4=所属地区 data-param5=版本。' +
      '过滤：[3] 单元格文本 === 翁法罗斯。',
  },
  {
    id: 'decorations',
    title: '装饰一览',
    url: pageUrl('装饰一览'),
    kind: 'table',
    extractor: 'extractDecorations',
    fixture: '装饰一览.html',
    notes:
      'CardSelectTr 表格：列 [1]名称 [3]类型 [4]获取方式 [5]说明 [6]介绍 [7]版本；' +
      'data-param1=稀有度 data-param2=类型 data-param3=获取方式 data-param4=版本。无过滤。',
  },
  {
    id: 'aeons',
    title: '星神',
    url: pageUrl('星神'),
    kind: 'sections',
    extractor: 'extractAeons',
    fixture: '星神.html',
    notes:
      'h2 章节（标题形如「开拓」，阿基维利），内容在 table.wikitable 内；' +
      '排除 目录 / 星神总览 / 参考资料，空内容章节丢弃。path/aeon 由 「」 与 ， 切分。',
  },
  {
    id: 'factions',
    title: '派系',
    url: pageUrl('派系'),
    kind: 'sections',
    extractor: 'extractFactions',
    fixture: '派系.html',
    notes:
      'h2 = 命途、h3 = 派系；内容由 <p> 与 table.wikitable 组成（<big><b>简介</b></big> 为小节标签）。' +
      '排除 目录 / 派系总览 / 参考链接；h2 自身也作为条目（path = 自己）。',
  },
  {
    id: 'terms',
    title: '专有名词',
    url: pageUrl('专有名词'),
    kind: 'sections',
    extractor: 'extractTerms',
    fixture: '专有名词.html',
    notes:
      'h2 = 分类（名词/地名/人物/科技/年表/学说/现象/物体）、h3 = 词条，内容在 table.wikitable 内；' +
      '排除 目录。category = 最近的上级 h2。',
  },
  {
    id: 'simuniverse',
    title: '模拟宇宙',
    url: pageUrl('模拟宇宙'),
    kind: 'tabs',
    extractor: 'extractSimuniverse',
    fixture: '模拟宇宙.html',
    notes:
      '先定位 h2「模拟宇宙图鉴」区间（到下一个 h2 为止），在其中收集所有 div.resp-tab-content（h3 星神 小节）；' +
      '每个标签页按 <hr /> 切段，每段 = 一条 开发日志N（path 取段内 关联条目-「X」）。绝不整页 indexOf 猜章节。',
  },
  {
    id: 'curios',
    title: '奇物一览（差分）',
    url: pageUrl('奇物一览（差分）'),
    kind: 'table',
    extractor: 'extractCurios',
    fixture: '奇物一览_差分_.html',
    notes:
      'CardSelectTr 表格：列 [1]名称 [2]模式 [3]TAG [4]获取方式 [5]效果 [6]版本；' +
      'data-param1=模式 data-param2=TAG data-param3=获取 data-param4=标签 data-param5=版本 data-param6=星级。无过滤。',
  },
  {
    id: 'events',
    title: '事件一览',
    url: pageUrl('事件一览'),
    kind: 'table',
    extractor: 'extractEvents',
    fixture: '事件一览.html',
    notes:
      'CardSelectTr 表格：列 [1]事件名 [3]选项 [4]版本；data-param1=模式 data-param2=类型 data-param3=版本。' +
      '过滤：模式包含 千面英雄（多模式行写作 "千面英雄, 乐园漫记"，用 includes 判断）。',
  },
  {
    id: 'equations',
    title: '方程一览',
    url: pageUrl('方程一览'),
    kind: 'table',
    extractor: 'extractEquations',
    fixture: '方程一览.html',
    notes:
      'CardSelectTr 表格：列 [1]名称 [2]模式 [3]需要祝福 [4]效果 [5]版本；' +
      'data-param1=稀有度 data-param2=主要命途 data-param3=次要命途 data-param4=实装版本 data-param5=模式。' +
      '过滤：模式包含 千面英雄。',
  },
  {
    id: 'broadcast',
    title: '星际和平播报',
    url: pageUrl('星际和平播报'),
    kind: 'page',
    extractor: 'extractBroadcast',
    fixture: '星际和平播报.html',
    notes:
      '整页文本（条目 全文 + 每个 h4 章节一条）；必须保留 女声/男声/（音乐） 等原始播报格式，不做语气清洗。',
  },
]

/** Ids in registry order. */
export const DATASET_IDS = DATASETS.map((dataset) => dataset.id)

/** @param {string} id */
export function getDataset(id) {
  return DATASETS.find((dataset) => dataset.id === id) ?? null
}

/**
 * Canonical id for `id`, accepting the singular alias of every plural id
 * (`equation` → `equations`). The tool layer advertises singular ids in one
 * place and plural ids in another; accepting both keeps `/gs` working instead
 * of failing an exact-match lookup.
 *
 * @param {string} id
 * @returns {string|null}
 */
export function resolveDatasetId(id) {
  if (typeof id !== 'string') return null
  const key = id.trim().toLowerCase()
  if (key.length === 0) return null
  const alias = DATASET_ALIASES[key]
  return alias ?? null
}

/** `equations` → `equation` alias, plus the canonical id itself. */
const DATASET_ALIASES = (() => {
  const map = {}
  for (const dataset of DATASETS) {
    map[dataset.id.toLowerCase()] = dataset.id
    if (dataset.id.endsWith('s')) map[dataset.id.slice(0, -1).toLowerCase()] = dataset.id
  }
  return map
})()

/** Ids the registry does not know (accepts singular aliases). */
export function unknownDatasetIds(ids) {
  const list = Array.isArray(ids) ? ids : [ids]
  return list.filter((id) => resolveDatasetId(id) === null)
}

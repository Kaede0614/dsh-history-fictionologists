# dsh-history-fictionologists · 实现规格（BRIEF）

> **勘误（2026-09-26，实现完成后回填）** —— 本文件是写作期的规划规格，有若干处与实际
> 落地不一致。**以代码与 `docs/DESIGN.md` 为准**：
>
> 1. **§1 把外壳钉在 `lib/index.js`** —— 实际入口是 **`lib/shell.js`**（`package.json` 的
>    `main`）。原因：一次机械回写把 `lib/index.js` 写成了非 UTF-8（201 个 U+FFFD），
>    文件系统观察策略正确地拒绝覆写一个读不出来的路径，安全修复是换文件名并让
>    `main`/`exports` 指过去。§7.1 里的行号引用因此全部失效，请以 `lib/shell.js` 为准。
> 2. **§1 注 `cordis.patch.yml # 不需要` 是错的** —— 它是 bundle 清单，`package.json` 的
>    `dsh.bundle.patch` 指向它，官方 `dsh-plugin-dev check` 把它当必需项。
> 3. **§7.5 要求 section order = 4500** —— 实现用 3050（落在 `TOOL_COMPUTER_USE = 3000` 与
>    `MCP_SERVERS = 3100` 之间的空档，语义上更贴「工具文档之后」），代码里有注释说明。
> 4. **§7.4 的返回键集合不完整** —— 实现另含 `ok`/`workspace`/`ageDays`/`recentGuardDays`/
>    `missions`（`gs_setup`）与 `ok`/`counts`（`gs_update`）。
> 5. **§5 的路径优先级不完整** —— 实际还包含「从 cwd 向上走」与 `packageRoot()` 兜底，
>    见 `lib/paths.js`。
> 6. **§9 的 DoD 缺了最关键的一条** —— 必须用**宿主自己的** `validateJsonSchemaValue` 校验
>    工具返回值。正是因为它缺席，`gs_setup` 返回的 `lastUpdated: null` 才一路活到真机才炸；
>    现已补为 `test/host-validator.test.mjs`（并用元测试证明该断言能失败）。
> 7. **§3.3 若干实测数字偏大**（探针在第一个 `</table>` 处被截断所致）：奇物实际 251 条
>    （不是 298 行 / 71 条）、事件实际 54 条（不是 86）、派系 48 条、专有名词 47 条、
>    方程 212 条。逐条更正与证据见 `docs/DESIGN.md`。
>
> 保留原文不改，是为了让「规划 vs 实测」的差异本身成为证据。

> 本文件是**唯一事实来源**。所有实现细节以本文件为准；本文件所有结论都已经过真实抓取验证
> （验证脚本与原始输出在 `_probe/`）。凡与猜测冲突，以本文件为准。不要凭记忆编造 wiki 结构。

## 0. 目标与坐标

- 插件包目录 = 工作区根 = `C:\Users\masha\Desktop\hsr-history-fictionologists`
- 插件名 `dsh-history-fictionologists`，触发命令 `/gs`
- 运行宿主：DSH 0.1.7-rc.2（`C:\Users\masha\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）
- profile：`C:\Users\masha\.dsh\profiles\web`（已存在指向本目录的 junction `node_modules\dsh-history-fictionologists`）
- 纯 ESM，Node 24（宿主 Node 支持 `fetch`、`node:test`、`import.meta.dirname`）
- **零运行时第三方依赖**（node-html-parser 等一律不用；自己写正则解析）
- 只有 `.mjs` / `.js`（ESM），不引入 TypeScript 构建步骤

## 1. 目录与文件所有权（严格遵守，避免并写冲突）

```
<root>/
  package.json                     # 由队长编写
  cordis.patch.yml                 # 不需要（bundle 清单方式）
  lib/
    resolve.js                     # 队长：多 base 可选依赖解析链
    paths.js                       # 队长：工作区/缓存/输出路径解析
    wiki/
      datasets.mjs                 # 数据源登记表（12 个）—— 见 §3
      client.mjs                   # HTTP 客户端（限流/重试/UA）
      html.mjs                     # 通用 HTML 工具
      wikitext.mjs                 # wikitext 模板工具
      extract.mjs                  # 12 个抽取器本体
      cache.mjs                    # 缓存读写 + 增量更新
      index.mjs                    # 对外 API：status / update / read / sample
    missions.js                    # hsr-missions 读取与索引
    digest.js                      # 素材摘要/去重集合构建
    index.js                       # 插件外壳：/gs 命令 + 工具 + 提示词
  test/                            # node:test
  README.md  CHANGELOG.md
```

**不要把 `_probe/` 删掉或改动**，它是证据目录。

## 2. 数据源清单（用户指定 12 项，编号固定）

| id | 页面标题 | 抓取内容 | 过滤 |
|---|---|---|---|
| `relics` | 遗器图鉴 | 每套遗器「遗器来历」（各部位 `*故事`） | — |
| `lightcones` | 光锥图鉴 | 每个光锥的「光锥故事」 | — |
| `consumables` | 消耗品筛选 | 每个消耗品的「介绍」 | 排除所属地区=翁法罗斯 |
| `decorations` | 装饰一览 | 每个装饰的「介绍」 | — |
| `aeons` | 星神 | 每个星神的介绍 | — |
| `factions` | 派系 | 每个派系的内容 | — |
| `terms` | 专有名词 | 每个专有名词的内容 | — |
| `simuniverse` | 模拟宇宙 | 「模拟宇宙图鉴」下「星神」小节的开发日志 | — |
| `curios` | 奇物一览（差分） | 每个奇物的介绍/效果 | — |
| `events` | 事件一览 | 每个事件的内容 | 排除模式含「千面英雄」 |
| `equations` | 方程一览 | 每个方程的内容（效果全文） | 排除模式含「千面英雄」 |
| `broadcast` | 星际和平播报 | 全部内容 | — |

## 3. 已实测的抓取事实（**必须按此实现**）

### 3.1 HTTP 客户端

- 端点：`https://wiki.biligame.com/sr/api.php`（MediaWiki 1.37 + SMW）
- UA 必须是浏览器 UA（用 §附录 A 的常量）
- 必须带 `referer: https://wiki.biligame.com/sr/`
- **WAF 会拦频率**：实测连续 12 次无间隔请求 → 后 6 次返回 `status 567` + 一份内联 CSS 的
  HTML 错误页（**不是 JSON**）。
- 应对：①相邻请求间隔 ≥ 1500ms（默认 2000ms，可配置）；②非 JSON 响应或 5xx/567 →
  指数退避重试（4s/8s/16s，最多 3 次重试）；③重试仍失败 → **返回 null 并标记失败，
  由上层回退到缓存**，绝不能抛到 unhandled。
- 请求不要带 `x-requested-with`（实测成功与失败都出现过；不要引入变量，只用 UA+referer+accept+accept-language）。
- 超时：单请求 30s，用 `AbortSignal.timeout`。

**两种取数方式**（都实测可用）：

1. **渲染 HTML**（列表页用）：`?action=parse&page=<标题>&prop=text&format=json&formatversion=2&disablelimitreport=1&disableeditsection=1`
   → `json.parse.text`（字符串 HTML）。
2. **原始 wikitext 批量取**（详情页用）：`?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=A|B|C`
   → `json.query.pages[].revisions[0].slots.main.content`；**一次最多 50 个标题**（实测 4 个标题 145ms，HTTP 200）。
   `titles` 用 `encodeURIComponent(titles.join('|'))`。
   `missing===true` 表示页面不存在。

### 3.2 HTML 解析工具（通用）

- **表格切分**：按 `<table`/`</table>` 配对取整表（处理嵌套）。
- **行切分**：`table.split(/(?=<tr[\s>])/i)`（**注意：绝不能用 `split(/<tr[^>]*>/)`，
  那会丢掉 `data-param*` 属性——这是已踩过的坑**）。首元素是表头/前缀，用 `slice(1)` 丢弃。
- **单元格切分**：`row.split(/(?=<t[dh][\s>])/i)`，首元素是 `<tr ...>`，用 `slice(1)` 丢弃。
- **行属性**：`/<tr[^>]*>/.exec(row)[0]`，再取 `data-param1..N`。
- **文本清洗**：
  1. 先删掉 `<div style="display:none;">…</div>`（SMW 提示浮层，会污染正文）
  2. `<br\s*/?>` → `\n`
  3. 其余标签删掉；`&#160;`/`&nbsp;` → 空格
  4. HTML 实体解码（至少 `&amp; &lt; &gt; &quot; &#39;`）
  5. 压缩连续空白（但保留单个 `\n`）
- **名称提取优先级**：单元格内 `<a title="…">` 的 title > `class="equation-title"`/`relicset-name`/`weapon-name` 内的文本 > 纯文本。

### 3.3 各数据集的精确选择器

#### `equations`（方程一览）— 已实测：325 行，324 条数据行
- 表：含 `id="CardSelectTr"`；数据行 = `<tr class="divsort" data-param1..5>`；`data-param5` = 模式。
- 列：`[0]`图标 `[1]`名称 `[2]`模式 `[3]`需要祝福 `[4]`效果（**这就是「内容」**）`[5]`版本。
- 行属性：`data-param1`=稀有度(`3星`/`2星`/`1星`/`4星`) `data-param2`=主要命途 `data-param3`=次要命途
  `data-param4`=实装版本 `data-param5`=模式。
- 模式取值：`人间喜剧` / `千面英雄` / `乐园漫记`（实测行数 108 / 112 / 104）。
- 过滤：`data-param5` 或 `[2]` 单元格包含 `千面英雄` → 排除。
- 输出条目：`{ name, rarity, pathPrimary, pathSecondary, mode, blessing, content, version }`
  （`blessing`=`[3]`、`content`=`[4]`）。

#### `events`（事件一览）— 已实测 204 行
- 表含 `id="CardSelectTr"`；行属性 `class="divsort"` + `data-param1`=模式 `data-param2`=类型 `data-param3`=版本。
- 列：`[0]`图标 `[1]`事件名 `[2]`模式 `[3]`选项（含选项文本+后果） `[4]`版本。
- 过滤：**模式包含 `千面英雄` → 排除**（实测 118 行含千面英雄；多模式行写作
  `data-param1="千面英雄, 乐园漫记"`，单元格文本是 `千面英雄乐园漫记`，用 `includes` 判断即可）。
- 输出条目：`{ name, mode, type, options, version }`。

#### `curios`（奇物一览（差分））— 已实测 298 行，71+ 数据行
- 行属性 `data-param1`=模式 `data-param2`=TAG/类型 `data-param3`=获取 `data-param4`=标签
  `data-param5`=版本 `data-param6`=星级。
- 列：`[0]`图标 `[1]`名称 `[2]`模式 `[3]`TAG `[4]`获取方式 `[5]`效果（介绍）`[6]`版本。
- 输出条目：`{ name, mode, tag, star, acquire, content, version }`。

#### `consumables`（消耗品筛选）— 已实测 217 行
- 行属性 `data-param1`=稀有度 `data-param2`=类型 `data-param3`=获取方式 `data-param4`=**所属地区**
  `data-param5`=版本 `data-param6..8`=其他。
- 列：`[0]`图标 `[1]`名称 `[2]`稀有度 `[3]`所属地区 `[4]`TAG `[5]`获取途径 **`[6]`说明(介绍)** `[7]`所需材料。
- **过滤：`[3]` 单元格文本 === `翁法罗斯` → 排除**（实测 24 行）。
- 输出条目：`{ name, rarity, region, tag, acquire, content, version }`（`content`=`[6]`）。

#### `decorations`（装饰一览）— 已实测 251 行
- 行属性 `data-param1`=稀有度 `data-param2`=类型 `data-param3`=获取方式 `data-param4`=版本。
- 列：`[0]`图标 `[1]`名称 `[2]`稀有度 `[3]`类型 `[4]`获取方式 `[5]`说明 **`[6]`介绍** `[7]`版本。
- 输出条目：`{ name, rarity, type, acquire, effect, content, version }`（`content`=`[6]`）。

#### `relics`（遗器图鉴）— 已实测 62 个套装卡
- 列表页**没有表格数据行**，卡片是 `<div class="divsort" data-param0..3>`：
  `data-param1`=类别（`隧洞遗器`/`位面饰品`）`data-param2`=获取方式 `data-param3`=版本。
- 名称在 `<div class="relicset-name"><a title="…">名称</a></div>`。
- 注意：新版套装的卡片图标链接可能指向 `index.php?title=特殊:上传文件...`（文件不存在），
  **名称必须优先取 `relicset-name` 内的 `<a title>`，不能取卡片内第一个 `<a>`**。
- 详情：`action=query` 批量取套装页 wikitext，模板 `{{遗器套装|…}}`，字段：
  `名称 / 类别 / 两件套效果 / 四件套效果 / 获取方式 / 获取途径 / 实装版本 / 头部 / 手部 / 躯干 / 脚部 /
  头部描述 头部故事 手部描述 手部故事 躯干描述 躯干故事 脚部描述 脚部故事 /
  位面球 连结绳 位面球描述 位面球故事 连结绳描述 连结绳故事`
- **「遗器来历」= 6 个 `*故事` 字段**（`<br>`→换行；`<i>` 内是引文，可保留为普通文本）。
  空字段直接跳过。**实测**：`戍卫风雪的铁卫` 6 个故事齐全；
  `盗贼公国塔利亚`（位面饰品）用 `位面球/连结绳`+`位面球故事/连结绳故事`；
  部分新套装（如 `戏梦点星的伶人`）故事字段为空 → 该套装仍保留条目但 `content` 为空，
  此时**不要**报错，`entries` 里保留并标记 `empty: true`。
- 输出条目：`{ name, category, version, parts: [{ slot, name, description, story }] }`，
  另给出便于阅读的 `content` = 各部位 `story` 拼接（带部位名小标题）。

#### `lightcones`（光锥图鉴）— 已实测 169 个卡片
- 卡片 `<div class="divsort" data-param0..4>`：`data-param1`=稀有度 `data-param2`=命途
  `data-param3`=获取方式（如 `限定跃迁`）`data-param4`=版本。
- 名称在 `<div class="weapon-name"><a title="…">名称</a></div>`。
- 详情：批量 wikitext，模板 `{{光锥图鉴|…}}`，取字段 **`光锥故事`**（以及 `命途`/`稀有度`/`实装版本`）。
  **实测**：`向浪花掷下盛夏` 的 `光锥故事` 是完整故事（含 `<br>` 与 `<i>` 引文）。
- 输出条目：`{ name, rarity, path, acquire, content, version }`。

#### `aeons`（星神）— 已实测 18 个 h2 章节
- 章节标题形如 `「开拓」，阿基维利`（h2 内 `<span class="mw-headline" id="…">`）。
- 抓取范围：`h2` 到下一个 `h2` 之间的内容；**排除** 目录、`星神总览`、`参考资料` 三个章节。
- 章节内容是 `<table class="wikitable">`（1~3 行：简介 / 引文+正文 / 关联条目）。
- 输出条目：`{ name: '「开拓」，阿基维利', path: '开拓', aeon: '阿基维利', content }`。
  `path`/`aeon` 从标题按 `「」` 与 `，` 切分；切不开就整串放 `content` 标题即可。
- 过滤掉 content 为空的章节。

#### `factions`（派系）— 已实测 54 个 h2/h3 章节
- h2 = 命途（开拓/巡猎/虚无/丰饶/毁灭/同谐/智识/存护/繁育/记忆/欢愉/纯美/神秘/均衡/秩序/终末），
  h3 = 派系（无名客/仙舟联盟/假面愚者/虚构史学家/…）。
- **需要名称提取**：章节内容由 `<p>` 与 `<table class="wikitable">` 组成，
  其中 `<big><b>简介</b></big>` / `<big><b>智库</b></big>` 是小节标签。
- 输出条目：`{ name, path, content }`（`path` = 所属 h2 命途，来自最近的上级 h2；h2 自身也可作为条目）。
- 排除 目录/派系总览/参考链接 章节。

#### `terms`（专有名词）— 已实测 48 个 h2/h3 章节
- h2 分类：`名词 / 地名 / 人物 / 科技 / 年表 / 学说 / 现象 / 物体`；h3 是词条。
- 输出条目：`{ name, category, content }`（`category` = 最近的上级 h2）。
- 排除 目录 章节。

#### `simuniverse`（模拟宇宙）
- 取「模拟宇宙图鉴 → 星神」小节里的**开发日志**。
- 实测：`开发日志` 文本在渲染 HTML 的 `<div class="resp-tab-content">` 内，
  结构为 `<p>开发日志N<br /><b>关联条目-「存护」</b><br />……正文……</p>` 用 `<hr />` 分隔。
- 定位方式：找 `<h2>` 里含 `模拟宇宙图鉴` 的位置 → 到下一个 `<h2>` 结束；
  在其中找含 `开发日志` 的片段。**不要用 `indexOf('开发日志')` 去猜章节**，
  必须在该区间内收集所有 `resp-tab-content` div。
- 输出条目：`{ name: '开发日志 · <命途/星神>' , path, index, content }`，
  即每个 `开发日志N` 一段；`path` 从同段内的 `关联条目-「X」` 提取。
- 保底：如果区间内一条都没抽到，退化为收集整页里的 `开发日志\d` 段落。

#### `broadcast`（星际和平播报）— 已实测 16.8KB 渲染 HTML
- 整页内容，按 h4 章节（如 `完成雅利洛-Ⅵ开拓任务`）与段落组织。
- 输出条目：`{ name: <h4 标题 or '全文'>, content }` —— 每段一条；同时顶层保留 `raw` 全文文本。
- 这是「格式与语调」样例，必须把**原始模板格式**（`女声：`/`男声：`/`（音乐）`）保留下来。
  实测文本里含有 `女声`/`男声` 说话人标签，不要清洗掉。

## 4. 缓存契约（硬要求）

- 目录：`<workspace>/hsr-worldview-cache/`（工作区解析见 §5）
- 每个数据集一个文件：`<id>.json`（如 `equations.json`、`aeons.json`），另有 `index.json`。
- 文件结构：
  ```json
  {
    "dataset": "equations",
    "title": "方程一览",
    "url": "https://wiki.biligame.com/sr/方程一览",
    "lastUpdated": "2026-09-26T02:00:00.000Z",
    "revisionId": 12345,
    "pageSha": "<抓取到的原始 HTML 的 sha256 前 16 位>",
    "count": 216,
    "excludedCount": 112,
    "entries": [ … ],
    "warnings": ["…"]
  }
  ```
- `index.json`：`{ schema, generatedAt, datasets: { <id>: { lastUpdated, count, revisionId, pageSha, ok, error? } } }`
- **增量更新**：先用 `action=query&prop=revisions&rvprop=ids|timestamp&titles=<页面>` 取最新
  `revid`；与缓存 `revisionId` 相同 → 跳过（不改写文件、不计入 changed）。
  不同或无缓存 → 重新抓取解析并原子写（先写 `.tmp` 再 `rename`）。
- `lastUpdated` 为本次成功更新的时间（跳过时保留原值）。
- 抓取/解析失败：保留旧缓存，在 `index.json` 里记 `ok:false, error`，并把该数据集列入返回值
  `failed[]`；**绝不能把缓存清空或写成半成品**。
- 任何情况下 `read`/`status` 都必须在缓存目录还不存在时正常工作（返回空状态）。

## 5. 工作区与路径解析（`lib/paths.js`）

优先级（依次尝试，取第一个存在的）：
1. 环境变量 `DSH_HISTORY_FICTIONOLOGISTS_WORKSPACE`
2. `process.env.DSH_WORKSPACE`
3. `process.cwd()`（若其下存在 `hsr-missions` 或 `hsr-worldview-cache`）
4. 从 `import.meta.url` 向上最多 4 级找含 `hsr-missions` 的目录
5. 兜底 `process.cwd()`

导出：
- `resolveWorkspace(cfg?)` → 绝对路径
- `missionsDir(ws)` → `<ws>/hsr-missions`
- `cacheDir(ws)` → `<ws>/hsr-worldview-cache`
- `storiesDir(ws)` → `<ws>/hsr-stories`
- `broadcastsDir(ws)` → `<ws>/hsr-broadcasts`
- 所有函数必须保证目录存在时才使用；写入前 `mkdir -p`。

## 6. hsr-missions 既有故事（`lib/missions.js`）

工作区实测结构：

- `<ws>/hsr-missions/sr-开拓续闻-完整/index.json` → 7 个系列（52 个任务）
- 每个系列目录：`_index.json` + `01_任务名.json` … 单任务 JSON 字段见其 README：
  `系列任务/任务编号/任务名称/页面标题/任务地区/所属版本/任务描述/出场人物/剧情内容[{章节,文本}]/剧情wiki原文`
- `<ws>/hsr-missions/trailblaze_missions.json`（14MB）：
  `{ source, generated, excluded_acts[], stats{acts,series,missions}, acts:[{act, series:[{series, description, missions:[{name, meta{…}, description, objectives[], summary[], story[]}]}]}] }`
  （**非常大：绝不要整体 `JSON.parse` 后返回给模型**）
- `<ws>/hsr-missions/adventure_other_tasks_full.json`：
  `{ chapters:[{chapter, sectionAnchor, taskCount, tasks:[{name, page, url, meta{…}, contentChars, content}]}] }`
- `<ws>/hsr-missions/books_without_amphoreus.json`（498 本书，**书架**）：
  数组，元素 `{ title, 编号, 所属, 所属名称, 类型, 描述, 相关角色, 卷数, 实装版本, url, 分卷:[{名称,卷数,获取方式,内容}], 模板 }`

`missions.js` 必须导出：

- `scanMissions(ws)` → `{ root, series: [{ name, region, version, missions: [{ name, file }] }], counts, warnings }`
  （只读 `sr-开拓续闻-完整/index.json` 与各系列 `_index.json`，不读大文件）
- `catalogTrailblaze(ws, { limit })` → 从 `trailblaze_missions.json` **流式/分块**抽取
  `{ acts: [{ act, series: [{ series, region?, missions: [{ name, description, characters }] }] }] }`
  —— 用 `fs.readFile` 后 `JSON.parse` 允许（14MB 可解析），但**只返回精简字段**，
  且必须支持 `act` 过滤与 `limit`（默认返回全部 act 名 + 每个 act 前 40 个任务名，
  避免把 147 个任务的 summary 全塞进模型上下文）。
- `catalogBooks(ws)` → `{ count, books: [{ title, 类型, 所属名称, 描述, 相关角色 }] }`（**不含正文**）
- `booksByTitle(ws, titles)` → 指定书的正文（`分卷[].内容`），用于「参考书架风格」
- `loadSeries(ws, seriesName)` → 该系列全部任务的精简视图（名称+描述+出场人物+章节标题，
  **不含完整台词**），用于避让冲突
- 所有函数在文件缺失时返回 `{ ok: false, warnings: [...] }` 形态，不得抛异常

## 7. 插件外壳（`lib/index.js`）

### 7.1 契约

- `export const name = 'dsh-history-fictionologists'`
- `export const inject = ['commands', 'tools', 'systemPrompt']`（若 systemPrompt 可选则用 `ctx.inject`）
- `export const Config`（Schemastery，走 `lib/resolve.js` 解析链；**解析不到就 `export const Config = undefined`，
  绝不导出普通对象**）
- `export function apply(ctx, config)`

### 7.2 Config 字段（都可从 cordis.yml 覆盖）

| 字段 | 默认 | 说明 |
|---|---|---|
| `workspace` | `''` | 空 = 自动解析 |
| `requestIntervalMs` | `2000` | 相邻 wiki 请求最小间隔 |
| `requestTimeoutMs` | `30000` | 单请求超时 |
| `maxRetries` | `3` | WAF/网络失败重试次数 |
| `staleAfterDays` | `7` | 超过该天数才**建议**用户重新抓取 |
| `recentGuardDays` | `7` | 距上次更新不足该天数时，即使用户选 Y 也提示一句确认 |
| `defaultStoryWords` | `2000` | 构史文集默认字数 |
| `defaultBroadcastWords` | `1000` | 播报默认字数（要求区间 800–1200） |
| `inspirationCount` | `4` | 神人制造机默认灵感条数（要求 3–5） |
| `saveOutputs` | `true` | 是否把成品落到 `hsr-stories/` / `hsr-broadcasts/` |
| `userAgent` | 见附录 A | 允许覆盖 |

### 7.3 `/gs` 命令（`ctx.commands.register`）

- `name: 'gs'`，`description: '虚构史学家：生成星穹铁道世界观灵感 / 短篇 / 星际和平播报'`
- `input: { hint: '[灵感主题，可留空]', attachments: false }`
- `definitionId`：用 `lib/resolve.js` 拿 `@deepseek-ai/dsh-commands` 的 `CommandDefinitionId`；
  拿不到就不传该字段（可选字段）。
- handler 行为（**本地、无模型**）：
  1. `rawInput.trim()` 保留为「用户附带主题」，可为空；
  2. 读取缓存状态（`wiki.index.status()`）与 missions 概况（容错）；
  3. `invocation.agent.followup(createUserMessage({ content:[{type:'text',text}], source:{kind:'plugin',plugin:'dsh-history-fictionologists'} }))`
     —— `createUserMessage` 从 `@deepseek-ai/dsh-llm` 经解析链拿；**拿不到就降级为只返回
     `{kind:'success', text}`，不 followup**（并说明）。
  4. 返回 `{ kind: 'success', text: <给用户看的简短说明> }`。
  5. 注入文本必须包含：本插件定位、三步交互协议（第 1 步功能选择 / 第 2 步数据更新策略 /
     第 3 步执行）、当前缓存状态（各数据集条目数 + lastUpdated + 是否过期）、
     要求用 `ask_user_question` 弹出选项、以及「必须调用 gs_* 工具取数据，不得凭空编造设定」。
- **必须**：handler 内任何异常都转成 `{kind:'error'|'success', text}`，不能抛。

### 7.4 模型工具（`ctx.tools.register(defineTool(...))`，名字前缀 `gs_`）

所有 `output.schema` 必须是**显式 `additionalProperties`** 的对象；**嵌套 `undefined` 会被宿主拒绝**
（要么不放该键，要么放 `null`）。`parameters` 是内联 DSL（`{ type, required, description }`）。

1. `gs_setup`
   - 参数：无
   - 语义：第 2 步的数据源策略。返回 `{ cacheDir, hasCache, lastUpdated, stale, staleAfterDays, datasets:[{id,title,count,lastUpdated,ok}], recommendation:'update'|'use-cache', advice }`
   - `recommendation` 规则：无缓存 → `update`；全部数据集的 `lastUpdated` 都新于 `staleAfterDays` → `use-cache`；否则 `update`。
2. `gs_update`
   - 参数：`datasets?: string[]`（省略=全部）、`force?: boolean`（忽略 revid 短路，默认 false）
   - 语义：增量抓取；返回 `{ updated:[ids], skipped:[ids], failed:[{id,error}], durationMs, cacheDir, lastUpdated }`
   - 语义要求：任一数据集失败不得让整体失败；返回里明确 `failed`。
   - 注入模型可见结果时说明「更新失败，已使用缓存数据」由模型告知用户（render 里给出提示）。
3. `gs_read`
   - 参数：`dataset: string`（必填）、`query?: string`（关键词过滤 name/content）、
     `limit?: number`（默认 20，上限 50）、`offset?: number`
   - 返回 `{ dataset, title, count, total, matched, offset, limit, entries:[{name, content, ...}] }`
   - 条目 `content` 单条超过 1500 字时截断并在条目里带 `truncated: true`（**不要用 undefined**）。
4. `gs_digest`
   - 参数：`kind: 'equations'|'mission-digest'|'book-digest'|'broadcast-template'`、`limit?`
   - 语义：给模型喂「命名逻辑 / 既有故事标题（避让）/ 书架风格 / 播报格式」的紧凑素材。
5. `gs_missions`
   - 参数：`series?: string`、`query?: string`、`limit?`
   - 语义：既有故事目录与指定系列的避让清单（人物、地点、事件线）。
6. `gs_save`
   - 参数：`kind: 'story'|'broadcast'|'inspiration'`（必填）、`title: string`（必填）、
     `content: string`（必填）、`meta?: object`
   - 语义：写入 `hsr-stories/` 或 `hsr-broadcasts/`（`inspiration` 写 `hsr-stories/inspirations/`），
     文件名 `<YYYYMMDD-HHmmss>-<安全标题>.md`，YAML front-matter 带 kind/title/createdAt/meta。
     返回 `{ saved: true, path, bytes }`。

### 7.5 系统提示词 section

- `ctx.systemPrompt.section({ name, order, text })`（具体 API 用 `lib/resolve.js` 探测；
  拿不到该服务就把整段文字并入 `/gs` 注入文本）。
- `order` 用 `getSectionOrder('TOOL_WEB_SEARCH')` 之类的既有常量不稳妥 → 直接用固定数字 4500 并注释说明。
- section 文本内容 = §8 的语言风格总则（可被模型长期看到，故要精炼）。

## 8. 语言风格总则（写进提示词）

- 核心参考「方程一览」：**用最严肃的格式包装最离谱的内容**。
- 把宏大哲学概念（记忆/虚无/欢愉/繁育/均衡/同谐…）与日常琐碎、荒诞离奇的具体意象嫁接。
- 荒诞感来自「认真对待荒诞」，不是「故意搞笑」；允许一本正经地胡说八道。
- 喜剧底色下可以带一点暗色，但不要沉闷；想象力优先，逻辑内部自洽即可。
- **星神纪律**（0.1.1 追加，三功能共同适用）：
  - 星神、令使与星神级存在不出场——只是背景、传闻、缺席、遗迹、别人的说法。
  - 命途归属只是气质标签，不是赐福；禁止「被星神选中 / 获得星神的力量」。
  - 已陨/失踪/消亡者（繁育·塔伊兹育罗斯、贪饕·奥博洛斯、秩序·太一、不朽·龙、
    纯美·伊德莉拉、开拓·阿基维利）绝不写成在世、现身或归来。
  - 神人自己才是主角：写他的职业、麻烦、账单、家人与出路。
- **用户设定补充优先于缓存**（0.2.0 追加）：`gs_read` 末尾的「用户设定补充」
  （`<工作区>/hsr-worldview-cache/user-canon.json`，独立文件、抓取不改写）是硬约束，
  与缓存文本冲突时以它为准；`gs_setup` 报告其条数。
- 三个功能的输出格式（**必须逐字按用户要求实现**）：

**功能 1 神人制造机**（3–5 条）：
```
【灵感名称】
命途归属：〈主命途〉/〈次命途〉
一句话简介：……
详细设定：……（约 100–200 字，须带荒诞感）
可能的故事方向：……
```

**功能 2 构史文集**：默认约 2000 字短篇（用户可指定），先读 hsr-missions 既有故事避免冲突，
参考「书架」书籍风格，荒诞但不轻浮，喜剧底色下可有一丝温情或哲思。

**功能 3 星际构史播报**：约 800–1200 字，3–5 条新闻，格式：
```
（音乐）

女声：这里是星际和平播报，观众朋友们晚上好。
男声：晚上好。

女声：第一条消息。……
男声：第二条消息。……

女声：本次播报到此结束，请在指定时间收听下一周期的星际和平播报。
（音乐）
```
**虚构文本要充满想象力，不要是对已有故事的重组，一定要足够科幻和太空。**

## 9. 验证要求（自证 DoD）

写完必须自己跑通并留原始输出（命令 + 输出写到 `_evidence/`）：

1. `node --check <每个 .js>`（语法）
2. `node -e "import('./lib/index.js').then(...)"` 从**部署位置**
   （`C:\Users\masha\.dsh\profiles\web\node_modules\dsh-history-fictionologists\lib\index.js`）导入成功，
   打印 `name`/`inject`/`typeof apply`/`Config != null`
3. `node test/run.mjs`（或 node:test）全绿
4. **真实抓取**：对真实 API 跑一次抽取，把每个数据集的条目数、首条样例（name + content 前 80 字）
   落到 `_evidence/live-extract.txt`。抽到的条数必须与 §3 实测数量级一致（±20% 之内，
   因为 wiki 会更新）。任何一个数据集为 0 条目都算失败，必须排查。
5. 缓存往返：抓取 → 写缓存 → 再 `status()` 看到 `lastUpdated` → 再 `update()` 应全部 `skipped`
   （证明 revid 短路生效）。

## 附录 A：常量

```js
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
export const API = 'https://wiki.biligame.com/sr/api.php'
export const PAGE_BASE = 'https://wiki.biligame.com/sr/'
```

## 附录 B：参考证据文件（只读）

- `_probe/dump.txt`、`_probe/dump2.txt`、`_probe/dump3.txt` —— 各页面真实 HTML 片段
- `_probe/wikitext.txt`、`_probe/wikitext2.txt` —— 真实 wikitext（遗器/光锥/消耗品/装饰/星神/派系/专有名词/模拟宇宙）
- `_probe/missions.txt` —— hsr-missions 三种 JSON 的真实结构
- `_probe/html/*.html` —— 12 个页面的完整渲染 HTML（可离线重放解析，**省流必用**）
- `_probe/fetch.mjs`（下载器，带限流重试）、`_probe/analyze.mjs`（结构普查）

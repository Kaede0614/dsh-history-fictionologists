# 数据源结构实测记录（DESIGN）

> 本文件记录 12 个 biligame Wiki 数据源**实测**到的页面结构，是 `lib/wiki/extract.mjs`
> 里每一条选择器的依据。凡本文件与代码不一致，以实测证据为准并同步修正。
>
> 实测方式：`action=parse&prop=text` 取渲染 HTML + `action=query&prop=revisions` 取批量
> wikitext，样本与原始输出留在 `_probe/`（`html/`、`dump*.txt`、`wikitext*.txt`）。
> **测试期观测值**（wiki 会持续更新，数字只用于判断数量级是否合理）：
> 方程 325 行 / 事件 204 行 / 奇物 298 行 / 消耗品 217 行 / 装饰 251 行 /
> 遗器套装 62 / 光锥 169 / 星神 18 章 / 派系 54 章 / 专有名词 48 章。

## 0. 抓取通道与反爬

- 端点 `https://wiki.biligame.com/sr/api.php`（MediaWiki 1.37 + Semantic MediaWiki）。
- 两种取数方式：
  - 列表页 → `action=parse&page=<标题>&prop=text&format=json&formatversion=2`
    （`json.parse.text` 是渲染后的 HTML；SMW 的 `#ask` 已经在服务端展开）。
  - 详情页 → `action=query&prop=revisions&rvprop=content&rvslots=main&titles=A|B|…`
    （一次最多 50 个标题；`missing===true` 表示页面不存在）。
- **限流是硬约束**：连续 12 次无间隔请求，后 6 次返回 HTTP **567** + 一份内联 CSS 的
  HTML 错误页（不是 JSON）。相邻请求 ≥ 1500 ms（默认 2000 ms）即稳定成功。
- 必须带浏览器 UA 与 `referer: https://wiki.biligame.com/sr/`。

## 1. HTML 解析的两个坑

1. **表格里的 `<img>` / `<a>` 属性包含 `>` 之外的内容没有风险，但行属性必须保留**：
   行切分只能用 `table.split(/(?=<tr[\s>])/i)`。
   用 `split(/<tr[^>]*>/)` 会把 `data-param*` 一起吃掉——数据行的全部筛选信息都在那里。
2. **SMW 提示浮层**：`<div style="display:none;"><span class="smw-highlighter">…` 会混进
   正文文本，清洗时必须先整段删除。

## 2. 列表页（表格型）：方程 / 事件 / 奇物 / 消耗品 / 装饰

五张表结构同源：`<table id="CardSelectTr" class="CardSelect wikitable sortable">`，
数据行 `<tr class="divsort" data-paramN="…">`，首行是 `id="CardSelectTabHeader"` 的表头。

| 数据集 | 行属性含义 | 单元格列 | 过滤 |
|---|---|---|---|
| `equations` | 1=稀有度 2=主命途 3=次命途 4=版本 5=模式 | 0 图标 / 1 名称 / 2 模式 / 3 需要祝福 / **4 效果** / 5 版本 | 模式含 `千面英雄` → 排除 |
| `events` | 1=模式 2=类型 3=版本 | 0 图标 / 1 事件名 / 2 模式 / **3 选项** / 4 版本 | 模式含 `千面英雄` → 排除 |
| `curios` | 1=模式 2=TAG 3=获取 4=标签 5=版本 6=星级 | 0 图标 / 1 名称 / 2 模式 / 3 TAG / 4 获取 / **5 效果** / 6 版本 | — |
| `consumables` | 1=稀有度 2=类型 3=获取方式 **4=所属地区** 5=版本 | 0 图标 / 1 名称 / 2 稀有度 / 3 所属地区 / 4 TAG / 5 获取途径 / **6 说明** / 7 所需材料 | 所属地区 === `翁法罗斯` → 排除 |
| `decorations` | 1=稀有度 2=类型 3=获取方式 4=版本 | 0 图标 / 1 名称 / 2 稀有度 / 3 类型 / 4 获取方式 / 5 说明 / **6 介绍** / 7 版本 | — |

模式为多值时写作 `data-param1="千面英雄, 乐园漫记"`，单元格文本则是 `千面英雄乐园漫记`
（`<br>` 被清洗掉）——两者都用 `includes` 判断即可。

## 3. 列表页（卡片型）：遗器 / 光锥

这两页**没有数据行表格**，卡片是 `<div class="divsort" data-paramN="…">`：

- `relics`：`data-param1`=类别（隧洞遗器 / 位面饰品）`data-param2`=获取方式 `data-param3`=版本；
  名称在 `<div class="relicset-name"><a title="…">`。
  **注意**：新套装的缩略图链接可能指向 `index.php?title=特殊:上传文件…`（文件不存在），
  所以名称必须取 `relicset-name` 内的 `<a title>`，不能取卡片里第一个 `<a>`。
- `lightcones`：`data-param1`=稀有度 `data-param2`=命途 `data-param3`=获取方式 `data-param4`=版本；
  名称在 `<div class="weapon-name"><a title="…">`。

## 4. 详情页（wikitext 模板）

| 数据集 | 模板 | 取用字段 |
|---|---|---|
| `relics` | `{{遗器套装\|…}}` | **6 个 `*故事` 字段**（头部/手部/躯干/脚部，或位面球的 `位面球故事`/`连结绳故事`），另取 `头部/手部/…` 部位名与 `*描述`。部分新套装故事字段为空 → 保留条目并标记 `empty`，不报错。 |
| `lightcones` | `{{光锥图鉴\|…}}` | **`光锥故事`**，另取 `命途`/`稀有度`/`实装版本` |
| `consumables` | `{{消耗品\|…}}` | **`介绍`**、`所属地区`、`稀有度`、`效果` |
| `decorations` | `{{装饰\|…}}` | **`介绍`**、`说明`、`类型`、`稀有度` |

wikitext 清洗约定：`<br>` → 换行；`<i>` 引文按普通文本保留；`<!-- -->` 注释整段丢弃；
`{{颜色|描述2|18%}}` 之类模板取最后一个位置参数。

## 5. 章节页（渲染 HTML 的标题切片）

这三页是「`<h2>`/`<h3>` 标题 + 表格/段落」结构，需要按标题切片而不是按表格行：

- `aeons`（星神）：渲染 HTML 里是 `<h2>`，标题文本形如 `「开拓」，阿基维利`
  （`<span class="mw-headline" id="…">`）。排除「目录 / 星神总览 / 参考资料」。
- `factions`（派系）：`<h2>` = 命途，`<h3>` = 派系；条目归属最近的上级 h2。
  排除「目录 / 派系总览 / 参考链接」。
- `terms`（专有名词）：`<h2>` = 分类（名词/地名/人物/科技/年表/学说/现象/物体），`<h3>` = 词条。

## 6. 模拟宇宙的开发日志

开发日志**不在**表格里，而在「模拟宇宙图鉴 → 星神」小节的
`<div class="resp-tab-content">` 内，形如：

```html
<p>开发日志1<br /><b>关联条目-「存护」</b><br />……正文……</p>
<hr />
<p>开发日志2<br />…</p>
```

定位必须先锁定「模拟宇宙图鉴」所在的 `<h2>` 区间，再在该区间内收集
`resp-tab-content`；直接 `indexOf('开发日志')` 会命中正文里的随机提及。

## 7. 星际和平播报

整页 HTML 约 17 KB，按 `<h4>` 小节（完成雅利洛-Ⅵ开拓任务 / 完成仙舟「罗浮」开拓任务 /
匹诺康尼… / 翁法罗斯… / 二相乐园…）组织。文本里**自带** `（音乐）`、`女声：`、`男声：`
说话人标签——这是功能 3 的格式依据，清洗时不得删除。

## 8. 缓存与增量

- 增量判据：`action=query&prop=revisions&rvprop=ids|timestamp&titles=<页面>` 取最新 `revid`，
  与缓存里的 `revisionId` 相同即跳过（不改写文件）。
- 写盘：先写 `<file>.tmp` 再 `rename`，避免半成品；
- 失败：保留旧文件，把 `ok:false` + `error` 写进 `index.json`，并列入 `failed[]`。

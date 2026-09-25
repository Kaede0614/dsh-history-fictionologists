# dsh-history-fictionologists · 虚构史学家

> 基于《崩坏：星穹铁道》官方世界观进行二次创作的 DSH 插件。
> 触发命令：**`/gs`**。风格基调：太空轻喜剧 + 一本正经地胡说八道。

核心参考游戏内「差分宇宙 · 方程一览」的想象力与命名逻辑：
**用最严肃的格式包装最离谱的内容**。

---

## 能力清单（前置条件）

| 能力 | 触发方式 | 前置条件 |
|---|---|---|
| `/gs` 三步交互入口 | 在 DSH Web 输入框输入 `/gs` | 插件已装入 profile 的 bundles，进程已重启 |
| `gs_setup` 缓存状态与更新建议 | 模型调用（`/gs` 第 2 步） | 无 |
| `gs_update` 增量抓取 12 个 Wiki 数据源 | 模型调用 | **需要联网**；本机可访问 `wiki.biligame.com` |
| `gs_read` 读取世界观条目 | 模型调用 | 至少成功抓取过一次（缓存存在） |
| `gs_missions` 既有故事目录（避让冲突） | 模型调用 | 工作区存在 `hsr-missions/` |
| `gs_digest` 命名逻辑 / 书架风格 / 播报格式素材 | 模型调用 | `equation`、`broadcast-template` 需缓存；`mission-digest`、`book-digest` 需 `hsr-missions/` |
| `gs_save` 成品落盘 | 模型调用 | 工作区可写 |
| 系统提示「语言风格总则 + 星神纪律」 | 自动注入 | 无 |

**降级行为（已实测）**：缓存目录不存在时 `gs_setup` / `gs_read` 仍返回合法结果（`hasCache:false`、
`recommendation:"update"`），不会抛错；`/gs` 在缺少子模块时仍能启动并如实报告状态。

---

## 安装

本插件通过 **GitHub 仓库 / Release 附件** 分发。它**不在 npm registry 上**——
`package.json` 里的 `private: true` 是刻意留的，防止这份二创包被误发到公共 registry。

```powershell
# 方式 A（推荐）：下载 Release 附件里的 tarball，再从本地路径安装
dsh plugin --profile web add C:\Users\<你>\Downloads\dsh-history-fictionologists-0.2.0.tgz

# 方式 B：直接从 GitHub 仓库装
dsh plugin --profile web add github:Kaede0614/dsh-history-fictionologists

# 方式 C：本地开发（junction 安装，改源码立即生效）
dsh plugin --profile web add link:<你的仓库路径>
```

> `dsh plugin` 是 profile 目录下 `pnpm` 的透传封装，所以本地 tarball 路径、`github:` 简写
> 都由 pnpm 解析；`dsh plugin add ...` 会**重解析整棵依赖树**，装进一个干净 profile 最稳。

安装后 **必须进程级重启 DSH**（新增 bundles 行只在启动时组合；`Ctrl+Shift+R` 热重载不生效）。

验证是否装载：

```powershell
dsh --profile web --dump-config | Select-String history-fictionologists
```

应当看到一行 `- id: dsh-history-fictionologists`。

### 仓库里有什么 / 没有什么

| | 内容 |
|---|---|
| **有** | `lib/`（插件本体）、`test/`（102 个离线用例）、`scripts/check.mjs`、`docs/`、`_evidence/`（自证与独立复核证据）、`BRIEF.md`（实现规格）、`cordis.patch.yml`、`hsr-worldview-cache/user-canon.json`（手工维护的裁定层） |
| **没有** | `hsr-missions/`（游戏原始剧本文本，约 20 MB，版权归米哈游）、`hsr-worldview-cache/*.json`（`gs_update` 可重新抓取）、`_probe/`（4.9 MB 原始渲染 HTML）、`hsr-stories/` 与 `hsr-broadcasts/`（本机成品） |

被忽略的目录仍留在你的工作区里，只是不进版本库（见 [`.gitignore`](<.gitignore>)）。

**功能 2 / 3 依赖工作区的 `hsr-missions/`**：没有它插件照样装载，
`gs_missions` 会如实降级报告「目录缺失」，`gs_digest` 的 `mission-digest` / `book-digest` 同理
（这条降级有 `test/missions.test.mjs` 覆盖）。要用全功能，请自备并放到 `<工作区>/hsr-missions/`：

```
trailblaze_missions.json          5 幕 / 18 系列 / 147 个开拓任务
adventure_other_tasks_full.json   7 章 / 33 个冒险任务
books_without_amphoreus.json      498 本书（「书架」风格参考）
sr-开拓续闻-完整/                  7 个系列 / 52 个开拓续闻任务
```

---

## 怎么触发

1. 在 DSH Web 的输入框输入 **`/gs`**（可以附带主题，例如 `/gs 欢愉命途的荒诞点子`）。
2. 插件会：
   - 本地读取缓存与既有故事状态，**不发一次模型请求**；
   - 把「三步交互协议」作为一条 plugin 来源的用户消息交给当前 agent；
   - 返回一行简短回执。
3. 模型据此依次弹出：
   - **第 1 步 · 功能选择**：1 神人制造机 / 2 构史文集 / 3 星际构史播报（单选弹窗）；
   - **第 2 步 · 世界观数据更新策略**：`Y` 访问网页重新抓取 / `N` 使用本地缓存；
   - **第 3 步 · 执行所选功能**。

### 第 2 步的引导规则

- 本地**无缓存** → 不问 Y/N，直接抓取，并告知「本地无缓存，已自动抓取」。
- 缓存较新（距上次更新 < `recentGuardDays`，默认 7 天）→ 即使选 Y，也先确认一句
  「数据较新，确认需要重新抓取吗？」。
- 选 Y → `gs_update` **增量**更新：先比对页面 `revid`，没变化的数据集直接跳过。
- 抓取失败（网络异常 / 被反爬拦截）→ **自动回退本地缓存**，并明确告知
  「更新失败，已使用缓存数据」。

---

## 三种功能

### 功能 1 · 神人制造机

生成 3–5 条全新科幻灵感（默认 4 条），输出格式：

```
【灵感名称】
命途归属：〈主命途〉/〈次命途〉
一句话简介：……
详细设定：……（约 100–200 字，须带荒诞感）
可能的故事方向：……
```

> **星神纪律**（0.1.1）：命途归属只是气质标签——星神与令使不出场，只能是背景、传闻与缺席；
> 已陨/失踪的星神（贪饕、繁育、秩序、不朽、纯美、开拓）绝不写成在世、现身或归来。
> 正文写神人自己的职业、麻烦与出路：荒诞来自「命途概念 × 市井生活」的错位，不是「他和星神很熟」。

### 功能 2 · 构史文集

先读 `hsr-missions` 的既有故事避免冲突，参考「书架」书籍风格，默认约 **2000 字**短篇
（可指定字数）。荒诞但不轻浮，喜剧底色下可有一丝温情或哲思。

### 功能 3 · 星际构史播报

约 **800–1200 字**、**3–5 条**新闻，固定格式：

```
（音乐）

女声：这里是星际和平播报，观众朋友们晚上好。
男声：晚上好。

女声：第一条消息。……
男声：第二条消息。……

女声：本次播报到此结束，请在指定时间收听下一周期的星际和平播报。
（音乐）
```

虚构文本必须足够科幻、足够太空、充满想象力——**不是对已有故事的重组**。

---

## 世界观数据

### 已发生的故事（本地，无需抓取）

工作区 `hsr-missions/`：

| 文件 | 内容 |
|---|---|
| `sr-开拓续闻-完整/` | 7 个系列 / 52 个「开拓续闻」任务（含完整台词稿） |
| `trailblaze_missions.json` | 5 幕 / 18 系列 / 147 个开拓任务 |
| `adventure_other_tasks_full.json` | 7 章 / 33 个冒险任务 |
| `books_without_amphoreus.json` | 498 本书（「书架」风格参考） |

功能 2 / 3 生成前必须读它，避免与既有事件冲突。

### 背景设定（12 个 Wiki 数据源，需联网抓取）

| id | 页面 | 抓取内容 | 过滤 |
|---|---|---|---|
| `relics` | 遗器图鉴 | 每套遗器的「遗器来历」（各部位 `*故事`） | — |
| `lightcones` | 光锥图鉴 | 每个光锥的「光锥故事」 | — |
| `consumables` | 消耗品筛选 | 每个消耗品的「介绍」 | 排除所属地区=翁法罗斯 |
| `decorations` | 装饰一览 | 每个装饰的「介绍」 | — |
| `aeons` | 星神 | 每个星神的介绍 | — |
| `factions` | 派系 | 每个派系的内容 | — |
| `terms` | 专有名词 | 每个专有名词的内容 | — |
| `simuniverse` | 模拟宇宙 | 「模拟宇宙图鉴 → 星神」里的开发日志 | — |
| `curios` | 奇物一览（差分） | 每个奇物的介绍/效果 | — |
| `events` | 事件一览 | 每个事件的内容 | 排除模式含「千面英雄」 |
| `equations` | 方程一览 | 每个方程的内容（效果全文） | 排除模式含「千面英雄」 |
| `broadcast` | 星际和平播报 | 全部内容 | — |

抓取礼仪：相邻请求间隔 ≥ `requestIntervalMs`（默认 2000 ms），带浏览器 UA 与 Referer，
非 JSON 响应（WAF 会返回 HTTP 567 的错误页）走指数退避重试，重试耗尽则保留旧缓存并如实上报。

---

## 缓存目录

**`<工作区>/hsr-worldview-cache/`**

```
hsr-worldview-cache/
├── index.json          # 每个数据集的状态：lastUpdated / count / revisionId / ok / error
├── equations.json      # 每个数据集一个文件，字段见下
├── aeons.json
├── factions.json
├── terms.json
├── relics.json
├── lightcones.json
├── consumables.json
├── decorations.json
├── curios.json
├── events.json
├── simuniverse.json
├── broadcast.json
└── user-canon.json     # 用户设定补充（手工维护，抓取永不改写）
```

单个缓存文件结构：

```json
{
  "dataset": "equations",
  "title": "方程一览",
  "url": "https://wiki.biligame.com/sr/方程一览",
  "lastUpdated": "2026-09-26T02:00:00.000Z",
  "revisionId": 12345,
  "pageSha": "…",
  "count": 212,
  "excludedCount": 112,
  "entries": [ { "name": "…", "content": "…" } ],
  "warnings": []
}
```

> **提示**：每个缓存文件都带 `lastUpdated` 时间戳。删掉整个目录就是彻底重置；
> 想强制重抓某一天数据，用 `gs_update` 的 `force: true`（或删掉对应的单个 json 文件）。

工作区解析优先级：插件 `config.workspace` → `DSH_HISTORY_FICTIONOLOGISTS_WORKSPACE`
→ `DSH_WORKSPACE` → 当前工作目录（或其上层含 `hsr-missions` 的目录）→ 插件包所在目录。

### 用户设定补充（`user-canon.json`）

缓存是「抓来的事实」，你自己的设定裁定是另一层——**它优先于缓存**。

- **位置**：`<工作区>/hsr-worldview-cache/user-canon.json`，手工维护。`gs_update` 只重写
  `<数据集>.json`，**永远不会碰这个文件**（所以裁定不会被下一次抓取抹掉）。
- **生效方式**：`gs_read` 结果末尾附上「用户设定补充」区块，并明确标注「冲突时以此为准」；
  `gs_setup` 报告条数与更新时间；系统提示的「语言风格总则」也写明了它的优先级。
- **作用域**：`dataset` 写数据集 id 时只在该数据集生效（`aeons` / `aeon` 都认），
  写 `"*"` 或省略则对全部数据集生效；`match` 是触发关键词（命中 `gs_read` 的 `query`，
  或与该数据集返回的条目同屏出现时带出）；`query` 为空时，该数据集名下的裁定一律带出。
- **`note` 必填**：没有 `note` 的条目会被忽略并告警——空口裁定不算设定。

```json
{
  "schema": "dsh-history-fictionologists/user-canon@1",
  "updatedAt": "2026-09-26T03:30:00.000Z",
  "entries": [
    {
      "dataset": "aeons",
      "match": ["贪饕", "奥博洛斯"],
      "name": "「贪饕」，奥博洛斯",
      "status": "已镇压（不得写成在世／失踪待返／即将归来）",
      "note": "奥博洛斯早已四分五裂、被镇压。缓存里的「已失踪无影」只是旧传闻，不得当作现状。",
      "source": "用户评审（2026-09-26）"
    }
  ]
}
```

文件缺失 = 没有裁定（正常状态）；文件损坏或 JSON 非法 = 降级为「0 条 + 告警」，
不影响缓存读取与其它工具。读取逻辑在 [`lib/usercanon.mjs`](<lib/usercanon.mjs>)，
测试在 [`test/usercanon.test.mjs`](<test/usercanon.test.mjs>)。

---

## 成品落在哪

| 类型 | 目录 |
|---|---|
| 短篇小说（功能 2） | `<工作区>/hsr-stories/<时间戳>-<标题>.md` |
| 星际和平播报（功能 3） | `<工作区>/hsr-broadcasts/<时间戳>-<标题>.md` |
| 灵感（功能 1） | `<工作区>/hsr-stories/inspirations/<时间戳>-<标题>.md` |

文件带 YAML front-matter（`kind` / `title` / `createdAt` / `generator`）。
把 `config.saveOutputs` 设为 `false` 可关闭落盘。

---

## 配置项

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（整行 `config` 会被替换，所以要把需要的键都写上）：

```yaml
- id: dsh-history-fictionologists
  config:
    workspace: ''            # 留空自动解析
    requestIntervalMs: 2000  # 相邻 Wiki 请求最小间隔（毫秒）
    requestTimeoutMs: 30000
    maxRetries: 3
    staleAfterDays: 7        # 超过该天数即建议重新抓取
    recentGuardDays: 7       # 不足该天数时，选 Y 也先确认一次
    defaultStoryWords: 2000
    defaultBroadcastWords: 1000
    inspirationCount: 4      # 3–5
    saveOutputs: true
    userAgent: 'Mozilla/5.0 …'
```

---

## 目录结构（插件本体）

```
dsh-history-fictionologists/
├── package.json            # dsh.bundle.patch 指向 cordis.patch.yml；main = lib/shell.js
├── cordis.patch.yml        # bundle 挂载声明
├── lib/
│   ├── shell.js            # 插件外壳：/gs 命令、6 个工具、风格提示词、Config（包入口）
│   ├── resolve.js          # @deepseek-ai/* 可选依赖的多 base 解析链
│   ├── paths.js            # 工作区 / 缓存 / 成品目录解析
│   ├── missions.js         # hsr-missions 读取与索引
│   ├── digest.js           # 命名逻辑 / 书架风格 / 播报格式素材
│   └── wiki/               # 12 个数据源的抓取与解析
│       ├── datasets.mjs    # 数据源登记表（含单复数 id 别名）
│       ├── client.mjs      # 限流 / 重试 / WAF 识别
│       ├── html.mjs        # 通用 HTML 解析
│       ├── wikitext.mjs    # {{模板|字段=值}} 解析
│       ├── extract.mjs     # 12 个抽取器
│       ├── cache.mjs       # 原子缓存 + revid 短路
│       └── index.mjs       # status / update / read / sampleAll
├── test/                   # node:test：离线重放 + mock ctx + 宿主校验器一致性（无网络）
├── docs/DESIGN.md          # 数据源结构实测记录（抓取选择器依据）
└── CHANGELOG.md
```

> 入口文件叫 `lib/shell.js` 而不是惯用的 `lib/index.js`：一次编辑事故把后者写成了非 UTF-8
> 字节，文件系统观察策略（正确地）拒绝再覆写一个读不出来的路径，于是安全修复是换一个
> 干净文件名并把 `package.json` 的 `main`/`exports` 指过去。行为与 `index.js` 完全等价。

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 输入 `/gs` 没有补全、没有反应 | bundles 行未生效：确认 `--dump-config` 里有该行，然后**进程级重启** |
| `--dump-config` 报告跳过该 bundle | 报的是原因（多半是解析不到包）。确认 `node_modules/dsh-history-fictionologists` 链接或已 `dsh plugin add` |
| `--dump-config` 报错、整棵插件树崩 | `Config` 被导出成普通对象（本插件已规避；若你改过 `lib/shell.js` 请检查） |
| 工具「静默消失」 | `@deepseek-ai/*` 解析失败。`node -e "import('./lib/resolve.js').then(m=>console.log(m.resolutionReport()))"` 看解析链 |
| 工具报 `returned invalid output` | 某个工具返回值违反了它自己声明的 schema（例如可选键出现了 `null`）。跑 `node --test test/host-validator.test.mjs` 会直接指出是哪一个 |
| 抓取全部失败 | 网络不通，或请求过于频繁被 WAF（HTTP 567）拦截。调大 `requestIntervalMs` 后重试 |
| 模型说「未读取到数据」 | 先跑一次 `gs_update`；或检查 `config.workspace` 是否指向了正确的工作区 |
| 想看抓取细节 | 缓存目录的 `index.json` 里有每个数据集的 `ok` / `error` / `count` / `revisionId` |

## 自检命令

```powershell
cd <你的仓库路径>
node scripts/check.mjs    # 首选：语法检查全部 13 个模块 + 跑全套测试（约 1.5 秒）
node --test               # 只跑测试（Node 自动发现 test/ 下所有 *.test.mjs）
node _evidence/e2e-wiring.mjs     # 真实 Wiki 上跑通 6 个工具的接线（会联网，约 15 秒）
node _evidence/run-extract.mjs --live   # 12 个数据源真机抓取取证（会联网，约 60 秒）
node _evidence/verify-gs-e2e.mjs  # 隔离实例里端到端验证 /gs（约 15 秒）
```

> **为什么不用 `npm test`**：这台机器上 PATH 里只有 `npm.ps1`，而 PowerShell 执行策略禁止运行它，
> 所以 `npm test` 在 PowerShell 里直接报 `running scripts is disabled`（用 `cmd /c "npm test"` 可以跑通）。
> 另外 **`node --test test/` 这种带斜杠的写法在 Node 24 上会失败**（`Cannot find module ...\test`：
> Node 不会替 npm script 展开 glob），所以 `package.json` 的 `test` 用的是裸 `node --test` 自动发现。
> 为了让自检不依赖 npm，才把检查逻辑放进 `scripts/check.mjs`。

**测试分层**（每一层都补上一层的盲区）：

| 层 | 文件 | 能证明什么 | 证明不了什么 |
|---|---|---|---|
| 契约 | `test/plugin.test.mjs` | 注册物齐全（6 工具 / 1 命令 / 1 section）、`/gs` handler 在异常与降级输入下不抛、规范 JSON | 返回值是否符合 `output.schema`（mock 不校验） |
| 宿主校验 | `test/host-validator.test.mjs` | 用**宿主自己的** `validateJsonSchemaValue` 校验 6 个工具的全部降级路径；含元测试证明该断言会失败；含卸载/重载与 stub 接缝的隔离断言 | 真实进程内的注册成功 |
| 解析 | `test/wiki.test.mjs` | 12 个抽取器对真实 HTML 的选择器正确性（离线重放）+ revid 短路 + WAF 重试 + 注入时钟的确定性限流断言 | 真机网络行为 |
| 连续性 | `test/missions.test.mjs` | `hsr-missions` 三种 JSON 的读取、截断上界、缺失降级 | — |

> 全部离线（每个 `new WikiClient` 都注入了假 `fetch`，套件里 `globalThis.fetch` 一次都不会被调用）。
> 需要联网的验证在 `_evidence/`（`run-extract.mjs --live`、`cache-roundtrip.mjs`、`e2e-wiring.mjs`）。

### 在哪台机器上跑得出什么

`test/` 里有一层用例**重放本地夹具**（`_probe/html/*.html`）与**真实语料**（`hsr-missions/`）——
这两份数据按体积与版权考虑**不进版本库**（见 `.gitignore`）。所以同一套用例在不同检出里给出的数字不同：

| 检出 | 命令 | 结果 |
|---|---|---|
| 作者工作区（`_probe/` 与 `hsr-missions/` 都在） | `node --test` | **102 用例 / 101 pass / 0 fail / 1 skip**（约 1.5 秒） |
| **全新克隆**（两者都不在） | `node --test` | **102 用例 / 70 pass / 0 fail / 32 skip**（约 0.3 秒） |

**32 条 skip 的每一条都带原因**，直接印在输出里，例如：

```
﹣ update: unknown ids and a broken client degrade into failed[] # _probe/html/遗器图鉴.html,
  _probe/html/光锥图鉴.html, _probe/html/消耗品筛选.html, _probe/html/装饰一览.html (+8 more)
  are not in this checkout (see .gitignore)
```

设计口径：**夹具缺失 → 显式 skip；从不静默通过，也从不弱化断言**。
所有与磁盘无关的用例（`client:` 限流与 WAF 重试、HTML/wikitext 解析、合成缓存降级、
`gs_*` 工具输出的规范 JSON 与宿主校验器一致性……共 70 条）在任何检出里都照跑。

唯一的例外是 `test/host-validator.test.mjs`：这一层要解析**宿主的**
`validateJsonSchemaValue`，所以**前置条件是本机装过 dsh**（解析基座见
[`lib/resolve.js`](<lib/resolve.js>)）。没装时它是**硬失败而不是 skip**——
实测 `10 fail / 2 pass / 0 skip`。这是刻意的：这一层存在的意义正是证明其余断言**不是恒真**的，
让它静默跳过就等于把「已验证」变成一句空话。装上 dsh 后这 10 条照跑。

> 想要完整 102 条：把 `_probe/`（`docs/DESIGN.md` 里有每个页面的抓取依据）与 `hsr-missions/`
> 准备好，或直接在作者工作区里跑。

**最关键的一条产品证据**（可复现）：`node _evidence/check-prompt-section.mjs`

它从隔离实例的真实会话日志里**解析**出注入记录，证明模型确实收到了这份指导，而不只是「插件注册成功」：

```
record type=system/message  role=system  chars=3500   <- 整条组装后的系统提示
风格总则本体 = 725 字符（= 抓取当次的 __internals.STYLE_GUIDE.length，与日志内容逐字节一致）
gs_* tools in the request tool list: gs_digest, gs_missions, gs_read, gs_save, gs_setup, gs_update
  YES  章节标题 / 风格总则 / 功能 1 四个字段 / 功能 2（2000 字·荒诞但不轻浮）
  YES  功能 3（女声·男声·（音乐）·结束语·800–1200 字）/「不得凭空编造与既有设定冲突的事实」
```

即：**风格总则（本体 725 字，0.1.0 版）与三个功能的逐字格式进入了那条 3500 字的组装后系统提示，
6 个 `gs_*` 工具同时出现在请求的工具列表里。**
输出在 `_evidence/prompt-section-injection.txt`。

> 口径提醒（复核者 R3-5 纠正，我先前表述有夸大）：**3500 是整条系统提示的长度，不是风格总则的长度**。
> 复核者另做了更强的一致性检查：日志里的风格文本 `includes(STYLE_GUIDE) === true`，即与抓取当次的源码逐字节一致。
>
> **版本提醒**：上面这段是 0.1.0 的快照，当时 `STYLE_GUIDE` 为 725 字符。此后每次改提示词长度都会变：
> 0.1.1（加入「星神纪律」）为 1161 字符 / 55 行，**当前源码（0.2.0）为 1291 字符 / 57 行**。
> 要刷新这条产品证据，需要在隔离实例里重跑 `node _evidence/check-prompt-section.mjs`（本机日常实例不重启）。

### 开发/取证目录（不属于插件运行时，不随包发布）

| 目录 | 内容 |
|---|---|
| `_probe/` | 抓取前的结构侦察产物：12 个页面的原始渲染 HTML、结构普查文本、真实 wikitext 样本。**是 `docs/DESIGN.md` 里每条选择器的原始证据** |
| `_evidence/` | 自证与复核证据：离线重放报告、真机抓取日志、缓存往返日志、接线检查、端到端验证脚本与输出、**独立复核报告 `review-shell.md`** |
| `BRIEF.md` | 实现规格（数据源结构实测记录 + 接口契约）。**有勘误表，见文件头的回填说明** |

隔离实例端到端验证（**绝不动你自己的 `~/.dsh`**）：

```powershell
node _evidence/verify-gs-e2e.mjs          # 默认路径，约 15 秒
node _evidence/verify-gs-e2e.mjs --model  # 额外让模型真调一次 gs_setup（隔离 home 无模型路由，会超时）
# 1) 建一个临时 DSH_HOME + web profile（bundles 含本插件）
# 2) 起 dsh --profile web --port 3081 --no-open
# 3) 用启动 token 换签名 cookie
# 4) session/create → commands/list（确认 /gs 出现）→ commands/execute "/gs"
# 5) 收尾：taskkill 自己的子进程树 + 杀掉「测试端口」的持有者
```

**诚实边界**：`--model` 那一步在隔离 home 里必然超时——启动 token 与模型路由都属于你自己的实例，
隔离 home 两者都没有（实测：prompt 被接受后 180 秒内会话日志始终为空）。该契约因此由
`test/host-validator.test.mjs`（用宿主同一个校验函数，离线）与**你实例里那次真实调用**共同覆盖：
插件首次装好后模型确实调到了 `gs_setup`，而正是那一次暴露了 `lastUpdated: null` 的 schema bug。

> ⚠️ 收尾只用 `taskkill /PID <自己的子进程> /T` 加「测试端口持有者」。**不要**改成
> `Get-Process node | Stop-Process`——开发过程中这么写了一次，把用户正在使用的 dsh 实例
> 一起杀掉了（已修正，教训记在 `_evidence/verify-gs-e2e.ps1` 文件头与脚本注释里）。

---

## 版权

插件源代码与文档以 **MIT** 许可发布，见 [`LICENSE`](<LICENSE>)。
[`NOTICE`](<NOTICE>) 另外声明了第三方归属：《崩坏：星穹铁道》的游戏文本与世界观设定版权归
米哈游（HoYoverse），Wiki 页面文本版权归 Bwiki 编辑者；MIT **不覆盖**这些素材。

原始文本版权归米哈游（HoYoverse）及 Bwiki 编辑者所有。本插件产出的内容属于**非营利性二创**，
米哈游对二创持开放态度。仅供个人学习、检索与研究使用。

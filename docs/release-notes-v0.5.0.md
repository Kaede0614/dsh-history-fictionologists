# v0.5.0 — 虚构史学家（dsh-history-fictionologists）

> 一个 DSH 插件：把《崩坏：星穹铁道》的官方世界观当作素材库，用 **`/gs`** 生成二创内容。
> 三步交互：**选功能 → 选数据更新策略 → 生成**。

**本次是功能版本：新增第 5 个功能「虚构差分方程」**（`/gs` 第 1 步的第 5 项）。

按本仓库的语义化版本表「新增用户可见能力 → minor」，故为 `0.5.0`。

**本版同时收进了从未单独发布的 0.4.0**：0.3.0 之后，星际构史播报的格式与题材口径经用户评审改过一轮，
那段改动一直留在工作区里没有单独发版，所以版本号从 0.3.0 直接跳到 0.5.0——0.4.0 的内容在本版一并生效。

---

## 安装

```powershell
# 方式 A（推荐）：下载本 Release 的 .tgz 附件，再从本地路径安装
dsh plugin --profile web add C:\Users\<你>\Downloads\dsh-history-fictionologists-0.5.0.tgz

# 方式 B：GitHub 仓库直装
dsh plugin --profile web add github:Kaede0614/dsh-history-fictionologists

# 方式 C：AtomGit 仓库直装（国内网络更稳；镜像同步状态见文末「已知限制」）
dsh plugin --profile web add https://atomgit.com/Scombriformes/dsh-history-fictionologists

# 方式 D：本地开发（junction 安装，改源码立即生效）
dsh plugin --profile web add link:<你的仓库路径>
```

安装后 **必须进程级重启 DSH**——新增的 bundles 行只在启动时组合，`Ctrl+Shift+R` 热重载不生效。

验证：

```powershell
dsh --profile web --dump-config | Select-String history-fictionologists
```

---

## 能力清单

**10 个模型工具 + 1 个斜杠命令 + 1 段自动注入的系统提示**（v0.3.0 是 9 个工具）。

| 能力 | 触发方式 | 前置条件 |
|---|---|---|
| `/gs` 三步交互入口 | Web 输入框输入 `/gs` | 已装入 bundles + 进程级重启；第 1 步现在是**五个**功能 |
| `gs_setup` | 模型调用 | 无（无缓存时也返回合法降级结果） |
| `gs_update` | 模型调用 | **需要联网**，本机可访问 `wiki.biligame.com` |
| `gs_read` | 模型调用 | 至少成功抓取过一次（或存在 `user-canon.json`） |
| `gs_missions` | 模型调用 | 工作区存在 `hsr-missions/` |
| `gs_digest` | 模型调用 | `equation` / `broadcast-template` 需缓存；`mission-digest` / `book-digest` 需 `hsr-missions/` |
| `gs_planets` | 模型调用 | 无（缺增量文件时只报原始 27 颗，不报错） |
| `gs_planet_save` | 模型调用 | 工作区可写；原始列表优先，重名候选进 `rejected` |
| `gs_planet_reset` | 模型调用 | 工作区可写；**必须用户明确确认后带 `confirm: true`** |
| `gs_equation_save` **(新)** | 模型调用 | 工作区可写；既有方程缓存存在时叠加重名检查（缓存缺失则跳过并 `warnings` 说明） |
| `gs_save` | 模型调用 | 工作区可写 |
| 系统提示「语言风格总则 + 星神纪律」 | 自动注入 | 无（新增功能 5 的输出格式段） |

配置项 **13 个**（新增 `equationCount`，默认 `6`，范围 3–10）。

---

## 本次新增

### 虚构差分方程（功能 5）

- **[`lib/equations.mjs`](<../lib/equations.mjs>)**：规则本体。五类主题与命途白名单、
  生物类命名规则、`validateFictionEquations()`（**逐条 + 批级**两段校验）、
  `renderEquationsMarkdown()` / `renderEquationsCheckReport()`、`readExistingEquationNames()`、
  `describeEquationRules()`。
- **叙事对象不限于人物**，五类大致均分：人物·职业/身份 / 生物·物种衍生体 / 装置·器物场所 /
  抽象概念·现象事件 / 派系·机构组织。参考既有 **212 条**方程的实际配比（人物类占 59.0%），
  本功能刻意把人物压到「每批最多 1–2 条」。硬约束：**每类 ≥1 条、单类 ≤2 条**（批次 ≥ 5 条时校验）。
- **默认 6 条**（`config.equationCount`，3–10）。**不要用 5 条**——5 条无法同时满足
  「每类 ≥1」「单类 ≤2」「鱼类与鸟类 ≥2」；推荐配额 人物 1 / 生物 2 / 装置 1 / 概念 1 / 派系 1。
- **新工具 `gs_equation_save`**：逐条校验后写入 `<工作区>/hsr-stories/equations/`，
  同目录再写一份 `-equations.md` 自检记录（五类配比、生物构成、被拒原因）。
  **只写入通过的条目**，被拒条目在 `rejected` 里逐条给原因——不会把「部分写入」讲成「全部写入」。
- **正文不写游戏机制**：方括号符号、百分比、暴击 / 护盾 / 战技点 / 终结技 / 削韧 / 回合等
  机制语言一律**拒收**（本功能产出的是「名称 + 详细设定」，不是方程卡）。
- **生物类命名**三条硬规则：名字 ≥3 字；不得沿用既有构词（蠧役 / 残嗣 / 虫帝 / 王虫 / 巨人 …）；
  鱼类与鸟类占比高于虫类——虫类 ≤ 四成、鱼鸟 ≥ 2 条、鸟类 ≤ 1 条、生僻字 ≤ 1 条
  （这三条按**提示**定级，不硬拒批次）。
- **派系类必须新造机构名**：使用既有派系名即等于换皮。
- 输出格式（逐字）：

  ```
  【方程名称】
  〔主题类别〕命途归属：〈主命途〉/〈次命途〉
  详细设定：……（约 120–220 字，须带荒诞感）
  可能的故事方向：……（一到两句话）
  ```

- [`scripts/check-fiction-equations-v2.mjs`](<../scripts/check-fiction-equations-v2.mjs>)：离线自检脚本，
  刻意做成**薄封装**——规则本体就是 `lib/equations.mjs`，不让「对话里生成」与「工具落盘」出现两套口径。
  被它取代的第一版 `scripts/check-fiction-equations.cjs` 留档不删。
- 实现规格见 [`docs/fiction-equation.md`](<../docs/fiction-equation.md>)；被废弃的第一版方案
  （带游戏机制的方程卡写法）留档在
  [`docs/fiction-equation-v1-mechanics.md`](<../docs/fiction-equation-v1-mechanics.md>)，作为
  「为什么这个功能不该写机制」的对照证据。

### 同时发布：星际构史播报的格式与题材口径（0.4.0）

- **去掉序号前缀**：不再写「第一条消息。/第二条消息。」，每条新闻直接从内容展开。
- **问候之后补过渡句**：报头那位说完「晚上好」后固定补一句「欢迎收听今天的星际和平播报节目：」。
- **报头人声改随机**：可女声可男声，选定后全篇**严格交替**；模板改用具名占位符
  〈报头人声〉/〈另一位〉/〈轮到的那一位〉，开场问候句与结尾句仍逐字不变。
- **题材口径**：报道对象是星球、地区、派系与它们身上发生的事件，不落到某个普通个人的轶事上
  （要人物请走功能 1「神人制造机」）。
- 两条裁定落在 [`hsr-worldview-cache/user-canon.json`](<../hsr-worldview-cache/user-canon.json>)：
  `broadcast-format-rules` 与 `broadcast-no-godman-maker-subject`。该文件是手工维护的裁定层，
  抓取流程永不改写。

### 工程侧

- **测试临时目录改到工作区内**：受限沙箱（Windows ACL restricted token）下 Node 对系统 temp 的
  `mkdtempSync` 会 EPERM，8 个测试文件此前都依赖系统 temp，现统一改用 `<工作区>/.tmp-tests/`
  （见 [`test/helpers.mjs`](<../test/helpers.mjs>)），`.gitignore` 同步新增该目录。
- 工具数与功能数断言同步（9 → 10 个工具、4 → 5 个功能选项），新工具纳入宿主校验器的降级路径覆盖。
- 系统提示总则里的「四个功能」表述同步为「五个功能」。

---

## 制品与验证（全部真跑，非推断）

**附件**：`dsh-history-fictionologists-0.5.0.tgz`

```
26 个文件 · 172695 字节（168.6 kB）
SHA256  D92A42409BE81EC3EFFEFB1BC77C26DAEB13BFE674D76A32B2DBFAC3DA5E2E1E
SHA1    ADD9F237CC61A6CF617D62C4B17FB576F1FA23CE
```

`files` 白名单核对：清单里**没有** `test/`、`docs/`、`_evidence/`、`_probe/`、`node_modules/`、
`hsr-missions/`、任何 `.bak` / `.log` / **令牌文件**。制品由发版脚本自己的读回器逐字节比对过；
**连续两次构建哈希相同**（gzip + tar 带 `mtime=0`，字节确定）。

- **离线用例**：**200 用例 / 199 pass / 0 fail / 1 skip**（2026-09-29，作者工作区）。
  分文件：本功能 `test/equations.test.mjs` **25 条全绿**、星球 22、发版工具链 26（GitHub）+
  24（AtomGit）、wiki 29、missions 41、宿主校验 13、契约 12、用户裁定 8。
  唯一 skip 是 missions 的「缓存已存在时不再跑降级断言」，与制品无关。
  跑法说明：受限沙箱下 `node --test` 在**宿主侧**就 EPERM（测试运行器要为每个测试文件 spawn
  子进程，而沙箱禁止管道 stdio），故改为逐文件 `node test/<name>.test.mjs` 直跑后汇总——
  与 `node --test` 跑的是同一批文件、同一套断言。
- **语法自检**：`lib/` 全部模块 `node --check` 通过（0 失败）。
  `scripts/check.mjs` 本身在受限沙箱下跑不动（它内部用管道 spawn `node --test`），
  故其两半被拆开单独执行：语法逐文件、用例逐文件。
- **CR 字节**：工作区所有待打包文件 `CR=0`（`.gitattributes` 钉死 LF）。
  注意 `.tgz` 原文件里能扫到 600 余个 `0x0D`——那是 gzip 压缩流的二进制噪声，不是文本 CRLF；
  脚本自身的 CR 扫描只看解压后的文本条目，这个口径是对的。
- **GitHub 写入路径**：本次发布结果与公开下载逐字节回验，记在
  [`_evidence/github-publish-v0.5.0.txt`](<../_evidence/github-publish-v0.5.0.txt>)。
- **AtomGit 镜像**：本版**尚未同步**（见下）。

---

## 已知限制（诚实边界）

- **模型行为本身未在真机验证**：隔离实例没有模型路由。「模型真的收到了 0.5.0 的提示词」由离线断言兜底
  （系统提示里必须出现功能 5 的格式与五类配额、`/gs` 协议文本里必须出现五个功能）；
  模型是否会照做「每批均分五类」**未验证**。校验器只能拒收不合规的落盘，管不了模型怎么想。
- **`_evidence/prompt-section-injection.txt` 仍是 0.1.0 的抓取，对 0.5.0 已过期**（README 已注明）。
- **[`BRIEF.md`](<../BRIEF.md>) 未同步功能 5**：该文件按「原文不改 + 文件头勘误」的惯例维护，
  目前文件头最新的勘误只覆盖到 0.3.0 的星球功能；功能 5 在 BRIEF 里一个字都没有。
  权威说明是 README 的「功能 5」一节与 [`CHANGELOG.md`](<../CHANGELOG.md>) 的 0.5.0 条目。
- **README 里「没装 dsh 时 host-validator 实测 `10 fail / 2 pass`」未复测**：该文件已从 12 条长到 13 条，
  这个数字很可能过期，但作者机器上装着 dsh，无法复现「没装」的条件。
- **功能 2 / 3 依赖工作区的 `hsr-missions/`**（约 20 MB 游戏原始剧本文本，版权归米哈游，**不进版本库**）。
  缺失时插件照样装载，`gs_missions` 如实降级报告「目录缺失」。
- **`gs_update` 一轮全量约需数分钟**（站点限流决定），串行抓取以规避风控。
- **AtomGit 是分发镜像，本版尚未同步**：0.3.0 时两平台同级，本版只发了 GitHub；
  镜像滞后需要在 AtomGit 侧跑一次 `scripts/release-atomgit.mjs --publish`（同一份字节、同一哈希）。

---

## 版权

代码以 **MIT** 许可发布（[`LICENSE`](<../LICENSE>)）。游戏原始素材版权归
米哈游（HoYoverse）及 Bwiki 编辑者所有，第三方内容声明见 [`NOTICE`](<../NOTICE>)。
本插件产出属**非营利性二创**。

> 本包**不在 npm registry 上**。`package.json` 里的 `private: true` 是刻意留的，
> 防止这份二创包被误发到公共 registry。

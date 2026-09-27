# v0.3.0 — 虚构史学家（dsh-history-fictionologists）

> 一个 DSH 插件：把《崩坏：星穹铁道》的官方世界观当作素材库，用 **`/gs`** 生成二创内容。
> 三步交互：**选功能 → 选数据更新策略 → 生成**。

**本次是功能版本：新增第 4 个功能「星球制造机」**（`/gs` 第 1 步的第 4 项）。

按本仓库的语义化版本表「新增用户可见能力 → minor」，故为 `0.3.0`。
前三个功能（神人制造机 / 构史文集 / 星际构史播报）行为不变；随系统提示注入的
「语言风格总则 + 星神纪律」由 **1291 字符 / 57 行 → 1748 字符 / 72 行**
（并入功能 4 的格式与「生成后必须依次问两件事」）。

---

## 安装

```powershell
# 方式 A（推荐）：下载本 Release 的 .tgz 附件，再从本地路径安装
dsh plugin --profile web add C:\Users\<你>\Downloads\dsh-history-fictionologists-0.3.0.tgz

# 方式 B：GitHub 仓库直装
dsh plugin --profile web add github:Kaede0614/dsh-history-fictionologists

# 方式 C：本地开发（junction 安装，改源码立即生效）
dsh plugin --profile web add link:<你的仓库路径>
```

> **AtomGit 镜像本版未同步**：镜像站最新仍是 `v0.2.1`。`package.json` 的
> `repository` / `homepage` / `bugs` 始终指向 GitHub。

安装后 **必须进程级重启 DSH**——新增的 bundles 行只在启动时组合，`Ctrl+Shift+R` 热重载不生效。

验证：

```powershell
dsh --profile web --dump-config | Select-String history-fictionologists
```

---

## 能力清单

**9 个模型工具 + 1 个斜杠命令 + 1 段自动注入的系统提示**（v0.2.1 是 6 个工具）。

| 能力 | 触发方式 | 前置条件 |
|---|---|---|
| `/gs` 三步交互入口 | Web 输入框输入 `/gs` | 已装入 bundles + 进程级重启 |
| `gs_setup` | 模型调用 | 无（无缓存时也返回合法降级结果；回执新增星球列表状态） |
| `gs_update` | 模型调用 | **需要联网**，本机可访问 `wiki.biligame.com` |
| `gs_read` | 模型调用 | 至少成功抓取过一次（或存在 `user-canon.json`） |
| `gs_missions` | 模型调用 | 工作区存在 `hsr-missions/` |
| `gs_digest` | 模型调用 | `equation` / `broadcast-template` 需缓存；`mission-digest` / `book-digest` 需 `hsr-missions/` |
| `gs_planets` **(新)** | 模型调用 | 无（缺增量文件时只报原始 27 颗，不报错） |
| `gs_planet_save` **(新)** | 模型调用 | 工作区可写；原始列表优先，重名候选进 `rejected` |
| `gs_planet_reset` **(新)** | 模型调用 | 工作区可写；**必须用户明确确认后带 `confirm: true`** |
| `gs_save` | 模型调用 | 工作区可写 |
| 系统提示「语言风格总则 + 星神纪律」 | 自动注入 | 无 |

配置项 **12 个**（新增 `planetCount`，默认 3，范围 1–10：功能 4 默认生成几颗）。

---

## 本次新增

### 星球制造机（功能 4）

- **[`lib/planets.mjs`](<../lib/planets.mjs>)**：用户给出的 **27 颗原始星球**逐字编译为常量底本
  `PLANET_BASELINE_SOURCE`，解析成常量条目并加「出处」标注（`visited` / `mentioned` /
  `ruined` / `unknown` / `other`）——**标注只用于分组参考，不改用户原文一个字**。
  底本与常量的逐条一致性由「回查原文」的用例锁死。
  为什么不放进工作区文件：`gs_update` 每次都原子重建 `<dataset>.json`，
  而「重置回原始」必须是**永远拿得回**的操作，常量是唯一不会丢的副本。
- **增量列表** `<工作区>/hsr-worldview-cache/planet-list.json`：只装「生成出来并被用户确认保留」
  的星球（`added[]`），另存 `baseline` 快照供人工核对；抓取流程永不触碰该文件。
- **三个模型工具**：`gs_planets`（原始 + 增量，可按 `source` / `query` 过滤）、
  `gs_planet_save`（并入新星球；与 27 颗重名的候选一律进 `rejected`，**绝不覆写用户设定**）、
  `gs_planet_reset`（**不带 `confirm: true` 时只回报状态、绝不改文件**）。

### 独立复核发现的 6 条问题（已全部处理）

本轮功能由**独立复核者**（未参与编写）按「攻击证据与口径」复验，报告在
[`_evidence/review-0.3.0-planets.md`](<../_evidence/review-0.3.0-planets.md>)。
核心断言独立复现成立（三个工具真注册、真落盘、真重置；27 颗与用户原话逐字一致；
22 条重名/覆写攻击路径下**无一能覆写原始描述**；不带 `confirm` 时文件 bytes/mtime/sha256 三者全等）。

| id | 级别 | 问题 | 处理 |
|---|---|---|---|
| R-1 | medium | 单批超过 `MAX_BATCH=20` 的候选被**静默丢弃**而 `ok` 仍为 true | 新增结构化 `overflow` + `warnings` 点名警告 + 回归用例 |
| R-2 | medium | 重名判定只比中文名，`ARIVANTA` / `arivanta` 能当新星球写入 | 重名判定覆盖**星球名与英文名**（大小写、空格不敏感） |
| R-3 | low | 候选的 `en` 字段仍可绕过去重 | `baselineCollision(name, en)` 同时校验 `en` |
| R-4 | low | 超长名字静默截断到 60 字 | 标记 `nameTruncated` 并写入 `warnings` |
| R-5 | low | 测试调用了**根本不存在**的 `__internals.resetPlanets`，错误被空 catch 吞掉 | 真的导出该函数，并断言重置成功（不再吞错） |
| R-6 | low | 英文名匹配略宽（`EDOSTAR` / `Edo Star` 都判成江户星） | 不改行为（多拒不可少拒、不会覆写），在注释与 README 写明口径 |

---

## 发布当天：首次真跑 GitHub 写入路径，抓出并修掉两个叠加缺陷

0.2.1 的笔记里如实留了一条债：「本机没有 GitHub 令牌，GitHub 写入路径未重跑」。
**本版把这条债还了**——第一次真跑就把它跑出来了：

```
PATCH  /repos/…/releases/397598669 -> 200            # Release 建起来了
POST_BINARY /repos/…/releases/397598669/assets?name=… -> 403   # 附件传不上去
```

403 的正文是 GitHub 的「Access to this site has been restricted.」限制页。
脚本**没有把「Release 有了、附件没有」当成功**（报 `published_incomplete` 并退出码 1）。

**第一次归因错了**：起初只怀疑主机，改完主机**再跑仍然 403**。
做了一次只变一个因子的实验（走真客户端、同一 token、同一 Release、同一份字节）才看清：

| 方法 | 主机 | 结果 |
|---|---|---|
| `POST` | `uploads.github.com` | 首次 **201**（重跑因已存在同名 **422**）|
| `POST` | `api.github.com` | **404**（该主机不服务此端点）|
| `POST_BINARY` | `uploads.github.com` | **403** + 限制页 |
| `POST_BINARY` | `api.github.com` | **403** + 限制页 |

两个缺陷叠加，各自都足以让附件传不上去：

1. **主因：伪 HTTP 方法。** 发版脚本把日志标签 `POST_BINARY` 当成了方法名，线上请求字面就是
   `POST_BINARY /repos/…/assets HTTP/1.1`。两种主机给同一个 403，正是「方法非法」的指纹。
2. **次因：主机不对。** 方法正确时 `api.github.com` 也不服务该端点（404），
   附件字节必须发给 `uploads.github.com`。

两者都长得和「token 权限不够」一样——token 实际是 `repo` 作用域、仓库 `admin`、
同一客户端刚刚 PATCH 成功。已修：方法白名单守卫 + `DEFAULT_UPLOAD_API` + `extra.upload`，
并补 4 条离线回归用例（含「非 HTTP 方法一个字节都不许上网」）。
完整证据与时间线见 [`CHANGELOG.md`](<../CHANGELOG.md>) 的 0.3.0 小节、
[`_evidence/github-publish-v0.3.0.txt`](<../_evidence/github-publish-v0.3.0.txt>) 与
[`_evidence/github-upload-host-probe.txt`](<../_evidence/github-upload-host-probe.txt>)。

> `v0.3.0` 的 tag 一开始打在了修复前的提交上。当时**一个附件都没成功上传**（`assets: []`），
> 不存在已下载的制品，因此把 tag 移到修复后的提交再传附件——让 tag 与制品描述同一棵树。

---

## 制品与验证（全部真跑，非推断）

**附件**：`dsh-history-fictionologists-0.3.0.tgz`

```
23 个文件 · 152089 字节（148.5 kB）
SHA256  DE155AA1ABD4981D0267980FA95A57818AA31C44461BC1F6A66EFFDB13C1D5C9
SHA1    DBCAD4F06F5AC3D2714108F2F42378F251078FFF
```

`files` 白名单核对：清单里**没有** `test/`、`docs/`、`_evidence/`、`_probe/`、
`node_modules/`、`hsr-missions/`、任何 `.bak` / `.log` / **令牌文件**。
制品由发版脚本自己的读回器逐字节比对过（**gzip + tar 带 mtime=0，字节确定**，
同一份源码重复构建哈希不变）。

- **离线用例**：`node --test` → **175 个用例，174 pass / 0 fail / 1 skip**
  （skip 是缺 `_probe/` 夹具那一个，与制品无关）。其中星球 22 条，发版工具链 26 条。
- **仓库自检**：`node scripts/check.mjs` → `RESULT: PASS`（语法 0 失败，测试退出码 0）。
- **`/gs` 真机加载**：`node _evidence/verify-gs-e2e.mjs` → `RESULT: PASS`
  （隔离实例，回执里的命令描述是 0.3.0 的新文案，证明加载的是改后代码），
  原始输出 [`_evidence/verify-gs-e2e-0.3.0.txt`](<../_evidence/verify-gs-e2e-0.3.0.txt>)。
- **CR 字节**：全部改动文件 `CR=0`（`.gitattributes` 钉死 LF；本仓库有逐字读自己源码的用例，
  CRLF 制品是真缺陷）。

---

## 已知限制（诚实边界）

- **模型行为本身未在真机验证**：隔离实例没有模型路由，`--model` 那一步无法完成。
  「模型真的收到了 0.3.0 的提示词」由离线断言兜底（系统提示总则里必须出现星球格式与两问，
  `/gs` 协议文本里必须出现四个功能与两问）；模型是否会照做「生成后两问」**未验证**。
- **`_evidence/prompt-section-injection.txt` 仍是 0.1.0 的抓取，对 0.3.0 已过期**（README 已注明）。
- **功能 2 / 3 依赖工作区的 `hsr-missions/`**（约 20 MB 游戏原始剧本文本，版权归米哈游，
  **不进版本库**）。缺失时插件照样装载，`gs_missions` 如实降级报告「目录缺失」。
- **`gs_update` 一轮全量约需数分钟**（站点限流决定），串行抓取以规避风控。
- **AtomGit 镜像滞后**：本版只发 GitHub，镜像站最新仍是 `v0.2.1`。

---

## 版权

代码以 **MIT** 许可发布（[`LICENSE`](<../LICENSE>)）。游戏原始素材版权归
米哈游（HoYoverse）及 Bwiki 编辑者所有，第三方内容声明见 [`NOTICE`](<../NOTICE>)。
本插件产出属**非营利性二创**。

> 本包**不在 npm registry 上**。`package.json` 里的 `private: true` 是刻意留的，
> 防止这份二创包被误发到公共 registry。

# v0.2.1 — 虚构史学家（dsh-history-fictionologists）

> 一个 DSH 插件：把《崩坏：星穹铁道》的官方世界观当作素材库，用 **`/gs`** 生成二创内容。
> 三步交互：**选功能 → 选数据更新策略 → 生成**。

**本次是工具链版本：插件运行时零变更。** `lib/shell.js` 与随系统提示注入的
「语言风格总则 + 星神纪律」一字未动（`STYLE_GUIDE` 仍是 1291 字符 / 57 行；
`git diff b8221bc -- lib/shell.js lib/wiki lib/usercanon.mjs …` 输出为空，已实测）。

这一版补的是「**怎么把它发出去**」。本机 `gh` 完全不在 PATH、`npm.cmd` 一写缓存就 `EPERM`，
所以前两次发版都卡在命令行那一步。0.2.1 起发版路径全部用纯 Node 重写，并且**新增 AtomGit 支路**——
本插件从此在 **GitHub 与 AtomGit 双平台**分发。

---

## 安装

```powershell
# 方式 A（推荐）：下载本 Release 的 .tgz 附件，再从本地路径安装
dsh plugin --profile web add C:\Users\<你>\Downloads\dsh-history-fictionologists-0.2.1.tgz

# 方式 B：AtomGit 仓库直装（国内网络更稳）
dsh plugin --profile web add https://atomgit.com/Scombriformes/dsh-history-fictionologists

# 方式 C：GitHub 仓库直装
dsh plugin --profile web add github:Kaede0614/dsh-history-fictionologists

# 方式 D：本地开发（junction 安装，改源码立即生效）
dsh plugin --profile web add link:<你的仓库路径>
```

> **AtomGit 是分发镜像，不是主仓**：`package.json` 的 `repository` / `homepage` / `bugs`
> 仍指向 GitHub。两平台并不同构，四个 API 差异见
> [`docs/atomgit-description.md`](<../docs/atomgit-description.md>)。

安装后 **必须进程级重启 DSH**——新增的 bundles 行只在启动时组合，`Ctrl+Shift+R` 热重载不生效。

验证：

```powershell
dsh --profile web --dump-config | Select-String history-fictionologists
```

应当看到一行 `- id: dsh-history-fictionologists`。

---

## 能力清单

**与 v0.2.0 完全一致**——本版没有增删任何能力、工具或配置项。

| 能力 | 触发方式 | 前置条件 |
|---|---|---|
| `/gs` 三步交互入口 | Web 输入框输入 `/gs` | 已装入 bundles + 进程级重启 |
| `gs_setup` | 模型调用 | 无（无缓存时也返回合法降级结果） |
| `gs_update` | 模型调用 | **需要联网**，本机可访问 `wiki.biligame.com` |
| `gs_read` | 模型调用 | 至少成功抓取过一次（或存在 `user-canon.json`） |
| `gs_missions` | 模型调用 | 工作区存在 `hsr-missions/` |
| `gs_digest` | 模型调用 | `equation` / `broadcast-template` 需缓存；`mission-digest` / `book-digest` 需 `hsr-missions/` |
| `gs_save` | 模型调用 | 工作区可写 |
| 系统提示「语言风格总则 + 星神纪律」 | 自动注入 | 无 |

---

## 本次新增

### 发版工具链（GitHub 与 AtomGit 双支路）

- **[`lib/release-kit.mjs`](<../lib/release-kit.mjs>)** / **[`scripts/release.mjs`](<../scripts/release.mjs>)**：
  GitHub 支路。**手工写的** gzip+tar 读写器（不调 `npm pack`，不调系统 `tar`），
  内容严格来自 `package.json` 的 `files` 白名单；REST 调用走 Node 原生 `fetch`。
- **[`lib/atomgit-kit.mjs`](<../lib/atomgit-kit.mjs>)** / **[`scripts/release-atomgit.mjs`](<../scripts/release-atomgit.mjs>)**：
  AtomGit 支路。`PRIVATE-TOKEN` 认证、按 `tag_name` 定位 Release、
  **签名两步法**传附件（`GET upload_url` → `PUT` 并原样带回 `x-obs-*` 头）。
- **[`test/release.test.mjs`](<../test/release.test.mjs>)** / **[`test/atomgit-release.test.mjs`](<../test/atomgit-release.test.mjs>)**：
  **42 个全离线用例**，HTTP 层用假 `fetch` 记录真实请求，**不触网**。

两条支路都是**幂等**的：Release 已存在走 `PATCH`，同名附件先删后传，重跑不产生重复资产。
`--publish` 前拒绝脏工作区，并扫描归档里的 CR 字节；传完附件会**再查一次** Release 与附件清单。
AtomGit 支路额外把附件**下载回来比 sha256**：API 里有一个同名附件，
和「用户下到的字节就是我们构建的字节」不是一回事。

### 发布前做了一次独立对抗式复核

复核者只读、不改文件，逐条比对官方 OpenAPI 文档、实跑单测，并用可编程假 `fetch` 专打失败路径。
结论「有条件通过」，无 blocker，但抓出 19 条问题——其中两条是**把失败当成功**，已全部修掉：

- **附件没传上去 / 下载字节不符，只打 warning 就退出 0 并报 `PUBLISHED`。**
  这正是「对象存储收下写入但不触发回调」这一平台差异唯一能被发现的信号。
  现在三种情况一律 `ERROR` + `result: published_incomplete` + **退出码 1**。
- **`--publish --dry-run` 一个字节都没写却报 `PUBLISHED`**（兄弟支路同型，一并修）。
- `upload_url` 返回空 headers 或缺一个 `x-obs-*` 时照常 PUT——现在四个必需头逐一校验，缺任一**拒绝上传**。
- PUT 判定用 `>= 400` 会把 **302 当成功**——改为 2xx 谓词。
- 先删旧附件再传新附件的**非原子窗口**——失败时明确提示「该 Release 目前没有制品 + 重跑」。
- `refs/tags/v0.2.0*` 通配会把 **`v0.2.0-rc.1` 当成 `v0.2.0` 存在**——改为精确 ref 匹配。

清单全文与每条的修复见 [`CHANGELOG.md`](<../CHANGELOG.md>) 的 0.2.1 小节。

---

## 制品与验证（全部真跑，非推断）

**附件**：`dsh-history-fictionologists-0.2.1.tgz`

```
22 个文件 · 125662 字节（122.7 kB）
SHA256  7F489EB73ED8E2C59670BAD22484E8531B6989D6BC4FA3A5F37AA6F7CD7312A0
SHA1    B3B68A9A8B0C6679456C7D5A9CF1C04D8A70E012
```

`files` 白名单核对：清单里**没有** `test/`、`docs/`、`_evidence/`、`_probe/`、
`node_modules/`、`hsr-missions/`、任何 `.bak` / `.log` / **令牌文件**。
制品用**系统 `tar -tvf` 独立复核**过（不只信自己写的读回器）：22 个条目全部列出，
与白名单逐条一致。

- **离线用例**：`node --test --test-isolation=none` → **144 个用例，143 pass / 0 fail / 1 skip**
  （skip 是缺 `_probe/` 夹具那一个，与制品无关）。
- **运行时零变更**：`git diff` 无输出（见文首）。
- **AtomGit 写入路径：已实跑**（原始输出存
  [`_evidence/atomgit-publish-v0.2.1.txt`](<../_evidence/atomgit-publish-v0.2.1.txt>)）。
  发布前先在真实平台上预演了一次 `v0.2.1-rc.1`：建仓 `POST /orgs/:owner/repos -> 200`、
  推 `main` 与 tag、建 Release、**签名两步法**上传附件（id `218037`）、
  下载回验 `sha256 4f8ec752… MATCHES`。再把同一命令**重跑一遍**打幂等路径：
  `PATCH -> 200`、`DELETE .../attach_files/218037 -> 204` 后重传得 `id=218039`、
  下载回验再次 `MATCHES`。两次均 `EXIT=0`，命令里没有 `--allow-dirty`。
- **GitHub 写入路径本版未重跑**：本机没有 GitHub 令牌，其写分支仍只有假 `fetch` 的离线用例与逻辑推演。
  这条债本版**不还**，如实留着。

---

## 已知限制（诚实边界）

- **书架的默认抽样上限**：`limit` 只在数据源配置里控制，全量抓取会更慢。
- **DSH 的 skill-name 只接受 ASCII kebab-case**，故技能注册名为 `gs`，中文名「虚构史学家」在 description 里。
- **功能 2 / 3 依赖工作区的 `hsr-missions/`**（约 20 MB 游戏原始剧本文本，版权归米哈游，**不进版本库**）。
  缺失时插件照样装载，`gs_missions` 如实降级报告「目录缺失」。
- **`gs_update` 一轮全量约需数分钟**（站点限流决定），串行抓取以规避风控。
- **AtomGit 的 Release 没有 draft 状态**（`release_status` 只有 `pre | latest`），
  因此 `release-atomgit.mjs` 不接受 `--draft`，只接受 `--prerelease`。
- **本版未重跑隔离实例的「制品验证六条」端到端**：运行时零变更，
  该证据沿用 v0.2.0 的记录（<https://github.com/Kaede0614/dsh-history-fictionologists/releases/tag/v0.2.0>）。

---

## 版权

代码以 **MIT** 许可发布（[`LICENSE`](<../LICENSE>)）。游戏原始素材版权归
米哈游（HoYoverse）及 Bwiki 编辑者所有，第三方内容声明见 [`NOTICE`](<../NOTICE>)。
本插件产出属**非营利性二创**。

> 本包**不在 npm registry 上**。`package.json` 里的 `private: true` 是刻意留的，
> 防止这份二创包被误发到公共 registry。

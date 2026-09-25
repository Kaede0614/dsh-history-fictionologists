# CHANGELOG

本插件遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 0.2.1 — 2026-09-26

**双平台发版工具链**：不再需要 `gh` CLI，也不再需要可用的 `npm`；并新增 AtomGit 支路。

起因是两次发版都撞上「没装 CLI」。查证结果是本机环境两条路都断：
`gh` 完全不在 PATH（`Get-Command gh` 为空），`winget` 虽存在但同样不可调用；
`npm` 只有 `npm.ps1`（被执行策略挡住）与 `npm.cmd`，后者一写 `%LOCALAPPDATA%\npm-cache`
就 `EPERM`（实测）。**但发布本身没失败**——仓库与 `v0.2.0` Release（含 tgz 附件、12 个 topics、
MIT 识别）都是好的，缺的只是命令行那条自动化路径。

本版把这条路补齐，并同时补上 AtomGit：本插件从此在 **GitHub 与 AtomGit 双平台**分发。
按本仓库的语义化版本表「工具链/文档 → patch」，故为 `0.2.1`；**插件运行时行为零变更**
（`lib/shell.js` 与提示词一字未动，`STYLE_GUIDE` 仍是 1291 字符 / 57 行）。

### 新增

#### GitHub 支路

- **[`lib/release-kit.mjs`](<lib/release-kit.mjs>)**：发版工具链的可测内核。
  - `parseRepoSlug` 认全 `git+https` / `git@` / `github:` 简写 / 裸 `owner/repo` 五种写法；
  - `resolveToken`：`GH_TOKEN` → `GITHUB_TOKEN` → 仓库根 `.gh-token`（已 gitignore），**从不打印 token**；
  - `extractChangelogSection` / `resolveReleaseNotes`：正文优先级
    `--notes` → `--notes-file` → `docs/release-notes-v<版本>.md` → `CHANGELOG` 对应小节；
    **全都没有时返回 null 让发版失败**，而不是发一个空正文的 Release；
  - `buildTarball` / `readTarball`：**手工写的** gzip+tar 读写器（纯 Node，不调 `npm pack`
    也不调系统 `tar`）。内容严格来自 `package.json` 的 `files` 白名单；
  - `createGitHubClient`：`fetch` 注入式 REST 客户端，支持二进制附件上传（**不经过
    `JSON.stringify`**，也不自带 `content-length`）；
  - `readRepoMeta`：从 [`docs/github-description.md`](<docs/github-description.md>) 按**形状**
    （围栏里的裸 topic 列表）取 About 描述与 topics，避免文档与仓库设置各说各话；
  - `describeApiFailure`：把 401 与 403 分开报，因为「没 token」和「token 权限不够」修法不同。
- **[`scripts/release.mjs`](<scripts/release.mjs>)**：发版命令。
  - 默认**只预演**（把将要打的每个 API 都打出来）；`--publish` 才真写；
  - 幂等：Release 已存在走 `PATCH`，同名附件先删后传，重跑不产生重复资产；
  - `--publish` 前会**拒绝脏工作区**（`--allow-dirty` 可越过），
    并在归档里扫 CR 字节并告警——本仓库有「读自己源码逐字断言」的用例，CRLF 制品是真缺陷；
  - 传完附件后**复查** Release 与附件清单，并在 `--json` 下输出结构化结果；
  - `--sync-meta` 顺带同步 About 描述与 topics；`--draft` / `--prerelease` / `--no-asset` 等常规开关。
- **[`test/release.test.mjs`](<test/release.test.mjs>)**：22 个全离线用例。HTTP 层用假 `fetch`
  记录真实请求（方法/URL/头/体），**不触网**；tgz 层把 `buildTarball` 的产物用
  `readTarball` 逐字节读回来比对，并用仓库真实的 `files` 白名单整体打一遍。

#### AtomGit 支路

AtomGit 不是「换了个域名的 GitHub」。四条实测差异各自能让一次照搬的发布**静默失败**：
认证头是 GitLab 风格的 `PRIVATE-TOKEN`；Release 响应里**没有数字 `id`**，只能按 `tag_name` 定位；
**没有** `POST /releases/:id/attach_files`（返回 404），附件走**签名两步法**；
**同名附件覆盖不生效**——PUT 返回成功，用户下到的还是旧文件。详见
[`docs/atomgit-description.md`](<docs/atomgit-description.md>)。

- **[`lib/atomgit-kit.mjs`](<lib/atomgit-kit.mjs>)**：AtomGit 的可测内核。
  - `parseAtomgitSlug` 认全 `git+https` / `git@` / `ssh://` / `atomgit:` 简写 / 裸 `owner/repo`，
    并**明确拒绝 GitHub 地址**——`--repo` 指错平台会静默发到同名仓库，这条 guard 就是防它的；
  - `resolveAtomgitToken`：`ATOMGIT_TOKEN` → `ATOMGIT_ACCESS_TOKEN` → 仓库根 `.atomgit-token`（已 gitignore）；
  - `createAtomgitClient`：认证走 **`PRIVATE-TOKEN` 头**；
  - `uploadReleaseAsset`：**签名两步法**——先 `GET …/releases/:tag/upload_url?file_name=…`
    拿 `{url, headers}`，再把 `x-obs-*` 头**原样**带回 `PUT`。少一个头，对象存储要么拒绝、
    要么写入成功但**回调不触发**（附件在页面上根本不出现）；
  - `buildAtomgitReleaseBody`：创建与更新发送**同一个完整 body**，因为该平台的
    `PATCH /releases/:tag` 不接受部分更新；`release_status` 只有 `pre | latest`，**没有 draft**；
  - `describeAtomgitFailure`：401 / 403 / 404 分开报，并**把必需的 scope 清单写进 403 的正文**——
    实测「令牌有效但一个 scope 都没勾」是本站最像「令牌坏了」的失败
    （`no scopes:read_user` 与 `CH.00000403 apig token has not permission to request url`
    两种报错、同一个根因），光看状态码根本修不对。
- **[`scripts/release-atomgit.mjs`](<scripts/release-atomgit.mjs>)**：AtomGit 发版命令。
  - 默认只预演，且预演**按真实执行顺序**打印调用（初版按代码排布打印，顺序与实跑不符，已改）；
  - `--create-repo`：仓库不存在时走 `POST /orgs/:owner/repos` 建仓（`public` 是整数 0/1）；
  - 幂等：Release 已存在走 `PATCH`；**同名附件先 `DELETE` 再传**——该平台同名覆盖不生效，
    这是必须的一步而不是优化；
  - 传完把附件**下载回来比 sha256**：「API 里有一个同名附件」与「用户下到的字节就是构建的字节」
    不是一回事；
  - 令牌不进 argv、不进日志：API 走请求头，`git push` 走一次性 `credential.helper`
    （先 `-c credential.helper=` 清空继承来的 helper，否则本机 Git Credential Manager
    不认识 `atomgit.com`，会退回交互式提示）；
  - 沿用 GitHub 支路的脏工作区拒绝、CR 字节扫描、`--json` 结构化输出与「没有正文就失败」。
- **[`test/atomgit-release.test.mjs`](<test/atomgit-release.test.mjs>)**：20 个全离线用例。
  签名两步法用假 `fetch` 逐字节核对（第二步必须带上全部 `x-obs-*` 头、body 是 Buffer 而非 JSON、
  **令牌不得跟到对象存储**），并有「`upload_url` 没给 headers 时**不许**自作主张 PUT 上去」的反例。
- **[`docs/atomgit-description.md`](<docs/atomgit-description.md>)**：平台差异备忘 + About 文案 +
  实测探针原始输出。`lib/atomgit-kit.mjs` 的文件头引用它作为「那四条差异从哪来」的依据。

#### 共同

- **`package.json`** 补 `release:plan` / `release:publish` / `release:atomgit:plan` /
  `release:atomgit:publish` 四个脚本；**`.gitignore`** 加 `.gh-token` 与 `.atomgit-token`。
- **README 安装章节**补 AtomGit 直装地址，并写明「**AtomGit 是分发镜像，不是主仓**」——
  `package.json` 的 `repository` / `homepage` / `bugs` 仍指向 GitHub，不改成其中之一。

### 验证

- `node --test --test-isolation=none`：**148 个用例，147 pass / 0 fail / 1 skip**
  （本版新增的 22 + 24 = 46 个全过；skip 仍是缺 `_probe/` 夹具那一个）。
- **制品独立交叉验证**（不只信自己写的读回器）：把 `dsh-history-fictionologists-0.2.1.tgz`
  交给**系统 `tar -xzf`** 解包，与工作区逐文件比 SHA256 —— **22 个条目 / 22 MATCH / 0 MISMATCH**；
  `tar -tf` 列出的 22 条与 `files` 白名单一致；解包出的 `lib/shell.js` **CR 字节 0**
  （`.gitattributes` 生效）。制品的 SHA256/SHA1 与字节数记在 `docs/release-notes-v0.2.1.md`
  ——**故意不写进本文件**：`CHANGELOG.md` 本身在 tgz 里，把哈希写进来就成了自指，哈希会随之变化。
- 预演输出实测：正确定位 `main` / HEAD、识别 `v0.2.0` **已在远端**、
  正文取自 `docs/release-notes-v0.2.0.md`（3774 字符）。
- **AtomGit 只读探针**（`_evidence/atomgit-probe.mjs`，输出落在 `_evidence/atomgit-probe.txt`）：
  确认账号存在；确认**带令牌**时「仓库不存在」稳定回 **404 `Project not found`**。
  同一件事在别的条件下会给出别的码——匿名访问裸仓库端点**两次跑分别得到 401 和 404**
  （同一请求、两个答案），`git ls-remote` 给 403。因此 `lib/atomgit-kit.mjs` 里定了一条硬规矩：
  **绝不从「未授权响应」推断任何事**，只看带令牌的结果。

### 独立复核与修复（发布前）

本版在发布前做了一次**独立对抗式复核**：复核者只读、不改任何文件，逐条比对官方 OpenAPI 文档、
实跑 20 个单测，并用可编程假 `fetch` 专打失败路径。结论「有条件通过」，无 blocker，
但抓出 19 条问题，其中两条是**把失败当成功**。已全部修掉：

- **附件没传上去 / 下载字节不符，只打 warning 就退出 0 并报 `PUBLISHED`**（high）。
  这正是第 4 条平台差异唯一能被发现的信号——脚本自己做下载回验就是为了抓它，抓到却不失败。
  现在三种情况一律 `ERROR` + `result: published_incomplete` + **退出码 1**：
  附件未列在 Release 上、下载回来的 sha256 不符、回验根本跑不起来。
- **`--publish --dry-run` 一个字节都没写却报 `PUBLISHED`**（high，**兄弟支路同型**）。
  两个开关现在互斥，用法错退出 2；`scripts/release.mjs` 一并修。
- `upload_url` 返回空 headers 或缺一个 `x-obs-*` 时照常 PUT（medium）——现在四个必需头逐一校验，
  缺任一就**拒绝上传**。那正是「写入成功但回调不触发、附件永不出现」的成因。
- PUT 判定用 `>= 400` 会把 **302 当成功**（medium）——改为 2xx 谓词 `isSuccessStatus`。
- 先 `DELETE` 旧附件再 PUT 新附件的**非原子窗口**（medium）——失败时现在明确打印
  「附件已被删除、该 Release 目前没有制品、重跑命令」，并带上对象存储的原始错误体
  （OBS 的 `<Code>SignatureDoesNotMatch</Code>` 是唯一有用的诊断）。
- `/releases/tags/${tag}` **未转义**（medium）——`release/1.0` 这类合法 tag 会走错路由并重复建 Release。
- 建仓把 **400 当「已存在」**（medium）——官方语义里 400 是「缺必需属性」，只有 409/422 才算已存在。
- `refs/tags/v0.2.0*` 通配把 **`v0.2.0-rc.1` 当成 `v0.2.0` 存在**（medium，**兄弟支路同源**）——
  会让脚本跳过推 tag，再由服务端在默认分支 tip 上建 tag，而日志说「already on the remote」。
  改为精确 ref 匹配，`scripts/release.mjs` 一并修。
- **远端** tag 指向旧 commit 的告警丢失（medium；`tagState.peeled` 成了死代码）——已补回。
- 预签名 OBS URL（含 `AccessKeyId`/`Signature`）会被 `JSON.stringify` 写进异常文本（low）——已脱敏。
- `export ATOMGIT_TOKEN=…` 粘贴不被剥离，整行被当成令牌（low，兄弟支路同型）——已修。
- `--skip-tag-push` 在 tag 本地与远端都不存在时静默放过（low）——现在报错退出 1。
- 远端缺失时日志仍打印「git ls-remote failed」，与上一行自相矛盾（low）——已按情况分措辞。
- 新增 4 个离线用例覆盖上述失败路径（非 2xx PUT、`headers: {}`、缺单个必需头、`export` 粘贴），
  并加一条**结构性断言**守住脚本层不变量——脚本在加载时就跑 `main()`、无法 `import`，
  这一点在用例里写明了，没有假装它是行为测试。

复核者另外确认了两件「不是缺陷」的事，避免过度修正：`PRIVATE-TOKEN` 写法、四个 Release 端点
路径与方法、建仓 body 字段、`release_status: pre|latest`、`assets[]` 字段名，都逐条对得上官方文档。

- **未验证**：GitHub 支路的 `--publish` **真实写入路径**仍未实跑过（本机没有 GitHub 令牌），
  写分支只有假 `fetch` 的单元测试与逻辑推演。按本仓库的纪律**只记「未验证」，不记「通过」**。
- **未验证**：`--sync-meta` 未对真实 GitHub 仓库执行过（同样因为无令牌）。

## 0.2.0 — 2026-09-26

新增**用户设定补充层**（`hsr-worldview-cache/user-canon.json`）：把你的设定裁定与抓来的缓存
分开存放，并让它在模型面前明确压过缓存。

### 新增

- **[`lib/usercanon.mjs`](<lib/usercanon.mjs>)**：只读、永不抛错的裁定层读取与匹配。
  - 位置 `<工作区>/hsr-worldview-cache/user-canon.json`，**抓取永远不会改写它**——
    `gs_update` 只原子重写 `<数据集>.json`，把裁定塞进数据集文件里会被下一次抓取抹掉。
  - `dataset` 作用域（`aeons` / `aeon` 都认，`"*"` 或省略 = 全局）、`match` 关键词触发、`note` 必填。
  - 文件缺失 = 0 条（正常状态）；损坏 / 非法 JSON = 0 条 + 告警，不影响缓存与其它工具。
- **`gs_read`**：结果新增可选 `userCanon` 数组；渲染文本末尾追加
  「### 用户设定补充（优先于上方缓存文本，冲突时以此为准）」。无缓存（含 wiki 子模块不可用）时
  仍然交付裁定——那正是它最该出现的场景。
- **`gs_setup`**：结果新增必填对象 `userCanon: { count, updatedAt, path }`，并在文本里报告条数。
- **风格总则**：新增优先级规则「用户设定补充优先于缓存」；`/gs` 协议「硬性要求」同步收口。
- **仓库自带** [`hsr-worldview-cache/user-canon.json`](<hsr-worldview-cache/user-canon.json>)，
  第一条裁定即本次评审的贪饕口径（奥博洛斯已四分五裂、被镇压，不得写成失踪待返或归来）。

### 验证

- `node --check`：13 个模块全过。
- `node --test --test-isolation=none`：**102 个用例，101 pass / 0 fail / 1 skip**（约 2.1 秒，全离线）。
- 新增 [`test/usercanon.test.mjs`](<test/usercanon.test.mjs>)（8 个用例）：缺失 / 损坏 / 缺 `note` 的降级、
  作用域与单复数别名、query 命中（含「返回条目命中关键词」）、`gs_read` 结果与渲染文本、
  `gs_setup` 渲染文本、「不与任何 `<dataset>.json` 撞名」的抓取安全断言，以及仓库自带文件的真实解析。
- 实测真实文件：`readUserCanon(工作区)` → `count=1, ok=true, warnings=[]`；
  `matchUserCanon(canon, { dataset: 'aeons' })` 返回贪饕裁定全文。
- `STYLE_GUIDE` 长度 `1161 → 1291` 字符（57 行）。
- **未验证**：真机系统提示注入未重新取证（需要隔离实例重启；本机日常实例不重启）。

### 首次公开发布（GitHub）

- **仓库只分发插件本体 + 测试 + 文档**：`lib/`、`test/`、`scripts/`、`docs/`、`_evidence/`、
  `BRIEF.md`、`cordis.patch.yml`、`package.json`、`README.md`、`CHANGELOG.md`、`LICENSE`、
  `.gitignore`、`.gitattributes`，外加手工维护的 `hsr-worldview-cache/user-canon.json`。
  游戏原始剧本文本（`hsr-missions/`，约 20 MB）、抓取缓存、原始渲染 HTML（`_probe/`，4.9 MB）
  与本机成品**不入库**——体积与版权两头都不合适。被忽略的目录仍留在作者工作区（不删除任何文件）。
- 新增 [`LICENSE`](<LICENSE>)（**逐字 MIT**，与 `package.json` 的 `license` 字段一致）与
  [`NOTICE`](<NOTICE>)（第三方内容声明：MIT 只覆盖作者编写的代码与文档，
  游戏素材版权归米哈游及 Bwiki 编辑者）。
  两者**分开是有原因的**：第一版把声明追加在 `LICENSE` 尾部，GitHub 的许可证识别直接报
  `NOASSERTION / Other`（实测）；拆成独立 `NOTICE` 后识别为 `MIT`。
- 新增 [`.gitattributes`](<.gitattributes>)：`* text=auto eol=lf`。**这不是洁癖**——套件里有
  「系统提示里的风格总则必须与 `STYLE_GUIDE` 逐字节一致」这类**读自己源码做逐字断言**的用例，
  Windows 上 `core.autocrlf=true` 的克隆会把源码转成 CRLF，断言会莫名其妙地失败。
  实测：克隆后 `lib/shell.js` 的 CRLF 计数为 0。
- `package.json` 补 `repository` / `homepage` / `bugs`；README 安装章节由「npm」改写为 GitHub 分发
  （Release tarball / `github:` 直装 / 本地 `link:`）。**`private: true` 是刻意留的**，不发公共 registry。
- 制品：`npm pack` → `dsh-history-fictionologists-0.2.0.tgz`，19 个文件 / 包体 89.9 kB；
  `files` 白名单核对过，清单里没有 `test/`、`_evidence/`、`_probe/`、`node_modules/`、`.bak`、日志。
- `_evidence/verify-gs-e2e.mjs` 新增 `--package <spec>` / `--home <dir>` / `--ws <dir>`：
  让这套端到端验证能针对**打包制品**（而不是源码 `link:`）跑，默认行为逐字不变。
  它现在会先跑真实的 `dsh plugin add`，再从**部署位置** `import()` 全部 13 个模块——
  这正是「源码能跑、包不能跑」（`files` 漏文件 / `exports` 写错）会被抓到的一步。

### 测试：夹具缺失时显式 skip（让克隆可跑）

`test/` 有一层用例重放 `_probe/html/*.html` 与真实语料 `hsr-missions/`，而这两份数据按上面的理由
不进版本库。此前它们在全新克隆里会**失败**（实测 32 fail）——那等于「公开仓库一克隆就是红的」。

- [`test/wiki.test.mjs`](<test/wiki.test.mjs>) 与 [`test/missions.test.mjs`](<test/missions.test.mjs>)
  改用具名 skip：夹具不在本检出时跳过，并**在 skip reason 里点名缺哪个文件**。
  **零条断言被改写或删除**（`git diff` 审查：`-` 行只有 `it(...)` 的签名变形，`assert` 删除行数为 0）。
- 一处混合用例 `copes with garbage cfg values instead of throwing` 只跳过依赖真实语料的后半段，
  与磁盘无关的 junk-config 那半段照跑。
- 结果：`_probe/` 与 `hsr-missions/` 都在时 **102 用例 / 101 pass / 0 fail / 1 skip**（与改动前逐字一致）；
  两者都不在时 **102 用例 / 70 pass / 0 fail / 32 skip**。70 条与磁盘无关的用例
  （`client:` 限流与 WAF 重试、HTML/wikitext 解析、合成缓存降级、规范 JSON 等）在任何检出里都照跑。
- `test/host-validator.test.mjs` **保持硬失败**：它要解析宿主的 `validateJsonSchemaValue`，
  没装 dsh 时是 `10 fail / 2 pass / 0 skip`（实测）。刻意不改成 skip——这一层的存在意义就是
  证明其余断言不是恒真的，静默跳过会把「已验证」变成空话。
- **未验证**：只在 Windows + node v24.21.0 上跑过；未在 Linux/macOS 或其它 node 版本上验证。

## 0.1.1 — 2026-09-26

产品规则修正：**星神不出场，神人自己才是主角**。

### 修正

- 用户在评审中指出：神人制造机此前把星神写成了出场角色（末王散出的黑猫群、克里珀的施工现场、
  迷思的思想之雨、奥博洛斯的失踪线索），而按设定这些存在早已陨落、失踪或不可能现身。
  已把「星神只作背景」固化成插件规则，而不是靠每次口头交代。

### 新增

- **风格总则里新增「星神纪律」**（四个约束，三个功能共同适用，随系统提示自动注入）：
  1. **星神不出场**——星神、令使与星神级存在不得作为角色行动、说话、现身或与神人互动，
     只能以背景、传闻、缺席、遗迹、别人嘴里的说法存在。
  2. **命途只是标签，不是靠山**——〈主命途〉/〈次命途〉描述气质与活法，不等于赐福；
     禁止「被某位星神选中」「获得星神的力量」这类金手指。
  3. **已陨/失踪/消亡的星神一律不得写成在世**——点名繁育（塔伊兹育罗斯）、贪饕（奥博洛斯）、
     秩序（太一）、不朽（龙）、纯美（伊德莉拉）、开拓（阿基维利）；绝不现身、绝不复归、绝不「被惊动」。
  4. **神人自己才是主角**——写他自己的职业、麻烦、账单、家人与出路；
     荒诞来自「命途概念 × 市井生活」的错位，而不是「他和星神很熟」。
- **`/gs` 注入协议同步收口**：功能 1 的取材清单不再点名「星神」
  （改为派系/专有名词/奇物/遗器），并在「硬性要求」里带上星神纪律。
- **[`test/plugin.test.mjs`](<test/plugin.test.mjs>)** 新增 2 个用例（+ 1 条断言）：
  风格总则必须含四条规则并点名贪饕/繁育；`/gs` 协议文本必须带上星神纪律，
  且不得再出现「再 gs_read 取星神/」这种取材指引。

### 验证

- `node --check`：12 个模块全部通过（`node scripts/check.mjs` 在本机沙箱里会因
  `child_process.spawn` 被拒（EPERM）而无法收集子进程输出，改用
  `node --test --test-isolation=none` 直接跑）。
- `node --test --test-isolation=none`：**94 个用例，93 pass / 0 fail / 1 skip**（约 1.9 秒，全离线）。
- `__internals.STYLE_GUIDE.length`：`725 → 1161` 字符（55 行）。README 里的 725 字符证据是
  0.1.0 的抓取快照，已就地标注版本，未改写历史证据。
- **未验证**：新文案在真机系统提示里的注入尚未重新取证（需要隔离实例重启一次抓会话日志）；
  本机日常实例不作重启。

## 0.1.0 — 2026-09-26

首个可用版本。

### 新增

- **`/gs` 命令**：三步交互入口
  1. 功能选择（神人制造机 / 构史文集 / 星际构史播报）
  2. 世界观数据更新策略（Y 重新抓取 / N 使用本地缓存）
  3. 执行所选功能

  命令 handler 本身**不调用模型**：它本地读取缓存与既有故事状态，把交互协议作为一条
  plugin 来源的用户消息交给当前 agent，并返回一行回执。

- **6 个模型工具**
  - `gs_setup` — 缓存状态、`lastUpdated`、陈旧判定与 Y/N 建议
  - `gs_update` — 12 个数据源增量抓取（`revid` 短路；失败保留旧缓存并如实上报）
  - `gs_read` — 按数据集读取条目（支持关键词过滤、分页、单条截断标记）
  - `gs_missions` — 既有故事目录（避免新故事与已发生事件冲突）
  - `gs_digest` — 方程命名逻辑 / 已发生故事 / 书架风格 / 播报格式四类素材
  - `gs_save` — 成品落盘到 `hsr-stories/` 与 `hsr-broadcasts/`

- **世界观数据抓取**：12 个 biligame Wiki 数据源（遗器来历、光锥故事、消耗品介绍、
  装饰介绍、星神、派系、专有名词、模拟宇宙开发日志、奇物、事件、方程、星际和平播报），
  含用户指定的两条过滤规则（消耗品排除翁法罗斯；事件与方程排除「千面英雄」模式）。

- **缓存机制**：`<工作区>/hsr-worldview-cache/` 按数据集分文件，每个文件带
  `lastUpdated` / `revisionId` / `pageSha` / `count` / `warnings`，另有 `index.json` 汇总；
  写入走「临时文件 + rename」原子替换；抓取失败绝不清空已有缓存。

- **反爬应对**：请求间隔限流（默认 2000 ms）、浏览器 UA + Referer、把 WAF 的非 JSON
  响应（HTTP 567）识别为可重试失败、指数退避、失败回退缓存并明确告知用户。

- **系统提示词段落**：「虚构史学家语言风格总则」——以「方程一览」为基准，用最严肃的
  格式包装最离谱的内容，并逐字固化三个功能的输出格式。

### 工程说明

- 零运行时第三方依赖（自带 HTML 表格/卡片解析与 wikitext 模板解析）。
- `@deepseek-ai/*` 全部走多 base 可选解析链，解析不到时降级而不是崩溃；
  `Config` 解析不到 Schemastery 时导出 `undefined`（避免整棵插件树崩）。
- 所有注册走 `ctx.effect()`；`apply` 不是 async，注册前无 `await`（无卸载窗口竞态）。
- 工具输出保证规范 JSON：无嵌套 `undefined`、无非有限数字、可选键不出现 `null`。
  最后一条是实测出来的：宿主用 `validateJsonSchemaValue` 校验返回值，可选 `string` 键若为
  `null` 会让**每一次成功调用**都以 `returned invalid output` 失败。
  `test/host-validator.test.mjs` 直接调用宿主同一个校验器覆盖 6 个工具的全部降级路径。
- 包入口是 `lib/shell.js`（不是 `lib/index.js`）：一次编辑事故把后者写成了非 UTF-8 字节，
  安全修复是换文件名并让 `package.json` 的 `main`/`exports` 指过去。
- 测试：`npm test` → 91 个用例，**全部离线**（离线重放真实抓取到的 HTML + mock ctx 契约 +
  宿主校验器一致性），约 1.5 秒。1 个 skip 是「尚未做 live capture 时」的占位断言。

### 独立复核与打回修复（2026-09-26）

复核者未参与编写被复核文件，判定 `needs_revision`，提 10 条 finding。已全部处置：

| id | 级别 | 处置 |
|---|---|---|
| F1 | high | **复核者发现我自己的断言是恒真的**：`validateJsonSchemaValue` 返回「违规字符串数组」，而测试写的是 `result.valid !== false` → 空数组与非空数组都通过，等于零覆盖。已改为 `assert.deepEqual(violations, [], …)`，并补一条元测试证明该断言**能失败** |
| F2 | medium | Schemastery 不拒绝 `NaN`/`Infinity`；非有限配置值会被 `lossless` 丢键 → **required 键缺失** → 宿主必然拒绝。已在读取处加 `num()` 有限性钳制，并在 Config schema 补 `.min()/.max()`，让坏配置在加载期就响亮失败 |
| F3 | medium | 标注「no network」的用例实际做了全量 12 数据集抓取。已改为走 `wiki` 子模块缺失分支；测试套件从 49 秒降到 1.5 秒，且真的不联网 |
| F4 | medium | mock 丢弃 disposer，「注销链坏掉 / 重复注册」不可观测。已让 mock 返回**真注销函数**并断言：卸载后 0 残留、二次 dispose 安全、重载后仍恰好 6 工具 / 1 命令 / 1 section |
| F5 | low | `counts` 用 `wanted.size === 0` 当「无过滤」哨兵，与「请求的数据集全部失败」撞车 → 会列出未请求的数据集。已改为显式 `requestedIds`，并优先采用 `update()` 自带的 `counts` 对象 |
| F6 | low | `gs_save` 把标题原样插进 YAML front-matter，多行标题可注入键。已改为 `JSON.stringify(title)`（合法 YAML 双引号标量） |
| F7 | low | `/gs` 的「约 N 天前」缺下界钳制（`gs_setup` 有），未来时间戳会渲染成负数。已统一 `Math.max(0, …)` |
| F8 | low | 不可解析的 `lastUpdated` 被原样回显，`advice` 却断言「已超过 7 天」。现在丢弃该时间戳、加告警，并明确说「新鲜度未知，按建议更新处理」 |
| F9 | low | 子模块返回非数组 `failed` / `null` status 会抛 TypeError。已在 5 个读子模块的工具里全部加形态守卫 |
| F10 | info | 唯一静态检查告警是缺五语 README —— 有意不写（中文单语项目），保留告警 |

复核者同时记录了「查过、未发现」的类别：`Config` 是真 schema、无硬 `@deepseek-ai/*` import、
`apply` 同步且注册全在 effect 内、无可达的 lossless 违规、返回键与声明键双向一致、
`CommandDefinition` 形态合法、`/gs` 在 7 种恶意调用下都不抛、`safeFileName` 能挡住
`..\..\evil`/空/超长标题、四个 digest 在真实缓存上分别产出 4285/2598/2158/3141 字
（没有静默降级成空）。

复核报告：[`_evidence/review-shell.md`](_evidence/review-shell.md)。

### 产品级验证：指导确实到了模型手里

插件「注册成功」不等于「模型收到了该怎么写」。已用可复现脚本从隔离实例的真实会话日志里
**解析**注入记录（`node _evidence/check-prompt-section.mjs`）：

```
record type=system/message  role=system  chars=3500
gs_* tools in the request tool list: gs_digest, gs_missions, gs_read, gs_save, gs_setup, gs_update
  YES  章节标题 / 风格总则（用最严肃的格式包装最离谱的内容）
  YES  功能 1 四个字段（【灵感名称】/命途归属/一句话简介/详细设定/可能的故事方向）
  YES  功能 2（构史文集 · 默认约 2000 字 · 荒诞但不轻浮）
  YES  功能 3（女声：/男声：/（音乐）/本次播报到此结束/800–1200 字）
  YES  「不得凭空编造与既有设定冲突的事实」
```

即：**风格总则（本体 725 字符）与三个功能的逐字格式进入了那条 3500 字符的组装后系统提示，
6 个 `gs_*` 工具同时在请求的工具列表里**。
原始输出：`_evidence/prompt-section-injection.txt`。

> 口径更正（复核者 R3-5）：我先前的说法「3500 字的风格总则」是夸大——3500 是**整条系统提示**的
> 长度，风格总则本体是 725 字符（`__internals.STYLE_GUIDE.length`）。复核者另做了更强的一致性检查：
> 日志里的风格文本 `includes(STYLE_GUIDE) === true`，与当前源码逐字节一致。

### 复核第 3 轮：**pass**（含 1 条 low + 4 条 info 的收尾）

判定 pass，无 blocker/high/medium。收尾项全部处理：

| id | 级别 | 处置 |
|---|---|---|
| R3-1 | low | `canonicalDatasetId()` 少了 `trim()/toLowerCase()`，而数据层的 `resolveDatasetId()` 两者都做 → `['Equations']` / `[' equations ']` / `['EQUATION']` 会丢 `counts`。已对齐归一化；实测 6 种写法（含 `EQUATIONS`）全部命中，未知 id 仍为空 |
| R2-5 | low | 时钟缝返回非有限数会静默关闭限流。已改为**逐次调用**守卫（`Number.isFinite(Number(impl())) ? v : Date.now()`），并补回归：`NaN`/`±Infinity`/非数字 四种情况下必须仍恰好 sleep 一次 ~1500ms |
| R3-2 | info | 第二个缝场景的还原没在 `try/finally` 里。已包进 `finally` |
| R3-3 | info | `scripts/check.mjs` 的 `walk()` 只递归名字叫 `wiki` 的目录。已改为递归所有子目录（当前检查 12 个模块） |
| R3-4 | info | `restore()` 不可 LIFO 组合（一律把闩锁置 false，内层还原会取消外层 stub）。已改为**捕获并还原 `wasLoaded`**，并补「内层还原后外层 stub 仍生效」的断言 |
| R3-5 | info | 文档把「3500 字」说成风格总则长度。已在上文更正为 725 字符并写明口径 |

复核者同时确认：`scripts/check.mjs` 是诚实的（12/12 模块、失败必 FAIL、`null` status 也 FAIL、判定不依赖解析出的摘要）、
无第二个 flaky/时间依赖/日期腐烂实例、`canonicalDatasetId()` 无误匹配也无重复计数、
任何还原顺序都不会留下错句柄、「92 tests / 1 skip」诚实（那 1 个 skip 是「本机已有缓存」时的条件跳过，干净克隆里会执行）。

### 又一个被自己抓到的假绿：限流测试其实是 flaky

连续跑 6 次全量测试时，`client: throttle gap is enforced and never below 1500ms` **失败了 2 次**。
根因：该测试只注入了 `sleepImpl`，节流判断里仍然读真实 `Date.now()`——若第一个请求恰好耗时超过
1500ms（机器有负载时就会），第二次请求就不需要 sleep，于是「存在 ≥1500ms 的 sleep」这个断言失败。

修法是给 `WikiClient` 补 `nowImpl` 时钟接缝（与既有 `sleepImpl` 同一风格），让测试冻结时间并手工推进，
断言从「存在某个 sleep」改为「恰好一次 1500ms」，并补一条反向对照（时间已越过间隔 → 不得 sleep）。
修后连续 **8 次全量运行 0 失败**。

这类「计时断言在负载下偶发失败」的测试比没有测试更危险：它会让绿色的 CI 变得不可信。

### 复核第 2 轮（3 条新 finding，全部处置）

复核者确认第 1 轮 9 条**全部验证修好**，并给出 3 条新 finding：

| id | 级别 | 处置 |
|---|---|---|
| R2-1 | medium | **项目自己的测试命令跑不起来**：`node --test test/`（带斜杠）在 Node 24 上报 `Cannot find module ...\test`，而且 Node 不会替 npm script 展开 glob。已把 `npm test` 改成裸 `node --test` 自动发现，新增 `scripts/check.mjs`（语法检查 11 个模块 + 全套测试），README 首选命令改为 `node scripts/check.mjs`。顺带记录：本机 PATH 里只有被策略禁止的 `npm.ps1`，`npm test` 在 PowerShell 里同样跑不起来（`cmd /c "npm test"` 可通） |
| R2-2 | low | **别名 id 让 counts 变空**：`gs_update({datasets:['equation']})` 用调用方的原始 id 去比对数据层回报的规范复数 id，于是 `counts: []`。已加 `canonicalDatasetId()` 归一化，并补回归测试；该测试已用「还原成修复前实现」的变异验证过**确实会失败**（`AssertionError: singular alias 也必须拿到 counts，实际：[]`） |
| R2-3 | low | **stub 接缝的恢复路径会把插件钉死在降级态**：只换回句柄而不清「已加载」闩锁，会让 `wiki: null` 永久生效。`stubSubmodules()` 现在返回 `restore()` 闭包（恢复句柄 + 清闩锁），测试相应改为 `try/finally restore()`，并新增一条「stub 成 null → restore → 必须回到真实子模块」的断言 |

另按复核建议收紧一条偏松断言：不可解析时间戳的检查从真值判断改为
`assert.equal('lastUpdated' in value, false)`（空串会逃过真值判断）。

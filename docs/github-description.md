# GitHub 仓库描述文案（dsh-history-fictionologists）

> 事实来源：`package.json`（v0.2.0 / MIT / `private: true`）、`README.md`、`lib/shell.js`（6 个 `gs_*` 工具）、
> 实跑 `node --test`（102 用例 / 101 pass / 1 skip / 0 fail / 约 1.5 秒）。
> 所有数字都可回查，未编造。
>
> 本文只是**文案备料**：About 描述、Topics、长描述、电梯陈述，复制粘贴用。

---

## 1. About 短描述（GitHub 上限 350 字符）

**主选（中文，105 字符）**

```
基于《崩坏：星穹铁道》官方世界观的 DSH 二创插件（/gs）：神人制造机出科幻灵感、构史文集写短篇、星际构史播报编新闻；12 个 Wiki 数据源增量抓取并本地缓存，抓不到就自动回退缓存。非营利二创，MIT。
```

**备用（中文，92 字符，更短）**

```
基于《崩坏：星穹铁道》官方世界观的 DSH 二创插件（/gs）：灵感、短篇、虚构播报三种产出，12 个 Wiki 数据源增量抓取 + 本地缓存 + 用户设定裁定层。非营利二创，MIT。
```

**英文（226 字符，面向英文检索）**

```
A DeepSeek Harness (DSH) plugin (/gs) for Honkai: Star Rail fan fiction - generates sci-fi story ideas, short stories and fake interstellar news from 12 incrementally cached Bwiki datasets. Unofficial, non-commercial fan work.
```

---

## 2. Topics（GitHub 标签，最多 20 个）

```
dsh
dsh-plugin
deepseek-harness
honkai-star-rail
star-rail
fanfiction
worldbuilding
ai-agent
llm
plugin
wiki-scraper
mit-license
chinese
```

> 规则提醒：topic 只能小写字母、数字、连字符，且必须以字母或数字开头。
> `dsh-plugin` 是这套生态里最关键的发现入口，`honkai-star-rail` / `fanfiction` 负责吸引非 DSH 用户。

---

## 3. 长描述（仓库介绍页 / Release 正文 / 投稿用）

**dsh-history-fictionologists · 虚构史学家**

把《崩坏：星穹铁道》的官方世界观当作素材库，用一个 `/gs` 命令产出二创内容。
风格基调参考游戏内「差分宇宙 · 方程一览」——**用最严肃的格式包装最离谱的内容**。

三种产出：

- **神人制造机**：3–5 条全新科幻灵感（灵感名称 / 命途归属 / 一句话简介 / 详细设定 / 可能的故事方向）
- **构史文集**：默认约 2000 字短篇，先读既有故事避免冲突，参考「书架」书籍风格
- **星际构史播报**：3–5 条虚构新闻，固定「女声 / 男声 +（音乐）」播报格式，800–1200 字

数据分两层，这是它和普通「提示词模板」的区别：

- **事实层**：12 个 biligame Wiki 数据源（星神 / 派系 / 专有名词 / 遗器 / 光锥 / 奇物 / 方程 / 事件 / 播报等），
  按页面 `revid` 增量抓取，相邻请求限流 2 秒，被 WAF 拦截时指数退避；
  **抓取失败保留旧缓存并如实上报**，不会静默失败。
- **裁定层**：`hsr-worldview-cache/user-canon.json`，你手工维护的设定裁定。
  它附在 `gs_read` 结果末尾并标注「冲突时以此为准」，而**抓取永远不会改写这个文件**。

三步交互：**选功能 → 选数据更新策略（Y 重抓 / N 用缓存）→ 生成**。`/gs` 的 handler 本身不发模型请求，
只做本地状态读取与协议注入。

```powershell
dsh plugin --profile web add github:Kaede0614/dsh-history-fictionologists
# 安装后必须进程级重启 DSH：新增的 bundles 行只在启动时组合
```

两个注意事项：本插件**不在 npm registry 上**（`private: true` 是刻意留的，防止二创包被误发到公共源）；
功能 2 / 3 需要自备工作区的 `hsr-missions/`（约 20 MB 游戏原始剧本文本，版权归米哈游，不进版本库），
缺少它插件照样装载并如实降级报告。

代码以 MIT 许可发布；游戏原始素材版权归米哈游（HoYoverse）及 Bwiki 编辑者，本插件产出属**非营利性二创**。

---

## 4. 一句话电梯陈述（社交预览 / 群聊转发）

```
用最严肃的格式，包装最离谱的内容——把星穹铁道的官方世界观，变成一个会自己查资料、还会听你改设定的二创写手。
```

**英文一句**

```
Serious formats, absurd contents: turn Honkai: Star Rail's official lore into a fan-fiction writer that cites its sources and obeys your canon overrides.
```

---

## 5. 命令备忘

**本机没有 `gh` CLI**（`gh` 不在 PATH，也没有 winget 可装），所以仓库走「网页建空仓 → `git push`」，
Release 走网页或 API。若日后装了 `gh`，下面两条可以直接用。

```powershell
# --- 有 gh 时 ---
gh repo create Kaede0614/dsh-history-fictionologists --public --source=. --push `
  --description "基于《崩坏：星穹铁道》官方世界观的 DSH 二创插件（/gs）：神人制造机出科幻灵感、构史文集写短篇、星际构史播报编新闻；12 个 Wiki 数据源增量抓取并本地缓存，抓不到就自动回退缓存。非营利二创，MIT。"

# --- 没有 gh 时（本机实际路径）---
# 1) 在 https://github.com/new 建一个空仓库（不要勾 README/.gitignore/LICENSE）
git remote add origin https://github.com/Kaede0614/dsh-history-fictionologists.git
git push -u origin main
git tag -a v0.2.0 -m "v0.2.0" ; git push origin v0.2.0
# 2) Releases → Draft a new release → 选 v0.2.0 → 正文用 docs/release-notes-v0.2.0.md
#    → 附上 dsh-history-fictionologists-0.2.0.tgz

# topics：建完仓库后在网页 About 齿轮里加，或装 gh 后用 API
gh api -X PUT repos/Kaede0614/dsh-history-fictionologists/topics `
  -f names[]=dsh -f names[]=dsh-plugin -f names[]=deepseek-harness `
  -f names[]=honkai-star-rail -f names[]=fanfiction -f names[]=worldbuilding `
  -f names[]=ai-agent -f names[]=llm -f names[]=plugin -f names[]=wiki-scraper -f names[]=mit-license
```

> `package.json` 里的 `repository` / `homepage` / `bugs` 已经指向这个地址，与上面一致，无需再改。

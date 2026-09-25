# v0.2.0 — 虚构史学家（dsh-history-fictionologists）

> 一个 DSH 插件：把《崩坏：星穹铁道》的官方世界观当作素材库，用 **`/gs`** 生成二创内容。
> 三步交互：**选功能 → 选数据更新策略 → 生成**。

**本次发布重点：用户设定补充层。** 0.1.x 里「星神纪律」是写死在风格总则里的一条规则；
0.2.0 起，你可以用同一个机制覆盖**任何**设定：把裁定写进
`hsr-worldview-cache/user-canon.json`，它会附在 `gs_read` 结果末尾并明确标注
「冲突时以此为准」，而**抓取永远不会改写这个文件**。

---

## 安装

```powershell
# 方式 A（推荐）：下载本 Release 的 .tgz 附件，再从本地路径安装
dsh plugin --profile web add C:\Users\<你>\Downloads\dsh-history-fictionologists-0.2.0.tgz

# 方式 B：直接从 GitHub 仓库装
dsh plugin --profile web add github:Kaede0614/dsh-history-fictionologists

# 方式 C：本地开发（junction 安装，改源码立即生效）
dsh plugin --profile web add link:<你的仓库路径>
```

安装后 **必须进程级重启 DSH**——新增的 bundles 行只在启动时组合，`Ctrl+Shift+R` 热重载不生效。

验证：

```powershell
dsh --profile web --dump-config | Select-String history-fictionologists
```

应当看到一行 `- id: dsh-history-fictionologists`。

---

## 能力清单

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

## 制品与验证（全部真跑，非推断）

**附件**：`dsh-history-fictionologists-0.2.0.tgz`

```
20 个文件 · 包体 95.0 kB · 解包后 304.8 kB
SHA256  92D7B2E2C93805AAB5C3026C9A7E3165409000E72642C608333D79EC1C92CB8E
SHA1    9df48f5da8c92b780b1299cd1232f36f4eeafce0   (npm shasum)
```

`.gitattributes` 里钉死了 `* text=auto eol=lf`——套件里有「系统提示必须与源码逐字节一致」
这类**读自己源码做逐字断言**的用例，Windows 上 `core.autocrlf=true` 的克隆会把源码转成 CRLF
让断言莫名其妙地失败。实测克隆后 `lib/shell.js` 的 CRLF 计数为 0。

`files` 白名单核对：清单里**没有** `test/`、`_evidence/`、`_probe/`、`node_modules/`、
`hsr-missions/`、任何 `.bak` / `.log` / 密钥。
**制品验证六条**（隔离实例，绝不触碰你日常在用的 DSH）：

| # | 检查 | 结果 |
|---|---|---|
| 1 | 装得上：`dsh plugin --profile web add <tarball 绝对路径>` | exit 0 |
| 2 | 组合进得去：隔离实例正常启动，bundle 进入配置树 | 启动成功、`/gs` 注册 |
| 3 | **真加载**：从**部署位置** `import()` 全部 13 个模块 | 13/13 通过 |
| 4 | seam 指向正确 | `/gs` 的 `definitionId` = `dsh-history-fictionologists` |
| 5 | 真实跑一次主能力 | `/gs` 执行返回 `kind:"success"`；空工作区报「本地缓存为空」，真实工作区报「12/12 个数据集有数据」 |
| 6 | 边界 | 缓存目录不存在时不抛错，如实降级 |

**测试**（全部离线，`globalThis.fetch` 一次都不被调用）：

| 检出 | 命令 | 结果 |
|---|---|---|
| 作者工作区（`_probe/` 与 `hsr-missions/` 都在） | `node --test` | 102 用例 / **101 pass / 0 fail** / 1 skip |
| **全新 `git clone`**（两者都不在，即你拿到的样子） | `node --test` | 102 用例 / **70 pass / 0 fail** / 32 skip |

32 条 skip 每一条都在输出里点名缺哪个文件（夹具按体积与版权考虑不入库）。
与磁盘无关的 70 条在任何检出里都照跑。详见 README 的「在哪台机器上跑得出什么」。

另有真机 Wiki 回归 `node _evidence/e2e-wiring.mjs` → `ALL WIRING CHECKS PASSED`
（真抓 `aeons` 18 条 / `factions` 48 条，与冻结基线一致；二次 update 全部 revid 短路）。

---

## 仓库里有什么 / 没有什么

| | 内容 |
|---|---|
| **有** | `lib/`（插件本体）、`test/`（离线用例）、`docs/`、`_evidence/`（自证与独立复核证据）、`BRIEF.md`（实现规格）、`cordis.patch.yml`、`hsr-worldview-cache/user-canon.json` |
| **没有** | `hsr-missions/`（约 20 MB 游戏原始剧本文本，版权归米哈游）、`hsr-worldview-cache/*.json`（`gs_update` 可重新抓取）、`_probe/`（4.9 MB 原始 Wiki HTML）、`hsr-stories/` 与 `hsr-broadcasts/`（本机成品） |

**功能 2 / 3 依赖工作区的 `hsr-missions/`**：没有它插件照样装载，`gs_missions` 会如实报告
「目录缺失」。要用全功能，请自备这四份数据放进 `<工作区>/hsr-missions/`。

---

## 已知限制（诚实边界）

- **三个功能的产出质量无法在隔离实例里验证**：隔离 `DSH_HOME` 既没有启动 token 也没有模型路由，
  `session/prompt` 会被接受然后永远等不到模型（实测：180 秒内会话日志始终为空）。
  这一环由「逐字节一致的提示词注入证据」+「你自己实例里的真实调用」共同覆盖。
- **用户设定补充层需要你手工维护**：`note` 字段必填，缺 `note` 的条目会被忽略并告警——
  空口裁定不算设定。
- **抓取依赖第三方 Wiki**：被 WAF 拦截时保留旧缓存并如实上报，不会静默失败。
- **`private: true` 是刻意的**：这份二创包不发 npm registry，只走 GitHub 分发。

---

## 版权

原始文本版权归米哈游（HoYoverse）及 Bwiki 编辑者所有。本插件产出属**非营利性二创**。
插件源代码以 MIT 许可发布（见 [LICENSE](<../LICENSE>)），该许可**不覆盖**游戏原始素材。

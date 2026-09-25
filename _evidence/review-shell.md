# 独立复核报告 · dsh-history-fictionologists 插件外壳

**复核角色**：独立复核者（未参与编写 `lib/shell.js` / `lib/resolve.js` / `lib/paths.js` / `package.json` / `cordis.patch.yml` / 两个测试文件）
**复核契约**：`BRIEF.md` §7（插件外壳）、§9（验证）+ `~/.dsh/skills/forge-writing` SKILL.md §1 三条硬规则 / §4 无损 JSON / §6 DoD

---

# 第三轮复核（round 3）—— 本节取代第二轮结论

**第三轮基线（我实测的 hash，与交付清单逐条一致，无漂移）**
```
lib/shell.js                 52385  BDB2359D5EAE3DC0    test/host-validator.test.mjs 19476  D3844D8F3886500D
package.json                  1172  B084A2D2A5AF60CE    test/wiki.test.mjs           35245  83629C8AB2E58777
lib/wiki/client.mjs          13759  62737A321C54CFEC    test/plugin.test.mjs         10977  5FF816A62536767C
scripts/check.mjs             2577  BD59AF8EDB1AB660    test/missions.test.mjs       33710  BDD6041E1D36495C
lib/resolve.js ED1410B6B284B1BA · lib/paths.js B120A1C4C27D9825 · lib/missions.js 8989F68A5BB34A30
lib/digest.js EC55E066177912D5 · lib/wiki/index.mjs D9F190D289D0560A · cordis.patch.yml C1D4660E3CF7BD1A
```

## 第三轮结论：**pass**

第二轮的三条（R2-1/R2-2/R2-3）**全部修复并经独立复验**；第一轮 F1–F9 仍保持修复状态。
本轮未发现 blocker/high/medium：只剩一条**低危**（别名归一化没做 trim/lowercase，与 R2-2 同类但更窄）
和四条**说明级**问题（其中 R2-5 未处理，属测试缝、生产不可达）。仓库自带的自检链路现在是真的能跑、且不会掩盖失败。

| id | 级别 | 一句话 |
|---|---|---|
| R3-1 | low | `lib/shell.js:217-222` 的 `canonicalDatasetId()` 不 trim/不 lowercase，而 `lib/wiki/datasets.mjs:191-195` 的 `resolveDatasetId()` 两者都做 → `gs_update({datasets:['Equations']})` / `[' equations ']` / `['EQUATION']` 会 `updated:['equations']` 但 `counts: []`（R2-2 的残留同类） |
| R2-5 | low（沿用，未处理） | `lib/wiki/client.mjs:110` 的 `nowImpl` 非函数已兜住，但**返回非有限数的时钟会静默关闭限流**（0 次 sleep）并使 `ms: NaN`；纯测试缝，生产不可达（`createWikiClient` 不传 `nowImpl`），`ms` 也进不了工具 schema |
| R3-2 | info | `test/host-validator.test.mjs:390-395` 第二个缝场景的 `restoreNull()` **没在 try/finally 里**：392 的断言若抛，null-wiki stub 不会被还原（今天无影响——它是本文件最后一个用例；但在 `--test-isolation=none` 下会污染同进程的另一个文件） |
| R3-3 | info | `scripts/check.mjs:26` 的 `walk()` 只递归名为 `wiki` 的子目录，将来任何 `lib/<其它目录>/` 的模块会被**静默漏检**；另外脚本实际检查 **12** 个模块（交付说明写「11 个」） |
| R3-4 | info | `stubSubmodules()` 的 `restore()` **不可 LIFO 组合**：它在还原句柄的同时把 `loaded` 置 false，于是下一次工具调用会**重新导入真实模块、顺带取消所有仍生效的外层 stub**。现有用例不依赖「内层还原后外层 stub 仍生效」，故无实际影响 |
| R3-5 | info | 文档口径仍不准确：`README.md:316` 与 `CHANGELOG.md:96` 写「3500 字的风格总则」；实测日志 3500 字是**整条系统提示**，风格总则本体 **725 字**（= 当前 `STYLE_GUIDE.length`，且逐字节一致） |

### R2-1 / R2-2 / R2-3 的复验（全部 FIXED）

| 项 | 复验证据 | 结论 |
|---|---|---|
| R2-1 测试命令 | `package.json.scripts.test` 现为 `node --test`；`node --test` → 92/91/0/1；`cmd /c "npm test"` → 92/91/0/1；`node scripts/check.mjs` → `RESULT: PASS (syntax failures: 0, test exit: 0)`，exit 0。`node --test test/` 仍如我报告的那样失败（已在 README 记录为陷阱） | FIXED |
| R2-2 别名 counts | stub 出「真实 wiki 的归一化语义」后：`['equation']`→`counts=[{equations,7}]` ✓；`['aeon']`→`[{aeons,7}]` ✓；`['equation','equations']`→**单条**（Set 去重）✓；`['broadcast']`→`[{broadcast,7}]`（`broadcast` 本身是规范 id，未被误加 s）✓；`['nope']`/`['broadcasts']`→`counts=[]`（wiki 侧也拒绝）✓ | FIXED（窄残留见 R3-1） |
| R2-3 缝钉死 | `stubSubmodules()` 现返回 `restore()` 闭包（`lib/shell.js:1121-1136`），闭包里 `loaded = false` + 清 errors；实测「stub wiki:null → restore() → 下一次调用回到 12 个真实数据集、`moduleErrors()` 为空」✓；测试也新增了该回归用例（`host-validator.test.mjs:359-396`） | FIXED |

### Q1 `scripts/check.mjs` 是否诚实？

**是**，逐条核对：
- **覆盖**：`collectModules()` 遍历 `lib/`，实测输出 **12 条 `OK` 行**，与磁盘上 12 个运行时模块（`lib/*.js` ×5 + `lib/wiki/*.mjs` ×7）完全一致 —— 交付说明里「11 个」是笔误，脚本本身没错。
- **不掩盖失败**：`const failed = syntaxFailures > 0 || tests.status !== 0; process.exit(failed ? 1 : 0)`（`:63-65`）。
  即使测试摘要解析不到（`:57` 的 fallback），判定仍用子进程真实 `status`；`spawnSync` 失败时 `status` 为 `null`，`null !== 0` 判 FAIL —— 失败方向是安全的。
  语法检查逐个 `spawnSync(process.execPath, ['--check', file])` 并累计 `syntaxFailures`，不吞错。
- **`node --check` 的意义边界**：它只做**解析**（语法/词法），不执行、不解析 import、不建 DOM/网络 —— 所以它能挡「语法错/半截写入的损坏文件」（这正是本项目踩过的 UTF-8 污染类问题的近亲），但**不能**替代运行期验证。脚本自己的注释与命名（"syntax check"）没有夸大这一点。
- **唯一死角**：`scripts/check.mjs:26` 的 `if (entry.name === 'wiki') walk(full)` —— 只递归 `wiki` 一个子目录（R3-3）。

### Q2 flake 类：在**新文件**上再查一遍 —— 未发现第二个

- 静态：`test/` 内 `Date.now / performance.now / setTimeout / new Date() / AbortSignal.timeout / ms >=` 全部命中点复核过：
  `plugin.test.mjs` 的 4 处 `AbortSignal.timeout(20_000)` 只作**输入 signal**、不作断言；
  `host-validator.test.mjs` 的 `new Date(Date.now() + 2*86400000)` 只构造**未来**时间戳；
  `wiki.test.mjs` 的限流断言现为冻结时钟 + `deepEqual(sleeps, [1500])` 与反向对照 `deepEqual(sleeps2, [])`；
  退避断言是 `deepEqual(sleeps.filter(ms => ms >= 4000), [4000, 8000])` + 精确 `attempts`，全走假 fetch/假 sleep。
  `missions.test.mjs` 无任何时间断言（`missions.js` 的 `readMs/parseMs/totalMs` 无人消费）。
- 动态：本轮 **4 次**全套（其中 3 次在 1 个 CPU 满载后台任务下）→ 每次 `92/91/0`；跨轮累计 **17 次以上**全绿。
- 日期腐烂：再确认**无**。`lib/wiki/index.mjs:187` 的 `buildRecord` 用 `new Date().toISOString()`（本次更新时间）写 `lastUpdated`，
  故 `wiki.test.mjs` 的 `recommendation === 'use-cache'`（现 `:644` 附近）不会随日历腐烂；测试里两处硬编码时间戳（`:555`、`missions.test.mjs:105`）都是惰性 fixture。

### Q3 `canonicalDatasetId()` 的攻击结果

```js
// lib/shell.js:217-222
function canonicalDatasetId(id) {
  const value = String(id)
  if (CANONICAL_DATASET_IDS.includes(value)) return value
  const plural = `${value}s`
  return CANONICAL_DATASET_IDS.includes(plural) ? plural : value
}
```
- **不会产生错误匹配**：只有「请求 id 的复数恰好是规范 id」时才会命中，也就是别名语义本身；`broadcast`（规范）不会被加成 `broadcasts`，`aeons` 不会被加成 `aeonss`，未知 id 原样返回 → `wasRequested` 为假 ✓。
- **不会产生重复 counts**：`requestedIds.flatMap(id => [id, canonicalDatasetId(id)])` 进的是 `Set`；`counts` 又从 `after.datasets`（每个数据集一行）/`raw.counts`（对象键唯一）映射而来 ✓。
- **唯一真缺陷 = 大小写/空白**（R3-1）：wiki 侧 `resolveDatasetId` 做 `trim().toLowerCase()`（`datasets.mjs:192-195`），外壳侧不做：
```
  resolveDatasetId("Equations") = equations      resolveDatasetId(" equations ") = equations      resolveDatasetId("EQUATION") = equations
  {"datasets":["equation"]}     updated=["equations"] counts=[{"id":"equations","count":7}]   <- 正常
  {"datasets":["Equations"]}    updated=["equations"] counts=[]                                <- R3-1
  {"datasets":[" equations "]}  updated=["equations"] counts=[]                                <- R3-1
  {"datasets":["EQUATION"]}     updated=["equations"] counts=[]                                <- R3-1
```
  修法一行：`const value = String(id).trim().toLowerCase()`。影响面同 R2-2：只丢附加统计 `counts`，不影响 `updated`/`failed`/落盘，也不违 schema。

### Q4 `restore()` 闭包的正确性攻击

- **实际行为（实测）**：任意 `restore()` 之后，下一次工具调用都会拿到**真实模块**（12 个数据集），无论还原顺序：
```
  baseline (real)          datasets=[relics,lightcones,...] (12)
  nested: A then B         datasets=["B"]
  LIFO restore (rB, rA)    datasets=[relics,...] (12)      <- 内层还原即已重新解析真实模块
  OUT-OF-ORDER (rC, rD)    datasets=[relics,...] (12)      <- 也没有留下陈旧 stub
```
  原因在 `lib/shell.js:1133`（`restore()` 里 `modules.loaded = false`）：句柄无论被写成什么，下一次调用都会重新 `import()` 真实模块并覆盖。
- 所以 **不存在「还原后装错句柄」**；代价是 **R3-4**：`restore()` 不可 LIFO 组合 —— 还原内层会顺带取消外层 stub。当前用例唯一的嵌套处（`host-validator.test.mjs:204-248`）在内层还原后不再依赖外层 stub，且 `finally` 顺序是标准 LIFO，所以没有实际影响。
  若想让语义可组合，正解是**捕获并还原 `loaded`**：`const wasLoaded = modules.loaded` → restore 时 `modules.loaded = wasLoaded`（而不是一律 false）。这样「从未加载过」的还原仍然是 false（R2-3 不回归），而嵌套 stub 也能逐层解开。
- **`finally` 覆盖**：三处 stub 都在 `try/finally`（`:216-248`、`:378-383`），唯一例外是 `:390-395` 的第二场景（R3-2）。
  测试进程被强杀的路径本质上无法兜（与代码无关）。

### Q5 离线可验证性 + 「92 tests / 1 skip」是否诚实

- **仍然只能联网验证的部分**：`gs_update` 的真实抓取路径（revid 查询 → 列表页 → 详情 wikitext → 原子写）与真实宿主进程行为。
  其余全部离线可验：6 个工具 × 全部降级路径（宿主校验器）、4 个 digest、missions 扫描、缓存读写往返（假客户端）、`/gs` 文本与 handler、Config/路径解析、缝与生命周期。
- **1 个 skip 的真相**（TAP 实测）：`ok 9 - equationNameDigest / broadcastDigest degrade on the real workspace # SKIP cache already exists`
  —— 它是 `test/missions.test.mjs:382` 的**条件跳过**：本机工作区已有 `hsr-worldview-cache`，所以跳过；**干净克隆里它会运行**。
  另有一个潜在跳过点（`test/wiki.test.mjs:280` 的 live-capture 回放）因 `test/fixtures/wikitext-live.json` 存在而**实际在跑**。
  因此「92 tests / 91 pass / 1 skip」是**诚实**的：不是永久缺口，而是「有缓存时跳过、无缓存时执行」的环境分支。
  （唯一边界：在**有缓存**的机器上，`missions.js` 的 digest 降级分支不会被这套测试覆盖——那句话反过来说才对，不是缺陷，但值得知道。）

## 第三轮的「查过，未发现问题」

- **R2-1/R2-2/R2-3 修复的真实性**：见上表；三处都有可复现命令或实测输出，且 R2-2 的修复点用「真实 wiki 归一化语义」的 stub 复现过正反例。
- **`scripts/check.mjs` 的诚实性**：12/12 模块、失败必 FAIL、exit code 正确（Q1）。
- **flaky/时间依赖/日期腐烂**：未见第二个实例（Q2）。
- **`canonicalDatasetId` 的复数化边角**：无误匹配、无重复计数（Q3），仅 R3-1。
- **`restore()` 的顺序安全**：任何顺序都不会留下错句柄或钉死降级（Q4），仅 R3-4 的组合性语义。
- **宿主 schema 一致性**：第三轮仍复跑了空工作区 11 例 + 真实缓存 6 例 → 0 失败（`validateJsonSchemaValue` 违规 0、null 0、非无损 0）。

## 第三轮未验证

1. `gs_update` 的真实联网路径；任何真实 dsh 进程行为（本轮同样未启动宿主；用户 GUI 02:06 重启后 `lib/shell.js` 已两度变更，当前 hash 无 live 证据）。
2. `node scripts/check.mjs` 在**语法失败**时的表现只做了代码审读（`syntaxFailures` 累计 → `RESULT: FAIL` → `exit 1`），没有真的往仓库里塞一个坏文件去验证（遵守「只读」约束）。
3. `--test-isolation=none` 下的跨文件污染只在**当前全绿**状态下验证（22/22），未构造「某个用例中途失败」的场景去实证 R3-2 的泄漏路径。

---

# 第二轮复核（ Historical · 其结论已被第三轮 pass 取代）

**第二轮基线（逐一复核 hash，全部与交付说明一致）**

```
lib/shell.js                 50201  02:31:23  26AFBDC855AB2E36   <- 主产物
test/host-validator.test.mjs 18071  ~02:45   33BD7CDB7DD72D2B   <- 复核中途又改过一次，见下方「复核期间的第二次改动」
test/plugin.test.mjs         10977  01:53:16  5FF816A62536767C   （未改）
lib/resolve.js ED1410B6B284B1BA / lib/paths.js B120A1C4C27D9825 / lib/missions.js 8989F68A5BB34A30
lib/digest.js EC55E066177912D5 / lib/wiki/index.mjs D9F190D289D0560A（未改；`lib/wiki/client.mjs` 与 `test/wiki.test.mjs` 在补丁中改过，见文末附录）
package.json 8C98801CA33A3DCF / cordis.patch.yml C1D4660E3CF7BD1A（均未改）
BRIEF.md 1A20B03A0273B308 / README.md FA89A6F5335629DC / CHANGELOG.md 38CD91662B870BA3（文档变更，不在代码复核范围）
```

## 第二轮结论：**needs_revision**

**第一轮 F1–F9 全部修复，并已逐条独立复验**（复验方式见下表）；外壳本体在本轮 29 条一致性用例上 0 失败。
打回只剩一个可复现的交付层缺陷：**仓库自带的测试命令在本机 Node 上跑不起来**（R2-1，一行可修）。
另有四条低危与一条说明。文末附录另覆盖交付方在复核期间提交的**数据层补丁**（`lib/wiki/client.mjs` 时钟缝 + `test/wiki.test.mjs` 限流用例去 flaky）
与**提示词 section 证据的独立审计**（R2-5、R2-6）。

| id | 级别 | 一句话 |
|---|---|---|
| R2-1 | medium | `package.json:33` 的 `"test": "node --test test/"` 在 Node 24.21.0 上失败（`Cannot find module '…\test'`，exit 1，0 passed / 1 failed）——`npm test` 与 BRIEF §9.3 的验证命令都跑不通 |
| R2-2 | low | `lib/shell.js:540,544` 的 `counts` 过滤器拿**调用方原始 id**比**规范复数 id**：`gs_update({datasets:['equation']})`（单数别名，`gs_read` 自己就这么宣传）返回 `counts: []`，尽管 `equations` 已更新成功 |
| R2-3 | low | 测试缝 `stubSubmodules()` 的**还原路径**在忘记配套 `resetSubmodules()` 时会把模块永久钉在降级态（`loadSubmodules()` 永远返回 `wiki: null`，即使真实模块就在磁盘上）——正是「工具静默消失」那一类；现有调用点都配对了，故无实际缺陷 |
| R2-4 | info | Config 的 `.min()/.max()` **拦不住 NaN/Infinity**（NaN 与任何界比较都不触发失败），真正的网是 `num()`/`toNumber()`；逐键核对后确认无残留路径（见 Q1） |
| R2-5 | low | `lib/wiki/client.mjs:110,119-122` 的新时钟缝：非函数 `nowImpl` 已被 `typeof` 兜住，但**返回非有限数的 `nowImpl` 会静默关闭限流**（两次相邻请求 0 次 sleep，违反 BRIEF §3.1 的 ≥1500ms 底线）并让 `ms: NaN` 进入客户端结果；纯测试缝、生产不可达（`createWikiClient` 从不传 `nowImpl`），且 `ms` 到不了工具输出（外壳逐字段白名单） |
| R2-6 | info | 提示词 section 的「产品证据」经独立审计**成立但有两点需要更正**：日志里 3500 字符是**整条组装后的系统提示**，section 本体是 **725 字符**；脚本只 `console.log` 记录类型/角色而没有断言，且工具清单取的是跨文件最后一条 `request/header`（本例只有 1 条，故不咬人）。我另做了更强的一条检查：日志文本 `includes(STYLE_GUIDE) === true`（与当前文件逐字节一致） |

### 复核期间的第二次改动（交付流程问题，需记录）

交付说明声明「全部冻结」时 `test/host-validator.test.mjs` 是 16735 B / `07E2BA59AC784555`（02:31:46）；
我在复核过程中它又变成 **18071 B / `33BD7CDB7DD72D2B`**。逐行核对后确认增量是：

- 追加了一个用例 `the stub seam restores the real submodules (no cross-test leakage)`（现 `:343-371`）——
  它先 `resetSubmodules()` 取真实模块（断言 12 个数据集），再 stub 一个假 wiki（断言只报 `fake`），
  最后 `stubSubmodules(previous) + resetSubmodules()` 并断言回到 12 个数据集。**非恒真**（假 stub 只返回 1 个数据集，能区分）。
- 另有少量注释行的增删，导致 `:172/:293` 附近行号与旧版差 ±1；本报告所有测试引用行号已按**新 hash** 逐条用文本检索复核过。

复核结论：**该用例覆盖的是「安全配对」（还原 + reset），并不覆盖 R2-3 的「只还原不 reset」路径**，故 R2-3 依然成立。
加改动后复跑：`node --test` → **tests 92 / pass 91 / fail 0 / skipped 1 / 1.87 s**；
单进程不隔离两文件（两个顺序）→ **22/22 pass**。

### R2-1 [medium] `package.json:33` —— 自带测试命令在宿主 Node 上失败

**问题**：`"scripts": { "test": "node --test test/" }`。Node 24.21.0 把 `test/`（非 glob 的位置参数）当作**入口脚本**加载，
报 `Cannot find module 'C:\Users\masha\Desktop\hsr-history-fictionologists\test'`；`node --test test`（无斜杠）同样失败。
BRIEF §9.3 与 README 都让读者跑测试，交付说明里的「91 tests」是用 glob 形式跑出来的。

**requiredFix**：`"test": "node --test \"test/*.test.mjs\""`（或直接 `node --test`，走 cwd 自动发现）。

**证据**：
```
=== A: node --test test/  (package.json scripts.test) ===
Error: Cannot find module 'C:\Users\masha\Desktop\hsr-history-fictionologists\test'
ℹ pass 0 / ℹ fail 1                                          exit=1
=== B: node --test test ===                                   exit=1（同样失败）
=== C: node --test ===                ℹ tests 91 / pass 90 / fail 0 / skipped 1 / duration_ms 1498   exit=0
=== D: node --test "test/*.test.mjs"  ℹ tests 91 / pass 90 / fail 0 / skipped 1 / duration_ms 1446   exit=0
```
（C/D 的 1 skipped 是 `test/wiki.test.mjs:280` 的 live-capture 跳过，属预期。）

### R2-2 [low] `lib/shell.js:514-516,540,544` —— 别名 id 让 `counts` 变空

**问题**：`requestedIds = args.datasets.map(String)`（调用方原样字符串，可能是 `equation` 这类单数别名），
而过滤器比较的是 `status.datasets[].id` 与 `raw.counts` 的键（`lib/wiki/index.mjs` 一律给出**规范复数** id）：

```js
.filter((d) => (requestedIds === null ? wanted.has(d?.id) : requestedIds.includes(String(d?.id))))   // :540
.filter(([id]) => requestedIds === null || requestedIds.includes(id))                                 // :544
```
`['equation'].includes('equations') === false` → `counts` 为空；回退分支（`:542-545`）被同一条件滤掉。
第一轮 F5 修好了「未请求的数据集混进来」，但把过滤基准从**规范 id**（`wanted`）换成了**原始输入**，于是别名反向漏掉。
`gs_read` 的参数描述自己写着「也接受单数别名」（`lib/shell.js:576`），`test/wiki.test.mjs:711` 也把
`['equation','equations']` 当合法输入测过——别名是**受支持**的调用方式。

**requiredFix**：取并集匹配，例如
`requestedIds === null ? wanted.has(d?.id) : (wanted.has(d?.id) || requestedIds.includes(String(d?.id)))`
（`wanted` 来自 `update()` 的 `updated`/`skipped`，天然是规范 id：`lib/wiki/index.mjs:233` 已做 `resolveDatasetId`。）

**证据**（stub wiki 子模块，仅本地；同一 stub 下按规范 id 请求正常，形成对照）：
```
  {"datasets":["equations"]}             updated=["equations"] counts=[{"id":"equations","count":212}]
  {"datasets":["equation"]}              updated=["equations"] counts=[]            <- R2-2
  {"datasets":["equation","equations"]}  updated=["equations"] counts=[{"id":"equations","count":212}]
  {"datasets":["equations","equations"]} updated=["equations"] counts=[{"id":"equations","count":212}]  （重复 id 正常）
  {"datasets":[]}                        updated=["equations"] counts=[{"id":"equations","count":212}] （空数组 = 不过滤，正常）
```

### R2-3 [low] `lib/shell.js:1086-1098` —— 缝的还原路径会静默钉死降级态

**问题**：`stubSubmodules(next)` 在 `next.reload !== false` 时把 `modules.loaded` 置为 `true`；
还原调用 `stubSubmodules(previous)` **不带 `reload`**，于是 `loaded` 仍为 `true` 而句柄被还原成之前的值——
若之前是 `null`（进程启动、尚未加载），`loadSubmodules()` 之后永远返回 `null`，所有工具静默降级；
只有再调一次 `resetSubmodules()` 才会重新解析真实模块。

**现状**：`test/host-validator.test.mjs` 的 3 处 stub 都是 `finally { stubSubmodules(prev); resetSubmodules() }`；
两种文件顺序 + 单进程不隔离（`--test-isolation=none`）实测 21/22 全过 → **当前无泄漏**；
但 API 形状让「安全用法」不显然，且失败后果正是「工具静默消失」。

**requiredFix**：让 `stubSubmodules` 返回 `{ previous, restore() }`（`restore()` 内部顺手清 latch），
或把「还原必须紧跟 `resetSubmodules()`」写成 JSDoc 契约并加断言。

**证据**：
```
  after stub: wiki=null
  restore WITHOUT reset -> wiki=null  (real module IS available on disk)      <- 钉死
  after resetSubmodules  -> wiki.status is function, update is function       <- 恢复
=== E/F: node --test --test-isolation=none <两个测试文件>（正序 21 pass / 反序 22 pass, 0 fail）===  无泄漏
```

### R2-4 [info] `.min()/.max()` 拦不住 NaN —— 但 `num()`/`toNumber()` 已覆盖全部配置键

```
  staleAfterDays NaN        -> accepted, staleAfterDays=NaN finite=false
  staleAfterDays Infinity   -> accepted, staleAfterDays=Infinity finite=false
  staleAfterDays -1         -> REJECTED AT LOAD: $.staleAfterDays expected number >= 0 but got -1
  inspirationCount 9 / 2    -> REJECTED AT LOAD（>=3 <=5）
  requestTimeoutMs 0        -> REJECTED AT LOAD（>=1）
  inspirationCount NaN / requestIntervalMs NaN / maxRetries NaN / defaultBroadcastWords NaN -> accepted
```
即：界只拦「明显荒谬的值」，拦不住非有限数；逐键核对消费方后确认无残留路径（见 Q1）。

## 附录：第二轮补丁复核（数据层 flake 修复 + 时钟缝 + 提示词证据审计）

**补丁基线**（`lib/shell.js` 未变，故上文全部 shell 结论继续有效）
```
lib/shell.js                 50201  02:31:23  26AFBDC855AB2E36   （未变）
lib/wiki/client.mjs          13759  02:45:21  62737A321C54CFEC   <- 新增 nowImpl 时钟缝
test/wiki.test.mjs           35245  02:45:25  83629C8AB2E58777   <- 限流用例改为冻结时钟
test/host-validator.test.mjs 18071  02:43:59  33BD7CDB7DD72D2B
CHANGELOG.md                  8207  02:45:48  38CD91662B870BA3 / docs/README.md（文档）
```

### R2-5 [low] `lib/wiki/client.mjs:110,119-122` —— 时钟缝的非有限返回值会静默关闭限流

```js
this.now = typeof merged.nowImpl === 'function' ? merged.nowImpl : () => Date.now()   // :110 非函数已兜住
async #waitTurn() {
  const gap = this.options.intervalMs - (this.now() - this.#lastRequestAt)            // :120
  if (this.#lastRequestAt > 0 && gap > 0) await this.options.sleepImpl(gap)           // :121
  this.#lastRequestAt = this.now()
}
```
- **非函数 `nowImpl`**（字符串/null/对象）→ 回落到真实时钟 ✓（实测）。
- **函数但返回非有限数** → `gap = NaN`／`Infinity` → `gap > 0` 为假 → **永不 sleep**：限流被静默关闭，
  而 BRIEF §3.1 的 ≥1500ms 是防 WAF 的硬要求；同时 `ms: this.now() - started` 变成 `NaN` 进入客户端结果。
- 生产不可达：`createWikiClient()`（`:350-358`）从不传 `nowImpl`，模型/宿主也碰不到；
  且 `ms` 不会进工具 schema（`lib/shell.js` 对每个 wiki 结果**逐字段白名单**，`gs_update` 的 `durationMs` 用的是 `Date.now()`）。
  故列 low：与 `toNumber()` 对 `intervalMs/timeoutMs/maxRetries` 的加固不对称，建议同样收敛一次
  （`const v = Number(this.now()); return Number.isFinite(v) ? v : Date.now()`），或把 `nowImpl` 纳入 `toNumber` 家族。

**证据**：
```
  non-function nowImpl -> now() type=number value-is-finite=true   (falls back to real clock)
  null nowImpl         -> finite=true
  NaN clock -> sleeps=[]        (expected [1500] for a real clock)     <- 限流被关闭
  NaN clock -> result.ms=NaN isFinite=false ok=true                    <- 非有限 ms 外泄
  Infinity clock -> sleeps=[] result.ms=NaN
  string clock -> sleeps=[1500] (coerced, no crash)
  frozen clock advanced in sleep -> sleeps=[1500] ms=0                 <- 新用例的模型，行为正确
  default clock -> ms is finite=true value=0
```

### R2-6 [info] 对「提示词 section 进真实请求」证据的独立审计

我把交付方给的 `_evidence/check-prompt-section.mjs` 跑了一遍并逐行读了实现，结论：**这条证据成立，且比脚本自己打印的更强，但交付说明里的措辞要更正两点**。
- 实测输出：`record type=system/message seq=7 role=system chars=3500`；`gs_* tools: gs_digest, gs_missions, gs_read, gs_save, gs_setup, gs_update`；6 项内容检查全 YES。
- **更正 1**：`chars=3500` 是**整条组装后的系统提示**（尾部含 `Your working directory is C:\Users\masha\hsr-fictionologists-testws.`），
  **section 本体是 725 字符**（= 当前 `__internals.STYLE_GUIDE.length`）。说「3500 字符的 section」不准确。
- **更正 2（我补的更强检查）**：脚本只做子串检查，不做版本一致性；
  我独立解出那条记录并比对当前源码：**`record.text.includes(STYLE_GUIDE) === true`**，
  即日志里的风格文本与**当前** `lib/shell.js` 的 `STYLE_GUIDE` 逐字节一致（`record !== STYLE_GUIDE` 只是因为外面裹着 harness 自己的系统提示）。
- **证据强度上的两点削弱**（不影响本例结论）：① 脚本只 `console.log` 记录类型/角色，没有 `assert`，
  若哪天记录变成 `assistant/message` 回显也会被判为命中（本例实测确为 `system/message` + `role=system`）；
  ② 工具清单的循环（`:61-71`）遍历所有文件、每条 `request/header` 都覆盖 `tools`，取的是**字典序最后一条**，
  并没绑到承载该 section 的那次请求上（本例日志里只有 **1 条** `request/header`，seq=10，含全部 6 个 `gs_*`，故不咬人）。
- 该脚本读的是隔离实例的日志目录（`C:\Users\masha\hsr-fictionologists-testhome\sessions`，11 个文件 17.9KB），**不碰用户日常实例**，符合团队硬规则 1。

### 三角：flaky / 时间依赖的第二次排查 —— 查过，未发现第二个

**静态排查**（`grep -n "Date.now|performance.now|setTimeout|new Date(|AbortSignal.timeout|elapsed|durationMs|ms >=" test/`）：
- `test/plugin.test.mjs:135,151,209,246` 的 `AbortSignal.timeout(20_000)` 只作为**输入 signal**，不作断言，且相关调用无网络/无耗时；不可能因机器慢而失败。
- `test/host-validator.test.mjs:280` 的 `new Date(Date.now() + 2*86400000)` 构造**未来**时间戳，断言的是「未来时间戳不得产生负 ageDays」，与当前时刻无关。
- `test/wiki.test.mjs:447-482` 的限流用例已冻结时钟；`:496-504` 的退避断言是 `deepEqual(sleeps.filter(ms => ms >= 4000), [4000, 8000])` 与 `attempts` 精确值，全部走假 fetch + 假 sleep，与真实耗时无关。
- `test/missions.test.mjs` 无任何 `Ms`/时间断言（`missions.js` 里的 `readMs/parseMs/totalMs` 无人断言）。

**日期腐烂（date rot）排查**：确认**不存在**。`lib/wiki/index.mjs:187` 的 `buildRecord` 用 `lastUpdated: new Date().toISOString()`（本次更新时间），
不是页面 revid 时间戳；因此 `test/wiki.test.mjs:644` 的 `assert.equal(after.recommendation, 'use-cache')` 永远成立，
`:555` 硬编码的 `timestamp: '2026-09-25T00:00:00Z'` 与 `test/missions.test.mjs:105` 的固定 `lastUpdated` 都只作惰性 fixture 数据，不被时间断言消费。

**动力学复查**：干净环境连跑 5 次 + **在 2 个 CPU 满载后台任务下再连跑 8 次** → 每次都是 `tests 92 / pass 91 / fail 0 / skipped 1`，0 失败。
（交付方报告修复前 6 次里 2 次失败；修复后 8 次 + 我的 13 次全绿，与其根因分析一致：原用例注入 `sleepImpl` 但仍读真实 `Date.now()`，
首个请求耗时超过 `intervalMs` 时就不会 sleep，断言 `some(ms => ms >= 1500)` 随机器负载翻脸。）

**结论**：flaky 类在本树中**未见第二个实例**，且该类的现有唯一实例已被结构性修掉（冻结时钟 + 更强断言 + 反向对照），不只是调参绕过。

## 第一轮 F1–F9 的复验结果（全部 FIXED）

| 项 | 复验证据 | 结论 |
|---|---|---|
| F1 断言恒真 | 新断言为 `assert.deepEqual(validate(...), [])`；对 6 个**真实**工具的 schema 喂 `{}` 分别得 3–10 条违规、喂多余键再多 1 条 → 对每个工具都可失败；元测试还用 `vacuous()` 记录了旧写法 | FIXED |
| F2 NaN 丢必填键 | `num()` 用于 `:365-366` 与 `/gs` 文本 5 个字段（`:900-904`）；NaN/±Inf 配置下 `gs_setup` 结果键仍在且有限（测试 `:183-195`，我亦独立复跑） | FIXED |
| F3 联网用例 | 该用例改为 stub `wiki: null` 走降级分支；全套离线（见下「测试树是否联网」） | FIXED |
| F4 disposer 不可观测 | 新 mock 返回**真注销函数**；生命周期用例断言 apply 后 8 个生效注册、全部 dispose 后 0 个、二次 dispose 安全、重新 apply 回到 6/1/1（`host-validator.test.mjs:311-333`）；我用同构 mock 独立复跑一致 | FIXED |
| F5 counts 列未请求数据集 | 引入 `requestedIds` 显式标志（`:514-516`）；stub「只请求 aeons 且失败」→ `counts` 只含 aeons（测试 `:197-236`） | FIXED（别名边角见 R2-2） |
| F6 YAML 注入 | `title: ${JSON.stringify(title)}`（`:834`）；16 个恶意标题（多行、`---`、引号、冒号、反斜杠、`\t`、DEL、NEL、U+2028/29、孤立代理项、emoji）逐个落盘：front-matter 键恒为 `kind/title/createdAt/generator`、正文逐字不变 | FIXED |
| F7 负数天数 | `:914` 加 `Math.max(0, …)`（与 `:427` 一致） | FIXED |
| F8 不可解析时间戳 | `:437` 丢弃不可解析的 `lastUpdated`、`:399` 加告警、`:408` advice 改为「无法判断新鲜度…建议更新」 | FIXED |
| F9 异常形态崩 | `:373`（status 非对象）、`:379-382`（datasets 非数组）、`:525-531`（result/failed/updated 非数组）、`:640-654`（entries 非数组）、`:724/781`（digest 结果非对象）＋元素级 `d?.`/`e?.`/`f?.` | FIXED |

## 逐条回答第二轮的六个攻击点

### Q1 `num()` 与 Config 界：还有必填键消失的路径吗？界会不会让合法配置响亮失败？
**没有残留路径。** 逐个配置键核对消费方（全部实测）：

| 配置键 | 消费方 | 非有限数后果 |
|---|---|---|
| `staleAfterDays` / `recentGuardDays` | shell `num()`（`:365-366`）+ wiki `staleDaysOf` | 回退默认，必填键保留 |
| `requestIntervalMs` / `requestTimeoutMs` / `maxRetries` | wiki client `toNumber()`（`client.mjs:100-103,339-342`）→ `Number.isFinite` 回退 + 下限 | 回退默认（interval 另有 `Math.max(1500,…)` 托底） |
| `inspirationCount` / `defaultStoryWords` / `defaultBroadcastWords` | `/gs` 文本 `num()`（`:900-904`） | 回退默认，文本正常 |
| `workspace` / `userAgent` / `saveOutputs` | `resolveWorkspace` 类型检查 / client 字符串检查 / `!== true` | 无影响 |

界只在**真正荒谬**的值上响亮失败（`-1` 天、`0` ms 超时、`0` 字、`3–5` 之外的灵感条数——最后一项正是 BRIEF §7.2 的既有要求）；
所有默认值都落在界内（`2000≥0`、`30000≥1`、`4∈[3,5]`、`2000≥1`…），**不存在「合法配置被新界拒绝」的回归**。
唯一需知：`inspirationCount` 现被硬限 3–5，用户想配 6 会在加载期响亮失败（有意为之）。

### Q2 `stubSubmodules` 缝会不会串测试 / 生产侧是否要设防？
- **不串**：同文件内 `node:test` 顶层用例顺序执行；`node --test` 默认每文件独立进程；
  我另用 `--test-isolation=none` 把两个外壳测试文件塞进**同一进程**（正序 21 pass / 反序 22 pass，0 fail）也无泄漏。
  三处 stub 都在 `try/finally` 里 `stubSubmodules(prev) + resetSubmodules()`。
- **但形状危险**（R2-3）：只还原不 reset 会把 `loaded` 留在 `true` 且句柄为 `null`，永久静默降级——已实验证明。
- **生产设防**：不需要（模型/宿主都碰不到 `__internals`，且它是模块级共享状态的测试专用入口）；
  建议按 R2-3 改成 `restore()` 闭包或在 JSDoc 写死配对契约（现有 JSDoc 只说明了 stub 方向）。

### Q3 新的 counts 逻辑（空、别名、重复、raw.counts 越界）
- **`requestedIds !== null` 但空**：不可能——三元式对空数组返回 `null`（`:514-516`），空数组=不过滤（与 BRIEF「省略=全部」一致）。
- **别名**：**有 bug**，见 R2-2。
- **重复 id**：`['equations','equations']` → 正常（实测）。
- **`raw.counts` 含未请求 id**：`requestedIds !== null` 时被 `:544` 滤掉 ✓；`=== null`（不过滤）时全量保留是正确语义 ✓。
- **索引为空时回退 `raw.counts`**：`:542` 守卫（`!== null && typeof 'object' && !Array.isArray`）正确；
  `lib/wiki/index.mjs:235` 的早退分支**不含** `counts` → `typeof undefined !== 'object'` → 不误用 ✓
  （实测「`failed` 非数组 + `status` 返回 null」的用例得到 `counts: []`）。
- **`counts` 缺失是否违约**：不违约——BRIEF §7.4.2 的必需返回里没有 `counts`，它是外壳自加的附加统计；R2-2 只影响信息量。

### Q4 `JSON.stringify(title)` 是否对所有标题都是合法 YAML？
- 16 个恶意标题实测（见 F6 行）：front-matter 恒为 4 个键、delimiter 正确、正文逐字保留。
- `JSON.stringify` 只输出 `\" \\ \b \f \n \r \t` 与 `\uXXXX`，这些是 **YAML 1.2 双引号标量转义的子集**，
  故「合法 YAML 标量」成立；NUL 仍会被 `JSON.stringify` 转义、但**文件名**层不洗 NUL →
  `writeFile` 抛错 → `gs_save` 捕获后返回 `{saved:false,error}`（不崩、不违 schema，属既有行为）。
- 两处**未能证明**（明确标注）：① 插件解析链解析不到 `js-yaml`/`yaml`（两者都在
  `C:\Users\masha\.dsh\profiles\node_modules`，不在插件的解析 base 上），所以「真的能 parse 回来」没跑通；
  ② U+2028/U+2029 被 `JSON.stringify` **原样输出**（不转义），YAML 1.2 里它们不是换行符，
  但若解析器按 1.1 兼容折叠，回读可能变成空格——插件从不回读该文件，故只是理论差异。

### Q5 `apply` 是否仍然同步、注册是否仍在 `ctx.effect()` 内？
- `export function apply(` **不是 async**（`lib/shell.js:268`）；
- apply 体内 `ctx.effect(` 恰好 **3** 处（`:290` section、`:301` 工具、`:860` 命令），
  所有 `ctx.tools.register` / `ctx.commands.register` 都在这两个 effect 回调内；
- apply 体内出现的 17 个 `await` 全在其 `async execute()` / `async handler` 函数体里，不在 apply 的同步路径上；
- 模块级 `await`（`:65-67` 三个可选依赖、`:76` Schemastery）仍早于任何注册。
→ **判定不变，无卸载窗口竞态。**

### Q6 `test/host-validator.test.mjs` 里还有没有第二个恒真断言？
**没有找到第二个恒真断言**（逐个断言类型审过并做了针对性攻击）：
- 全部一致性断言都是 `assert.deepEqual(violationsOf(...), [])`（`:136,172,192,219,228,293`），
  已证明 `validate` 对 6 个真实 schema 的 `{}` / 多余键都会产生违规（**可失败**）。
- `validate` 若为 `null` → `null(...)` 直接 TypeError → 用例失败（不会静默跳过）；另有 `:105-109` 单独断言可解析性。
- `assert.ok(Number.isFinite(...))`（`:189-191,294`）、`assert.deepEqual(JSON.parse(JSON.stringify(value)), value)`（`:170`）、
  `assert.deepEqual([...record.live], [])`（`:322`）、`record.live.size === 8`（`:319`）都是可失败断言的正确形态。
- 唯一「偏松」处：`:299` `assert.ok(!value.lastUpdated, ...)` 用真值判定「键已消失」——若实现改成回显 `''` 仍通过；
  **不构成恒真**（回显 `'not-a-date'` 会失败）。严格写法是 `assert.ok(!('lastUpdated' in value))`。列为 info 级形式化建议。
- `:124-125` 的 `vacuous()` 仅用于记录旧 bug（断言它对违规数组返回 `true`），语义正确。

## 第二轮的「查过，未发现问题」

- **6 个工具 × 降级路径的宿主一致性（29 例）**：空工作区 14 例、真实缓存 10 例、三个子模块全 null 5 例 ——
  宿主 `validateJsonSchemaValue` 违规 0、`null` 值 0、非无损 JSON 0、`output.render` 破块 0；事后 `resetSubmodules()` 也能恢复真实模块。
- **`apply` 同步性与注册位置**：见 Q5，无问题。
- **`Config` 仍是标准 schema 或 undefined**：`typeof Config['~standard'].validate === 'function'`（既有用例通过），无硬 import。
- **测试树是否联网**：**确认无真实网络 I/O**。`test/wiki.test.mjs` 的 8 处 `new WikiClient(...)`
  （`:432,446,462,469,481,487,496,503`）**全部注入 `fetchImpl` 假实现**与 `sleepImpl`；
  8 处 `await update(...)`（`:601,624,631,674,694,705,711,726`）**全部传入 `client`**，
  故 `createWikiClient()`/`globalThis.fetch` 在测试中从不被调用；`https://example.invalid/*` 只是喂给假 fetch 的目标字符串
  （RFC 2606 保留域，亦不可达）。全套 1.5 s 跑完，与「离线」声明相符。
- **真注销链**：`lib/shell.js:848-856` 对每个子 disposer 单独 try/catch；`stubSubmodules` 的还原在测试里配有 reset（见 Q2）。

## 第二轮未验证

1. **`js-yaml`/`yaml` 实际 parse**（不在插件解析 base 上，见 Q4）——「合法 YAML」是按转义集推断，不是跑出来的。
2. **真实宿主进程行为**：用户 GUI 于 02:06 重启，而 `lib/shell.js` 在 02:31 又改过，
   因此**当前 hash 的版本没有任何活跃进程跑过**；交付说明里的 live 证据对应 02:06 那一版，不能算 02:31 版的证据。
3. **`gs_update` 的真实联网/E2E 路径**：仍未跑（遵守「不联网」）。
4. **`node --test test/` 在其它 Node 版本（22.x）是否也失败**：只在 24.21.0 上验证。

> 以下第一轮章节是**历史记录**（针对 `lib/index.js` 前身 / 44778B 版），其行号与结论已被本节取代。

---

## 复核基线（第一轮，冻结版本，逐一核对 hash）

```
lib/shell.js                 44778  01:54:22  420C322571457F88     <- 外壳（package.json main）
lib/resolve.js                5612  01:39:35  ED1410B6B284B1BA
lib/paths.js                  4170  01:39:41  B120A1C4C27D9825
test/plugin.test.mjs         10977  01:53:16  5FF816A62536767C
test/host-validator.test.mjs  5994  01:55:35  811FB970E960C678
package.json                  1364  01:55:31  8C98801CA33A3DCF
cordis.patch.yml              1091  01:41:12  C1D4660E3CF7BD1A
lib/wiki/index.mjs           20108  01:53:15  D9F190D289D0560A     <- 仅用于核对调用点契约
lib/missions.js              43749  01:46:39  8989F68A5BB34A30     <- 仅用于核对调用点契约
lib/digest.js                29090  01:47:31  EC55E066177912D5     <- 仅用于核对调用点契约
```

复核过程中 `lib/index.js` 被并发重写（先消失、再以无效 UTF-8 出现、再消失，最终改名 `lib/shell.js`）。
本报告**只针对上表 hash** 的版本；任何引用 `lib/index.js:NNN` 的旧行号均已失效。
复核期间我没有修改任何文件（唯一写入即本文件）。

## 结论：**needs_revision**

外壳代码本身在本轮已无 blocker：6 个工具的真实返回值全部通过宿主自己的
`validateJsonSchemaValue`（含空缓存 / 未知数据集 / 未知 kind / saveOutputs=false / wiki 缺失等降级路径），
`/gs` handler 在全部恶意 invocation 下都返回 `{kind}` 而不抛出，三个子模块的调用点与真实导出/返回结构一致且**未静默降级**。
打回的原因是**测试层**与**一处配置态契约漏洞**：

| id | 级别 | 一句话 |
|---|---|---|
| F1 | high | `test/host-validator.test.mjs` 的宿主校验断言恒真（空数组/非空数组都通过）→ 该文件宣称覆盖的「schema 一致性」实际零覆盖 |
| F2 | medium | 非有限配置值（`staleAfterDays`/`recentGuardDays` = NaN/Infinity）会让 `gs_setup` 结果**缺失两个 required 键** → 宿主必然 `INVALID_TOOL_OUTPUT` |
| F3 | medium | `test/host-validator.test.mjs` 标注「no network」的 `gs_update` 用例实际触发全量 12 数据集抓取（无缓存临时工作区） |
| F4 | medium | mock ctx 丢弃 disposer：**当前**代码的注销链是对的（我补齐 mock 后验证过），但该类缺陷在现有测试下完全不可观测；重复 `apply` 也无任何断言 |
| F5 | low | `gs_update` 的 `counts` 派生在「请求的数据集未产生 updated/skipped」时会把**未请求**的数据集也列进去 |
| F6 | low | `gs_save` 把标题原样插进 YAML front-matter：多行标题会注入键并破坏 front-matter |
| F7 | low | `/gs` 文本的「约 N 天前」未做下界钳制，时钟回拨/未来时间戳会显示负数（`gs_setup` 的 `ageDays` 有钳制，两者不一致） |
| F8 | low | `gs_setup` 对无法解析的 `lastUpdated` 原样回显，而 `advice` 却断言「缓存已超过 7 天」 |
| F9 | low（当前不可达） | 子模块返回非数组 `failed` 时 `gs_update` 抛 TypeError；返回 `null` 时 `gs_setup` 抛 TypeError |
| F10 | info | 官方 `dsh-plugin-dev check` 唯一告警：五语 README 不完整（打包/文档层，不影响运行） |

---

## F1 [high] `test/host-validator.test.mjs:69-73, 107-111` — 宿主校验断言恒真，覆盖为 0

**问题**：`@deepseek-ai/dsh-tools` 的 `validateJsonSchemaValue(schema, value, path)` 返回的是
**违规字符串数组**（`lib/index.js:529-533`：`@returns All violations in walk order; empty means valid`），
不是带 `valid` 字段的对象。测试写的是：

```js
// test/host-validator.test.mjs:70-73 （107-111 同构）
const result = validate(outputSchemaOf(tool), value)
assert.ok(result === undefined || result === null || result.valid !== false, ...)
```

数组既不是 `undefined` 也不是 `null`，且 `arr.valid === undefined`，于是 `undefined !== false` 为真 →
**断言在任何情况下都通过**。该文件 docstring 声称「calls the exact validator the DSH tool registry uses」
并用来守护刚修好的 `gs_setup` null 回归，实际守护它的只有 `hasNullValue()` 与 JSON 往返两条断言：
「键缺失 / 类型错 / 多出键」三类违规完全不被发现。

**requiredFix**：断言改为对违规数组判空，例如
```js
const violations = validate(tool.output.schema, value, 'value')
assert.deepEqual(violations, [], `${name} 被宿主校验拒绝：${violations.join('; ')}`)
```
并在 `hasNullValue` 之外补一条「required 键必须存在」的用例（见下方证据里的 `missing` 行）。

**证据**（可复现，直接照抄运行）：
```
node --input-type=module -e "const {optionalImport}=await import('./lib/resolve.js');const {validateJsonSchemaValue}=await optionalImport('@deepseek-ai/dsh-tools');const schema={type:'object',additionalProperties:false,properties:{ok:{type:'boolean'},n:{type:'number'}}};for(const [l,v] of [['valid',{ok:true,n:1}],['wrong type',{ok:true,n:'x'}],['extra key',{ok:true,n:1,nope:2}]]){const r=validateJsonSchemaValue(schema,v,'value');console.log(l,JSON.stringify(r),'assertion passes?',r===undefined||r===null||r.valid!==false)}"
```
原始输出：
```
===== vacuity proof: the assertion host-validator.test.mjs uses =====
  valid                violations=[] isArray=true result.valid=undefined => test assertion passes? true
  wrong type           violations=["\"value.n\" must be a number"] isArray=true result.valid=undefined => test assertion passes? true
  missing required key violations=[] isArray=true result.valid=undefined => test assertion passes? true
  extra key            violations=["\"value.nope\" is not a declared property (additionalProperties: false)"] isArray=true result.valid=undefined => test assertion passes? true
  type of validateJsonSchemaValue return: ARRAY (violation strings)
```
（`missing required key` 一行是探针里手写裸 schema 没有 `required:[...]` 数组所致，不代表宿主行为；
前两行「有违规但断言仍通过」即为恒真证据。）

---

## F2 [medium] `lib/shell.js:405-406`（配合 `164-203`）— 非有限配置值 → `gs_setup` 缺失 required 键 → 宿主拒绝

**问题**：`gs_setup` 输出 schema 把 `staleAfterDays` / `recentGuardDays` 声明为 **required number**
（`lib/shell.js:312-313`），而返回值是 `Number(cfg.staleAfterDays)`（`405-406`）。
`canonical()`→`lossless()` 会**丢掉非有限数字键**（`191-193`）。因此只要配置里这两个值之一是
`NaN`/`±Infinity`，该键就从结果里消失 → 宿主 `createSuccessResult` 的
`validateJsonSchemaValue` 报 `missing required property "value.staleAfterDays"` → 整次调用失败。

可达性（已证明）：Schemastery 的 `Schema.number()` **不拒绝** NaN/Infinity，并原样保留。
配置源若给出 `.nan` / `.inf`（YAML 浮点字面量）或任何程序化 patch，`apply` 拿到的就是非有限数。
（我无法从插件解析链里解析 `js-yaml`/`yaml` 去证明 yml 加载器一定产出 NaN，故「配置文件路线」标注为未证明；
「配置对象路线」已用 `mod.Config({staleAfterDays: NaN})` 实测证明。）

**requiredFix**：取值处收敛到有限数，例如
```js
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
staleAfterDays: num(cfg.staleAfterDays, DEFAULTS.staleAfterDays),
recentGuardDays: num(cfg.recentGuardDays, DEFAULTS.recentGuardDays),
```
或在 Config schema 里加 `.min(0)` 之类的有限性约束。

**证据**（探针打印里的 `{"staleAfterDays":null}` 是 `JSON.stringify(NaN/Infinity) === "null"` 的显示假象；
紧随其后的 `typeof/isNaN/value/isFinite` 才是真实值）：
```
node --input-type=module -e "const m=await import('./lib/shell.js');for(const p of [{staleAfterDays:NaN},{staleAfterDays:Infinity}]){const o=m.Config(p);console.log(typeof o.staleAfterDays,Number.isNaN(o.staleAfterDays),String(o.staleAfterDays))}"
```
原始输出：
```
===== does Schemastery preserve NaN / Infinity / null? =====
  {"staleAfterDays":null} -> typeof=number isNaN=true value=NaN isFinite=false
  {"staleAfterDays":null} -> typeof=number isNaN=false value=Infinity isFinite=false
  {"staleAfterDays":"7"} -> SCHEMA REJECTED: $.staleAfterDays expected number but got 7
  {"staleAfterDays":true} -> SCHEMA REJECTED: $.staleAfterDays expected number but got true
===== gs_setup when config carries a NaN =====
  staleAfterDays in result: ABSENT
  host validator: REJECTED -> missing required property "value.staleAfterDays"
```
（探针里 `apply` 收到的正是 `mod.Config({staleAfterDays: NaN})` 的输出，即宿主会传给 `apply` 的同一个对象形态。）

---

## F3 [medium] `test/host-validator.test.mjs:98-99` — 标注「no network」的用例会做全量抓取

**问题**：用例写
```js
// no network here: gs_update must still return a schema-valid result
['gs_update', { datasets: [] }],
```
`lib/shell.js:484` 把空数组规范成 `undefined`：
```js
datasets: Array.isArray(args.datasets) && args.datasets.length > 0 ? args.datasets : undefined,
```
而 `lib/wiki/index.mjs:230` 把 `undefined` 解释为**全部 12 个数据集**：
```js
const requested = Array.isArray(options.datasets) && options.datasets.length > 0 ? options.datasets : DATASETS.map((dataset) => dataset.id)
```
随后每个数据集都要先发一次 revid 查询（`lib/wiki/index.mjs:255-261`，注释明说 "always fetched"），
且用例的工作区是 `mkdtempSync` 的空目录 → 12 个数据集全部无缓存 → 还会继续抓列表页/详情页。
所以这不是离线用例：网络可用时它做一次~1.5MB 的全量抓取；网络不可用时按退避（4s/8s/16s × 3 次重试 × 12 数据集）
可能要跑好几分钟。该文件与 `test/plugin.test.mjs` 的 docstring 都写着 "WITHOUT the network"，与此矛盾。

**requiredFix**：把该用例改成注入假客户端（`test/wiki.test.mjs` 已有 `fakeClient(state)` 可复用），
或断言 `gs_update` 的 **`wiki` 子模块缺失**降级分支，而不是触发真实 `update()`。若确实要跑真实增量，
必须显式标注为联网用例并用环境变量开关（如 `HSF_LIVE=1`）。

**证据**（静态行号引用，遵守「不联网」约束，未执行该用例）：
- `test/host-validator.test.mjs:98-99`（用例）、`lib/shell.js:484`（`[]` → `undefined`）
- `lib/wiki/index.mjs:230`（`undefined` → 12 个 id）、`255-261`（逐数据集发 revid 查询）

---

## F4 [medium] mock ctx 丢弃 disposer —— 隐藏的是「注销/幂等」这一整类，而不是当前某处具体 bug

**结论（先回答问题）**：`test/plugin.test.mjs:36-41` 的 `effect` 会把回调返回值塞进 `record.disposers`
但**从不调用**；`test/host-validator.test.mjs:31` 更彻底（`effect: (cb) => cb()`，disposer 直接丢弃）。
两个文件的 `tools.register` / `commands.register` / `systemPrompt.section` 都返回 `() => {}`。

我用「会真正注销」的 mock 复跑了 `apply`：`lib/shell.js:783-791` 的注销链是**正确**的——
调用全部 effect disposer 之后 6 个工具 + 1 个 section + 1 个命令全部注销（`unregistered` 集合含全部 8 项），
二次 dispose 也不抛。所以**当前没有「注册了但永不注销」的实际缺陷**；
被隐藏的是这一类缺陷在测试里不可观测：
(1) 谁把 `return () => {...}` 写丢 / 写坏，10 个用例照过；
(2) 卸载后重复 `apply` 的幂等性无人断言——我在同一 ctx 上连跑两次 `apply`，得到 **12 个工具、2 个命令、2 个 section**，
而 `test/plugin.test.mjs:109-112` 的 `assert.equal(record.commands.length, 1)` / `sections.length === 1` 只在单次 apply 后成立，不会发现双注册。

**requiredFix（具体断言）**：让 mock 的注册函数返回真注销函数并按下标记录，然后新增：
```js
test('unload disposes every registration (no leak, no double registration)', async () => {
  const mod = await loadPlugin()
  const { ctx, record } = makeCtx()            // makeCtx 改为返回真 disposer 的 mock
  await mod.apply(ctx, { workspace })
  assert.equal(record.tools.length, 6); assert.equal(record.sections.length, 1); assert.equal(record.commands.length, 1)
  for (const d of record.disposers) d?.()       // 卸载
  assert.deepEqual(record.liveRegistrations(), [])          // 注册表被清空
  await mod.apply(ctx, { workspace })                       // 重载
  assert.equal(record.tools.length, 6, 'reload 不得重复注册/泄漏')
})
```
**证据**：
```
===== mock ctx: does the recorded disposer actually unregister anything? =====
  after apply: tools=6 sections=1 commands=1 effects=3
  after calling every recorded disposer: tools still registered=0 (was 6), unregistered set=["section","gs_save","gs_digest","gs_missions","gs_read","gs_update","gs_setup","command"]
  NOTE the mock in test/plugin.test.mjs returns () => {} from register, so this cleanup is unobservable there.
===== double apply on the same ctx (no test covers idempotency) =====
  tools after 2x apply=12 names=["gs_setup","gs_update","gs_read","gs_missions","gs_digest","gs_save","gs_setup",...] commands=2 sections=2
  double-dispose: no throw; tools=0
```

---

## F5 [low] `lib/shell.js:494-503` — `gs_update.counts` 派生在「无 updated/skipped」时列错数据集

**问题**：
```js
const wanted = new Set([...updated, ...skipped])
counts = (after.datasets ?? []).filter((d) => wanted.size === 0 || wanted.has(d.id)).map(...)
```
`wanted.size === 0` 被当作「没有过滤条件」的哨兵，但它同时是「过滤条件存在、只是这些数据集既没更新也没跳过（例如全部失败）」
的取值。此时 `counts` 会退化为 status 里的**全部**数据集——包括用户根本没要求更新的那些。
`lib/wiki/index.mjs:230` 起 `update()` 本来就会返回 `counts: Record<string, number>`（对象），
外壳选择自己从 `status()` 派生数组（不算错，BRIEF §7.4.2 也没要求 `counts`），但派生逻辑在失败路径上是错的。

**requiredFix**：显式区分「是否带过滤」而不是用集合大小当哨兵，例如
```js
const requestedIds = Array.isArray(args.datasets) && args.datasets.length > 0 ? args.datasets.map(String) : null
counts = (after.datasets ?? [])
  .filter((d) => requestedIds === null ? wanted.has(d.id) : requestedIds.includes(d.id))
  .map(...)
```
或直接采用 `result.counts`（对象）转数组，并保留 `status()` 只为拿最新条目数。

**证据**（stub 掉 wiki 子模块，仅本地）：
```
===== gs_update derivation (stubbed wiki) =====
  all-datasets update: counts=[{"id":"equations","count":5}] updated=["equations"] skipped=["terms"] failed=[] ok=true schema-ok
  requested one (aeons): counts=[{"id":"aeons","count":18}] updated=["aeons"] skipped=[] failed=[] ok=true schema-ok
  requested one FAILED: counts=[{"id":"equations","count":5},{"id":"aeons","count":18}] updated=[] skipped=[] failed=[{"id":"aeons","error":"boom"}] ok=false schema-ok
  hostile shapes: counts=[] updated=["1","2"] skipped=[] failed=[{"id":"*","error":"未知错误"}] ok=false schema-ok
  wiki=null: {"ok":false,...,"counts":[],...} schema-ok
```
第 3 行即缺陷：只请求 `aeons` 且失败，`counts` 里却出现 `equations`。

---

## F6 [low] `lib/shell.js:766-775` — `gs_save` 的多行标题破坏 YAML front-matter

**问题**：文件名走 `safeFileName()`（`227-235`，对 `\r\n\t` 做了清洗），但 front-matter 里的标题是**原样插值**：
```js
`title: ${title}`,        // lib/shell.js:769
```
标题含换行时会注入额外 YAML 键，并把 `createdAt`/`generator` 挤到 front-matter 之外、多出一个 `---`。

**requiredFix**：对 front-matter 值做转义/压平，例如
`title: ${JSON.stringify(title)}`（合法 YAML 双引号标量）或 `oneLine(title)`。

**证据**（临时工作区，未触碰仓库文件）：
```
===== gs_save: multi-line title vs YAML front-matter =====
  saved=true path=...\hsr-stories\20260926-015737-Real Title_injected_ true_---.md
  file contents:
    ---
    kind: story
    title: Real Title
    injected: true
    ---
    createdAt: 2026-09-25T17:57:37.029Z
    generator: dsh-history-fictionologists
    ---
    body
```

---

## F7 [low] `lib/shell.js:842-845` — `/gs` 的「约 N 天前」无下界钳制（与 `gs_setup` 不一致）

**问题**：`gs_setup` 用 `Math.max(0, ...)`（`397`），`/gs` 文本没有：
```js
const age = Number.isFinite(parsed) ? Math.round((Date.now() - parsed) / 86400000) : null   // 842-843
... `（约 ${age ?? '?'} 天前，阈值 ${staleDays} 天）`                                          // 845
```
缓存时间戳在未来（时钟回拨 / 跨机器拷贝的缓存）会渲染成「约 -2 天前」。
**requiredFix**：与 `397` 一致加 `Math.max(0, ...)`。

**证据**：`lib/shell.js:397`（有钳制，实测未来时间戳 `ageDays=0`）对 `lib/shell.js:842-843`（无钳制）：
```
  FUTURE lastUpdated   rec=use-cache hasCache=true lastUpdated="2026-09-27T18:27:39.885Z" ageDays=0 ...
```
（`/gs` 一侧为代码引用；同一表达式在 842-843 无 `Math.max`，`Math.round((now-(now+2d))/day) === -2`。）

---

## F8 [low] `lib/shell.js:371-381, 407` — 不可解析的 `lastUpdated` 被原样回显，`advice` 却给出确定结论

**问题**：`typeof status.lastUpdated === 'string'` 只判类型不判可解析性，因此 `"not-a-date"` 会原样进入结果；
此时 `ageDays` 被丢弃（可选键，合规），但 `stale` 判定为真 → `advice` 说「缓存已超过 7 天，建议选 Y 增量更新」——
其实插件并不知道缓存多旧。**requiredFix**：不可解析时给 `warnings` 增一行并在 `advice` 里说明「缓存时间戳不可解析」。

**证据**：
```
  malformed lastUpdated   rec=update hasCache=true lastUpdated="not-a-date" ageDays=undefined advice="缓存已超过 7 天，建议选 Y 增量更新。" schema-ok
```

---

## F9 [low · 当前不可达] 子模块返回异常形态时外壳会抛 TypeError（降级不够彻底）

- `lib/shell.js:509`：`(result.failed ?? []).map(...)` —— `failed` 若是对象而非数组 →
  `TypeError: (result.failed ?? []).map is not a function`（实测）。
- `lib/shell.js:361`：`(status.datasets ?? []).map(...)` —— `status` 若是 `null` →
  `TypeError: Cannot read properties of null (reading 'datasets')`（实测）。

冻结版 `lib/wiki/index.mjs` 的 `update()` 恒返回数组 `failed`（`227`、`235`）、`status()` 恒返回对象，
所以**当前不可达**；仅在 wiki 子模块被替换/演进时才会暴露。列为低优先级的加固建议
（`Array.isArray(result.failed) ? result.failed : []` / `status ?? {}`），不阻塞交付。

**证据**：
```
  failed non-array: EXEC THREW (result.failed ?? []).map is not a function
TypeError: Cannot read properties of null (reading 'datasets')
    at execute (file:///C:/Users/masha/Desktop/hsr-history-fictionologists/lib/shell.js:361:34)
```

---

## F10 [info] `dsh-plugin-dev check --json` 唯一告警：五语 README 不完整

```
"readme-five-langs","severity":"warning","status":"warn","message":"five-language README incomplete",
"detail":["README-zh.md","README-es.md","README-pt.md","README-hi.md"]
```
`ok: true, passed 9, failed 0, warned 1, skipped 5`。属文档/打包层，不影响运行；若按 forge 技能 §8 的
「文档双语成对」门禁要求，需要补齐或显式豁免。

---

# 逐类别的「查过，未发现问题」记录

### 1. 崩树风险 —— 查过，未发现（4/5 项）
- **`Config` 不是普通对象**：`lib/shell.js:94-109` 为 `Schema === null ? undefined : Schema.object({...})`；
  实测解析到 `@deepseek-ai/schemastery` 且 `typeof Config['~standard'].validate === 'function'`
  （`node --test test/plugin.test.mjs` 的 `plugin module exposes the required contract` 通过）。
- **无硬 `import` `@deepseek-ai/*`**：`grep -rn "@deepseek-ai" lib/*.js` 只命中 `lib/resolve.js:6`（注释）
  与 `lib/shell.js` 的 JSDoc 类型引用；三个可选依赖全走 `lib/resolve.js` 的多 base 链
  （实测 5 个 base 全部命中 profile 共享层，`resolutionReport()` 四项 `resolvable: true`）。
- **`apply` 内无 `await`，注册全在 `ctx.effect()` 内**：`lib/shell.js:254`（同步 `apply`）→ 三个
  `ctx.effect()`：`276`（section）、`287`（6 个工具）、`795`（命令）；模块级 `await` 在 `65-76`，
  首次 await 早于任何注册，卸载窗口竞态不成立。
- **disposer 抛异常不破坏卸载**：工具 effect 的 disposer 对每个子 disposer 单独 `try/catch`（`783-791`）；
  section/命令的 disposer 是 `() => dispose?.()`，实测（会真正注销的 mock）不抛。
- 唯一发现的同类问题就是 **F2**（配置态非有限数把 required 键弄丢）。

### 2. 无损 JSON —— 查过，可达路径无违规
对 6 个工具的所有降级路径跑了「宿主真实校验器 + `hasNullValue` + JSON 往返」三重检查（真实缓存与空工作区各一轮）：
```
===== EMPTY WORKSPACE =====
  ok gs_setup({}) / ok gs_read({dataset:equations}) / ok gs_read({dataset:no-such}) / ok gs_missions({}) /
  ok gs_missions({series:不存在系列}) / ok gs_digest(kind=equation|mission-digest|book-digest|broadcast-template|nope) /
  ok gs_save(kind=story|inspiration|broadcast, title='..\..\evil' | '' | 500×'A')
===== REAL WORKSPACE (cache present) =====
  ok gs_setup({}) / ok gs_read({dataset:equations|equation|aeons, query, limit}) / ok gs_missions({limit:3}) /
  ok gs_digest(kind=equation|mission-digest|book-digest|broadcast-template, limit)
```
- `gs_read({})` / `gs_digest({})` 抛的是 **`invalid arguments: missing required property "dataset"/"kind"`**，
  即 `defineTool` 的参数校验在 `execute` 之前拦下，属正确行为（不是逃逸的异常）。
- `canonical()`（`lib/shell.js:200-203`）= `stripNullKeys(lossless(v))`：`undefined`、非有限数、`null 键`
  三类都被清理；数组元素里的 `null` 保留（`164-175`，其自带用例 `host-validator.test.mjs:127-133` 断言了这一点）。
- 曾怀疑的「`offset: Infinity` 导致 required 键 `offset` 消失」**不可达**：参数字段是有限数校验，
  实测 `validateJsonSchemaValue(tool.parameters, {dataset:'equations', offset: Infinity})` →
  `["\"offset\" must be a finite JSON number"]`。故该路径在宿主侧就被拒绝。
- 已知**可达**的违规只有 **F2**（配置态 NaN），已知不可达的异常形态见 **F9**。

### 3. 契约违规（schema / CommandDefinition / handler 抛出）—— 查过，未发现
- 6 个工具的 `output.schema` 均为显式 `additionalProperties` 的对象（`false`），
  且用宿主 DSL 的 `required: true` 内联写法；`tools.register` 注册期会走
  `assertSupportedJsonSchema`（`dsh-tools/lib/index.js:2882`）——6 个工具在真实宿主里注册成功即通过。
- 逐一核对「返回键集合 ↔ 声明键集合」：全部**双向一致**（无多键、无缺键，除非 F2 触发丢键）。
- 降级路径必填键齐全：`gs_update` 的 `wiki` 缺失分支（`469-478`）含全部 7 个 required 键（实测 schema-ok）。
- `/gs` 命令定义符合 `CommandDefinition`：`{ definitionId?, name:'gs', description, input:{hint, attachments:false}, handler }`
  （对照 `dsh-commands/lib/types/index.d.ts:38-44` 与 `types.d.ts` 的 `CommandInputDescriptor` 要求 `hint` 为必填字符串）。
  `CommandDefinitionId('...')` 是恒等函数（`dsh-commands/lib/types/brand.js:16-18`），拿不到就不传该键，符合 BRIEF §7.3。
- **`/gs` handler 从不抛出**（实测 7 种恶意 invocation）：
```
  followup throws            -> kind=success len=1472 [handoffNote present]
  createUserMessage throws   -> kind=success len=1467
  workspace() throws         -> kind=error  len=17  "虚构史学家启动失败：ws-boom"
  wiki.status throws         -> kind=success len=57  [statusLine=读取失败]
  rawInput = 42              -> kind=success
  invocation undefined       -> kind=success
  agent.followup missing     -> kind=success
```

### 4. 逻辑 bug —— 查过，`safeFileName` 与限流钳制无问题；stale 算术见下
**`gs_setup` 的 stale/recommendation/ageDays 算术表**（stub `wiki.status`，全部 schema-ok）：
```
  all fresh (1d)                 rec=use-cache hasCache=true ageDays=1
  6d old, threshold 7            rec=use-cache hasCache=true ageDays=6
  exactly 7d old                 rec=update    hasCache=true ageDays=7     <- 边界按「≥ 阈值即过期」，自洽
  8d old                         rec=update    hasCache=true ageDays=8
  malformed lastUpdated          rec=update    ageDays=undefined            <- F8
  FUTURE lastUpdated             rec=use-cache ageDays=0                    <- 与 F7 的 /gs 文本不一致
  empty datasets                 rec=update    hasCache=false lastUpdated=undefined
  count>0, lastUpdated null      rec=update    hasCache=true  lastUpdated=undefined
  threshold 0                    rec=update    advice="缓存已超过 0 天，建议选 Y 增量更新。"
  dataset ok:false, count 5      rec=use-cache ageDays=1
```
结论：无 NaN 泄漏、无负 `ageDays`、`present.length===0 → update`、`staleAfterDays` 边界自洽；
只有 F2（非有限配置）、F7（/gs 未钳制）、F8（不可解析时间戳的措辞）三处小问题。

**`safeFileName`**（`lib/shell.js:227-235`）—— 无路径穿越、无空名、无超长：
```
  "..\\..\\evil"                -> "_.._evil"(27 字符落盘名，实测 exists=true)
  ".." / "..." / "" / "   "     -> "untitled"
  "a/b\\c:d*e?f\"g<h>i|j"       -> "a_b_c_d_e_f_g_h_i_j"
  500×"A"                       -> 60 字符
  "title\nnewline"              -> "title_newline"
  "\u0000null"                  -> 未清洗，但 gs_save 捕获后返回 {saved:false,error}（不抛）
  "CON"                         -> "CON"，但落盘名形如 20260926-015725-CON.md，不是 Windows 保留设备名
```

**`gs_read` limit/offset 钳制**（`lib/shell.js:575-576`）—— 全部符合 BRIEF §7.4.3：
```
  limit 0 -> 20 | limit -5 -> 1 | limit 1000000000 -> 50      （钳制生效）
  offset -3 -> 0 | offset 99999 -> 返回 0 条（合法越界，不报错）
  limit/offset = NaN 或 Infinity -> EXEC THREW invalid arguments: "limit"/"offset" must be a finite JSON number
  limit/offset = "5"/"7"        -> EXEC THREW invalid arguments: "limit"/"offset" must be a number
```
即非有限数与字符串在 `defineTool` 的参数校验阶段（`execute` 之前）就被拒绝，
`Number.isFinite` 意义上的坏值**进不到** `575-576`——这也是「`offset: Infinity` 会丢 required 键」这一猜想不可达的原因
（与之一致：`validateJsonSchemaValue(tool.parameters, {dataset:'equations', offset: Infinity})` →
`["\"offset\" must be a finite JSON number"]`）。

### 5. 与真实子模块的接线 —— 查过，未发现错接（四个 digest 都非空，无静默空转）
真实缓存（12/12 数据集，`lastUpdated 2026-09-25T17:52:07.477Z`）实测：
```
  gs_setup hasCache=true datasets=12 withCount=12 lastUpdated=2026-09-25T17:52:07.477Z ageDays=0
           missions={"ok":true,"seriesCount":7,"missionCount":52} warnings=[]
  gs_missions {"limit":5}                  ok=true mdLen=885   first="## 已发生故事（避免与下列内容冲突）"
  gs_digest {"kind":"equation"}            ok=true mdLen=4285  first="## 方程命名逻辑（现实素材，勿凭空编造）"
  gs_digest {"kind":"mission-digest"}      ok=true mdLen=2598
  gs_digest {"kind":"book-digest"}         ok=true mdLen=2158  first="## 「书架」风格素材（现实素材，勿凭空编造）"
  gs_digest {"kind":"broadcast-template"}  ok=true mdLen=3141  first="## 星际和平播报 · 格式与语调（现实素材）"
```
- `missions.js`：`scanMissions(cfg)` 返回 `{ok, root, series[{name,region,version,missions[]}], counts:{series,missions,...}, warnings}`；
  外壳只读 `scan.ok` / `scan.series.length` / `scan.counts.missions`（`lib/shell.js:385-390`）—— 三个字段都在，7/52 与 BRIEF §6 一致。
- `digest.js`：四个导出（`equationNameDigest` / `missionDigest` / `bookDigest` / `broadcastDigest`）都是**同步**函数，
  外壳用 `await` 调用对非 Promise 同样成立；外壳只读 `ok` / `markdown` / `warnings`，`missionDigest` 额外提供
  `seriesCount` / `missionCount`（`lib/digest.js:486-492`）—— 与 `gs_missions` 的读取一致。
- `wiki/index.mjs`：`status(cfg)` / `read(cfg, {dataset,query,limit,offset})` / `update(cfg, {datasets,force,signal})`
  三个调用点的参数与返回字段都被真实运行覆盖（`update` 除外，见「未能验证」）。
- `rawInput` 非字符串（`42`）、缺 `agent`、缺 `invocation` 都能正常构造文本（不抛）。

### 6. 静默降级 —— 查过，未发现「完全静默」（两处降级都会说话）
- wiki 子模块缺失 → `gs_update` 返回 `failed:[{id:'*',error:'wiki 子模块不可用'}]` 且 `warnings` 有文案
  （`lib/shell.js:468-478`）；`gs_read` 返回 `warnings:['wiki 子模块不可用']`（`577-588`）。
- digest 子模块缺失 → `gs_missions` / `gs_digest` 返回 `ok:false` + `warnings`（`648-657`、`705-707`）。
- 可选依赖降级会 `logger.warn`（`262-265`），且 `__internals.helpers()` 暴露三项解析结果，可诊断。
- `gs_update` 的 `counts` 派生失败被静默吞掉（`501-503` 空 `catch`），但那是**附加统计**且结果里
  `counts: []` 可见，不会伪装成成功；不构成 F 级问题。

---

# 未能验证（明确标注「未验证」，不写成通过）

1. **`gs_update` 的真实联网路径未执行**：遵守「不联网」约束，`wiki.update()` 的实网抓取、
   revid 短路、失败回退只用 stub + 代码阅读核对（`lib/wiki/index.mjs:212-{...}`）。真实 e2e 证据在
   `_evidence/cache-roundtrip.txt`、`_evidence/verify-gs-e2e.txt`（写入者产出，我未复跑）。
2. **`test/host-validator.test.mjs` 与 `test/wiki.test.mjs` 的完整套件未跑**：前者含 F3 的联网用例。
   我只跑了离线且与本报告相关的 `node --test test/plugin.test.mjs`（10/10 通过）。
3. **YAML 加载器是否真会把 `.nan`/`.inf` 送进配置**：插件解析链里解析不到 `js-yaml`/`yaml`，
   故 F2 只证明了「配置对象含 NaN/Infinity 时必然违反契约」，配置文件路线未证明。
4. **真实 DSH 宿主里的端到端命令执行**：未启动任何 dsh 进程（约束）。写入者提供的
   `commands/list` / `commands/execute /gs` 证据我未复现。
5. **`lib/wiki/*` 与 `lib/missions.js` / `lib/digest.js` 的内部实现质量**：本轮只把它们当作「真实子模块契约」
   核对调用点与返回结构（这是外壳复核的范围），未做全面审计。

---

# BRIEF.md 本身的问题（错误 / 自相矛盾 / 已过期）

1. **§1 目录表 vs 现实**：BRIEF 规定外壳为 `lib/index.js`；冻结版外壳是 `lib/shell.js`（`package.json` 的
   `main`/`exports` 也指向它）。BRIEF §1 与 §7.1 的行号引用因此全部失效。
2. **§1 自相矛盾**：第 21 行写 `cordis.patch.yml # 不需要（bundle 清单方式）`，但同文件 §7 与
   `package.json` 的 `dsh.bundle.patch` 又要求随包交付 `cordis.patch.yml`；官方检查器
   （`dsh-plugin-dev check`）把 `cordis.patch.yml` + `dsh.bundle.patch` 判为**必须通过**项。现实实现是对的，
   BRIEF 这句注释是错的。
3. **§7.5 与实际取值不一致**：BRIEF 让 `order` 用固定数字 **4500**；实现用 **3050**（`lib/shell.js:29-32`，
   注释理由充分：紧跟内置 `TOOL_COMPUTER_USE=3000`、早于 MCP）。属于 BRIEF 与实现的良性偏差，但 BRIEF 未更新。
4. **§7.4 的返回契约不完整**：BRIEF 列的 `gs_setup` 返回键缺 `ok`/`workspace`/`ageDays`/`recentGuardDays`/`missions`/`warnings`，
   `gs_update` 缺 `ok`/`counts`；实现比 BRIEF 更丰富（不违规，但 BRIEF 作为「唯一事实来源」已不准确）。
5. **§5 路径优先级不完整**：BRIEF 列 5 条（env → `DSH_WORKSPACE` → cwd → 向上 4 级 → cwd 兜底），
   实现多了「cwd 起向上 5 级找标记目录」与 `packageRoot()` 两级（`lib/paths.js:61-76`）。行为更宽，BRIEF 未记录。
6. **§9 的验证项与实际手段脱节**：§9 只要求 `node --check` + 部署位置导入 + `node:test` + 真实抓取 + 缓存往返，
   **没有**要求「用宿主自己的 `validateJsonSchemaValue` 校验工具返回值」——而本轮唯一的 blocker 级缺陷
   （null 键导致 `INVALID_TOOL_OUTPUT`）恰好只能被这种校验发现。建议把该检查写进 §9。

---

# 复核手段（可复现）

```powershell
cd C:\Users\masha\Desktop\hsr-history-fictionologists
node --check lib/shell.js ; node --check lib/resolve.js ; node --check lib/paths.js     # 全部 exit 0
node --test test/plugin.test.mjs                                                        # tests 10 / pass 10 / fail 0
node "C:\Users\masha\.dsh\profiles\web\node_modules\dsh-plugin-guide\dist\dsh-plugin-dev.js" check --cwd . --json
node --input-type=module -e "<本报告各段给出的探针>"                                      # 仅本地，无网络
```
宿主校验器路径（理解 F1/F2 的关键）：`dsh-tools/lib/index.js:3541-3544`
`createSuccessResult` → `validateJsonSchemaValue(tool.output.schema, detached, "value")` → 违规即
`throw new ToolOutputError(tool.name, violations)`（`2550-2557`，code `INVALID_TOOL_OUTPUT`）。

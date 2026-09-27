# 复核报告 · 星球制造机（0.3.0）

## 结论

**有条件通过** —— 核心断言（三个工具真注册、真落盘、真能重置、27 颗原始星球与用户原话逐字一致、
两道防线在全部攻击路径下都没有被突破）经我独立复现成立，且**没有任何一条路径能覆写原始描述**；
但有 2 条中等、4 条低等 finding（静默丢弃、`en` 字段绕过去重、超长名字静默截断、测试文件里一处
永不生效的清理调用、英文名匹配略宽，外加一条作者已在复核中修复并留档），建议修复后再宣布交付。

> 复核期间作者在**同时改代码**（`lib/planets.mjs` / `test/planets.test.mjs` / `README.md` /
> `CHANGELOG.md` 的 mtime 从 17:51 一直变到 18:01）。本报告所有结论均在**下列指纹**下重跑过，
> 其中 F 项的英文名口径是作者**采纳我的 finding 之后**的新行为（代码注释与测试名都写着
> `reviewer B3 回归`），见 Findings R-2。

---

## 复核环境

| 项 | 值 |
|---|---|
| 仓库 | `C:\Users\masha\Desktop\hsr-history-fictionologists` |
| HEAD commit | `99d90278eb5f871b09d5f5e5c758ad8f3255e095`（`git rev-parse --short HEAD` → `99d9027`，与复核期间相同，未提交） |
| Node | `v24.21.0`（`node --version`） |
| 部署位置 | `C:\Users\masha\.dsh\profiles\web\node_modules\dsh-history-fictionologists` |
| junction 目标 | `C:\Users\masha\Desktop\hsr-history-fictionologists`（`LinkType: Junction`，实测 `shell.js/planets.mjs/package.json` 三份 SHA256 与源码逐字节相同） |
| 复核时快照（SHA256 前 16 位） | `lib/shell.js CEE3872B440180C2`(84908B) / `lib/planets.mjs 09658A20C01E5351`(24573B) / `test/planets.test.mjs BFCA4C8C50800CE3`(27354B) / `test/host-validator.test.mjs 824C57F3D7DA0629`(23957B) / `README.md 5A6F887D4EA8BD25`(30608B) / `CHANGELOG.md 83AAEC3EDD22A040`(38902B) / `package.json 01D8E406CCB1D67D`(1788B) |
| 联网 | **未做任何联网操作**（本次改动与网络无关） |

---

## 逐项判定

### A. 同义复现「27 颗 == 用户原话」（不采信作者脚本）—— **通过**

我新建了 `_evidence/reviewer-baseline-check.mjs`，用与作者脚本不同的四层姿势复现：

1. **多帧 zstd 换姿势**：作者是「解一帧 → `indexOf` 魔数 → 再解」；我改成
   **逐字节扫描全部 4 字节魔数偏移，每个偏移各试一次 `zstdDecompressSync`，成功即收下**，
   不依赖「解压 API 消耗了多少字节」这个未公开量。同时记录一个**反例**证明多帧确实存在：
   把整份文件喂给**流式** `createZstdDecompress()` 只能解出**第一帧 234 字节**就报
   `Unknown frame descriptor`。
2. **两路独立提取消息**：作者只认 `event.type === 'user/message'` 且按 `role` 过滤得到 0 条；
   我除了事件路（JSONL 解析）之外，另加**原始文本正则路**（在未解析的 JSONL 原文里用
   `/"text":"((?:[^"\\]|\\.)*)"/g` 抠 `text` 字段），两路结果必须一致。
3. **不引入任何原文片段当锚点**：作者用 `indexOf('阿丽万塔 (Arivanta)')` / `indexOf('日耀-XIII …')`
   切区段；我改为「含制表符的连续行块」+「从第一个制表符处切开首行前言」，不依赖任何字符串常量。
4. **比对维度**：逐行 + 名字集合双向差集 + 描述逐条 + `parseBaseline()` 二次解析交叉验证。

原始命令与输出（`_evidence/reviewer-baseline-check.txt` 全文）：

```
> node _evidence/reviewer-baseline-check.mjs
[A] 会话根目录：C:\Users\masha\.dsh\sessions
[A] 候选会话文件：58 个
[A]   DEBUG 原文首行长度=273 制表符个数=1
[A]   DEBUG 解析后首行 JSON="阿丽万塔 (Arivanta)\t受三颗卫星影响，引力时刻以波德函数形式变化，发展出了独特的生态系统，特产“换境树”。"
[A] 命中会话：C:\Users\masha\.dsh\sessions\--C-Users-masha-Desktop-hsr-history-fictionologists--\session-27186f34-d19b-4aa8-bfe8-f68d7eb1f525\session.v4.jsonl.zstd
[A] 提取姿势：event:type=user/message
[A] 解压：3025104 字符 / 993 帧；同一文件流式解码器只解出 234 字节（=多帧证据）
[A] 对照：按 data.role==='user' 过滤命中 6 条；原始文本正则路命中 4567 个候选块；两路结果一致=true
[A] 常量行数=27 用户原文行数=27
[A] 逐行不一致：0
[A] 名字集合：仅常量有 []；仅用户有 []
[A] 描述逐条不一致：0
[A] parseBaseline 二次解析条数=27；与 PLANETS 名字与描述一致=true

[A] PASS：27/27 行（名字+英文名+描述）与用户原话逐字符一致（流式解压 + 双路提取）
```

**关于作者脚本本身**（题目要求我评判它是否踩坑）：它记录的两个坑我**复现确认属实**——
(a) 多帧 zstd：流式解码器只给 234 字节，逐帧处理是必需的；(b) 事件里确实没有 `role` 字段
（我按 `data.role === 'user'` 过滤也得到 6 条命中，但那 6 条来自 `content[].type` 的块拼装路径，
按 `role` 过滤本身在外层会得 0 条）。它的锚点 `FIRST`/`LAST` 有真实脆弱性：**如果用户换个说法
描述同一份列表（首行前缀变成别的内容）**，锚点 `阿丽万塔 (Arivanta)` 仍能命中，但若用户改写了
第一颗星球的名字，脚本会报「找不到原文」而不是报「不一致」——这是**假阴性风险**，我的脚本没有
这个风险（不依赖任何原文片段）。作者脚本还留了一句 `void assert`（第 106 行）是无意义的空操作，
不影响结论。**没有发现作者脚本的假阳性**：它断言的 `mismatches === 0` 与我的独立结果一致。

**证据文件**：`_evidence/reviewer-baseline-check.mjs`、`_evidence/reviewer-baseline-check.txt`

---

### B. 反例攻击：重名与覆写防线 —— **通过（防线守住了；产出 1 条 medium）**

在**部署位置**驱动 `gs_planet_save`，22 条攻击用例（每个用例前清空增量文件，且**每条都逐条核对
落盘文件里的 27 条 baseline 描述是否与常量逐字相同**——作者脚本只断言 `rejected` 里有撞名项，
没做这个核对）。

原始命令：`node _evidence/reviewer-adversarial.mjs`（全文 `_evidence/reviewer-adversarial.txt`）

| # | 攻击写法 | ok | added | rejected | lossless | 覆写原始？ |
|---|---|---|---|---|---|---|
| B1 | `螺丝星\u3000`（全角空格尾随） | false | `[]` | `["螺丝星"]` | true | 无 |
| B2 | `  螺丝星  `（前后空格） | false | `[]` | `["螺丝星"]` | true | 无 |
| B3 | `ARIVANTA`（ASCII 大小写改写） | **false** | `[]` | `["ARIVANTA"]` | true | 无 |
| B4 | `螺丝\u3000星`（中间全角空格） | false | `[]` | `["螺丝　星"]` | true | 无 |
| B5 | `江户星/江户城`（无空格） | false | `[]` | `["江户星/江户城"]` | true | 无 |
| B6 | `江户星`（前缀） | true | `["江户星"]` | `[]` | true | 无 |
| B7 | `江户星 / 江户城`（原文） | false | `[]` | `["江户星 / 江户城"]` | true | 无 |
| B8 | `name: ''` | false | `[]` | `[]` | true | 无 |
| B9 | `name: '   '` | false | `[]` | `[]` | true | 无 |
| B10 | 200 字长名字 | true | 60 字截断后写入 | `[]` | true | 无 |
| B11 | 2000 字长描述 | true | 正常 | `[]` | true | 无 |
| B12 | 缺 description | true | 正常 | `[]` | true | 无 |
| B13 | 混入 `'x'`/`42`/`null`/`[]` + 1 个正常 | true | `["复核正常星"]` | `[]` | true | 无 |
| B14 | 全是非对象 | **throw** | — | — | — | 无 |
| B15 | 一次调用同名两次 | true | `["复核重复星"]` | `[]` | true | 无 |
| B16 | 一次调用两颗原始名 | false | `[]` | `["螺丝星","湛蓝星"]` | true | 无 |
| B17 | `planets: '洛珂萨'` | **throw** | — | — | — | 无 |
| B18 | `planets: []` | false | `[]` | `[]` | true | 无 |
| B19 | 缺 `planets` | **throw** | — | — | — | 无 |
| B20 | 螺丝星 + 正常星 | true | `["复核混装星"]` | `["螺丝星"]` | true | 无 |
| B21 | 先垫增量再试图用原始名覆写 | false | `[]` | `["螺丝星"]` | true | 无 |
| B22 | 增量同名更新 | true | `[]` | `[]`（updated） | true | 无 |

关键原始输出片段：

```
B14 planets 全是非对象
  ok=(throw) added="-" ... error=INVALID_ARGS: invalid arguments: "planets" must be a dense lossless JSON array
B17 planets 不是数组（字符串）
  ok=(throw) ... error=INVALID_ARGS: invalid arguments: "planets" must be an array
B19 planets 缺失
  ok=(throw) ... error=INVALID_ARGS: invalid arguments: missing required property "planets"
B22 增量同名更新（应进 updated 而非 added）
  ok=true   added=[] updated=["复核更新星"] rejected=[] lossless=true null=false 覆盖=[]
  文件里该条描述="第二版描述" 第一次 added=["复核更新星"]
B24 单次 25 条（MAX_BATCH=20）
  ok=true added=20 updated=0 addedCount=20 文件 added.length=20
  warnings=["单次最多并入 20 颗星球，超出部分未被处理"]
  未出现在返回值也不在文件里的候选：["复核批次星20","复核批次星21","复核批次星22","复核批次星23","复核批次星24"]
```

**结论：22/22 用例的 `覆盖=[]`——没有任何一种写法（含全角空格、大小写、前缀、空名、超长、
非对象、同调用重复、先垫增量再覆写）能把原始 27 颗里的描述覆写掉。** 这是本次改动最严重的一类
缺陷，实测不存在。`B3` 在复核早期版本里曾**成功写入** `ARIVANTA`（当时 `isBaselineName` 只比
中文名），作者随后采纳并修复（见 Findings R-2 的回归测试），当前版本已拒绝。

B14/B17/B19 抛 `INVALID_ARGS` 是**宿主 args 层**（`execute` 之前）拒绝的，不是工具返回的
`ok:false`——与 `test/host-validator.test.mjs:201` 的既有断言一致。

**证据文件**：`_evidence/reviewer-adversarial.mjs`、`_evidence/reviewer-adversarial.txt`

---

### C. 重置防线（字节数 + mtime + sha256 三重复核）—— **通过**

不看返回值，直接读文件事实：

```
=== C. gs_planet_reset 确认防线 ===
  重置前：bytes=6420 mtime=1790503240230.193 sha=cce42f1cbc838353 added=2 baseline=27
  gs_planet_reset({}) → ok=true reset=false removed=0 message="未重置（缺少 confirm=true）。当前已并入 2 颗新星球；请先向用户确认「是否要把星球列表重置回原始 27 颗」，得到肯定答复后再带 confirm: true 调用。"
  重置后：bytes=6420 mtime=1790503240230.193 sha=cce42f1cbc838353 added=2
  文件未变（bytes && mtime && sha 三者全等）=true
  gs_planet_reset({confirm:false}) → reset=false；文件未变=true
  gs_planet_reset({confirm:true}) → ok=true reset=true removed=2 total=27 bytes=6058
  文件：added.length=0 baseline.length=27 schema=dsh-history-fictionologists/planet-list@1
  宿主校验 violations=[] lossless=true
  重置后 gs_planets：baselineCount=27 addedCount=0 total=27
  再次 confirm:true → reset=true removed=0（幂等）

C2 目录里没有 planet-list.json 时 confirm:true → ok=true created=true removed=0 total=27
  文件已创建=true bytes=6058
```

- 不带 `confirm`：**bytes / mtime / sha 三者全等**，文件一个字节都没动；
- `confirm: false`：同样全等；
- `confirm: true`：`added.length=0`、`baseline.length=27`、`removed=2`、二次调用幂等；
- 文件原本不存在时 `created=true` 且真的建了文件。

**证据文件**：同上（C 段）。

---

### D. 宿主校验器口径（补作者遗漏的边界路径）—— **通过**

用宿主自己的 `@deepseek-ai/dsh-tools` 的 `validateJsonSchemaValue`（与 `test/host-validator.test.mjs`
同一函数，实测可解析），对 13 条路径做校验。作者覆盖的是「正常 + 过滤 + 非法入参 + 重名 + 无 confirm」，
我**补上**了他没覆盖的几条：`gs_planet_save` 全被拒绝分支、`planets=[]`、`planets` 子模块缺失下
三个工具各自的退化分支、`gs_setup` 退化分支、`gs_planets` 命中 0 条、并入缺 description 条目后。

```
  D1 gs_planet_save 全被拒绝: violations=[] lossless=true nullKeys=false
  D2 gs_planet_save planets=[]: violations=[] lossless=true nullKeys=false
  D3 gs_planets 子模块缺失: violations=[] lossless=true nullKeys=false
     ok=false baselineCount=27 matched=27 warnings=["planets 子模块不可用，仅返回编译进插件的内置原始列表（无法读取/写入增量列表）"]
  D4 gs_planet_save 子模块缺失: violations=[] lossless=true nullKeys=false
  D5 gs_planet_reset 子模块缺失（无 confirm）: violations=[] lossless=true nullKeys=false
  D6 gs_planet_reset 子模块缺失（confirm:true）: violations=[] lossless=true nullKeys=false
  D7 gs_setup 子模块缺失: violations=[] lossless=true nullKeys=false
  D8 gs_planets 命中 0 条: violations=[] lossless=true nullKeys=false
     命中 0 条：matched=0 planets=[] render 长度=564 含 guidance=true
  D9 gs_planets 并入「缺 description」后: violations=[] lossless=true nullKeys=false
     新增条目={"name":"复核渲染星","origin":"added","source":"other","addedAt":"2026-09-27T10:00:40.343Z"} render 含该名字=true saveCheck.ok=true
  D10 损坏 planet-list.json：listPlanets → ok=false baselineCount=27 addedCount=0 warnings=["planet-list.json 读取失败（Expected property name or '}' in JSON at position 2 (line 1 column 3)），已退回原始星球列表"]
  D11 顶层是标量 42：ok=false baselineCount=27 warnings=["planet-list.json 顶层不是对象，已退回原始星球列表"]
  D12 added 不是数组：ok=true addedCount=0 warnings=["planet-list.json 缺少 added 数组，已按空列表处理"]
  D13 文件里混入撞名/null/空名：addedCount=1 added=["合法星"] warnings=["planet-list.json 有 3 条因重名或字段非法被忽略"]
     读完之后文件里的 added.length=4（读取不应改写文件）
```

**13/13 条路径 `violations=[]`、`lossless=true`、`nullKeys=false`**——没有嵌套 `undefined`、
没有 `null` 值、全部通过宿主校验。注意 D3 的 `ok:false` 但 schema 校验通过（`ok` 是 boolean，
值为 false 合法），这一条比作者原来的断言更强。

**证据文件**：同上（D 段）。

---

### E. 口径与数字核对 —— **通过（文档与实测一致；作者在我复核期间同步更新了数字）**

| 声称 | 我的实测 | 判定 |
|---|---|---|
| `node scripts/check.mjs` → PASS | `RESULT: PASS (syntax failures: 0, test exit: 0)` | 一致 |
| `node --test` 168 / 167 pass / 0 fail / 1 skip | 复核早期 `ℹ tests 168 / pass 167 / fail 0 / skipped 1`；**复核后期（作者加用例后）为 `169 / 168 / 0 / 1`** | 早期一致；后期数字已变，作者文档也已同步改为 169 |
| `test/planets.test.mjs` 19 条离线用例 | 复核早期 `tests 19 / pass 19`；后期 `tests 20 / pass 20`（新增「英文名大小写变体也算重名」） | 早期一致；后期 +1 且合理 |
| `STYLE_GUIDE` 1749 字符 / 73 行 | **实测 `len=1748` / 换行数 71 / 含首行共 72 行**（`split('\n').length` 的 73 是把结尾换行算成一行） | **任务书里的 1749/73 与实测差 1**；仓库内 README/CHANGELOG 写的 **1748 字符 / 72 行与实测一致** |
| 版本 0.3.0 | `package.json` `"version": "0.3.0"`，`git diff` 显示 0.2.1 → 0.3.0 | 一致 |
| `gs_planets` 默认返回条数 | `matched=27 total=27 planets.length=27 source=undefined query=undefined updatedAt=undefined` | 27，与 README「默认返回 27 颗」一致 |
| README `168 个离线用例` | 已改为 **169**（`README.md:74` → `test/`（169 个离线用例）） | 已同步 |
| README `1749 字符 / 73 行` | 仓库里原本就是 **1748 字符 / 72 行**（`README.md:497`、`CHANGELOG.md:48`） | 与实测一致 |

原始输出：

```
> node scripts/check.mjs
ℹ tests 168          ← 复核早期
ℹ pass 167
ℹ fail 0
ℹ skipped 1
RESULT: PASS (syntax failures: 0, test exit: 0)

> node --test        ← 复核后期（作者加用例后）
ℹ tests 169
ℹ pass 168
ℹ fail 0
ℹ skipped 1

> node --test test/planets.test.mjs
ℹ tests 20 / pass 20 / fail 0        ← 后期（早期为 19/19）

STYLE_GUIDE len= 1748 lines(换行数)= 71 行数(含首行)= 72
gs_planets 默认：matched= 27 total= 27 planets.length= 27 source= undefined query= undefined updatedAt= undefined
```

**结论：没有发现「文档比证据走得更远」的地方**。唯一要提醒的是**任务书里给我的口径
`1749 字符 / 73 行` 与实测不符**（差 1 字符/1 行，是行尾换行计数口径差异），仓库文档本身没错。

---

### F. 抽一条换姿势重跑（名字容错判定）—— **通过，但抓到 2 个口径边界**

不信 `test/planets.test.mjs:227` 的断言，独立构造用例，**走工具入口**（不是直接调 `addPlanets`）：

```
  F1 螺丝星二号（不得当作 螺丝星）: 期望=added 实际=added OK（added=["螺丝星二号"] rejected=[]）
  F2 江户星（不得当作 江户星 / 江户城）: 期望=added 实际=added OK（added=["江户星"] rejected=[]）
  F3 江户星 / 江户城（原文写法，必须被拒）: 期望=rejected 实际=rejected OK（added=[] rejected=["江户星 / 江户城"]）
  F4 江户星/江户城（无空格，必须被拒）: 期望=rejected 实际=rejected OK（added=[] rejected=["江户星/江户城"]）
  F5 螺丝星（必须被拒）: 期望=rejected 实际=rejected OK（added=[] rejected=["螺丝星"]）
```

再独立实现一遍同义判定规则做矩阵对照（8 组全部 OK），并直接调被测导出的 `isBaselineName`：

```
  独立判定 sameName("江户星 / 江户城", "江户星/江户城") 期望=true 实际=true OK
  独立判定 sameName("江户星 / 江户城", "江户星") 期望=false 实际=false OK
  独立判定 sameName("螺丝星", "螺丝星二号") 期望=false 实际=false OK
  独立判定 sameName("螺丝星二号", "螺丝星") 期望=false 实际=false OK
  被测 isBaselineName("江户星/江户城") = true   被测 isBaselineName("江户星") = false
  被测 isBaselineName("螺丝星二号") = false     被测 isBaselineName("螺丝星　") = true
```

**测试没有自欺**：它的两条断言（`江户星/江户城` 被拒、`螺丝星二号` 入列）在我独立构造下都成立。

同一条测试旁边的**新增**口径（英文名大小写也算重名）我也攻击了，抓到 2 个边界：

```
  被测 isBaselineName("arivanta") = true（期望 true）OK
  被测 isBaselineName("ARIVANTA") = true（期望 true）OK
  被测 isBaselineName("Arivanta ") = true（期望 true）OK
  被测 isBaselineName("  arivanta  ") = true（期望 true）OK
  被测 isBaselineName("EDOSTAR") = true（期望 false）MISMATCH
  被测 isBaselineName("Edo Star") = true（期望 true）OK
  被测 isBaselineName("Edo  Star") = true（期望 false）MISMATCH
  被测 isBaselineName("edo") = false（期望 false）OK
  被测 isBaselineName("Arivantu") → 被测测试断言为「拼写相近但不同，应入列」，实测相符
```

以及工具入口下的两个行为：

```
  工具入口 gs_planet_save({name:'arivanta'}) → ok=false added=[] rejected=["arivanta"]      （已修复）
  工具入口 gs_planet_save({name:'洛珂萨', en:'Arivanta'}) → ok=true added=["洛珂萨"] rejected=[]   （见 R-3）
```

**证据文件**：`_evidence/reviewer-adversarial.mjs`、`_evidence/reviewer-adversarial.txt`（F 段）

---

## Findings

| id | severity | 问题 | 需要怎么修 | 文件:行 |
|---|---|---|---|---|
| **R-1** | **medium** | **超过 `MAX_BATCH=20` 的候选被静默丢弃**：一次传 25 条时，第 21–25 条既不在返回值的 `added`/`updated`/`rejected` 里，也没有落盘，而 `ok` 仍是 `true`、`addedCount=20`。`warnings` 里确有一句「超出部分未被处理」，但返回体没有任何**结构化**字段告诉模型哪 5 条被丢了——模型会向用户复述「这 25 颗都加进去了」。 | 在返回值里加 `overflow: { count, names }` 之类字段（或把超出项以 `rejected`+`reason:'超出单次上限'` 的形式列出），让模型能如实转告；`warnings` 保留。 | `lib/planets.mjs:428-431`（`if (rawList.length > MAX_BATCH)` / `accepted.slice(0, MAX_BATCH)`） |
| **R-2** | **medium**（**作者已修，留档**） | 复核早期版本里 `isBaselineName` 只比中文名，`ARIVANTA` / `arivanta`（原始列表「阿丽万塔 (Arivanta)」的英文名）能作为一颗「新星球」写进列表——围绕英文名绕开防线。 | 已修：`isBaselineName` 现在同时比对 `planet.en` 且不区分大小写，并新增回归测试。我实测 `gs_planet_save({name:'arivanta'})` → `ok=false, rejected=["arivanta"]`。 | `lib/planets.mjs:220-224`（现版本）；回归测试 `test/planets.test.mjs:244` |
| **R-3** | **low** | **`en` 字段仍旧可以绕过去重**：去重只看候选的 `name`，不看候选的 `en`。实测 `gs_planet_save({name:'洛珂萨', en:'Arivanta'})` → `ok=true, added=["洛珂萨"]`，于是列表里出现两条 `en: "Arivanta"`（原始「阿丽万塔」+ 新「洛珂萨」）。这不是覆写（原始描述没动），但会造出「同一颗英文名两个中文名」的脏数据。 | 在 `addPlanets` 里对候选的 `en` 也跑一次 `isBaselineName`（或在结果里对 `en` 撞名给出 `warnings`），至少要告警。 | `lib/planets.mjs:405`（`if (isBaselineName(entry.name))` 只传了 name） |
| **R-4** | **low** | **超长名字被静默截断到 `MAX_NAME=60`**：传 200 字名字时 `name.slice(0, MAX_NAME)` 直接截断，`ok=true`、`warnings=[]`，模型和用户都不知道名字被改短了。 | 与 `MAX_ADDED` 的处理对齐：超长时要么拒绝并说明，要么在 `warnings` 里报「N 条名字超过 60 字已截断」。 | `lib/planets.mjs:43`（`MAX_NAME = 60`）、`lib/planets.mjs:241`（`name: name.slice(0, MAX_NAME)`） |
| **R-5** | **low** | **一处永不生效的清理调用**：`test/host-validator.test.mjs` 的 `finally` 里写 `mod.__internals.resetPlanets(workspace)`，但 `__internals` **不导出** `resetPlanets`（实测 `Object.keys(mod.__internals)` 共 28 个键，不含它），于是每次都抛 `TypeError` 并被空 `catch` 吞掉——注释声称「重置回纯原始列表」，实际上文件从未被重置。本用例自带 `mkdtemp` 所以**不影响结论**，但注释与行为不符。 | 改成 `mod.__internals.stubSubmodules({reload:true})` 之外的正当路径（例如 `rmSync(workspace, {recursive:true,force:true})` 已足够，直接删掉这段），或把 `resetPlanets` 加进 `__internals`。 | `test/host-validator.test.mjs:193`；`lib/shell.js:1731`（`__internals` 导出表） |
| **R-6** | **low** | **英文名匹配略宽**：`isBaselineName('EDOSTAR') === true`（我的期望是 false）；`sameName` 的「去空格后相同」规则对**英文名**同样生效，所以 `Edo Star` / `EDOSTAR` / `Edo  Star` 都被判成「江户星 / 江户城」。方向的副作用是**多拒不可少拒**（模型换一个英文名即可），不会造成覆写。 | 若想让英文名判定更严，可对英文名只做「折叠空白 + 小写」的精确比较、不做去空格；或维持现状并在文档里写清「英文名去空格后同名即算重名」。 | `lib/planets.mjs:204-210`（`sameName`）、`lib/planets.mjs:223` |

**没有任何 blocker / high。** 两道防线（原始列表优先、重置需 confirm）在 22+ 条攻击路径下全部守住，
且 27 条原始描述在每条用例后都逐字未变。

---

## 未验证

明确列出我**没有**跑、因此**不能**写「通过」的部分：

1. **真机上模型是否照做两问**——`/gs` 协议文本里确实出现了「4) 星球制造机」「功能 4：先 gs_planets」
   「① 生成结束后用 ask_user_question 问」「② 紧接着再问一次」，但「模型真的会在生成后依次问这两件事」
   取决于模型行为，我**未在真机实例里发起过一次 `/gs` 会话**。README:451 自己也把这一格写成
   「真机上模型是否照做」。
2. **真实 DSH 主机的 args 层**——B14/B17/B19 的 `INVALID_ARGS` 来自 `defineTool` 在本次运行里
   解析到的宿主实现；我没有在真实 DSH 进程里通过 `/gs` 或工具调用跑一遍，因此「宿主 args 层
   在真实进程里的拒绝消息/错误码」不算已验证。`validateJsonSchemaValue` 是我能拿到的最接近的宿主口径。
3. **发布形态**——没有验证 `npm pack` 出来的 0.3.0 tarball 是否**包含** `lib/planets.mjs`
   （`package.json` 的 `files` 含 `lib`，静态看没问题，但未实测打包后 import 路径）。
4. **多进程并发写** `planet-list.json`——只验证了单进程内的原子写（`.tmp` + rename）；
   并发/崩溃场景未复现（属既有设计，不是本次新增逻辑）。
5. **Windows 下 mtime 的分辨率**——我用 25ms 的间隔 + sha256/bytes 来规避「mtime 粒度导致假通过」；
   但反过来，如果某次写发生得极快且内容恰好相同，mtime 可能不变——我的结论建立在**sha256 与 bytes
   全等**之上，不单靠 mtime。
6. **我没有改过任何被测文件**（唯一写入位置是 `_evidence/reviewer-*.mjs|.txt` 与 `$env:TEMP`），
   但**作者在复核期间一直在改** `lib/planets.mjs` / `test/planets.test.mjs` / `README.md` /
   `CHANGELOG.md`；我的结论对应上面的 SHA256 指纹，若作者继续改动，需要按 forge-roles §修正回路
   「只复核增量 diff 与受影响属性」再收口。

---

## 产物

新建的文件（全部在 `_evidence/` 下，均为我作为独立复核者新建；**未修改、未删除任何已有文件**）：

| 路径 | 说明 |
|---|---|
| `_evidence/reviewer-baseline-check.mjs` | A 项：独立复现「27 颗 == 用户原话」（多帧 zstd 逐字节扫描 + 双路消息提取 + 无锚点区段切分） |
| `_evidence/reviewer-baseline-check.txt` | 上述脚本的原始输出（PASS，27/27，不一致 0） |
| `_evidence/reviewer-adversarial.mjs` | B/C/D/F 项：22 条重名/覆写攻击 + 重置三重复核 + 13 条宿主校验边界路径 + 名字容错矩阵 |
| `_evidence/reviewer-adversarial.txt` | 上述脚本的原始输出（findings 4 条） |
| `_evidence/review-0.3.0-planets.md` | 本报告 |

临时文件（在 `$env:TEMP`，不在仓库内，仅调试用）：`hsf-dbg-msg.mjs`、`hsf-dbg2.mjs`、
`hsf-style-len.mjs`、`cc-probe.mjs`。

`git status --short` 原始输出（确认我没有动过任何被测文件；带 `??` 的 `reviewer-*` 四项即我的产物）：

```
 M BRIEF.md
 M CHANGELOG.md
 M README.md
 M docs/DESIGN.md
 M docs/github-description.md
 M lib/shell.js
 M package.json
 M test/host-validator.test.mjs
 M test/plugin.test.mjs
 M test/release.test.mjs
?? _evidence/planet-baseline-vs-user-text.mjs
?? _evidence/planet-baseline-vs-user-text.txt
?? _evidence/planet-tools-deploy.mjs
?? _evidence/planet-tools-deploy.txt
?? _evidence/planet-workspace-roundtrip.mjs
?? _evidence/planet-workspace-roundtrip.txt
?? _evidence/reviewer-adversarial.mjs
?? _evidence/reviewer-adversarial.txt
?? _evidence/reviewer-baseline-check.mjs
?? _evidence/reviewer-baseline-check.txt
?? _evidence/verify-gs-e2e-0.3.0.txt
?? lib/planets.mjs
?? test/planets.test.mjs
```

> 说明：`M BRIEF.md` / `docs/*` / `lib/shell.js` / `test/*` / `package.json` 等 10 个文件是
> **作者本次 0.3.0 改动的既有工作树状态**（我进场前就存在，且在我的复核期间继续变化）；
> 我本人只新增了上表 4 个 `reviewer-*` 文件。无法用 `git` 直接区分「作者改的」与「我改的」，
> 因此以「我从未对任何已有文件调用 write/edit」为据——本次会话中我的 write/edit 目标只有
> `_evidence/reviewer-baseline-check.mjs` 与 `_evidence/reviewer-adversarial.mjs`。

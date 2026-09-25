/**
 * dsh-history-fictionologists �?基于《崩坏：星穹铁道》官方世界观的二创辅助插件�? *
 * 三种功能（由 `/gs` 命令启动三步交互后执行）�? *   1. 神人制造机   —�?生成 3�? 条「方程一览」风格的荒诞科幻灵感
 *   2. 构史文集     —�?依据既有故事避让 + 书架风格，写一篇短篇小�? *   3. 星际构史播报 —�?虚构一�?3�? 条新闻的星际和平播报
 *
 * 数据面：
 *   - 12 �?biligame Wiki 数据源，增量抓取并缓存于 <workspace>/hsr-worldview-cache/
 *   - <workspace>/hsr-missions/ 下的既有故事，供功能 2/3 避让冲突
 *
 * 契约要点（DSH 插件红线）：
 *   - 一切注册走 `ctx.effect()`；`Config` 解析不到 Schemastery 时必须为 `undefined`
 *   - 可选依赖全部经 `lib/resolve.js` 的多 base 解析链，绝不�?import
 *   - 工具输出�?lossless JSON：对象里不放 `undefined` �? *
 * @module dsh-history-fictionologists
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { optionalDefault, optionalImport } from './resolve.js'
import { broadcastsDir, cacheDir, describePaths, inspirationsDir, resolveWorkspace, storiesDir } from './paths.js'

export const name = 'dsh-history-fictionologists'

/** Required services; DSH unloads/reloads the plugin if any of them comes or goes. */
export const inject = ['commands', 'tools', 'systemPrompt']

/** Placement: after the built-in tool sections (TOOL_COMPUTER_USE = 3000) and before MCP_SERVERS. */
const STYLE_SECTION_ORDER = 3050

/** Lazy module handles. Sub-modules are loaded defensively so a partial install still boots. */
const modules = {
  wiki: null,
  missions: null,
  digest: null,
  loaded: false,
  errors: [],
}

async function loadSubmodules() {
  if (modules.loaded) return modules
  modules.loaded = true
  for (const [key, specifier] of [
    ['wiki', './wiki/index.mjs'],
    ['missions', './missions.js'],
    ['digest', './digest.js'],
  ]) {
    try {
      modules[key] = await import(specifier)
    } catch (error) {
      modules[key] = null
      modules.errors.push({ module: specifier, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return modules
}

// ---------------------------------------------------------------------------
// Optional host helpers
// ---------------------------------------------------------------------------
// Resolved at module evaluation, NOT inside `apply`. Registering after the first
// `await` inside an async `apply` opens an unload-window race: the fiber can be
// disposed while the import is pending and the registrations would leak. Node
// memoizes ESM modules, so this costs one resolution per process.
const toolsMod = await optionalImport('@deepseek-ai/dsh-tools')
const llmMod = await optionalImport('@deepseek-ai/dsh-llm')
const cmdMod = await optionalImport('@deepseek-ai/dsh-commands/brand')

const defineTool = toolsMod?.defineTool ?? null
const createUserMessage = llmMod?.createUserMessage ?? null
const commandDefinitionId = cmdMod?.CommandDefinitionId ?? null

// ---------------------------------------------------------------------------
// Config (Schemastery or nothing �?a plain object here crashes the plugin tree)
// ---------------------------------------------------------------------------
const Schema = await optionalDefault('@deepseek-ai/schemastery')

/** Resolved defaults, also used when Schemastery is unavailable. */
const DEFAULTS = {
  workspace: '',
  requestIntervalMs: 2000,
  requestTimeoutMs: 30000,
  maxRetries: 3,
  staleAfterDays: 7,
  recentGuardDays: 7,
  defaultStoryWords: 2000,
  defaultBroadcastWords: 1000,
  inspirationCount: 4,
  saveOutputs: true,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

export const Config =
  Schema === null
    ? undefined
    : Schema.object({
        workspace: Schema.string().default('').description('数据工作区绝对路径；留空自动解析当前会话工作�?),
        requestIntervalMs: Schema.number().default(2000).description('相邻 Wiki 请求的最小间隔（毫秒），过高会被反爬拦截'),
        requestTimeoutMs: Schema.number().default(30000).description('单次 Wiki 请求超时（毫秒）'),
        maxRetries: Schema.number().default(3).description('Wiki 请求失败后的重试次数'),
        staleAfterDays: Schema.number().default(7).description('缓存超过该天数即建议用户重新抓取'),
        recentGuardDays: Schema.number().default(7).description('距上次更新不足该天数时，即使用户选择更新也提示确�?),
        defaultStoryWords: Schema.number().default(2000).description('构史文集默认篇幅（字�?),
        defaultBroadcastWords: Schema.number().default(1000).description('星际构史播报默认篇幅（字�?),
        inspirationCount: Schema.number().default(4).description('神人制造机默认灵感条数�?�?�?),
        saveOutputs: Schema.boolean().default(true).description('是否把成品落盘到 hsr-stories / hsr-broadcasts'),
        userAgent: Schema.string().default(DEFAULTS.userAgent).description('抓取 Wiki 时使用的 User-Agent'),
      })

const STYLE_GUIDE = `## 虚构史学家（/gs）语言风格总则

核心参考游戏内「差分宇宙·方程一览」：**用最严肃的格式包装最离谱的内�?*�?
- 把宏大哲学概念（记忆、虚无、欢愉、繁育、均衡、同谐、巡猎、毁灭、智识、存护…）与日常琐碎�?  荒诞离奇的具体意象嫁接；荒诞感来自「认真对待荒诞」，而不是「故意搞笑」�?- 允许一本正经地胡说八道，不要学术腔、不要说明文腔�?- 喜剧底色下可以带一点暗色，但不要沉闷；想象力优先，逻辑内部自洽即可�?- 命名要像方程：「大鼻子奶奶」「怒火船长」「和平主义者」这种「严肃词 × 市井词」的错位感�?- 涉及世界观设定时以插件提供的缓存数据为准�?*不得凭空编造与既有设定冲突的事�?*�?
三个功能的输出格式（逐字遵守）：

**神人制造机**�?�? 条）
\`\`\`
【灵感名称�?命途归属：〈主命途�?〈次命途�?一句话简介：…�?详细设定：……（�?100�?00 字，须带荒诞感）
可能的故事方向：…�?\`\`\`

**构史文集**：先�?hsr-missions 既有故事避免冲突，参考「书架」书籍风格，默认�?2000 �?（用户可指定），荒诞但不轻浮，喜剧底色下可有一丝温情或哲思�?
**星际构史播报**：约 800�?200 字�?�? 条新闻，格式固定�?\`\`\`
（音乐）

女声：这里是星际和平播报，观众朋友们晚上好�?男声：晚上好�?
女声：第一条消息。…�?男声：第二条消息。…�?
女声：本次播报到此结束，请在指定时间收听下一周期的星际和平播报�?（音乐）
\`\`\`
虚构文本必须足够科幻、足够太空、充满想象力�?*不是对已有故事的重组**�?
版权：米哈游对二创持开放态度，本插件产出属非营利性二创。`

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
/** Which optional host helpers the last `apply` managed to resolve (diagnostics/tests). */
let lastHelpers = { defineTool: false, createUserMessage: false, commandDefinitionId: false }

const nowIso = () => new Date().toISOString()

function str(value, fallback = '') {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * Drop `null` object keys so an OPTIONAL key that the host schema types as
 * `string`/`number`/`object` is simply absent. The DSH registry validates the
 * returned value against `output.schema` and `null` is not a string, so an
 * optional key that arrives as `null` fails the whole call ("returned invalid
 * output"). `lossless()` alone is not enough: it only removes `undefined`.
 * Array elements are kept (a `null` there is the caller's real value).
 */
function stripNullKeys(value) {
  if (Array.isArray(value)) return value.map(stripNullKeys)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === null) continue
      out[key] = stripNullKeys(item)
    }
    return out
  }
  return value
}

/**
 * Canonical lossless JSON: the host requires `JSON.parse(JSON.stringify(v))` to deep-equal `v`.
 * - objects: drop `undefined` keys
 * - arrays: drop `undefined` holes (they would stringify to `null`)
 * - numbers: drop non-finite values (`NaN`/`±Infinity` also stringify to `null`)
 * Anything else passes through unchanged.
 */
function lossless(value) {
  if (Array.isArray(value)) {
    return value.map(lossless).filter((item) => item !== undefined)
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (typeof item === 'number' && !Number.isFinite(item)) continue
      out[key] = lossless(item)
    }
    return out
  }
  return value
}

/** Canonical value for a tool result: lossless JSON with no null-valued keys. */
function canonical(value) {
  return stripNullKeys(lossless(value))
}

function safeFileName(input) {
  const cleaned = String(input ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const trimmed = cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned
  return trimmed.length > 0 ? trimmed : 'untitled'
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Text block handed to the renderer for human/agent display. */
function textOf(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function fail(message, error) {
  return canonical({ ok: false, error: message, detail: error === undefined ? undefined : String(error?.message ?? error) })
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const logger = ctx.logger('dsh-history-fictionologists')
  const workspace = () => resolveWorkspace(cfg)

  // -- optional DSH helpers -------------------------------------------------
  // Already resolved at module evaluation (see above): nothing is awaited before
  // the registrations below, so a disposal during apply cannot leave them behind.
  const helperErrors = []
  if (defineTool === null) helperErrors.push('@deepseek-ai/dsh-tools:defineTool 不可解析')
  if (createUserMessage === null) helperErrors.push('@deepseek-ai/dsh-llm:createUserMessage 不可解析')
  if (helperErrors.length > 0) logger.warn(`可选依赖降级：${helperErrors.join('�?)}`)
  lastHelpers = {
    defineTool: defineTool !== null,
    createUserMessage: createUserMessage !== null,
    commandDefinitionId: commandDefinitionId !== null,
  }

  // Sub-modules load lazily on first tool call; the first call is already
  // inside an execute() body, so it never races plugin disposal.

  // -- system prompt style section -----------------------------------------
  ctx.effect(() => {
    const section = ctx.systemPrompt.section({
      name: 'plugin:history-fictionologists:style',
      order: STYLE_SECTION_ORDER,
      text: STYLE_GUIDE,
      interpolate: false,
    })
    return () => section?.()
  }, 'history-fictionologists style section')

  // -- model-facing tools ---------------------------------------------------
  ctx.effect(() => {
    if (defineTool === null) {
      logger.warn('tools 未注册：defineTool 不可解析（插件已降级为仅 /gs 菜单�?)
      return () => {}
    }
    const disposers = []

    /** gs_setup �?�?2 步的数据源策略�?*/
    disposers.push(ctx.tools.register(defineTool({
      name: 'gs_setup',
      description:
        '查看《崩坏：星穹铁道》世界观缓存的现状并给出「是否重新抓取」的建议�?
        + '/gs 三步交互的第 2 步使用：先调用它拿到缓存状态，再用 ask_user_question 询问用户选择 Y（更新）还是 N（用缓存）�?,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            cacheDir: { type: 'string', required: true },
            workspace: { type: 'string', required: true },
            hasCache: { type: 'boolean', required: true },
            recommendation: { type: 'string', required: true },
            advice: { type: 'string', required: true },
            staleAfterDays: { type: 'number', required: true },
            recentGuardDays: { type: 'number', required: true },
            lastUpdated: { type: 'string' },
            ageDays: { type: 'number' },
            datasets: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  count: { type: 'number', required: true },
                  ok: { type: 'boolean', required: true },
                  lastUpdated: { type: 'string' },
                  error: { type: 'string' },
                },
              },
            },
            missions: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                seriesCount: { type: 'number', required: true },
                missionCount: { type: 'number', required: true },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => textOf(renderSetup(value)),
      },
      async execute() {
        const ws = workspace()
        const mods = await loadSubmodules()
        const warnings = []
        if (mods.wiki === null) warnings.push('wiki 子模块不可用，缓存状态未�?)
        let status = { ok: false, datasets: [], lastUpdated: undefined }
        if (mods.wiki !== null) {
          try {
            status = await mods.wiki.status({ ...cfg, workspace: ws })
          } catch (error) {
            warnings.push(`读取缓存状态失败：${String(error?.message ?? error)}`)
          }
        }
        // Optional keys (`lastUpdated`, `error`) must be ABSENT rather than null when
        // unknown: the host validates them as strings and rejects the whole call on null.
        const datasets = (status.datasets ?? []).map((d) =>
          canonical({
            id: str(d.id, 'unknown'),
            title: str(d.title, str(d.id, 'unknown')),
            count: Number.isFinite(d.count) ? d.count : 0,
            ok: d.ok !== false,
            lastUpdated: typeof d.lastUpdated === 'string' ? d.lastUpdated : undefined,
            error: typeof d.error === 'string' ? d.error : undefined,
          }),
        )
        const present = datasets.filter((d) => d.count > 0)
        const staleMs = Number(cfg.staleAfterDays) * 86400000
        const now = Date.now()
        const ages = present
          .map((d) => (d.lastUpdated === undefined ? Number.POSITIVE_INFINITY : now - Date.parse(d.lastUpdated)))
          .filter((ms) => Number.isFinite(ms) || ms === Number.POSITIVE_INFINITY)
        const stale = present.length === 0 || ages.some((ms) => !(ms < staleMs))
        const recommendation = present.length === 0 ? 'update' : stale ? 'update' : 'use-cache'
        const advice =
          present.length === 0
            ? '本地缓存为空，必须先抓取一次（�?Y/N 选择余地）�?
            : stale
              ? `缓存已超�?${cfg.staleAfterDays} 天，建议�?Y 增量更新。`
              : `缓存较新（阈�?${cfg.staleAfterDays} 天），建议�?N 直接用缓存；若用户仍�?Y，先提示一句「数据较新，确认需要重新抓取吗？」。`
        let missions = { ok: false, seriesCount: 0, missionCount: 0 }
        if (mods.missions !== null) {
          try {
            const scan = await mods.missions.scanMissions({ ...cfg, workspace: ws })
            missions = {
              ok: scan.ok !== false,
              seriesCount: (scan.series ?? []).length,
              missionCount: Number.isFinite(scan.counts?.missions) ? scan.counts.missions : 0,
            }
          } catch (error) {
            warnings.push(`读取 hsr-missions 失败�?{String(error?.message ?? error)}`)
          }
        }
        // `lastUpdated` may be absent (no cache) or unparsable; never emit NaN.
        const parsedLast = typeof status.lastUpdated === 'string' ? Date.parse(status.lastUpdated) : Number.NaN
        const ageDays = Number.isFinite(parsedLast) ? Math.max(0, Math.round((now - parsedLast) / 86400000)) : undefined
        return canonical({
          ok: true,
          cacheDir: cacheDir(ws),
          workspace: ws,
          hasCache: present.length > 0,
          recommendation,
          advice,
          staleAfterDays: Number(cfg.staleAfterDays),
          recentGuardDays: Number(cfg.recentGuardDays),
          lastUpdated: typeof status.lastUpdated === 'string' ? status.lastUpdated : undefined,
          ageDays,
          datasets,
          missions,
          warnings: (status.warnings ?? []).map(String).concat(warnings),
        })
      },
    })))

    /** gs_update �?增量抓取世界观数据�?*/
    disposers.push(ctx.tools.register(defineTool({
      name: 'gs_update',
      description:
        '增量抓取/更新《崩坏：星穹铁道》世界观数据�?2 �?Wiki 数据源）�?
        + '只重新抓取页面版本号变化的源；失败时保留旧缓存并�?warnings 里报告，必须把失败告知用户（「更新失败，已使用缓存数据」）�?,
      parameters: {
        datasets: {
          type: 'array',
          description: '只更新这些数据集 id（如 ["equations","aeons"]）；省略表示全部 12 个�?,
          items: { type: 'string' },
        },
        force: { type: 'boolean', description: '忽略版本号短路，强制重抓（默�?false）�? },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            cacheDir: { type: 'string', required: true },
            updated: { type: 'array', required: true, items: { type: 'string' } },
            skipped: { type: 'array', required: true, items: { type: 'string' } },
            failed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'string', required: true }, error: { type: 'string', required: true } },
              },
            },
            counts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'string', required: true }, count: { type: 'number', required: true } },
              },
            },
            durationMs: { type: 'number', required: true },
            lastUpdated: { type: 'string' },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => textOf(renderUpdate(value)),
      },
      async execute(args, exec) {
        const ws = workspace()
        const mods = await loadSubmodules()
        if (mods.wiki === null) {
          return canonical({
            ok: false,
            cacheDir: cacheDir(ws),
            updated: [],
            skipped: [],
            failed: [{ id: '*', error: 'wiki 子模块不可用' }],
            counts: [],
            durationMs: 0,
            warnings: ['wiki 子模块加载失败，无法抓取'],
          })
        }
        const started = Date.now()
        const result = await mods.wiki.update(
          { ...cfg, workspace: ws },
          {
            datasets: Array.isArray(args.datasets) && args.datasets.length > 0 ? args.datasets : undefined,
            force: args.force === true,
            signal: exec?.signal,
          },
        )
        const updated = result.updated ?? []
        const skipped = result.skipped ?? []
        // Post-update entry counts. `update()` reports per-dataset progress rather
        // than a counts array, so derive the numbers from the cache index instead
        // of assuming a return shape the data layer does not own.
        let counts = []
        try {
          const after = await mods.wiki.status({ ...cfg, workspace: ws })
          const wanted = new Set([...updated, ...skipped])
          counts = (after.datasets ?? [])
            .filter((d) => wanted.size === 0 || wanted.has(d.id))
            .map((d) => ({ id: str(d.id, ''), count: Number.isFinite(d.count) ? d.count : 0 }))
        } catch {
          // counts are advisory; never fail an update over them
        }
        return canonical({
          ok: (result.failed ?? []).length === 0,
          cacheDir: cacheDir(ws),
          updated,
          skipped,
          failed: (result.failed ?? []).map((f) => ({ id: str(f.id, '*'), error: str(f.error, '未知错误') })),
          counts,
          durationMs: Date.now() - started,
          lastUpdated: result.lastUpdated,
          warnings: result.warnings ?? [],
        })
      },
    })))

    /** gs_read �?读缓存正文�?*/
    disposers.push(ctx.tools.register(defineTool({
      name: 'gs_read',
      description:
        '读取已缓存的世界观数据条目（方程/星神/派系/专有名词/遗器来历/光锥故事/消耗品/装饰/奇物/事件/播报…）�?
        + '生成任何内容前都必须先用它取真实素材，不得凭记忆编造设定�?,
      parameters: {
        dataset: {
          type: 'string',
          required: true,
          description: 'equation|event|curio|consumable|decoration|relic|lightcone|aeon|faction|term|simuniverse|broadcast',
        },
        query: { type: 'string', description: '关键词过滤（匹配条目名称或正文）�? },
        limit: { type: 'number', description: '返回条数，默�?20，上�?50�? },
        offset: { type: 'number', description: '偏移量，默认 0�? },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            dataset: { type: 'string', required: true },
            title: { type: 'string', required: true },
            total: { type: 'number', required: true },
            matched: { type: 'number', required: true },
            offset: { type: 'number', required: true },
            limit: { type: 'number', required: true },
            lastUpdated: { type: 'string' },
            entries: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  content: { type: 'string', required: true },
                  truncated: { type: 'boolean' },
                  path: { type: 'string' },
                  category: { type: 'string' },
                  mode: { type: 'string' },
                  rarity: { type: 'string' },
                  version: { type: 'string' },
                },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => textOf(renderRead(value)),
      },
      async execute(args) {
        const ws = workspace()
        const mods = await loadSubmodules()
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 50)
        const offset = Math.max(0, Number(args.offset) || 0)
        if (mods.wiki === null) {
          return canonical({
            ok: false, dataset: str(args.dataset, ''), title: '', total: 0, matched: 0,
            offset, limit, entries: [], warnings: ['wiki 子模块不可用'],
          })
        }
        const result = await mods.wiki.read(
          { ...cfg, workspace: ws },
          { dataset: str(args.dataset, ''), query: str(args.query, ''), limit, offset },
        )
        return canonical({
          ok: result.ok !== false,
          dataset: str(result.dataset, str(args.dataset, '')),
          title: str(result.title, ''),
          total: Number.isFinite(result.total) ? result.total : 0,
          matched: Number.isFinite(result.matched) ? result.matched : 0,
          offset,
          limit,
          lastUpdated: result.lastUpdated,
          entries: (result.entries ?? []).map((e) =>
            lossless({
              name: str(e.name, '(未命�?'),
              content: str(e.content, ''),
              truncated: e.truncated === true ? true : undefined,
              path: e.path,
              category: e.category,
              mode: e.mode,
              rarity: e.rarity,
              version: e.version,
            }),
          ),
          warnings: result.warnings ?? [],
        })
      },
    })))

    /** gs_missions �?既有故事避让素材�?*/
    disposers.push(ctx.tools.register(defineTool({
      name: 'gs_missions',
      description:
        '查看 hsr-missions 里「已发生的故事」（避免新故事与其冲突）。功�?2 构史文集与功�?3 播报生成前必须调用一次�?,
      parameters: {
        series: { type: 'string', description: '指定系列名（如「蕉恶非道•无忍义之战」），省略则返回总目录�? },
        query: { type: 'string', description: '关键词过滤任务名/描述�? },
        limit: { type: 'number', description: '条目上限，默�?40�? },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            root: { type: 'string', required: true },
            seriesCount: { type: 'number', required: true },
            missionCount: { type: 'number', required: true },
            markdown: { type: 'string', required: true },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => textOf(value.markdown.length > 0 ? value.markdown : '（无既有故事数据�?),
      },
      async execute(args) {
        const ws = workspace()
        const mods = await loadSubmodules()
        if (mods.digest === null) {
          return canonical({ ok: false, root: ws, seriesCount: 0, missionCount: 0, markdown: '', warnings: ['digest 子模块不可用'] })
        }
        const dig = await mods.digest.missionDigest({ ...cfg, workspace: ws }, {
          series: str(args.series, ''),
          query: str(args.query, ''),
          limit: Number(args.limit) || 40,
        })
        return canonical({
          ok: dig.ok !== false,
          root: ws,
          seriesCount: Number.isFinite(dig.seriesCount) ? dig.seriesCount : 0,
          missionCount: Number.isFinite(dig.missionCount) ? dig.missionCount : 0,
          markdown: str(dig.markdown, ''),
          warnings: dig.warnings ?? [],
        })
      },
    })))

    /** gs_digest �?命名逻辑/风格素材�?*/
    disposers.push(ctx.tools.register(defineTool({
      name: 'gs_digest',
      description:
        '获取风格与结构素材：equation=方程命名逻辑与范例；mission-digest=已发生故事目录；'
        + 'book-digest=「书架」书籍风格；broadcast-template=星际和平播报格式模板与真实片段�?,
      parameters: {
        kind: {
          type: 'string',
          required: true,
          description: 'equation | mission-digest | book-digest | broadcast-template',
        },
        limit: { type: 'number', description: '素材条数上限（默认按各类型取值）�? },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            kind: { type: 'string', required: true },
            markdown: { type: 'string', required: true },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => textOf(value.markdown.length > 0 ? value.markdown : '（无可用素材�?),
      },
      async execute(args) {
        const ws = workspace()
        const mods = await loadSubmodules()
        const kind = str(args.kind, '')
        if (mods.digest === null) {
          return canonical({ ok: false, kind, markdown: '', warnings: ['digest 子模块不可用'] })
        }
        const limit = Number(args.limit) || undefined
        let result
        try {
          if (kind === 'equation') result = await mods.digest.equationNameDigest({ ...cfg, workspace: ws }, { limit })
          else if (kind === 'mission-digest') result = await mods.digest.missionDigest({ ...cfg, workspace: ws }, { limit })
          else if (kind === 'book-digest') result = await mods.digest.bookDigest({ ...cfg, workspace: ws }, { limit })
          else if (kind === 'broadcast-template') result = await mods.digest.broadcastDigest({ ...cfg, workspace: ws }, { limit })
          else return canonical({ ok: false, kind, markdown: '', warnings: [`未知 kind�?{kind}`] })
        } catch (error) {
          return canonical({ ok: false, kind, markdown: '', warnings: [`生成素材失败�?{String(error?.message ?? error)}`] })
        }
        return canonical({
          ok: result.ok !== false,
          kind,
          markdown: str(result.markdown, ''),
          warnings: result.warnings ?? [],
        })
      },
    })))

    /** gs_save �?成品落盘�?*/
    disposers.push(ctx.tools.register(defineTool({
      name: 'gs_save',
      description:
        '把生成的成品写入工作区：story �?hsr-stories/，broadcast �?hsr-broadcasts/，inspiration �?hsr-stories/inspirations/�?
        + '输出生成完成后调用一次，告诉用户文件位置�?,
      parameters: {
        kind: { type: 'string', required: true, description: 'story | broadcast | inspiration' },
        title: { type: 'string', required: true, description: '作品标题（用于文件名）�? },
        content: { type: 'string', required: true, description: 'Markdown 正文�? },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            saved: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
            error: { type: 'string' },
          },
        },
        render: (_args, value) => textOf(value.saved ? `已保存：${value.path}�?{value.bytes} 字节）` : `保存失败�?{value.error ?? '未知错误'}`),
      },
      async execute(args) {
        const ws = workspace()
        const kind = str(args.kind, 'story')
        const title = str(args.title, 'untitled')
        const body = str(args.content, '')
        const dir = kind === 'broadcast' ? broadcastsDir(ws) : kind === 'inspiration' ? inspirationsDir(ws) : storiesDir(ws)
        if (cfg.saveOutputs !== true) {
          return canonical({ saved: false, path: '', bytes: 0, error: 'saveOutputs 已关闭（config.saveOutputs=false�? })
        }
        try {
          await mkdir(dir, { recursive: true })
          const file = join(dir, `${stamp()}-${safeFileName(title)}.md`)
          const front = [
            '---',
            `kind: ${kind}`,
            `title: ${title}`,
            `createdAt: ${nowIso()}`,
            'generator: dsh-history-fictionologists',
            '---',
            '',
          ].join('\n')
          await writeFile(file, front + body, 'utf8')
          return canonical({ saved: true, path: file, bytes: Buffer.byteLength(body, 'utf8') })
        } catch (error) {
          return canonical({ saved: false, path: '', bytes: 0, error: String(error?.message ?? error) })
        }
      },
    })))

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.()
        } catch {
          // disposers are best-effort; a failure here must not break unload
        }
      }
    }
  }, 'history-fictionologists tools')

  // -- /gs command ----------------------------------------------------------
  ctx.effect(() => {
    const definitionId =
      typeof commandDefinitionId === 'function'
        ? commandDefinitionId('dsh-history-fictionologists')
        : undefined
    const dispose = ctx.commands.register(lossless({
      ...(definitionId === undefined ? {} : { definitionId }),
      name: 'gs',
      description: '虚构史学家：生成星穹铁道世界观灵�?/ 短篇 / 星际和平播报',
      input: { hint: '[可选的灵感主题、命途或播报主题]', attachments: false },
      handler: (invocation) => runGsCommand(invocation, { cfg, workspace, logger, createUserMessage }),
    }))
    return () => dispose?.()
  }, 'history-fictionologists /gs command')

  logger.info(`已加载：工作�?${workspace()}，缓存目�?${cacheDir(workspace())}`)
}

// ---------------------------------------------------------------------------
// /gs command handler
// ---------------------------------------------------------------------------
/**
 * Local, model-free command: inspect state and hand the whole three-step protocol
 * to the agent as a plugin-sourced user message.
 */
async function runGsCommand(invocation, { cfg, workspace, logger, createUserMessage }) {
  const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
  try {
    const ws = workspace()
    const mods = await loadSubmodules()
    const lines = []
    lines.push('【虚构史学家 /gs 已启动�?)
    lines.push('')
    lines.push(`工作区：${ws}`)
    lines.push(`缓存目录�?{cacheDir(ws)}`)

    let statusLine = '不可用（wiki 子模块未加载�?
    let hasCache = false
    const staleDays = Number(cfg.staleAfterDays)
    if (mods.wiki !== null) {
      try {
        const status = await mods.wiki.status({ ...cfg, workspace: ws })
        const ds = status.datasets ?? []
        const present = ds.filter((d) => (d.count ?? 0) > 0)
        hasCache = present.length > 0
        const age = status.lastUpdated === undefined ? null : Math.round((Date.now() - Date.parse(status.lastUpdated)) / 86400000)
        statusLine = hasCache
          ? `${present.length}/${ds.length} 个数据集有数据，最近更�?${status.lastUpdated ?? '未知'}（约 ${age ?? '?'} 天前，阈�?${staleDays} 天）`
          : '本地缓存为空'
        const detail = ds
          .map((d) => `${d.id}=${d.count ?? 0}${d.ok === false ? '(失败)' : ''}`)
          .join('  ')
        if (detail.length > 0) lines.push(`数据集：${detail}`)
      } catch (error) {
        statusLine = `读取失败�?{String(error?.message ?? error)}`
      }
    }
    lines.push(`缓存状态：${statusLine}`)

    if (raw.length > 0) {
      lines.push('')
      lines.push(`用户附带参数�?{raw}`)
    }

    lines.push('')
    lines.push('请严格按以下三步与我交互（不要跳步、不要自己替我选）�?)
    lines.push('')
    lines.push('�?1 �?· 功能选择：用 ask_user_question 弹出一个单选问题，三个选项逐字为：')
    lines.push('  1) 神人制造机 —�?生成新的科幻灵感')
    lines.push('  2) 构史文集 —�?根据灵感撰写短篇小说')
    lines.push('  3) 星际构史播报 —�?虚构一期星际和平播报节�?)
    lines.push('')
    lines.push('�?2 �?· 世界观数据更新策略：先调�?gs_setup 读缓存状态，再用 ask_user_question 问一次（单选）�?)
    lines.push('  Y) 访问网页，重新抓取并更新世界观数�?)
    lines.push(`  N) 使用本地已有的世界观数据�?{hasCache ? '（推荐）' : ''}`)
    lines.push(`  若本地缓存为空：跳过本步的询问，直接调用 gs_update 抓取，并告知用户「本地无缓存，已自动抓取」。`)
    lines.push(`  若缓存存在但较新（不�?${cfg.recentGuardDays} 天）：即使我选了 Y，也先问一句「数据较新，确认需要重新抓取吗？」再决定。`)
    lines.push('  �?Y �?调用 gs_update（增量，只更新有变化的页面）；若返回 failed 非空，明确告诉我「更新失败，已使用缓存数据」�?)
    lines.push('  �?N �?直接用缓存�?)
    lines.push('')
    lines.push('�?3 �?· 执行所选功能：')
    lines.push(`  · 功能 1：先 gs_digest(kind="equation") 学「方程一览」的命名与想象力，再 gs_read 取星�?派系/专有名词素材，`
      + `生成 ${cfg.inspirationCount} 条（3�? 条之间）灵感，逐字使用【灵感名称�?命途归�?一句话简�?详细设定/可能的故事方�?的格式。`)
    lines.push('  · 功能 2：先 gs_missions（必要时�?gs_digest(kind="book-digest")）确保不与已发生故事冲突�?
      + `再围绕给定灵感写�?${cfg.defaultStoryWords} 字短篇；写完后用 gs_save(kind="story") 落盘。`)
    lines.push('  · 功能 3：先 gs_digest(kind="broadcast-template") 读格式与语调，再 gs_missions 避让既有故事�?
      + `虚构�?${cfg.defaultBroadcastWords} 字�?�? 条新闻的播报；写完后�?gs_save(kind="broadcast") 落盘。`)
    lines.push('')
    lines.push('硬性要求：所有设定都要来�?gs_* 工具返回的缓存数据，不得凭空编造与既有设定冲突的事实；'
      + '语言风格遵循系统提示中的「虚构史学家语言风格总则」�?)
    lines.push('现在请直接执行第 1 步：调用 ask_user_question 让我选功能�?)

    const text = lines.join('\n')

    // Hand the protocol to the agent as a plugin-sourced user message.
    let handedOff = false
    let handoffNote = ''
    const agent = invocation?.agent
    if (typeof createUserMessage === 'function' && agent !== undefined && typeof agent.followup === 'function') {
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name },
        }))
        handedOff = true
      } catch (error) {
        handoffNote = `（无法自动接管本轮对话：${String(error?.message ?? error)}）`
        logger?.warn?.(handoffNote)
      }
    } else {
      handoffNote = '（当前宿主不支持 agent.followup，请把下面的内容当作本轮指令直接执行。）'
    }

    const short = [
      '虚构史学�?/gs 已启动�?,
      statusLine,
      handedOff ? '交互协议已交给模型，正在准备�?1 步的功能选择�? : handoffNote,
    ].join('\n')

    return {
      kind: 'success',
      text: handedOff ? short : `${short}\n\n${text}`,
    }
  } catch (error) {
    logger?.warn?.(`/gs 失败�?{String(error?.message ?? error)}`)
    return { kind: 'error', text: `虚构史学家启动失败：${String(error?.message ?? error)}` }
  }
}

// ---------------------------------------------------------------------------
// Model-facing renderers (pure functions of the canonical value)
// ---------------------------------------------------------------------------
function renderSetup(value) {
  if (value.ok !== true) return `读取缓存状态失败：${value.error ?? '未知错误'}`
  const rows = value.datasets
    .map((d) => `- ${d.id}�?{d.title}）：${d.count} �?{d.ok ? '' : ' ⚠失�?}${d.lastUpdated ? ` · ${d.lastUpdated}` : ''}`)
    .join('\n')
  return [
    `缓存目录�?{value.cacheDir}`,
    `工作区：${value.workspace}`,
    `本地缓存�?{value.hasCache ? '�? : '�?}`,
    value.lastUpdated ? `最近更新：${value.lastUpdated}（约 ${value.ageDays ?? '?'} 天前）` : '最近更新：�?,
    `建议�?{value.recommendation === 'update' ? '抓取/更新（Y�? : '直接用缓存（N�?}`,
    value.advice,
    `既有故事�?{value.missions.ok ? `${value.missions.seriesCount} 个系�?/ ${value.missions.missionCount} 个任务` : '未读�?hsr-missions'}`,
    '',
    rows,
    value.warnings.length > 0 ? `\n警告：\n${value.warnings.map((w) => `- ${w}`).join('\n')}` : '',
  ].filter((s) => s !== '').join('\n')
}

function renderUpdate(value) {
  const parts = [
    `更新完成：updated=${value.updated.length} skipped=${value.skipped.length} failed=${value.failed.length}�?{value.durationMs} ms）`,
  ]
  if (value.updated.length > 0) parts.push(`- 已更新：${value.updated.join(', ')}`)
  if (value.skipped.length > 0) parts.push(`- 无变化跳过：${value.skipped.join(', ')}`)
  if (value.failed.length > 0) {
    parts.push(`- 失败�?{value.failed.map((f) => `${f.id}(${f.error})`).join('; ')}`)
    parts.push('�?更新失败，已使用缓存数据——请把这一点明确告知用户�?)
  }
  if (value.counts.length > 0) parts.push(`- 条目数：${value.counts.map((c) => `${c.id}=${c.count}`).join(' ')}`)
  if (value.warnings.length > 0) parts.push(`- 警告�?{value.warnings.join('; ')}`)
  return parts.join('\n')
}

function renderRead(value) {
  if (value.ok !== false && value.total === 0) {
    return `数据�?${value.dataset} 还没有缓存。请先运�?gs_update 抓取，或改读其他数据集。`
  }
  const head = `数据�?${value.dataset}�?{value.title}）：�?${value.total} 条，匹配 ${value.matched} 条，返回 ${value.entries.length} 条`
    + (value.lastUpdated ? `（缓存于 ${value.lastUpdated}）` : '')
  const body = value.entries
    .map((e) => {
      const meta = [e.mode, e.rarity, e.category, e.path, e.version].filter((x) => typeof x === 'string' && x.length > 0).join(' / ')
      return `\n### ${e.name}${meta ? `�?{meta}）` : ''}\n${e.content}${e.truncated ? '\n…（已截断）' : ''}`
    })
    .join('\n')
  const warnings = value.warnings.length > 0 ? `\n\n警告�?{value.warnings.join('; ')}` : ''
  return head + body + warnings
}

// ---------------------------------------------------------------------------
// Re-exports for tests and diagnostics
// ---------------------------------------------------------------------------
export const __internals = {
  DEFAULTS,
  STYLE_GUIDE,
  STYLE_SECTION_ORDER,
  lossless,
  safeFileName,
  stamp,
  runGsCommand,
  loadSubmodules,
  describePathFacts: (cfgOverride) => describePaths({ ...DEFAULTS, ...(cfgOverride ?? {}) }),
  moduleErrors: () => [...modules.errors],
  helpers: () => lastHelpers,
  basename,
}

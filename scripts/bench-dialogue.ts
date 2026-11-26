/**
 * 对话记录库规模基准：在临时目录里生成合成会话日志，用插件自己的对话记录库、追赶编排和检索入口计时，
 * 输出一张结果表（档、项目、数值、单位）和几行判定。手动运行；`--tier ci` 也用于 CI，跑完删除临时目录。
 *
 * 用法：
 *   node scripts/bench-dialogue.ts                         同 --tier all
 *   node scripts/bench-dialogue.ts --tier all              200、1 千、5 千个会话，加单个巨大日志
 *   node scripts/bench-dialogue.ts --tier ci               CI：小规模会话档加一个较小的巨大日志
 *   node scripts/bench-dialogue.ts --sessions 3 --turns 6 --huge-turns 60 --rounds 3
 *                                                          自定规模（档名记作 custom），不能和 --tier 同传
 *
 * 判定（任何一行 FAIL 退出码为 1）：
 *   - 检索前追赶不超过时间上限：实测 ≤ 预算（CATCHUP_FOCUS_BUDGET_MS）+ 单个会话最长耗时 + 收尾统计。
 *   - 两个进程同时追，库内容一致：两个进程同时从空库建同一批会话，建完的库和单个进程建的逐段相同。
 * 某一档某一项中途抛错：整次失败，写明是哪一档哪一项，不打印残缺的结果表；临时目录照常删。
 * 合成日志只用脚本里的固定词表，不含真实对话；时间从固定起点算，不取当天。
 */
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readdirSync, realpathSync, statSync, statfsSync } from 'node:fs'
import { tmpdir, cpus, platform, arch } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { DialogueRecordStore } from '../src/storage/dialogue-records.ts'
import { DIALOGUE_RECORDS_FILE } from '../src/storage/paths.ts'
import { CATCHUP_FOCUS_BUDGET_MS } from '../src/tools/dialogue-catchup.ts'
import type { SessionLog } from '../src/session-log.ts'

/** 一档的规模：sessions 个会话、每个 turns 轮；hugeTurns 是单个巨大日志的轮数。没有的部分这一档不跑。 */
export interface DialogueBenchScale {
  sessions?: number
  turns?: number
  hugeTurns?: number
}

/**
 * 命名的档。会话档每个会话 20 轮，和日常会话的长度相当；巨大日志 5 万轮，JSONL 约几十 MB，
 * 用来看整份读日志和同步切段对前台的影响。ci 档在共享 runner 上几十秒内跑完。
 */
export const DIALOGUE_BENCH_TIERS = {
  ci: { sessions: 40, turns: 20, hugeTurns: 1_000 },
  '200': { sessions: 200, turns: 20 },
  '1k': { sessions: 1_000, turns: 20 },
  '5k': { sessions: 5_000, turns: 20 },
  huge: { hugeTurns: 50_000 },
} as const satisfies Record<string, DialogueBenchScale>

/** --tier all 依次跑的档。 */
export const DIALOGUE_BENCH_ALL = ['200', '1k', '5k', 'huge'] as const

/** 检索前追赶那一项：开着的会话取 min(会话数, 这个数) 个，每个追加 FOCUS_NEW_TURNS 轮新消息再计时。 */
export const FOCUS_LIVE_SESSIONS = 30
/** 让检索前追赶在 ci 档也确实追不完：每个开着的会话追加的轮数。 */
export const FOCUS_NEW_TURNS = 300
/** 巨大日志建库期间，前台每隔这么久发一次原话检索；开始建库时先发一次。 */
export const FOREGROUND_INTERVAL_MS = 50
/** 查询延迟每项计几轮（--rounds 的缺省）。 */
export const DEFAULT_ROUNDS = 20

export type DialogueBenchUnit = 'ms' | 'MB' | '次'
export interface DialogueBenchItem { label: string; unit: DialogueBenchUnit }

/** 会话档每一档都出的行。 */
export const SESSION_TIER_ITEMS = {
  build: { label: '首次建库（后台推进连续跑到建完）', unit: 'ms' },
  buildAdvances: { label: '首次建库用的后台推进次数', unit: '次' },
  buildLogRead: { label: '首次建库期间读会话日志合计', unit: 'ms' },
  logReadMax: { label: '读一份会话日志最长', unit: 'ms' },
  dbSize: { label: '建完的库体积', unit: 'MB' },
  buildRss: { label: '建库进程内存峰值', unit: 'MB' },
  rebuild: { label: '整份重建', unit: 'ms' },
  rebuildFilesPeak: { label: '重建期间库文件合计峰值（新旧两代加回滚日志）', unit: 'MB' },
  rebuildFsDrop: { label: '重建期间文件系统可用空间最大降幅（含临时文件）', unit: 'MB' },
  incremental: { label: '增量追赶（开着的会话各追加新轮后追完）', unit: 'ms' },
  focus: { label: '检索前追赶实测', unit: 'ms' },
  focusSessionMax: { label: '检索前追赶中单个会话最长（读日志、切段、第一批）', unit: 'ms' },
  focusTail: { label: '检索前追赶的收尾统计', unit: 'ms' },
  queryAllP50: { label: '原话查询（全部词命中）中位数', unit: 'ms' },
  queryAllP95: { label: '原话查询（全部词命中）p95', unit: 'ms' },
  queryAnyP50: { label: '原话查询（退到任一词命中）中位数', unit: 'ms' },
  queryAnyP95: { label: '原话查询（退到任一词命中）p95', unit: 'ms' },
  bothP50: { label: '两者都查端到端中位数', unit: 'ms' },
  bothP95: { label: '两者都查端到端 p95', unit: 'ms' },
  wRewrite: { label: '换词典后只重算整词列', unit: 'ms' },
  concurrent: { label: '两个进程同时建库（两边都建完）', unit: 'ms' },
  concurrentSuperseded: { label: '两个进程同时建库作废的批', unit: '次' },
  concurrentLogReads: { label: '两个进程同时建库读会话日志合计', unit: '次' },
} as const satisfies Record<string, DialogueBenchItem>

/** 巨大日志那一档（或档里巨大日志那部分）出的行。 */
export const HUGE_TIER_ITEMS = {
  hugeBuild: { label: '巨大日志建库（后台推进连续跑到建完）', unit: 'ms' },
  hugeAdvances: { label: '巨大日志建库用的后台推进次数', unit: '次' },
  hugeIdleAdvances: { label: '巨大日志建库期间空转推进次数', unit: '次' },
  hugeLogRead: { label: '读一次巨大日志', unit: 'ms' },
  hugeRss: { label: '巨大日志建库进程内存峰值', unit: 'MB' },
  hugeForegroundMax: { label: '巨大日志建库期间前台检索延迟最长', unit: 'ms' },
  hugeForegroundP95: { label: '巨大日志建库期间前台检索延迟 p95', unit: 'ms' },
  hugeLoopDelayMax: { label: '巨大日志建库期间事件循环最长停顿', unit: 'ms' },
} as const satisfies Record<string, DialogueBenchItem>

/** 结果表的表头。 */
export const BENCH_TABLE_HEADER = '| 档 | 项目 | 数值 | 单位 |'
/** 这一项这次不适用时「数值」一栏写它（只用于分词器降级、没有整词列可重算的那一行），单位栏写原因。 */
export const BENCH_SKIPPED = '跳过'
/** 两行判定的名字；判定行写作「PASS：<档> / <名字>：<说明>」或「FAIL：…」。 */
export const FOCUS_VERDICT = '检索前追赶不超过时间上限'
export const CONCURRENT_VERDICT = '两个进程同时追，库内容一致'

export interface SyntheticLogOptions {
  sessionId: string
  /** 轮数。 */
  turns: number
  /** 同样的种子生成同样的正文；不同会话给不同的种子。 */
  seed: number
}

/**
 * 合成一个宿主格式的会话日志（readSessionLog 返回的形状）：会话 id、没有继承前缀、不是 seeded；
 * 序号从 0 连续递增，时间从固定起点递增。每轮：turn/start、一条用户本人的消息、一条助手正文、
 * 一次工具调用和它的结果、turn/end。每 10 轮里至少各有一条：超过 300 token、要切成几段的长助手正文，
 * 报错的工具结果，超过 300 token 的普通工具输出（收录时不收）；其余工具结果是短输出。
 * 正文只取自固定词表。多生成几轮时，前面的事件和少生成时逐字节相同（用来模拟开着的会话追加新轮）。
 */
export function syntheticSessionLog(_opts: SyntheticLogOptions): SessionLog {
  let seed = _opts.seed
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const words = ['缓存', '队列', '索引', '日志', '部署', '配置', '连接', '重试']
  const events: SessionLog['events'] = []
  const add = (type: string, data: unknown) => events.push({ type, seq: events.length, time: 1_700_000_000_000 + events.length, data })
  const content = (text: string) => [{ type: 'text', text }]
  for (let turn = 0; turn < _opts.turns; turn++) {
    const text = `${_opts.seed === 1 ? 'foregroundprobe ' : ''}alpha beta ${Array.from({ length: 8 }, () => words[Math.floor(rand() * words.length)]).join(' ')}`
    add('turn/start', {})
    add('user/message', { content: content(text), source: { kind: 'user' } })
    add('assistant/message', { message: { content: content(turn % 10 === 0 ? text.repeat(40) : text) } })
    add('tool/call', { callId: `call-${turn}`, name: 'inspect' })
    add('tool/result', { message: { toolCallId: `call-${turn}`, isError: turn % 10 === 1, content: content(turn % 10 === 2 ? text.repeat(40) : text) } })
    add('turn/end', {})
  }
  return { header: { id: _opts.sessionId, isSeeded: false }, inheritedEventCount: 0, events }
}

function options() {
  const { values } = parseArgs({ options: Object.fromEntries(['tier', 'sessions', 'turns', 'huge-turns', 'rounds'].map(k => [k, { type: 'string' as const }])) })
  const number = (key: string, fallback?: number) => {
    if (values[key] === undefined) return fallback
    const n = Number(values[key])
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${key} 应为正整数`)
    return n
  }
  const sessions = number('sessions'), turns = number('turns'), hugeTurns = number('huge-turns')
  const rounds = number('rounds', DEFAULT_ROUNDS)!
  const custom = sessions !== undefined || turns !== undefined || hugeTurns !== undefined
  if (values.tier !== undefined && custom) throw new Error('--tier 与 --sessions、--turns、--huge-turns 互斥')
  if ((sessions === undefined) !== (turns === undefined)) throw new Error('--sessions 和 --turns 应成对给出')
  const tier = values.tier ?? 'all'
  if (tier !== 'all' && !Object.hasOwn(DIALOGUE_BENCH_TIERS, tier)) throw new Error('--tier 取值不认识')
  const tiers: Array<[string, DialogueBenchScale]> = custom ? [['custom', { sessions, turns, hugeTurns }]]
    : (tier === 'all' ? DIALOGUE_BENCH_ALL : [tier]).map(t => [t, DIALOGUE_BENCH_TIERS[t as keyof typeof DIALOGUE_BENCH_TIERS]])
  return { tiers, rounds }
}

async function main() {
  const { tiers, rounds } = options()
  const rows: string[] = [], verdicts: string[] = []
  let failed = false
  for (const [tier, scale] of tiers) {
    const root = await mkdtemp(join(tmpdir(), 'dialogue-bench-'))
    let item = '生成合成日志'
    const logs = join(root, 'logs')
    const addRows = (items: Record<string, DialogueBenchItem>, values: Record<string, number | string>) => {
      for (const [key, meta] of Object.entries(items)) {
        const value = values[key]
        rows.push(`| ${tier} | ${meta.label} | ${typeof value === 'number' ? (meta.unit === '次' ? value : value.toFixed(2)) : value} | ${value === BENCH_SKIPPED ? '分词器降级，没有整词列' : meta.unit} |`)
      }
    }
    const workers = new Set<ReturnType<typeof fork>>()
    const concurrentReady: Array<ReturnType<typeof fork>> = []
    let concurrentStart = 0, concurrentElapsed = 0
    const worker = (mode: string, db: string, count: number) => new Promise<Record<string, number | string>>((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./bench-dialogue-worker.ts', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      workers.add(child)
      let stderr = '', result: Record<string, number | string>
      child.stderr!.on('data', chunk => { stderr += chunk })
      child.on('message', message => {
        if (message === 'ready') {
          concurrentReady.push(child)
          if (concurrentReady.length === 2) {
            concurrentStart = performance.now()
            for (const ready of concurrentReady) ready.send('go')
          }
        } else {
          result = message as typeof result
          if (mode === 'concurrent') concurrentElapsed = performance.now() - concurrentStart
        }
      })
      child.on('error', error => { workers.delete(child); reject(error) })
      child.on('close', (code, signal) => {
        workers.delete(child)
        if (code === 0) resolve(result)
        else reject(new Error(`子进程退出：code=${code}，signal=${signal}；${stderr}`))
      })
      child.send({ mode, root, logs, db, count, turns: scale.turns, rounds })
    })
    const writeLogs = async (count: number, turns: number) => {
      await mkdir(logs, { recursive: true })
      for (let i = 0; i < count; i++) {
        const log = syntheticSessionLog({ sessionId: `s${i}`, turns, seed: i + 1 })
        await writeFile(join(logs, `s${i}.jsonl`), log.events.map(e => JSON.stringify(e)).join('\n'))
      }
    }
    try {
      if (scale.sessions !== undefined) {
        await writeLogs(scale.sessions, scale.turns!)
        const db = join(root, DIALOGUE_RECORDS_FILE)
        item = SESSION_TIER_ITEMS.build.label
        const values = await worker('build', db, scale.sessions)
        item = SESSION_TIER_ITEMS.concurrent.label
        const concurrentDb = join(root, 'concurrent.sqlite')
        const both = await Promise.allSettled([worker('concurrent', concurrentDb, scale.sessions), worker('concurrent', concurrentDb, scale.sessions)])
        values.concurrent = concurrentElapsed
        const results = both.map(r => { if (r.status === 'rejected') throw r.reason; return r.value })
        values.concurrentSuperseded = results.reduce((n, r) => n + Number(r.superseded), 0)
        values.concurrentLogReads = results.reduce((n, r) => n + Number(r.reads), 0)
        const stores = [db, concurrentDb].map(path => new DialogueRecordStore({ path, log: { warn() {}, info() {}, error() {} } }))
        let equal = true
        try {
          for (let i = 0; i < scale.sessions; i++) {
            const segments = stores.map(store => {
              const state = store.state()
              if (state.status === 'none') throw new Error('建完应有可读代')
              return store.segmentsOf(state.read.gen, `s${i}`, 0, Number.MAX_SAFE_INTEGER).map(({ turnSeq, seq, segment, speaker, text }) => [turnSeq, seq, segment, speaker, text])
            })
            equal &&= JSON.stringify(segments[0]) === JSON.stringify(segments[1])
          }
        } finally { stores.forEach(store => store.close()) }
        verdicts.push(`${equal ? 'PASS' : 'FAIL'}：${tier} / ${CONCURRENT_VERDICT}：逐会话逐段比较`)
        failed ||= !equal
        item = SESSION_TIER_ITEMS.rebuild.label
        const filesSize = () => readdirSync(root).filter(n => n === DIALOGUE_RECORDS_FILE || n.startsWith(`${DIALOGUE_RECORDS_FILE}-`)).reduce((n, file) => n + (statSync(join(root, file), { throwIfNoEntry: false })?.size ?? 0), 0)
        const free = () => { const s = statfsSync(root); return s.bavail * s.bsize }
        const before = free()
        let peak = filesSize(), drop = 0
        const sample = () => { peak = Math.max(peak, filesSize()); drop = Math.max(drop, before - free()) }
        // 定时器异常交回本项的错误路径，仍等待子进程退出并清理临时目录。
        let sampleError: unknown
        const timer = setInterval(() => {
          try { sample() } catch (error) { sampleError = error; clearInterval(timer) }
        }, 5)
        try {
          Object.assign(values, await worker('rebuild', db, scale.sessions))
          if (sampleError !== undefined) throw sampleError
          sample()
        }
        finally { clearInterval(timer) }
        values.rebuildFilesPeak = peak / 1024 ** 2
        values.rebuildFsDrop = drop / 1024 ** 2
        item = '增量追赶、查询和词典重算'
        Object.assign(values, await worker('measure', db, scale.sessions))
        const focus = Number(Number(values.focus).toFixed(2)), max = Number(Number(values.focusSessionMax).toFixed(2)), tail = Number(Number(values.focusTail).toFixed(2))
        const pass = focus <= CATCHUP_FOCUS_BUDGET_MS + max + tail
        verdicts.push(`${pass ? 'PASS' : 'FAIL'}：${tier} / ${FOCUS_VERDICT}：实测 ${focus}，预算 ${CATCHUP_FOCUS_BUDGET_MS}，单个会话最长 ${max}，收尾统计 ${tail}`)
        failed ||= !pass
        addRows(SESSION_TIER_ITEMS, values)
        rows.push(`| ${tier} | 两者都查：降级 | ${values.bothDegraded}/${rounds} | 次 |`)
      }
      if (scale.hugeTurns !== undefined) {
        item = HUGE_TIER_ITEMS.hugeBuild.label
        await rm(logs, { recursive: true, force: true })
        await writeLogs(1, 1)
        const huge = syntheticSessionLog({ sessionId: 's1', turns: scale.hugeTurns, seed: 2 })
        await writeFile(join(logs, 's1.jsonl'), huge.events.map(e => JSON.stringify(e)).join('\n'))
        addRows(HUGE_TIER_ITEMS, await worker('huge', join(root, 'huge.sqlite'), 2))
      }
    } catch (error) { throw new Error(`FAIL：${tier} / ${item}：${String(error)}`) }
    finally {
      await Promise.all([...workers].filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill() })))
      await rm(root, { recursive: true, force: true })
    }
  }
  console.log(`Node ${process.version} · ${platform()} ${arch()} · ${cpus()[0]?.model}`)
  console.log([BENCH_TABLE_HEADER, '| --- | --- | ---: | --- |', ...rows, ...verdicts].join('\n'))
  if (failed) process.exitCode = 1
}
if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try { await main() } catch (error) { console.error(String(error)); process.exitCode = 1 }
}

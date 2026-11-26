import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BENCH_SKIPPED, BENCH_TABLE_HEADER, CONCURRENT_VERDICT, FOCUS_VERDICT, HUGE_TIER_ITEMS, SESSION_TIER_ITEMS, syntheticSessionLog,
} from '../scripts/bench-dialogue.ts'
import { intakeOf } from '../src/search/dialogue-intake.ts'
import { dialogueTokenizer } from '../src/search/dialogue-tokenizer.ts'
import { SEGMENT_MAX_TOKENS } from '../src/search/segments.ts'
import { isRealUserMessage, messageText } from '../src/session-log.ts'
import { estimateTokens } from '../src/snapshot.ts'
import { CATCHUP_FOCUS_BUDGET_MS } from '../src/tools/dialogue-catchup.ts'

// 对话记录库规模基准：合成会话日志走公开的生成函数；基准本身按命令行跑（子进程，Node 直接执行 .ts），
// 只看它打印的结果表、判定行和退出码。子进程的 TMPDIR 指到这里建的空目录，跑完据此核对临时目录删干净了。
// 这里只用很小的自定规模，不断言耗时快慢；耗时的判定由基准自己在 CI 的规模档里做。

const SCRIPT = fileURLToPath(new URL('../scripts/bench-dialogue.ts', import.meta.url))

interface Run { code: number | null; stdout: string; stderr: string; tmp: string }

async function runBench(args: readonly string[]): Promise<Run> {
  const tmp = await mkdtemp(join(tmpdir(), 'pm-bench-dialogue-'))
  const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const [code] = await once(child, 'exit') as [number | null]
  return { code, stdout, stderr, tmp }
}

interface Row { tier: string; label: string; value: string; unit: string }

/** 结果表的数据行；没有表时抛错，错误里带子进程的 stderr。 */
function tableOf(run: Run): Row[] {
  const lines = run.stdout.split('\n')
  const start = lines.indexOf(BENCH_TABLE_HEADER)
  if (start < 0) throw new Error(`结果表缺失（退出码 ${run.code}）：${run.stderr}`)
  const rows: Row[] = []
  for (const line of lines.slice(start + 2)) {
    const m = /^\| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/u.exec(line)
    if (!m) break
    rows.push({ tier: m[1]!, label: m[2]!, value: m[3]!, unit: m[4]! })
  }
  return rows
}

/** 某一档某一项的数值；必须恰好一行。 */
function valueOf(rows: readonly Row[], tier: string, item: { label: string }): string {
  const found = rows.filter(r => r.tier === tier && r.label === item.label)
  if (found.length !== 1) throw new Error(`「${tier} / ${item.label}」应有一行，实际 ${found.length} 行`)
  return found[0]!.value
}
const numberOf = (rows: readonly Row[], tier: string, item: { label: string }) => Number(valueOf(rows, tier, item))

const verdictLines = (run: Run, name: string) => run.stdout.split('\n').filter(l => new RegExp(`^(PASS|FAIL)：custom / ${name}：`, 'u').test(l))

describe('合成会话日志', () => {
  it('同样的参数生成两次逐字节相同，换种子正文不同', () => {
    const a = syntheticSessionLog({ sessionId: 's1', turns: 12, seed: 7 })
    const b = syntheticSessionLog({ sessionId: 's1', turns: 12, seed: 7 })
    const c = syntheticSessionLog({ sessionId: 's1', turns: 12, seed: 8 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.events.length).toBe(c.events.length)
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(c.events))
  })

  it('多生成几轮时，前面的事件和少生成时逐字节相同', () => {
    const short = syntheticSessionLog({ sessionId: 's1', turns: 10, seed: 3 })
    const long = syntheticSessionLog({ sessionId: 's1', turns: 25, seed: 3 })
    expect(long.events.length).toBeGreaterThan(short.events.length)
    expect(JSON.stringify(long.events.slice(0, short.events.length))).toBe(JSON.stringify(short.events))
  })

  it('格式按宿主会话日志：带会话 id、没有继承前缀，序号从 0 连续递增，时间不倒退，轮数等于参数', () => {
    const log = syntheticSessionLog({ sessionId: 'sess-a', turns: 10, seed: 1 })
    expect(log.header.id).toBe('sess-a')
    expect(log.header.isSeeded).toBe(false)
    expect(log.inheritedEventCount).toBe(0)
    expect(log.events.map(e => e.seq)).toEqual(log.events.map((_, i) => i))
    const times = log.events.map(e => e.time!)
    for (const t of times) expect(Number.isFinite(t)).toBe(true)
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThanOrEqual(times[i - 1]!)
    expect(log.events.filter(e => e.type === 'turn/start')).toHaveLength(10)
    expect(log.events.filter(e => e.type === 'turn/end')).toHaveLength(10)
  })

  it('收录后每轮的用户消息都在；十轮里有切成多段的长消息、报错的工具结果、短工具输出，超长的普通工具输出不收', () => {
    const log = syntheticSessionLog({ sessionId: 'sess-b', turns: 10, seed: 2 })
    const users = log.events.filter(e => e.type === 'user/message')
    expect(users).toHaveLength(10)
    for (const e of users) expect(isRealUserMessage(log, e)).toBe(true)
    const intake = intakeOf(log, -1)
    if (intake.kind !== 'rows') throw new Error(`合成日志整份没收：${intake.reason}`)
    const rowSeqs = new Set(intake.rows.map(r => r.seq))
    for (const e of users) expect(rowSeqs.has(e.seq!)).toBe(true)
    expect(intake.turns).toHaveLength(10)
    // 切成多段的长消息
    expect(intake.rows.some(r => r.segment >= 1)).toBe(true)
    const tools = log.events.filter(e => e.type === 'tool/result')
    const isError = (e: (typeof tools)[number]) => (e.data as { message?: { isError?: unknown } }).message?.isError === true
    const tokens = (e: (typeof tools)[number]) => estimateTokens(messageText(e)!.text)
    const errors = tools.filter(isError)
    const shortOutputs = tools.filter(e => !isError(e) && tokens(e) <= SEGMENT_MAX_TOKENS)
    const longOutputs = tools.filter(e => !isError(e) && tokens(e) > SEGMENT_MAX_TOKENS)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(shortOutputs.length).toBeGreaterThanOrEqual(1)
    expect(longOutputs.length).toBeGreaterThanOrEqual(1)
    for (const e of [...errors, ...shortOutputs]) expect(rowSeqs.has(e.seq!)).toBe(true)
    for (const e of longOutputs) expect(rowSeqs.has(e.seq!)).toBe(false)
  })
})

describe('小规模跑一遍基准', () => {
  let run: Run
  beforeAll(async () => {
    run = await runBench(['--sessions', '3', '--turns', '6', '--huge-turns', '60', '--rounds', '3'])
  }, 300_000)
  afterAll(async () => {
    if (run !== undefined) await rm(run.tmp, { recursive: true, force: true })
  })

  it('会话档和巨大日志的每一项各有一行，数值是非负的有限数；整词列重算在分词器降级时写明跳过', async () => {
    const rows = tableOf(run)
    const degraded = (await dialogueTokenizer({ log: { warn() {} } })).degraded
    for (const item of Object.values(SESSION_TIER_ITEMS)) {
      const raw = valueOf(rows, 'custom', item)
      if (item === SESSION_TIER_ITEMS.wRewrite && degraded) {
        expect(raw).toBe(BENCH_SKIPPED)
        continue
      }
      expect(Number.isFinite(Number(raw)), `${item.label}：${raw}`).toBe(true)
      expect(Number(raw)).toBeGreaterThanOrEqual(0)
      expect(rows.find(r => r.tier === 'custom' && r.label === item.label)!.unit).toBe(item.unit)
    }
    for (const item of Object.values(HUGE_TIER_ITEMS)) {
      const value = numberOf(rows, 'custom', item)
      expect(Number.isFinite(value), item.label).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    // 真的建了库、真的读了日志
    for (const item of [SESSION_TIER_ITEMS.build, SESSION_TIER_ITEMS.dbSize, SESSION_TIER_ITEMS.buildRss, SESSION_TIER_ITEMS.rebuildFilesPeak, HUGE_TIER_ITEMS.hugeBuild, HUGE_TIER_ITEMS.hugeRss]) {
      expect(numberOf(rows, 'custom', item), item.label).toBeGreaterThan(0)
    }
    for (const item of [SESSION_TIER_ITEMS.buildAdvances, HUGE_TIER_ITEMS.hugeAdvances]) expect(numberOf(rows, 'custom', item)).toBeGreaterThanOrEqual(1)
    // 重建期间新旧两代同时在：峰值不小于建完的库
    expect(numberOf(rows, 'custom', SESSION_TIER_ITEMS.rebuildFilesPeak)).toBeGreaterThanOrEqual(numberOf(rows, 'custom', SESSION_TIER_ITEMS.dbSize))
  })

  it('检索前追赶的判定：预算取检索前追赶的时间上限，判 PASS 当且仅当实测不超过预算加单个会话最长耗时加收尾统计', () => {
    const rows = tableOf(run)
    const lines = verdictLines(run, FOCUS_VERDICT)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(String(CATCHUP_FOCUS_BUDGET_MS))
    const focus = numberOf(rows, 'custom', SESSION_TIER_ITEMS.focus)
    const sessionMax = numberOf(rows, 'custom', SESSION_TIER_ITEMS.focusSessionMax)
    const tail = numberOf(rows, 'custom', SESSION_TIER_ITEMS.focusTail)
    expect(sessionMax).toBeGreaterThan(0)
    expect(lines[0]!.startsWith('PASS')).toBe(focus <= CATCHUP_FOCUS_BUDGET_MS + sessionMax + tail)
  })

  it('两个进程同时追：判 PASS（建完的库和单个进程建的逐段相同），两边合计读日志不少于会话数', () => {
    const rows = tableOf(run)
    const lines = verdictLines(run, CONCURRENT_VERDICT)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith('PASS')).toBe(true)
    expect(numberOf(rows, 'custom', SESSION_TIER_ITEMS.concurrentLogReads)).toBeGreaterThanOrEqual(3)
    expect(Number.isInteger(numberOf(rows, 'custom', SESSION_TIER_ITEMS.concurrentSuperseded))).toBe(true)
  })

  it('退出码和判定一致：有 FAIL 行时为 1，否则为 0', () => {
    tableOf(run)
    const hasFail = run.stdout.split('\n').some(l => l.startsWith('FAIL：'))
    expect(run.code).toBe(hasFail ? 1 : 0)
  })

  it('跑完临时目录删干净', async () => {
    expect(tableOf(run).length).toBeGreaterThan(0)
    expect(await readdir(run.tmp)).toEqual([])
  })
})

describe('命令行参数', () => {
  it.each([
    { args: ['--tier', '10k'], flag: '--tier' },
    { args: ['--tier', 'ci', '--sessions', '3', '--turns', '2'], flag: '--sessions' },
    { args: ['--sessions', '0', '--turns', '5'], flag: '--sessions' },
    { args: ['--sessions', '3'], flag: '--turns' },
    { args: ['--rounds', 'x'], flag: '--rounds' },
  ])('$args：开跑前就拒绝，说明是哪个参数，不打印结果表、不留临时目录', async ({ args, flag }) => {
    const r = await runBench(args)
    try {
      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain(flag)
      expect(r.stdout).not.toContain(BENCH_TABLE_HEADER)
      expect(await readdir(r.tmp)).toEqual([])
    } finally {
      await rm(r.tmp, { recursive: true, force: true })
    }
  }, 60_000)
})

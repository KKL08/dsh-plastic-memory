import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { AdviceIgnoreStore } from '../src/governance/advice-ignores.ts'
import { CheckupRecordStore } from '../src/governance/checkup-records.ts'
import { AutoCheckupSettingStore } from '../src/governance/auto-checkups.ts'
import { adviceIgnoreSchema, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { ViewWriter, collectCheckupView, collectGlobalViews } from '../src/gui/view-writer.ts'
import { runCheckup, type CheckupRunInput } from '../src/gui/checkup-run.ts'
import { AUTO_SUGGESTION_LIMIT, CheckupSuggestions, SUGGESTION_ATTEMPT_LIMIT } from '../src/gui/checkup-suggestions.ts'
import { GUI_VIEW_DIR, GUI_VIEW_FILES, SCOPE_KEYS, checkupKey, pendingViewSchema } from '../src/gui/contract.ts'
import type { Scope } from '../src/scope.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import type { ReadEventFn } from '../src/tools/source.ts'

// 体检之后的后续段（处理建议）：真实临时目录（FileTable + .state 侧表 + 视图文件），一次体检和后续段都用真的；
// 只把进程边界换掉：宿主模型（假 llm，内容检查和建议各一种回法）、心跳计时、时钟。

const NOW = 10 * RETENTION_MS
const WS = '/tmp/pm-sg-ws'
const OTHER_WS = '/tmp/pm-sg-other'
const GLOBAL = { kind: 'global' as const }
const PROJECT = { kind: 'workspace' as const, workspacePath: WS }
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const quietLog = { info() {}, warn() {}, error() {} }
const schemas = { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema, adviceIgnores: adviceIgnoreSchema }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-checkup-sg-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** 生成建议的提示词（system）里有这句；内容检查的没有。 */
const isSuggestionCall = (input: { system: string }) => input.system.includes('两条互相矛盾的记忆')

type Reply = string | { code: string } | 'wait'

/**
 * 假模型：内容检查报 conflicts 里、这次输入里双方都在的冲突，用量 100；生成建议按 suggest 回（缺省「保留 A」），用量 30。
 * 'wait' 一直等到 release()（不理会取消信号：模型在取消之后才回来）；{ code } 按宿主错误码抛错。
 */
function fakeModel(conflicts: Array<[string, string]>, suggest: (user: string, n: number) => Reply = () => JSON.stringify({ action: 'keep-a', reason: '以 A 为准' })) {
  const suggestCalls: string[] = []
  let scanCalls = 0
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  let isStarted = new Promise<void>(resolve => { started = resolve })
  const llm: SemanticLlm = {
    model: 'm-test',
    complete: async (input, signal, onUsage) => {
      if (!isSuggestionCall(input)) {
        scanCalls++
        onUsage?.(100)
        const findings = conflicts.filter(ids => ids.every(id => input.user.includes(id)))
          .map(memoryIds => ({ type: 'conflict', memoryIds, summary: '说法矛盾', suggestedAction: '请裁决' }))
        return JSON.stringify({ findings })
      }
      suggestCalls.push(input.user)
      const reply = suggest(input.user, suggestCalls.length)
      expect(signal === undefined || signal instanceof AbortSignal).toBe(true)
      if (reply === 'wait') {
        const gate = new Promise<void>(resolve => { release = resolve })
        started?.()
        await gate
        isStarted = new Promise<void>(resolve => { started = resolve })
        onUsage?.(30)
        return JSON.stringify({ action: 'keep-b', reason: '迟到的' })
      }
      onUsage?.(30)
      if (typeof reply === 'object') throw Object.assign(new Error(`host ${reply.code}`), { code: reply.code })
      return reply
    },
  }
  return { llm, suggestCalls, scanCalls: () => scanCalls, release: () => release?.(), started: () => isStarted }
}

function env(opts: { readEvent?: ReadEventFn } = {}) {
  const clock = { now: NOW }
  const sidecar = new SidecarStore({ root, schemas, now: () => clock.now, log: quietLog })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats, now: () => clock.now }), quietLog, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const cache = sidecar.scanCache
  const ignores = new AdviceIgnoreStore(sidecar.adviceIgnores)
  const checkups = new CheckupRecordStore(sidecar.checkups)
  const autoCheckups = new AutoCheckupSettingStore(sidecar.autoCheckups)
  let suggestions!: CheckupSuggestions
  const writer = new ViewWriter({
    memoryRoot: root, log: quietLog,
    collect: () => collectGlobalViews({
      store, decisions, cache, ignores, checkups, autoCheckups, registry, memoryRoot: root, now: () => clock.now, log: quietLog,
      generatingSuggestions: () => suggestions.generatingIds(),
    }),
    collectCheckups: () => collectCheckupView({ store, checkups, autoCheckups, cache, now: () => clock.now }),
    now: () => clock.now, sleep: async () => {},
  })
  const warnings: unknown[][] = []
  const log = { info() {}, error() {}, warn: (...args: unknown[]) => { warnings.push(args) } }
  suggestions = new CheckupSuggestions({ store, decisions, checkups, views: writer, now: () => clock.now, log, ...(opts.readEvent !== undefined ? { getReadEvent: () => opts.readEvent! } : {}) })
  const heartbeat = () => () => {}
  /** 一次体检（手动缺省），做完后接着跑后续段；返回体检结果和后续段（不等它）。 */
  const checkup = async (input: Partial<CheckupRunInput> & Pick<CheckupRunInput, 'llm'>, signal?: AbortSignal) => {
    const target = input.target ?? { kind: 'all' as const }
    const by = input.by ?? 'manual'
    const outcome = await runCheckup({ by, baseline: null, ...input, target }, {
      scan: { store, registry, decisions, cache, ignores }, checkups, views: writer, interval: heartbeat, now: () => clock.now, log: quietLog,
    })
    const followUp = suggestions.run({ target, by, llm: input.llm, outcome, ...(signal !== undefined ? { signal } : {}) })
    return { outcome, followUp }
  }
  const readPending = async () => pendingViewSchema.parse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.pending), 'utf8')))
  const conflictItems = async () => (await readPending()).items.flatMap(i => (i.kind === 'conflict-horizontal' ? [i] : []))
  const entryOf = async (a: string, b: string) => (await decisions.list()).find(d => d.memoryIds.join() === [a, b].join())
  const lastResult = async (key: string) => (await checkups.list()).find(r => r.id === key)?.lastResult
  return { clock, sidecar, store, decisions, checkups, suggestions, writer, warnings, checkup, readPending, conflictItems, entryOf, lastResult }
}
type Env = ReturnType<typeof env>

/** 一对冲突的两条记忆（全局，或某个项目），A 先建；content 带 id，内容检查的假模型据它认出这一对。 */
async function seedPair(e: Env, a: string, b: string, opts: { workspacePath?: string; contentA?: string } = {}) {
  const scoped = opts.workspacePath === undefined ? {} : { scope: 'workspace' as const, workspacePath: opts.workspacePath }
  await e.store.create(record({ id: a, name: `${a} 名`, content: opts.contentA ?? `${a}：用 pnpm`, ...scoped }))
  await e.store.create(record({ id: b, name: `${b} 名`, content: `${b}：用 npm`, ...scoped }))
}

describe('手动体检之后补上建议', () => {
  it('故事 26：体检结果和冲突卡先出（卡上带「正在生成」），建议随后补上；全部补完后用量记进这次体检的结果，标记清掉', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']], () => 'wait')
    const { outcome, followUp } = await e.checkup({ llm: m.llm })
    expect(outcome).toMatchObject({ kind: 'done', usageTokens: 100 })
    // 体检的结果已经记下（用量只有内容检查的那次）；冲突卡已出，建议还在生成
    expect((await e.lastResult(SCOPE_KEYS.all))?.usageTokens).toBe(100)
    await m.started()
    expect(await e.conflictItems()).toEqual([expect.objectContaining({ isGeneratingSuggestion: true, noSuggestion: { code: 'not-generated' } })])

    m.release()
    await followUp
    const [item] = await e.conflictItems()
    expect(item).toMatchObject({ suggestion: { action: 'keep-b', reason: '迟到的', isSourced: false } })
    expect(item).not.toHaveProperty('isGeneratingSuggestion')
    const entry = await e.entryOf('mem_a', 'mem_b')
    expect(entry?.suggestion?.action).toBe('keep-b')
    expect(entry?.suggestionAttempts).toEqual({ fingerprint: entry?.fingerprint, count: 1 })
    expect((await e.lastResult(SCOPE_KEYS.all))?.usageTokens).toBe(130)
  })

  it('故事 29：同一对两条内容没变，再体检不再调用模型生成建议', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']])
    await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls).toHaveLength(1)
    await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls).toHaveLength(1)
    expect(m.scanCalls()).toBe(2)
  })

  it('手动体检不设条数上限，先旧后新；含高危密钥的不发给模型', async () => {
    const e = env()
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < AUTO_SUGGESTION_LIMIT + 2; i++) {
      const pair: [string, string] = [`mem_${i}a`, `mem_${i}b`]
      await seedPair(e, ...pair)
      // 先挂账的算旧：按 i 的顺序挂
      await e.decisions.upsert({ memoryIds: pair, summary: '说法矛盾' }, NOW - 1000 + i)
      pairs.push(pair)
    }
    await seedPair(e, 'mem_sa', 'mem_sb', { contentA: `mem_sa：token ${FAKE_SECRET.github}` })
    const m = fakeModel([...pairs, ['mem_sa', 'mem_sb']])
    await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls).toHaveLength(AUTO_SUGGESTION_LIMIT + 2)
    expect(m.suggestCalls.map(u => /mem_(\d+)a/.exec(u)?.[1])).toEqual(pairs.map((_, i) => String(i)))
    const items = await e.conflictItems()
    expect(items.filter(i => i.suggestion !== undefined)).toHaveLength(AUTO_SUGGESTION_LIMIT + 2)
    expect(items.find(i => i.left?.id === 'mem_sa')?.noSuggestion).toEqual({ code: 'has-secret' })
  })

  it('只给这次体检范围内的冲突生成：项目体检不碰别的项目的冲突', async () => {
    const e = env()
    await seedPair(e, 'mem_pa', 'mem_pb', { workspacePath: WS })
    await seedPair(e, 'mem_oa', 'mem_ob', { workspacePath: OTHER_WS })
    await seedPair(e, 'mem_ga', 'mem_gb')
    const m = fakeModel([['mem_pa', 'mem_pb'], ['mem_oa', 'mem_ob'], ['mem_ga', 'mem_gb']])
    // 先全库体检挂上三对（不跑后续段），再只查本项目
    await runCheckup({ by: 'manual', baseline: null, target: { kind: 'all' }, llm: fakeModel([['mem_pa', 'mem_pb'], ['mem_oa', 'mem_ob'], ['mem_ga', 'mem_gb']], () => '不是 JSON').llm }, {
      scan: { store: e.store, registry, decisions: e.decisions, cache: e.sidecar.scanCache, ignores: new AdviceIgnoreStore(e.sidecar.adviceIgnores) },
      checkups: e.checkups, views: e.writer, interval: () => () => {}, now: () => e.clock.now, log: quietLog,
    })
    await (await e.checkup({ llm: m.llm, target: PROJECT })).followUp
    // 项目体检读全局加本项目：本项目和全局的两对都在范围里
    expect(m.suggestCalls.map(u => /mem_(\w)a/.exec(u)?.[1]).sort()).toEqual(['g', 'p'])
    expect((await e.entryOf('mem_oa', 'mem_ob'))?.suggestion).toBeUndefined()
    // 用量补记在这次体检的范围键上
    expect((await e.lastResult(checkupKey(PROJECT)))?.usageTokens).toBe(100 + 2 * 30)
  })

  it('这次体检里模型用不了、或语义扫描失败：不跑这一段，也不计尝试次数', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '说法矛盾' }, NOW)
    const calls: string[] = []
    const failing = (code: string | undefined): SemanticLlm => ({
      complete: async (input) => {
        calls.push(isSuggestionCall(input) ? 'suggest' : 'scan')
        if (code !== undefined) throw Object.assign(new Error(`host ${code}`), { code })
        return '不是 JSON'
      },
    })
    const unavailable = await e.checkup({ llm: failing('AUTH') })
    expect(unavailable.outcome).toMatchObject({ kind: 'done', notes: expect.arrayContaining([expect.objectContaining({ code: 'model-unavailable' })]) })
    await unavailable.followUp
    const semanticFailed = await e.checkup({ llm: failing(undefined) })
    expect(semanticFailed.outcome).toMatchObject({ kind: 'done', notes: expect.arrayContaining([expect.objectContaining({ code: 'semantic-failed' })]) })
    await semanticFailed.followUp
    expect(calls).not.toContain('suggest')
    expect((await e.entryOf('mem_a', 'mem_b'))?.suggestionAttempts).toBeUndefined()
    expect((await e.conflictItems())[0]).toMatchObject({ noSuggestion: { code: 'not-generated' } })
  })

  it('生成中模型用不了（宿主报 AUTH）：停下，这一条不写、不计尝试，后面的不再试', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    await seedPair(e, 'mem_c', 'mem_d')
    const m = fakeModel([['mem_a', 'mem_b'], ['mem_c', 'mem_d']], () => ({ code: 'AUTH' }))
    await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls).toHaveLength(1)
    for (const entry of await e.decisions.list()) {
      expect(entry.suggestionFailure).toBeUndefined()
      expect(entry.suggestionAttempts).toBeUndefined()
    }
    expect((await e.conflictItems()).map(i => i.noSuggestion?.code)).toEqual(['not-generated', 'not-generated'])
  })

  it('同一冲突指纹体检最多试 2 次：失败、输出不合格式都算；指纹变了从头算', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']], () => '不是 JSON')
    for (let i = 0; i < SUGGESTION_ATTEMPT_LIMIT + 1; i++) await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls).toHaveLength(SUGGESTION_ATTEMPT_LIMIT)
    expect((await e.conflictItems())[0]).toMatchObject({ noSuggestion: { code: 'failed', cause: { kind: 'unparseable' } } })
    // 两条内容变了：新的冲突指纹，从头再试
    await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: 'mem_b：用 npm，CI 里也是' }))
    await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls).toHaveLength(SUGGESTION_ATTEMPT_LIMIT + 1)
  })

  it('模型判断不了（undecided）：算一次做完的尝试，同样的依据下次体检不再问', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']], () => JSON.stringify({ action: 'unsure', reason: '分不出哪条对' }))
    await (await e.checkup({ llm: m.llm })).followUp
    await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls).toHaveLength(1)
    const entry = await e.entryOf('mem_a', 'mem_b')
    expect(entry?.suggestionAttempts?.count).toBe(1)
    expect((await e.conflictItems())[0]).toMatchObject({ noSuggestion: { code: 'undecided', reason: '分不出哪条对' } })
  })

  it('写入时条目正被别处认领（正在裁决）：这一份丢弃，不记尝试', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']], () => 'wait')
    const { followUp } = await e.checkup({ llm: m.llm })
    await m.started()
    const entry = (await e.entryOf('mem_a', 'mem_b'))!
    const release = await e.sidecar.pending.claim(entry.id)
    m.release()
    await followUp
    await release!()
    const after = await e.entryOf('mem_a', 'mem_b')
    expect(after?.suggestion).toBeUndefined()
    expect(after?.suggestionAttempts).toBeUndefined()
    expect((await e.conflictItems())[0]).not.toHaveProperty('isGeneratingSuggestion')
  })

  it('生成期间别处已写下当前依据的建议（「补上建议」先写完）：不覆盖，丢掉自己这份', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']], () => 'wait')
    const { followUp } = await e.checkup({ llm: m.llm })
    await m.started()
    const entry = (await e.entryOf('mem_a', 'mem_b'))!
    const pair = await Promise.all(entry.memoryIds.map(id => e.store.get(id))) as [MemoryRecord, MemoryRecord]
    const { suggestionBasis } = await import('../src/governance/decisions.ts')
    expect(await e.decisions.writeSuggestion(entry.id, {
      suggestion: { id: 'sg_user', action: 'keep-a', reason: '用户点的', ops: [{ kind: 'keep', memoryId: 'mem_a' }, { kind: 'forget', memoryId: 'mem_b' }], basis: suggestionBasis(entry, pair), isSourced: false, generatedAt: NOW },
    }, id => e.store.get(id))).toBe('written')
    m.release()
    await followUp
    expect((await e.entryOf('mem_a', 'mem_b'))?.suggestion?.id).toBe('sg_user')
  })

  it('取消（插件卸载）：不等在途的模型调用，不写建议，标记清掉；没回来的那次不计用量', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']], () => 'wait')
    const controller = new AbortController()
    const { followUp } = await e.checkup({ llm: m.llm }, controller.signal)
    await m.started()
    controller.abort(new DOMException('plugin unloaded', 'AbortError'))
    // 模型还没回来（gate 没开），这一段已经结束
    await followUp
    const entry = await e.entryOf('mem_a', 'mem_b')
    expect(entry?.suggestion).toBeUndefined()
    expect(entry?.suggestionFailure).toBeUndefined()
    expect((await e.conflictItems())[0]).not.toHaveProperty('isGeneratingSuggestion')
    m.release()
    await e.suggestions.whenIdle()
    expect((await e.entryOf('mem_a', 'mem_b'))?.suggestion).toBeUndefined()
    expect((await e.lastResult(SCOPE_KEYS.all))?.usageTokens).toBe(100)
  })

  it('后续段出错：只记日志，体检照常算做完（结果、冲突卡都在），标记清掉', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    const m = fakeModel([['mem_a', 'mem_b']])
    const write = e.decisions.writeSuggestion.bind(e.decisions)
    e.decisions.writeSuggestion = async () => { throw new Error('写账本出错') }
    const { outcome, followUp } = await e.checkup({ llm: m.llm })
    await expect(followUp).resolves.toBeUndefined()
    e.decisions.writeSuggestion = write
    expect(outcome.kind).toBe('done')
    expect(e.warnings.map(w => String(w[0]))).toEqual([expect.stringContaining('生成处理建议出错')])
    expect((await e.conflictItems())[0]).toMatchObject({ noSuggestion: { code: 'not-generated' } })
    expect((await e.conflictItems())[0]).not.toHaveProperty('isGeneratingSuggestion')
    // 模型那次调用已经花掉：照常补记
    expect((await e.lastResult(SCOPE_KEYS.all))?.usageTokens).toBe(130)
  })

  it('取消时前面已经生成完的那几条：用量照常补记', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    await seedPair(e, 'mem_c', 'mem_d')
    const m = fakeModel([['mem_a', 'mem_b'], ['mem_c', 'mem_d']], (_user, n) => (n === 1 ? JSON.stringify({ action: 'keep-a', reason: '先到的' }) : 'wait'))
    const controller = new AbortController()
    const { followUp } = await e.checkup({ llm: m.llm }, controller.signal)
    await m.started()
    controller.abort(new DOMException('plugin unloaded', 'AbortError'))
    await followUp
    expect((await e.lastResult(SCOPE_KEYS.all))?.usageTokens).toBe(130)
    m.release()
    await e.suggestions.whenIdle()
  })

  it('取消时出处读取还没回来：不等它，这一段照样结束、标记清掉', async () => {
    let asked!: () => void
    const isAsked = new Promise<void>(resolve => { asked = resolve })
    const e = env({ readEvent: () => { asked(); return new Promise(() => {}) } })
    for (const id of ['mem_a', 'mem_b']) {
      await e.store.create(record({ id, name: `${id} 名`, content: `${id}：用 pnpm`, source: { sessionId: `sess-${id}`, eventRange: [0, 2], sourceMode: 'user-explicit' } }))
    }
    const m = fakeModel([['mem_a', 'mem_b']])
    const controller = new AbortController()
    const { followUp } = await e.checkup({ llm: m.llm }, controller.signal)
    await isAsked
    controller.abort(new DOMException('plugin unloaded', 'AbortError'))
    await followUp
    expect(m.suggestCalls).toHaveLength(0)
    expect((await e.conflictItems())[0]).not.toHaveProperty('isGeneratingSuggestion')
  })

  it('两段交错：前一段收尾时不清掉后一段给同一条加的标记', async () => {
    const e = env()
    await seedPair(e, 'mem_a', 'mem_b')
    await seedPair(e, 'mem_c', 'mem_d')
    const pairs: Array<[string, string]> = [['mem_a', 'mem_b'], ['mem_c', 'mem_d']]
    // 第一段：第一条答得读不出（记一次失败，仍可再试），第二条等着
    const first = fakeModel(pairs, (_user, n) => (n === 1 ? '读不出的回复' : 'wait'))
    const one = await e.checkup({ llm: first.llm })
    await first.started()
    // 第二段：第二条正被第一段占着，只选中第一条，等着
    const second = fakeModel(pairs, () => 'wait')
    const two = await e.checkup({ llm: second.llm })
    await second.started()
    first.release()
    await one.followUp
    const ab = await e.entryOf('mem_a', 'mem_b')
    expect((await e.conflictItems()).find(i => i.decisionId === ab!.id)).toMatchObject({ isGeneratingSuggestion: true })
    second.release()
    await two.followUp
    expect((await e.conflictItems()).every(i => !('isGeneratingSuggestion' in i))).toBe(true)
  })
})

describe('体检之后的建议也回查出处', () => {
  it('两条都有出处：提示词带两段出处，建议记 isSourced 为真', async () => {
    const readEvent: ReadEventFn = async ({ sessionId }) => ({
      session: { id: sessionId },
      events: [{ type: 'user/message', seq: 1, data: { id: `u-${sessionId}`, role: 'user', content: [{ type: 'text', text: `${sessionId} 里说过的话` }], source: { kind: 'user' } } }],
    })
    const e = env({ readEvent })
    for (const id of ['mem_a', 'mem_b']) {
      await e.store.create(record({ id, name: `${id} 名`, content: `${id}：用 pnpm`, source: { sessionId: `sess-${id}`, eventRange: [0, 2], sourceMode: 'user-explicit' } }))
    }
    const m = fakeModel([['mem_a', 'mem_b']])
    await (await e.checkup({ llm: m.llm })).followUp
    expect(m.suggestCalls[0]).toContain('sess-mem_a 里说过的话')
    expect(m.suggestCalls[0]).toContain('sess-mem_b 里说过的话')
    expect((await e.conflictItems())[0]).toMatchObject({ suggestion: { isSourced: true } })
  })
})

describe('自动体检之后补上建议', () => {
  it('一次最多 10 条，先旧后新；没轮到的记「名额用完」，不调用模型、不算尝试；下一次自动体检接着补', async () => {
    const e = env()
    const pairs: Array<[string, string]> = []
    for (let i = 0; i < AUTO_SUGGESTION_LIMIT + 2; i++) {
      const pair: [string, string] = [`mem_${String(i).padStart(2, '0')}a`, `mem_${String(i).padStart(2, '0')}b`]
      await seedPair(e, ...pair)
      await e.decisions.upsert({ memoryIds: pair, summary: '说法矛盾' }, NOW - 1000 + i)
      pairs.push(pair)
    }
    const m = fakeModel(pairs)
    await (await e.checkup({ llm: m.llm, target: GLOBAL as Scope, by: 'auto' })).followUp
    expect(m.suggestCalls).toHaveLength(AUTO_SUGGESTION_LIMIT)
    const items = await e.conflictItems()
    expect(items.slice(0, AUTO_SUGGESTION_LIMIT).every(i => i.suggestion !== undefined)).toBe(true)
    expect(items.slice(AUTO_SUGGESTION_LIMIT).map(i => i.noSuggestion)).toEqual([{ code: 'quota-exhausted' }, { code: 'quota-exhausted' }])
    const late = await e.entryOf(...pairs[AUTO_SUGGESTION_LIMIT]!)
    expect(late?.suggestionAttempts).toBeUndefined()

    await (await e.checkup({ llm: m.llm, target: GLOBAL as Scope, by: 'auto' })).followUp
    expect(m.suggestCalls).toHaveLength(AUTO_SUGGESTION_LIMIT + 2)
    expect((await e.conflictItems()).every(i => i.suggestion !== undefined)).toBe(true)
  })
})

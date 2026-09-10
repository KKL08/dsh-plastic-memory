import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BaselineCache, EMPTY_BASELINE, baselineTexts, foldBaseline } from '../src/governance/baseline.ts'

/**
 * 宿主 agent-instructions 的 user/message 事件（形状照 0.1.5 的 AgentInstructionSource）：
 * 正文是渲染后的提示语加文件内容；`changes` 是结构化真相——这条消息 set/replace/remove 了哪些 scope；
 * `baseline: true` 标记启动/恢复时的完整基线。scope 在宿主是「目录 + 候选文件名」编码的键，这里用可读字符串代替。
 */
type Change = { action: 'set' | 'replace' | 'remove'; scope: string; path: string }
type Block = { type: string; text?: unknown }
let nextSeq = 0
function instr(text: string | Block[], changes: Change[], opts: { baseline?: true } = {}): SessionEvent {
  const content = typeof text === 'string' ? [{ type: 'text', text }] : text
  return {
    type: 'user/message',
    seq: nextSeq++,
    time: 0,
    data: { id: `m${nextSeq}`, role: 'user', content, source: { kind: 'agent-instructions', form: 'instructions', ...opts, changes } },
  } as unknown as SessionEvent
}
const full = (text: string | Block[], changes: Change[]) => instr(text, changes, { baseline: true })
const set = (scope: string): Change => ({ action: 'set', scope, path: `${scope}/AGENTS.md` })
const replace = (scope: string): Change => ({ action: 'replace', scope, path: `${scope}/AGENTS.md` })
const remove = (scope: string): Change => ({ action: 'remove', scope, path: `${scope}/AGENTS.md` })
const GLOBAL = 'user-global'
const ROOT = '.'
const PKG = 'pkg'
const otherEvent = (type: string) => ({ type, seq: nextSeq++, time: 0, data: {} }) as unknown as SessionEvent

/** 断言用：把有效消息正文按顺序拼起来；没有生效指令时 null。 */
const joined = (texts: readonly string[] | null) => (texts === null || texts.length === 0 ? null : texts.join('\n\n'))
const fold = (events: SessionEvent[], warn: (msg: string) => void = () => {}) =>
  joined(baselineTexts(foldBaseline(EMPTY_BASELINE, events, warn)))

describe('foldBaseline：按 changes 的 scope 折叠出当前有效指令集合', () => {
  it('无事件或无 agent-instructions 消息时为空', () => {
    expect(fold([])).toBeNull()
    expect(fold([otherEvent('tool/call')])).toBeNull()
    const plainUser = { type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }
    expect(fold([plainUser as unknown as SessionEvent])).toBeNull()
  })

  it('正文取 text 块按行拼接，非 text 块剔除', () => {
    expect(fold([full([
      { type: 'text', text: '规则 A' },
      { type: 'image' },
      { type: 'text', text: '规则 B' },
    ], [set(ROOT)])])).toBe('规则 A\n规则 B')
  })

  it('增量触碰新 scope：按事件顺序追加在完整基线之后', () => {
    expect(fold([
      full('Instructions from: AGENTS.md\n\n包管理用 pnpm', [set(GLOBAL), set(ROOT)]),
      instr('Additional instructions from: pkg/AGENTS.md\n\n子包用 vitest', [set(PKG)]),
    ])).toBe('Instructions from: AGENTS.md\n\n包管理用 pnpm\n\nAdditional instructions from: pkg/AGENTS.md\n\n子包用 vitest')
  })

  it('replace 同一 scope：旧文本退出，只剩新修订（长基线加修订不再被截断成只剩旧规则）', () => {
    expect(fold([
      full('Instructions from: AGENTS.md\n\n包管理用 npm', [set(ROOT)]),
      instr('Updated instructions from: AGENTS.md\n\n包管理用 pnpm', [replace(ROOT)]),
    ])).toBe('Updated instructions from: AGENTS.md\n\n包管理用 pnpm')
  })

  it('remove：提示语顶替原文本，之后再 set 又顶替提示语', () => {
    const events = [
      full('包管理用 npm', [set(ROOT)]),
      instr('Instructions removed: AGENTS.md\n\nThe previously loaded instructions from this file no longer apply.', [remove(ROOT)]),
    ]
    expect(fold(events)).toBe('Instructions removed: AGENTS.md\n\nThe previously loaded instructions from this file no longer apply.')
    expect(fold([...events, instr('Additional instructions from: AGENTS.md\n\n重新加回：用 pnpm', [set(ROOT)])]))
      .toBe('Additional instructions from: AGENTS.md\n\n重新加回：用 pnpm')
  })

  it('多 scope 消息被部分取代时整条保留，剩余 scope 也被取代后才退出', () => {
    const base = full('global 规则 + root 规则', [set(GLOBAL), set(ROOT)])
    const rootV2 = instr('root v2', [replace(ROOT)])
    expect(fold([base, rootV2])).toBe('global 规则 + root 规则\n\nroot v2')
    expect(fold([base, rootV2, instr('global v2', [replace(GLOBAL)])])).toBe('root v2\n\nglobal v2')
  })

  it('宿主换基线（身份变化）：新完整基线携带旧 scope 的 remove，旧基线退出，未触碰的子目录规则保留', () => {
    expect(fold([
      full('v1：global + root', [set(GLOBAL), set(ROOT)]),
      instr('子包规则', [set(PKG)]),
      full('v2：只剩 root', [remove(GLOBAL), set(ROOT)]),
    ])).toBe('子包规则\n\nv2：只剩 root')
  })

  it('恢复会话时新出现的根目录基线不会冲掉已加载、宿主不再重发的子目录规则', () => {
    expect(fold([
      instr('Additional instructions from: pkg/AGENTS.md\n\n子包用 vitest', [set(PKG)]),
      full('Instructions from: AGENTS.md\n\n根目录规则', [set(ROOT)]),
    ])).toBe('Additional instructions from: pkg/AGENTS.md\n\n子包用 vitest\n\nInstructions from: AGENTS.md\n\n根目录规则')
  })

  it('compaction 后宿主重发不带 remove 的完整基线：上一条完整基线覆盖的 scope 整体作废，未触碰的子目录规则保留', () => {
    const before = [full('global 规则 + root 规则', [set(GLOBAL), set(ROOT)]), instr('子包规则', [set(PKG)])]
    expect(fold([...before, full('只剩 root（global 文件已删）', [set(ROOT)])])).toBe('子包规则\n\n只剩 root（global 文件已删）')
  })

  it('两次完整基线之间对基线 scope 的增量修订，同样被重发的完整基线作废', () => {
    expect(fold([
      full('global + root', [set(GLOBAL), set(ROOT)]),
      instr('global v2', [replace(GLOBAL)]),
      full('只剩 root', [set(ROOT)]),
    ])).toBe('只剩 root')
  })

  it('只有增量、没见过完整基线时也把增量当作当前指令', () => {
    expect(fold([instr('只有一条增量', [set(PKG)])])).toBe('只有一条增量')
  })

  it('正文没有 text 块（形状漂移）：changes 照常生效、不追加文本，并告警指出 seq', () => {
    const warnings: string[] = []
    const events = [full('真基线', [set(ROOT)]), instr([{ type: 'image' }], [replace(ROOT)])]
    expect(fold(events, m => warnings.push(m))).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`seq ${events[1].seq}`)
  })

  it('消息缺少 changes（形状漂移）：文本保留且永不退出，并告警', () => {
    const warnings: string[] = []
    const broken = instr('没有 changes 的消息', [])
    delete (broken.data as { source: { changes?: unknown } }).source.changes
    expect(fold([broken, full('后来的基线', [set(ROOT)])], m => warnings.push(m))).toBe('没有 changes 的消息\n\n后来的基线')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`seq ${broken.seq}`)
  })

  it('分批折叠与一次折叠结果逐字相同（折叠只取决于事件序列）', () => {
    const events = [full('v1', [set(GLOBAL), set(ROOT)]), instr('pkg', [set(PKG)]), instr('root v2', [replace(ROOT)]), full('v2', [remove(GLOBAL), set(ROOT)]), instr('pkg 删除', [remove(PKG)])]
    const once = joined(baselineTexts(foldBaseline(EMPTY_BASELINE, events, () => {})))
    let state = EMPTY_BASELINE
    for (const e of events) state = foldBaseline(state, [e], () => {})
    expect(joined(baselineTexts(state))).toBe(once)
    expect(once).toBe('v2\n\npkg 删除')
  })
})

/** 假的宿主 Session 日志读取面：seq 是下一条事件的位置，snapshotEvents 是半开区间；记录每次请求的区间。 */
function fakeLog(events: SessionEvent[]) {
  const calls: Array<[number, number]> = []
  return {
    calls,
    log: {
      get seq() { return events.length },
      snapshotEvents(fromSeq = 0, toSeqExclusive = events.length) {
        calls.push([fromSeq, toSeqExclusive])
        return events.slice(fromSeq, toSeqExclusive)
      },
    },
  }
}
const cache = () => new BaselineCache(() => {})

describe('BaselineCache：按 session.seq 增量物化', () => {
  it('undefined session 或空日志返回 null', () => {
    const c = cache()
    expect(c.get(undefined)).toBeNull()
    expect(c.get(fakeLog([]).log)).toBeNull()
  })

  it('首次读取折叠全量', () => {
    const c = cache()
    const { log, calls } = fakeLog([full('包管理用 pnpm', [set(ROOT)])])
    expect(joined(c.get(log))).toBe('包管理用 pnpm')
    expect(calls).toEqual([[0, 1]])
  })

  it('seq 不变时命中缓存，不再请求事件', () => {
    const c = cache()
    const events = [full('第一版', [set(ROOT)])]
    const { log, calls } = fakeLog(events)
    expect(joined(c.get(log))).toBe('第一版')
    ;(events[0].data as { content: { text: string }[] }).content[0].text = '偷偷改了' // 已接受的事件在真机是冻结的；这里证明没重扫
    expect(joined(c.get(log))).toBe('第一版')
    expect(calls).toHaveLength(1)
  })

  it('seq 前进时只物化 [cachedSeq, seq) 这段新增区间', () => {
    const c = cache()
    const events = [full('第一版', [set(ROOT)]), otherEvent('tool/call')]
    const { log, calls } = fakeLog(events)
    expect(joined(c.get(log))).toBe('第一版')
    events.push(otherEvent('assistant/message'), instr('增量甲', [set(PKG)]))
    expect(joined(c.get(log))).toBe('第一版\n\n增量甲')
    expect(calls).toEqual([[0, 2], [2, 4]])
  })

  it('新增区间没有指令消息时结果不变', () => {
    const c = cache()
    const events = [full('第一版', [set(ROOT)])]
    const { log } = fakeLog(events)
    expect(joined(c.get(log))).toBe('第一版')
    events.push(otherEvent('tool/call'))
    expect(joined(c.get(log))).toBe('第一版')
  })

  it('分三批读与冷读一次结果逐字相同', () => {
    const events = [full('第一版', [set(ROOT)]), instr('增量甲', [set(PKG)]), full('第二版', [set(ROOT)]), instr('增量乙', [replace(PKG)])]
    const cold = joined(cache().get(fakeLog(events).log))
    const growing: SessionEvent[] = []
    const { log } = fakeLog(growing)
    const warm = cache()
    growing.push(events[0]); warm.get(log)
    growing.push(events[1], events[2]); warm.get(log)
    growing.push(events[3])
    expect(joined(warm.get(log))).toBe(cold)
    expect(cold).toBe('第二版\n\n增量乙')
  })

  it('折叠告警经缓存的 warn 回调送出', () => {
    const warnings: string[] = []
    const c = new BaselineCache(m => warnings.push(m))
    expect(c.get(fakeLog([instr([{ type: 'image' }], [set(ROOT)])]).log)).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it('HMR 场景：新建缓存实例对已有日志的 session 直接 get 到基线（无需先观察）', () => {
    expect(joined(cache().get(fakeLog([full('# CLAUDE.md\n不要 mock 数据库', [set(ROOT)])]).log))).toContain('不要 mock 数据库')
  })

  it('不同 session 的基线互不串台', () => {
    const c = cache()
    const a = fakeLog([full('项目甲：用 pnpm', [set(ROOT)])]).log
    const b = fakeLog([full('项目乙：用 npm', [set(ROOT)])]).log
    expect(joined(c.get(a))).toBe('项目甲：用 pnpm')
    expect(joined(c.get(b))).toBe('项目乙：用 npm')
    expect(joined(c.get(a))).toBe('项目甲：用 pnpm')
  })
})

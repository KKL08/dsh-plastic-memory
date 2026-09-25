import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { baselineProjectionDefinition, baselineTexts, readBaseline } from '../src/governance/baseline.ts'

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
/** 形状漂移：删掉 source.changes。 */
function withoutChanges(event: SessionEvent): SessionEvent {
  delete (event.data as { source: { changes?: unknown } }).source.changes
  return event
}
const otherEvent = (type: string) => ({ type, seq: nextSeq++, time: 0, data: {} }) as unknown as SessionEvent

/** 断言用：把有效消息正文按顺序拼起来；没有生效指令时 null。 */
const joined = (texts: readonly string[] | null) => (texts === null || texts.length === 0 ? null : texts.join('\n\n'))
/** 照宿主 registry 的驱动方式：init 起步，逐条事件过 apply。 */
const { init, apply } = baselineProjectionDefinition
const reduce = (events: SessionEvent[]) => events.reduce(apply, init())
const fold = (events: SessionEvent[]) => joined(baselineTexts(reduce(events)))

describe('基线投影 apply：按 changes 的 scope 折叠出当前有效指令集合', () => {
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

  it('正文没有 text 块（形状漂移）：changes 照常生效、不追加文本，drift 记 no-text', () => {
    const noText = instr([{ type: 'image' }], [replace(ROOT)])
    const state = reduce([full('真基线', [set(ROOT)]), noText])
    expect(joined(baselineTexts(state))).toBeNull()
    expect(state.drift).toEqual([{ seq: noText.seq, kind: 'no-text' }])
  })

  it('只有空 text 块同样算 no-text', () => {
    const empty = instr([{ type: 'text', text: '' }], [replace(ROOT)])
    const state = reduce([full('真基线', [set(ROOT)]), empty])
    expect(joined(baselineTexts(state))).toBeNull()
    expect(state.drift).toEqual([{ seq: empty.seq, kind: 'no-text' }])
  })

  it('消息缺少 changes（形状漂移）：文本保留且永不退出，drift 记 no-changes', () => {
    const broken = withoutChanges(instr('没有 changes 的消息', []))
    const state = reduce([broken, full('后来的基线', [set(ROOT)])])
    expect(joined(baselineTexts(state))).toBe('没有 changes 的消息\n\n后来的基线')
    expect(state.drift).toEqual([{ seq: broken.seq, kind: 'no-changes' }])
  })

  it('分支优先级：既缺 changes 又无正文 → 只记 no-changes，照旧追加一条空正文', () => {
    const broken = withoutChanges(instr([{ type: 'image' }], []))
    const state = reduce([broken])
    expect(state.entries).toEqual([{ text: '', scopes: [] }])
    expect(state.drift).toEqual([{ seq: broken.seq, kind: 'no-changes' }])
  })

  it('drift 只留最近 32 条：第 33 条进来时丢最旧，顺序不变', () => {
    const events = Array.from({ length: 33 }, () => instr([{ type: 'image' }], [set(PKG)]))
    const at32 = reduce(events.slice(0, 32))
    expect(at32.drift.map(d => d.seq)).toEqual(events.slice(0, 32).map(e => e.seq))
    const at33 = reduce(events)
    expect(at33.drift).toHaveLength(32)
    expect(at33.drift.map(d => d.seq)).toEqual(events.slice(1).map(e => e.seq))
    expect(baselineProjectionDefinition.stateSchema.safeParse(at33).success).toBe(true)
  })

  it('不相关事件（非指令消息）返回同一状态引用（宿主据 Object.is 判定零下游工作）', () => {
    const state = reduce([full('基线', [set(ROOT)])])
    const plainUser = { type: 'user/message', seq: nextSeq++, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }
    expect(apply(state, otherEvent('tool/call'))).toBe(state)
    expect(apply(state, plainUser as unknown as SessionEvent)).toBe(state)
  })
})

/**
 * 宿主 checkpoint 存的是 `val`（经无损 JSON 守卫落盘），恢复时过 stateSchema 再从 seq 之后续折。
 * 这里照这条路走：任意切点前缀折叠 → JSON 往返 → stateSchema.parse → 后缀续折，须与不间断折叠逐字相等。
 */
describe('checkpoint 等价性：前缀折叠 → JSON 往返 → stateSchema → 后缀续折', () => {
  const { stateSchema } = baselineProjectionDefinition
  const plainUser = () => ({ type: 'user/message', seq: nextSeq++, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }) as unknown as SessionEvent

  /** 覆盖全部折叠分支的一段事件，中间穿插不相关事件。 */
  function coverage(): SessionEvent[] {
    return [
      full('v1：global + root', [set(GLOBAL), set(ROOT)]),
      otherEvent('tool/call'),
      instr('子包规则', [set(PKG)]),
      instr('root v2', [replace(ROOT)]), // 多 scope 基线被部分取代：整条保留，只剩 global
      plainUser(),
      instr([{ type: 'image' }], [replace(GLOBAL)]), // no-text：changes 生效、不追加
      instr('Instructions removed: pkg/AGENTS.md', [remove(PKG)]),
      full('v2：换基线，带 remove', [remove(GLOBAL), set(ROOT)]),
      withoutChanges(instr('没有 changes 的消息', [])), // no-changes：追加且永不退出
      otherEvent('turn/end'),
      instr('a + b 两个 scope', [set('a'), set('b')]),
      instr('a v2', [replace('a')]), // 增量多 scope 消息被部分取代
      full('v3：compaction 后重发，不带 remove', [set(ROOT)]),
      instr('c 规则', [set('c')]),
      otherEvent('tool/result'),
    ]
  }

  it('任意切点（含 0 与末尾）续折后的完整状态与正文都与不间断折叠相等', () => {
    const events = coverage()
    const whole = reduce(events)
    // 先确认这段序列真的走到了各分支，否则等价性是空证明
    expect(baselineTexts(whole)).toEqual([
      'Instructions removed: pkg/AGENTS.md', '没有 changes 的消息', 'a + b 两个 scope', 'a v2',
      'v3：compaction 后重发，不带 remove', 'c 规则',
    ])
    expect(whole.entries[2]).toEqual({ text: 'a + b 两个 scope', scopes: ['b'] })
    expect(whole.baselineScopes).toEqual([ROOT])
    expect(whole.drift.map(d => d.kind)).toEqual(['no-text', 'no-changes'])
    for (let k = 0; k <= events.length; k++) {
      const checkpoint = JSON.parse(JSON.stringify(events.slice(0, k).reduce(apply, init())))
      const resumed = events.slice(k).reduce(apply, stateSchema.parse(checkpoint))
      expect(resumed, `切点 ${k}`).toEqual(whole)
      expect(baselineTexts(resumed), `切点 ${k}`).toEqual(baselineTexts(whole))
    }
  })

  it('init 结果通过 stateSchema', () => {
    expect(stateSchema.parse(init())).toEqual(init())
  })

  it('stateSchema 拒绝未知 drift kind 与非数组 scopes', () => {
    expect(stateSchema.safeParse({ entries: [], baselineScopes: [], drift: [{ seq: 0, kind: 'no-idea' }] }).success).toBe(false)
    expect(stateSchema.safeParse({ entries: [{ text: 'x', scopes: {} }], baselineScopes: [], drift: [] }).success).toBe(false)
  })
})

describe('readBaseline：状态 → 正文与本次新告警', () => {
  it('同一 session 同一 seq 只告警一次；两种 kind 沿用两条不同措辞', () => {
    const noText = instr([{ type: 'image' }], [set(PKG)])
    const broken = withoutChanges(instr('没有 changes 的消息', []))
    const state = reduce([full('基线', [set(ROOT)]), noText, broken])
    const warned = new Set<number>()
    const first = readBaseline(state, warned)
    expect(first.texts).toEqual(['基线', '没有 changes 的消息'])
    expect(first.warnings).toEqual([
      `agent-instructions message at seq ${noText.seq} carries no text blocks; baseline may be incomplete`,
      `agent-instructions message at seq ${broken.seq} carries no changes array; keeping its text without scope tracking`,
    ])
    const second = readBaseline(state, warned)
    expect(second.texts).toEqual(first.texts)
    expect(second.warnings).toEqual([])
  })

  it('之后新增的漂移只对新 seq 告警；另一个 session 的集合各自告警', () => {
    const first = instr([{ type: 'image' }], [set(PKG)])
    const later = instr([{ type: 'image' }], [set(PKG)])
    const warned = new Set<number>()
    readBaseline(reduce([first]), warned)
    const again = readBaseline(reduce([first, later]), warned)
    expect(again.warnings).toHaveLength(1)
    expect(again.warnings[0]).toContain(`seq ${later.seq} `)
    expect(readBaseline(reduce([first, later]), new Set()).warnings).toHaveLength(2)
  })

  it('已退出 drift 的 seq 也从 warned 里清掉：长会话反复漂移，集合不超过 drift 上限', () => {
    const events = Array.from({ length: 100 }, () => instr([{ type: 'image' }], [set(PKG)]))
    const warned = new Set<number>()
    let total = 0
    for (let k = 1; k <= events.length; k++) total += readBaseline(reduce(events.slice(0, k)), warned).warnings.length
    expect(total).toBe(events.length)
    expect(warned.size).toBe(32)
    expect([...warned]).toEqual(reduce(events).drift.map(d => d.seq))
    expect(readBaseline(reduce(events), warned).warnings).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { BaselineCache, deriveBaseline } from '../src/governance/baseline.ts'

/** 造一条 agent-instructions 的 user/message 事件（session.events 元素形状：{ type, data }）。 */
function instr(content: unknown) {
  return { type: 'user/message', data: { source: { kind: 'agent-instructions' }, content } }
}

describe('deriveBaseline', () => {
  it('无事件或无 agent-instructions 时返回 null', () => {
    expect(deriveBaseline([])).toBeNull()
    expect(deriveBaseline([{ type: 'tool/call', data: {} }])).toBeNull()
    expect(deriveBaseline([{ type: 'user/message', data: { source: { kind: 'user' }, content: 'hi' } }])).toBeNull()
  })

  it('content 为字符串时直接提取', () => {
    expect(deriveBaseline([instr('# AGENTS.md\n包管理用 pnpm')])).toContain('包管理用 pnpm')
  })

  it('content 为 ContentBlock 数组时拼接 text 块，非 text/非字符串 text 被剔除', () => {
    expect(deriveBaseline([instr([
      { type: 'text', text: '规则 A' },
      { type: 'image' },
      { type: 'text', text: 123 },
      { type: 'text', text: null },
      { type: 'text', text: '规则 B' },
    ])])).toBe('规则 A\n规则 B')
  })

  it('多条 agent-instructions 时尾部（最新）胜', () => {
    expect(deriveBaseline([instr('第一版'), instr('第二版')])).toBe('第二版')
  })

  it('最新一条为退化形状（空串/空数组/无 text 块）时回退到更早的真基线', () => {
    expect(deriveBaseline([instr('真基线'), instr('')])).toBe('真基线')
    expect(deriveBaseline([instr('真基线'), instr([])])).toBe('真基线')
    expect(deriveBaseline([instr('真基线'), instr([{ type: 'image' }])])).toBe('真基线')
  })

  it('全部为退化形状时返回 null（不把库当作有基线）', () => {
    expect(deriveBaseline([instr(''), instr([]), instr([{ type: 'image' }])])).toBeNull()
  })
})

describe('BaselineCache', () => {
  it('从 session.events 现推基线；无事件返回 null', () => {
    const c = new BaselineCache()
    expect(c.get({ events: [] })).toBeNull()
    expect(c.get({ events: [instr('包管理用 pnpm')] })).toContain('包管理用 pnpm')
  })

  it('undefined session 或缺 events 字段时返回 null', () => {
    const c = new BaselineCache()
    expect(c.get(undefined)).toBeNull()
    expect(c.get({})).toBeNull()
  })

  it('memoize：事件数不变不重扫，追加事件后才重新推导', () => {
    const c = new BaselineCache()
    const ev = instr('第一版')
    const session: { events: unknown[] } = { events: [ev] }
    expect(c.get(session)).toBe('第一版')

    // 原地篡改已有事件内容（length 不变）：memoize 命中，仍返回上次结果，证明没重扫
    ev.data.content = '偷偷改了'
    expect(c.get(session)).toBe('第一版')

    // 追加新事件（length 变）：重新推导，尾部最新胜
    session.events.push(instr('第三版'))
    expect(c.get(session)).toBe('第三版')
  })

  it('HMR 场景：新建缓存实例对已有 events 的 session 直接 get 到基线（无需先观察）', () => {
    // 插件热重载后 BaselineCache 是全新实例、无任何历史观察；拉模型下 get 直接从
    // session.events 推导即可拿到基线，垂直冲突检测不会因重载而静默失效。
    const c = new BaselineCache()
    const session = { events: [instr('# CLAUDE.md\n不要 mock 数据库') ] }
    expect(c.get(session)).toContain('不要 mock 数据库')
  })
})

describe('BaselineCache 按 session 隔离', () => {
  it('不同 session 的基线互不串台', () => {
    const c = new BaselineCache()
    const a = { events: [instr('项目甲：用 pnpm')] }
    const b = { events: [instr('项目乙：用 npm')] }
    expect(c.get(a)).toBe('项目甲：用 pnpm')
    expect(c.get(b)).toBe('项目乙：用 npm')
    expect(c.get({ events: [] })).toBeNull()
  })
})

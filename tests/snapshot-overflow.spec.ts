import { describe, expect, it } from 'vitest'
import { assembleSnapshot, estimateTokens, overflowLevel, COLD_START_TEXT, MEMORY_AS_DATA_NOTE, COMPACTION_ENGINE_NOTE } from '../src/snapshot.ts'
import { EVIDENCE_GUIDANCE } from '../src/evidence-guidance.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { formatIndexLine } from '../src/index-line.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { DAY } from './helpers/clock.ts'
import { SNAPSHOT_SUPERSEDE_NOTE } from '../src/snapshot-message.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const NOW = 10 * DAY
const WS = '/repo/proj'
/** 快照消息里取代句连同空行的估算：属于消息层，计进固定说明。 */
const SUPERSEDE_TOKENS = estimateTokens(`${SNAPSHOT_SUPERSEDE_NOTE}\n\n`)
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, ...partial })
const base = { registry, workspacePath: WS, now: NOW }

/** 十条 knowledge（search 召回），一半 global、一半本项目。 */
function tenRecords(): MemoryRecord[] {
  return Array.from({ length: 10 }, (_, i) => record({
    id: `mem_${i}`, name: `条目${i}`, summary: '一段用来占预算的摘要文字', confidence: 0.9 - i * 0.01,
    ...(i % 2 === 0 ? { scope: 'global' as const } : { scope: 'workspace' as const, workspacePath: WS }),
  }))
}

describe('estimateTokens：按字符计价', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('纯中文每字 0.6，合计向上取整；整数倍不因浮点误差多进一', () => {
    expect(estimateTokens('中文记忆')).toBe(3) // 2.4
    expect(estimateTokens('一二三四五')).toBe(3) // 3.0
    expect(estimateTokens('字'.repeat(6666))).toBe(4000) // 默认上限约合 6,700 个中文字
  })

  it('纯英文每个字符 0.3：字母、数字、空白、半角标点都算', () => {
    expect(estimateTokens('hello world')).toBe(4) // 11 × 0.3 = 3.3
    expect(estimateTokens('a1 ,.!?\n')).toBe(3) // 8 × 0.3 = 2.4
    expect(estimateTokens('x'.repeat(10))).toBe(3) // 3.0
  })

  it('中英混排各按各的计', () => {
    expect(estimateTokens('用 pnpm 装依赖')).toBe(5) // 4 × 0.6 + 6 × 0.3 = 4.2
  })

  it('全角标点（CJK 符号与标点、全角形式）按中文计，半角标点按其他字符计', () => {
    expect(estimateTokens('，。！？「」')).toBe(4) // 6 × 0.6 = 3.6
    expect(estimateTokens('、〜　（）：')).toBe(4) // U+3001 U+301C U+3000 U+FF08 U+FF09 U+FF1A
    expect(estimateTokens(',.!?()')).toBe(2) // 6 × 0.3 = 1.8
  })

  it('与检索同一 CJK 口径：假名、谚文算中文；按码点计，扩展区汉字不算两个', () => {
    expect(estimateTokens('かなカナ한글')).toBe(4) // 6 × 0.6 = 3.6
    expect(estimateTokens('𠀀')).toBe(1) // 0.6
    expect(estimateTokens('😀😀')).toBe(1) // 2 × 0.3 = 0.6
  })
})

describe('assembleSnapshot：超出上限两种模式', () => {
  it('自动放宽：预算再小也全部带入，不截断、没有导航图，用量如实超过上限', () => {
    const records = tenRecords()
    const r = assembleSnapshot({ ...base, records, budget: 20, overflow: 'relax' })
    for (const rec of records) expect(r.text).toContain(`[${rec.id}]`)
    expect(r.text).not.toContain('索引未列全')
    expect(r.omittedCount).toBe(0)
    expect([...r.injectedIds].sort()).toEqual(records.map(x => x.id).sort())
    expect(r.usedTokens).toBeGreaterThan(20)
  })

  it('缺省模式就是自动放宽', () => {
    const r = assembleSnapshot({ ...base, records: tenRecords(), budget: 20 })
    expect(r.omittedCount).toBe(0)
  })

  it('严格：截断只作用于索引行，固定尾注照常带上；omittedCount 就是没带入的条数', () => {
    const records = tenRecords()
    const budget = 60
    const r = assembleSnapshot({ ...base, records, budget, overflow: 'strict', memoryRoot: '/m', evidenceLookup: 'strict' })
    expect(r.usedTokens).toBeLessThanOrEqual(budget)
    expect(r.omittedCount).toBeGreaterThan(0)
    expect(r.omittedCount + r.injectedIds.length).toBe(records.length)
    expect(r.text).toContain(`另有 ${r.omittedCount} 条记忆未列出`)
    for (const id of r.injectedIds) expect(r.text).toContain(`[${id}]`)
    // 尾注不计预算、不被截
    expect(r.text).toContain(MEMORY_AS_DATA_NOTE)
    expect(r.text).toContain(EVIDENCE_GUIDANCE.strict)
    expect(r.text).toContain('/m/global/MEMORY.md')
  })

  it('严格且放得下：全部带入，omittedCount 为 0', () => {
    const r = assembleSnapshot({ ...base, records: tenRecords(), budget: 4000, overflow: 'strict' })
    expect(r.omittedCount).toBe(0)
    expect(r.injectedIds).toHaveLength(10)
  })
})

describe('assembleSnapshot：按作用域分段的 token', () => {
  it('记忆行按作用域归本项目 / 全局，其余（标题、附注、尾注、取代句）归固定说明；三段之和 = 预算内用量 + 附注 + 固定尾注 + 取代句', () => {
    const g = record({ id: 'mem_g', scope: 'global', name: '全局条目', summary: '全局摘要' })
    const w = record({ id: 'mem_w', scope: 'workspace', workspacePath: WS, name: '项目条目', summary: '项目摘要内容' })
    const r = assembleSnapshot({ ...base, records: [g, w], budget: 4000 })
    expect(r.tokens.global).toBe(estimateTokens(formatIndexLine(g, { passive: false, note: '' })))
    expect(r.tokens.workspace).toBe(estimateTokens(formatIndexLine(w, { passive: false, note: '' })))
    const tail = estimateTokens('\n看全文：用 memory_search 按 id 或关键词查。') + estimateTokens(`\n${MEMORY_AS_DATA_NOTE}`)
    expect(r.tokens.workspace + r.tokens.global + r.tokens.fixed).toBe(r.usedTokens + estimateTokens(`\n> ${COMPACTION_ENGINE_NOTE}\n`) + tail + SUPERSEDE_TOKENS)
    expect(r.injectedIds.sort()).toEqual(['mem_g', 'mem_w'])
  })

  it('core 区正文同样按作用域计', () => {
    const w = record({ id: 'mem_pref', type: 'preference', scope: 'workspace', workspacePath: WS, content: '项目里用 pnpm' })
    const r = assembleSnapshot({ ...base, records: [w], budget: 4000 })
    expect(r.tokens.workspace).toBeGreaterThan(0)
    expect(r.tokens.global).toBe(0)
    expect(r.injectedIds).toEqual(['mem_pref'])
  })

  it('冷启动：只有固定说明（文案加取代句）', () => {
    const r = assembleSnapshot({ ...base, records: [], budget: 4000 })
    expect(r.tokens).toEqual({ workspace: 0, global: 0, fixed: estimateTokens(COLD_START_TEXT) + SUPERSEDE_TOKENS })
    expect(r.usedTokens).toBe(0)
    expect(r.injectedIds).toEqual([])
    expect(r.omittedCount).toBe(0)
  })
})

describe('overflowLevel：档位', () => {
  it('自动放宽：档位 = 上限 × (1 + 0.25n)，用量超过上一档才进入下一档', () => {
    expect(overflowLevel('relax', 4000, 4000)).toBeUndefined()
    expect(overflowLevel('relax', 4001, 4000)).toEqual({ mode: 'relax', tier: 1 })
    expect(overflowLevel('relax', 5000, 4000)).toEqual({ mode: 'relax', tier: 1 })
    expect(overflowLevel('relax', 5001, 4000)).toEqual({ mode: 'relax', tier: 2 })
    expect(overflowLevel('relax', 9000, 4000)).toEqual({ mode: 'relax', tier: 5 })
  })

  it('严格：用到 95% 记一档', () => {
    expect(overflowLevel('strict', 3799, 4000)).toBeUndefined()
    expect(overflowLevel('strict', 3800, 4000)).toEqual({ mode: 'strict', tier: 0 })
    expect(overflowLevel('strict', 4000, 4000)).toEqual({ mode: 'strict', tier: 0 })
  })

  it('上限不是正数时不提醒', () => {
    expect(overflowLevel('relax', 100, 0)).toBeUndefined()
    expect(overflowLevel('strict', 100, 0)).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { SCAN_CONTENT_FIELDS, scanContentFingerprint, scanFingerprint } from '../src/governance/changeset.ts'
import { buildSemanticPrompt, semanticMemoryLine, SEMANTIC_PROMPT_VERSION } from '../src/governance/semantic-scan.ts'
import { batchKey, batchMembers, checkContext, crossWsRows, instructionState, planCheckup, REFRESH_AFTER_MS, type InstructionState, type PlannedRound } from '../src/governance/checkup-plan.ts'
import { hostSemanticLlm } from '../src/governance/host-llm.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

const FUTURE = Date.UTC(2030, 0, 1)

/** 每个内容字段换一个不同的值。 */
const CHANGED: Record<(typeof SCAN_CONTENT_FIELDS)[number], Partial<MemoryRecord>> = {
  type: { type: 'preference' },
  name: { name: '另一个名字' },
  content: { content: '另一段正文' },
  summary: { summary: '另一句摘要' },
  factTime: { factTime: '2026-11' },
  validFrom: { validFrom: FUTURE },
  validTo: { validTo: FUTURE },
}

describe('键与上下文', () => {
  it('指纹字段和模型行字段出自同一份清单：行里的每个内容字段都在指纹里；改类型、事实时间、有效期（改到未来）后发给模型的文本变了', () => {
    const base = record({ id: 'mem_a', type: 'knowledge' })
    for (const field of SCAN_CONTENT_FIELDS) {
      const changed = { ...base, ...CHANGED[field] }
      // 行里写了这个字段，就一定进了指纹：两者一起变
      expect(semanticMemoryLine(changed), field).not.toBe(semanticMemoryLine(base))
      expect(scanFingerprint(changed), field).not.toBe(scanFingerprint(base))
      expect(scanContentFingerprint(changed), field).not.toBe(scanContentFingerprint(base))
    }
    // 只改标签：行和指纹都不变
    const tagged = { ...base, tags: ['新标签'] }
    expect(semanticMemoryLine(tagged)).toBe(semanticMemoryLine(base))
    expect(scanFingerprint(tagged)).toBe(scanFingerprint(base))
    expect(scanContentFingerprint(tagged)).toBe(scanContentFingerprint(base))
  })

  it('批的键：成员和上下文一样、批内顺序不同 → 键一样；任一成员的指纹变了、上下文任一项变了 → 键不一样', () => {
    const a = record({ id: 'mem_a' })
    const b = record({ id: 'mem_b', scope: 'workspace', workspacePath: '/w' })
    const llm = { provider: 'p', model: 'm', reasoningEffort: 'high' }
    const ctx = checkContext(SEMANTIC_PROMPT_VERSION, llm, 'none')
    const key = batchKey(ctx, batchMembers([a, b]))
    expect(batchKey(ctx, batchMembers([b, a]))).toBe(key)
    expect(batchKey(ctx, batchMembers([a, { ...b, content: '改过' }]))).not.toBe(key)

    const states: InstructionState[] = [
      instructionState({ kind: 'none' }),
      instructionState({ kind: 'unavailable', reason: 'x' }),
      instructionState({ kind: 'found', texts: ['规则'], isTruncated: false }),
      instructionState({ kind: 'found', texts: ['规则'], isTruncated: true }),
    ]
    const contexts = [
      ctx,
      checkContext(SEMANTIC_PROMPT_VERSION + 1, llm, 'none'),
      checkContext(SEMANTIC_PROMPT_VERSION, { ...llm, provider: 'q' }, 'none'),
      checkContext(SEMANTIC_PROMPT_VERSION, { ...llm, model: 'n' }, 'none'),
      checkContext(SEMANTIC_PROMPT_VERSION, { ...llm, reasoningEffort: 'low' }, 'none'),
      checkContext(SEMANTIC_PROMPT_VERSION, { provider: 'p', model: 'm' }, 'none'),
      ...states.slice(1).map(s => checkContext(SEMANTIC_PROMPT_VERSION, llm, s)),
    ]
    const keys = contexts.map(c => batchKey(c, batchMembers([a, b])))
    expect(new Set(keys).size).toBe(keys.length)
    // 指令文件四种状态两两不同，读到的内容不同摘要也不同
    expect(new Set(states).size).toBe(4)
    expect(instructionState({ kind: 'found', texts: ['别的规则'], isTruncated: false })).not.toBe(states[2])
  })

  it('标签不发给模型，也不影响发给模型的那一行：标签和摘要拼起来像密钥时，行照样不变', () => {
    const base = record({ id: 'mem_a', summary: 'Use Bearer', tags: [] })
    const tagged = { ...base, tags: ['12345678901234567890'] }
    expect(semanticMemoryLine(tagged)).toBe(semanticMemoryLine(base))
    expect(semanticMemoryLine(tagged)).toContain('summary: Use Bearer')
  })

  it('护栏：内容检查的系统提示词或一条样例行变了，要同时改提示词版本（再按新版本更新这里的摘要）', () => {
    const sample = record({ id: 'mem_sample', type: 'knowledge', name: '样例', content: '正文', summary: '摘要', factTime: '2026-11', validFrom: new Date(2030, 0, 1, 0, 0).getTime(), validTo: new Date(2030, 0, 2, 0, 0).getTime() })
    // 有效期按本地时间构造：发给模型的那一行按本地时间写，换时区跑摘要也不变
    const prompt = buildSemanticPrompt([sample], ['基线'])
    // 检查项目时多出的那一段也在护栏里
    const projectPrompt = buildSemanticPrompt([sample], ['基线'], '/work/sample')
    const digest = createHash('sha1').update(`${prompt.system}\n${prompt.user}\n${projectPrompt.user}`).digest('hex')
    expect({ version: SEMANTIC_PROMPT_VERSION, digest }).toEqual({ version: 3, digest: 'ff9f5030012f6c147dbf2dee8331bbcdf6aec6ff' })
  })

  it('宿主接线的模型调用透出提供方、模型和推理强度；借会话的模型没有推理强度', () => {
    const llm = hostSemanticLlm({ stream: async function* () {} }, { provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect([llm?.provider, llm?.model, llm?.reasoningEffort]).toEqual(['p', 'm', 'high'])
    const borrowed = hostSemanticLlm({ stream: async function* () {} }, { provider: 'p', model: 'm' })
    expect(borrowed).not.toHaveProperty('reasoningEffort')
  })
})

describe('跨项目比较的行', () => {
  const members = [['/a', 'x'], ['/b', 'y'], ['global', 'z']] as const
  const row = (result: unknown) => ({ key: 'k', checkedAt: 1, members: members.map(m => [...m] as const), result })
  it('结构校验：主题为空、项目不到两个、项目不在这一行的成员里 → 这一行不要；合规的照常读出', () => {
    const good = { topic: '主题', workspaces: ['/a', '/b'], suggestion: '' }
    expect(crossWsRows([row([good])])).toHaveLength(1)
    for (const bad of [{ ...good, topic: '' }, { ...good, workspaces: ['/a'] }, { ...good, workspaces: ['/a', '/elsewhere'] }]) {
      expect(crossWsRows([row([good, bad])]), JSON.stringify(bad)).toEqual([])
    }
  })
})

describe('计划：顺序和上限', () => {
  const NOW = 100 * REFRESH_AFTER_MS
  const hitAt = (checkedAt: number) => ({ key: 'k', checkedAt, members: [], result: [] })
  const round = (key: string, lastCompletedAt: number | null, batches: PlannedRound['batches']): PlannedRound =>
    ({ round: key, scope: key === 'global' ? { kind: 'global' } : { kind: 'workspace', workspacePath: key }, lastCompletedAt, batches })
  const label = (steps: ReturnType<typeof planCheckup>['steps']) =>
    steps.map(s => (s.kind === 'cross-ws' ? 'cross' : `${s.round}#${s.index}${s.isRefresh ? '刷新' : ''}`))

  it('没命中的批轮流取：没完成过的轮最前，相同时全局在前、项目按路径；之后跨项目比较，最后按检查时间从旧到新刷新', () => {
    const old = NOW - REFRESH_AFTER_MS - 1
    const plan = planCheckup({
      rounds: [
        round('/b', 5, [{ cost: 1, hit: undefined }, { cost: 1, hit: hitAt(old - 10) }]),
        round('/a', null, [{ cost: 1, hit: undefined }, { cost: 1, hit: undefined }]),
        round('global', null, [{ cost: 1, hit: hitAt(old) }, { cost: 1, hit: undefined }]),
      ],
      crossWs: { cost: 1, isHit: false }, cap: 100, now: NOW,
    })
    expect(label(plan.steps)).toEqual(['global#1', '/a#0', '/b#0', '/a#1', 'cross', '/b#1刷新', 'global#0刷新'])
    expect(plan.isCapped).toBe(false)
  })

  it('累计超过上限就停：整次第一批不受上限限制（只这一批）；刷新批不享受豁免，放不下就不发', () => {
    const old = NOW - REFRESH_AFTER_MS - 1
    expect(planCheckup({ rounds: [round('global', null, [{ cost: 50, hit: undefined }, { cost: 50, hit: undefined }])], cap: 10, now: NOW }))
      .toEqual({ steps: [{ kind: 'batch', round: 'global', index: 0, isRefresh: false }], isCapped: true })
    expect(planCheckup({ rounds: [round('global', null, [{ cost: 50, hit: hitAt(old) }])], cap: 10, now: NOW }))
      .toEqual({ steps: [], isCapped: false })
    // 没命中的批发完后预算有余才刷新；不到 30 天的不刷新
    expect(label(planCheckup({ rounds: [round('global', null, [{ cost: 5, hit: undefined }, { cost: 5, hit: hitAt(old) }, { cost: 5, hit: hitAt(NOW - 1) }])], cap: 10, now: NOW }).steps))
      .toEqual(['global#0', 'global#1刷新'])
  })
})

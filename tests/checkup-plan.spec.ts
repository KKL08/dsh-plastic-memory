import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { SCAN_CONTENT_FIELDS, scanFingerprint } from '../src/governance/changeset.ts'
import { buildSemanticPrompt, semanticMemoryLine, SEMANTIC_PROMPT_VERSION } from '../src/governance/semantic-scan.ts'
import { batchKey, batchMembers, checkContext, instructionState, type InstructionState } from '../src/governance/checkup-plan.ts'
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
    }
    // 只改标签：行和指纹都不变
    const tagged = { ...base, tags: ['新标签'] }
    expect(semanticMemoryLine(tagged)).toBe(semanticMemoryLine(base))
    expect(scanFingerprint(tagged)).toBe(scanFingerprint(base))
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
    const digest = createHash('sha1').update(`${prompt.system}\n${prompt.user}`).digest('hex')
    expect({ version: SEMANTIC_PROMPT_VERSION, digest }).toEqual({ version: 2, digest: '00685c3a2ccf234fab697db0cb1a1fadc7d9c274' })
  })

  it('宿主接线的模型调用透出提供方、模型和推理强度；借会话的模型没有推理强度', () => {
    const llm = hostSemanticLlm({ stream: async function* () {} }, { provider: 'p', model: 'm', reasoningEffort: 'high' })
    expect([llm?.provider, llm?.model, llm?.reasoningEffort]).toEqual(['p', 'm', 'high'])
    const borrowed = hostSemanticLlm({ stream: async function* () {} }, { provider: 'p', model: 'm' })
    expect(borrowed).not.toHaveProperty('reasoningEffort')
  })
})

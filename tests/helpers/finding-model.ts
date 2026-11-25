import type { SemanticLlm } from '../../src/governance/semantic-scan.ts'
import { SOURCE_CHECK_SYSTEM_PROMPT } from '../../src/tools/finding-sources.ts'

/** 模型桩在内容检查里报的一条发现：涉及的记忆都在这一批里才报。type 原样给出，可以是不认识的取值。 */
export interface ReplyFinding {
  type: string
  ids: readonly string[]
  summary?: string
  suggestedAction?: string
  baselineRef?: string
  current?: string
}

/** 回查出处那次调用收到的内容：两条记忆的 id（按用户消息里出现的顺序）和整段用户消息。 */
export interface VerifyCall { ids: string[]; user: string }

/**
 * 五种发现用的模型桩，按系统提示词分出三种调用：回查出处（SOURCE_CHECK_SYSTEM_PROMPT）、跨项目比较（提示词里有「多个项目（workspace）」）、
 * 其余是内容检查的一批。内容检查照用户消息里的 `- id=` 认出这一批的记忆；回查的回复由 verify 给（缺省回 conflict），
 * 返回 Error 时这次调用抛错。所有调用的系统提示词、用户消息都记下来，用来查哪些文字发给了模型。
 */
export interface FindingModel extends SemanticLlm {
  findings: ReplyFinding[]
  verify: (call: VerifyCall) => string | Error
  crossReply: string
  batchCalls: string[][]
  verifyCalls: VerifyCall[]
  crossCalls: number
  /** 每次调用发出的用户消息（三种都算）。 */
  users: string[]
  /** 每次内容检查发出的系统提示词。 */
  batchSystems: string[]
}

export const verifyReply = (verdict: string, extra: { summary?: string; suggestedAction?: string; current?: string } = {}): string =>
  JSON.stringify({ verdict, summary: extra.summary ?? `回查后判为 ${verdict}`, suggestedAction: extra.suggestedAction ?? '处理', ...(extra.current !== undefined ? { current: extra.current } : {}) })

export function findingModel(init: { model?: string; findings?: ReplyFinding[] } = {}): FindingModel {
  const m: FindingModel = {
    provider: 'stub',
    model: init.model ?? 'model-a',
    findings: init.findings ?? [],
    verify: () => verifyReply('conflict'),
    crossReply: '{"duplicates":[]}',
    batchCalls: [],
    verifyCalls: [],
    crossCalls: 0,
    users: [],
    batchSystems: [],
    complete: async (input, signal) => {
      signal?.throwIfAborted()
      m.users.push(input.user)
      if (input.system === SOURCE_CHECK_SYSTEM_PROMPT) {
        const call = { ids: [...input.user.matchAll(/^- id=(\S+)/gm)].map(x => x[1]!), user: input.user }
        m.verifyCalls.push(call)
        const reply = m.verify(call)
        if (reply instanceof Error) throw reply
        return reply
      }
      if (input.system.includes('多个项目（workspace）')) {
        m.crossCalls++
        return m.crossReply
      }
      m.batchSystems.push(input.system)
      const ids = [...input.user.matchAll(/^- id=(\S+)/gm)].map(x => x[1]!)
      m.batchCalls.push(ids)
      const present = new Set(ids)
      return JSON.stringify({
        findings: m.findings.filter(f => f.ids.every(id => present.has(id))).map(f => ({
          type: f.type, memoryIds: f.ids, summary: f.summary ?? `${m.model} 查出的问题`, suggestedAction: f.suggestedAction ?? '处理',
          ...(f.baselineRef !== undefined ? { baselineRef: f.baselineRef } : {}),
          ...(f.current !== undefined ? { current: f.current } : {}),
        })),
      })
    },
  }
  return m
}

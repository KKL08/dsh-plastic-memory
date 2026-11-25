import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_GUIDANCE, EVIDENCE_GUIDANCE_WITH_QUOTES, MESSAGE_REF_GUIDANCE, evidenceGuidance, hasDialogueSource,
} from '../src/evidence-guidance.ts'
import { SEARCH_SOURCES } from '../src/contract-codes.ts'

const LEVELS = ['off', 'strict', 'active'] as const

describe('下钻引导随记忆带原话和检索来源切换', () => {
  it('来源含不含原话只看配置：dialogue 和 both 算含', () => {
    expect(hasDialogueSource('memory')).toBe(false)
    expect(hasDialogueSource('dialogue')).toBe(true)
    expect(hasDialogueSource('both')).toBe(true)
  })

  it('只查记忆且带原话关：三档和原来的文案完全一致', () => {
    for (const level of LEVELS) expect(evidenceGuidance(level, { memoryQuotes: false, searchSource: 'memory' })).toBe(EVIDENCE_GUIDANCE[level])
  })

  it('带原话关、来源含原话：原来的文案后面只多一句按引用看更多内容的说明', () => {
    for (const level of LEVELS) {
      for (const searchSource of ['dialogue', 'both'] as const) {
        expect(evidenceGuidance(level, { memoryQuotes: false, searchSource })).toBe(EVIDENCE_GUIDANCE[level] + MESSAGE_REF_GUIDANCE[level])
      }
    }
  })

  it('带原话开：换一套三档，先看结果里附带的原话，不够再用 memory_source 回查', () => {
    for (const level of LEVELS) {
      const text = EVIDENCE_GUIDANCE_WITH_QUOTES[level]
      expect(text).not.toBe(EVIDENCE_GUIDANCE[level])
      expect(text).toContain('memory_search 返回记忆条目时，排在前面的几条下面可能附有出处那一轮的原话')
      expect(text).toContain('附带的原话不够时')
      expect(text).toContain('memory_source 填记忆 id 回查')
      expect(text).not.toContain('推测出处')
      // 记忆下面附的原话也带消息引用：只查记忆时同样补引用那句
      for (const searchSource of SEARCH_SOURCES) expect(evidenceGuidance(level, { memoryQuotes: true, searchSource })).toBe(text + MESSAGE_REF_GUIDANCE[level])
    }
    expect(EVIDENCE_GUIDANCE_WITH_QUOTES.active).not.toContain('无关时，直接使用记忆')
    expect(EVIDENCE_GUIDANCE_WITH_QUOTES.strict).toContain('严重矛盾')
    expect(EVIDENCE_GUIDANCE_WITH_QUOTES.active).toContain('模型推断，未经确认')
    expect(EVIDENCE_GUIDANCE_WITH_QUOTES.off).not.toContain('矛盾')
  })

  it('各种组合各自自包含：不提别的档位，各自指得到回查工具，结果里会有消息引用时恰好一句引用说明', () => {
    const outputs = new Set<string>()
    for (const level of LEVELS) {
      for (const memoryQuotes of [false, true]) {
        for (const searchSource of SEARCH_SOURCES) {
          const text = evidenceGuidance(level, { memoryQuotes, searchSource })
          outputs.add(text)
          for (const other of LEVELS) if (other !== level) expect(text).not.toContain(other)
          for (const word of ['上一档', '同上', '前一段', '另一套', '上面这几种']) expect(text).not.toContain(word)
          expect(text).toContain('memory_source')
          expect(text.split('memory_source 带上这条消息的引用').length - 1).toBe(hasDialogueSource(searchSource) || memoryQuotes ? 1 : 0)
        }
      }
    }
    // 三档 ×（只查记忆且带原话关 / 来源含原话且带原话关 / 带原话开）：九种各不相同
    expect(outputs.size).toBe(9)
  })

  it('新写的文案用正向表述', () => {
    for (const level of LEVELS) {
      for (const text of [EVIDENCE_GUIDANCE_WITH_QUOTES[level], MESSAGE_REF_GUIDANCE[level]]) {
        for (const word of ['不要', '禁止', '不得']) expect(text).not.toContain(word)
      }
      expect(MESSAGE_REF_GUIDANCE[level]).toContain('节选')
      expect(MESSAGE_REF_GUIDANCE[level]).toContain('更多内容')
      expect(MESSAGE_REF_GUIDANCE[level]).toContain('截断提示')
      expect(MESSAGE_REF_GUIDANCE[level]).not.toContain('完整内容')
    }
    expect(MESSAGE_REF_GUIDANCE.strict).toContain('用户明确要求看原话')
  })
})

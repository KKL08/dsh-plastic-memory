import { describe, expect, it } from 'vitest'
import { computeHealth, noiseProgress } from '../src/governance/scoring.ts'
import type { Finding } from '../src/governance/schema.ts'

function finding(type: Finding['type'], layer: Finding['layer'] = 'rule'): Finding {
  return { type, layer, severity: 'info', memoryIds: ['mem_x'], summary: '', suggestedAction: '' }
}
const findings = (type: Finding['type'], n: number) => Array.from({ length: n }, () => finding(type))

describe('noiseProgress 双轴进度', () => {
  it('小库由条数轴按住：10 条库 1 条 → 1/3 进度', () => {
    expect(noiseProgress(1, 10)).toBeCloseTo(1 / 3)
  })
  it('大库由占比轴放宽：500 条库 1 条 → 2% 进度', () => {
    expect(noiseProgress(1, 500)).toBeCloseTo(0.02)
  })
  it('条数与占比双双达标才满格', () => {
    expect(noiseProgress(3, 10)).toBe(1)   // 3 条且 30%
    expect(noiseProgress(20, 200)).toBe(1) // 20 条且 10%
    expect(noiseProgress(5, 200)).toBeCloseTo(0.25) // 条数够但占比只 2.5%
  })
  it('total=0 时占比轴缺席，只按条数轴（空库的隔离区 malformed）', () => {
    expect(noiseProgress(2, 0)).toBeCloseTo(2 / 3)
  })
})

describe('computeHealth 三层结构', () => {
  const empty = { totalMemories: 0, ruleFindings: [], semanticFindings: [], freshnessRatios: [] }

  it('空库满分 green，gate 未触发', () => {
    const h = computeHealth(empty)
    expect(h.score).toBe(100)
    expect(h.tier).toBe('green')
    expect(h.gate.secret).toBe(false)
  })

  it('红线：secret 存在即判死——tier 强制 red、score 压进红区，高分不能稀释', () => {
    const h = computeHealth({ ...empty, totalMemories: 200, ruleFindings: [finding('secret')] })
    expect(h.gate.secret).toBe(true)
    expect(h.tier).toBe('red')
    expect(h.score).toBe(40) // 其余全干净 raw=100，仍被压到红区上限
  })

  it('重问题：conflict 计条 10/条封顶 30，与库大小无关', () => {
    const at = (n: number, total: number) =>
      computeHealth({ ...empty, totalMemories: total, semanticFindings: findings('conflict', n) })
    expect(at(1, 10).score).toBe(90)
    expect(at(1, 1000).score).toBe(90)  // 大库占比趋零也照扣
    expect(at(2, 50).score).toBe(80)
    expect(at(2, 50).tier).toBe('green') // 绿黄边缘
    expect(at(3, 50).score).toBe(70)
    expect(at(3, 50).tier).toBe('amber')
    expect(at(5, 50).score).toBe(70)     // 封顶 30
  })

  it('校准表：早期库单例噪音不吓人', () => {
    // 10 条库 1 冗余：6 × 1/3 = 2 分
    const h = computeHealth({ ...empty, totalMemories: 10, semanticFindings: findings('redundancy', 1) })
    expect(h.score).toBeCloseTo(98)
    expect(h.tier).toBe('green')
  })

  it('校准表：早期库真脏照样扣满', () => {
    // 10 条库：3 冗余(满格6) + 2 过期(6×2/3=4) + 3/10 超期(满格15) → 75 amber
    const h = computeHealth({
      totalMemories: 10,
      ruleFindings: findings('expired', 2),
      semanticFindings: findings('redundancy', 3),
      freshnessRatios: [1.5, 2.0, 1.2, 0.8, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    })
    expect(h.rulePenalty).toBeCloseTo(4)
    expect(h.semanticPenalty).toBeCloseTo(6)
    expect(h.freshness.penalty).toBeCloseTo(15)
    expect(h.score).toBeCloseTo(75)
    expect(h.tier).toBe('amber')
  })

  it('校准表：中后期库零星问题几乎不扰', () => {
    // 200 条：5 冗余(6×0.25=1.5) + 2 超期(15×0.1=1.5) → 97
    const h = computeHealth({
      totalMemories: 200,
      ruleFindings: [],
      semanticFindings: findings('redundancy', 5),
      freshnessRatios: [...Array.from({ length: 198 }, () => 0.3), 1.5, 2.0],
    })
    expect(h.score).toBeCloseTo(97)
    expect(h.tier).toBe('green')
  })

  it('校准表：中后期库单类高占比满格，多类并存才压黄', () => {
    // 200 条 20 冗余（10%）单类满格 → 94 仍绿
    const single = computeHealth({ ...empty, totalMemories: 200, semanticFindings: findings('redundancy', 20) })
    expect(single.score).toBeCloseTo(94)
    expect(single.tier).toBe('green')
    // 冗余/错位/模糊各 10% + 超期 10% → 6+6+6+15 = 33 → 67 黄
    const multi = computeHealth({
      totalMemories: 200,
      ruleFindings: [],
      semanticFindings: [...findings('redundancy', 20), ...findings('misplaced', 20), ...findings('unclear', 20)],
      freshnessRatios: [...Array.from({ length: 180 }, () => 0.3), ...Array.from({ length: 20 }, () => 1.5)],
    })
    expect(multi.score).toBeCloseTo(67)
    expect(multi.tier).toBe('amber')
  })

  it('新鲜度当第八类：一条超期很深的记忆不再单独打满', () => {
    // 100 条库 1 条超期 10 倍：进度 min(1, 1/3, 0.1)=0.1 → 1.5 分（旧公式会扣满 15）
    const h = computeHealth({
      ...empty, totalMemories: 100,
      freshnessRatios: [...Array.from({ length: 99 }, () => 0.2), 10],
    })
    expect(h.freshness.staleCount).toBe(1)
    expect(h.freshness.penalty).toBeCloseTo(1.5)
  })

  it('misplaced 分层：workspace 层 6、global 层 10（项目私货混进 global 在所有会话生效）', () => {
    const base = { ...empty, totalMemories: 10, semanticFindings: findings('misplaced', 3) }
    expect(computeHealth(base).semanticPenalty).toBeCloseTo(6)
    expect(computeHealth({ ...base, layer: 'global' }).semanticPenalty).toBeCloseTo(10)
  })

  it('expired 降为噪音档 6：validTo 过期已被注入/检索过滤，只占地方不误导', () => {
    const h = computeHealth({ ...empty, totalMemories: 10, ruleFindings: findings('expired', 3) })
    expect(h.rulePenalty).toBeCloseTo(6)
  })

  it('score 下限 0；无 secret 时 tier 按 80/50 分档', () => {
    const dirty = computeHealth({
      totalMemories: 10,
      ruleFindings: [...findings('expired', 3), ...findings('bloat', 3), ...findings('orphan', 3), ...findings('malformed', 3)],
      semanticFindings: [...findings('conflict', 5), ...findings('redundancy', 3), ...findings('misplaced', 3), ...findings('unclear', 3)],
      freshnessRatios: Array.from({ length: 10 }, () => 2),
    })
    // 噪音 7×6 + freshness 15 + conflict 30 = 87 → 13 red
    expect(dirty.score).toBeCloseTo(13)
    expect(dirty.tier).toBe('red')
  })
})

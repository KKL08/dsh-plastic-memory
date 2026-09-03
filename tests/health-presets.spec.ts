import { describe, expect, it } from 'vitest'
import { SENSITIVITY_PRESETS, resolveHealthThresholds } from '../src/governance/health-presets.ts'

describe('health sensitivity 预设', () => {
  it('三档阈值精确锚定（score 60/70/80，天数递减）', () => {
    expect(SENSITIVITY_PRESETS.conservative).toEqual({ actionScoreThreshold: 60, pendingOverdueDays: 14, scanStaleDays: 30 })
    expect(SENSITIVITY_PRESETS.normal).toEqual({ actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 })
    expect(SENSITIVITY_PRESETS.proactive).toEqual({ actionScoreThreshold: 80, pendingOverdueDays: 3, scanStaleDays: 3 })
  })

  it('resolveHealthThresholds 按档返回', () => {
    expect(resolveHealthThresholds('proactive').actionScoreThreshold).toBe(80)
  })
})

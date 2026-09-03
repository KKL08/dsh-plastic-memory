import { describe, expect, it } from 'vitest'
import { RETENTION_MS } from '../src/retention.ts'

// RETENTION_MS 是软删清扫窗口与快照保留窗口的单一来源，两者必须一致。
// 模块只导出这个常量，故守它的值与形态即可。
// 边缘案例（每条一个 it）：
// 1. 值恰为 14 天的毫秒数（1_209_600_000）——改 14 或改天毫秒都会失败。
// 2. 折算为整数天恰为 14——整除且商为 14。
// 3. 是正整数——毫秒比较（now - x >= RETENTION_MS）无小数误差。
const DAY = 86_400_000

describe('RETENTION_MS', () => {
  it('等于 14 天的毫秒数', () => {
    expect(RETENTION_MS).toBe(1_209_600_000)
  })

  it('折算为整数天恰为 14', () => {
    expect(RETENTION_MS % DAY).toBe(0)
    expect(RETENTION_MS / DAY).toBe(14)
  })

  it('是正整数', () => {
    expect(Number.isInteger(RETENTION_MS)).toBe(true)
    expect(RETENTION_MS).toBeGreaterThan(0)
  })
})

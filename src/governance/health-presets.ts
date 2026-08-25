/** health recommendation 触发的可调阈值。纯数值，供 health.ts 消费——它不认识"预设名"。 */
export interface HealthThresholds {
  /** 分数低于此 → recommendation 提示"存在待清理问题"。 */
  actionScoreThreshold: number
  /** 待裁决冲突挂起超此天数 → 提示裁决，并在 breakdown 标 overdue。 */
  pendingOverdueDays: number
  /** 语义扫描超此天数 → 提示重扫。 */
  scanStaleDays: number
}

export type HealthSensitivity = 'conservative' | 'normal' | 'proactive'

/** 三档预设。normal 为默认；secret 检出不受档位影响、永远提示（逻辑在 health.ts）。 */
export const SENSITIVITY_PRESETS: Record<HealthSensitivity, HealthThresholds> = {
  conservative: { actionScoreThreshold: 60, pendingOverdueDays: 14, scanStaleDays: 30 },
  normal: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
  proactive: { actionScoreThreshold: 80, pendingOverdueDays: 3, scanStaleDays: 3 },
}

export function resolveHealthThresholds(sensitivity: HealthSensitivity): HealthThresholds {
  return SENSITIVITY_PRESETS[sensitivity]
}

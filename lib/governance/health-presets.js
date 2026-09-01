/** 三档预设。normal 为默认；secret 检出不受档位影响、永远提示（逻辑在 health.ts）。 */
export const SENSITIVITY_PRESETS = {
    conservative: { actionScoreThreshold: 60, pendingOverdueDays: 14, scanStaleDays: 30 },
    normal: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
    proactive: { actionScoreThreshold: 80, pendingOverdueDays: 3, scanStaleDays: 3 },
};
export function resolveHealthThresholds(sensitivity) {
    return SENSITIVITY_PRESETS[sensitivity];
}

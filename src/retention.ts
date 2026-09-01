/**
 * 软删记录清扫窗口与快照保留窗口的单一来源（docs/p1-governance-health-design.md §6）。两者必须一致：快照恢复语义
 * 依赖被删记录仍落在保留窗口内，任一先过期都会让 memory_forget 的撤销落空。
 */
export const RETENTION_MS = 14 * 86_400_000

import type { MemoryRecord } from '../record-schema.ts'

/** 纯逻辑层的日志注入口：接线层（index.ts）传入 ctx.logger，缺省回退 console，
 *  保证测试与独立使用场景仍有输出。file-table.ts / forget.ts 复用此形状，保持三层注入风格一致。 */
export interface MemoryLogger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

/** 读写全部异步（PR1 先改签名，内核不动）。`list()` 是「全部记录」的过渡读法，PR2 换成按范围读取。 */
export interface MemoryTable {
  get(key: string): Promise<MemoryRecord | undefined>
  list(): Promise<MemoryRecord[]>
  put(key: string, value: MemoryRecord): Promise<void>
  update(key: string, fn: (current: MemoryRecord) => MemoryRecord): Promise<MemoryRecord>
  delete(key: string): Promise<boolean>
}

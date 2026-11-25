import { isLocked, type MemoryRecord } from '../record-schema.ts'

/** 记忆梦境写入时用的发起方名字（操作日志、最近一次内容改动里记的也是它）。 */
export const DREAMS_INITIATOR = 'dreams'

/**
 * 写入许可：这个发起方现在能不能改这条记忆。按写入段里刚读到的那一版判。规则表只有一条：记忆梦境不改锁定的记忆。
 * 返回 undefined 是许可。撤回、撤销不过它：它们只把自己写的字段改回去，不碰锁。
 */
export function writeGate(initiator: string, record: Pick<MemoryRecord, 'locked' | 'lockedUntil'>, now: number): 'locked' | undefined {
  return initiator === DREAMS_INITIATOR && isLocked(record, now) ? 'locked' : undefined
}

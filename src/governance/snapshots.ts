import { isDeepStrictEqual } from 'node:util'
import type { MemoryRecord } from '../record-schema.ts'
import type { KvTable } from '../kv-table.ts'
import { REDACTED_PLACEHOLDER, genId, type MemorySnapshot, type SnapshotRecord } from './schema.ts'
import { RETENTION_MS } from '../retention.ts'
import { secretFields } from '../secrets.ts'

/** 保留窗口：与软删清扫共用 retention.ts 的单一来源（两者必须一致）。 */
export const SNAPSHOT_RETENTION_MS = RETENTION_MS

export interface SnapshotDiffEntry {
  id: string
  snapshotted: SnapshotRecord
  current: MemoryRecord | undefined
  changedAfterSnapshot: boolean
}

/**
 * 恢复比较投影（docs/design-storage-file-is-memory.md §13）：判「快照后被修改」只比这些内容字段，
 * 不含时间戳、status、handEdited、位置与召回统计，也不读文件里的 digest——手改后立即恢复也能判出，
 * 没有 digest 的旧快照同样能比。正文 CRLF 归一为 LF（与 digest 一致，换行风格不算修改）。
 */
export function restoreProjection(r: MemoryRecord) {
  return {
    name: r.name, type: r.type, tags: r.tags, summary: r.summary,
    content: r.content.replace(/\r\n/g, '\n'),
    validFrom: r.validFrom, validTo: r.validTo, confidence: r.confidence, supersedes: r.supersedes,
    source: r.source && { sessionId: r.source.sessionId, eventRange: r.source.eventRange, sourceMode: r.source.sourceMode },
  }
}

/**
 * 当前记录与快照记录的投影不同才算冲突。软删除不是"更新的编辑"，它正是要撤销的对象；
 * 把它算作冲突会让 memory_forget 的撤销默认失效，因此当前记录若已是 status: 'deleted' 不计入冲突。
 */
function isConflicting(current: MemoryRecord | undefined, snapshotted: MemoryRecord): boolean {
  return current !== undefined && current.status !== 'deleted'
    && !isDeepStrictEqual(restoreProjection(current), restoreProjection(snapshotted))
}

/**
 * 密钥硬删的快照脱敏（docs/design-storage-file-is-memory.md §10）：命中密钥的字段换成占位文本，打 redacted 标记，
 * 其余字段原样。按这份记录自己的内容检测——旧版本可能还没贴密钥，那就只打标记（记忆已物理删除，不再可恢复）。
 */
export function redactRecord(r: SnapshotRecord): SnapshotRecord {
  const next: SnapshotRecord = { ...r, redacted: true }
  for (const field of secretFields(r)) {
    if (field === 'tags') next.tags = [REDACTED_PLACEHOLDER]
    else next[field] = REDACTED_PLACEHOLDER
  }
  return next
}

/**
 * 记忆快照（docs/p1-governance-health-design.md §6）：只管记忆数据的可恢复性，操作审计走 dsh session log。
 * 只存受影响记录，非全量。
 */
export class SnapshotStore {
  private table: KvTable<MemorySnapshot>
  /** redact 是整快照的读改写，进程内串行，否则两次并发脱敏会把对方的明文写回。 */
  private redactChain: Promise<void> = Promise.resolve()

  constructor(table: KvTable<MemorySnapshot>) {
    this.table = table
  }

  async capture(
    input: { operation: MemorySnapshot['operation']; description: string; records: SnapshotRecord[] },
    now: number,
  ): Promise<MemorySnapshot> {
    const snapshot: MemorySnapshot = {
      id: genId('snap'),
      createdAt: now,
      operation: input.operation,
      description: input.description,
      memoryIds: input.records.map(r => r.id),
      data: input.records,
    }
    await this.table.put(snapshot.id, snapshot)
    await this.sweep(now)  // 顺手清理超窗口的旧快照
    return snapshot
  }

  /** 清扫超保留窗口的旧快照。capture 内复用，工具入口也调用——否则停用 forget/promote 后
   * 旧快照会永留侧表。 */
  async sweep(now: number): Promise<void> {
    const cutoff = now - SNAPSHOT_RETENTION_MS
    for (const [key, snap] of await this.table.list()) {
      if (snap.createdAt < cutoff) await this.table.delete(key)
    }
  }

  async list(): Promise<MemorySnapshot[]> {
    return (await this.table.list()).map(([, s]) => s).sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Promise<MemorySnapshot | undefined> {
    return this.table.get(id)
  }

  /**
   * 密钥硬删（ARCHITECTURE.md ⑥-6c）：所有含这些 id 的快照里把该记录脱敏（redactRecord），同快照的其他记录不动。
   * 每个快照经侧表 put 原子重写（tmp + rename）；内容没变的（不含这些 id、或已脱敏过）不写。
   */
  redact(ids: ReadonlySet<string>): Promise<void> {
    const run = this.redactChain.then(() => this.redactNow(ids))
    this.redactChain = run.catch(() => {})
    return run
  }

  private async redactNow(ids: ReadonlySet<string>): Promise<void> {
    for (const [, snap] of await this.table.list()) {
      let changed = false
      const data = snap.data.map(r => {
        if (!ids.has(r.id)) return r
        const next = redactRecord(r)
        if (!isDeepStrictEqual(next, r)) changed = true
        return next
      })
      if (changed) await this.table.put(snap.id, { ...snap, data })
    }
  }

  /** current：调用方预读的现状（至少含快照内各 id，含非 active），缺键视为当前不存在。 */
  diff(snapshot: MemorySnapshot, current: ReadonlyMap<string, MemoryRecord>): SnapshotDiffEntry[] {
    return snapshot.data.map(snapshotted => {
      const present = current.get(snapshotted.id)
      return {
        id: snapshotted.id,
        snapshotted,
        current: present,
        changedAfterSnapshot: isConflicting(present, snapshotted),
      }
    })
  }

  /**
   * 选择性恢复：ids 为 undefined 恢复全部。快照后被修改过的记录默认跳过（冲突保护），
   * overwriteChanged=true 才覆盖。脱敏记录（密钥硬删）一律跳过，计入 skipped 并单列在 redacted。
   * 恢复动作本身只 put 旧数据，不做二次快照。current：调用方预读的现状（同 diff）。
   */
  async restore(
    snapshot: MemorySnapshot,
    ids: string[] | undefined,
    put: (record: MemoryRecord) => Promise<void>,
    current: ReadonlyMap<string, MemoryRecord>,
    overwriteChanged: boolean,
  ): Promise<{ restored: string[]; skipped: string[]; redacted: string[] }> {
    const restored: string[] = []
    const skipped: string[] = []
    const redacted: string[] = []
    const targets = ids ? snapshot.data.filter(r => ids.includes(r.id)) : snapshot.data
    for (const rec of targets) {
      if (rec.redacted) {
        skipped.push(rec.id)
        redacted.push(rec.id)
        continue
      }
      if (isConflicting(current.get(rec.id), rec) && !overwriteChanged) {
        skipped.push(rec.id)
        continue
      }
      await put(rec)
      restored.push(rec.id)
    }
    return { restored, skipped, redacted }
  }
}

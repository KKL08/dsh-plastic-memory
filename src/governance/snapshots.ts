import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MemoryRecord } from '../record-schema.ts'
import type { KvTable } from '../kv-table.ts'
import { REDACTED_PLACEHOLDER, genId, type MemorySnapshot, type SnapshotRecord } from './schema.ts'
import { RETENTION_MS } from '../retention.ts'
import { maskSecrets, secretFields } from '../secrets.ts'

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

/** 恢复比较投影的指纹：直接改写完后记下它，撤销前比一下，就知道之后有没有被别处改过。 */
export function editFingerprint(r: MemoryRecord): string {
  return createHash('sha1').update(JSON.stringify(restoreProjection(r))).digest('hex')
}

/**
 * 当前记录与快照记录的投影不同才算冲突。软删除不是"更新的编辑"，它正是要撤销的对象；
 * 把它算作冲突会让 memory_forget 的撤销默认失效，因此当前记录若已是 status: 'deleted' 不计入冲突。
 */
export function isConflicting(current: MemoryRecord | undefined, snapshotted: MemoryRecord): boolean {
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

/** 快照说明可能是 agent 写的原文（forget 的原因、手动快照的说明）：落盘前两级密钥都遮。 */
const maskDescription = (text: string) => maskSecrets(text, { severity: 'suspected' })

/**
 * 记忆快照（docs/p1-governance-health-design.md §6）：只管记忆数据的可恢复性，操作审计走 dsh session log。
 * 只存受影响记录，非全量。
 */
export class SnapshotStore {
  private table: KvTable<MemorySnapshot>
  /** redact / purge 是整快照的读改写，进程内串行，否则两次并发改写会把对方抹掉的内容写回。 */
  private rewriteChain: Promise<void> = Promise.resolve()

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
      description: maskDescription(input.description),
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
    return this.serialize(() => this.redactNow(ids))
  }

  /**
   * 彻底删除最近删除里的记忆（GUI 的 hard-delete）：所有快照里去掉命中的记录，快照因此空了就整份删掉。
   * 之后按快照恢复、撤销都找不到它。
   */
  purge(isPurged: (r: SnapshotRecord) => boolean): Promise<void> {
    return this.serialize(async () => {
      for (const [key, snap] of await this.table.list()) {
        const data = snap.data.filter(r => !isPurged(r))
        if (data.length === snap.data.length) continue
        if (data.length === 0) await this.table.delete(key)
        else await this.table.put(key, { ...snap, memoryIds: data.map(r => r.id), data })
      }
    })
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const run = this.rewriteChain.then(task)
    this.rewriteChain = run.catch(() => {})
    return run
  }

  private async redactNow(ids: ReadonlySet<string>): Promise<void> {
    for (const [, snap] of await this.table.list()) {
      if (!snap.data.some(r => ids.has(r.id))) continue
      const data = snap.data.map(r => (ids.has(r.id) ? redactRecord(r) : r))
      // 说明一并遮：早先的快照落盘时还没遮过
      const description = maskDescription(snap.description)
      if (description !== snap.description || !isDeepStrictEqual(data, snap.data)) await this.table.put(snap.id, { ...snap, description, data })
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
   * overwriteChanged=true 才覆盖；给函数时只覆盖它认可的现状（直接改的撤销：现状就是那次写下的内容）。脱敏记录（密钥硬删）一律跳过，计入 skipped 并单列在 redacted。
   * 恢复动作本身只 put 旧数据，不做二次快照。current：调用方预读的现状（同 diff）。
   * 预读之后记录仍可能被别处改动：不覆盖时把冲突判定交给 put 的 skipIf，在写入那一刻按最新内容再判一次；
   * put 返回 false 即按「快照后被修改」跳过。返回 void 的 put 视为已写入。
   * 密钥硬删先脱敏快照、再删文件（tools/forget.ts），可能发生在别的会话、别的进程，也可能在调用方读出快照之后：
   * 写入前按盘上的这份快照现读一次，已脱敏（或快照已清扫）的不写；全部写完再读一次，仍未脱敏说明对方删文件在后，
   * 会连这份一起删掉，读到已脱敏的就用 discard 删掉刚写的那份，同样计入 redacted；条目已从快照里清掉的（最近删除里的彻底删除）
   * 也 discard，计入 skipped。中途某条写入抛错时，已写入的照样复核完再抛。盘上快照只读这两次，条数多也不逐条重读。
   */
  async restore(
    snapshot: MemorySnapshot,
    ids: string[] | undefined,
    put: (record: MemoryRecord, skipIf?: (current: MemoryRecord) => boolean) => Promise<boolean | void>,
    current: ReadonlyMap<string, MemoryRecord>,
    overwriteChanged: boolean | ((current: MemoryRecord) => boolean),
    discard: (record: MemoryRecord) => Promise<unknown>,
  ): Promise<{ restored: string[]; skipped: string[]; redacted: string[] }> {
    const targets = ids ? snapshot.data.filter(r => ids.includes(r.id)) : snapshot.data
    const blocks = (cur: MemoryRecord | undefined, rec: MemoryRecord) =>
      isConflicting(cur, rec) && !(typeof overwriteChanged === 'function' ? overwriteChanged(cur!) : overwriteChanged)
    const outcomes: Array<'restored' | 'skipped' | 'redacted'> = []
    const onDisk = async () => new Map((await this.table.get(snapshot.id))?.data.map(r => [r.id, r]))
    const before = await onDisk()
    try {
      for (const rec of targets) {
        const latest = rec.redacted ? rec : before.get(rec.id)
        if (latest?.redacted) outcomes.push('redacted')
        else if (latest === undefined || blocks(current.get(rec.id), rec)) outcomes.push('skipped')
        else outcomes.push((await put(rec, overwriteChanged === true ? undefined : cur => blocks(cur, rec))) === false ? 'skipped' : 'restored')
      }
    } finally {
      // 后面某条写入抛错也要跑：前面已写回的可能正赶上别处的密钥硬删
      if (outcomes.includes('restored')) {
        const after = await onDisk()
        for (const [i, rec] of targets.entries()) {
          // 开头还在、收尾不在了：恢复途中被彻底删除（快照条目先清、文件后删），刚写回的同样撤回
          const settled = after.get(rec.id)
          if (outcomes[i] !== 'restored' || (settled !== undefined && settled.redacted !== true)) continue
          await discard(rec)
          outcomes[i] = settled === undefined ? 'skipped' : 'redacted'
        }
      }
    }
    const idsWhere = (keep: (outcome: (typeof outcomes)[number]) => boolean) => targets.filter((_, i) => keep(outcomes[i]!)).map(r => r.id)
    return { restored: idsWhere(o => o === 'restored'), skipped: idsWhere(o => o !== 'restored'), redacted: idsWhere(o => o === 'redacted') }
  }
}

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MemoryRecord } from '../record-schema.ts'
import type { KvTable } from '../kv-table.ts'
import { REDACTED_PLACEHOLDER, genId, type MemorySnapshot, type SnapshotRecord } from './schema.ts'
import { RETENTION_MS } from '../retention.ts'
import { maskSecrets, secretFields } from '../secrets.ts'
import { roundValidity } from '../validity.ts'
import { scopeAt } from '../scope.ts'
import type { MemoryStore } from '../store.ts'

/** 保留窗口：与软删清扫共用 retention.ts 的单一来源（两者必须一致）。 */
export const SNAPSHOT_RETENTION_MS = RETENTION_MS

export interface RestoreOptions {
  target: 'exact' | 'hint'
  /** 给函数时对锁内现状求值（定位不到时传 undefined），为真才写。 */
  overwrite: boolean | ((current: MemoryRecord | undefined) => boolean)
  now?: () => number
}

export interface SnapshotDiffEntry {
  id: string
  snapshotted: SnapshotRecord
  current: MemoryRecord | undefined
  changedAfterSnapshot: boolean
}

/**
 * 恢复比较投影：判「快照后被修改」只比这些内容字段，
 * 不含时间戳、status、handEdited、位置与召回统计，也不读文件里的 digest——手改后立即恢复也能判出，
 * 没有 digest 的旧快照同样能比。正文 CRLF 归一为 LF（与 digest 一致，换行风格不算修改）。
 */
export function restoreProjection(r: MemoryRecord) {
  return {
    name: r.name, type: r.type, tags: r.tags, summary: r.summary,
    content: r.content.replace(/\r\n/g, '\n'),
    // 有效期按文件里的分钟比：旧版本快照里不在整分钟上的毫秒，和转换后的文件读出来的值视为相同
    validFrom: r.validFrom === undefined ? undefined : roundValidity('validFrom', r.validFrom),
    validTo: r.validTo === undefined ? undefined : roundValidity('validTo', r.validTo),
    confidence: r.confidence, supersedes: r.supersedes,
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
 * 密钥硬删的快照脱敏（含密钥的记忆被遗忘后，快照里也不能留明文）：命中密钥的字段换成占位文本，打 redacted 标记，
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
 * 记忆快照：只管记忆数据的可恢复性，操作审计走 dsh session log。
 * 只存受影响记录，非全量。
 */
export interface SnapshotStoreOptions {
  /**
   * 给定记录里此刻已不在盘上（被彻底删除）的那些。给了它，capture 落盘后复核（见 capture）；
   * 接线层传 goneCopies(store)，测试里不关心并发的可以不给。
   */
  findGone?: (records: readonly SnapshotRecord[]) => Promise<ReadonlySet<SnapshotRecord>>
}

export class SnapshotStore {
  private table: KvTable<MemorySnapshot>
  private findGone: SnapshotStoreOptions['findGone']
  /** redact / purge / 落盘复核是整快照的读改写，进程内串行，否则两次并发改写会把对方抹掉的内容写回。 */
  private rewriteChain: Promise<void> = Promise.resolve()

  constructor(table: KvTable<MemorySnapshot>, options: SnapshotStoreOptions = {}) {
    this.table = table
    this.findGone = options.findGone
  }

  /**
   * 拍快照。记录是调用方先前读的：读完到落盘之间，别的会话、进程可能彻底删除了其中一条，它先脱敏盘上所有快照、再删文件，
   * 扫的时候这份还没落盘。所以落盘后按 findGone 复核，已经不在的在这份里脱敏（redactRecord）。
   * 对方扫在这份落盘之前、删文件又在这边复核之后的，由彻底删除那一方删完再扫一遍兜住（tools/forget.ts）。
   */
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
    const findGone = this.findGone
    if (findGone !== undefined) await this.serialize(() => this.redactGoneNow(snapshot.id, findGone))
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
   * 密钥硬删：所有含这些 id 的快照里把该记录脱敏（redactRecord），同快照的其他记录不动。
   * isCopy：只删了一层的那份时只认那一层的副本，别层同 id 副本的快照不动；缺省不分层。
   * 每个快照经侧表 put 原子重写（tmp + rename）；内容没变的（不含这些 id、或已脱敏过）不写。
   */
  redact(ids: ReadonlySet<string>, isCopy: (r: SnapshotRecord) => boolean = () => true): Promise<void> {
    return this.serialize(() => this.redactNow(r => ids.has(r.id) && isCopy(r)))
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

  /**
   * 读盘上这份快照，已不在盘上的记录脱敏后写回；没有要脱敏的不写。写回的是复核前读到的那份：复核期间别的进程彻底删除了其中
   * 另一条、已把它在盘上脱敏，会被这次写回盖成明文，所以写回后重读再查，直到没有新的要脱敏。
   */
  private async redactGoneNow(id: string, findGone: NonNullable<SnapshotStoreOptions['findGone']>): Promise<void> {
    for (;;) {
      const snap = await this.table.get(id)
      if (snap === undefined) return
      const gone = await findGone(snap.data.filter(r => r.redacted !== true))
      if (gone.size === 0) return
      await this.table.put(id, { ...snap, data: snap.data.map(r => (gone.has(r) ? redactRecord(r) : r)) })
    }
  }

  private async redactNow(isHit: (r: SnapshotRecord) => boolean): Promise<void> {
    for (const [, snap] of await this.table.list()) {
      if (!snap.data.some(isHit)) continue
      const data = snap.data.map(r => (isHit(r) ? redactRecord(r) : r))
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
   * 选择性恢复，写回与撤回都在这里做：ids 为 undefined 恢复全部。快照后被修改过的记录默认跳过（冲突保护），
   * overwrite=true 才覆盖；给函数时只写它认可的现状（撤销：现状就是那次写下的内容），已删除的、定位不到的也不例外，
   * 否则之后被别处删掉的会被盖回在用、被搬走的会在原处重建旧版。冲突在写入那一刻按锁内最新内容判（put 的 skipIf），判中即按「快照后被修改」跳过。
   * target：'exact' 写回快照里这条记录自己的作用域；'hint' 按它的 workspacePath 提示定位（当前项目优先），留给 agent 工具。
   * 脱敏记录（密钥硬删）一律跳过，计入 skipped 并单列在 redacted。恢复动作本身只写旧数据，不做二次快照。
   * 密钥硬删先脱敏快照、再删文件（tools/forget.ts），可能发生在别的会话、别的进程，也可能在调用方读出快照之后：
   * 写入前按盘上的这份快照现读一次，已脱敏（或快照已清扫）的不写；全部写完再读一次，仍未脱敏说明对方删文件在后，
   * 会连这份一起删掉，读到已脱敏的就撤回刚写的那份，同样计入 redacted；条目已从快照里清掉的（最近删除里的彻底删除）
   * 也撤回，计入 skipped。撤回只删仍是刚写回那一版的：写回之后被改过的不是这次写的，留着、照样算恢复。
   * 中途某条写入抛错时，已写入的照样复核完再抛。盘上快照只读这两次，条数多也不逐条重读。
   * 收尾时整份快照都不在了：已过保留窗口的是被清扫掉的，刚写回的留着；还在窗口内的只可能是彻底删除抹空后整份删掉，照样撤回。
   * now 在收尾读完快照之后取，别处清扫用的时刻不会比它晚。
   */
  async restore(
    snapshot: MemorySnapshot,
    ids: string[] | undefined,
    store: Pick<MemoryStore, 'put' | 'hardDelete'>,
    { target, overwrite, now = Date.now }: RestoreOptions,
  ): Promise<{ restored: string[]; skipped: string[]; redacted: string[] }> {
    const targets = ids ? snapshot.data.filter(r => ids.includes(r.id)) : snapshot.data
    const blocks = (cur: MemoryRecord | undefined, rec: MemoryRecord) => (typeof overwrite === 'function'
      ? !overwrite(cur)
      : !overwrite && isConflicting(cur, rec))
    const outcomes: Array<'restored' | 'skipped' | 'redacted'> = []
    const written = new Map<number, MemoryRecord>()
    const onDisk = async () => {
      const snap = await this.table.get(snapshot.id)
      return snap === undefined ? undefined : new Map(snap.data.map(r => [r.id, r]))
    }
    const before = await onDisk() ?? new Map<string, SnapshotRecord>()
    try {
      for (const [i, rec] of targets.entries()) {
        const latest = rec.redacted ? rec : before.get(rec.id)
        if (latest?.redacted) { outcomes.push('redacted'); continue }
        const put = latest === undefined ? undefined
          : await store.put(rec, target === 'exact' ? scopeAt(rec.workspacePath) : { workspacePath: rec.workspacePath },
            overwrite === true ? undefined : cur => blocks(cur, rec))
        if (put !== undefined) written.set(i, put)
        outcomes.push(put === undefined ? 'skipped' : 'restored')
      }
    } finally {
      // 后面某条写入抛错也要跑：前面已写回的可能正赶上别处的密钥硬删
      const after = written.size > 0 ? await onDisk() : undefined
      // 整份快照过期被清扫：不是彻底删除，刚写回的都留着
      if (written.size > 0 && !(after === undefined && snapshot.createdAt < now() - SNAPSHOT_RETENTION_MS)) {
        for (const [i, put] of written) {
          // 开头还在、收尾不在了：恢复途中被彻底删除（快照条目先清、文件后删），刚写回的同样撤回
          const settled = after?.get(put.id)
          if (settled !== undefined && settled.redacted !== true) continue
          // 已被对方删掉的照样按撤回计；写回之后被改过的不是这次写的，留着
          const fingerprint = editFingerprint(put)
          let isChanged = false
          await store.hardDelete(put, { at: scopeAt(put.workspacePath) }, cur => (isChanged = editFingerprint(cur) !== fingerprint))
          if (isChanged) continue
          outcomes[i] = settled === undefined ? 'skipped' : 'redacted'
        }
      }
    }
    const idsWhere = (keep: (outcome: (typeof outcomes)[number]) => boolean) => targets.filter((_, i) => keep(outcomes[i]!)).map(r => r.id)
    return { restored: idsWhere(o => o === 'restored'), skipped: idsWhere(o => o !== 'restored'), redacted: idsWhere(o => o === 'redacted') }
  }
}

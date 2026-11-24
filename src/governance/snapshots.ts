import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { MemoryRecord } from '../record-schema.ts'
import type { CasKvTable } from '../kv-table.ts'
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
 * 不含时间戳、status、位置与召回统计，也不读文件里的 digest——手改后立即恢复也能判出，
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
    // 用户或模型会改的新键：手改之后恢复不能悄悄盖掉。缺省值不进 JSON，没有这些键的记录指纹不变
    factTime: r.factTime, related: r.related,
    premises: sortKeys(r.premises), recall: sortKeys(r.recall), locked: sortKeys(r.locked), lockedUntil: sortKeys(r.lockedUntil),
  }
}

/**
 * 开放取值里的对象按键名排序：手改只换了键的顺序时，深比较和指纹（JSON 文本）一样都视为没改。
 * 只用在新键上，旧字段照原样，账本里存过的指纹不受影响。
 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v === null || typeof v !== 'object') return v
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])]))
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

/** 现状与快照里这条除召回统计外完全相同（位置、状态、时间戳都算）：恢复写回也不会改动它。 */
function isSameRecord(current: MemoryRecord | undefined, snapshotted: SnapshotRecord): boolean {
  if (current === undefined) return false
  const stable = ({ recallCount: _count, lastRecalledAt: _at, ...rest }: MemoryRecord) => rest
  return isDeepStrictEqual(stable(current), stable(snapshotted))
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

/** 强制覆盖式恢复记在「最近一次内容改动」和操作日志里的发起方。 */
const RESTORE_INITIATOR = 'snapshot-restore'

/** 快照说明可能是 agent 写的原文（forget 的原因、手动快照的说明）：落盘前两级密钥都遮。 */
const maskDescription = (text: string) => maskSecrets(text, { severity: 'suspected' })

/** 快照里一条记录的身份：id 加所在作用域。同一份快照里可能有同 id 的几个副本（不同层），按身份才分得开。 */
const recordIdentity = (r: SnapshotRecord) => JSON.stringify([r.id, r.scope, r.workspacePath ?? null])

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
  private table: CasKvTable<MemorySnapshot>
  private findGone: SnapshotStoreOptions['findGone']

  constructor(table: CasKvTable<MemorySnapshot>, options: SnapshotStoreOptions = {}) {
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
    if (findGone !== undefined) await this.redactGoneNow(snapshot.id, findGone)
    // 不在这里清过期快照：每次写入都扫一遍快照表，开销随快照数增长。清扫在快照冻结时分批做，快照工具和撤销的入口也各清一遍
    return snapshot
  }

  /** 清扫超保留窗口的旧快照。快照冻结时分批调用（给 limit，一次最多清这么多条，剩下的下次再清），快照工具和撤销的入口整份清。
   *  过期没清掉的快照不会被拿来恢复：快照工具和撤销在读之前先整份清一遍，恢复时还按保留窗口再判一次。 */
  async sweep(now: number, limit = Infinity): Promise<void> {
    const cutoff = now - SNAPSHOT_RETENTION_MS
    let swept = 0
    for (const [key, snap] of await this.table.list()) {
      if (snap.createdAt >= cutoff) continue
      if (swept++ >= limit) return
      await this.table.delete(key)
    }
  }

  /** 这份快照对应的那次写入已经原样撤回、不会再有人按它恢复：删掉，不留到保留窗口结束。 */
  async discard(id: string): Promise<void> {
    await this.table.delete(id)
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
   * 每个快照在表的写锁内重读再改（update）：按此刻的内容判、脱敏，别处刚脱敏的不会被盖回明文、刚清除的不会被写回来；
   * 内容没变的（不含这些 id、或已脱敏过）不写。
   */
  redact(ids: ReadonlySet<string>, isCopy: (r: SnapshotRecord) => boolean = () => true): Promise<void> {
    return this.redactNow(r => ids.has(r.id) && isCopy(r))
  }

  /**
   * 彻底删除最近删除里的记忆（GUI 的 hard-delete）：所有快照里去掉命中的记录，快照因此空了就整份删掉。
   * 之后按快照恢复、撤销都找不到它。每个快照同 redact 在写锁内重读再改；抹空了再删，删前在锁内确认此刻仍是空的。
   */
  async purge(isPurged: (r: SnapshotRecord) => boolean): Promise<void> {
    for (const [key, snap] of await this.table.list()) {
      if (!snap.data.some(isPurged)) continue
      let isEmptied = false
      await this.table.update(key, cur => {
        if (cur === undefined) return undefined
        const data = cur.data.filter(r => !isPurged(r))
        if (data.length === cur.data.length) return undefined
        isEmptied = data.length === 0
        return { ...cur, memoryIds: data.map(r => r.id), data }
      })
      if (isEmptied) await this.table.deleteIf(key, cur => cur.data.length === 0)
    }
  }

  /**
   * 读盘上这份快照，锁外查出已不在盘上的记录，再在写锁内重读、按记录身份把它们脱敏（update）；没有要脱敏的不写。
   * 写回后重读再查，直到没有新的要脱敏：写锁不可用时条件写只在本实例内原子，别的进程在这次重读之后脱敏、清除的条目
   * 仍可能被写回盖掉，重读能把它补上。
   */
  private async redactGoneNow(id: string, findGone: NonNullable<SnapshotStoreOptions['findGone']>): Promise<void> {
    for (;;) {
      const snap = await this.table.get(id)
      if (snap === undefined) return
      const gone = await findGone(snap.data.filter(r => r.redacted !== true))
      if (gone.size === 0) return
      const goneIds = new Set([...gone].map(recordIdentity))
      const isGone = (r: SnapshotRecord) => r.redacted !== true && goneIds.has(recordIdentity(r))
      await this.table.update(id, cur => (cur?.data.some(isGone) ? { ...cur, data: cur.data.map(r => (isGone(r) ? redactRecord(r) : r)) } : undefined))
    }
  }

  private async redactNow(isHit: (r: SnapshotRecord) => boolean): Promise<void> {
    for (const [key, snap] of await this.table.list()) {
      if (!snap.data.some(isHit)) continue
      await this.table.update(key, cur => {
        if (cur === undefined) return undefined
        const data = cur.data.map(r => (isHit(r) ? redactRecord(r) : r))
        // 说明一并遮：早先的快照落盘时还没遮过
        const description = maskDescription(cur.description)
        return description !== cur.description || !isDeepStrictEqual(data, cur.data) ? { ...cur, description, data } : undefined
      })
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
   * overwrite=true 才覆盖（覆盖掉改过的那一版算现在的一次内容改动，见写入处）；给函数时只写它认可的现状（撤销：现状就是那次写下的内容），已删除的、定位不到的也不例外，
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
    store: Pick<MemoryStore, 'get' | 'put' | 'newOp' | 'finishOp' | 'hardDelete' | 'writeSection'>,
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
    // 版本标记先取后读：读之前就变了的，下面比对时照样重读
    let seen = { revision: await this.table.revision?.(snapshot.id), records: await onDisk() }
    /**
     * 快照此刻的内容：版本标记没变就用上次读到的，变了（或表不支持版本标记）才整份重读，不按条数成倍地读。
     * 整份已不在为 undefined：可能是彻底删除把它清空删掉了，也可能是过期被清扫，两者分不出来，所以还没写回的都跳过，
     * 不按之前读到的写回（写回会清掉全局同 id 的副本，删掉的密钥也会回来）。
     */
    const current = async () => {
      const revision = await this.table.revision?.(snapshot.id)
      if (revision !== undefined && revision === seen.revision) return seen.records
      seen = { revision, records: await onDisk() }
      return seen.records
    }
    try {
      for (const [i, rec] of targets.entries()) {
        // 一条一段：快照里这一条的现状在写入段里再确认一次，确认到写回之间别的写入插不进来。开头那次读到的可能已过时：
        // 密钥硬删先脱敏快照、再删文件，夹在中间的话照旧写回，写入还会顺带清掉全局的同 id 副本，收尾撤回后两份都没了
        outcomes.push(await store.writeSection(async () => {
          const latest = rec.redacted ? rec : (await current())?.get(rec.id)
          if (latest?.redacted) return 'redacted'
          // 现状已和快照里这条完全相同：不写，也不进撤回名单。撤回删的是「刚写回的那一版」，这时删掉的其实是原来那份，
          // 正在删它的那次密钥硬删随后找不到它，回报删了 0 条、待决账本也清不到
          let isAlreadyThere = false
          const from = target === 'exact' ? scopeAt(rec.workspacePath) : { workspacePath: rec.workspacePath }
          // 强制覆盖一条快照之后又被改过、还在用的记录：内容取快照的，但这是现在发生的一次内容改动，状态起点和最近一次内容改动
          // 连同修改时间按现在记，不拿快照里那几项盖回去（那样时间线上这一版会比被它盖掉的版本还早）。其余情况（现状就是要撤的那次写入、
          // 已删除、已不在）回到快照里的值
          const seen = overwrite === true && latest !== undefined ? await store.get(rec.id, from) : undefined
          const op = isConflicting(seen, rec) ? store.newOp({ initiator: RESTORE_INITIATOR }) : undefined
          const at = now()
          const next = op === undefined ? rec : { ...rec, updatedAt: at, stateSince: at, lastChange: { kind: 'correct', at, op: op.id, by: RESTORE_INITIATOR } }
          const put = latest === undefined ? undefined
            : await store.put(next, from, cur => {
              isAlreadyThere = false
              if (overwrite !== true && blocks(cur, rec)) return true
              isAlreadyThere = isSameRecord(cur, rec)
              return isAlreadyThere
            }, op)
          if (op !== undefined && put !== undefined) await store.finishOp(op, put)
          if (put !== undefined) written.set(i, put)
          return put === undefined && !isAlreadyThere ? 'skipped' : 'restored'
        }))
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

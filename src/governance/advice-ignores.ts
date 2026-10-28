import { createHash } from 'node:crypto'
import type { CasKvTable } from '../kv-table.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { IGNORABLE_ADVICE_TYPES, type IgnorableAdviceType } from '../contract-codes.ts'
import type { AdviceIgnore, Finding, FindingType } from './schema.ts'

/**
 * 建议忽略：用户对一条建议整理项点了「忽略」，以后不再提示、也不再扣分。记录存在单独的侧表（不进待决账本：
 * 旧版本插件的账本 schema 不认识新种类，会把它当读不出的条目；单独存放时旧版本完全看不见它）。
 * 一项 = 问题类型 + 涉及的记忆 id（内容重复成对，其余每条记忆一项），记下每条记忆当时的指纹（adviceFingerprint）；
 * 指纹对不上就不算已忽略，问题还在就重新出现。评分前按它剔除发现（applyIgnores），评分公式不动。
 */

/**
 * 忽略用的记忆指纹：各类建议依据的字段都算进去（名称、摘要、正文、有效期、所在层、取代的旧记忆），一个函数管所有类型；
 * 标签、确认时间不算——它们不影响任何一类建议，改了不该让用户再看一遍。
 */
export function adviceFingerprint(r: Pick<MemoryRecord, 'id' | 'name' | 'summary' | 'content' | 'validTo' | 'scope' | 'workspacePath' | 'supersedes'>): string {
  const fields = [r.id, r.name, r.summary, r.content, r.validTo ?? null, r.scope, r.workspacePath ?? null, r.supersedes ?? []]
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex')
}

/** 能忽略的都是体检发现的类型（这里按 FindingType 收一次，名字有出入编译不过；名字本身只在 contract-codes 定义）。 */
const IGNORABLE_FINDING_TYPES: readonly FindingType[] = IGNORABLE_ADVICE_TYPES

export function isIgnorableType(type: string): type is IgnorableAdviceType {
  return (IGNORABLE_FINDING_TYPES as readonly string[]).includes(type)
}

/** 一项建议的身份：类型 + 排序后的记忆 id。也是忽略记录的 id。 */
export function adviceIdentity(type: string, memoryIds: readonly string[]): string {
  return `${type}:${[...memoryIds].sort().join(',')}`
}

/** 被剔除的一项（视图的「已忽略」列表、工具输出的条数）。memoryIds 已排序。 */
export interface IgnoredAdvice {
  type: IgnorableAdviceType
  memoryIds: string[]
}

/** 这条记录此刻还算数：每条记忆都在用、指纹与忽略时一致。 */
function isStillMatching(entry: AdviceIgnore, byId: ReadonlyMap<string, MemoryRecord>): boolean {
  return entry.memoryIds.every((id, i) => {
    const r = byId.get(id)
    return r?.status === 'active' && adviceFingerprint(r) === entry.fingerprints[i]
  })
}

/**
 * 评分前剔除被忽略的发现。内容重复按整组（排序后的 id）对；其余类型按每条记忆对，一条发现涉及几条记忆时只去掉被忽略的那几条，
 * 都去掉了整条不计——没有忽略时发现原样保留，计数不变。冲突、密钥、读不出的文件不可忽略，原样保留。
 */
export function applyIgnores(
  findings: readonly Finding[],
  ignores: readonly AdviceIgnore[],
  byId: ReadonlyMap<string, MemoryRecord>,
): { kept: Finding[]; ignored: IgnoredAdvice[] } {
  if (ignores.length === 0) return { kept: [...findings], ignored: [] }
  const live = new Map(ignores.filter(e => isStillMatching(e, byId)).map(e => [e.id, e]))
  const ignored = new Map<string, IgnoredAdvice>()
  const kept: Finding[] = []
  for (const f of findings) {
    const type = f.type
    if (!isIgnorableType(type) || f.memoryIds.length === 0) { kept.push(f); continue }
    const groups = type === 'redundancy' ? [f.memoryIds] : f.memoryIds.map(id => [id])
    const hit = groups.filter(ids => live.has(adviceIdentity(type, ids)))
    for (const ids of hit) ignored.set(adviceIdentity(type, ids), { type, memoryIds: [...ids].sort() })
    if (hit.length === 0) { kept.push(f); continue }
    const remaining = f.memoryIds.filter(id => !hit.some(ids => ids.includes(id)))
    if (type !== 'redundancy' && remaining.length > 0) kept.push({ ...f, memoryIds: remaining })
  }
  return { kept, ignored: [...ignored.values()] }
}

/**
 * 清理点要删的记录：引用的记忆已不在用（删除、归档、彻底删除）或内容变了。
 * isComplete：这次读全了（没有读不出的文件、目录），byId 里没有的 id 才算真的没了；没读全时只按读到的判断。
 * before：只清不晚于这个时刻（读记忆之前取）记下的：读的过程中别处刚按新内容忽略的，不会因为这次读到的是旧内容被清掉。
 */
export function staleIgnores(
  ignores: readonly AdviceIgnore[],
  byId: ReadonlyMap<string, MemoryRecord>,
  opts: { isComplete: boolean; before: number },
): AdviceIgnore[] {
  return ignores.filter(e => e.ignoredAt <= opts.before && e.memoryIds.some((id, i) => {
    const r = byId.get(id)
    if (r === undefined) return opts.isComplete
    return r.status !== 'active' || adviceFingerprint(r) !== e.fingerprints[i]
  }))
}

/** 建议忽略表：治理侧只经 KvTable 一类接口读写（清理要条件删除，用 CasKvTable），不碰文件细节。 */
export class AdviceIgnoreStore {
  private readonly table: CasKvTable<AdviceIgnore>

  constructor(table: CasKvTable<AdviceIgnore>) {
    this.table = table
  }

  async list(): Promise<AdviceIgnore[]> {
    return (await this.table.list()).map(([, e]) => e)
  }

  /** 记下这一项（records 是此刻在用的记忆）；同一项再忽略一次覆盖成新的指纹和时间。 */
  async ignore(type: IgnorableAdviceType, records: readonly MemoryRecord[], now: number): Promise<AdviceIgnore> {
    const entry = toEntry(type, records, now)
    await this.table.put(entry.id, entry)
    return entry
  }

  /**
   * 这一项还没有算数的忽略（没有记录，或记录的指纹对不上此刻的记忆）时记下，返回写下的那条；已经忽略着的不动，返回 undefined。
   * 判断和写在同一次读改写里：判断之后别处刚写下的忽略不会被盖掉。
   */
  async ignoreIfAbsent(type: IgnorableAdviceType, records: readonly MemoryRecord[], now: number): Promise<AdviceIgnore | undefined> {
    const entry = toEntry(type, records, now)
    const isWritten = await this.table.update(entry.id, current =>
      current !== undefined && current.fingerprints.join(',') === entry.fingerprints.join(',') ? undefined : entry)
    return isWritten ? entry : undefined
  }

  /** 只在此刻的记录仍是 written 那一条（忽略时间、指纹都没变）时取消忽略：之后重新忽略过的、已取消的不动。 */
  async unignoreIfSame(type: string, memoryIds: readonly string[], written: Pick<AdviceIgnore, 'ignoredAt' | 'fingerprints'>): Promise<boolean> {
    return this.deleteIfSame(adviceIdentity(type, memoryIds), written)
  }

  /** 取消忽略；本来就没有返回 false。 */
  async unignore(type: string, memoryIds: readonly string[]): Promise<boolean> {
    return this.table.delete(adviceIdentity(type, memoryIds))
  }

  /** 清理点删掉判定过时的记录：只删此刻仍是判定时那一版的（忽略时间、指纹都没变），期间重新忽略写下的新记录留着。 */
  async remove(entries: readonly AdviceIgnore[]): Promise<void> {
    for (const e of entries) await this.deleteIfSame(e.id, e)
  }

  private deleteIfSame(id: string, e: Pick<AdviceIgnore, 'ignoredAt' | 'fingerprints'>): Promise<boolean> {
    return this.table.deleteIf(id, cur => cur.ignoredAt === e.ignoredAt && cur.fingerprints.join(',') === e.fingerprints.join(','))
  }
}

function toEntry(type: IgnorableAdviceType, records: readonly MemoryRecord[], now: number): AdviceIgnore {
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    id: adviceIdentity(type, sorted.map(r => r.id)), type,
    memoryIds: sorted.map(r => r.id), fingerprints: sorted.map(adviceFingerprint), ignoredAt: now,
  }
}

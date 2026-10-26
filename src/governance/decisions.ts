import { createHash } from 'node:crypto'
import type { ClaimKvTable } from '../kv-table.ts'
import type { MemoryRecord } from '../record-schema.ts'
import { RETENTION_MS } from '../retention.ts'
import type { OverflowLevel } from '../contract-codes.ts'
import { genId, type PendingDecision, type PendingKind, type SettledVerdict } from './schema.ts'

/** 去重 key：memoryIds 排序拼接 + baselineRef（垂直冲突与横向冲突互不干扰）。 */
export function dedupKey(memoryIds: string[], baselineRef?: string): string {
  return [...memoryIds].sort().join('|') + (baselineRef ? `#${baselineRef}` : '')
}

/**
 * 冲突双方的内容指纹：按 id 排序取 name + content；垂直冲突再加整份基线。任一方改写或基线变了，指纹就变。
 * 垂直冲突不看 baselineRef：它是 LLM 自由填写的出处描述，每次扫描措辞都可能不同。
 */
export function conflictFingerprint(records: ReadonlyArray<Pick<MemoryRecord, 'id' | 'name' | 'content'>>, baseline?: readonly string[]): string {
  const parts = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(r => [r.id, r.name, r.content])
  return createHash('sha1').update(JSON.stringify({ parts, baseline: baseline ?? null })).digest('hex')
}

/** 提升候选的内容指纹：单条记忆的 id + name + content。内容改了，「留在本项目」的旧结论作废。 */
export function candidateFingerprint(record: Pick<MemoryRecord, 'id' | 'name' | 'content'>): string {
  return conflictFingerprint([record])
}

type KindKeyed ={ kind?: PendingKind; memoryIds: string[]; baselineRef?: string }

/** 条目种类，缺省即冲突（旧条目）。 */
export function kindOf(entry: { kind?: PendingKind }): PendingKind {
  return entry.kind ?? 'conflict'
}

/** 两个条目是否同一种类、指同一组记忆、同一类冲突（横向 / 垂直），不看 baselineRef 措辞。 */
function samePair(a: KindKeyed, b: KindKeyed): boolean {
  return kindOf(a) === kindOf(b) && dedupKey(a.memoryIds) === dedupKey(b.memoryIds) && (a.baselineRef !== undefined) === (b.baselineRef !== undefined)
}

/**
 * 裁决要删掉的一方（败方）；两边都留、或不是冲突条目时为 undefined。
 * 横向：left=memoryIds[0]、right=memoryIds[1]；垂直（有 baselineRef）：left=记忆、right=基线，基线不可删，keep-right 意为记忆删除。
 */
export function verdictLoser(entry: KindKeyed, verdict: SettledVerdict): string | undefined {
  if (kindOf(entry) !== 'conflict') return undefined
  if (entry.baselineRef !== undefined) return verdict === 'keep-right' ? entry.memoryIds[0] : undefined
  return verdict === 'keep-left' ? entry.memoryIds[1] : verdict === 'keep-right' ? entry.memoryIds[0] : undefined
}

/** 已裁决且裁决删掉了一方的条目。 */
function isDeletionSettled(entry: PendingDecision): boolean {
  return entry.settled !== undefined && verdictLoser(entry, entry.settled.verdict) !== undefined
}

/** 留作撤销的已裁决条目（删一方、提升为全局、直接改与直接合并）：快照过了保留窗口就无从撤销，由 sweep 清掉。 */
function isUndoable(entry: PendingDecision): boolean {
  return isDeletionSettled(entry) || entry.settled?.verdict === 'promoted' || kindOf(entry) === 'edit'
}

/** 超限条目的指纹：relax 为档位号（'1'、'2'…），strict 只有一档。 */
const STRICT_OVERFLOW_FINGERPRINT = 'strict-95'

export function overflowFingerprint(level: OverflowLevel): string {
  return level.mode === 'strict' ? STRICT_OVERFLOW_FINGERPRINT : String(level.tier)
}

/** 超限条目的档位（由指纹还原）。 */
export function overflowLevelOf(entry: Pick<PendingDecision, 'fingerprint'>): OverflowLevel {
  return entry.fingerprint === STRICT_OVERFLOW_FINGERPRINT
    ? { mode: 'strict', tier: 0 }
    : { mode: 'relax', tier: Number.parseInt(entry.fingerprint ?? '', 10) || 0 }
}

/** 超限条目所属的项目（workspace 路径，无项目的会话为 'global'），存在 workspaces[0]。 */
export function overflowScopeOf(entry: Pick<PendingDecision, 'workspaces'>): string | undefined {
  return entry.workspaces?.[0]
}

/** 按 id 读记忆此刻的状态（扫描传入 store.get）：认领条目之后据此核对，不用扫描开头预读的数据。 */
export type ReadMemory = (id: string) => Promise<MemoryRecord | undefined>

/** 记忆此刻仍是这个项目里 active 的提升候选。 */
async function isCandidateNow(id: string, scope: string | undefined, read: ReadMemory): Promise<boolean> {
  const r = await read(id)
  return r?.status === 'active' && r.scope === 'workspace' && r.workspacePath === scope && r.globalCandidate === true
}

/** 体检要把条目挂成待处理时核对它此刻还成立：冲突双方都还 active；提升候选仍是该项目的候选。 */
async function holdsNow(entry: KindKeyed & { workspaces?: string[] }, read: ReadMemory): Promise<boolean> {
  if (kindOf(entry) === 'promote-candidate') return isCandidateNow(entry.memoryIds[0] ?? '', entry.workspaces?.[0], read)
  return (await Promise.all(entry.memoryIds.map(read))).every(r => r?.status === 'active')
}

type UpsertInput = { kind?: PendingKind; memoryIds: string[]; baselineRef?: string; summary: string; workspaces?: string[]; fingerprint?: string }

/** 同键再报：更新 summary / workspaces / 指纹，保留 id 与 firstSeenAt。workspaces 与 memoryIds 一一对应，按已有条目的 id 顺序重排。 */
function mergeReport(existing: PendingDecision, input: UpsertInput): PendingDecision {
  const wsById = new Map(input.memoryIds.map((id, i) => [id, input.workspaces?.[i]]))
  const workspaces = input.workspaces !== undefined ? existing.memoryIds.map(id => wsById.get(id) ?? '(未知)') : undefined
  return {
    ...existing, summary: input.summary,
    ...(workspaces !== undefined ? { workspaces } : {}),
    ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
  }
}

/**
 * pending-decisions 待决账本（docs/p1-governance-health-design.md §4）。种类见 kind：冲突（缺省）、提升候选、超限提醒。
 * 裁决一律标 settled 留在账本里：两边都留的（含提升候选「留在本项目」、超限「忽略」），指纹不变时不再挂账，
 * 指纹变了（任一方改写、基线变了、换了档位）旧结论作废、按新条目重报；删掉一方的记下快照 id 供撤销，
 * 同一对再被扫到（败方回来了）就回到待处理，败方超出保留窗口后由 sweep 清掉。
 * settled 条目对 get / list 不可见，只有 listSettled、upsert、removeByMemoryIds、sweep 会看到它。
 */
export class PendingDecisionsStore {
  private table: ClaimKvTable<PendingDecision>

  constructor(table: ClaimKvTable<PendingDecision>) {
    this.table = table
  }

  /**
   * 认领一条条目后执行 fn，跑完释放：同一条目同时只有一个持有者（侧表实现跨进程），两条相反的裁决不会各删一方。
   * 已被别人认领时不等待，返回 { isClaimed: false }，什么都不做。fn 里要重新读条目确认它仍是期望的状态：
   * 认领之前它可能刚被别人裁决完。不可重入：fn 里不能再认领同一条。
   */
  async withClaim<R>(id: string, fn: () => Promise<R>): Promise<{ isClaimed: true; value: R } | { isClaimed: false }> {
    const release = await this.table.claim(id)
    if (release === undefined) return { isClaimed: false }
    try {
      return { isClaimed: true, value: await fn() }
    } finally {
      await release()
    }
  }

  async list(): Promise<PendingDecision[]> {
    return (await this.table.list()).map(([, e]) => e).filter(e => !e.settled).sort((a, b) => a.firstSeenAt - b.firstSeenAt)
  }

  async get(id: string): Promise<PendingDecision | undefined> {
    const entry = await this.table.get(id)
    return entry?.settled ? undefined : entry
  }

  /** 已裁决条目（含删一方留作撤销的），按裁决时间升序。 */
  async listSettled(): Promise<PendingDecision[]> {
    return (await this.table.list()).map(([, e]) => e).filter(e => e.settled).sort((a, b) => a.settled!.at - b.settled!.at)
  }

  /**
   * settled：命中已裁决条目且指纹没变，没有挂账，entry 是那条已裁决条目。
   * 改已有条目前先认领它、认领后重读：读快照之后它可能刚被裁决或撤销，不拿旧快照盖掉。正被别人认领（正在裁决）的
   * 不动，返回 isSkipped。给了 read 时，把条目挂成待处理（重开删一方的裁决、作废旧结论、更新未决条目）之前按记忆
   * 此刻的状态核对一遍（holdsNow），对不上也返回 isSkipped：刚删掉败方的裁决不会被当成「败方回来了」反撤。
   */
  async upsert(input: UpsertInput, now: number, read?: ReadMemory): Promise<{ created: boolean; settled?: true; isSkipped?: true; entry: PendingDecision }> {
    const entries = await this.table.list()
    const key = dedupKey(input.memoryIds, input.baselineRef)
    // 先看已裁决的同一对，再看未决的同键条目
    const matches = [
      ...entries.filter(([, e]) => e.settled !== undefined && samePair(e, input)),
      ...entries.filter(([, e]) => e.settled === undefined && kindOf(e) === kindOf(input) && dedupKey(e.memoryIds, e.baselineRef) === key),
    ]
    const holds = async () => read === undefined || await holdsNow(input, read)
    for (const [id, seen] of matches) {
      const claimed = await this.withClaim(id, async (): Promise<{ created: false; settled?: true; isSkipped?: true; entry: PendingDecision } | undefined> => {
        const existing = await this.table.get(id)
        if (existing === undefined || !samePair(existing, input)) return undefined
        if (existing.settled !== undefined) {
          if (!isDeletionSettled(existing) && input.fingerprint !== undefined && existing.fingerprint === input.fingerprint) {
            return { created: false, settled: true, entry: existing }
          }
          if (!(await holds())) return { created: false, isSkipped: true, entry: existing }
          if (!isDeletionSettled(existing)) {
            await this.table.delete(id) // 指纹变了：旧结论作废
            return undefined
          }
          // 删一方的裁决：同一对又被扫到、双方此刻都在，说明败方回来了（快照恢复等），回到待处理，沿用原条目
          const { settled: _settled, ...open } = existing
          const reopened = mergeReport(open, input)
          await this.table.put(reopened.id, reopened)
          return { created: false, entry: reopened }
        }
        if (!(await holds())) return { created: false, isSkipped: true, entry: existing }
        const updated = mergeReport(existing, input)
        await this.table.put(updated.id, updated)
        return { created: false, entry: updated }
      })
      if (!claimed.isClaimed) return { created: false, isSkipped: true, entry: seen }
      if (claimed.value !== undefined) return claimed.value
    }
    const entry: PendingDecision = {
      id: genId('pd'),
      ...(input.kind !== undefined && input.kind !== 'conflict' ? { kind: input.kind } : {}),
      memoryIds: input.memoryIds,
      ...(input.baselineRef !== undefined ? { baselineRef: input.baselineRef } : {}),
      summary: input.summary,
      firstSeenAt: now,
      ...(input.workspaces !== undefined ? { workspaces: input.workspaces } : {}),
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    }
    await this.table.put(entry.id, entry)
    return { created: true, entry }
  }

  /**
   * 记下裁决。两边都留的靠指纹判断以后变没变：没有指纹的旧条目无从判断，退回直接移除，返回 false。
   * 删一方的留账是为了撤销，不看指纹；snapshotId 是删败方前的快照。fingerprint 给出时换掉条目上的指纹
   * （「留在本项目」按记忆此刻的内容记，不用上次体检时的）。顺手清扫超出保留窗口的条目。
   */
  async settle(id: string, verdict: SettledVerdict, now: number, opts: { snapshotId?: string; fingerprint?: string } = {}): Promise<boolean> {
    const entry = await this.table.get(id)
    if (!entry) return false
    if (entry.fingerprint === undefined && opts.fingerprint === undefined && verdictLoser(entry, verdict) === undefined) {
      await this.table.delete(id)
      return false
    }
    await this.table.put(id, {
      ...entry,
      ...(opts.fingerprint !== undefined ? { fingerprint: opts.fingerprint } : {}),
      settled: { verdict, at: now, ...(opts.snapshotId !== undefined ? { snapshotId: opts.snapshotId } : {}) },
    })
    await this.sweep(now)
    return true
  }

  /**
   * 连带清理：删一方的已裁决条目，败方软删时刻就是裁决时刻，超出保留窗口后败方已被维护点物理删除、
   * 快照也已过期，撤销无从谈起，条目一起清掉（提升为全局的同理：快照过期即不可撤销）（与 storage 维护点、SnapshotStore.sweep 同一个 RETENTION_MS 截止线）。
   */
  async sweep(now: number): Promise<void> {
    const cutoff = now - RETENTION_MS
    for (const [key, e] of await this.table.list()) {
      if (isUndoable(e) && e.settled!.at < cutoff) await this.table.delete(key)
    }
  }

  /** 撤销裁决：去掉 settled，条目回到待处理（沿用原 id 与 firstSeenAt）。条目不存在或未裁决返回 false。 */
  async unsettle(id: string): Promise<boolean> {
    const entry = await this.table.get(id)
    if (!entry?.settled) return false
    const { settled: _settled, ...open } = entry
    await this.table.put(id, open)
    return true
  }

  /** 全部超限条目（含已忽略的）：已忽略只是不再提醒，超限的事实仍在，健康把它列为问题。 */
  async listOverflow(): Promise<PendingDecision[]> {
    return (await this.table.list()).map(([, e]) => e).filter(e => kindOf(e) === 'overflow')
  }

  /**
   * 快照冻结时同步一个项目的超限提醒（scope：workspace 路径，无项目为 'global'）。每个项目同时只留一条，指纹 = 当前档位：
   * 同档沿用原条目、只更新说明里的用量（已忽略的保持忽略，不重报）；进入更高档换一条新的未决条目；回落到没超限删掉，下次超限重新提醒；
   * 从高档降到低档时高档条目删掉、换成低档条目，高档已忽略的低档也算忽略（回落不打扰），再升回高档重新提醒。
   * 换模式（relax ↔ strict）旧条目作废。返回账本是否有变化。
   */
  async syncOverflow(scope: string, level: OverflowLevel | undefined, now: number, summary: string): Promise<boolean> {
    const mine = (await this.table.list()).filter(([, e]) => kindOf(e) === 'overflow' && overflowScopeOf(e) === scope)
    const fingerprint = level === undefined ? undefined : overflowFingerprint(level)
    const current = mine.find(([, e]) => e.fingerprint === fingerprint)
    const stale = mine.filter(entry => entry !== current)
    for (const [key] of stale) await this.table.delete(key)
    if (level === undefined) return stale.length > 0
    if (current !== undefined) {
      if (current[1].summary === summary) return stale.length > 0
      await this.table.put(current[0], { ...current[1], summary })
      return true
    }
    const dismissedAbove = stale.some(([, e]) => e.settled !== undefined && overflowLevelOf(e).mode === level.mode && overflowLevelOf(e).tier > level.tier)
    const entry: PendingDecision = {
      id: genId('pd'), kind: 'overflow', memoryIds: [], summary, firstSeenAt: now, workspaces: [scope], fingerprint: fingerprint!,
      ...(dismissedAbove ? { settled: { verdict: 'dismiss' as const, at: now } } : {}),
    }
    await this.table.put(entry.id, entry)
    return true
  }

  /**
   * 扫描时同步一个项目的提升候选（scope：workspace 路径）。candidates：该项目 active 且带 globalCandidate 的记忆；
   * liveIds：该项目全部 active 记忆。每条候选一条 promote-candidate 条目，指纹 = 记忆内容指纹（candidateFingerprint）：
   * 「留在本项目」过的指纹不变不再提示，内容改了旧结论作废、重新提示；已提升（promoted）的又成了本项目候选
   * （被快照恢复回来）回到待处理。未决条目的记忆不再是候选（已提升、标记被清、记忆没了）就移除；
   * 「留在本项目」的条目在记忆不再 active 时移除；promoted 留给撤销，由 sweep 按保留窗口清。
   * 每条先认领、认领后重读（正被别人认领的跳过）；给了 read 时只在扫描数据与记忆此刻的状态一致时才动它
   * （期间被提升、撤销的这次不动，下次体检再说）。
   */
  async syncPromoteCandidates(
    scope: string,
    candidates: ReadonlyArray<{ id: string; summary: string; fingerprint: string }>,
    liveIds: ReadonlySet<string>,
    now: number,
    read?: ReadMemory,
  ): Promise<void> {
    const candidateIds = new Set(candidates.map(c => c.id))
    for (const [key, seen] of await this.table.list()) {
      if (kindOf(seen) !== 'promote-candidate' || seen.workspaces?.[0] !== scope) continue
      await this.withClaim(key, async () => {
        const e = await this.table.get(key)
        if (e === undefined) return
        const id = e.memoryIds[0]!
        const isCandidate = candidateIds.has(id)
        const isCandidateFresh = read === undefined ? isCandidate : await isCandidateNow(id, scope, read)
        if (e.settled?.verdict === 'promoted') {
          if (isCandidate && isCandidateFresh) await this.unsettle(key)
        } else if (e.settled === undefined) {
          if (!isCandidate && !isCandidateFresh) await this.table.delete(key)
        } else if (!liveIds.has(id)) {
          const r = read === undefined ? undefined : await read(id)
          if (r?.status !== 'active' || r.workspacePath !== scope) await this.table.delete(key)
        }
      })
    }
    for (const c of candidates) {
      await this.upsert({ kind: 'promote-candidate', memoryIds: [c.id], summary: c.summary, workspaces: [scope], fingerprint: c.fingerprint }, now, read)
    }
  }

  /**
   * 记一条生来就已结清的条目（直接改、直接合并的撤销记录）：不经过未决，别处读账本时不会把它当待处理。
   * 同一条记忆改几次就有几条，撤销各自核对指纹；超出保留窗口由 sweep 清掉。
   */
  async addSettled(
    input: { kind: PendingKind; memoryIds: string[]; summary: string; workspaces: string[]; fingerprint: string },
    verdict: SettledVerdict, now: number, snapshotId: string,
  ): Promise<PendingDecision> {
    const entry: PendingDecision = { id: genId('pd'), ...input, firstSeenAt: now, settled: { verdict, at: now, snapshotId } }
    await this.table.put(entry.id, entry)
    await this.sweep(now)
    return entry
  }

  async remove(id: string): Promise<boolean> {
    return this.table.delete(id)
  }

  /** 悬空引用清理：任一被删记忆出现在条目里，整条移除（含已裁决条目，keepId 那条除外）。返回移除的未决条目数。 */
  async removeByMemoryIds(memoryIds: string[], keepId?: string): Promise<number> {
    const hit = (await this.table.list()).filter(([key, e]) => key !== keepId && e.memoryIds.some(id => memoryIds.includes(id)))
    for (const [key] of hit) await this.table.delete(key)
    return hit.filter(([, e]) => !e.settled).length
  }
}

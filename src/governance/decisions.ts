import { createHash } from 'node:crypto'
import type { CasKvTable, ClaimKvTable } from '../kv-table.ts'
import type { MemoryRecord } from '../record-schema.ts'
import type { OverflowLevel } from '../contract-codes.ts'
import {
  genId, kindOf, verdictLoser, type BatchReceipt, type PendingDecision, type PendingKind, type SettledProposal, type SettledVerdict, type StoredSuggestion,
  type SuggestionBasis, type SuggestionFailure,
} from './schema.ts'
import { isUndoExpired } from './undo-rules.ts'
import { editFingerprint } from './snapshots.ts'
import { scopeAt, scopeKey } from '../scope.ts'

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

/** 记忆所在作用域的标准键：完整内容指纹不含位置，提升、移动要靠它认出来（融合稿写进哪条按合并规则看作用域）。 */
const scopeKeyOf = (r: MemoryRecord) => scopeKey(scopeAt(r.workspacePath))

/**
 * 处理建议的依据版本：条目此刻的冲突指纹，和每条涉及记忆此刻的完整内容指纹、作用域键（按条目 memoryIds 的顺序）。
 * records 与条目 memoryIds 一一对应、都是此刻读到的记录。
 */
export function suggestionBasis(entry: Pick<PendingDecision, 'fingerprint'>, records: readonly MemoryRecord[]): SuggestionBasis {
  return {
    ...(entry.fingerprint !== undefined ? { conflictFingerprint: entry.fingerprint } : {}),
    memories: records.map(r => ({ memoryId: r.id, fingerprint: editFingerprint(r), scopeKey: scopeKeyOf(r) })),
  }
}

/** 依据版本和此刻对得上：条目的冲突指纹一致，每条记忆（按 memoryIds 顺序）都在，完整内容指纹和作用域都一致。 */
export function isBasisCurrent(entry: Pick<PendingDecision, 'fingerprint' | 'memoryIds'>, basis: SuggestionBasis, records: ReadonlyArray<MemoryRecord | undefined>): boolean {
  if (entry.fingerprint !== basis.conflictFingerprint) return false
  if (basis.memories.length !== entry.memoryIds.length || records.length !== entry.memoryIds.length) return false
  return basis.memories.every((m, i) => {
    const r = records[i]
    return m.memoryId === entry.memoryIds[i] && r !== undefined && r.id === m.memoryId && editFingerprint(r) === m.fingerprint && scopeKeyOf(r) === m.scopeKey
  })
}

/** 「留在本项目」顺带写的放错层忽略（见 schema settled.misplacedIgnore）。 */
export type MisplacedIgnore = NonNullable<NonNullable<PendingDecision['settled']>['misplacedIgnore']>

type KindKeyed ={ kind?: PendingKind; memoryIds: string[]; baselineRef?: string }

/** 同一组记忆、同一类冲突（横向 / 垂直）的键，不看 baselineRef 措辞（LLM 自由填写，每次扫描都可能不同）。 */
export function pairKey(entry: { memoryIds: string[]; baselineRef?: string }): string {
  return dedupKey(entry.memoryIds) + (entry.baselineRef !== undefined ? '#baseline' : '')
}

/** 两个条目是否同一种类、指同一组记忆、同一类冲突（横向 / 垂直），不看 baselineRef 措辞。 */
function samePair(a: KindKeyed, b: KindKeyed): boolean {
  return kindOf(a) === kindOf(b) && pairKey(a) === pairKey(b)
}

/**
 * 挂账时按冲突身份（samePair 的口径）认领用的键。侧表认领按键建 `<键>.claim`，pairKey 里的 `|`、`#` 不能当文件名
 * （不能当文件名的键认领直接放行、不排他），所以取哈希；`pair_` 前缀与条目 id（`pd_`）分开，不会和裁决认领撞上。
 */
function pairClaimKey(entry: KindKeyed): string {
  return `pair_${createHash('sha1').update(`${kindOf(entry)}\n${pairKey(entry)}`).digest('hex')}`
}

/** 先出现的在前，同一时刻按 id：收拢重复条目时留下排第一的那条。 */
function byFirstSeen(a: PendingDecision, b: PendingDecision): number {
  return a.firstSeenAt - b.firstSeenAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** 已裁决且裁决删掉了一方的条目。 */
function isDeletionSettled(entry: PendingDecision): boolean {
  return entry.settled !== undefined && verdictLoser(entry, entry.settled.verdict) !== undefined
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
type UpsertResult = { created: boolean; settled?: true; isSkipped?: true; entry: PendingDecision }

/**
 * 同一对再报：更新 summary / baselineRef 措辞 / workspaces / 指纹，保留 id 与 firstSeenAt。
 * workspaces 与 memoryIds 一一对应，按已有条目的 id 顺序重排。
 */
function mergeReport(existing: PendingDecision, input: UpsertInput): PendingDecision {
  const wsById = new Map(input.memoryIds.map((id, i) => [id, input.workspaces?.[i]]))
  const workspaces = input.workspaces !== undefined ? existing.memoryIds.map(id => wsById.get(id) ?? '(未知)') : undefined
  return {
    ...existing, summary: input.summary,
    ...(input.baselineRef !== undefined ? { baselineRef: input.baselineRef } : {}),
    ...(workspaces !== undefined ? { workspaces } : {}),
    ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
  }
}

/**
 * pending-decisions 待决账本：等用户裁决的事项。种类见 kind：冲突（缺省）、提升候选、超限提醒。
 * 裁决一律标 settled 留在账本里：两边都留的（含提升候选「留在本项目」、超限「忽略」），指纹不变时不再挂账，
 * 指纹变了（任一方改写、基线变了、换了档位）旧结论作废、按新条目重报；删掉一方的记下快照 id 供撤销，
 * 同一对再被扫到（败方回来了）就回到待处理，败方超出保留窗口后由 sweep 清掉。
 * settled 条目对 get / list 不可见，只有 listSettled、upsert、removeByMemoryIds、sweep 会看到它。
 * 同一对（samePair）在账本里只有一条未决条目，跨进程也成立：挂账按冲突身份认领（见 upsert）。
 */
/** 账本用的表：带排他认领，清理用条件删除。 */
export type PendingTable = ClaimKvTable<PendingDecision> & Pick<CasKvTable<PendingDecision>, 'deleteIf'>

export class PendingDecisionsStore {
  private table: PendingTable

  constructor(table: PendingTable) {
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

  /** 认领一对冲突的身份后执行 fn（同 withClaim，不等待）：挂账和要删一方的裁决都先认领它，同一对同时只有一处在动。 */
  withPairClaim<R>(entry: KindKeyed, fn: () => Promise<R>): Promise<{ isClaimed: true; value: R } | { isClaimed: false }> {
    return this.withClaim(pairClaimKey(entry), fn)
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
   * 整个查找、新建按冲突身份认领（pairClaimKey）：两次体检同时扫到同一对（agent 体检不认领体检范围、或两个宿主进程），
   * 不认领的话都读到「还没有」、各建一条，之后两条各裁一个相反的结论会把双方都删掉。认领不到说明别处正在挂这一对，
   * 不等待，返回 isSkipped，entry 是这次要报的内容、没写进账本，这次不挂账，下次体检再说。
   * 改已有条目前先认领它、认领后重读：读快照之后它可能刚被裁决或撤销，不拿旧快照盖掉。正被别人认领（正在裁决）的
   * 不动，返回 isSkipped。给了 read 时，把条目挂成待处理（重开删一方的裁决、作废旧结论、更新未决条目）之前按记忆
   * 此刻的状态核对一遍（holdsNow），对不上也返回 isSkipped：刚删掉败方的裁决不会被当成「败方回来了」反撤。
   * 挂上之后（新建、更新、重开，或命中仍成立的两边都留结论）收拢同一对多出来的未决条目，见 dropDuplicates。
   */
  async upsert(input: UpsertInput, now: number, read?: ReadMemory): Promise<UpsertResult> {
    const draft: PendingDecision = {
      id: genId('pd'),
      ...(input.kind !== undefined && input.kind !== 'conflict' ? { kind: input.kind } : {}),
      memoryIds: input.memoryIds,
      ...(input.baselineRef !== undefined ? { baselineRef: input.baselineRef } : {}),
      summary: input.summary,
      firstSeenAt: now,
      ...(input.workspaces !== undefined ? { workspaces: input.workspaces } : {}),
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
    }
    const claimed = await this.withPairClaim(input, () => this.upsertClaimed(input, draft, read))
    return claimed.isClaimed ? claimed.value : { created: false, isSkipped: true, entry: draft }
  }

  /** 持有冲突身份的认领时挂账：同一对的查找、新建、收拢同时只有一处在做。 */
  private async upsertClaimed(input: UpsertInput, draft: PendingDecision, read?: ReadMemory): Promise<UpsertResult> {
    const entries = await this.table.list()
    // 先看已裁决的同一对，再看未决的同一对（垂直冲突的 baselineRef 措辞每次扫描都可能不同，不能按它分开，否则每次重扫都多一条）。
    // 未决的按先出现排：修复前留下的重复条目里沿用最早的那条
    const opens = entries.filter(([, e]) => e.settled === undefined && samePair(e, input)).sort(([, a], [, b]) => byFirstSeen(a, b))
    const matches = [...entries.filter(([, e]) => e.settled !== undefined && samePair(e, input)), ...opens]
    const holds = async () => read === undefined || await holdsNow(input, read)
    let result: UpsertResult | undefined
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
      if (claimed.value !== undefined) {
        result = claimed.value
        break
      }
    }
    if (result === undefined) {
      await this.table.put(draft.id, draft)
      result = { created: true, entry: draft }
    }
    if (!result.isSkipped) await this.dropDuplicates(opens.map(([id]) => id), result.entry.id, input)
    return result
  }

  /**
   * 收拢同一对多出来的未决条目（按冲突身份认领之前，并发挂账会建出几条）：keepId 之外的逐条认领、重读，仍是未决的同一对才删。
   * 留下的是这次挂上的那条，或命中的两边都留结论（结论仍成立，多出来的未决条目不该再裁一次）。
   * 已结清的不动：删一方的裁决记着撤销要用的快照，由重开、sweep 处理。正被认领（正在裁决）的这次不动，下次挂账再收。
   */
  private async dropDuplicates(openIds: readonly string[], keepId: string, input: UpsertInput): Promise<void> {
    for (const id of openIds) {
      if (id === keepId) continue
      await this.withClaim(id, async () => {
        const e = await this.table.get(id)
        if (e !== undefined && e.settled === undefined && samePair(e, input)) await this.table.delete(id)
      })
    }
  }

  /**
   * 记下裁决。两边都留的靠指纹判断以后变没变：没有指纹的旧条目无从判断，退回直接移除，返回 false。
   * 删一方的留账是为了撤销，不看指纹；snapshotId 是删败方前的快照。fingerprint 给出时换掉条目上的指纹
   * （「留在本项目」按记忆此刻的内容记，不用上次体检时的）。isBornSettled、misplacedIgnore、proposal 见 schema。顺手清扫超出保留窗口的条目。
   */
  async settle(
    id: string, verdict: SettledVerdict, now: number,
    opts: { snapshotId?: string; fingerprint?: string; isBornSettled?: true; misplacedIgnore?: MisplacedIgnore; proposal?: SettledProposal } = {},
  ): Promise<boolean> {
    const entry = await this.table.get(id)
    if (!entry) return false
    if (entry.fingerprint === undefined && opts.fingerprint === undefined && verdictLoser(entry, verdict) === undefined) {
      await this.table.delete(id)
      return false
    }
    await this.table.put(id, {
      ...entry,
      ...(opts.fingerprint !== undefined ? { fingerprint: opts.fingerprint } : {}),
      settled: {
        verdict, at: now, ...(opts.snapshotId !== undefined ? { snapshotId: opts.snapshotId } : {}), ...(opts.isBornSettled ? { isBornSettled: true as const } : {}),
        ...(opts.misplacedIgnore !== undefined ? { misplacedIgnore: opts.misplacedIgnore } : {}),
        ...(opts.proposal !== undefined ? { proposal: opts.proposal } : {}),
      },
    })
    await this.sweep(now)
    return true
  }

  /**
   * 连带清理：删一方的已裁决条目，败方软删时刻就是裁决时刻，超出保留窗口后败方已被维护点物理删除、
   * 快照也已过期，撤销无从谈起，条目一起清掉（提升为全局的同理：快照过期即不可撤销）（与 storage 维护点、SnapshotStore.sweep 同一个 RETENTION_MS 截止线）。
   */
  async sweep(now: number): Promise<void> {
    for (const [key, e] of await this.table.list()) {
      // 读到之后条目可能被重开（同一对再被扫到、撤销）：删之前按此刻的值再判一次
      if (isUndoExpired(e, now)) await this.table.deleteIf(key, current => isUndoExpired(current, now))
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

  /**
   * 把一次生成的结果（处理建议，或没生成成的原因）写到条目上。生成在认领之外做（模型调用可能超过认领的 60 秒），
   * 这里只认领条目、重读、核对、写：条目仍未决；双方此刻都在用，依据版本和生成时一致；条目上还没有当前依据的建议
   * （有就不覆盖，丢掉这一份，失败也不记，免得盖住别处刚写的建议）。写建议时清掉之前记的失败。
   * 删除一条记忆的路径先删记忆、再清条目，且不认领条目：核对之后、写入之前被清掉的条目会被这次写入写回来，
   * 所以写完（仍在认领内）再读一遍两条，任一条已不在用就撤回这次写入的条目，回 gone。
   * 返回：written 已写；has-current 已有当前建议、这份丢弃；stale 依据对不上；gone 条目不在、已结清或写完发现一方已不在用；claimed 正被别处认领、这份丢弃。
   */
  async writeSuggestion(
    id: string, outcome: { suggestion: StoredSuggestion } | { failure: SuggestionFailure }, read: ReadMemory,
  ): Promise<'written' | 'has-current' | 'stale' | 'gone' | 'claimed'> {
    const claimed = await this.withClaim(id, async () => {
      const entry = await this.table.get(id)
      if (entry === undefined || entry.settled !== undefined) return 'gone' as const
      const records = await Promise.all(entry.memoryIds.map(read))
      const live = records.map(r => (r?.status === 'active' ? r : undefined))
      if (entry.suggestion !== undefined && isBasisCurrent(entry, entry.suggestion.basis, live)) return 'has-current' as const
      const basis = 'suggestion' in outcome ? outcome.suggestion.basis : outcome.failure.basis
      if (!isBasisCurrent(entry, basis, live)) return 'stale' as const
      if ('suggestion' in outcome) {
        const { suggestionFailure: _failure, ...rest } = entry
        await this.table.put(id, { ...rest, suggestion: outcome.suggestion })
      } else {
        await this.table.put(id, { ...entry, suggestionFailure: outcome.failure })
      }
      const after = await Promise.all(entry.memoryIds.map(read))
      if (after.some(r => r?.status !== 'active')) {
        await this.table.delete(id)
        return 'gone' as const
      }
      return 'written' as const
    })
    return claimed.isClaimed ? claimed.value : 'claimed'
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
      // 认领后重读、只改说明：读账本之后用户可能刚忽略了它（dismiss-overflow 认领着写 settled），不拿旧值盖回未决。
      // 正被认领的这次不改，下次冻结再同步
      const [key] = current
      const claimed = await this.withClaim(key, async () => {
        const latest = await this.table.get(key)
        if (latest === undefined || latest.summary === summary) return false
        await this.table.put(key, { ...latest, summary })
        return true
      })
      return (claimed.isClaimed && claimed.value) || stale.length > 0
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
   * 记一条生来就已结清的条目，不经过未决：别处读账本（体检同步提升候选）时不会把它当待处理清掉。
   * 撤销记录走下面按种类的方法；就地处理时才记的提升、留下也直接用它（isBornSettled 见 schema）。超出保留窗口由 sweep 清掉。
   */
  async addSettled(
    input: { kind: PendingKind; memoryIds: string[]; summary: string; workspaces: string[]; fingerprint?: string; receipts?: BatchReceipt[]; origin?: PendingDecision['origin'] },
    verdict: SettledVerdict, now: number,
    opts: { snapshotId?: string; isBornSettled?: true; misplacedIgnore?: MisplacedIgnore } = {},
  ): Promise<PendingDecision> {
    const settled = {
      verdict, at: now, ...(opts.snapshotId !== undefined ? { snapshotId: opts.snapshotId } : {}), ...(opts.isBornSettled ? { isBornSettled: true as const } : {}),
      ...(opts.misplacedIgnore !== undefined ? { misplacedIgnore: opts.misplacedIgnore } : {}),
    }
    const entry: PendingDecision = { id: genId('pd'), ...input, firstSeenAt: now, settled }
    await this.table.put(entry.id, entry)
    await this.sweep(now)
    return entry
  }

  // 撤销记录：written 必须是这次操作提交的那条（处理器手里写下的、put / update 的返回值），指纹按它算，不写后重读：
  // 重读拿到的可能已是别处紧接着写的版本，撤销会把它当成自己写的盖掉。同一条记忆改几次就有几条，撤销各自核对指纹。

  /** 直接改、直接合并：written 是保留的那条，memoryIds 是保留的那条（合并时再跟上删掉的那条）。 */
  addEdit(written: MemoryRecord, input: { memoryIds: string[]; summary: string; workspaces: string[] }, verdict: 'edited' | 'merged', snapshotId: string, now: number) {
    return this.addSettled({ kind: 'edit', ...input, fingerprint: editFingerprint(written) }, verdict, now, { snapshotId })
  }

  /**
   * 整理所选的应用：writes 是这次提交的每一项（按计划顺序），written 是那一项实际提交的那份（改写是 update 的返回值，
   * 删除是软删时锁内那份），回执的指纹按它算；改写写完应是在用，删除写完应在最近删除里。
   */
  addBatchEdit(
    writes: ReadonlyArray<{ memoryId: string; op: BatchReceipt['op']; written: MemoryRecord }>, input: { summary: string; workspaces: string[] }, snapshotId: string, now: number,
  ) {
    const receipts = writes.map((w): BatchReceipt => ({ memoryId: w.memoryId, op: w.op, fingerprint: editFingerprint(w.written), expectedStatus: w.op === 'edit' ? 'active' : 'deleted' }))
    return this.addSettled({ kind: 'edit', memoryIds: writes.map(w => w.memoryId), ...input, receipts }, 'batch-edited', now, { snapshotId })
  }

  /** 全局记忆移到项目：written 是移过去的那一份。 */
  addMove(written: MemoryRecord, input: { summary: string; workspace: string }, snapshotId: string, now: number) {
    return this.addSettled({ kind: 'move', memoryIds: [written.id], summary: input.summary, workspaces: [input.workspace], fingerprint: editFingerprint(written) }, 'moved', now, { snapshotId })
  }

  /** 模型改写、替代：written 是改写后的那条、标成已取代的那条。 */
  addModelChange(written: MemoryRecord, input: { kind: 'rewrite' | 'supersede'; workspace: string; origin: NonNullable<PendingDecision['origin']> }, snapshotId: string, now: number) {
    return this.addSettled({
      kind: input.kind, memoryIds: [written.id], summary: written.name, workspaces: [input.workspace], fingerprint: editFingerprint(written), origin: input.origin,
    }, input.kind === 'rewrite' ? 'rewritten' : 'superseded', now, { snapshotId })
  }

  /** 模型改写、替代已撤销：条目留到保留窗口结束（对话卡与右侧栏据此显示「已撤销」），不能再撤一次。条目不存在或未结清返回 false。 */
  async markUndone(id: string): Promise<boolean> {
    const entry = await this.table.get(id)
    if (!entry?.settled) return false
    await this.table.put(id, { ...entry, settled: { ...entry.settled, isUndone: true } })
    return true
  }

  async remove(id: string): Promise<boolean> {
    return this.table.delete(id)
  }

  /**
   * 彻底删除前清依赖条目：撤销要靠的那份快照副本马上就没了（snapshotIds 是含被抹那条的快照），指向它们、涉及这条记忆的条目清掉，
   * 之后恢复不再说冲突会回到待处理。同一份快照里别的记忆的副本还在，只涉及它们的撤销条目留着。
   */
  async dropDependingOn(snapshotIds: ReadonlySet<string>, memoryId: string): Promise<void> {
    for (const [key, e] of await this.table.list()) {
      const snapshotId = e.settled?.snapshotId
      if (snapshotId !== undefined && snapshotIds.has(snapshotId) && e.memoryIds.includes(memoryId)) await this.table.delete(key)
    }
  }

  /** 悬空引用清理：任一被删记忆出现在条目里，整条移除（含已裁决条目，keepId 那条除外）。返回移除的未决条目数。 */
  async removeByMemoryIds(memoryIds: string[], keepId?: string): Promise<number> {
    const hit = (await this.table.list()).filter(([key, e]) => key !== keepId && e.memoryIds.some(id => memoryIds.includes(id)))
    for (const [key] of hit) await this.table.delete(key)
    return hit.filter(([, e]) => !e.settled).length
  }
}

import type { MemoryRecord, RecallTier } from '../record-schema.ts'
import type { MemoryStore } from '../store.ts'
import { scanFingerprint, type ChangeOp } from '../governance/changeset.ts'
import { buildTidyPrompt, parseTidyOutput, tidyBatches } from '../governance/dreams-tidy.ts'
import { buildOrganizePrompt, organizeBatches, organizeDirectory, organizeGroups, parseOrganizeOutput, type OrganizeMember } from '../governance/index-organize.ts'
import type { SemanticLlm } from '../governance/semantic-scan.ts'
import { JSON_RETRY_HINT } from '../json-reply.ts'
import type { IndexFiles } from '../topic-index.ts'
import { DREAMS_APPLY_MAX_OPS, isCompleteRead, type DreamsStep, type DreamsStepContext } from './dreams-run.ts'

/**
 * 记忆梦境的整理步骤：整理主题索引（归主题、改名、合并、调顺序、改说明，和手动「整理一次索引」同一套提示词和操作），
 * 再逐条整理记忆（刷新摘要和标签、建关联、调注入档位）。调模型都在锁外；每个操作经 ctx 落盘，落盘前按当下的数据核对，
 * 对不上、目标锁定、超出改动量上限（只算改写记忆文件的）的跳过，不影响其余。模型给的值不能用的操作丢掉，同样列进结果。一批模型调用失败就停（这一步算没做完）；
 * 回复读不出的那一批不出操作，其余批照做，做完这一步按没做完收：这次运行不记成做完，下次重来。读记忆读不全也按没做完收。
 * 逐条整理在名额用完之后只再处理这次已经改动过的记忆；没处理到的告诉 ctx，不进这次的基线。整理主题索引不占名额。
 */

/** 模型给的值不能用（不认识的记忆、坏格式、超出限制）：跳过的原因。 */
const UNUSABLE = 'unusable'

export interface TidyStepDeps {
  store: Pick<MemoryStore, 'readIndex' | 'readRaw' | 'maintain'>
  maxTopics: () => number
  now: () => number
  /** 类型默认的注入档位。 */
  typeRecall: (type: string) => RecallTier
}

/** 问一批：回复读不出时重问一次；还读不出返回 undefined。模型出错原样抛出。用量随回调记进这次运行。 */
export async function ask<T>(llm: SemanticLlm, prompt: { system: string; user: string }, parse: (raw: string) => T | undefined, ctx: DreamsStepContext): Promise<T | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await llm.complete(attempt === 0 ? prompt : { ...prompt, user: prompt.user + JSON_RETRY_HINT }, ctx.signal, (tokens) => { void ctx.addUsage(tokens) })
    const parsed = parse(raw)
    if (parsed !== undefined) return parsed
    if (ctx.shouldStop()) return undefined
  }
  return undefined
}

/**
 * 这个范围这一层在用的记忆，一个 id 一份；同一层里同 id 有几份在用的，分不清该动哪一份，不交给模型。
 * 读不全（有文件解析不了、目录读不了或缺标记）抛错：不知道少了哪些，不能当成没有。
 */
export async function activeMembers(store: Pick<MemoryStore, 'readRaw'>, ctx: DreamsStepContext): Promise<Map<string, MemoryRecord>> {
  const read = await store.readRaw(ctx.scope)
  if (!isCompleteRead(read)) throw new Error('这个范围的记忆读不全')
  const byId = new Map<string, MemoryRecord>()
  const doubled = new Set<string>()
  for (const { record } of read.records) {
    if (record.status !== 'active') continue
    if (byId.has(record.id)) doubled.add(record.id)
    byId.set(record.id, record)
  }
  for (const id of doubled) byId.delete(id)
  return byId
}

export const unreadError = (count: number) => new Error(`有 ${count} 批模型的回复读不出，这一批没有整理`)

/** 整理主题索引：先看主题目录（已有主题时），再按批看成员怎么归。只挪索引行，不受改动量上限约束。 */
export const organizeIndexStep = (deps: TidyStepDeps): DreamsStep => ({
  name: 'organize-index',
  needsChanges: true,
  async run(ctx) {
    const load = async (): Promise<{ files: IndexFiles; records: Map<string, MemoryRecord>; members: Map<string, OrganizeMember> } | undefined> => {
      const files = await deps.store.readIndex(ctx.scope)
      if (files === undefined) return undefined
      const records = await activeMembers(deps.store, ctx)
      const members = new Map([...records.values()].map(r => [r.id, { id: r.id, name: r.name, summary: r.summary, updatedAt: r.updatedAt }]))
      return { files, records, members }
    }
    const first = await load()
    if (first === undefined || first.members.size === 0) return
    const llm = await ctx.llm()
    let unread = 0
    let applied = 0
    /** 问一批、把给的操作逐个落盘。返回 false：该停了。 */
    const round = async (only: ReadonlySet<string> | undefined): Promise<boolean> => {
      const state = await load()
      if (state === undefined) return false
      const groups = only === undefined ? [] : organizeGroups(state.files, state.members, only)
      if (only !== undefined && groups.length === 0) return true
      // 要挪的成员按这一刻读到的版本复核；归组只认给模型看过的成员
      const basis = new Map([...state.records.values()].map(r => [r.id, scanFingerprint(r)]))
      const shown = new Set(groups.flatMap(g => g.members.map(m => m.id)))
      const prompt = buildOrganizePrompt(organizeDirectory(state.files, state.members, deps.now()), groups, deps.maxTopics())
      const parsed = await ask(llm, prompt, raw => parseOrganizeOutput(raw, shown), ctx)
      if (ctx.shouldStop()) return false
      if (parsed === undefined) {
        unread++
        return true
      }
      for (let i = 0; i < parsed.dropped; i++) ctx.skip({ kind: 'operation', target: '', reason: UNUSABLE })
      for (const op of parsed.ops) {
        if (ctx.shouldStop()) return false
        if ((await ctx.applyIndex(op, { maxTopics: deps.maxTopics(), basis })).kind === 'applied') applied++
      }
      return true
    }
    try {
      // 还没有主题时没有目录可调，直接看成员
      if (organizeDirectory(first.files, first.members, deps.now()).length > 0 && !(await round(undefined))) return
      const after = await load()
      for (const batch of after === undefined ? [] : organizeBatches(after.files, after.members)) {
        if (!(await round(new Set(batch)))) return
      }
    } finally {
      // 入口投影（MEMORY.md）跟着索引重新生成
      if (applied > 0) await deps.store.maintain(ctx.scope)
    }
    if (unread > 0) throw unreadError(unread)
  },
})

/** 一次应用装多少个操作：同一条记忆的几个操作放在同一次里（后面的操作要按前面刚写下的核对），一次不超过上限。 */
function chunksByTarget(ops: readonly ChangeOp[], max = DREAMS_APPLY_MAX_OPS): ChangeOp[][] {
  const byTarget = new Map<string, ChangeOp[]>()
  for (const op of ops) byTarget.set(op.memoryId, [...(byTarget.get(op.memoryId) ?? []), op])
  const chunks: ChangeOp[][] = []
  let chunk: ChangeOp[] = []
  for (const group of byTarget.values()) {
    if (chunk.length > 0 && chunk.length + group.length > max) {
      chunks.push(chunk)
      chunk = []
    }
    chunk.push(...group)
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * 逐条整理记忆：上一次做完之后变了的记忆按主题分批交给模型，刷新摘要和标签、建关联、调注入档位。
 * 名额用完之后只把这次已经改动过的交给模型；没交给模型的、操作因名额跳过的，记成这次没处理到。
 */
export const tidyMemoriesStep = (deps: TidyStepDeps): DreamsStep => ({
  name: 'tidy-memories',
  needsChanges: true,
  async run(ctx) {
    const files = await deps.store.readIndex(ctx.scope)
    // 前面的步骤留给下次运行的（这次合并过的存活那条）不再交给模型
    const changed = new Map([...(await activeMembers(deps.store, ctx))].filter(([id]) => ctx.isChanged(id) && !ctx.isHeldForNextRun(id)))
    if (files === undefined || changed.size === 0) return
    const llm = await ctx.llm()
    let unread = 0
    let seq = 0
    const newOpId = () => `${ctx.runId}:tidy:${++seq}`
    for (const batch of tidyBatches(files, changed, deps.typeRecall)) {
      if (ctx.shouldStop()) return
      // 名额用完了：没占名额的再问也只会被跳过，留给下次
      const closed = batch.filter(id => !ctx.canChange(id))
      ctx.markUnprocessed(closed)
      if (closed.length === batch.length) continue
      // 问之前现读：操作的依据和预期值都按这一版，落盘前对不上就跳过
      const read = await activeMembers(deps.store, ctx)
      const batchRead = new Map(batch.flatMap(id => { const r = read.get(id); return r === undefined || closed.includes(id) ? [] : [[id, r] as const] }))
      if (batchRead.size === 0) continue
      const parse = (raw: string) => parseTidyOutput(raw, batchRead, newOpId, { typeRecall: deps.typeRecall, maxOpsPerMemory: DREAMS_APPLY_MAX_OPS })
      const parsed = await ask(llm, buildTidyPrompt(files, read, new Set(batchRead.keys()), deps.typeRecall), parse, ctx)
      if (ctx.shouldStop()) return
      if (parsed === undefined) {
        unread++
        continue
      }
      for (const d of parsed.dropped) ctx.skip({ ...d, reason: UNUSABLE })
      for (const chunk of chunksByTarget(parsed.ops)) {
        const r = await ctx.apply(chunk)
        ctx.markUnprocessed(r.outcomes.flatMap(o => (o.kind === 'skipped' && o.reason === 'quota' ? [o.memoryId] : [])))
        if (ctx.shouldStop()) return
      }
    }
    if (unread > 0) throw unreadError(unread)
  },
})

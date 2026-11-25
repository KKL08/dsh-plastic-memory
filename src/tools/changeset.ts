import type { ChangeAnchor, ChangeFields } from '../change.ts'
import { commitChange, isSameRecord } from '../commit-change.ts'
import { isPendingDelegated, memoryRecordSchema, type LinkIds, type MemoryRecord, type MergedInto } from '../record-schema.ts'
import { scopeAt, scopeOfLedger } from '../scope.ts'
import { markDeleted, type MemoryLogger, type MemoryStore } from '../store.ts'
import { hasSecret } from '../secrets.ts'
import { mergeLinks, resolveLinks } from '../links.ts'
import { newWriteOp } from '../storage/table.ts'
import { layerOf } from '../storage/history.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import { kindOf, type SnapshotRecord } from '../governance/schema.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import { CHANGE_RECEIPT_STEP, changeReceiptStep, changeUndoneStep, ledgerSteps } from '../governance/op-steps.ts'
import { writeGate } from '../governance/write-gate.ts'
import {
  CREATE_RECEIPT_FIELDS, advance, changeKindOf, checkOp, copyKey, createdFrom, newProgress, receiptOf, revertBlock, reverted,
  type BatchProgress, type ChangeOp, type ChangeOpKind, type ChangeReceipt, type PatchField, type ReceiptField, type RevertBlock, type SkipReason,
} from '../governance/changeset.ts'
import { locateCopy } from './workspace-gate.ts'

/**
 * 变更集的执行器：把一组操作逐个落盘、逐个记回执，按回执逐个还原。每个操作各占一次写入段，核对（governance/changeset.ts 的 checkOp）
 * 在段里按刚读到的记录做；回执是写入提交后的一步，中断后由下一次进写入段的人补上。
 */

export interface ChangesetDeps {
  store: MemoryStore
  snapshots: SnapshotStore
  decisions: PendingDecisionsStore
  mergeWindowMs?: number
  log?: MemoryLogger
}

export interface ApplyOptions {
  /** 回执记到哪条账本条目上（调用方先建好：addChangeRun，或已有的未决条目）。 */
  entryId: string
  /** 谁写的：界面、记忆梦境……记进操作日志和最近一次内容改动。 */
  by: string
  at: number
  /** 发起的会话：状态变化的合并窗口只对同一个会话开。 */
  sessionId?: string
  /** 后台写入（没有用户逐字确认）：改写稿里的疑似密钥只放行原记忆里已有的。 */
  isSecretChecked: boolean
  /** 一项对不上就整批退：按回执逆序撤掉这批已做的（整理所选、采纳方案）。缺省各做各的。 */
  isAllOrNothing?: boolean
  /** 界面里用户亲手定的稿：确认时间记为这一刻；子 agent 写的待确认记录改过就算由用户升档。 */
  isUserConfirmed?: boolean
  /** 补证的出处。 */
  anchor?: ChangeAnchor
  /** 依据按什么指纹比（见 CheckInput.fingerprint）；缺省扫描指纹。 */
  fingerprint?: (r: MemoryRecord) => string
  /** 软删时哪些算含密钥、软删不了；缺省两级都算。 */
  isSecret?: (current: MemoryRecord) => boolean
  /**
   * 每个操作（或每一组）开始之前问一次：为真就停，后面的都不做、各记一条 stopped，已经开始的那一组做完。
   * 后台运行让路用；整批退的那一批不看它（要么全做要么全退）。
   */
  shouldStop?: () => boolean
  /**
   * 每个操作（或每一组）开始之前问一次放不放行：applied 是这一批到这时做成了、仍留在盘上的（见 isOnDisk：撤回干净的组不算）。不放行的这一项（这一组）
   * 不做、各记一条 quota，后面的照问。记忆梦境按一次运行的改动量上限用它；整批退的那一批不看它。
   */
  admit?: (unit: readonly ChangeOp[], applied: readonly OpOutcome[]) => boolean
}

/**
 * has-secret：要软删的那条含密钥；link-invalid：要挂的 id 不合规（detail 是给模型看的原因）；invalid：拼出来的记录过不了格式校验；
 * changed：落盘那一刻文件被手改了；locked：这个发起方不许改这条（见 writeGate）；group：同组的另一步没过，这一步跟着不做；
 * stopped：调用方叫停了（shouldStop），这一项没开始；quota：调用方不放行（admit，记忆梦境一次运行的改动量上限），这一项没做。
 */
export type ApplySkipReason = SkipReason | 'has-secret' | 'link-invalid' | 'invalid' | 'changed' | 'locked' | 'group' | 'stopped' | 'quota'

/** 一组的结果。applied：全做成了；skipped：第一步之前的核对没过，什么都没写；rolled-back：做到一半有一步不成，已做的按回执撤回了。 */
export interface GroupResult {
  group: string
  state: 'applied' | 'skipped' | 'rolled-back'
  /** 撤回出错、仍是这次写下的样子的：回执留着，组仍记作没做完，下次再撤。 */
  kept?: string[]
  /** 已被别处接着改过、撤不回的：回执拿掉了。 */
  unrecorded?: string[]
}

export type OpOutcome =
  | { kind: 'applied'; opId: string; opKind: ChangeOpKind; memoryId: string; /** 这次写入的操作 id。 */ writeOp: string; written: MemoryRecord; fields: ReceiptField[]; snapshotId?: string; links?: { added: LinkIds; removed: LinkIds } }
  /** 核对过了，不用写（keep）。 */
  | { kind: 'checked'; opId: string; memoryId: string }
  | { kind: 'skipped'; opId: string; memoryId: string; reason: ApplySkipReason; detail?: string }

export interface ApplyResult {
  /** 各项的结果。撤回了的组，它的各项仍是撤回之前的结果：写报告以 groups 为准。 */
  outcomes: OpOutcome[]
  /** 带 group 的操作按组的结果（整批退的那一批不分组，没有这一项）。 */
  groups?: GroupResult[]
  /** 整批退了：outcomes 里是退之前各项的结果，applied 的那些已经按回执撤回（没撤回的见下面两项）。 */
  isRolledBack?: boolean
  /** 整批退时撤回出错、仍是这次写下的样子的：回执留在条目上，可以再撤。 */
  kept?: string[]
  /** 整批退时已被别处接着改过、撤不回的：回执拿掉了，停在别处的版本。 */
  unrecorded?: string[]
  /** 整批退是因为某一项写入抛了错：错误原样带回，由调用方决定抛不抛。 */
  thrown?: unknown
  /** 调用方中途叫停了（shouldStop）：没开始的各项在 outcomes 里是 stopped。 */
  isStopped?: boolean
}

function ensureSteps(deps: ChangesetDeps): void {
  if (!deps.store.hasStep(CHANGE_RECEIPT_STEP)) deps.store.registerSteps(ledgerSteps(deps.decisions, deps.log))
}

/**
 * 应用一个变更集。按顺序逐个操作：进写入段，读目标和依据，核对，写，记回执。对不上的操作跳过、原因记在结果里，后面的照做；
 * isAllOrNothing 时第一项对不上（补丁和现状一样、没有可写的不算）或写入抛错就停，把已做的按回执逆序撤掉。
 * 带 group 的连续几个操作是一组：第一步之前先把组内的目标和依据读齐核对一遍，有一条不过整组不做；做到一半有一步不成，
 * 组内已做的按回执撤回，后面的操作照常。isAllOrNothing 时整批的规则优先，不另分组。
 * 动手之前先把以前中断留下的半个组撤掉（settleOpenGroups）。
 */
export async function applyChangeset(ops: readonly ChangeOp[], opts: ApplyOptions, deps: ChangesetDeps): Promise<ApplyResult> {
  ensureSteps(deps)
  await settleOpenGroups(deps, { by: opts.by, own: opts.entryId })
  const progress = newProgress()
  const outcomes: OpOutcome[] = []
  const groups: GroupResult[] = []
  const done = (): ApplyResult => ({ outcomes, ...(groups.length > 0 ? { groups } : {}) })
  const segments = segmentsOf(ops, opts.isAllOrNothing === true)
  for (const [i, segment] of segments.entries()) {
    if (opts.isAllOrNothing !== true && opts.shouldStop?.() === true) {
      for (const rest of segments.slice(i)) for (const op of rest.ops) outcomes.push({ kind: 'skipped', opId: op.id, memoryId: op.memoryId, reason: 'stopped' })
      return { ...done(), isStopped: true }
    }
    if (opts.isAllOrNothing !== true && opts.admit !== undefined) {
      const applied = outcomes.filter(o => o.kind === 'applied' && isOnDisk(o, groups, ops))
      if (!opts.admit(segment.ops, applied)) {
        for (const op of segment.ops) outcomes.push({ kind: 'skipped', opId: op.id, memoryId: op.memoryId, reason: 'quota' })
        continue
      }
    }
    if (segment.group !== undefined) {
      const r = await applyGroup(segment.group, segment.ops, segment.isBroken, opts, deps, progress)
      outcomes.push(...r.outcomes)
      groups.push(r.result)
      if (r.thrown !== undefined) throw r.thrown.error
      continue
    }
    const [op] = segment.ops
    const { outcome, thrown } = await applyOne(op!, opts, deps, progress)
    if (outcome !== undefined) outcomes.push(outcome)
    if (thrown !== undefined) {
      if (opts.isAllOrNothing !== true) throw thrown.error
      return { outcomes, isRolledBack: true, thrown: thrown.error, ...(await rollBack(receiptsOfOutcomes(outcomes), opts, deps)) }
    }
    if (outcome?.kind === 'applied') advance(progress, op!, outcome.written, opts.fingerprint)
    if (outcome?.kind === 'skipped' && outcome.reason !== 'no-change' && opts.isAllOrNothing === true) {
      return { outcomes, isRolledBack: true, ...(await rollBack(receiptsOfOutcomes(outcomes), opts, deps)) }
    }
  }
  return done()
}

/**
 * 做成了的这一项现在还算不算这批留在盘上的：不在组里、或组做成了的算；组撤回了的，撤回出错留着（kept）、
 * 已被别处接着改过撤不回（unrecorded）的那几条记忆上的仍算（写下过、没撤回），其余撤干净的不算。
 */
export function isOnDisk(outcome: OpOutcome, groups: readonly GroupResult[], ops: readonly ChangeOp[]): boolean {
  const group = ops.find(op => op.id === outcome.opId)?.group
  const result = group === undefined ? undefined : groups.find(g => g.group === group)
  return result === undefined || result.state === 'applied' || [...(result.kept ?? []), ...(result.unrecorded ?? [])].includes(outcome.memoryId)
}

interface Segment { group?: string; ops: ChangeOp[]; /** 同一个 group 的操作不连续：整组不做。 */ isBroken: boolean }

/** 按组切段：连续的同组操作一段，其余各自一段。整批退的那一批不分组。 */
function segmentsOf(ops: readonly ChangeOp[], isFlat: boolean): Segment[] {
  const segments: Segment[] = []
  const seen = new Set<string>()
  const broken = new Set<string>()
  for (const op of ops) {
    const last = segments.at(-1)
    if (isFlat || op.group === undefined) segments.push({ ops: [op], isBroken: false })
    else if (last?.group === op.group) last.ops.push(op)
    else {
      if (seen.has(op.group)) broken.add(op.group)
      seen.add(op.group)
      segments.push({ group: op.group, ops: [op], isBroken: false })
    }
  }
  return segments.map(s => (s.group !== undefined && broken.has(s.group) ? { ...s, isBroken: true } : s))
}

const cloneProgress = (p: BatchProgress): BatchProgress => ({
  written: new Map([...p.written].map(([key, fields]) => [key, new Map(fields)])), fingerprints: new Map(p.fingerprints), forgotten: new Set(p.forgotten),
})

/** 做一组。第一步之前的核对没过：整组跳过，什么都不写。做到一半不成：撤回组内已做的，批内进度放回组开始之前。 */
async function applyGroup(
  group: string, ops: readonly ChangeOp[], isBroken: boolean, opts: ApplyOptions, deps: ChangesetDeps, progress: BatchProgress,
): Promise<{ outcomes: OpOutcome[]; result: GroupResult; thrown?: { error: unknown } }> {
  const allSkipped = (failed?: OpOutcome): OpOutcome[] => ops.map(op => (failed !== undefined && failed.opId === op.id
    ? failed
    : { kind: 'skipped', opId: op.id, memoryId: op.memoryId, reason: failed === undefined ? 'unsupported' : 'group' }))
  if (isBroken) return { outcomes: allSkipped(), result: { group, state: 'skipped' } }
  const failed = await precheck(ops, opts, deps, progress)
  if (failed !== undefined) return { outcomes: allSkipped(failed), result: { group, state: 'skipped' } }
  if (!(await deps.store.writeSection(() => deps.decisions.openGroup(opts.entryId, group)))) throw new Error(`变更集的条目 ${opts.entryId} 不在账本里，这一组没有做`)
  const before = cloneProgress(progress)
  const outcomes: OpOutcome[] = []
  let thrown: { error: unknown } | undefined
  let isFailed = false
  for (const op of ops) {
    const r = await applyOne(op, opts, deps, progress)
    if (r.outcome !== undefined) outcomes.push(r.outcome)
    if (r.outcome?.kind === 'applied') advance(progress, op, r.outcome.written, opts.fingerprint)
    thrown = r.thrown
    isFailed = thrown !== undefined || (r.outcome?.kind === 'skipped' && r.outcome.reason !== 'no-change')
    if (isFailed) break
  }
  const close = () => deps.store.writeSection(() => deps.decisions.closeGroup(opts.entryId, group)).catch(() => {})
  if (!isFailed) {
    // 没拿掉标记只会让下次把这一组当没做完撤回：不丢数据，不为它另加状态
    await close()
    return { outcomes, result: { group, state: 'applied' } }
  }
  const left = await rollBack(receiptsOfOutcomes(outcomes, group), opts, deps)
  Object.assign(progress, before)
  if (left.kept === undefined) await close()
  // 没做的几步也交代一句：同组的另一步没过
  const rest: OpOutcome[] = ops.filter(op => !outcomes.some(o => o.opId === op.id)).map(op => ({ kind: 'skipped', opId: op.id, memoryId: op.memoryId, reason: 'group' }))
  return { outcomes: [...outcomes, ...rest], result: { group, state: 'rolled-back', ...left }, ...(thrown !== undefined ? { thrown } : {}) }
}

/**
 * 一组第一步之前的核对：一个写入段里把组内每个操作的目标和依据读齐，过同一个核对（checkOp）、写入许可、软删的密钥检查。
 * 补丁和现状一样、不用写的那一步也要过写入许可：它锁着时同组别的几步照做，等于绕开了锁。
 * 返回第一个不过的；都过返回 undefined。同一条记忆在组里的第二个操作不在这里查（它要按前一步写完的样子比）。
 */
async function precheck(ops: readonly ChangeOp[], opts: ApplyOptions, deps: ChangesetDeps, progress: BatchProgress): Promise<OpOutcome | undefined> {
  return deps.store.writeSection(async () => {
    const seen = new Set<string>()
    for (const op of ops) {
      if (seen.has(copyKey(op))) continue
      seen.add(copyKey(op))
      const { target, check } = await readAndCheck(op, opts, deps, cloneProgress(progress))
      const skipped = (reason: ApplySkipReason, memoryId = op.memoryId): OpOutcome => ({ kind: 'skipped', opId: op.id, memoryId, reason })
      if (check.kind === 'skip' && check.reason !== 'no-change') return skipped(check.reason, check.memoryId)
      if (target === undefined) continue
      if (writeGate(opts.by, target, opts.at) !== undefined) return skipped('locked')
      if (check.kind === 'forget' && (opts.isSecret ?? hasSecret)(target)) return skipped('has-secret')
    }
    return undefined
  })
}

/** 读一个操作的目标和依据（按读到时的作用域找那一份），核对。在写入段里调用。 */
async function readAndCheck(op: ChangeOp, opts: ApplyOptions, deps: ChangesetDeps, progress: BatchProgress) {
  // 目标按读到时的作用域找那一份：期间搬走了，原处就没有它，按不在处理（同 id 在别处的副本不是这次判断的对象）
  const scope = scopeOfLedger(op.scopeKey)
  const target = await locateCopy(deps.store, op.memoryId, scope)
  const basis = new Map<string, MemoryRecord>()
  for (const b of op.basis) {
    if (copyKey(b) === copyKey(op)) continue
    const record = await locateCopy(deps.store, b.memoryId, scopeOfLedger(b.scopeKey))
    if (record !== undefined) basis.set(copyKey(b), record)
  }
  const check = checkOp(op, { target, basis, progress, isSecretChecked: opts.isSecretChecked, ...(opts.fingerprint !== undefined ? { fingerprint: opts.fingerprint } : {}) })
  return { scope, target, basis, check }
}

/**
 * 把以前中断留下的半个组撤掉：进写入段（操作日志的补做先跑完，提交了的那一步的回执补齐），带着没做完的组的条目逐条占住
 * （占不到的是别人正在跑，不碰），把组内已做的按回执逆序撤回，撤干净的拿掉标记。own 是调用方自己已经占着的那条。
 * 每次应用变更集之前、条目撤销之前、记忆梦境每次运行开头调用。
 */
export async function settleOpenGroups(deps: ChangesetDeps, opts: { by: string; own?: string }): Promise<void> {
  ensureSteps(deps)
  await deps.store.writeSection(async () => {
    for (const entry of await deps.decisions.withOpenGroups()) {
      const release = entry.id === opts.own ? async () => {} : await deps.decisions.hold(entry.id)
      if (release === undefined) continue
      try {
        for (const group of entry.openGroups ?? []) {
          const receipts = (await receiptsOfEntry(deps.decisions, entry.id)).filter(r => r.group === group)
          const left = await rollBack(receipts, { entryId: entry.id, by: opts.by }, deps)
          if (left.kept === undefined) await deps.decisions.closeGroup(entry.id, group)
        }
        // 记忆梦境的批次：还有记忆的回执等着补记（文件已提交）时条目留着，不然那次改动就没了撤销入口
        if (entry.id !== opts.own) await deps.decisions.removeEmptyRun(entry.id, kindOf(entry) === 'brewing-dreams-run' ? () => hasPendingReceipts(deps.store, entry.id) : undefined)
      } finally {
        await release().catch(() => {})
      }
    }
  })
}

/** 这条条目还有记忆的回执等着补记：操作日志里有记它回执的步骤没做完（文件提交了，记账失败）。 */
export function hasPendingReceipts(store: Pick<MemoryStore, 'hasPendingStep'>, entryId: string): boolean {
  return store.hasPendingStep(step => step.kind === CHANGE_RECEIPT_STEP && (step as { entryId?: unknown }).entryId === entryId)
}

/** 把一条条目上的回执全部按逆序撤掉（调用方结账没成时用）。分类同整批退。 */
export async function rollBackEntry(entryId: string, opts: { by: string }, deps: ChangesetDeps): Promise<{ kept?: string[]; unrecorded?: string[] }> {
  return rollBack(await receiptsOfEntry(deps.decisions, entryId), { entryId, by: opts.by }, deps)
}

/** 这批写成的各项的回执，按做的先后。按手里写下的那份现算，不等账本：账本一时写不进去时照样退得回去。 */
function receiptsOfOutcomes(outcomes: readonly OpOutcome[], group?: string): ChangeReceipt[] {
  return outcomes.flatMap(o => (o.kind !== 'applied' ? [] : [receiptOf({
    id: o.opId, op: o.writeOp, kind: o.opKind, fields: o.fields, ...(group !== undefined ? { group } : {}),
    ...(o.snapshotId !== undefined ? { snapshotId: o.snapshotId } : {}), ...(o.links !== undefined ? { links: o.links } : {}),
  }, o.written)]))
}

/** 按回执逆序撤掉这批已做的。 */
async function rollBack(receipts: readonly ChangeReceipt[], opts: Pick<ApplyOptions, 'entryId' | 'by'>, deps: ChangesetDeps): Promise<{ kept?: string[]; unrecorded?: string[] }> {
  const kept: string[] = []
  const unrecorded: string[] = []
  for (const receipt of [...receipts].reverse()) {
    try {
      const r = await revertChange(opts.entryId, receipt, { by: opts.by }, deps)
      if (r.kind === 'reverted') {
        // 整批退回的这一项当没发生过：它那份改前快照不留
        if (receipt.snapshotId !== undefined) await deps.snapshots.discard(receipt.snapshotId).catch(() => {})
        continue
      }
      // 已被别处接着改过：撤不回，也不再算这次写下的，回执拿掉
      await deps.store.writeSection(() => deps.decisions.dropChange(opts.entryId, receipt.op)).catch(() => {})
      unrecorded.push(receipt.memoryId)
    } catch {
      // 没撤回、仍是这次写下的：回执要在账上，之后才撤得了（写完就抛错的那一项，记回执的步骤可能还没做；重复记不会多一条）
      await deps.store.writeSection(() => deps.decisions.appendChange(opts.entryId, receipt)).catch(() => {})
      kept.push(receipt.memoryId)
    }
  }
  return { ...(kept.length > 0 ? { kept } : {}), ...(unrecorded.length > 0 ? { unrecorded } : {}) }
}

/** 条目上现有的回执（未决、已结清的都读）。 */
export async function receiptsOfEntry(decisions: PendingDecisionsStore, entryId: string): Promise<ChangeReceipt[]> {
  const entry = (await decisions.get(entryId)) ?? (await decisions.listSettled()).find(d => d.id === entryId)
  return entry?.changes ?? []
}

/** 一个操作动手过程中攒下的：写方法抛错时凭它判断落没落盘、补出回执。 */
interface Landed { target?: MemoryRecord; /** 这次要写下的那一版，落盘之前定好。 */ planned?: MemoryRecord; opKind?: ChangeOpKind; writeOp?: string; fields?: ReceiptField[]; links?: { added: LinkIds; removed: LinkIds }; snapshotId?: string }

/**
 * 做一个操作。写入抛错时（文件写完之后维护目录、记账出错）不知道落没落盘：按这次写入的操作 id 找文件上的提交标记，
 * 找到就是写下了，照样当写成的交回，连同错误。交回的是落盘之前定好的那一版，不是这时重读到的：提交标记只说明这次写过，
 * 文件此刻可能已被手改，按重读的算回执会让退回把手改盖掉。
 */
async function applyOne(
  op: ChangeOp, opts: ApplyOptions, deps: ChangesetDeps, progress: ReturnType<typeof newProgress>,
): Promise<{ outcome?: OpOutcome; thrown?: { error: unknown } }> {
  const landed: Landed = {}
  return deps.store.writeSection(async () => {
    // 拍了改前快照却没写成的（落盘前发现被别处改过、写盘报错）：那份快照没有对应的写入，不留
    const dropSnapshot = async () => { if (landed.snapshotId !== undefined) await deps.snapshots.discard(landed.snapshotId).catch(() => {}) }
    try {
      const outcome = await applyInSection(op, opts, deps, progress, landed)
      if (outcome.kind === 'skipped') await dropSnapshot()
      return { outcome }
    } catch (error) {
      // 抛错时不知道落没落盘：按这次写入的提交标记去找，找到就是已经写下了，照做成了记（调用方据此退回或保留）
      const { target, writeOp } = landed
      let isSureUnwritten = target === undefined || writeOp === undefined
      const found = target === undefined || writeOp === undefined
        ? undefined
        : (await deps.store.locateWrittenBy(target.id, scopeAt(target.workspacePath), { id: writeOp, steps: [] }).then(
            (found) => { isSureUnwritten = found === undefined; return found },
            () => undefined,
          ))?.record
      if (found === undefined || writeOp === undefined) {
        // 查不出落没落盘（读出错）时快照留着：万一写下了，之后补记的回执还要靠它撤
        if (isSureUnwritten) await dropSnapshot()
        return { thrown: { error } }
      }
      return {
        thrown: { error },
        outcome: {
          kind: 'applied' as const, opId: op.id, opKind: landed.opKind ?? (op.kind as ChangeOpKind), memoryId: op.memoryId, writeOp, written: landed.planned ?? found,
          fields: landed.fields ?? [], ...(landed.snapshotId !== undefined ? { snapshotId: landed.snapshotId } : {}), ...(landed.links !== undefined ? { links: landed.links } : {}),
        },
      }
    }
  })
}

async function applyInSection(
  op: ChangeOp, opts: ApplyOptions, deps: ChangesetDeps, progress: ReturnType<typeof newProgress>, landed: Landed,
): Promise<OpOutcome> {
  const { store } = deps
  const skipped = (reason: ApplySkipReason, memoryId = op.memoryId, detail?: string): OpOutcome =>
    ({ kind: 'skipped', opId: op.id, memoryId, reason, ...(detail !== undefined ? { detail } : {}) })
  return store.writeSection(async (): Promise<OpOutcome> => {
    const { scope, target, basis, check } = await readAndCheck(op, opts, deps, progress)
    // 组里不用写的一步同样按刚读到的这一版过写入许可：第一步之前的核对之后才上的锁，也不能让同组别的几步照做
    if (check.kind === 'skip' && check.reason === 'no-change' && op.group !== undefined && target !== undefined && writeGate(opts.by, target, opts.at) !== undefined) return skipped('locked')
    if (check.kind === 'skip') return skipped(check.reason, check.memoryId)
    if (check.kind === 'create') return create(op, check.from, opts, deps, skipped, landed)
    if (target === undefined) return { kind: 'checked', opId: op.id, memoryId: op.memoryId }
    // 写入许可按刚读到的这一版判（核对过不用写的也算过了一遍：这个发起方本来就不该碰它）
    if (writeGate(opts.by, target, opts.at) !== undefined) return skipped('locked')
    if (check.kind === 'none') return { kind: 'checked', opId: op.id, memoryId: op.memoryId }
    const opKind = op.kind as ChangeOpKind
    landed.target = target
    landed.opKind = opKind
    if (check.kind === 'forget') return forget(op, target, basis, opts, deps, skipped, landed)

    // 关联和前提的增量在 commitChange 的写入段里按最新值算，算出来的实际增减记进回执
    let links: { added: LinkIds; removed: LinkIds } | undefined
    let fields: ReceiptField[] = []
    const prepare = async (current: MemoryRecord): Promise<{ fields: ChangeFields } | { stop: OpOutcome }> => {
      if (check.kind === 'write') {
        fields = Object.keys(check.fields) as PatchField[]
        if (opts.isUserConfirmed !== true || !isPendingDelegated(current)) return { fields: check.fields as ChangeFields }
        fields = [...fields, 'delegation']
        return { fields: { ...check.fields, delegation: { ...current.delegation!, reviewed: { by: 'user', at: opts.at } } } as ChangeFields }
      }
      if (check.kind !== 'link') return { fields: {} }
      const add = op.links?.add ?? {}
      const resolved = await resolveLinks(store, { id: current.id, scope }, add)
      if ('problem' in resolved) return { stop: skipped('link-invalid', op.memoryId, resolved.problem) }
      const merged = mergeLinks(current, resolved)
      if ('problem' in merged) return { stop: skipped('link-invalid', op.memoryId, merged.problem) }
      const drop = { related: op.links?.remove?.related ?? [], premises: op.links?.remove?.premises ?? [] }
      const related = (merged.fields.related ?? []).filter(id => !drop.related.includes(id))
      const premises = (merged.fields.premises ?? []).filter(p => !drop.premises.includes(p.id))
      const removed = {
        related: (current.related ?? []).filter(id => drop.related.includes(id)),
        premises: (current.premises ?? []).filter(p => drop.premises.includes(p.id)).map(p => p.id),
      }
      links = { added: merged.added, removed }
      if ([...links.added.related, ...links.added.premises, ...removed.related, ...removed.premises].length === 0) return { stop: skipped('no-change') }
      // 清空的字段去掉这个键，不留空数组
      return { fields: { related: related.length > 0 ? related : undefined, premises: premises.length > 0 ? premises : undefined } }
    }
    // 注入档位、关联和前提是元数据：不动修改时间和最近一次内容改动
    const kind = check.kind === 'corroborate' ? 'corroborate' : check.kind === 'link' || opKind === 'set-recall' ? 'meta' : changeKindOf(op)
    const r = await commitChange<OpOutcome>({
      target,
      scope,
      kind,
      prepare,
      by: opts.by,
      at: opts.at,
      ...(check.kind === 'corroborate' && opts.anchor !== undefined ? { anchor: opts.anchor } : {}),
      ...(check.kind === 'corroborate' ? { isSnapshotForced: true } : {}),
      ...(opts.isUserConfirmed === true ? { isUserConfirmed: true } : {}),
      ...(op.reason !== undefined ? { reason: op.reason } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      // 核对是按上面读到的那一版做的：落盘前这条和它不是同一版（被不拿锁的手改过）就不写
      isBlocked: current => !isSameRecord(current, target),
      onOp: (opId, planned) => Object.assign(landed, { writeOp: opId, planned }),
      steps: (snapshotId) => {
        Object.assign(landed, { fields, snapshotId, ...(links !== undefined ? { links } : {}) })
        return [changeReceiptStep({ entryId: opts.entryId, opId: op.id, opKind, fields, snapshotId, ...(links !== undefined ? { links } : {}), ...groupOf(op) })]
      },
    }, deps)
    if (r.kind === 'stopped') return r.stop
    if (r.kind === 'changed') return skipped('changed')
    if (r.kind === 'invalid') return skipped('invalid', op.memoryId, r.reason)
    return {
      kind: 'applied', opId: op.id, opKind, memoryId: op.memoryId, writeOp: r.op, written: r.record, fields,
      ...(r.snapshotId !== undefined ? { snapshotId: r.snapshotId } : {}), ...(links !== undefined ? { links } : {}),
    }
  })
}

const groupOf = (op: ChangeOp) => (op.group !== undefined ? { group: op.group } : {})

/**
 * 新建（拆分出的一条）：内容是稿里的，其余从 from 继承。id 是操作里定好的：落盘那一刻那个作用域已经有它就不写。
 * 回执记内容字段的摘要，撤销时凭它判断还是不是这次写下的样子。
 */
async function create(
  op: ChangeOp, from: MemoryRecord, opts: ApplyOptions, deps: ChangesetDeps, skipped: (reason: ApplySkipReason, memoryId?: string, detail?: string) => OpOutcome, landed: Landed,
): Promise<OpOutcome> {
  const record = createdFrom(from, op.draft!, op.memoryId, opts.at)
  const parsed = memoryRecordSchema.safeParse(record)
  if (!parsed.success) return skipped('invalid', op.memoryId, parsed.error.issues.map(i => i.message).join('；'))
  const fields: ReceiptField[] = [...CREATE_RECEIPT_FIELDS]
  const writeOp = newWriteOp({ initiator: opts.by, steps: [changeReceiptStep({ entryId: opts.entryId, opId: op.id, opKind: 'create', fields, ...groupOf(op) })] })
  Object.assign(landed, { target: record, opKind: 'create', writeOp: writeOp.id, planned: record, fields })
  const written = await deps.store.put(record, scopeOfLedger(op.scopeKey), current => current !== undefined, writeOp)
  if (written === undefined) return skipped('id-taken')
  await deps.store.finishOp(writeOp, written)
  return { kind: 'applied', opId: op.id, opKind: 'create', memoryId: op.memoryId, writeOp: writeOp.id, written, fields }
}

/** 软删：含密钥的不删（由调用方先问用户）；改前那一版拍进快照，撤销时修改时间从它取。带去向的（并进另一条）记在软删的这一版上。 */
async function forget(
  op: ChangeOp, target: MemoryRecord, basis: ReadonlyMap<string, MemoryRecord>, opts: ApplyOptions, deps: ChangesetDeps, skipped: (reason: ApplySkipReason) => OpOutcome, landed: Landed,
): Promise<OpOutcome> {
  const { store } = deps
  if ((opts.isSecret ?? hasSecret)(target)) return skipped('has-secret')
  const at = Math.max(opts.at, target.updatedAt)
  const mergedInto = mergedIntoFor(op, target, basis)
  const snapshot = await deps.snapshots.capture({ operation: 'pre-forget', description: `删除记忆 ${target.id} 前`, records: [target] }, at)
  landed.snapshotId = snapshot.id
  const writeOp = newWriteOp({ initiator: opts.by, steps: [changeReceiptStep({ entryId: opts.entryId, opId: op.id, opKind: 'forget', fields: [], snapshotId: snapshot.id, ...groupOf(op) })] })
  const written = { ...markDeleted(target, at), ...(mergedInto !== undefined ? { mergedInto } : {}) }
  Object.assign(landed, { writeOp: writeOp.id, planned: written })
  const outcome = await store.softDeleteUnlessSecret(target, {
    at: scopeAt(target.workspacePath), now: at, op: writeOp, isChanged: cur => !isSameRecord(cur, target), ...(opts.isSecret !== undefined ? { isSecret: opts.isSecret } : {}), ...(mergedInto !== undefined ? { mergedInto } : {}),
  })
  if (outcome !== 'deleted') return skipped(outcome === 'has-secret' ? 'has-secret' : outcome === 'missing' ? 'gone' : 'changed')
  await store.finishOp(writeOp, written)
  return { kind: 'applied', opId: op.id, opKind: 'forget', memoryId: op.memoryId, writeOp: writeOp.id, written, fields: [], snapshotId: snapshot.id }
}

/**
 * 删除带的去向。并成版本的记下这条作为一版的结束时刻：当前页这个状态开始的时候，不早于这条自己的起点。
 */
function mergedIntoFor(op: ChangeOp, target: MemoryRecord, basis: ReadonlyMap<string, MemoryRecord>): MergedInto | undefined {
  if (op.into === undefined) return undefined
  const into = { id: op.into.memoryId, scopeKey: op.into.scopeKey, as: op.into.as }
  if (op.into.as !== 'version') return into
  const current = basis.get(copyKey(op.into))
  const startedAt = target.stateSince ?? target.createdAt
  return { ...into, endedAt: Math.max(startedAt, current?.stateSince ?? current?.createdAt ?? startedAt) }
}

/**
 * 撤销一次状态变化前，先把它在历史版本里留下的撤掉：这一版是它留的档就删掉，是并进别人留的那版就拿掉它那一笔（连同它给的原因）。
 * 按改前快照的 id 认是哪一次写入。先撤版本、再恢复记忆：中途断掉只是少一个历史版本，不会留下和当前页内容相同的版本。
 * 返回放回去的函数：恢复没成时照原样放回。
 */
export async function withdrawVersion(store: MemoryStore, before: SnapshotRecord, snapshotId: string): Promise<() => Promise<void>> {
  const found = await store.locate(before.id, scopeAt(before.workspacePath))
  if (found === undefined) return async () => {}
  const layer = layerOf(found)
  for (const version of await store.history.list(layer, before.id)) {
    const index = version.writes.findIndex(w => w.snapshot === snapshotId)
    if (index < 0) continue
    if (index === 0) await store.history.remove(layer, before.id, version.versionId)
    else await store.history.write(layer, { ...version, writes: version.writes.filter((_, i) => i !== index) })
    return () => store.history.write(layer, version)
  }
  return async () => {}
}

/** error：还原已经落盘，之后的收尾（维护目录、记账）抛了错；回执已拿掉，由调用方决定报不报。 */
export type RevertResult = { kind: 'reverted'; record: MemoryRecord; error?: unknown } | { kind: 'blocked'; block: RevertBlock | 'changed' }

/**
 * 按一条回执还原：进写入段，读现状和改前快照，够资格（revertBlock）就只把这次改的字段改回去，写成之后把回执从条目上拿掉
 * （同一个操作里的提交后步骤，中断后补上）。不够资格什么都不动。撤销本身照常写新的提交标记。
 * 回执要是调用方刚拿到的：这次运行自己写下的，或在条目的认领里从账本读的。撤过的回执不能留着再用（建关联的回执只看它加的 id 在不在，
 * 撤过之后别人重新挂上的同一个 id 会被它去掉）。
 */
export async function revertChange(entryId: string, receipt: ChangeReceipt, opts: { by?: string; at?: number }, deps: ChangesetDeps): Promise<RevertResult> {
  ensureSteps(deps)
  const { store } = deps
  return store.writeSection(async (): Promise<RevertResult> => {
    const scope = scopeOfLedger(receipt.scopeKey)
    const current = await locateCopy(store, receipt.memoryId, scope)
    const snapshot = receipt.snapshotId === undefined ? undefined : await deps.snapshots.get(receipt.snapshotId)
    const before = snapshot?.data.find(r => r.id === receipt.memoryId && r.redacted !== true)
    const block = revertBlock(receipt, current, before)
    if (block !== undefined || current === undefined) return { kind: 'blocked', block: block ?? 'gone' }
    // 这次写入留过历史版本的（状态变化）：先撤版本，再改回记忆，同一个写入段里别的写入插不进两步中间
    const putVersionBack = receipt.isContent && before !== undefined && receipt.snapshotId !== undefined
      ? await withdrawVersion(store, before, receipt.snapshotId)
      : async () => {}
    const { redacted: _redacted, ...plain } = before ?? ({} as SnapshotRecord)
    // 新建的撤销是软删进最近删除：删除时刻这里补
    const next = receipt.kind === 'create'
      ? markDeleted(current, Math.max(opts.at ?? Date.now(), current.updatedAt))
      : reverted(receipt, current, before === undefined ? undefined : plain as MemoryRecord)
    const op = newWriteOp({ ...(opts.by !== undefined ? { initiator: opts.by } : {}), steps: [changeUndoneStep(entryId, receipt.op)] })
    try {
      const written = await store.put(next, scope, latest => latest === undefined || !isSameRecord(latest, current), op)
      if (written === undefined) {
        await putVersionBack()
        return { kind: 'blocked', block: 'changed' }
      }
      await store.finishOp(op, written)
      return { kind: 'reverted', record: written }
    } catch (error) {
      // 抛错时不知道落没落盘：重读，提交标记是这次的就是还原已经写下了，回执拿掉、照还原了算；没写下的把历史版本放回去
      const latest = (await store.locateWrittenBy(receipt.memoryId, scope, op).catch(() => undefined))?.record
      if (latest === undefined) {
        await putVersionBack().catch(() => {})
        throw error
      }
      await deps.decisions.dropChange(entryId, receipt.op).catch(() => {})
      return { kind: 'reverted', record: latest, error }
    }
  })
}


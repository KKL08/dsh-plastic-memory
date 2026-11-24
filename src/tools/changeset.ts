import type { ChangeAnchor, ChangeFields } from '../change.ts'
import { commitChange, isSameRecord } from '../commit-change.ts'
import type { LinkIds, MemoryRecord } from '../record-schema.ts'
import { GLOBAL_SCOPE_KEY, scopeAt, type Scope } from '../scope.ts'
import { markDeleted, type MemoryLogger, type MemoryStore } from '../store.ts'
import { hasSecret } from '../secrets.ts'
import { mergeLinks, resolveLinks } from '../links.ts'
import { newWriteOp } from '../storage/table.ts'
import { layerOf } from '../storage/history.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { SnapshotRecord } from '../governance/schema.ts'
import type { SnapshotStore } from '../governance/snapshots.ts'
import { CHANGE_RECEIPT_STEP, changeReceiptStep, changeUndoneStep, ledgerSteps } from '../governance/op-steps.ts'
import {
  advance, changeKindOf, checkOp, newProgress, revertBlock, reverted,
  type ChangeOp, type ChangeOpKind, type ChangeReceipt, type PatchField, type RevertBlock, type SkipReason,
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
  /** 补证的出处。 */
  anchor?: ChangeAnchor
  /** 软删时哪些算含密钥、软删不了；缺省两级都算。 */
  isSecret?: (current: MemoryRecord) => boolean
}

/** has-secret：要软删的那条含密钥；link-invalid：要挂的 id 不合规（detail 是给模型看的原因）；invalid：拼出来的记录过不了格式校验；changed：落盘那一刻文件被手改了。 */
export type ApplySkipReason = SkipReason | 'has-secret' | 'link-invalid' | 'invalid' | 'changed'

export type OpOutcome =
  | { kind: 'applied'; opId: string; opKind: ChangeOpKind; memoryId: string; /** 这次写入的操作 id。 */ writeOp: string; written: MemoryRecord; fields: PatchField[]; snapshotId?: string }
  /** 核对过了，不用写（keep）。 */
  | { kind: 'checked'; opId: string; memoryId: string }
  | { kind: 'skipped'; opId: string; memoryId: string; reason: ApplySkipReason; detail?: string }

export interface ApplyResult {
  outcomes: OpOutcome[]
  /** 整批退了：outcomes 里是退之前各项的结果，applied 的那些已经撤回。 */
  isRolledBack?: boolean
  /** 整批退时没撤回去的（期间被别处接着改过）：它们的回执留在条目上，可以再撤。 */
  unreverted?: string[]
}

const scopeOfKey = (key: string): Scope => scopeAt(key === GLOBAL_SCOPE_KEY ? undefined : key)

function ensureSteps(deps: ChangesetDeps): void {
  if (!deps.store.hasStep(CHANGE_RECEIPT_STEP)) deps.store.registerSteps(ledgerSteps(deps.decisions, deps.log))
}

/**
 * 应用一个变更集。按顺序逐个操作：进写入段，读目标和依据，核对，写，记回执。对不上的操作跳过、原因记在结果里，后面的照做；
 * isAllOrNothing 时第一项对不上就停，把已做的按回执逆序撤掉。
 */
export async function applyChangeset(ops: readonly ChangeOp[], opts: ApplyOptions, deps: ChangesetDeps): Promise<ApplyResult> {
  ensureSteps(deps)
  const progress = newProgress()
  const outcomes: OpOutcome[] = []
  for (const op of ops) {
    const outcome = await applyOne(op, opts, deps, progress)
    outcomes.push(outcome)
    if (outcome.kind === 'applied') advance(progress, op, outcome.written)
    if (outcome.kind === 'skipped' && opts.isAllOrNothing === true) {
      return { outcomes, isRolledBack: true, ...(await rollBack(outcomes, opts, deps)) }
    }
  }
  return { outcomes }
}

/** 按回执逆序撤掉这批已做的。回执从条目上现读：它们是提交后的步骤记的，不凭内存里的结果拼。 */
async function rollBack(outcomes: readonly OpOutcome[], opts: ApplyOptions, deps: ChangesetDeps): Promise<{ unreverted?: string[] }> {
  const applied = outcomes.filter(o => o.kind === 'applied')
  if (applied.length === 0) return {}
  const receipts = await receiptsOfEntry(deps.decisions, opts.entryId)
  const unreverted: string[] = []
  for (const done of [...applied].reverse()) {
    const receipt = receipts.find(r => r.op === done.writeOp)
    const r = receipt === undefined ? undefined : await revertChange(opts.entryId, receipt, { by: opts.by }, deps)
    if (r?.kind !== 'reverted') unreverted.push(done.memoryId)
  }
  return unreverted.length > 0 ? { unreverted } : {}
}

/** 条目上现有的回执（未决、已结清的都读）。 */
export async function receiptsOfEntry(decisions: PendingDecisionsStore, entryId: string): Promise<ChangeReceipt[]> {
  const entry = (await decisions.get(entryId)) ?? (await decisions.listSettled()).find(d => d.id === entryId)
  return entry?.changes ?? []
}

async function applyOne(op: ChangeOp, opts: ApplyOptions, deps: ChangesetDeps, progress: ReturnType<typeof newProgress>): Promise<OpOutcome> {
  const { store } = deps
  const skipped = (reason: ApplySkipReason, memoryId = op.memoryId, detail?: string): OpOutcome =>
    ({ kind: 'skipped', opId: op.id, memoryId, reason, ...(detail !== undefined ? { detail } : {}) })
  return store.writeSection(async (): Promise<OpOutcome> => {
    const own = op.basis.find(b => b.memoryId === op.memoryId)
    // 目标按读到时的作用域找那一份：期间搬走了，原处就没有它，按不在处理（同 id 在别处的副本不是这次判断的对象）
    const target = own === undefined ? await store.get(op.memoryId, {}) : await locateCopy(store, op.memoryId, scopeOfKey(own.scopeKey))
    const basis = new Map<string, MemoryRecord>()
    for (const b of op.basis) {
      if (b.memoryId === op.memoryId) continue
      const record = await locateCopy(store, b.memoryId, scopeOfKey(b.scopeKey))
      if (record !== undefined) basis.set(b.memoryId, record)
    }
    const check = checkOp(op, { target, basis, progress, isSecretChecked: opts.isSecretChecked })
    if (check.kind === 'skip') return skipped(check.reason, check.memoryId)
    if (check.kind === 'none' || target === undefined) return { kind: 'checked', opId: op.id, memoryId: op.memoryId }
    const opKind = op.kind as ChangeOpKind
    if (check.kind === 'forget') return forget(op, target, opts, deps, skipped)

    // 关联和前提的增量在 commitChange 的写入段里按最新值算，算出来的实际增减记进回执
    let links: { added: LinkIds; removed: LinkIds } | undefined
    let fields: PatchField[] = []
    const prepare = async (current: MemoryRecord): Promise<{ fields: ChangeFields } | { stop: OpOutcome }> => {
      if (check.kind === 'write') {
        fields = Object.keys(check.fields) as PatchField[]
        return { fields: check.fields as ChangeFields }
      }
      if (check.kind !== 'link') return { fields: {} }
      const scope = scopeAt(current.workspacePath)
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
      kind,
      prepare,
      by: opts.by,
      at: opts.at,
      ...(check.kind === 'corroborate' && opts.anchor !== undefined ? { anchor: opts.anchor } : {}),
      ...(check.kind === 'corroborate' ? { isSnapshotForced: true } : {}),
      ...(op.reason !== undefined ? { reason: op.reason } : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      steps: snapshotId => [changeReceiptStep({ entryId: opts.entryId, opId: op.id, opKind, fields, snapshotId, ...(links !== undefined ? { links } : {}) })],
    }, deps)
    if (r.kind === 'stopped') return r.stop
    if (r.kind === 'changed') return skipped('changed')
    if (r.kind === 'invalid') return skipped('invalid', op.memoryId, r.reason)
    return { kind: 'applied', opId: op.id, opKind, memoryId: op.memoryId, writeOp: r.op, written: r.record, fields, ...(r.snapshotId !== undefined ? { snapshotId: r.snapshotId } : {}) }
  })
}

/** 软删：含密钥的不删（由调用方先问用户）；改前那一版拍进快照，撤销时修改时间从它取。 */
async function forget(
  op: ChangeOp, target: MemoryRecord, opts: ApplyOptions, deps: ChangesetDeps, skipped: (reason: ApplySkipReason) => OpOutcome,
): Promise<OpOutcome> {
  const { store } = deps
  if ((opts.isSecret ?? hasSecret)(target)) return skipped('has-secret')
  const at = Math.max(opts.at, target.updatedAt)
  const snapshot = await deps.snapshots.capture({ operation: 'pre-forget', description: `删除记忆 ${target.id} 前`, records: [target] }, at)
  const writeOp = newWriteOp({ initiator: opts.by, steps: [changeReceiptStep({ entryId: opts.entryId, opId: op.id, opKind: 'forget', fields: [], snapshotId: snapshot.id })] })
  const outcome = await store.softDeleteUnlessSecret(target, {
    at: scopeAt(target.workspacePath), now: at, op: writeOp, isChanged: cur => !isSameRecord(cur, target), ...(opts.isSecret !== undefined ? { isSecret: opts.isSecret } : {}),
  })
  if (outcome !== 'deleted') return skipped(outcome === 'has-secret' ? 'has-secret' : outcome === 'missing' ? 'gone' : 'changed')
  const written = markDeleted(target, at)
  await store.finishOp(writeOp, written)
  return { kind: 'applied', opId: op.id, opKind: 'forget', memoryId: op.memoryId, writeOp: writeOp.id, written, fields: [], snapshotId: snapshot.id }
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

export type RevertResult = { kind: 'reverted'; record: MemoryRecord } | { kind: 'blocked'; block: RevertBlock | 'changed' }

/**
 * 按一条回执还原：进写入段，读现状和改前快照，够资格（revertBlock）就只把这次改的字段改回去，写成之后把回执从条目上拿掉
 * （同一个操作里的提交后步骤，中断后补上）。不够资格什么都不动。撤销本身照常写新的提交标记。
 */
export async function revertChange(entryId: string, receipt: ChangeReceipt, opts: { by: string }, deps: ChangesetDeps): Promise<RevertResult> {
  ensureSteps(deps)
  const { store } = deps
  return store.writeSection(async (): Promise<RevertResult> => {
    const scope = scopeOfKey(receipt.scopeKey)
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
    const next = reverted(receipt, current, before === undefined ? undefined : plain as MemoryRecord)
    const op = newWriteOp({ initiator: opts.by, steps: [changeUndoneStep(entryId, receipt.op)] })
    const written = await store.put(next, scope, latest => latest === undefined || !isSameRecord(latest, current), op)
    if (written === undefined) {
      await putVersionBack()
      return { kind: 'blocked', block: 'changed' }
    }
    await store.finishOp(op, written)
    return { kind: 'reverted', record: written }
  })
}


import { isDeepStrictEqual } from 'node:util'
import { applyChange, applyMeta, stateStartOf, type Change, type ChangeAnchor, type ChangeFields } from './change.ts'
import { memoryRecordSchema, type ChangeKind, type MemoryRecord } from './record-schema.ts'
import type { MemoryLogger, MemoryStore } from './store.ts'
import type { SnapshotStore } from './governance/snapshots.ts'
import { layerOf, newVersionId, STATE_CHANGE_VERSION, type HistoryVersion } from './storage/history.ts'
import { INDEX_ROW_STEP } from './storage/file-table.ts'
import { newWriteOp, type TopicIntent, type OpStep, type OpStepHandler } from './storage/table.ts'
import { scopeOfMemory, type Scope } from './scope.ts'
import { toToolOutput } from './output.ts'
import { isCurrentPremise } from './links.ts'

/** 合并窗口的缺省长度：同一会话在这段时间里接连做的状态变化只留一次档。配置项 history.mergeWindowMinutes。 */
export const MERGE_WINDOW_MINUTES_DEFAULT = 60
/** 变化原因最多留多少字符：它随记忆文件和历史版本落盘，只要一句话。 */
export const CHANGE_REASON_LIMIT = 500

/** 状态变化写成之后留历史版本：新留一版，或并进上一次留的那版。 */
export const HISTORY_STEP = 'history-version'

interface HistoryStep extends OpStep {
  kind: typeof HISTORY_STEP
  mode: 'archive' | 'append'
  versionId: string
  snapshotId: string
  at: number
  /** 留档时：改前那一版从什么时候起是当前版。 */
  startedAt?: number
  sessionId?: string
}

/** 这次写入改前的那一版，按操作 id 暂存：正常写完时留档直接用它（带着原文件里不认识的键），中断后补做才回头读快照。 */
const pendingBefore = new Map<string, { record: MemoryRecord; extras: Record<string, unknown> }>()

/**
 * 历史版本步骤的处理器。能重复执行：版本里记着由哪几次操作形成，做过的不再做。
 * 改前的内容正常取暂存的那份，中断后补做时取改前快照里的；快照已经不在（过期、被彻底删除抹掉）就留不了档，只记日志。
 */
export function historySteps(store: MemoryStore, snapshots: SnapshotStore, log: MemoryLogger = console): Record<string, OpStepHandler> {
  return {
    [HISTORY_STEP]: async (raw, { op, record }) => {
      const step = raw as HistoryStep
      if (record === undefined) return
      const scope = scopeOfMemory(record)
      const found = scope === undefined ? undefined : await store.locate(record.id, scope)
      if (found === undefined) return
      const layer = layerOf(found)
      const { versions } = await store.history.list(layer, record.id)
      if (versions.some(v => v.writes.some(w => w.op === op))) return
      // 原因不进操作日志（日志不留记忆里的文字）：从写成的那一版的最近一次内容改动里取
      const reason = record.lastChange?.op === op ? record.lastChange.reason : undefined
      const write = { op, at: step.at, snapshot: step.snapshotId, ...(reason !== undefined ? { reason } : {}) }
      if (step.mode === 'append') {
        const version = versions.find(v => v.versionId === step.versionId)
        if (version !== undefined) await store.history.write(layer, { ...version, writes: [...version.writes, write] })
        return
      }
      const stashed = pendingBefore.get(op)
      const before = stashed?.record ?? (await snapshots.get(step.snapshotId))?.data.find(r => r.id === record.id && r.redacted !== true)
      if (before === undefined) {
        log.warn(`[plastic-memory] 操作 ${op} 改前的内容已不在快照 ${step.snapshotId} 里，记忆 ${record.id} 这次状态变化没有留下历史版本`)
        return
      }
      const version: HistoryVersion = {
        versionId: step.versionId,
        record: before,
        extras: stashed?.extras ?? {},
        startedAt: step.startedAt ?? before.createdAt,
        endedAt: step.at,
        kind: STATE_CHANGE_VERSION,
        ...(step.sessionId !== undefined ? { sessionId: step.sessionId } : {}),
        writes: [write],
      }
      await store.history.write(layer, version)
    },
  }
}

export interface CommitChangeDeps {
  store: MemoryStore
  /** 改前快照：撤销按它恢复，中断后补留历史版本也读它。 */
  snapshots: SnapshotStore
  /** 合并窗口，毫秒；缺省按 MERGE_WINDOW_MINUTES_DEFAULT。 */
  mergeWindowMs?: number
  log?: MemoryLogger
}

export interface CommitChangeInput<Stop = never> {
  /** 本次写入之后归主题的要求。 */
  topic?: TopicIntent
  /**
   * 只动这个作用域里的那一份：按它定位、按它写回，别的作用域里同 id 的副本不碰。不给时按会话视角（当前项目优先），
   * 写回时顺带清掉另一层的同 id 副本（会话里它们是同一条的重复）。
   */
  scope?: Scope
  /** 调用方读到的那一版，用来找到要改的那一份：锁内看到它不在了、状态变了或换了作用域就不写。别的字段不比，按锁内读到的最新版拼。 */
  target: MemoryRecord
  /** meta：只改元数据（注入档位、关联和前提），不动修改时间、出处清单和最近一次内容改动，照常拍改前快照。 */
  kind: ChangeKind | 'meta'
  /** 要改的字段（见 Change.fields）；补证时不生效。只放这次要改的：没列的字段保留锁内读到的值。 */
  fields?: ChangeFields
  /**
   * 要改的字段得看最新内容才定得下来时用它（和 fields 二选一，都给时用它）：锁内拿刚读到的那一版算，在拍快照之前。
   * 返回 stop 即不写，原样交回调用方。可以是异步的（要在写入段里再读别的记忆时）。
   */
  prepare?: (current: MemoryRecord) => Prepared<Stop> | Promise<Prepared<Stop>>
  /** 这次写入的出处；没有会话可指的后台写入不给。 */
  anchor?: ChangeAnchor
  /** 谁写的：记进锚、最近一次内容改动和操作日志。 */
  by: string
  /** 状态变化的原因，随历史版本留着。 */
  reason?: string
  /** 发起这次写入的会话：合并窗口只对同一个会话开，不给就每次都留档。 */
  sessionId?: string
  at: number
  /** 和目标拍进同一份改前快照的别的记录（这次写入随后还要动的）。 */
  alsoSnapshot?: readonly MemoryRecord[]
  /** 调用方在这次写入提交之后要补的账，拿到改前快照的 id 再定；处理器由调用方登记。 */
  steps?: (snapshotId: string) => OpStep[]
  /** 这次写入的操作 id 和要写下的那一版定下来就告诉调用方（落盘之前）：写方法抛错时调用方凭它查落没落盘、认写下的是什么。 */
  onOp?: (opId: string, planned: MemoryRecord) => void
  /** 用户在界面里亲手定下的内容：确认时间记为这一刻（不靠出处判断）。只改元数据的操作不生效。 */
  isUserConfirmed?: boolean
  /** 补证平时不拍改前快照（没有可撤的）；要给它留撤销入口时设为 true，照样拍。 */
  isSnapshotForced?: boolean
  /** 调用方另外的不写条件：对锁内看到的当前内容求值。 */
  isBlocked?: (current: MemoryRecord) => boolean
}

type Prepared<Stop> = { fields: ChangeFields } | { stop: Stop }

export type CommitChangeResult<Stop = never> =
  /** snapshotId：改前快照，补证不拍。version：这次状态变化留下或并进去的历史版本。 */
  | { kind: 'written'; isTopicPending: boolean; /** 这次写入的操作 id。 */ op: string; record: MemoryRecord; /** 写入段里读到、这次改动拼在它上面的那一版；整条替换时被盖掉的内容以它为准。 */ before: MemoryRecord; snapshotId?: string; version?: { id: string; isMerged: boolean } }
  /** 调用方读到之后目标不在了、状态变了、换了作用域，或过不了调用方另给的条件，没写。 */
  | { kind: 'changed'; current: MemoryRecord | undefined }
  /** prepare 看了最新内容之后叫停，没写。 */
  | { kind: 'stopped'; stop: Stop }
  /** 拼出来的记录过不了格式校验，没写。 */
  | { kind: 'invalid'; reason: string }

/** 召回统计之外整条相等：清候选标记、搬作用域这类不碰修改时间的改动也算改过。 */
export function isSameRecord(a: MemoryRecord, b: MemoryRecord): boolean {
  const { recallCount: _ra, lastRecalledAt: _la, ...restA } = a
  const { recallCount: _rb, lastRecalledAt: _lb, ...restB } = b
  return isDeepStrictEqual(restA, restB)
}

/**
 * 把一次声明了性质的改动落到一条已有的记忆上：改前快照、按性质拼出新记录、写文件、状态变化留历史版本，整段在一个写入段里。
 * 新记录是锁内读到的最新版加上这次要改的字段：调用方读到之后别处改的注入档位、有效期、关联、锁都留着，改前快照拍的也是最新版。
 * 这里只管落盘：调用方是谁、该不该改、内容合不合规由调用方先判。前台保存在外面套确认码和子 agent 的规则，没有会话的后台写入直接调。
 *
 * 顺序：先拍快照，再写记忆文件，历史版本记成提交之后的一步。写文件之前断掉，只多一份没人用的快照；
 * 写完文件断掉，下一次进写入段按操作日志从快照补上历史版本。任何时刻都不会有一个和当前页内容相同的历史版本。
 */
export async function commitChange<Stop = never>(input: CommitChangeInput<Stop>, deps: CommitChangeDeps): Promise<CommitChangeResult<Stop>> {
  const { store } = deps
  const { kind } = input
  return store.writeSection(async () => {
    // 定位和落盘同一个口径（会话视角，当前项目优先）：本项目那份没了、读到的是全局的同 id 副本时，作用域对不上，不写
    const from = input.scope ?? { workspacePath: input.target.workspacePath }
    const current = await store.get(input.target.id, from)
    const isSamePlace = current !== undefined && current.status !== 'deleted' && current.status === input.target.status
      && current.scope === input.target.scope && current.workspacePath === input.target.workspacePath
    if (!isSamePlace || input.isBlocked?.(current) === true) return { kind: 'changed', current }
    const target = current
    // 调用方的时刻是它开始时取的：别处在那之后写过这条，这次落盘排在它后面，时间不往回写
    const at = Math.max(input.at, current.updatedAt, current.lastConfirmedAt)
    const prepared = (await input.prepare?.(current)) ?? { fields: input.fields ?? {} }
    if ('stop' in prepared) return { kind: 'stopped', stop: prepared.stop }

    const isContentChange = kind !== 'corroborate'
    const alsoSnapshot = input.alsoSnapshot ?? []
    const snapshot = isContentChange || alsoSnapshot.length > 0 || input.isSnapshotForced === true
      ? await deps.snapshots.capture({ operation: 'pre-update', description: `更新记忆 ${target.id} 前`, records: [target, ...alsoSnapshot] }, at)
      : undefined

    // 状态变化：新留一版，还是并进上一次留的那版。同一会话在窗口里接着改的并进去，窗口从上一次留档算起、不随追加往后延
    let history: HistoryStep | undefined
    let before: { record: MemoryRecord; extras: Record<string, unknown> } | undefined
    if (kind === 'state-change' && snapshot !== undefined) {
      const scope = scopeOfMemory(target)
      const found = scope === undefined ? undefined : await store.locate(target.id, scope)
      if (found !== undefined) {
        const { versions, isComplete } = await store.history.list(layerOf(found), target.id)
        const last = versions.at(-1)
        const windowMs = deps.mergeWindowMs ?? MERGE_WINDOW_MINUTES_DEFAULT * 60_000
        // 接着改才并：当前这一版得是那个版本最后一笔写下的。中间别人改过正文（另一个会话纠错、界面里改）就另留一版，不然中间那一版哪里都不剩
        const lastWrite = last?.writes.at(-1)
        // 当前这一版被某条决定引用为前提时也另留一版：决定依据的那个状态要留得住
        const isMerged = isComplete && last !== undefined && last.kind === STATE_CHANGE_VERSION && input.sessionId !== undefined
          && last.sessionId === input.sessionId && at >= last.endedAt && at - last.endedAt < windowMs
          && lastWrite !== undefined && target.lastChange?.op === lastWrite.op && target.updatedAt === lastWrite.at
          && !(await isCurrentPremise(store, target))
        history = {
          kind: HISTORY_STEP,
          mode: isMerged ? 'append' : 'archive',
          versionId: isMerged ? last.versionId : newVersionId(at, versions.map(v => v.versionId)),
          snapshotId: snapshot.id,
          at,
          ...(isMerged ? {} : { startedAt: stateStartOf(target, last?.endedAt) }),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        }
        before = { record: target, extras: found.extras }
      }
    }
    if (history !== undefined && !store.hasStep(HISTORY_STEP)) store.registerSteps(historySteps(store, deps.snapshots, deps.log))

    const steps = [...(history !== undefined ? [history] : []), ...(snapshot !== undefined ? input.steps?.(snapshot.id) ?? [] : [])]
    const op = newWriteOp({ initiator: input.by, steps, topic: input.topic })
    const reason = kind === 'state-change' ? input.reason?.trim().slice(0, CHANGE_REASON_LIMIT) : undefined
    const change: Change = {
      kind: kind === 'meta' ? 'refine' : kind, fields: prepared.fields, anchor: input.anchor, by: input.by, op: op.id, at,
      ...(reason !== undefined && reason !== '' ? { reason } : {}),
      isMergedIntoLastVersion: history?.mode === 'append',
    }
    const applied = kind === 'meta' ? applyMeta(target, prepared.fields) : applyChange(target, change)
    const parsed = memoryRecordSchema.safeParse(kind !== 'meta' && input.isUserConfirmed === true ? { ...applied, lastConfirmedAt: at } : applied)
    if (!parsed.success) return { kind: 'invalid', reason: parsed.error.issues.map(i => i.message).join('；') }
    // 值是 undefined 的键去掉：记录要能无损序列化
    const next = toToolOutput(parsed.data) as unknown as MemoryRecord

    // 写入段挡不住不拿锁的写（手改文件）：落盘那一刻和刚读到的不是同一版就不写
    const seen: { current?: MemoryRecord } = {}
    const isChangedSinceRead = (latest: MemoryRecord | undefined) => {
      seen.current = latest
      return latest === undefined || !isSameRecord(latest, target)
    }
    input.onOp?.(op.id, next)
    if (before !== undefined) pendingBefore.set(op.id, before)
    try {
      const written = await store.put(next, from, isChangedSinceRead, op)
      if (written === undefined) return { kind: 'changed', current: seen.current }
      const isTopicPending = input.topic !== undefined && store.hasUnfinishedOwnStep(op.id, INDEX_ROW_STEP)
      await store.finishOp(op, written)
      return {
        kind: 'written', isTopicPending,
        op: op.id,
        record: next,
        before: target,
        ...(snapshot !== undefined ? { snapshotId: snapshot.id } : {}),
        ...(history !== undefined ? { version: { id: history.versionId, isMerged: history.mode === 'append' } } : {}),
      }
    } finally {
      pendingBefore.delete(op.id)
    }
  })
}

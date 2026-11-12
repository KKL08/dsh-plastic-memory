/**
 * 右侧栏「记忆」tab 正文（DESIGN.md Layout「右侧栏记忆 tab 内容（结构 A）」）。只讲插件放进上下文的那份快照和这次新写入的，
 * 对话中 memory_search 搜到的算普通上下文，不列、不计用量。从上到下：
 * 面包屑「本项目 / 项目名」→ 对话开始时 / 重新 / 压缩后重新带入的记忆（随快照来历换标题，用量条）→ 这次新写入的（可删，
 * 进了新快照的移到带入的记忆）→ 等你决定（带入的记忆涉及的待决冲突：横向是两条记忆，垂直是记忆对 AGENTS.md 基线；
 * 刚裁决的结果卡留在原位；都没有时不画）→ 带入的记忆（按类型分组，组标题标出全文、只带摘要或只带标题；冲突双方照常列在各自组里）
 * → 底部一行入口（其余待处理只在这里带数字）。
 * 「等你决定」和各类型组都可折叠：「等你决定」默认展开，类型组默认收起；点过的以用户为准，tab 挂着期间保留。
 * 数据：会话视图（来历、带入 / 全文 / 只带标题 / 新写入的 id、用量）、全部记忆视图（按 id 取记忆卡）、待处理视图（冲突与本项目待处理数）、
 * 健康视图（bootedAt：插件本次加载时刻）。
 * 四种状态：无记忆、有全局没本项目、正常、frozenAt 早于插件本次加载（重启后未重新带入；视图没带 bootedAt 时不判断）。
 * 横向冲突在 A、B 下面写一行处理建议的结论（「模型建议：保留 A」，理由不写）。建议是保留一方、都保留时给「采纳建议」
 * （发 apply-proposal，只带条目 id 和建议 id，不加确认）和一句采纳后哪条去哪；融合稿和对照放不下，融合和没有建议时只给「在记忆页处理 ›」，
 * 有建议时它也跟在「采纳建议」后面，作为不按建议处理的出口。采纳时建议已失效（stale，什么都没动）：原位写明，退化成没有建议，
 * 视图带来另一份（id 不同）时照常显示。基线冲突（记忆和指令文件）同样：建议是删除这条、都保留，且会话在这条记忆的项目里时给「采纳建议」，
 * 改写和没有建议时只给「在记忆页处理 ›」；不再有直接裁决的按钮。
 * 刚裁决的冲突在本地留原位可撤销，tab 卸载后收起。撤销生效、视图还没把冲突带回来时，按裁决前的样子原位画回冲突卡（同记忆页处理视图），
 * 「等你决定」不空出一帧，焦点留在这张卡上；视图带回后卡片不重挂。
 * 裁决碰上这条冲突正在别处处理或刚处理完（什么都没动）：冲突卡还在时原位说明，那边的结果写进视图、卡片消失后
 * 说明挪到「等你决定」「带入的记忆」上面（没有记忆了就在空状态上面），下一次动作时收起。
 * 新写入的行尾删除先在原位确认「删除这条？ 删除 · 取消」，点「删除」才发 forget；删后原位留「已删除」和「撤销」（发 restore，
 * 文案和撤销失败不写原因同对话交付卡），tab 卸载后收起。别处删掉的照旧直接从列表里去掉。
 * 新写入的含密钥时不能软删（服务端回 has-secret，什么都没动）：原位确认，「彻底删除」发 hard-delete，删后原位留不可恢复的说明，tab 卸载后收起。
 * 新写入的是全局提升候选时就地给「留在本项目」「提升为全局」，处理过的换成结果文字（见 promote-in-place.tsx），不进底部的待处理计数。
 * 这次对话里模型改写、替代已有记忆的（全部记忆视图的 modelChanges，按会话认领、晚于这份快照的；同一条只列最近那次改写，本次新记的不另列）也列在「这次新写入的」：
 * 改写的那条带「已改写」、「改前 / 改后」对照与「撤销修改」，替代写「「新」替代了「旧」」与「撤销修改」（见 model-change.tsx）。
 */
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CONFLICT_ACTION_VERDICTS, pendingItemScopes, sameScope, scopeOfMemory, verdictOfAction,
  type MemoryCard as MemoryCardData, type MemoryCommand, type ModelChange, type PendingItem, type Scope, type SnapshotOrigin, type Suggestion,
} from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { samePath } from '../session-pick.ts'
import { baseName, formatNumber, useT } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import type { NavTarget } from '../nav.ts'
import { GroupBody, useFold } from '../library/groups.tsx'
import { mergeTypeLabels, ViewMessage } from '../library/shared.tsx'
import { typeLabel } from '../type-label.ts'
import { ACTION_LABEL } from '../pending/suggestion.tsx'
import { AdviceNote, ResultLine } from '../ui/Advice.tsx'
import { Button } from '../ui/Button.tsx'
import { ConflictRuling, VerticalConflictRuling } from '../ui/ConflictRuling.tsx'
import { ContextBudgetBar } from '../ui/ContextBudgetBar.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { Icon } from '../ui/Icon.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { Arrival, useArrivals } from '../ui/motion.tsx'
import { CommandFeedback, DeleteWithConfirm } from '../command/confirm.tsx'
import type { Ok } from '../command/protocol.ts'
import { useCommandRunner } from '../command/useCommandRunner.ts'
import { promotionOf, usePromoteInPlace, type InPlacePromotion } from '../chat/promote-in-place.tsx'
import { ModelChangeLine } from '../chat/model-change.tsx'
import { isLiveWrite, sessionCards, writtenSinceSnapshot } from './session-memories.ts'
import { groupInjected, type Conflict, type Decision, type GroupDepth, type Outcome, type Ruled, type Verdict, type VerticalConflict } from './injected-groups.ts'

const outcomeOf = (result: Ok): Outcome => ({ ...(result.isUnrecorded ? { isUnrecorded: true } : {}), ...(result.isHardDeleted ? { isHardDeleted: true } : {}) })

/** 用量标题随快照来历变。 */
const USAGE_TITLE: Record<SnapshotOrigin, LocaleKey> = {
  start: 'sidebar.usage.title',
  resumed: 'sidebar.usage.titleResumed',
  compacted: 'sidebar.usage.titleCompacted',
  refreshed: 'sidebar.usage.titleRefreshed',
}

/** 「等你决定」段在折叠状态里的键（类型组是「type|类型」）。 */
const YOUR_CALL = 'your-call'

/** 组标题后面标的带入方式。 */
const DEPTH_LABEL: Record<GroupDepth, LocaleKey> = {
  full: 'sidebar.groups.full',
  summary: 'sidebar.groups.summary',
  titleOnly: 'sidebar.groups.titleOnly',
}

export interface SidebarTabProps {
  /** tab 所在的会话。 */
  sessionId: string
  /** 该会话的工作目录；会话视图带了 workspacePath 时以视图为准。 */
  workspacePath?: string | undefined
  /** 跳到记忆页（经导航 store）。 */
  openPage: (target: NavTarget) => void
}

/** 待处理条目是否属于这个项目（与记忆页按范围筛选同一口径）。 */
function inWorkspace(item: PendingItem, ws: string): boolean {
  // 右侧栏这次不分级，建议整理不算进「本项目还有 N 处待处理」
  if (item.kind === 'advice') return false
  const own: Scope = { kind: 'workspace', workspacePath: ws }
  return pendingItemScopes(item).some(s => sameScope(s, own))
}

export function SidebarTab({ sessionId, workspacePath: cwd, openPage }: SidebarTabProps) {
  const t = useT()
  const gateway = useGateway()
  const session = useMemo<BorrowedSession>(() => ({ kind: 'ready', sessionId, cwd }), [sessionId, cwd])
  const sessionView = gateway.useView(session, 'session')
  const library = gateway.useView(session, 'library')
  const pending = gateway.useView(session, 'pending')
  const health = gateway.useView(session, 'health')
  const config = gateway.useConfig()
  // 删过的记忆（这里、全部记忆或对话交付卡删的）：新记的列表里立刻去掉，不等视图刷新
  const deletions = gateway.useDeletions()
  const [ruled, setRuled] = useState<readonly Ruled[]>([])
  /** 裁决时的那条待决项（按 decisionId），撤销后原位画回去用。 */
  const ruledItems = useRef(new Map<string, Conflict | VerticalConflict>())
  /** 撤销已生效、待处理视图还没带回来的冲突：照裁决前的样子原位画，可以接着裁决；视图里重新有了就去掉这一笔。 */
  const [undone, setUndone] = useState<ReadonlyMap<string, Conflict | VerticalConflict>>(new Map())
  const [purged, setPurged] = useState<ReadonlySet<string>>(new Set())
  /**
   * 在这里删过的新写入：按 id 留着那张卡，软删后原位画「已删除 · 撤销」（视图刷新后卡已经不在全部记忆里）。
   * isRestored：撤销成功、视图还没刷新回来，照原样画这张卡；视图里重新有了就去掉这一笔。
   */
  const [removed, setRemoved] = useState<ReadonlyMap<string, { memory: MemoryCardData; isRestored?: true }>>(new Map())
  /** 这里写进了 AGENTS.md 的：项目里那条进了最近删除、离开了视图，按 id 留着那张卡和结果。 */
  const [wroteAgentsMd, setWroteAgentsMd] = useState<ReadonlyMap<string, MemoryCardData>>(new Map())
  // 动作按条（待决项 id / 记忆 id）经命令往返模块发出：在途时这一条不可再点，同一条冲突不会发出两条相反的裁决；
  // 跨项目确认、含密钥改彻底删除、失败提示都同其他面板
  const runner = useCommandRunner(session)
  /** 没有生效的那次裁决或撤销（待决项 id）：冲突卡消失后提示还要留着，所以记在这里，下一次动作时收起。 */
  const [refused, setRefused] = useState<string | undefined>(undefined)
  /** 采纳时回了 stale 的建议（待决项 id → 那一份建议的 id）：卡上把它当作没有建议。 */
  const [staleSuggestions, setStaleSuggestions] = useState<ReadonlyMap<string, string>>(new Map())

  const run = (id: string, command: MemoryCommand, onOk: (result: Ok, sent: MemoryCommand) => void) => {
    setRefused(undefined)
    runner.run(id, command, { onOk, onHandledElsewhere() { setRefused(id) } })
  }
  const settle = (item: Conflict | VerticalConflict, entry: Ruled) => {
    ruledItems.current.set(item.decisionId, item)
    setRuled(prev => [...prev, entry])
    setUndone((prev) => { const next = new Map(prev); next.delete(item.decisionId); return next })
  }
  const adopt = (item: Conflict | VerticalConflict, suggestion: Suggestion, verdict: Verdict) => {
    const ruledOf = (result: Ok): Ruled | undefined => {
      if (item.kind === 'conflict-vertical') return item.memory === null ? undefined : { kind: 'vertical', decisionId: item.decisionId, verdict, memory: item.memory, ...outcomeOf(result) }
      return item.left === null || item.right === null ? undefined : { kind: 'horizontal', decisionId: item.decisionId, verdict, left: item.left, right: item.right, ...outcomeOf(result) }
    }
    setRefused(undefined)
    runner.run(item.decisionId, { cmd: 'apply-proposal', decisionId: item.decisionId, suggestionId: suggestion.id }, {
      onOk(result) {
        const entry = ruledOf(result)
        if (entry !== undefined) settle(item, entry)
      },
      onHandledElsewhere() { setRefused(item.decisionId) },
      // 建议已换了一份，或两条在建议生成后被改过：什么都没动，卡上这一份当作失效
      onFailed(failure) {
        if (failure.code !== 'stale') return false
        setStaleSuggestions(prev => new Map(prev).set(item.decisionId, suggestion.id))
        return true
      },
    })
  }
  const undo = (decisionId: string) => {
    run(decisionId, { cmd: 'undo', decisionId }, () => {
      const item = ruledItems.current.get(decisionId)
      if (item !== undefined) setUndone(prev => new Map(prev).set(decisionId, item))
      setRuled(prev => prev.filter(r => r.decisionId !== decisionId))
    })
  }
  // 发出 forget 时就记下（含密钥时确认后改发的彻底删除沿用这一次），等删除状态记成彻底删除再换上说明：
  // 网关记删除和成功回调不在同一次提交，回调里才记会先空出一帧（这一行没了、说明还没来），焦点趁机落到后面的控件上。
  // 软删成功的去掉：之后在别处彻底删除的普通记忆不写含密钥那句
  const forget = (memory: MemoryCardData) => {
    const memoryId = memory.id
    setPurged(prev => new Set(prev).add(memoryId))
    // 同样在发出时记下：网关记成软删的那一帧这一行就换成「已删除」，焦点落在原位的「撤销」上
    setRemoved(prev => new Map(prev).set(memoryId, { memory }))
    run(memoryId, { cmd: 'forget', memoryId, layer: scopeOfMemory(memory) }, (_result, sent) => {
      if (sent.cmd === 'forget') setPurged((prev) => { const next = new Set(prev); next.delete(memoryId); return next })
    })
  }
  const isPurged = (id: string) => purged.has(id) && deletions.of(id) === 'hard'
  // 撤销删除失败不写原因，那一行还是「已删除」（同对话交付卡）
  const restore = (memory: MemoryCardData) => {
    runner.run(memory.id, { cmd: 'restore', memoryId: memory.id, layer: scopeOfMemory(memory) }, {
      onFailed: 'silent',
      onOk() { setRemoved(prev => new Map(prev).set(memory.id, { memory, isRestored: true })) },
    })
  }

  const arrivals = useArrivals(sessionView.status === 'ready' ? writtenSinceSnapshot(sessionView.data) : undefined, sessionId)
  // 「等你决定」和各类型组的折叠：组件内状态，tab 挂着期间保留
  const folds = useFold(undefined, 'sidebar', false)

  if (library.status !== 'ready') return <div className="pm-side"><ViewMessage state={library} idle={t('view.loading')} className="pm-side-hint" /></div>

  const snapshot = sessionView.status === 'ready' ? sessionView.data : undefined
  const ws = snapshot?.workspacePath ?? cwd
  const { byId, globalCount, projectCount } = sessionCards(library.data, ws)
  // 撤销回来的那条视图里重新有了：以视图为准，不再按留下的卡画
  const settled = [...removed].filter(([id, entry]) => entry.isRestored === true && byId.has(id)).map(([id]) => id)
  if (settled.length > 0) {
    setRemoved((prev) => { const next = new Map(prev); for (const id of settled) next.delete(id); return next })
  }
  // 彻底删除的那条视图里已经没有了，按 id 原位留一行说明（删的是最后一条时留在空状态上面，也是焦点的落点）
  const purgedNote = (id: string) => <p key={id} className="pm-side-hint" tabIndex={-1}>{t('pending.secret.deletedNotice')}</p>
  const refusedNote = <p className="pm-pending-error" role="alert" tabIndex={-1}>{t('sidebar.action.refused')}</p>
  if (globalCount === 0 && projectCount === 0) {
    return (
      <div className="pm-side">
        {(snapshot?.savedIds ?? []).filter(isPurged).map(purgedNote)}
        {refused !== undefined ? refusedNote : null}
        <EmptyState variant="first" title={t('sidebar.empty.title')}>{t('sidebar.empty.body')}</EmptyState>
      </div>
    )
  }

  const pendingItems = pending.status === 'ready' ? pending.data.items : []
  // 撤销回来的冲突视图里重新有了：以视图为准，不再按留下的那条画
  const backInView = [...undone.keys()].filter(id => pendingItems.some(item => 'decisionId' in item && item.decisionId === id))
  if (backInView.length > 0) {
    setUndone((prev) => { const next = new Map(prev); for (const id of backInView) next.delete(id); return next })
  }
  const stillUndone = [...undone.values()].filter(item => !backInView.includes(item.decisionId))
  const viewLabels = mergeTypeLabels(library, pending)
  const label = (type: string) => typeLabel(t, type, { viewLabels, customTypes: config?.customTypes })
  const ruledIds = new Set(ruled.map(r => r.decisionId))
  const { groups, decisions, inline } = groupInjected({
    injectedIds: snapshot?.injectedIds ?? [],
    coreIds: snapshot?.coreIds ?? [],
    titleOnlyIds: snapshot?.titleOnlyIds ?? [],
    byId,
    ruled,
    conflicts: [...pendingItems, ...stillUndone].filter((item): item is Conflict => item.kind === 'conflict-horizontal'),
    verticals: [...pendingItems, ...stillUndone].filter((item): item is VerticalConflict => item.kind === 'conflict-vertical'),
  })
  // 这次新写入的只列还没进快照、还在的；彻底删除的原位留说明
  // 这里软删的原位留「已删除 · 撤销」，撤销后视图还没刷新回来的照留下的卡画
  const saved = (snapshot === undefined ? [] : writtenSinceSnapshot(snapshot))
    .flatMap((id): Array<{ id: string; memory: MemoryCardData | undefined; isWrittenToAgentsMd?: true; isDeleted?: true }> => {
      if (wroteAgentsMd.has(id)) return [{ id, memory: wroteAgentsMd.get(id), isWrittenToAgentsMd: true }]
      if (isPurged(id)) return [{ id, memory: undefined }]
      const entry = removed.get(id)
      const how = entry === undefined ? undefined : deletions.of(id, scopeOfMemory(entry.memory))
      if (entry !== undefined && how === 'soft') return [{ id, memory: entry.memory, isDeleted: true }]
      if (isLiveWrite(id, byId, deletions)) return [{ id, memory: byId.get(id) }]
      return entry?.isRestored === true && how === undefined ? [{ id, memory: entry.memory }] : []
    })
  // 这次对话里模型改写、替代的：快照冻结之后的（之前的已在这份快照里，同新写入的口径）。
  // 同一条改写多次只列最近那次；这次对话里新记的那条再被改写不另列，新写入那行已经是它
  const sessionChanges = snapshot === undefined ? [] : (library.data.modelChanges ?? [])
    .filter(c => c.sessionId === sessionId && c.at > snapshot.frozenAt)
  const createdHere = new Set(snapshot?.savedIds ?? [])
  const latestRewrite = new Map<string, ModelChange>()
  for (const c of sessionChanges) {
    if (c.kind === 'rewrite' && c.at >= (latestRewrite.get(c.memoryId)?.at ?? -Infinity)) latestRewrite.set(c.memoryId, c)
  }
  const changes = sessionChanges.filter(c => c.kind === 'supersede' || (!createdHere.has(c.memoryId) && latestRewrite.get(c.memoryId) === c))
  const scope = ws === undefined ? undefined : { kind: 'workspace' as const, workspacePath: ws }
  const restPending = ws === undefined || pending.status !== 'ready'
    ? 0
    : pending.data.items.filter(item => inWorkspace(item, ws) && !('decisionId' in item && (inline.has(item.decisionId) || ruledIds.has(item.decisionId)))).length
  const now = Date.now()
  const card = (memory: MemoryCardData) => (
    <MemoryCard memory={memory} now={now} typeLabel={label(memory.type)} hideScope={memory.scope === 'workspace'} />
  )
  /** 这一条的确认、失败或没有生效。 */
  const failed = (id: string) => refused === id ? refusedNote : <CommandFeedback runner={runner} id={id} />
  // 冲突对方可能在别的项目：那一方写项目名（这里的「本项目」是会话视图解析出的项目，和上面分层同一口径）
  const projectName = (m: MemoryCardData) =>
    m.scope === 'workspace' && m.workspacePath !== undefined && !samePath(m.workspacePath, ws) ? baseName(m.workspacePath) : undefined
  const isOwnSide = (m: MemoryCardData | null) => m === null || m.scope === 'workspace' && projectName(m) === undefined

  // 会话快照冻结在插件本次加载之前 = 对话里还是重启前带入的那份
  const bootedAt = health.status === 'ready' ? health.data.bootedAt : undefined
  const usageTitle = t(USAGE_TITLE[snapshot?.origin ?? 'start'])
  const usage = snapshot === undefined
    ? sessionView.status === 'missing'
      ? <Note title={t('sidebar.noSnapshot.title')}>{t('sidebar.noSnapshot.body')}</Note>
      : <ViewMessage state={sessionView} idle={t('view.loading')} className="pm-side-hint" />
    : bootedAt !== undefined && snapshot.frozenAt < bootedAt
      ? <Note title={t('sidebar.stale.title')}>{t('sidebar.stale.body')}</Note>
      : (
        <>
          <ContextBudgetBar
            count={snapshot.injectedIds.length}
            budget={snapshot.budget}
            tokens={snapshot.tokens}
            usedTokens={snapshot.usedTokens}
            droppedCount={snapshot.overflowMode === 'strict' ? snapshot.omittedCount : 0}
            onHandle={() => { openPage({ view: 'todo', ...(scope === undefined ? {} : { scope }), fromChat: true }) }}
          />
          <p className="pm-side-hint">{t('sidebar.usage.searchNote')}</p>
        </>
      )

  const waiting = decisions.filter(d => d.kind !== 'ruled').length
  const toPage = () => { openPage({ view: 'todo', ...(scope === undefined ? {} : { scope }), fromChat: true, level: 'your-call' }) }
  /**
   * 冲突卡下面的整块（横向、基线冲突同一套）：建议结论一行；能采纳的（保留一方、删除这条、都保留）给「采纳建议」和一句采纳后的去向，
   * 后面跟「在记忆页处理 ›」。suggestion 是此刻卡上能用的那份（失效、记忆找不到、基线冲突不在它的项目里时为 undefined）。
   */
  const conflictFooter = (item: Conflict | VerticalConflict, suggestion: Suggestion | undefined, isStale: boolean) => {
    const verdict = suggestion === undefined ? undefined : verdictOfAction(suggestion.action)
    const { horizontal, vertical } = CONFLICT_ACTION_VERDICTS
    const adoptNote = verdict === undefined ? undefined
      : item.kind === 'conflict-vertical'
        ? t(verdict === vertical.keepBaseline ? item.memory?.hasSecret === true ? 'pending.vertical.adoptNotePurge' : 'pending.vertical.adoptNoteDelete' : 'pending.vertical.adoptNoteKeepBoth')
        : verdict === horizontal.keepBoth ? t('pending.conflict.adoptNoteKeepBoth')
          : t('pending.conflict.adoptNote', { drop: verdict === horizontal.keepA ? 'B' : 'A' })
    return (
      <>
        {suggestion !== undefined
          ? (
            <p className="pm-side-suggestion">
              <span className="pm-side-suggestion-icon"><Icon name="sparkle" size={14} /></span>
              <span>{t('sidebar.suggestion.lead')}<strong>{t(ACTION_LABEL[suggestion.action])}</strong></span>
            </p>
          )
          : null}
        {suggestion === undefined && !isStale && item.noSuggestion?.code === 'undecided'
          ? <p className="pm-side-hint">{t('sidebar.suggestion.undecided')}</p>
          : null}
        {isStale ? <p className="pm-side-hint" role="status">{t('sidebar.suggestion.stale')}</p> : null}
        {adoptNote !== undefined ? <AdviceNote label="note">{adoptNote}</AdviceNote> : null}
        <div className="pm-conflict-actions">
          {suggestion !== undefined && verdict !== undefined
            ? (
              <Button variant="primary" unavailable={runner.unavailable(item.decisionId)} onClick={() => { adopt(item, suggestion, verdict) }}>
                {t('pending.conflict.adopt')}
              </Button>
            )
            : null}
          {/* 和底部入口同名：去的是同一处 */}
          <button type="button" className="pm-link" onClick={toPage}>{t('sidebar.footer.pendingLink')}</button>
        </div>
      </>
    )
  }
  /** 卡上这一份建议采纳时回过 stale：当作没有建议。 */
  const isStaleOf = (item: Conflict | VerticalConflict) => {
    const staleId = staleSuggestions.get(item.decisionId)
    return staleId !== undefined && (item.suggestion === undefined || item.suggestion.id === staleId)
  }
  /** 「等你决定」里的一张卡：冲突写建议结论、能采纳的就地采纳，其余去记忆页；刚裁决的留结果和撤销。 */
  const decision = (entry: Decision) => {
    if (entry.kind === 'conflict') {
      const { item } = entry
      const isStale = isStaleOf(item)
      const suggestion = isStale || item.left === null || item.right === null ? undefined : item.suggestion
      return (
        <div key={item.decisionId}>
          <ConflictRuling
            layout="narrow"
            left={item.left}
            right={item.right}
            now={now}
            typeLabel={label}
            hideScope={isOwnSide(item.left) && isOwnSide(item.right)}
            projectName={projectName}
            footer={conflictFooter(item, suggestion, isStale)}
          />
          {failed(item.decisionId)}
        </div>
      )
    }
    if (entry.kind === 'vertical') {
      const { item } = entry
      const isStale = isStaleOf(item)
      const suggestion = isStale || item.memory === null ? undefined : item.suggestion
      return (
        <div key={item.decisionId}>
          <VerticalConflictRuling
            layout="narrow"
            memory={item.memory}
            baselineRef={item.baselineRef}
            now={now}
            typeLabel={label}
            hideScope={item.memory?.scope !== 'global'}
            footer={conflictFooter(item, suggestion, isStale)}
          />
          {failed(item.decisionId)}
        </div>
      )
    }
    const { ruled: r } = entry
    return (
      <div key={r.decisionId}>
        <RuledCard ruled={r} card={card} unavailable={runner.unavailable(r.decisionId)} onUndo={() => { undo(r.decisionId) }} />
        {failed(r.decisionId)}
      </div>
    )
  }

  return (
    <div className="pm-side">
      {ws !== undefined
        ? <p className="pm-side-crumb"><span className="pm-side-crumb-scope">{t('sidebar.crumb.scope')}</span> {baseName(ws)}</p>
        : null}
      {projectCount === 0 ? <p className="pm-side-crumb-hint">{t('sidebar.globalOnly')}</p> : null}

      <section className="pm-side-usage" aria-label={usageTitle}>
        <h2 className="pm-side-title">{usageTitle}</h2>
        {usage}
      </section>

      {saved.length > 0 || changes.length > 0
        ? (
          <section className="pm-side-section" aria-label={t('sidebar.saved.title')}>
            <div className="pm-side-section-head">
              <h2 className="pm-side-title">{t('sidebar.saved.title')}</h2>
              <p className="pm-side-hint">{t('sidebar.saved.note')}</p>
            </div>
            {saved.map(({ id, memory, isWrittenToAgentsMd, isDeleted }) => {
              const row = memory === undefined
                ? purgedNote(id)
                : isDeleted === true
                  ? (
                    <div key={id} className="pm-side-saved pm-side-saved--deleted" data-memory-id={id}>
                      <p className="pm-side-hint">{t('chat.card.deleted')}</p>
                      <Button variant="ghost" unavailable={runner.unavailable(id)} onClick={() => { restore(memory) }}>
                        {t('chat.card.undo')}
                      </Button>
                    </div>
                  )
                : isWrittenToAgentsMd === true
                  ? <SavedRow key={id} session={session} memory={memory} card={card} state="wrote-agents-md">{null}</SavedRow>
                  : (
                  <SavedRow
                    key={id}
                    session={session}
                    memory={memory}
                    card={card}
                    onWroteAgentsMd={() => { setWroteAgentsMd(prev => new Map(prev).set(id, memory)) }}
                  >
                    <DeleteWithConfirm
                      onDelete={() => { forget(memory) }}
                      trigger={open => (
                        <Button
                          variant="icon"
                          aria-label={t('sidebar.saved.delete')}
                          title={t('sidebar.saved.delete')}
                          unavailable={runner.unavailable(id)}
                          onClick={open}
                        >
                          <Icon name="trash" size={14} />
                        </Button>
                      )}
                    />
                    {failed(id)}
                  </SavedRow>
                )
              // 对话里刚写入的：撑开位置落进来，银藤浅底亮一下
              return <Arrival key={id} arrivals={arrivals} id={id} highlight>{row}</Arrival>
            })}
            {changes.map(change => change.kind === 'rewrite'
              ? (
                <div key={change.decisionId} className="pm-side-change" data-memory-id={change.memoryId}>
                  {card(byId.get(change.memoryId) ?? change.before)}
                  <ModelChangeLine session={session} change={change} kind="rewrite" after={byId.get(change.memoryId)} />
                </div>
              )
              : (
                <div key={change.decisionId} className="pm-side-change" data-memory-id={change.memoryId}>
                  <ModelChangeLine
                    session={session}
                    change={change}
                    kind="supersede"
                    bySubject={change.by === undefined ? undefined : byId.get(change.by)?.name}
                  />
                </div>
              ))}
          </section>
        )
        : null}

      {refused !== undefined && !inline.has(refused) && !ruledIds.has(refused) ? refusedNote : null}
      {decisions.length > 0
        ? (
          <section className="pm-side-section" aria-label={t('pending.level.your-call')}>
            <Fold
              level={2}
              className="pm-side-title"
              isOpen={folds.isOpen(YOUR_CALL, true)}
              onToggle={() => { folds.toggle(YOUR_CALL, folds.isOpen(YOUR_CALL, true)) }}
              heading={(
                <>
                  {t('pending.level.your-call')}
                  {waiting > 0 ? <>{' '}<span className="pm-side-group-count">{formatNumber(waiting)}</span><StatusMarker kind="pending" /></> : null}
                </>
              )}
            >
              {decisions.map(decision)}
            </Fold>
          </section>
        )
        : null}

      {groups.length > 0
        ? (
          <section className="pm-side-section" aria-label={t('sidebar.groups.title')}>
            <h2 className="pm-side-title">{t('sidebar.groups.title')}</h2>
            {groups.map(({ type, depth, memories }) => {
              const key = `type|${type}`
              const isOpen = folds.isOpen(key, false)
              return (
                <section key={type} className="pm-side-group" aria-label={label(type)}>
                  <Fold
                    level={3}
                    className="pm-side-group-title"
                    isOpen={isOpen}
                    onToggle={() => { folds.toggle(key, isOpen) }}
                    heading={(
                      <>
                        {label(type)}{' '}
                        <span className="pm-side-group-count">{formatNumber(memories.length)}</span>
                        {depth === undefined ? null : (
                          <>
                            {' '}<i className="pm-sep" aria-hidden="true">·</i>
                            <span className="pm-side-group-depth">{t(DEPTH_LABEL[depth])}</span>
                          </>
                        )}
                      </>
                    )}
                  >
                    {memories.map(memory => <div key={memory.id}>{card(memory)}</div>)}
                  </Fold>
                </section>
              )
            })}
          </section>
        )
        : null}

      {scope !== undefined && (restPending > 0 || projectCount > 0)
        ? (
          <p className="pm-side-footer">
            {restPending > 0
              ? t('sidebar.footer.pending', { n: formatNumber(restPending) })
              : t(projectCount === 1 ? 'sidebar.footer.count.one' : 'sidebar.footer.count', { n: formatNumber(projectCount) })}
            <i className="pm-sep" aria-hidden="true">·</i>
            <button
              type="button"
              className="pm-link"
              onClick={() => { openPage({ view: restPending > 0 ? 'todo' : 'library', scope, fromChat: true }) }}
            >
              {t(restPending > 0 ? 'sidebar.footer.pendingLink' : 'sidebar.footer.countLink')}
            </button>
          </p>
        )
        : null}
    </div>
  )
}

/** 这次新写入的一行：记忆卡 + 行尾删除；提升候选的建议区和两个动作（处理过换成结果行）在卡片下面。 */
function SavedRow({ session, memory, card, state, onWroteAgentsMd, children }: {
  session: BorrowedSession
  memory: MemoryCardData
  card: (memory: MemoryCardData) => ReactNode
  /** 提升状态；缺省按全部记忆视图（写进 AGENTS.md 的由上层给）。 */
  state?: InPlacePromotion
  onWroteAgentsMd?: () => void
  /** 行尾删除与它的反馈。 */
  children: ReactNode
}) {
  const promote = usePromoteInPlace(session, memory, scopeOfMemory(memory), state ?? promotionOf(memory), onWroteAgentsMd)
  return (
    <div className="pm-side-saved" data-memory-id={memory.id}>
      <div>{card(memory)}</div>
      {children}
      <div className="pm-side-saved-promote">{promote}</div>
    </div>
  )
}

/**
 * 刚裁决完：留下的卡（按基线则不留卡），下面结果行「已保留 A」（基线冲突：「已按基线」「已保留这条记忆」）+ 后果 +「撤销」。
 * 冲突在这里只能采纳建议，后果前面先写来由「按模型建议处理。」（同记忆页的结果卡）。
 */
function RuledCard({ ruled, card, unavailable, onUndo }: {
  ruled: Ruled
  card: (memory: MemoryCardData) => ReactNode
  unavailable: string | undefined
  onUndo: () => void
}) {
  const t = useT()
  const { verdict } = ruled
  const isBaseline = ruled.kind === 'vertical' && verdict === CONFLICT_ACTION_VERDICTS.vertical.keepBaseline
  const chipKey = ruled.kind === 'vertical'
    ? isBaseline ? 'sidebar.ruled.keepBaseline' : 'sidebar.ruled.keepMemory'
    : verdict === 'keep-left' ? 'sidebar.ruled.keepA' : verdict === 'keep-right' ? 'sidebar.ruled.keepB' : 'sidebar.ruled.keepBoth'
  const outcome = ruled.isUnrecorded ? t('sidebar.ruled.unrecorded')
    : ruled.isHardDeleted ? ruled.kind === 'vertical' ? t('conflict.purgedMemory') : t('conflict.purgedSide', { side: verdict === 'keep-left' ? 'B' : 'A' })
    : t(ruled.kind === 'vertical' ? isBaseline ? 'sidebar.ruled.deletedMemory' : 'sidebar.ruled.keptMemory'
      : verdict === 'keep-left' ? 'sidebar.ruled.deletedB' : verdict === 'keep-right' ? 'sidebar.ruled.deletedA' : 'sidebar.ruled.keptBoth')
  const note = t('conflict.twoSentences', { first: t('pending.result.bySuggestion'), second: outcome })
  // 删掉了一条时补一句生效时机：这次对话的快照已冻结，删掉的那条要到压缩后或下个对话才不再带入
  const isDeleting = ruled.kind === 'vertical' ? isBaseline : verdict !== CONFLICT_ACTION_VERDICTS.horizontal.keepBoth
  const kept = ruled.kind === 'vertical' ? isBaseline ? [] : [ruled.memory]
    : verdict === 'keep-left' ? [ruled.left] : verdict === 'keep-right' ? [ruled.right] : [ruled.left, ruled.right]
  return (
    <article className="pm-side-ruled">
      {kept.map(memory => <div key={memory.id}>{card(memory)}</div>)}
      <ResultLine
        chip={t(chipKey)}
        undo={ruled.isUnrecorded || ruled.isHardDeleted
          ? undefined
          : (
            <Button variant="ghost" unavailable={unavailable} onClick={onUndo}>
              {t('sidebar.ruled.undo')}
            </Button>
          )}
      >
        {note}
        {isDeleting ? <> <span>{t('sidebar.ruled.appliesLater')}</span></> : null}
      </ResultLine>
    </article>
  )
}

/**
 * 可折叠的一段：标题是整行按钮，level 2 是段标题、3 是类型组标题。箭头放在行末（展开时转 90°），
 * 标题文字和不折叠的段标题、组里记忆卡的竖线从同一处起。
 * 只有点标题展开时组体撑开（同记忆查看），首屏、视图刷新都瞬开，收起瞬收。
 */
function Fold({ level, className, heading, isOpen, onToggle, children }: {
  level: 2 | 3
  className: string
  heading: ReactNode
  isOpen: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const bodyId = useId()
  const isClicked = useRef(false)
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <>
      <Heading className={className}>
        <button
          type="button"
          className="pm-side-fold"
          aria-expanded={isOpen}
          aria-controls={bodyId}
          onClick={() => { isClicked.current = !isOpen; onToggle() }}
        >
          <span className="pm-side-fold-label">{heading}</span>
          <Icon name="chevronRight" size={14} />
        </button>
      </Heading>
      <div id={bodyId} className="pm-side-fold-body" hidden={!isOpen}>
        {isOpen ? <GroupBody clicked={isClicked}>{children}</GroupBody> : null}
      </div>
    </>
  )
}

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pm-side-note" role="status">
      <p className="pm-side-note-title">{title}</p>
      <p className="pm-side-note-body">{children}</p>
    </div>
  )
}

export const sidebarTabCss = `
.pm-side-root { height: 100%; min-height: 0; }
.pm-side {
  height: 100%; min-height: 0; overflow: auto; scrollbar-gutter: stable;
  display: flex; flex-direction: column; gap: 20px; padding: 12px 16px 24px; background: var(--pm-bg);
}
.pm-side-crumb { margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); overflow-wrap: anywhere; }
.pm-side-crumb-scope { color: var(--pm-text-2); }
.pm-side-crumb-hint { margin: -14px 0 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-side-usage { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 6px 8px; }
.pm-side-usage > .pm-budget { display: contents; }
.pm-side-usage .pm-budget-summary { grid-column: 2; grid-row: 1; }
.pm-side-usage .pm-budget-bar, .pm-side-usage .pm-budget-legend, .pm-side-usage > .pm-side-note, .pm-side-usage > .pm-side-hint { grid-column: 1 / -1; }
.pm-side-section { display: flex; flex-direction: column; gap: 12px; --pm-arrive-gap: 12px; }
.pm-side-group { display: flex; flex-direction: column; gap: 12px; }
.pm-side-group-title { margin: 4px 0 0; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-group-count { margin-left: 4px; font-weight: 400; color: var(--pm-text-2); }
.pm-side-group-title .pm-sep { margin: 0 6px 0 2px; }
.pm-side-group-depth { font-weight: 400; color: var(--pm-text-2); }
.pm-side-fold {
  display: flex; align-items: center; gap: 4px; width: calc(100% + 8px); margin: 0 -4px; padding: 2px 4px;
  border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer;
}
.pm-side-fold:hover { background: var(--pm-hover); }
.pm-side-fold svg { flex: none; margin-left: auto; color: var(--pm-text-2); transition: transform 120ms ease; }
.pm-side-fold[aria-expanded='true'] svg { transform: rotate(90deg); }
.pm-side-fold-label { min-width: 0; overflow-wrap: anywhere; }
.pm-side-fold-label .pm-marker { margin: -2px 0 0 6px; }
.pm-side-fold-body, .pm-side-fold-body .pm-arrive-body { display: flex; flex-direction: column; gap: 12px; }
.pm-side-fold-body[hidden] { display: none; }
.pm-side-section-head { display: flex; flex-direction: column; gap: 2px; }
.pm-side-saved { display: grid; grid-template-columns: minmax(0, 1fr) 24px; align-items: start; gap: 4px 8px; }
.pm-side-saved > .pm-pending-error, .pm-side-saved > .pm-side-saved-promote { grid-column: 1 / -1; }
.pm-side-saved--deleted { display: flex; align-items: center; justify-content: space-between; }
.pm-side-saved-promote { display: flex; flex-direction: column; gap: 8px; }
.pm-side-saved-promote:empty { display: none; }
.pm-side-change { display: flex; flex-direction: column; gap: 6px; }
.pm-side-change > .pm-change:only-child { padding-left: 0; }
/* 侧栏窄，删除确认放不进行尾：换到卡片下面一行靠右，记忆卡不跟着变窄 */
.pm-side-saved > .pm-soft-confirm { grid-column: 1 / -1; justify-self: end; }
.pm-side .pm-conflict { padding-bottom: 0; }
.pm-side .pm-conflict .pm-mc-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.pm-side .pm-conflict-actions .pm-btn { padding: 5px 10px; }
.pm-side .pm-conflict-footer { gap: 8px; }
/* 建议结论一行：图标和文字顶齐，窄宽度下文字折行 */
.pm-side-suggestion {
  display: flex; align-items: flex-start; gap: 6px; min-width: 0; margin: 0;
  font-size: 13px; line-height: 1.5; color: var(--pm-text); overflow-wrap: anywhere;
}
/* 模型图标同记忆页建议块：主题色；高度同一行文字，和第一行居中 */
.pm-side-suggestion-icon { display: inline-flex; flex: none; align-items: center; height: 19.5px; color: var(--pm-accent); }
.pm-side-suggestion strong { font-weight: 600; }
.pm-side-ruled { display: flex; flex-direction: column; gap: 10px; }
.pm-side-note { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-side-note-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-side-note-body { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-footer {
  margin: auto 0 0; padding-top: 12px; border-top: .5px solid var(--pm-line);
  font-size: 12px; line-height: 1.5; color: var(--pm-text-2);
}
.pm-side-footer .pm-link { font-size: 12px; }
@media (prefers-reduced-motion: reduce) {
  .pm-side-fold svg { transition: none; }
}
`

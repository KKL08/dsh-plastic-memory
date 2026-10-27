/**
 * 右侧栏「记忆」tab 正文（DESIGN.md Layout「右侧栏记忆 tab 内容（结构 A）」）。只讲插件放进上下文的那份快照和这次新写入的，
 * 对话中 memory_search 搜到的算普通上下文，不列、不计用量。从上到下：
 * 面包屑「本项目 / 项目名」→ 对话开始时 / 重新 / 压缩后重新带入的记忆（随快照来历换标题，用量条）→ 这次新写入的（可删，
 * 进了新快照的移到带入的记忆）→ 带入的记忆（按类型分组，组标题标出全文、只带摘要或只带标题；
 * 带入的记忆有待决冲突时冲突卡挂在那条记忆所在组里就地裁决：横向是两条记忆，垂直是记忆对 AGENTS.md 基线）→ 底部一行入口（其余待处理只在这里带数字）。
 * 数据：会话视图（来历、带入 / 全文 / 只带标题 / 新写入的 id、用量）、全部记忆视图（按 id 取记忆卡）、待处理视图（冲突与本项目待处理数）、
 * 健康视图（bootedAt：插件本次加载时刻）。
 * 四种状态：无记忆、有全局没本项目、正常、frozenAt 早于插件本次加载（重启后未重新带入；视图没带 bootedAt 时不判断）。
 * 刚裁决的冲突在本地留原位可撤销，tab 卸载后收起。
 * 裁决碰上这条冲突正在别处处理或刚处理完（什么都没动）：冲突卡还在时原位说明，那边的结果写进视图、卡片消失后
 * 说明挪到「带入的记忆」上面（没有记忆了就在空状态上面），下一次动作时收起。
 * 新写入的行尾删除先在原位确认「删除这条？ 删除 · 取消」，点「删除」才发 forget。
 * 新写入的含密钥时不能软删（服务端回 has-secret，什么都没动）：原位确认，「彻底删除」发 hard-delete，删后原位留不可恢复的说明，tab 卸载后收起。
 */
import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CONFLICT_ACTION_VERDICTS, layerOfMemory, type MemoryCard as MemoryCardData, type MemoryCommand, type PendingItem, type SnapshotOrigin,
} from '../../src/gui/contract.ts'
import { samePath, useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { baseName, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { sidebarZh } from '../locales/sidebar.ts'
import type { NavTarget } from '../nav.ts'
import { mergeTypeLabels } from '../library/shared.tsx'
import { Chip } from '../ui/Chip.tsx'
import { ConflictRuling, VerticalConflictRuling } from '../ui/ConflictRuling.tsx'
import { ContextBudgetBar } from '../ui/ContextBudgetBar.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { TrashIcon } from '../ui/TrashIcon.tsx'
import { CrossConfirm, crossConfirmCss, isHandledElsewhere, DeleteWithConfirm, SecretDeleteConfirm } from '../pending/action.tsx'
import { keepFocusInPlace } from '../ui/focus-return.ts'
import { isLiveWrite, sessionCards, writtenSinceSnapshot } from './session-memories.ts'

type Conflict = Extract<PendingItem, { kind: 'conflict-horizontal' }>
type VerticalConflict = Extract<PendingItem, { kind: 'conflict-vertical' }>
type Verdict = 'keep-left' | 'keep-right' | 'keep-both'

/** 刚裁决的冲突：记忆的快照留着，被删后仍能原位显示。 */
type Ruled =
  | { kind: 'horizontal'; decisionId: string; verdict: Verdict; left: MemoryCardData; right: MemoryCardData }
  | { kind: 'vertical'; decisionId: string; verdict: Verdict; memory: MemoryCardData }

const ruledMemories = (r: Ruled): MemoryCardData[] => r.kind === 'horizontal' ? [r.left, r.right] : [r.memory]

/** 用量标题随快照来历变。 */
const USAGE_TITLE: Record<SnapshotOrigin, LocaleKey> = {
  start: 'sidebar.usage.title',
  resumed: 'sidebar.usage.titleResumed',
  compacted: 'sidebar.usage.titleCompacted',
}

type Entry =
  | { kind: 'memory'; memory: MemoryCardData }
  | { kind: 'conflict'; item: Conflict }
  | { kind: 'vertical'; item: VerticalConflict }
  | { kind: 'ruled'; ruled: Ruled }

export interface SidebarTabProps {
  /** tab 所在的会话。 */
  sessionId: string
  /** 该会话的工作目录；会话视图带了 workspacePath 时以视图为准。 */
  workspacePath?: string | undefined
  /** 跳到记忆页（经导航 store）。 */
  openPage: (target: NavTarget) => void
}

/** 内置类型按界面语言写；其余（自定义、切模板前的旧类型）取全部记忆、待处理视图的 typeLabels，再认不出写 id。 */
function typeLabel(t: Translate, type: string, labels: Readonly<Record<string, string>> | undefined): string {
  const key = `sidebar.type.${type}`
  return key in sidebarZh ? t(key as LocaleKey) : labels?.[type] ?? type
}

/** 待处理条目是否属于这个项目。 */
function inWorkspace(item: PendingItem, ws: string): boolean {
  const own = (m: MemoryCardData | null) => m !== null && m.scope === 'workspace' && samePath(m.workspacePath, ws)
  switch (item.kind) {
    case 'secret': case 'conflict-vertical': case 'promote-candidate': return own(item.memory)
    case 'conflict-horizontal': return own(item.left) || own(item.right)
    case 'overflow': return samePath(item.workspacePath, ws)
    case 'unreadable-file': return item.layer.kind === 'workspace' && samePath(item.layer.workspacePath, ws)
    // 右侧栏这次不分级，建议整理不算进「本项目还有 N 处待处理」
    case 'advice': return false
  }
}

export function SidebarTab({ sessionId, workspacePath: cwd, openPage }: SidebarTabProps) {
  const t = useT()
  const gateway = useGateway()
  const session = useMemo<BorrowedSession>(() => ({ kind: 'ready', sessionId, cwd }), [sessionId, cwd])
  const sessionView = gateway.useView(session, 'session')
  const library = gateway.useView(session, 'library')
  const pending = gateway.useView(session, 'pending')
  const health = gateway.useView(session, 'health')
  // 删过的记忆（这里、全部记忆或对话交付卡删的）：新记的列表里立刻去掉，不等视图刷新
  const deletions = gateway.useDeletions()
  const [ruled, setRuled] = useState<readonly Ruled[]>([])
  const [purged, setPurged] = useState<ReadonlySet<string>>(new Set())
  const [secretId, setSecretId] = useState<string | undefined>(undefined)
  // 在途的动作按条（待决项 id / 记忆 id）记：别的动作开始或结束都不让这一条重新可点，同一条冲突不会发出两条相反的裁决。
  // ref 同步拦截，state 只管渲染
  const inFlight = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState<{ id: string; detail: string } | undefined>(undefined)
  /** 没有生效的那次裁决或撤销（待决项 id）。 */
  const [refused, setRefused] = useState<string | undefined>(undefined)
  // 涉及其他项目时服务端先拒（什么都没动），和待处理卡同一套：原位确认，「继续处理」才带 allowCrossWorkspace 重发
  const [cross, setCross] = useState<{ id: string; workspacePath: string; command: MemoryCommand; onOk: () => void } | undefined>(undefined)

  const run = async (id: string, command: MemoryCommand, onOk: () => void) => {
    if (inFlight.current.has(id)) return
    inFlight.current.add(id)
    keepFocusInPlace()
    setBusy(new Set(inFlight.current))
    setFailure(undefined)
    setRefused(undefined)
    setCross(undefined)
    setSecretId(undefined)
    const result = await gateway.execute(sessionId, command)
    inFlight.current.delete(id)
    setBusy(new Set(inFlight.current))
    if (result.ok) { onOk(); return }
    const workspacePath = result.rejected?.[0]?.workspacePath
    const isAllowed = 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
    if (result.code === 'cross-workspace' && !isAllowed && workspacePath !== undefined) setCross({ id, workspacePath, command, onOk })
    else if (result.code === 'has-secret' && command.cmd === 'forget') setSecretId(id)
    else if (isHandledElsewhere(command, result)) setRefused(id)
    else setFailure({ id, detail: result.detail ?? result.code })
  }
  const rule = (item: Conflict, verdict: Verdict) => {
    const { left, right } = item
    if (left === null || right === null) return
    void run(item.decisionId, { cmd: 'resolve', decisionId: item.decisionId, verdict }, () => {
      setRuled(prev => [...prev, { kind: 'horizontal', decisionId: item.decisionId, verdict, left, right }])
    })
  }
  const ruleVertical = (item: VerticalConflict, verdict: Verdict) => {
    const { memory } = item
    if (memory === null) return
    void run(item.decisionId, { cmd: 'resolve', decisionId: item.decisionId, verdict }, () => {
      setRuled(prev => [...prev, { kind: 'vertical', decisionId: item.decisionId, verdict, memory }])
    })
  }
  const undo = (decisionId: string) => {
    void run(decisionId, { cmd: 'undo', decisionId }, () => { setRuled(prev => prev.filter(r => r.decisionId !== decisionId)) })
  }
  const forget = (memory: MemoryCardData) => {
    const memoryId = memory.id
    void run(memoryId, { cmd: 'forget', memoryId, layer: layerOfMemory(memory) }, () => {})
  }
  // 发出时就记下，等删除状态记成彻底删除再换上说明：网关记删除和这里的成功回调不在同一次提交，
  // 回调里才记会先空出一帧（这一行没了、说明还没来），焦点趁机落到后面的控件上
  const hardDelete = (memoryId: string, memory: MemoryCardData | undefined) => {
    setPurged(prev => new Set(prev).add(memoryId))
    void run(memoryId, { cmd: 'hard-delete', memoryId, layer: memory && layerOfMemory(memory) }, () => {})
  }
  const isPurged = (id: string) => purged.has(id) && deletions.of(id) === 'hard'

  if (library.status !== 'ready') return <div className="pm-side"><ViewNote state={library} /></div>

  const snapshot = sessionView.status === 'ready' ? sessionView.data : undefined
  const ws = snapshot?.workspacePath ?? cwd
  const { byId, globalCount, projectCount } = sessionCards(library.data, ws)
  // 彻底删除的那条视图里已经没有了，按 id 原位留一行说明（删的是最后一条时留在空状态上面，也是焦点的落点）
  const purgedNote = (id: string) => <p key={id} className="pm-side-hint" tabIndex={-1}>{t('pending.secret.deletedNotice')}</p>
  const refusedNote = <p className="pm-side-error" role="alert" tabIndex={-1}>{t('sidebar.action.refused')}</p>
  if (globalCount === 0 && projectCount === 0) {
    return (
      <div className="pm-side">
        {(snapshot?.savedIds ?? []).filter(isPurged).map(purgedNote)}
        {refused !== undefined ? refusedNote : null}
        <EmptyState variant="first" title={t('sidebar.empty.title')}>{t('sidebar.empty.body')}</EmptyState>
      </div>
    )
  }

  // 带入的记忆按类型分组；记忆有待决横向冲突（或刚裁决完）时，那张冲突卡占它的位置，另一方不再单独列
  const pendingItems = pending.status === 'ready' ? pending.data.items : []
  const conflicts = pendingItems.filter((item): item is Conflict => item.kind === 'conflict-horizontal')
  const verticals = pendingItems.filter((item): item is VerticalConflict => item.kind === 'conflict-vertical')
  const labels = mergeTypeLabels(library, pending)
  const label = (type: string) => typeLabel(t, type, labels)
  const ruledIds = new Set(ruled.map(r => r.decisionId))
  const inline = new Set<string>()
  const shown = new Set<string>()
  const groups = new Map<string, Entry[]>()
  const counts = new Map<string, number>()
  // 每组按带入方式计数：快照按类型决定全文（core 区）、带摘要的索引行还是只带名称和标签的索引行，一组正常只有一种
  const coreIds = new Set(snapshot?.coreIds ?? [])
  const titleOnlyIds = new Set(snapshot?.titleOnlyIds ?? [])
  const fullCounts = new Map<string, number>()
  const titleCounts = new Map<string, number>()
  const push = (type: string, entry: Entry) => { groups.set(type, [...groups.get(type) ?? [], entry]) }
  for (const id of snapshot?.injectedIds ?? []) {
    const done = ruled.find(r => ruledMemories(r).some(m => m.id === id))
    const memory = byId.get(id) ?? (done === undefined ? undefined : ruledMemories(done).find(m => m.id === id))
    if (memory === undefined) continue
    counts.set(memory.type, (counts.get(memory.type) ?? 0) + 1)
    if (coreIds.has(id)) fullCounts.set(memory.type, (fullCounts.get(memory.type) ?? 0) + 1)
    if (titleOnlyIds.has(id)) titleCounts.set(memory.type, (titleCounts.get(memory.type) ?? 0) + 1)
    if (shown.has(id)) continue
    const open = done === undefined
      ? conflicts.find(c => !ruledIds.has(c.decisionId) && (c.left?.id === id || c.right?.id === id))
      : undefined
    const openVertical = done === undefined && open === undefined
      ? verticals.find(c => !ruledIds.has(c.decisionId) && c.memory?.id === id)
      : undefined
    if (done !== undefined) {
      push(memory.type, { kind: 'ruled', ruled: done })
      for (const m of ruledMemories(done)) shown.add(m.id)
    } else if (openVertical !== undefined) {
      push(memory.type, { kind: 'vertical', item: openVertical })
      inline.add(openVertical.decisionId)
      shown.add(id)
    } else if (open !== undefined) {
      push(memory.type, { kind: 'conflict', item: open })
      inline.add(open.decisionId)
      for (const side of [open.left, open.right]) if (side !== null) shown.add(side.id)
    } else {
      push(memory.type, { kind: 'memory', memory })
      shown.add(id)
    }
  }
  // 这次新写入的只列还没进快照、还在的；彻底删除的原位留说明
  const saved = (snapshot === undefined ? [] : writtenSinceSnapshot(snapshot))
    .flatMap((id): Array<{ id: string; memory: MemoryCardData | undefined }> =>
      isPurged(id) ? [{ id, memory: undefined }] : isLiveWrite(id, byId, deletions) ? [{ id, memory: byId.get(id) }] : [])
  const scope = ws === undefined ? undefined : { kind: 'workspace' as const, workspacePath: ws }
  const restPending = ws === undefined || pending.status !== 'ready'
    ? 0
    : pending.data.items.filter(item => inWorkspace(item, ws) && !('decisionId' in item && (inline.has(item.decisionId) || ruledIds.has(item.decisionId)))).length
  const now = Date.now()
  const card = (memory: MemoryCardData, chip?: ReactNode) => (
    <MemoryCard memory={memory} now={now} typeLabel={label(memory.type)} hideScope={memory.scope === 'workspace'} chip={chip} />
  )
  const failed = (id: string) => {
    if (secretId === id) return <SecretDeleteConfirm onCancel={() => { setSecretId(undefined) }} onConfirm={() => { hardDelete(id, byId.get(id)) }} />
    if (cross?.id === id) {
      return (
        <CrossConfirm
          workspacePath={cross.workspacePath}
          onCancel={() => { setCross(undefined) }}
          onConfirm={() => { void run(cross.id, { ...cross.command, allowCrossWorkspace: true } as MemoryCommand, cross.onOk) }}
        />
      )
    }
    if (refused === id) return refusedNote
    return failure?.id === id
      ? <p className="pm-side-error" role="alert">{t('sidebar.action.failed', { detail: failure.detail })}</p>
      : null
  }
  const isWaiting = (id: string) => busy.has(id) || cross?.id === id || secretId === id
  // 冲突对方可能在别的项目：那一方写项目名（这里的「本项目」是会话视图解析出的项目，和上面分层同一口径）
  const projectName = (m: MemoryCardData) =>
    m.scope === 'workspace' && m.workspacePath !== undefined && !samePath(m.workspacePath, ws) ? baseName(m.workspacePath) : undefined
  const isOwnSide = (m: MemoryCardData | null) => m === null || m.scope === 'workspace' && projectName(m) === undefined

  // 会话快照冻结在插件本次加载之前 = 重启后还没重新带入
  const bootedAt = health.status === 'ready' ? health.data.bootedAt : undefined
  const usageTitle = t(USAGE_TITLE[snapshot?.origin ?? 'start'])
  // 混着几种带入方式的组不标
  const depthMark = (type: string) => {
    const total = counts.get(type) ?? 0
    const full = fullCounts.get(type) ?? 0
    const titleOnly = titleCounts.get(type) ?? 0
    if (full === total) return t('sidebar.groups.full')
    if (titleOnly === total) return t('sidebar.groups.titleOnly')
    return full === 0 && titleOnly === 0 ? t('sidebar.groups.summary') : undefined
  }
  const usage = snapshot === undefined
    ? sessionView.status === 'missing'
      ? <Note title={t('sidebar.noSnapshot.title')}>{t('sidebar.noSnapshot.body')}</Note>
      : <ViewNote state={sessionView} />
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
            onHandle={() => { openPage({ tab: 'pending', ...(scope === undefined ? {} : { scope }) }) }}
          />
          <p className="pm-side-hint">{t('sidebar.usage.searchNote')}</p>
        </>
      )

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

      {saved.length > 0
        ? (
          <section className="pm-side-section" aria-label={t('sidebar.saved.title')}>
            <div className="pm-side-section-head">
              <h2 className="pm-side-title">{t('sidebar.saved.title')}</h2>
              <p className="pm-side-hint">{t('sidebar.saved.note')}</p>
            </div>
            {saved.map(({ id, memory }) => memory === undefined
              ? purgedNote(id)
              : (
                <div key={id} className="pm-side-saved">
                  <div className="pm-side-saved-card">{card(memory)}</div>
                  <DeleteWithConfirm
                    onDelete={() => { forget(memory) }}
                    trigger={open => (
                      <button
                        type="button"
                        className="pm-side-delete"
                        aria-label={t('sidebar.saved.delete')}
                        title={t('sidebar.saved.delete')}
                        aria-disabled={isWaiting(id) || undefined}
                        onClick={() => { if (!isWaiting(id)) open() }}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  />
                  {failed(id)}
                </div>
              ))}
          </section>
        )
        : null}

      {refused !== undefined && !inline.has(refused) && !ruledIds.has(refused) ? refusedNote : null}
      {groups.size > 0
        ? (
          <section className="pm-side-section" aria-label={t('sidebar.groups.title')}>
            <h2 className="pm-side-title">{t('sidebar.groups.title')}</h2>
            {[...groups].map(([type, entries]) => (
              <section key={type} className="pm-side-group" aria-label={label(type)}>
                <h3 className="pm-side-group-title">
                  {label(type)}{' '}
                  <span className="pm-side-group-count">{formatNumber(counts.get(type) ?? 0)}</span>
                  {depthMark(type) === undefined ? null : (
                    <>
                      {' '}<i className="pm-sep" aria-hidden="true">·</i>
                      <span className="pm-side-group-depth">{depthMark(type)}</span>
                    </>
                  )}
                </h3>
                {entries.map((entry) => {
                  if (entry.kind === 'memory') return <div key={entry.memory.id}>{card(entry.memory)}</div>
                  if (entry.kind === 'conflict') {
                    const { item } = entry
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
                          unavailable={isWaiting(item.decisionId) ? t('sidebar.action.busy') : undefined}
                          onRule={(verdict) => { rule(item, verdict) }}
                        />
                        {failed(item.decisionId)}
                      </div>
                    )
                  }
                  if (entry.kind === 'vertical') {
                    const { item } = entry
                    return (
                      <div key={item.decisionId}>
                        <VerticalConflictRuling
                          layout="narrow"
                          memory={item.memory}
                          baselineRef={item.baselineRef}
                          now={now}
                          typeLabel={label}
                          hideScope={item.memory?.scope !== 'global'}
                          unavailable={isWaiting(item.decisionId) ? t('sidebar.action.busy') : undefined}
                          onRule={(verdict) => { ruleVertical(item, verdict) }}
                        />
                        {failed(item.decisionId)}
                      </div>
                    )
                  }
                  const { ruled: r } = entry
                  return (
                    <div key={r.decisionId}>
                      <RuledCard ruled={r} card={card} busy={isWaiting(r.decisionId)} onUndo={() => { undo(r.decisionId) }} />
                      {failed(r.decisionId)}
                    </div>
                  )
                })}
              </section>
            ))}
          </section>
        )
        : null}

      {scope !== undefined && (restPending > 0 || projectCount > 0)
        ? (
          <p className="pm-side-footer">
            {restPending > 0
              ? t('sidebar.footer.pending', { n: formatNumber(restPending) })
              : t('sidebar.footer.count', { n: formatNumber(projectCount) })}
            <i className="pm-sep" aria-hidden="true">·</i>
            <button
              type="button"
              className="pm-link"
              onClick={() => { openPage({ tab: restPending > 0 ? 'pending' : 'library', scope }) }}
            >
              {t(restPending > 0 ? 'sidebar.footer.pendingLink' : 'sidebar.footer.countLink')}
            </button>
          </p>
        )
        : null}
    </div>
  )
}

/** 刚裁决完：留下的那条带「已按 A」（基线冲突：「已保留这条记忆」，按基线则不留卡），下面一行后果 +「撤销」。 */
function RuledCard({ ruled, card, busy, onUndo }: {
  ruled: Ruled
  card: (memory: MemoryCardData, chip?: ReactNode) => ReactNode
  busy: boolean
  onUndo: () => void
}) {
  const t = useT()
  const { verdict } = ruled
  const isBaseline = ruled.kind === 'vertical' && verdict === CONFLICT_ACTION_VERDICTS.vertical.keepBaseline
  const chipKey = ruled.kind === 'vertical'
    ? isBaseline ? 'sidebar.ruled.keepBaseline' : 'sidebar.ruled.keepMemory'
    : verdict === 'keep-left' ? 'sidebar.ruled.keepA' : verdict === 'keep-right' ? 'sidebar.ruled.keepB' : 'sidebar.ruled.keepBoth'
  const noteKey = ruled.kind === 'vertical'
    ? isBaseline ? 'sidebar.ruled.deletedMemory' : 'sidebar.ruled.keptMemory'
    : verdict === 'keep-left' ? 'sidebar.ruled.deletedB' : verdict === 'keep-right' ? 'sidebar.ruled.deletedA' : 'sidebar.ruled.keptBoth'
  const kept = ruled.kind === 'vertical' ? isBaseline ? [] : [ruled.memory]
    : verdict === 'keep-left' ? [ruled.left] : verdict === 'keep-right' ? [ruled.right] : [ruled.left, ruled.right]
  const chip = <Chip variant="result">{t(chipKey)}</Chip>
  return (
    <article className="pm-side-ruled">
      {kept.length === 0 ? <div>{chip}</div> : null}
      {kept.map((memory, i) => <div key={memory.id}>{card(memory, i === 0 ? chip : undefined)}</div>)}
      <p className="pm-side-ruled-note">
        {t(noteKey)}
        <button type="button" className="pm-link" aria-disabled={busy || undefined} onClick={() => { if (!busy) onUndo() }}>
          {t('sidebar.ruled.undo')}
        </button>
      </p>
    </article>
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

function ViewNote({ state }: { state: ViewState<unknown> }) {
  const t = useT()
  const text = state.status === 'error' ? t('view.error', { message: state.message })
    : state.status === 'outdated' ? t('view.outdated')
    : state.status === 'missing' ? t('view.missing')
    : t('view.loading')
  return <p className="pm-side-hint" role="status">{text}</p>
}

export const sidebarTabCss = crossConfirmCss + `
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
.pm-side-section { display: flex; flex-direction: column; gap: 12px; }
.pm-side-group { display: flex; flex-direction: column; gap: 12px; }
.pm-side-group-title { margin: 4px 0 0; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-group-count { margin-left: 4px; font-weight: 400; color: var(--pm-text-2); }
.pm-side-group-title .pm-sep { margin: 0 6px 0 2px; }
.pm-side-group-depth { font-weight: 400; color: var(--pm-text-2); }
.pm-side-section-head { display: flex; flex-direction: column; gap: 2px; }
.pm-side-saved { display: grid; grid-template-columns: minmax(0, 1fr) 24px; align-items: start; gap: 4px 8px; }
.pm-side-saved > .pm-side-error { grid-column: 1 / -1; }
/* 侧栏窄，删除确认放不进行尾：换到卡片下面一行靠右，记忆卡不跟着变窄 */
.pm-side-saved > .pm-soft-confirm { grid-column: 1 / -1; justify-self: end; }
.pm-side-delete {
  display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: var(--dsw-radius-sm, 8px); background: transparent; color: var(--pm-text-2); cursor: pointer;
}
.pm-side-delete:hover { background: var(--pm-hover); color: var(--pm-text); }
.pm-side-delete[aria-disabled='true'] { opacity: .4; cursor: default; }
.pm-side .pm-conflict { padding-bottom: 0; }
.pm-side .pm-conflict .pm-mc-text {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.pm-side .pm-conflict-buttons { flex-wrap: nowrap; }
.pm-side .pm-conflict-buttons .pm-btn { padding: 5px 10px; }
.pm-side-ruled { display: flex; flex-direction: column; gap: 10px; }
.pm-side-ruled-note { margin: 0; padding-left: 14px; font-size: 12px; line-height: 1.6; color: var(--pm-text-2); }
.pm-side-ruled-note .pm-link { margin-left: 8px; font-size: 12px; }
.pm-link[aria-disabled='true'] { opacity: .4; cursor: default; }
.pm-side-note { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-side-note-title { margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-side-note-body { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-side-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-error); }
.pm-side-footer {
  margin: auto 0 0; padding-top: 12px; border-top: .5px solid var(--pm-line);
  font-size: 12px; line-height: 1.5; color: var(--pm-text-2);
}
.pm-side-footer .pm-link { font-size: 12px; }
`

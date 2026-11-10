/**
 * 「记忆查看」：选中范围里的记忆卡列表。搜索框 → 项目和全局下一行存储说明（每条一个文件 · 目录 · 打开目录）→ 目录问题（来自视图，
 * 不在这里重算）→ 列表。单个范围按类型分组，每组先露 3 条；「全部」跨范围按更新时间分四段，卡片上的范围名点了下钻到那个范围。
 * 行尾「修改」·「删除」（先原位确认「删除这条？ 删除 · 取消」，再软删）·「打开文件」（纯图标）；
 * 删掉的那行原位换成结果行，可撤销（发 restore）；含密钥的再确认一次彻底删除，不可恢复。别处正在处理这一条时列表上方写明没有生效。
 * 「修改」在这一行下展开两段切换的面板（同待处理卡），同一时刻只展开一个，换行前有没保存的输入先原位问；
 * 应用或保存发 edit-memory，之后行内换成新内容、高亮一次、标「刚改」，结果行可撤销（发 undo）；结果行在展开别的面板或离开后收起。
 * 含密钥或没有版本的记忆不给「修改」（同待处理卡）。
 * 项目和全局范围的搜索框右侧有「选择」：进多选后每行左侧出勾选框、行尾按钮收起，勾选的行用选中行底色；列表底部浮起操作条
 * （已选条数 · 全选当前结果 · 取消 · 整理所选…）。「整理所选…」把列表换成整理工作区（batch-edit.tsx）。「全部」范围不能多选。
 * 工作区「应用全部」发 apply-edits；成功回到列表、退出多选，顶部结果条「已整理 N 条……」带「撤销全部」（发 undo，整批一起撤），
 * 改写过的行高亮一次、标「刚改」。结果条在离开记忆查看或开始下一次整理时收起。
 * 应用中途失败、已写的没能全部退回时同样回到列表，结果条换成「只应用了其中 k 条……」，副行写明哪几条没退回、为什么，
 * 「撤销全部」只撤仍是这次写下的；应用回 stale、not-found 时留在工作区，交给它等视图换成最新内容。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { checkupKey, MAX_BATCH_EDIT, scopeOfMemory, type LibraryView, type MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, useT, type Translate } from '../i18n.tsx'
import { isInScope, scopeLabel, type NavStore, type PageScope } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { EmptyState } from '../ui/EmptyState.tsx'
import { Icon } from '../ui/Icon.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { DeleteWithConfirm, SoftDeleteConfirm } from '../command/confirm.tsx'
import { baseOf, isEditable } from '../pending/cards.tsx'
import { EditPanel, type EditDraft } from '../pending/edit.tsx'
import { EditModes, type EditState } from '../pending/edit-modes.tsx'
import { ModelEditPanel } from '../pending/model-edit.tsx'
import { BatchEdit, toBatchItems, type BatchApplication, type BatchItem } from './batch-edit.tsx'
import { bucketize, GROUP_PREVIEW, groupByType, MemoryGroup, RECENT_BUCKETS, recentBucketOf, useFold, type FoldMemory } from './groups.tsx'
import { FlashRow, matchesQuery, SearchBox, useFlashTarget, useRowActions, useTypeLabel, ViewMessage } from './shared.tsx'

function dirName(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '')
}

/** 这个作用域的目录：记忆文件都在作用域目录顶层，取任一条的所在目录；空的全局落在 `<memoryRoot>/global`。 */
function scopeDir(view: LibraryView, scope: PageScope, firstFile: string | undefined): string | undefined {
  if (scope.kind === 'all') return undefined
  if (firstFile !== undefined && firstFile !== '') return dirName(firstFile)
  return scope.kind === 'global' ? `${view.memoryRoot.replace(/[\\/]+$/, '')}/global` : undefined
}

function shortPath(path: string, root: string): string {
  const base = root.replace(/[\\/]+$/, '')
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

function issueText(issue: LibraryView['directoryIssues'][number], root: string, t: Translate): string {
  const path = shortPath(issue.path, root)
  switch (issue.code) {
    case 'duplicate-id':
      // 在用的那份缺省时（旧视图文件）只能泛泛地说
      return issue.keptPath === undefined
        ? t('library.issue.other', { path })
        : t('library.issue.duplicate-id', { kept: shortPath(issue.keptPath, root), path })
    case 'marker-missing':
    case 'dir-unreadable':
      return t(`library.issue.${issue.code}`, { path })
    case 'reserved-keys':
      return t('library.issue.reserved-keys', { path, keys: (issue.keys ?? []).join(', ') })
    default:
      return t('library.issue.other', { path })
  }
}

/**
 * 本页删掉的记忆：deleting 是删除发出、结果还没回来，照原样画（宿主可能先推来没有它的视图），命令不在进行中时不算；
 * deleted 画结果行；restored 是撤销了、视图还没刷新回来，照原样画。index 是删时在这个范围列表里的位置。
 */
interface DoneRow { memory: MemoryCardData; index: number; state: 'deleting' | 'deleted' | 'restored' }

/**
 * 修改后的结果行（同一时刻一条）。done：应用或保存成功，via 决定文案，before 是打开面板时的那一份、draft 是写下的稿：
 * 视图还是 before 那一版（新版本还没推来）时按 draft 画。stale：这条已被别处改过，什么都没写，行内照视图画最新内容。
 */
type EditedRow =
  | { kind: 'done'; memoryId: string; via: 'model' | 'manual'; decisionId: string | undefined; before: MemoryCardData; draft: EditDraft }
  | { kind: 'stale'; memoryId: string }

const IDLE_EDIT: EditState = { phase: 'idle', isDirty: false }

/** 整理所选的应用和撤销全部共用的命令 key（不是记忆 id）。 */
const TIDY = 'tidy'

/**
 * 整理所选应用成功后的结果条。rewritten：改写项应用时工作区里的样子（命令核对的那一版）和写下的稿，视图还是那一版时按稿画；
 * deleted：删除项那一刻的样子，视图还是那一版时先不画（新视图还没推来）。isStale：撤销全部时有记忆之后又被改过，整批没动。
 * partial：只应用了一部分（退回时写盘出错、仍是这次写下的 kept，可撤销；退回前被别处接着改了的 unrecorded，不可撤销），
 * rewritten、deleted 只含 kept 里的。decisionId 缺省：没有可撤销的。
 */
interface TidyResult {
  decisionId: string | undefined
  total: number
  rewritten: ReadonlyMap<string, { before: MemoryCardData; draft: EditDraft }>
  deleted: readonly MemoryCardData[]
  isStale: boolean
  /** 已经整批撤销：撤回了几条。结果条换成一句「已撤销」，不再有按钮；改写、删除清空，列表照视图画。 */
  undone?: number
  partial?: { kept: readonly MemoryCardData[]; unrecorded: readonly MemoryCardData[] }
}

const draftOf = (memory: MemoryCardData): EditDraft => ({ content: memory.content, name: memory.name, summary: memory.summary, tags: memory.tags })
const isSameVersion = (a: MemoryCardData, b: MemoryCardData) => a.updatedAt === b.updatedAt && a.digest === b.digest

/** 一个组：单个范围按类型（先露 3 条），「全部」按时间段（不截断，「更早」默认收起）。 */
interface Group { key: string; title: string; items: MemoryCardData[]; isOpenByDefault: boolean; truncates: boolean; latest?: number }

export function LibraryTab({ nav, scope, session, fold, now = Date.now() }: {
  nav: NavStore
  scope: PageScope
  session: BorrowedSession
  /** 折叠状态：记忆页持有，这次打开期间保留；不给时用自己的一份。 */
  fold?: FoldMemory
  now?: number
}) {
  const t = useT()
  const gateway = useGateway()
  const view = gateway.useView(session, 'library')
  const [query, setQuery] = useState('')
  const [done, setDone] = useState<ReadonlyMap<string, DoneRow>>(new Map())
  const actions = useRowActions(session)
  /** 正在修改的那条：点「修改」那一刻的样子，之后视图刷新了也按它预填、按它的版本核对（同待处理卡）。 */
  const [editing, setEditing] = useState<MemoryCardData>()
  /** 面板报来的状态：换到别的行之前看有没有没保存的输入。 */
  const panel = useRef<EditState>(IDLE_EDIT)
  /** 有没保存的输入时点了别的行的「修改」：在那一行原位问。 */
  const [asking, setAsking] = useState<string>()
  const [edited, setEdited] = useState<EditedRow>()
  /** 这次打开期间改过的，标「刚改」。 */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  /** 刚改完、正在高亮的那几行（整理所选一次改写多条）。 */
  const [editFlash, setEditFlash] = useState<ReadonlySet<string>>(new Set())
  /** 多选开着没有、勾了哪几条（id）。 */
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  /** 点「选择」时单条面板有没保存的输入：在「选择」原位问。 */
  const [askingSelect, setAskingSelect] = useState(false)
  /** 整理工作区：点「整理所选…」那一刻的快照，之后视图刷新不改它。 */
  const [batch, setBatch] = useState<readonly BatchItem[]>()
  /** 从工作区回到列表：焦点回「整理所选…」。 */
  const selectionBar = useRef<HTMLDivElement>(null)
  const isBackFromBatch = useRef(false)
  const [tidied, setTidied] = useState<TidyResult>()
  /** 应用成功回到列表：焦点接到结果条上。 */
  const tidiedBar = useRef<HTMLDivElement>(null)
  const isTidiedNew = useRef(false)
  /** 多选操作条点「取消」：焦点回到搜索框旁的「选择」。 */
  const libBar = useRef<HTMLDivElement>(null)
  /** 不可选的勾选框念原因用的 id 前缀。 */
  const checkId = useId()
  /** 这一次渲染里展开着的组露出的行（id）。整理应用成功后只给这些行留高亮，收起的组里的行之后展开时不再突然高亮、滚过去。 */
  const drawnRows = useRef<ReadonlySet<string>>(new Set())
  const isTidyFlashNew = useRef(false)
  const kept = [...done.values()].filter(row => row.state !== 'deleting' || actions.isBusy(row.memory.id))
  const viewItems = view.status === 'ready' ? view.data.layers.filter(l => isInScope([l.layer], scope)).flatMap(l => l.items) : []
  // 本页删掉、视图里已经没有的那几条留在原位（等结果、结果行或撤销后等视图回来）；分组的排序是稳定的，插回原位就落回原来的组和位置
  const scopeItems = [...viewItems]
  for (const row of kept) {
    const at = scopeOfMemory(row.memory)
    if (at === undefined || !isInScope([at], scope) || scopeItems.some(m => m.id === row.memory.id)) continue
    scopeItems.splice(Math.min(row.index, scopeItems.length), 0, row.memory)
  }
  const isSearching = query.trim() !== ''
  // 整理删掉的、视图还没推来新版本的：先不画
  const tidyGone = (m: MemoryCardData) => tidied?.deleted.some(d => d.id === m.id && isSameVersion(m, d)) === true
  // 展开着面板的那一行不被搜索滤掉，免得面板连同写了一半的要求一起没了
  const items = scopeItems.filter(m => !tidyGone(m) && (matchesQuery(m, query) || m.id === editing?.id))
  const viewIds = viewItems.map(m => m.id).join('\n')
  // 撤销后视图里又有了：不用再替它占位
  useEffect(() => {
    const ids = new Set(viewIds.split('\n'))
    setDone((prev) => {
      const stale = [...prev.values()].filter(row => row.state === 'restored' && ids.has(row.memory.id))
      if (stale.length === 0) return prev
      const next = new Map(prev)
      for (const row of stale) next.delete(row.memory.id)
      return next
    })
  }, [viewIds])
  // 正在修改的那条在别处删掉了：面板随行消失，状态一起清掉
  const isEditingGone = editing !== undefined && view.status === 'ready' && !viewItems.some(m => m.id === editing.id)
  useEffect(() => {
    if (!isEditingGone) return
    panel.current = IDLE_EDIT
    setEditing(undefined)
  }, [isEditingGone])
  // 可勾选的：视图里在、能修改的（同「修改」的规则）。别处删掉或变得不能选的，从勾选里去掉，之后回来也不再勾上
  const isViewReady = view.status === 'ready'
  const selectableKey = viewItems.filter(isEditable).map(m => m.id).join('\n')
  useEffect(() => {
    if (!isViewReady) return
    const ids = new Set(selectableKey.split('\n'))
    setSelected((prev) => {
      const next = [...prev].filter(id => ids.has(id))
      return next.length === prev.size ? prev : new Set(next)
    })
  }, [selectableKey, isViewReady])
  useEffect(() => {
    if (batch !== undefined || !isBackFromBatch.current) return
    isBackFromBatch.current = false
    selectionBar.current?.querySelector<HTMLElement>('.pm-btn--primary')?.focus()
  }, [batch])
  useEffect(() => {
    if (tidied === undefined || !isTidiedNew.current) return
    isTidiedNew.current = false
    tidiedBar.current?.focus()
  }, [tidied])
  useEffect(() => {
    if (!isTidyFlashNew.current) return
    isTidyFlashNew.current = false
    setEditFlash((prev) => {
      const next = [...prev].filter(id => drawnRows.current.has(id))
      return next.length === prev.size ? prev : new Set(next)
    })
  }, [editFlash])
  const { flashId, revealId, targetId, clear } = useFlashTarget(nav, items.map(m => m.id))
  const typeLabel = useTypeLabel(session)
  const folds = useFold(fold, `library|${checkupKey(scope)}`, isSearching)
  /**
   * 应用全部：发 apply-edits；成功（含只应用了一部分）回到列表、退出多选，挂结果条，留下的改写标「刚改」、高亮一次。
   * stale、not-found：把对不上的那几条交回工作区（onBehind），由它回到写要求、等视图换成最新内容。
   */
  const applyTidy = (picked: readonly BatchItem[], application: BatchApplication, onBehind: (memoryIds: readonly string[]) => void) => {
    const { ops, keep, total } = application
    const command = { cmd: 'apply-edits', ops, ...(keep.length > 0 ? { keep } : {}) } as const
    actions.run(TIDY, command, null, (result) => {
      const memoryOf = (id: string) => picked.find(item => item.memory.id === id)!.memory
      // 只应用了一部分时只列仍是这次写下的
      const kept = new Set(result.memoryIds ?? ops.map(op => op.memoryId))
      const rewritten = new Map(ops.flatMap(op => (op.kind === 'edit' && kept.has(op.memoryId)
        ? [[op.memoryId, { before: memoryOf(op.memoryId), draft: { content: op.content, name: op.name, summary: op.summary, tags: op.tags } }] as const]
        : [])))
      setBatch(undefined)
      setSelecting(false)
      setSelected(new Set())
      setEdited(undefined)
      isTidiedNew.current = true
      setTidied({
        decisionId: result.decisionId, total, rewritten, isStale: false,
        deleted: ops.filter(op => op.kind === 'forget' && kept.has(op.memoryId)).map(op => memoryOf(op.memoryId)),
        ...(result.isPartial === true ? { partial: { kept: [...kept].map(memoryOf), unrecorded: (result.unrecordedIds ?? []).map(memoryOf) } } : {}),
      })
      setFresh(prev => new Set([...prev, ...rewritten.keys()]))
      // 回到列表画完后，没画出来的（收起的组里、收在「展开其余」里的）去掉高亮
      isTidyFlashNew.current = true
      setEditFlash(new Set(rewritten.keys()))
    }, (failure) => {
      const ids = failure.memoryIds
      if ((failure.code !== 'stale' && failure.code !== 'not-found') || ids === undefined || ids.length === 0) return false
      onBehind(ids)
      return true
    })
  }
  if (batch !== undefined) {
    return (
      <div className="pm-lib">
        <BatchEdit
          items={batch}
          latest={isViewReady ? viewItems : undefined}
          session={session}
          onBack={() => { isBackFromBatch.current = true; setBatch(undefined) }}
          onApply={(application, picked, onBehind) => { applyTidy(picked, application, onBehind) }}
          applyUnavailable={actions.unavailable(TIDY)}
          applyFeedback={actions.feedback(TIDY)}
        />
      </div>
    )
  }
  if (view.status !== 'ready') return <ViewMessage state={view} idle={null} />

  const data = view.data
  const total = data.layers.reduce((n, l) => n + l.items.length, 0)
  const dir = scopeDir(data, scope, viewItems[0]?.filePath)
  const notice = actions.notice
  const mark = (memory: MemoryCardData, state: DoneRow['state']) => {
    setDone((prev) => {
      const index = (state === 'deleting' ? undefined : prev.get(memory.id)?.index) ?? Math.max(0, viewItems.findIndex(m => m.id === memory.id))
      return new Map(prev).set(memory.id, { memory, index, state })
    })
  }
  const isAll = scope.kind === 'all'
  const groups: Group[] = isAll
    ? bucketize([...items].sort((a, b) => b.updatedAt - a.updatedAt), RECENT_BUCKETS, m => recentBucketOf(m.updatedAt, now))
      .map(({ key, items: rows }) => ({ key: `recent:${key}`, title: t(`library.recent.${key}`), items: rows, isOpenByDefault: key !== 'older', truncates: false }))
    : groupByType(items, data.typeOrder, typeLabel)
      .map(({ type, items: rows }) => ({ key: `type:${type}`, title: typeLabel(type), items: rows, isOpenByDefault: true, truncates: true, latest: rows[0]!.updatedAt }))
  // 高亮播完：目标所在的组记成展开（第 4 条以后的连展开其余），免得那一行在眼前缩回去
  const endFlash = () => {
    for (const group of groups) {
      const index = group.items.findIndex(m => m.id === flashId)
      if (index >= 0) folds.remember(group.key, { isOpen: true, ...(group.truncates && index >= GROUP_PREVIEW ? { isFull: true } : {}) })
    }
    clear()
  }

  const startEdit = (memory: MemoryCardData) => {
    panel.current = IDLE_EDIT
    setAsking(undefined)
    setEdited(undefined)
    setEditing(memory)
  }
  const modify = (memory: MemoryCardData) => {
    if (editing !== undefined && editing.id !== memory.id && panel.current.isDirty) { setAsking(memory.id); return }
    startEdit(memory)
  }
  const closeEdit = (id: string) => {
    setEditing((prev) => {
      if (prev?.id !== id) return prev
      panel.current = IDLE_EDIT
      return undefined
    })
  }
  const selectable = new Set(selectableKey.split('\n'))
  const picked = viewItems.filter(m => selected.has(m.id) && selectable.has(m.id))
  const pickedIds = new Set(picked.map(m => m.id))
  const startSelect = () => {
    panel.current = IDLE_EDIT
    setEditing(undefined)
    setAsking(undefined)
    setAskingSelect(false)
    setEdited(undefined)
    setSelected(new Set())
    setSelecting(true)
  }
  /** 进多选：展开着的单条面板有没保存的输入时先原位问（同换行）。 */
  const select = () => {
    if (editing !== undefined && panel.current.isDirty) { setAskingSelect(true); return }
    startSelect()
  }
  const endSelect = () => {
    setSelecting(false)
    setSelected(new Set())
  }
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  /** 应用（让模型改）或保存（手动改）：发 edit-memory，带打开面板时的版本；别处改过（stale）就关面板、换最新内容。 */
  const save = (before: MemoryCardData, draft: EditDraft, via: 'model' | 'manual') => {
    const command = { cmd: 'edit-memory', memoryId: before.id, layer: scopeOfMemory(before), base: baseOf(before), ...draft } as const
    actions.run(before.id, command, null, (result) => {
      closeEdit(before.id)
      setEdited({ kind: 'done', memoryId: before.id, via, decisionId: result.decisionId, before, draft })
      setFresh(prev => new Set(prev).add(before.id))
      setEditFlash(new Set([before.id]))
    }, (failure) => {
      if (failure.code !== 'stale') return false
      closeEdit(before.id)
      setEdited({ kind: 'stale', memoryId: before.id })
      return true
    })
  }
  const undoEdit = (memoryId: string, decisionId: string) => {
    actions.run(memoryId, { cmd: 'undo', decisionId }, null, () => {
      setEdited(undefined)
      setFresh((prev) => {
        const next = new Set(prev)
        next.delete(memoryId)
        return next
      })
    })
  }

  /** 撤销全部：整批一起恢复；有记忆之后又被改过（stale）整批没动，结果条写明，不再给撤销。 */
  const undoTidy = (result: TidyResult, decisionId: string) => {
    actions.run(TIDY, { cmd: 'undo', decisionId }, null, () => {
      // 撤回的可能有屏幕外的几条，按钮又随之消失：结果条原位说一句，焦点留在它上面
      isTidiedNew.current = true
      setTidied({ ...result, rewritten: new Map(), deleted: [], undone: result.rewritten.size + result.deleted.length })
      setFresh((prev) => {
        const next = new Set(prev)
        for (const id of result.rewritten.keys()) next.delete(id)
        return next
      })
    }, (failure) => {
      if (failure.code !== 'stale') return false
      setTidied({ ...result, isStale: true })
      return true
    })
  }
  /**
   * 整理所选的结果条：列表顶部，「已整理 N 条……」，有删除时副行说去哪找回，右侧「撤销全部」。
   * 只应用了一部分：「只应用了其中 k 条，其余没有改动」，副行点名没退回的几条和原因；没有可撤销的就不给「撤销全部」。
   */
  const tidiedBarOf = (result: TidyResult) => {
    const deletes = result.deleted.length
    const rewrites = result.rewritten.size
    const { partial, decisionId } = result
    const names = (memories: readonly MemoryCardData[]) => memories.map(m => m.name).join(t('library.batch.nameSep'))
    if (result.undone !== undefined) {
      return (
        <div ref={tidiedBar} className="pm-lib-result pm-lib-tidied" tabIndex={-1}>
          <p role="status" className="pm-lib-tidied-title">{t('library.batch.undone', { n: result.undone })}</p>
        </div>
      )
    }
    const subs = result.isStale ? [t('library.batch.undoStale')] : [
      ...(partial !== undefined && partial.kept.length > 0 ? [t('library.batch.partialKept', { names: names(partial.kept) })] : []),
      ...(partial !== undefined && partial.unrecorded.length > 0 ? [t('library.batch.partialChanged', { names: names(partial.unrecorded) })] : []),
      ...(deletes > 0 ? [t('library.batch.doneDeleted')] : []),
    ]
    return (
      <div ref={tidiedBar} className="pm-lib-result pm-lib-tidied" tabIndex={-1}>
        <div role="status">
          <p className="pm-lib-tidied-title">
            {partial !== undefined
              ? t('library.batch.partial', { n: partial.kept.length + partial.unrecorded.length })
              : t('library.batch.done', { n: result.total, deletes, rewrites, kept: result.total - deletes - rewrites })}
          </p>
          {subs.map(sub => <p key={sub} className="pm-lib-result-text">{sub}</p>)}
        </div>
        {result.isStale || decisionId === undefined
          ? null
          : <Button variant="ghost" unavailable={actions.unavailable(TIDY)} onClick={() => { undoTidy(result, decisionId) }}>{t('library.batch.undoAll')}</Button>}
      </div>
    )
  }

  /** 修改面板：两段切换，两侧都按打开时的那一份预填、按它的版本核对。 */
  const editPanel = (memory: MemoryCardData) => (
    <EditModes
      onClose={() => { closeEdit(memory.id) }}
      onStateChange={(state) => { panel.current = state }}
      model={report => (
        <ModelEditPanel
          memories={[memory]}
          base={draftOf(memory)}
          session={session}
          unavailable={actions.unavailable(memory.id)}
          onClose={() => { closeEdit(memory.id) }}
          onApply={(draft) => { save(memory, draft, 'model') }}
          onStateChange={report}
        />
      )}
      manual={report => (
        <EditPanel
          initial={draftOf(memory)}
          original={{ content: memory.content, summary: memory.summary, chars: memory.content.length }}
          isMerge={false}
          unavailable={actions.unavailable(memory.id)}
          onCancel={() => { closeEdit(memory.id) }}
          onSave={(draft) => { save(memory, draft, 'manual') }}
          onStateChange={report}
        />
      )}
    />
  )

  const editedRow = (row: EditedRow) => {
    const undoId = row.kind === 'done' ? row.decisionId : undefined
    return (
      <div className="pm-lib-result">
        <p className="pm-lib-result-text">
          {t(row.kind === 'stale' ? 'library.edit.stale' : row.via === 'model' ? 'library.edit.modelDone' : 'library.edit.manualDone')}
        </p>
        {undoId !== undefined
          ? <Button variant="ghost" unavailable={actions.unavailable(row.memoryId)} onClick={() => { undoEdit(row.memoryId, undoId) }}>{t('library.undo')}</Button>
          : null}
      </div>
    )
  }

  /** 「全部」里卡片上的范围名：点了落到那个范围的记忆查看，这一条所在的组展开，滚到中间、高亮、接住焦点。 */
  const scopeLink = (memory: MemoryCardData) => {
    const own = scopeOfMemory(memory)
    if (own === undefined) return undefined
    const name = scopeLabel(own, t)
    return (
      <button
        type="button"
        className="pm-mc-item pm-lib-scope"
        aria-label={t('library.goScope', { scope: name })}
        onClick={() => { nav.update({ scope: own, memoryId: memory.id }) }}
      >
        <Icon name={own.kind === 'global' ? 'globe' : 'folder'} size={13} />
        {name}
        <span aria-hidden="true">›</span>
      </button>
    )
  }

  /**
   * 多选时行首的勾选框：含密钥、没有版本的置灰，悬停写明原因。不用原生 disabled（同 Button 的 unavailable）：
   * 读屏能念到原因（aria-describedby），点击被吞掉。
   */
  const checkbox = (memory: MemoryCardData, isPicked: boolean) => {
    const reason = memory.hasSecret === true ? t('library.select.secret') : memory.digest === undefined ? t('library.select.noVersion') : undefined
    const blocked = reason !== undefined
    const reasonId = `${checkId}-${memory.id}`
    return (
      <label className="pm-lib-check" title={reason}>
        <input
          type="checkbox"
          aria-label={t('library.select.row', { name: memory.name })}
          aria-disabled={blocked || undefined}
          aria-describedby={blocked ? reasonId : undefined}
          checked={isPicked}
          onChange={() => { if (!blocked) toggle(memory.id) }}
        />
        {blocked ? <span id={reasonId} className="pm-sr-only">{reason}</span> : null}
      </label>
    )
  }

  /** 多选的操作条：浮在列表底部。2 条起、不超过上限才能整理。 */
  const selectBar = () => {
    const n = picked.length
    const isOver = n > MAX_BATCH_EDIT
    const blocked = n < 2 ? t('library.select.tooFew') : isOver ? t('library.select.tooMany', { n, max: MAX_BATCH_EDIT }) : undefined
    return (
      <div ref={selectionBar} className="pm-lib-selbar" role="group" aria-label={t('library.select.bar')}>
        <p className="pm-lib-selbar-count" role="status">{isOver ? t('library.select.tooMany', { n, max: MAX_BATCH_EDIT }) : t('library.select.count', { n })}</p>
        <Button onClick={() => { setSelected(prev => new Set([...prev, ...items.filter(m => selectable.has(m.id)).map(m => m.id)])) }}>{t('library.select.all')}</Button>
        <Button
          variant="ghost"
          onClick={() => {
            // 操作条随之收起：焦点回到「选择」（多选期间它就是「完成」，同一个按钮）
            endSelect()
            libBar.current?.querySelector<HTMLElement>('.pm-btn[aria-pressed]')?.focus()
          }}
        >
          {t('library.select.cancel')}
        </Button>
        <Button
          variant="primary"
          unavailable={blocked}
          onClick={() => {
            // 开始下一次整理：上一次的结果条和应用留下的提示收起
            setTidied(undefined)
            actions.dismiss(TIDY)
            setBatch(toBatchItems(picked))
          }}
        >
          {t('library.select.tidy')}
        </Button>
      </div>
    )
  }

  const row = (memory: MemoryCardData) => {
    const own = scopeOfMemory(memory)
    if (done.get(memory.id)?.state === 'deleted') {
      return (
        <li key={memory.id} className={selecting ? 'pm-list-row pm-lib-row--selecting' : 'pm-list-row'}>
          {selecting
            ? <span className="pm-lib-check pm-lib-check--blank" aria-hidden="true"><input type="checkbox" tabIndex={-1} disabled /></span>
            : null}
          <div className="pm-row-body">
            <div className="pm-lib-gone">
              <MemoryCard
                memory={memory}
                now={now}
                typeLabel={typeLabel(memory.type)}
                hideType={!isAll}
                hideScope={!isAll}
                projectName={memory.workspacePath === undefined ? undefined : baseName(memory.workspacePath)}
              />
            </div>
            <div className="pm-lib-result">
              <p className="pm-lib-result-text">{t('library.deletedResult')}</p>
              <Button
                variant="ghost"
                unavailable={actions.unavailable(memory.id)}
                onClick={() => { actions.run(memory.id, { cmd: 'restore', memoryId: memory.id, layer: own }, null, () => { mark(memory, 'restored') }) }}
              >
                {t('library.undo')}
              </Button>
            </div>
            {actions.feedback(memory.id)}
          </div>
        </li>
      )
    }
    const isEditing = editing?.id === memory.id
    const result = edited?.memoryId === memory.id ? edited : undefined
    const tidyRewrite = tidied?.rewritten.get(memory.id)
    // 刚应用、视图还没推来新版本：先按写下的稿子画
    const shown = result?.kind === 'done' && isSameVersion(memory, result.before) ? { ...memory, ...result.draft }
      : tidyRewrite !== undefined && isSameVersion(memory, tidyRewrite.before) ? { ...memory, ...tidyRewrite.draft } : memory
    const badge = fresh.has(memory.id) ? <Chip variant="neutral">{t('library.edit.justEdited')}</Chip> : undefined
    const endRowFlash = () => {
      if (editFlash.has(memory.id)) {
        setEditFlash((prev) => {
          const next = new Set(prev)
          next.delete(memory.id)
          return next
        })
      }
      if (flashId === memory.id) endFlash()
    }
    const isPicked = selecting && pickedIds.has(memory.id)
    const className = ['pm-list-row', selecting ? 'pm-lib-row--selecting' : '', isPicked ? 'pm-lib-row--selected' : ''].filter(Boolean).join(' ')
    return (
      <FlashRow key={memory.id} className={className} flashing={flashId === memory.id || editFlash.has(memory.id)} onFlashEnd={endRowFlash} takesFocus={memory.id === targetId}>
        {selecting ? checkbox(memory, isPicked) : null}
        <div className="pm-row-body">
          {isAll
            ? <MemoryCard memory={shown} now={now} typeLabel={typeLabel(memory.type)} scopeSlot={scopeLink(memory)} badge={badge} />
            : <MemoryCard memory={shown} now={now} hideType hideScope badge={badge} />}
          {isEditing ? editPanel(editing) : null}
          {result !== undefined ? editedRow(result) : null}
          {actions.feedback(memory.id)}
        </div>
        {isEditing || selecting
          ? null
          : (
            <div className="pm-row-actions">
              {!isEditable(memory) ? null : asking === memory.id
                ? (
                  <SoftDeleteConfirm
                    question={t('library.edit.discard')}
                    confirmLabel={t('library.edit.discardConfirm')}
                    onCancel={() => { setAsking(undefined) }}
                    onConfirm={() => { startEdit(memory) }}
                  />
                )
                : <Button unavailable={actions.unavailable(memory.id)} onClick={() => { modify(memory) }}>{t('pending.modify')}</Button>}
              <DeleteWithConfirm
                onDelete={() => {
                  // 删的是正在高亮的那一条：当作播完，所在的组记成展开，结果行和「撤销」不缩回「展开其余」里
                  if (memory.id === flashId) endFlash()
                  mark(memory, 'deleting')
                  actions.run(memory.id, { cmd: 'forget', memoryId: memory.id, layer: own }, null, () => { mark(memory, 'deleted') })
                }}
                trigger={open => <Button variant="ghost" unavailable={actions.unavailable(memory.id)} onClick={open}>{t('library.delete')}</Button>}
              />
              <Button variant="icon" aria-label={t('library.openFile')} title={t('library.openFile')} onClick={() => { void actions.open(memory.filePath) }}>
                <Icon name="openFile" size={14} />
              </Button>
            </div>
          )}
      </FlashRow>
    )
  }

  // 下面画组时记下露出的行，提交后整理的高亮据此去掉没画出来的
  const drawn = new Set<string>()
  drawnRows.current = drawn
  const group = ({ key, title, items: rows, isOpenByDefault, truncates, latest }: Group) => {
    const reveal = rows.findIndex(m => m.id === revealId)
    const isOpen = reveal >= 0 || folds.isOpen(key, isOpenByDefault)
    const isFull = !truncates || reveal >= GROUP_PREVIEW || folds.isFull(key)
    const shown = isFull ? rows : rows.slice(0, GROUP_PREVIEW)
    if (isOpen) for (const m of shown) drawn.add(m.id)
    // 直达高亮期间收起这个组：高亮一起结束，不再把组撑着
    const settle = () => { if (reveal >= 0) clear() }
    return (
      <MemoryGroup
        key={key}
        title={title}
        count={rows.length}
        latest={latest}
        now={now}
        isOpen={isOpen}
        onToggle={() => { settle(); folds.toggle(key, isOpen) }}
        hidden={rows.length - shown.length}
        onMore={() => { folds.remember(key, { isFull: true }) }}
        onLess={truncates && isFull && !isSearching && rows.length > GROUP_PREVIEW ? () => { settle(); folds.remember(key, { isFull: false }) } : undefined}
      >
        {shown.map(row)}
      </MemoryGroup>
    )
  }

  return (
    <div className="pm-lib">
      <div ref={libBar} className="pm-lib-bar">
        <SearchBox label={t('library.search.label')} placeholder={t('library.search.placeholder')} value={query} onChange={setQuery} />
        {isAll
          ? null
          : askingSelect
            ? (
              <SoftDeleteConfirm
                question={t('library.edit.discard')}
                confirmLabel={t('library.edit.discardConfirm')}
                onCancel={() => { setAskingSelect(false) }}
                onConfirm={startSelect}
              />
            )
            : <Button aria-pressed={selecting} onClick={selecting ? endSelect : select}>{t(selecting ? 'library.select.done' : 'library.select')}</Button>}
      </div>
      {viewItems.length > 0 && dir !== undefined
        ? (
          <p className="pm-lib-storage">
            <span>{t('library.storage.oneFile')}</span>
            <i className="pm-sep" aria-hidden="true">·</i>
            <span className="pm-lib-path" title={dir}>{dir}</span>
            <button type="button" className="pm-link" onClick={() => { void actions.open(dir) }}>{t('library.storage.openDir')}</button>
          </p>
        )
        : null}
      {data.directoryIssues.length > 0
        ? (
          <ul className="pm-lib-issues" aria-label={t('library.issues.label')}>
            {data.directoryIssues.map((issue, i) => <li key={i}>{issueText(issue, data.memoryRoot, t)}</li>)}
          </ul>
        )
        : null}
      {tidied !== undefined ? tidiedBarOf(tidied) : null}
      {tidied !== undefined ? actions.feedback(TIDY) : null}
      {notice !== undefined ? <p className="pm-notice" role="status" tabIndex={-1}>{notice.text}</p> : null}
      {actions.strayFailures([...items.map(m => m.id), TIDY])}
      {items.length === 0
        ? (total === 0 && kept.length === 0
            ? <EmptyState variant="first" title={t('library.empty.first.title')}>{t('library.empty.first.body')}</EmptyState>
            : viewItems.length > 0 || kept.length > 0
              ? <EmptyState variant="daily" title={t('library.search.none')} />
              : <EmptyState variant="daily" title={t('library.empty.scope')} />)
        : (
          <>
            {isAll && !isSearching && groups.every(g => g.key === 'recent:older') ? <p className="pm-lib-quiet">{t('library.recent.quiet')}</p> : null}
            <div className="pm-memgroups">{groups.map(group)}</div>
          </>
        )}
      {selecting ? selectBar() : null}
    </div>
  )
}

export const libraryTabCss = `
.pm-lib { display: flex; flex-direction: column; gap: 12px; }
.pm-lib-storage { display: flex; align-items: center; min-width: 0; margin: 0; padding: 0 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-lib-storage > span:first-child { flex-shrink: 0; white-space: nowrap; }
.pm-lib-storage .pm-link { margin-left: 8px; flex-shrink: 0; font-size: 12px; }
.pm-lib-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; }
.pm-lib-issues { margin: 0; padding: 0 16px; list-style: none; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); overflow-wrap: anywhere; }
.pm-lib > .pm-notice { padding: 0 16px; }
.pm-lib-quiet { margin: 0; padding: 0 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-lib-scope { padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
.pm-lib-scope:hover { color: var(--pm-text); text-decoration: underline; text-underline-offset: 3px; }
.pm-lib-gone { opacity: .55; }
.pm-lib-result { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-lib-result-text { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-lib-tidied { padding: 8px 8px 8px 16px; border: .5px solid var(--pm-line-card); border-radius: 10px; }
.pm-lib-tidied:focus { outline: none; }
.pm-lib-tidied:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 0; }
.pm-lib-tidied-title { margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-lib-bar { display: flex; align-items: center; gap: 8px; }
.pm-lib-bar > .pm-search { flex: 1; min-width: 0; }
.pm-lib-check { display: flex; align-items: center; flex-shrink: 0; height: 22px; cursor: pointer; }
.pm-lib-check input { margin: 0; accent-color: var(--pm-text); cursor: inherit; }
.pm-lib-check:has(input[aria-disabled='true']) { cursor: default; }
.pm-lib-check input[aria-disabled='true'] { opacity: .4; }
/* 刚删掉的结果行：只占勾选框那一列的位置，和别的行对齐 */
.pm-lib-check--blank { visibility: hidden; }
.pm-lib-row--selected { background: var(--pm-accent-tint); }
/* 窄宽度下行改成上下排；多选时行尾按钮收起了，勾选框仍留在卡片左边 */
@container (max-width: 500px) {
  .pm-list-row.pm-lib-row--selecting { flex-direction: row; }
}
/* 主区底部留白 48px：操作条浮在离底 16px 处。滚到底时主区的底部留白不一定算进滚动范围（内容溢出视图面板时），
   条自己带 16px 下边距，停在原位时也离底 16px，不会被顶上去压住最后一行 */
.pm-lib-selbar {
  position: sticky; bottom: -32px; z-index: 1; margin-bottom: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 8px 8px 16px; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-lg, 16px);
  background: var(--pm-bg-raised); box-shadow: var(--dsw-elevation-panel);
}
.pm-lib-selbar-count { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
`

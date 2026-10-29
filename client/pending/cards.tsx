/**
 * 待处理的各类卡（PRD 5.2；建议整理见 spec「建议整理的动作」）与处理后留在原位的结果卡。每张卡动手前写清后果；动作经 useItemAction 发命令，
 * 成功后把结果（Outcome）交给列表，由列表在原位换成结果卡。
 */
import { createContext, useContext, useState, type ReactNode } from 'react'
import {
  CONFLICT_ACTION_VERDICTS, MODEL_EDIT_ADVICE_TYPES, layerOfMemory, mergeKeeperIndex,
  type AdviceType, type GuiLayerRef, type IgnorableAdviceType, type MemoryCard as MemoryCardData, type MemoryCommand, type ModelEditAdviceType, type PendingItem,
} from '../../src/gui/contract.ts'
import { belongsTo, useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, formatDay, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { AdviceNote, ResultLine } from '../ui/Advice.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { ConflictRuling, VerticalConflictRuling } from '../ui/ConflictRuling.tsx'
import { DismissButton } from '../ui/DismissButton.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { ActionFeedback, DeleteWithConfirm, SecretDeleteConfirm, useItemAction, type EditCommand, type ItemAction } from './action.tsx'
import { EditPanel, type EditDraft } from './edit.tsx'
import { ModelEditPanel } from './model-edit.tsx'
import { MovePanel } from './move.tsx'

type Item<K extends PendingItem['kind']> = Extract<PendingItem, { kind: K }>
type Verdict = 'keep-left' | 'keep-right' | 'keep-both'

/** 一次动作的结果，结果卡按它写文案、决定能不能撤销。 */
export type Outcome =
  /** isUnrecorded：两边都留但结论没记下（见命令结果 isUnrecorded），没有可撤销的条目。 */
  | { kind: 'resolved'; verdict: Verdict; isUnrecorded?: true }
  /** decisionId：撤销用的账本条目（按记忆 id 提升时由命令结果带回；提升候选用条目自己的）。 */
  | { kind: 'promoted'; target: 'global' | 'agents-md'; decisionId?: string }
  /** 全局记忆移到了 workspacePath 那个项目；decisionId 是撤销用的账本条目，filePath 是移过去之后的文件。 */
  | { kind: 'moved'; workspacePath: string; decisionId?: string; filePath?: string }
  | { kind: 'kept-local' }
  | { kind: 'hard-deleted' }
  | { kind: 'dismissed' }
  | { kind: 'raised'; budget: number }
  | { kind: 'confirmed' }
  /** 软删进了最近删除：撤销发 restore，带删的那一份。 */
  | { kind: 'deleted'; memoryId: string; layer: GuiLayerRef | undefined }
  /** 建议整理的忽略：撤销发 unignore-advice，带同样的类型和记忆 id。 */
  | { kind: 'ignored'; type: IgnorableAdviceType; memoryIds: string[] }
  /** 直接改、直接合并：结果行写名称和字数变化；filePath 是写完后的文件（改了名称文件名会跟着变）。 */
  | { kind: 'edited' | 'merged'; decisionId?: string; name: string; fromChars: number; toChars: number; filePath?: string }

export interface CardProps<K extends PendingItem['kind']> {
  item: Item<K>
  session: BorrowedSession
  now: number
  typeLabels: Readonly<Record<string, string>>
  onDone: (outcome: Outcome) => void
  /** 这一条正在别处处理或刚处理完，什么都没动（见 isHandledElsewhere）：由列表在卡片外提示。 */
  onRefused: () => void
}

/** 记忆在别的项目里（相对借来的会话所在项目）时返回项目路径。 */
function otherProject(memory: MemoryCardData | null, session: BorrowedSession): string | undefined {
  if (memory?.workspacePath === undefined) return undefined
  return session.kind === 'ready' && belongsTo(session.cwd, memory.workspacePath, session.workspaces ?? {}) ? undefined : memory.workspacePath
}

/** 记忆卡上的作用域：在别的项目里写项目名，在本项目里照常写「本项目」。 */
function projectNameOf(session: BorrowedSession): (memory: MemoryCardData) => string | undefined {
  return (memory) => {
    const other = otherProject(memory, session)
    return other === undefined ? undefined : baseName(other)
  }
}

/** 记忆文件全文 → 正文（去掉 frontmatter）。 */
export function bodyOf(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m === null ? text : text.slice(m[0].length)).trim()
}

const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/** 「全部」里每张卡标题后的范围名胶囊（条目属于哪些范围）；选了具体范围时为空，不画。由列表按行给出。 */
export const ItemScopeNames = createContext<readonly string[]>([])

/** 这张卡是最近一次体检新增、这一趟还算「新」的：标题后先跟「新」胶囊。由列表按行给出。 */
export const ItemIsNew = createContext(false)

/** 记忆页处理视图里条目标题后的胶囊：「新」（ItemIsNew）在前，「全部」里的范围名（ItemScopeNames）在后。 */
function ScopeChips() {
  const t = useT()
  const scopes = useContext(ItemScopeNames)
  const isNew = useContext(ItemIsNew)
  return (
    <>
      {isNew ? <span className="pm-pending-scope"><Chip variant="neutral">{t('pending.new')}</Chip></span> : null}
      {scopes.map((name, i) => <span key={i} className="pm-pending-scope"><Chip variant="neutral">{name}</Chip></span>)}
    </>
  )
}

/** focusable：结果卡可以接住焦点（tabIndex=-1），确认收起后原来的按钮没了就落在它上面。 */
function Card({ marker, title, aside, focusable = false, isResult = false, children }: {
  marker?: ReactNode
  title: ReactNode
  aside?: ReactNode
  focusable?: boolean
  isResult?: boolean
  children: ReactNode
}) {
  const className = ['pm-pending-item', marker !== undefined && 'pm-pending-item--marked', isResult && 'pm-pending-item--result'].filter(Boolean).join(' ')
  return (
    <article className={className} tabIndex={focusable ? -1 : undefined}>
      <header className="pm-pending-head">
        {marker !== undefined ? <span className="pm-pending-mark">{marker}</span> : null}
        <h3 className="pm-pending-title">{title}</h3>
        <ScopeChips />
        {aside !== undefined ? <div className="pm-pending-aside">{aside}</div> : null}
      </header>
      <div className="pm-pending-body">{children}</div>
    </article>
  )
}

function MemoryOf({ memory, session, now, typeLabels }: {
  memory: MemoryCardData
  session: BorrowedSession
  now: number
  typeLabels: Readonly<Record<string, string>>
}) {
  return <MemoryCard memory={memory} now={now} typeLabel={typeLabels[memory.type]} projectName={projectNameOf(session)(memory)} />
}

export function titleOf(item: PendingItem, t: Translate): string {
  switch (item.kind) {
    case 'secret': return t('pending.secret.title')
    case 'conflict-horizontal': return item.summary || t('conflict.title')
    case 'conflict-vertical': return item.summary || t('conflict.title')
    case 'promote-candidate': return t('pending.promote.title')
    case 'overflow': return t('pending.overflow.title')
    case 'unreadable-file': return t('pending.unreadable.title')
    case 'advice': return t(ADVICE_COPY[item.type].title)
  }
}

// —— 密钥 ——

export function SecretCard({ item, session, now, typeLabels, onDone }: CardProps<'secret'>) {
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, () => { onDone({ kind: 'hard-deleted' }) })
  /** 本机临时展开的原文：只在这个组件的内存里，收起或离开页面就没了。 */
  const [revealed, setRevealed] = useState<string | null | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const { memory } = item
  const show = () => {
    if (session.kind !== 'ready') return
    void gateway.readFile(session.sessionId, memory.filePath).then((text) => { setRevealed(text === undefined ? null : bodyOf(text)) })
  }
  const open = () => { void gateway.openPath(memory.filePath, 'open').then((ok) => { if (!ok) action.fail(t('pending.openFailed')) }) }
  return (
    <Card marker={<StatusMarker kind="secret" label={t('marker.secret')} />} title={t('pending.secret.title')}>
      <MemoryOf session={session} memory={typeof revealed === 'string' ? { ...memory, content: revealed } : memory} now={now} typeLabels={typeLabels} />
      {revealed === null ? <p className="pm-pending-text">{t('pending.secret.readFailed')}</p> : null}
      <AdviceNote>{t('pending.secret.body')}</AdviceNote>
      {confirming
        ? (
          <SecretDeleteConfirm
            showTitle={false}
            unavailable={action.unavailable}
            onCancel={() => { setConfirming(false) }}
            onConfirm={() => { action.run({ cmd: 'hard-delete', memoryId: memory.id, layer: layerOfMemory(memory) }) }}
          />
        )
        : (
          <div className="pm-pending-actions">
            {typeof revealed === 'string'
              ? <Button onClick={() => { setRevealed(undefined) }}>{t('pending.secret.hide')}</Button>
              : <Button unavailable={action.unavailable} onClick={show}>{t('pending.secret.show')}</Button>}
            <Button onClick={open}>{t('pending.secret.rewrite')}</Button>
            <Button variant="danger" unavailable={action.unavailable} onClick={() => { setConfirming(true) }}>{t('pending.secret.delete')}</Button>
          </div>
        )}
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 冲突 ——

export function HorizontalCard({ item, session, now, typeLabels, onDone, onRefused }: CardProps<'conflict-horizontal'>) {
  const t = useT()
  const action = useItemAction(session, (command, result) => {
    if (command.cmd === 'resolve') onDone({ kind: 'resolved', verdict: command.verdict, ...(result.isUnrecorded ? { isUnrecorded: true } : {}) })
  }, onRefused)
  const preferred = item.preferredId === undefined ? undefined
    : item.left?.id === item.preferredId ? { side: 'A', memory: item.left }
      : item.right?.id === item.preferredId ? { side: 'B', memory: item.right } : undefined
  const note = preferred === undefined ? undefined
    : t(preferred.memory.sourceMode === 'user-explicit' ? 'pending.conflict.preferredExplicit' : 'pending.conflict.preferred', { side: preferred.side })
  return (
    <div className="pm-pending-item">
      <ConflictRuling
        layout="wide"
        left={item.left}
        right={item.right}
        now={now}
        title={titleOf(item, t)}
        note={note}
        unavailable={action.unavailable}
        typeLabel={type => typeLabels[type] ?? type}
        projectName={projectNameOf(session)}
        headExtra={<ScopeChips />}
        onRule={(verdict) => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict }) }}
      />
      <ActionFeedback action={action} />
    </div>
  )
}

export function VerticalCard({ item, session, now, typeLabels, onDone, onRefused }: CardProps<'conflict-vertical'>) {
  const t = useT()
  const action = useItemAction(session, (command, result) => {
    if (command.cmd === 'resolve') onDone({ kind: 'resolved', verdict: command.verdict, ...(result.isUnrecorded ? { isUnrecorded: true } : {}) })
  }, onRefused)
  return (
    <div className="pm-pending-item">
      <VerticalConflictRuling
        layout="wide"
        memory={item.memory}
        baselineRef={item.baselineRef}
        now={now}
        title={titleOf(item, t)}
        unavailable={action.unavailable}
        typeLabel={type => typeLabels[type] ?? type}
        projectName={projectNameOf(session)}
        headExtra={<ScopeChips />}
        onRule={(verdict) => { action.run({ cmd: 'resolve', decisionId: item.decisionId, verdict }) }}
      />
      <ActionFeedback action={action} />
    </div>
  )
}

// —— 提升候选 ——

export function PromoteCard({ item, session, now, typeLabels, onDone, onRefused, promoteTarget }: CardProps<'promote-candidate'> & {
  /** 来自配置 governance.globalPromoteTarget；还没读到为 undefined。 */
  promoteTarget: 'global' | 'agents-md' | undefined
}) {
  const t = useT()
  const action = useItemAction(session, (command) => {
    if (command.cmd === 'promote') onDone({ kind: 'promoted', target: command.target })
    if (command.cmd === 'keep-local') onDone({ kind: 'kept-local' })
  }, onRefused)
  const other = otherProject(item.memory, session)
  const unavailable = action.unavailable ?? (item.memory === null ? t('conflict.missingHint') : undefined)
  const promoteLabel = promoteTarget === 'agents-md' ? t('pending.promote.agentsMd')
    : other !== undefined ? t('pending.promote.globalIn', { name: baseName(other) }) : t('pending.promote.global')
  return (
    <Card
      marker={<StatusMarker kind="pending" />}
      title={other !== undefined ? t('pending.promote.titleIn', { name: baseName(other) }) : t('pending.promote.title')}
    >
      {item.memory === null
        ? <p className="pm-pending-text">{t('conflict.missing')}</p>
        : <MemoryOf session={session} memory={item.memory} now={now} typeLabels={typeLabels} />}
      {promoteTarget !== undefined
        ? <AdviceNote>{t(promoteTarget === 'agents-md' ? 'pending.promote.agentsMdNote' : 'pending.promote.globalNote')}</AdviceNote>
        : null}
      <div className="pm-pending-actions">
        <Button unavailable={unavailable} onClick={() => { action.run({ cmd: 'keep-local', decisionId: item.decisionId }) }}>
          {t('pending.promote.keepLocal')}
        </Button>
        <Button
          unavailable={unavailable ?? (promoteTarget === undefined ? t('pending.promote.configLoading') : undefined)}
          onClick={() => { if (promoteTarget !== undefined) action.run({ cmd: 'promote', decisionId: item.decisionId, target: promoteTarget }) }}
        >
          {promoteLabel}
        </Button>
      </div>
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 超出上限 ——

/** 第 tier 档放宽到的上限：budget × (1 + 0.25 × tier)。 */
const capOf = (budget: number, tier: number) => Math.round(budget * (1 + 0.25 * tier))

export function OverflowCard({ item, session, onDone, onRefused, budget, onCleanup }: CardProps<'overflow'> & {
  budget: number | undefined
  /** 「整理记忆 ›」：去全部记忆，作用域是这张卡那一层。 */
  onCleanup: (scope: GuiLayerRef) => void
}) {
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, () => { onDone({ kind: 'dismissed' }) }, onRefused)
  // 建议值：下一档的起点向上取整到百，填了就不会在这一档再提醒
  const suggested = budget === undefined ? '' : String(Math.ceil(capOf(budget, item.tier + 1) / 100) * 100)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const value = draft ?? suggested
  const parsed = Number(value)
  const invalid = budget === undefined || !/^\d+$/.test(value.trim()) || parsed <= budget
  const [saving, setSaving] = useState(false)
  const save = () => {
    if (invalid) return
    setSaving(true)
    void gateway.setConfig('snapshotTokenBudget', parsed).then((ok) => {
      setSaving(false)
      if (ok) onDone({ kind: 'raised', budget: parsed })
      else action.fail(t('pending.overflow.saveFailed'))
    })
  }
  const over = 25 * item.tier
  const summary = item.mode === 'relax'
    ? budget === undefined ? t('pending.overflow.relaxNoBudget', { over })
      : t('pending.overflow.relax', { over, cap: formatNumber(capOf(budget, item.tier)), budget: formatNumber(budget) })
    : budget === undefined ? t('pending.overflow.strictNoBudget') : t('pending.overflow.strict', { budget: formatNumber(budget) })
  return (
    <Card
      marker={<StatusMarker kind="pending" />}
      title={t('pending.overflow.title')}
      aside={<DismissButton label={t('pending.dismiss')} unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'dismiss-overflow', decisionId: item.decisionId }) }} />}
    >
      <p className="pm-pending-text">{summary}</p>
      <div className="pm-pending-option">
        <label className="pm-pending-option-label">
          {t('pending.overflow.raise')}
          <input
            className="pm-pending-input"
            inputMode="numeric"
            value={value}
            aria-invalid={budget !== undefined && invalid}
            onChange={(event) => { setDraft(event.target.value) }}
          />
        </label>
        <Button unavailable={saving ? t('pending.busy') : invalid ? t('pending.overflow.invalid', { budget: budget === undefined ? '' : formatNumber(budget) }) : undefined} onClick={save}>
          {t('pending.overflow.save')}
        </Button>
      </div>
      <p className="pm-pending-hint">
        {budget !== undefined && invalid && value.trim() !== '' ? t('pending.overflow.invalid', { budget: formatNumber(budget) }) : t('pending.overflow.raiseHint')}
        <button
          type="button"
          className="pm-link"
          onClick={() => { onCleanup(item.workspacePath !== undefined ? { kind: 'workspace', workspacePath: item.workspacePath } : { kind: 'global' }) }}
        >
          {t('pending.overflow.cleanup')}
        </button>
      </p>
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 读不出的文件 ——

export function UnreadableCard({ item, session }: CardProps<'unreadable-file'>) {
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, () => {})
  const open = (how: 'open' | 'reveal') => {
    void gateway.openPath(item.filePath, how).then((ok) => { if (!ok) action.fail(t('pending.openFailed')) })
  }
  return (
    <Card marker={<StatusMarker kind="pending" />} title={t('pending.unreadable.title')}>
      <p className="pm-pending-path">{item.relativePath}</p>
      <pre className="pm-pending-error-text">{item.error}</pre>
      <div className="pm-pending-actions">
        <Button onClick={() => { open('reveal') }}>{t(isMac() ? 'pending.unreadable.revealMac' : 'pending.unreadable.revealOther')}</Button>
        <Button onClick={() => { open('open') }}>{t('pending.unreadable.open')}</Button>
      </div>
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 建议整理 ——

type AdviceAction = 'confirm' | 'delete' | 'promote' | 'move' | 'open' | 'edit' | 'model'

/**
 * 每类建议的标题、动手前的说明和动作行（按 spec 表）。按钮顺序即显示顺序：退一步的幽灵按钮「打开文件」排在最左，
 * 推荐的排在最右。「不再提醒」不在动作行，是标题行右上角的叉（IgnoreButton）。
 * 内容重复这里是只有一条（和指令文件重复）的写法，两条以上见 AdviceGroupCard；放错层这里是项目 → 全局，全局那条见 MISPLACED_TO_PROJECT。
 */
const ADVICE_COPY = {
  expired: { title: 'pending.advice.expired.title', body: 'pending.advice.expired.body', actions: ['open', 'delete'] },
  // 很久没确认不给忽略：它的出路是「仍然有效」或删除
  stale: { title: 'pending.advice.stale.title', body: 'pending.advice.stale.body', actions: ['open', 'delete', 'confirm'] },
  bloat: { title: 'pending.advice.bloat.title', body: 'pending.advice.bloat.body', actions: ['open', 'edit', 'model'] },
  redundancy: { title: 'pending.advice.redundancy.title', body: 'pending.advice.redundancy.baselineBody', actions: ['open', 'delete'] },
  orphan: { title: 'pending.advice.orphan.title', body: 'pending.advice.orphan.body', actions: ['open'] },
  // 放错层只回答挪不挪：改写不动层
  misplaced: { title: 'pending.advice.misplaced.title', body: 'pending.advice.misplaced.toGlobalBody', actions: ['open', 'promote'] },
  unclear: { title: 'pending.advice.unclear.title', body: 'pending.advice.unclear.body', actions: ['open', 'edit', 'model'] },
} as const satisfies Record<AdviceType, { title: LocaleKey; body: LocaleKey; actions: readonly AdviceAction[] }>

/** 问题类型的显示名（卡片标题、不再提醒的列表）。 */
export function adviceTitle(type: AdviceType, t: Translate): string {
  return t(ADVICE_COPY[type].title)
}

/** 放错层里全局那条（该放项目）：「移到项目…」在卡片里选项目，和提升为全局对称。 */
const MISPLACED_TO_PROJECT = { body: 'pending.advice.misplaced.toProjectBody', actions: ['open', 'move'] } as const

/**
 * 标题行右上角的叉「不再提醒」：发 ignore-advice，带这一项的类型和全部记忆（内容重复是整组），每条带卡片上那一份的层和卡片版本。
 * 很久没确认的不给：它的出路是「仍然有效」或删除。
 */
function IgnoreButton({ item, action }: { item: Item<'advice'>; action: ItemAction }) {
  const t = useT()
  if (item.type === 'stale') return null
  const memories = item.memories.map(m => ({ memoryId: m.id, layer: layerOfMemory(m), base: baseOf(m) }))
  const command: MemoryCommand = { cmd: 'ignore-advice', type: item.type, memories }
  return <DismissButton label={t('pending.dismiss')} unavailable={action.unavailable} onClick={() => { action.run(command) }} />
}

/**
 * 能不能直接改：要有内容摘要（服务端靠它和 updatedAt 认出卡片加载后被改过），且不含密钥（界面上的文字可能是遮盖后的，
 * 照着改会把遮盖写回文件）。
 */
const isEditable = (memory: MemoryCardData) => memory.digest !== undefined && memory.hasSecret !== true

/** 能让模型改的建议类型（服务端按它给默认要求）。 */
const isModelEditType = (type: AdviceType): type is ModelEditAdviceType => (MODEL_EDIT_ADVICE_TYPES as readonly AdviceType[]).includes(type)

/** 命令里带回的卡片版本。 */
const baseOf = (memory: MemoryCardData) => ({ updatedAt: memory.updatedAt, digest: memory.digest ?? '' })

/** 改前字数：直接改是那一条，直接合并是两条相加。 */
function charsBefore(memories: readonly MemoryCardData[], command: EditCommand): number {
  const ids = command.cmd === 'edit-memory' ? [command.memoryId] : command.memories.map(m => m.memoryId)
  return memories.filter(m => ids.includes(m.id)).reduce((n, m) => n + m.content.length, 0)
}

/**
 * 建议整理卡：不着色、不带状态标记。删除先原位确认「删除这条？ 删除 · 取消」，再走 forget（进最近删除），含密钥时原位改问彻底删除；
 * 提升为全局按记忆 id 发 promote-memory，结果和提升候选一样可撤销；移到项目在卡片里选好项目再发 move-memory，同样可撤销。
 * 直接改在卡片里换出编辑框，保存发 edit-memory，同样可撤销；
 * 让模型改在卡片里展开生成与对照，应用同样发 edit-memory。借来的会话拿不到模型时，面板里写原因、「生成修改」置灰。
 */
export function AdviceCard(props: CardProps<'advice'> & {
  /** 「移到项目…」列出的已知项目，按显示顺序。 */
  projects: readonly string[]
  /** 「移到项目…」默认选中的项目（当前页面的项目）。 */
  defaultProject: string | undefined
}) {
  const { item, session, now, typeLabels, onDone, onRefused, projects, defaultProject } = props
  const t = useT()
  const gateway = useGateway()
  const action = useItemAction(session, (command, result) => {
    if (command.cmd === 'confirm') onDone({ kind: 'confirmed' })
    if (command.cmd === 'forget') onDone({ kind: 'deleted', memoryId: command.memoryId, layer: command.layer })
    if (command.cmd === 'hard-delete') onDone({ kind: 'hard-deleted' })
    if (command.cmd === 'promote-memory') onDone({ kind: 'promoted', target: 'global', decisionId: result.decisionId })
    if (command.cmd === 'move-memory') onDone({ kind: 'moved', workspacePath: command.workspacePath, decisionId: result.decisionId, filePath: result.filePath })
    if (command.cmd === 'ignore-advice') onDone({ kind: 'ignored', type: command.type, memoryIds: command.memories.map(m => m.memoryId) })
    if (command.cmd === 'edit-memory' || command.cmd === 'merge-memories') {
      onDone({
        kind: command.cmd === 'edit-memory' ? 'edited' : 'merged',
        decisionId: result.decisionId,
        name: command.name,
        fromChars: charsBefore(item.memories, command),
        toChars: command.content.length,
        filePath: result.filePath,
      })
    }
  }, onRefused)
  const [isEditing, setEditing] = useState(false)
  const [isModelEditing, setModelEditing] = useState(false)
  const [isMoving, setMoving] = useState(false)
  const buttonsOf = (memory: MemoryCardData, deleteLabel = t('pending.advice.delete')): Record<AdviceAction, ReactNode> => {
    const layer = layerOfMemory(memory)
    const open = () => { void gateway.openPath(memory.filePath, 'open').then((ok) => { if (!ok) action.fail(t('pending.openFailed')) }) }
    return {
      confirm: <Button key="confirm" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'confirm', memoryId: memory.id, layer }) }}>{t('pending.advice.confirm')}</Button>,
      delete: (
        <DeleteWithConfirm
          key="delete"
          onDelete={() => { action.run({ cmd: 'forget', memoryId: memory.id, layer }) }}
          trigger={open => <Button unavailable={action.unavailable} onClick={open}>{deleteLabel}</Button>}
        />
      ),
      promote: <Button key="promote" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'promote-memory', memoryId: memory.id, layer }) }}>{t('pending.promote.global')}</Button>,
      move: <Button key="move" unavailable={action.unavailable} onClick={() => { setMoving(true) }}>{t('pending.move.move')}</Button>,
      open: <Button key="open" variant="ghost" onClick={open}>{t('pending.advice.open')}</Button>,
      edit: isEditable(memory)
        ? <Button key="edit" unavailable={action.unavailable} onClick={() => { setEditing(true) }}>{t('pending.edit.edit')}</Button>
        : null,
      model: isEditable(memory)
        ? <Button key="model" unavailable={action.unavailable} onClick={() => { setModelEditing(true) }}>{t('pending.model.edit')}</Button>
        : null,
    }
  }
  if (item.type === 'redundancy' && item.memories.length > 1) {
    return <AdviceGroupCard {...props} action={action} buttonsOf={buttonsOf} />
  }
  const [memory] = item.memories
  const copy = item.type === 'misplaced' && memory.scope === 'global' ? { ...ADVICE_COPY.misplaced, ...MISPLACED_TO_PROJECT } : ADVICE_COPY[item.type]
  const buttons = buttonsOf(memory)
  return (
    <Card title={t(copy.title)} aside={item.type === 'stale' || isMoving || isEditing || isModelEditing ? undefined : <IgnoreButton item={item} action={action} />}>
      {isMoving
        ? (
          <>
            <div className="pm-pending-advice-memories"><MemoryOf session={session} memory={memory} now={now} typeLabels={typeLabels} /></div>
            <MovePanel
              projects={projects}
              initial={defaultProject}
              unavailable={action.unavailable}
              onCancel={() => { setMoving(false) }}
              onMove={(workspacePath) => { action.run({ cmd: 'move-memory', memoryId: memory.id, workspacePath }) }}
            />
          </>
        )
        : isEditing
        ? (
          <EditPanel
            initial={{ content: memory.content, name: memory.name, summary: memory.summary, tags: memory.tags }}
            original={{ content: memory.content, summary: memory.summary, chars: memory.content.length }}
            isMerge={false}
            unavailable={action.unavailable}
            onCancel={() => { setEditing(false) }}
            onSave={(draft) => { action.run({ cmd: 'edit-memory', memoryId: memory.id, layer: layerOfMemory(memory), base: baseOf(memory), ...draft }) }}
          />
        )
        : isModelEditing && isModelEditType(item.type)
          ? (
            <>
              <div className="pm-pending-advice-memories"><MemoryOf session={session} memory={memory} now={now} typeLabels={typeLabels} /></div>
              <ModelEditPanel
                memories={[memory]}
                adviceType={item.type}
                typeTitle={t(copy.title)}
                base={{ content: memory.content, name: memory.name, summary: memory.summary, tags: memory.tags }}
                session={session}
                unavailable={action.unavailable}
                onClose={() => { setModelEditing(false) }}
                onApply={(draft) => { action.run({ cmd: 'edit-memory', memoryId: memory.id, layer: layerOfMemory(memory), base: baseOf(memory), ...draft }) }}
              />
            </>
          )
          : (
            <>
              <div className="pm-pending-advice-memories">{item.memories.map(m => <MemoryOf key={m.id} session={session} memory={m} now={now} typeLabels={typeLabels} />)}</div>
              <AdviceNote>{t(copy.body, { date: formatDay(memory.lastConfirmedAt, now, t) })}</AdviceNote>
              <div className="pm-pending-actions">{copy.actions.map(a => buttons[a])}</div>
            </>
          )}
      <ActionFeedback action={action} />
    </Card>
  )
}

/** 直接合并的预填：保留的那条（mergeKeeperIndex）正文在前、空行接另一条，名称和摘要取保留那条，标签取并集。 */
function mergeDraft(pair: readonly [MemoryCardData, MemoryCardData]): { draft: EditDraft; chars: number } {
  const kept = pair[mergeKeeperIndex(pair)]
  const other = pair[1 - mergeKeeperIndex(pair)]!
  return {
    draft: { content: `${kept.content}\n\n${other.content}`, name: kept.name, summary: kept.summary, tags: [...new Set([...kept.tags, ...other.tags])] },
    chars: kept.content.length + other.content.length,
  }
}

/**
 * 互相重复的几条记忆一张卡：每条各自一栏，带自己的删除和打开文件。两条时左右并排，写「删除左边 / 删除右边」，
 * 两条都能改时再给「直接合并」「让模型合并」：合成保留的那条，另一条进最近删除。
 */
function AdviceGroupCard({ item, session, now, typeLabels, action, buttonsOf }: CardProps<'advice'> & {
  action: ItemAction
  buttonsOf: (memory: MemoryCardData, deleteLabel?: string) => Record<AdviceAction, ReactNode>
}) {
  const t = useT()
  const isPair = item.memories.length === 2
  const pair = isPair && item.memories.every(isEditable) ? [item.memories[0]!, item.memories[1]!] as const : undefined
  const [isMerging, setMerging] = useState(false)
  const [isModelMerging, setModelMerging] = useState(false)
  const merge = pair === undefined ? undefined : mergeDraft(pair)
  const mergeWith = (both: readonly [MemoryCardData, MemoryCardData], draft: EditDraft) => {
    const memories = both.map(m => ({ memoryId: m.id, layer: layerOfMemory(m), base: baseOf(m) }))
    action.run({ cmd: 'merge-memories', memories: [memories[0]!, memories[1]!], ...draft })
  }
  const sides = [
    { label: 'pending.advice.redundancy.left', delete: 'pending.advice.redundancy.deleteLeft' },
    { label: 'pending.advice.redundancy.right', delete: 'pending.advice.redundancy.deleteRight' },
  ] as const
  return (
    <Card title={t('pending.advice.redundancy.title')} aside={isMerging || isModelMerging ? undefined : <IgnoreButton item={item} action={action} />}>
      <div className="pm-pending-advice-memories pm-pending-advice-group">
        {item.memories.map((m, i) => {
          const side = isPair ? sides[i] : undefined
          const buttons = buttonsOf(m, side === undefined ? undefined : t(side.delete))
          return (
            <section key={m.id} className="pm-pending-advice-side" aria-label={side === undefined ? m.name : t(side.label)}>
              <MemoryOf session={session} memory={m} now={now} typeLabels={typeLabels} />
              {isMerging || isModelMerging ? null : <div className="pm-pending-actions">{buttons.open}{buttons.delete}</div>}
            </section>
          )
        })}
      </div>
      {isMerging && pair !== undefined && merge !== undefined
        ? (
          <EditPanel
            initial={merge.draft}
            original={{ content: merge.draft.content, summary: merge.draft.summary, chars: merge.chars }}
            isMerge
            unavailable={action.unavailable}
            onCancel={() => { setMerging(false) }}
            onSave={(draft) => { mergeWith(pair, draft) }}
          />
        )
        : isModelMerging && pair !== undefined && merge !== undefined
          ? (
            <ModelEditPanel
              memories={pair}
              adviceType="redundancy"
              typeTitle={t('pending.advice.redundancy.title')}
              base={merge.draft}
              keeper={mergeKeeperIndex(pair)}
              session={session}
              unavailable={action.unavailable}
              onClose={() => { setModelMerging(false) }}
              onApply={(draft) => { mergeWith(pair, draft) }}
            />
          )
          : (
            <>
              <AdviceNote>{t(isPair ? 'pending.advice.redundancy.body' : 'pending.advice.redundancy.manyBody')}</AdviceNote>
              <div className="pm-pending-actions">
                {pair !== undefined
                  ? (
                    <>
                      <Button unavailable={action.unavailable} onClick={() => { setMerging(true) }}>{t('pending.edit.merge')}</Button>
                      <Button unavailable={action.unavailable} onClick={() => { setModelMerging(true) }}>{t('pending.model.merge')}</Button>
                    </>
                  )
                  : null}
              </div>
            </>
          )}
      <ActionFeedback action={action} />
    </Card>
  )
}

// —— 结果卡：刚处理完留在原位，能撤销的带「撤销」 ——

interface ResultCopy { memory?: MemoryCardData | null; chip: string; body: string; undoable: boolean }

function resultCopy(item: PendingItem, outcome: Outcome, t: Translate): ResultCopy {
  if (outcome.kind === 'resolved' && item.kind === 'conflict-horizontal') {
    if (outcome.verdict === 'keep-left') return { memory: item.left, chip: t('pending.result.keptA'), body: t('pending.result.deletedSide', { side: 'B' }), undoable: true }
    if (outcome.verdict === 'keep-right') return { memory: item.right, chip: t('pending.result.keptB'), body: t('pending.result.deletedSide', { side: 'A' }), undoable: true }
    if (outcome.isUnrecorded) return { chip: t('pending.result.keptBoth'), body: t('pending.result.unrecordedBody'), undoable: false }
    return { chip: t('pending.result.keptBoth'), body: t('pending.result.keptBothBody'), undoable: true }
  }
  if (outcome.kind === 'resolved' && item.kind === 'conflict-vertical') {
    if (outcome.verdict === CONFLICT_ACTION_VERDICTS.vertical.keepBaseline) {
      return { chip: t('pending.result.followedBaseline'), body: t('pending.result.followedBaselineBody'), undoable: true }
    }
    return { memory: item.memory, chip: t('pending.result.keptMemory'), body: t(outcome.isUnrecorded ? 'pending.result.unrecordedBody' : 'pending.result.keptMemoryBody'), undoable: outcome.isUnrecorded !== true }
  }
  const memory = 'memory' in item ? item.memory : item.kind === 'advice' ? item.memories[0] : undefined
  switch (outcome.kind) {
    case 'promoted':
      // 写进 AGENTS.md 没有执行器能撤回那一行，服务端直接移出账本
      return outcome.target === 'global'
        ? { memory, chip: t('pending.result.promoted'), body: t('pending.result.promotedBody'), undoable: true }
        : { chip: t('pending.result.wroteAgentsMd'), body: t('pending.result.wroteAgentsMdBody'), undoable: false }
    case 'moved': {
      // 记忆卡按移过去之后的样子写作用域
      const moved = memory && { ...memory, scope: 'workspace' as const, workspacePath: outcome.workspacePath, filePath: outcome.filePath ?? memory.filePath }
      return { memory: moved, chip: t('pending.result.moved', { name: baseName(outcome.workspacePath) }), body: t('pending.result.movedBody'), undoable: true }
    }
    case 'kept-local': return { memory, chip: t('pending.result.keptLocal'), body: t('pending.result.keptLocalBody'), undoable: true }
    case 'hard-deleted': return { chip: t('pending.secret.deleted'), body: t('pending.secret.deletedBody'), undoable: false }
    case 'dismissed': return { chip: t('pending.result.dismissed'), body: t('pending.result.dismissedBody'), undoable: true }
    case 'raised': return { chip: t('pending.result.raised', { budget: formatNumber(outcome.budget) }), body: t('pending.overflow.raiseHint'), undoable: false }
    case 'confirmed': return { memory, chip: t('pending.result.confirmed'), body: t('pending.result.confirmedBody'), undoable: false }
    case 'deleted': return { chip: t('pending.result.deleted'), body: t('pending.result.deletedBody'), undoable: true }
    case 'ignored': return { memory, chip: t('pending.result.ignored'), body: t('pending.result.ignoredBody'), undoable: true }
    case 'resolved': throw new Error(`resolved outcome on ${item.kind}`)
    case 'edited': case 'merged': throw new Error(`${outcome.kind} outcome renders as EditedRow`)
  }
}

export function ResultCard({ item, outcome, session, now, typeLabels, onUndone, onRefused }: {
  item: PendingItem
  outcome: Outcome
  session: BorrowedSession
  now: number
  typeLabels: Readonly<Record<string, string>>
  onUndone: () => void
  onRefused: () => void
}) {
  const t = useT()
  const action = useItemAction(session, () => { onUndone() }, onRefused)
  if (outcome.kind === 'edited' || outcome.kind === 'merged') return <EditedRow item={item} outcome={outcome} action={action} />
  const copy = resultCopy(item, outcome, t)
  const undoId = 'decisionId' in item ? item.decisionId : outcome.kind === 'promoted' || outcome.kind === 'moved' ? outcome.decisionId : undefined
  // 忽略不进账本，撤销就是取消忽略；删除进了最近删除，撤销就是恢复那一份；其余撤销按账本条目
  const undo: MemoryCommand | undefined = !copy.undoable ? undefined
    : outcome.kind === 'ignored' ? { cmd: 'unignore-advice', type: outcome.type, memoryIds: outcome.memoryIds }
    : outcome.kind === 'deleted' ? { cmd: 'restore', memoryId: outcome.memoryId, layer: outcome.layer }
    : undoId !== undefined ? { cmd: 'undo', decisionId: undoId } : undefined
  return (
    <Card marker={item.kind === 'advice' ? undefined : <StatusMarker kind="done" />} title={titleOf(item, t)} focusable isResult>
      {copy.memory ? <MemoryOf session={session} memory={copy.memory} now={now} typeLabels={typeLabels} /> : null}
      <ResultLine
        chip={copy.chip}
        isStandalone={!copy.memory}
        undo={undo !== undefined
          ? (
            <Button variant="ghost" className="pm-pending-undo" unavailable={action.unavailable} onClick={() => { action.run(undo) }}>
              {t('pending.undo')}
            </Button>
          )
          : undefined}
      >
        {copy.body}
      </ResultLine>
      <ActionFeedback action={action} />
    </Card>
  )
}

/** 直接改、直接合并的结果收成一行：结果 · 名称 · 字数变化，带撤销和打开文件（打开的是写完后的那个文件）。 */
function EditedRow({ item, outcome, action }: {
  item: PendingItem
  outcome: Extract<Outcome, { kind: 'edited' | 'merged' }>
  action: ItemAction
}) {
  const t = useT()
  const gateway = useGateway()
  const filePath = outcome.filePath ?? (item.kind === 'advice' ? item.memories[0]?.filePath : undefined)
  const open = () => {
    if (filePath !== undefined) void gateway.openPath(filePath, 'open').then((ok) => { if (!ok) action.fail(t('pending.openFailed')) })
  }
  const undoId = outcome.decisionId
  return (
    <article className="pm-pending-item pm-pending-item--result" tabIndex={-1}>
      <div className="pm-pending-done">
        <Chip variant="result">{t(outcome.kind === 'edited' ? 'pending.result.edited' : 'pending.result.merged')}</Chip>
        <span className="pm-pending-done-text">
          {`${outcome.name} · ${t('pending.edit.count', { from: formatNumber(outcome.fromChars), to: formatNumber(outcome.toChars) })}`}
        </span>
        {undoId !== undefined
          ? (
            <Button variant="ghost" className="pm-pending-undo" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'undo', decisionId: undoId }) }}>
              {t('pending.undo')}
            </Button>
          )
          : null}
        {filePath !== undefined ? <Button onClick={open}>{t('pending.advice.open')}</Button> : null}
      </div>
      <ActionFeedback action={action} />
    </article>
  )
}

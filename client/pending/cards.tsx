/**
 * 待处理的各类卡（PRD 5.2；建议整理见 spec「建议整理的动作」）与处理后留在原位的结果卡。每张卡动手前写清后果；动作经 useCardAction（命令往返模块）发命令，
 * 成功后把结果（Outcome）交给列表，由列表在原位换成结果卡。
 */
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import {
  CONFLICT_ACTION_VERDICTS, MAX_BATCH_EDIT, MODEL_EDIT_ADVICE_TYPES, mergeKeeperIndex, sameScope, relaxedCap, scopeOfMemory, verdictOfAction,
  type AdviceType, type IgnorableAdviceType, type MemoryCard as MemoryCardData, type MemoryCommand, type ModelEditAdviceType, type PendingItem, type ProposalOp, type ProposalSource,
  type ResolveVerdict, type Scope, type SourceCheck,
} from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { belongsTo } from '../session-pick.ts'
import { baseName, formatDay, formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { isMac } from '../path.ts'
import { AdviceNote, ResultLine } from '../ui/Advice.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { ConflictRuling, VerticalConflictRuling } from '../ui/ConflictRuling.tsx'
import { DismissButton } from '../ui/DismissButton.tsx'
import { MemoryCard } from '../ui/MemoryCard.tsx'
import { StatusMarker } from '../ui/StatusMarker.tsx'
import { CommandFeedback, DeleteWithConfirm, SecretDeleteConfirm, SoftDeleteConfirm } from '../command/confirm.tsx'
import type { EditCommand } from '../command/protocol.ts'
import { useCommandRunner, type RunHandlers } from '../command/useCommandRunner.ts'
import { EditPanel, type EditDraft } from './edit.tsx'
import { EditModes } from './edit-modes.tsx'
import { BatchEdit, toBatchItems, type BatchApplication } from '../library/batch-edit.tsx'
import { useReturnFocus } from '../ui/focus-return.ts'
import { baseOf, draftOf, isEditable } from './card-edit.ts'
import { ModelEditPanel } from './model-edit.tsx'
import { MovePanel } from './move.tsx'
import { ProposalRequest, useRequestSlot, type DirectVerdict } from './proposal.tsx'
import { ChoicePanel } from './choice.tsx'
import { SuggestionBlock } from './suggestion.tsx'

type Item<K extends PendingItem['kind']> = Extract<PendingItem, { kind: K }>

/** 一次动作的结果，结果卡按它写文案、决定能不能撤销。 */
export type Outcome =
  /**
   * isUnrecorded：两边都留但结论没记下（见命令结果 isUnrecorded），没有可撤销的条目。isHardDeleted：败方含密钥、已彻底删除，没有撤销。
   * source：落盘的是哪种处理方案（横向冲突）——采纳模型的建议，结果卡写「按模型建议处理」；补充要求生成的，写「按你的要求处理」；缺省是用户直接选的。
   * current：并成版本时留作当前状态的那条（另一条并进它的历史版本）。体检的四种新发现也用它（忽略、确实不冲突、并成版本）。
   */
  | { kind: 'resolved'; verdict: ResolveVerdict; current?: string; isUnrecorded?: true; isHardDeleted?: true; source?: ProposalSource }
  /**
   * 融合成一条（横向冲突，采纳融合建议或按要求生成的融合方案，source 同上）：keeper 是写进融合稿的那条，按融合后的样子显示；keep、drop 是它和被并入的那条融合前的名称（结果卡用名称指代，不用 A / B）。
   * isPartial：只完成了一部分（被并入的那条没删）；decisionId 是仍可撤销的那一笔（融合稿还在时有），没有就不能撤。
   */
  | { kind: 'plan-merged'; source: ProposalSource; keeper: MemoryCardData; keep: string; drop: string; partial?: MergePartial; decisionId?: string }
  /**
   * 改写这条记忆（垂直冲突，采纳改写建议或按要求生成的改写方案，source 同上）：memory 按改写后的样子显示。
   * isPartial：没有做完（改写没退干净）；decisionId 是仍可撤销的那一笔（有才能撤）。
   */
  | { kind: 'plan-rewritten'; source: ProposalSource; memory: MemoryCardData; isPartial?: true; decisionId?: string }
  /** decisionId：撤销用的账本条目（按记忆 id 提升时由命令结果带回；提升候选用条目自己的）。memoryId：跨项目重复里提升的是哪一条。 */
  | { kind: 'promoted'; target: 'global' | 'agents-md'; decisionId?: string; memoryId?: string }
  /** 全局记忆移到了 workspacePath 那个项目；decisionId 是撤销用的账本条目，filePath 是移过去之后的文件。 */
  | { kind: 'moved'; workspacePath: string; decisionId?: string; filePath?: string }
  | { kind: 'kept-local' }
  | { kind: 'hard-deleted' }
  | { kind: 'dismissed' }
  | { kind: 'raised'; budget: number }
  | { kind: 'confirmed' }
  /** 软删进了最近删除：撤销发 restore，带删的那一份。 */
  | { kind: 'deleted'; memoryId: string; scope: Scope | undefined }
  /** 建议整理的忽略：撤销发 unignore-advice，带同样的类型和记忆 id。 */
  | { kind: 'ignored'; type: IgnorableAdviceType; memoryIds: string[] }
  /** 手动改、手动合并：结果行写名称和字数变化；filePath 是写完后的文件（改了名称文件名会跟着变）。 */
  | { kind: 'edited' | 'merged'; decisionId?: string; name: string; fromChars: number; toChars: number; filePath?: string }
  /** 三条以上内容重复的「合并」（整理所选的三步）：改写、删除了几条；decisionId 是撤销用的账本条目（撤销全部）。 */
  | { kind: 'tidied'; decisionId?: string; rewrites: number; deletes: number }

export interface CardProps<K extends PendingItem['kind']> {
  item: Item<K>
  session: BorrowedSession
  now: number
  typeLabel: (type: string) => string
  onDone: (outcome: Outcome) => void
  /** 这一条正在别处处理或刚处理完，什么都没动（命令往返的 handled-elsewhere）：由列表在卡片外提示。 */
  onRefused: () => void
}

/** 一张卡的动作：共用一个 key，在途、等确认、失败都记在这张卡上，反馈画在卡片底部。 */
export interface CardAction {
  run(command: MemoryCommand): void
  /** 按钮不可用的原因：没有会话、正在处理、等确认。 */
  unavailable: string | undefined
  /** 命令以外的失败（打开文件、写配置）也显示在同一处。 */
  fail(detail: string): void
  feedback: ReactNode
}

const CARD = 'card'

export function useCardAction(session: BorrowedSession, handlers: RunHandlers): CardAction {
  const runner = useCommandRunner(session)
  return {
    run(command) { runner.run(CARD, command, handlers) },
    unavailable: runner.unavailable(CARD),
    fail(detail) { runner.fail(CARD, detail) },
    feedback: <CommandFeedback runner={runner} id={CARD} />,
  }
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
function bodyOf(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return (m === null ? text : text.slice(m[0].length)).trim()
}

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
export function Card({ marker, title, aside, focusable = false, isResult = false, children }: {
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

export function MemoryOf({ memory, session, now, typeLabel, collapsible = false, projectName, badge }: {
  memory: MemoryCardData
  session: BorrowedSession
  now: number
  typeLabel: (type: string) => string
  /** 建议卡里的记忆（pm-pending-advice-memories）固定限 3 行、不展开，不传。 */
  collapsible?: boolean
  /** 作用域一律写这个项目名（跨项目重复）；缺省时只在别的项目里写项目名。 */
  projectName?: string | undefined
  /** 跟在原文末尾的标注（「建议留作当前」）。 */
  badge?: ReactNode
}) {
  return <MemoryCard memory={memory} now={now} typeLabel={typeLabel(memory.type)} projectName={projectName ?? projectNameOf(session)(memory)} collapsible={collapsible} badge={badge} />
}

/** 卡片标题；处理前的卡和处理后的结果卡共用，别的项目里的提升候选两处都写项目名。 */
export function titleOf(item: PendingItem, t: Translate, session: BorrowedSession): string {
  switch (item.kind) {
    case 'secret': return t('pending.secret.title')
    case 'conflict-horizontal': return item.summary || t('conflict.title')
    case 'conflict-vertical': return item.summary || t('conflict.title')
    case 'promote-candidate': {
      const other = otherProject(item.memory, session)
      return other !== undefined ? t('pending.promote.titleIn', { name: baseName(other) }) : t('pending.promote.title')
    }
    case 'overflow': return t('pending.overflow.title')
    case 'unreadable-file': return t('pending.unreadable.title')
    case 'advice': return t(ADVICE_COPY[item.type].title)
    case 'missed-change': return t('pending.missed.title')
    case 'exception': return t(item.baselineRef !== undefined ? 'pending.exception.titleBaseline' : 'pending.exception.title')
    case 'premise-changed': return t('pending.premise.title')
    case 'cross-duplicate': return t('pending.crossDup.title')
  }
}

// —— 密钥 ——

export function SecretCard({ item, session, now, typeLabel, onDone }: CardProps<'secret'>) {
  const t = useT()
  const gateway = useGateway()
  const action = useCardAction(session, { onOk: () => { onDone({ kind: 'hard-deleted' }) } })
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
      <MemoryOf session={session} memory={typeof revealed === 'string' ? { ...memory, content: revealed } : memory} now={now} typeLabel={typeLabel} collapsible />
      {revealed === null ? <p className="pm-pending-text">{t('pending.secret.readFailed')}</p> : null}
      <AdviceNote>{t('pending.secret.body')}</AdviceNote>
      {confirming
        ? (
          <SecretDeleteConfirm
            showTitle={false}
            unavailable={action.unavailable}
            onCancel={() => { setConfirming(false) }}
            onConfirm={() => { action.run({ cmd: 'hard-delete', memoryId: memory.id, layer: scopeOfMemory(memory) }) }}
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
      {action.feedback}
    </Card>
  )
}

// —— 冲突 ——

/**
 * 裁决成功 → 结果卡的 Outcome。采纳建议的命令只带建议 id，裁决由点击时卡上那份建议的结论给（adopted）；
 * 按要求应用的命令带着方案，裁决按方案的结论。
 */
export const resolvedTo = (onDone: (outcome: Outcome) => void, adopted?: ResolveVerdict): NonNullable<RunHandlers['onOk']> => (result, command) => {
  const proposal = command.cmd === 'apply-proposal' ? command.proposal : undefined
  const verdict = command.cmd === 'resolve' ? command.verdict
    : proposal !== undefined ? verdictOfAction(proposal.action)
      : command.cmd === 'apply-proposal' ? adopted : undefined
  if (verdict === undefined) return
  onDone({
    kind: 'resolved', verdict,
    ...(command.cmd === 'resolve' && command.current !== undefined ? { current: command.current } : {}),
    ...(result.isUnrecorded ? { isUnrecorded: true } : {}), ...(result.isHardDeleted ? { isHardDeleted: true } : {}),
    ...(command.cmd === 'apply-proposal' ? { source: proposal !== undefined ? 'request' : 'suggestion' } : {}),
  })
}

export function HorizontalCard({ item, session, now, typeLabel, onDone, onRefused }: CardProps<'conflict-horizontal'>) {
  const t = useT()
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
        title={titleOf(item, t, session)}
        note={note}
        typeLabel={typeLabel}
        projectName={projectNameOf(session)}
        headExtra={<><ScopeChips /><SourceCheckChip value={item.sourceCheck} /></>}
        footer={<HorizontalActions item={item} session={session} onDone={onDone} onRefused={onRefused} />}
      />
    </div>
  )
}

/** 横向冲突报出前回查出处的结果：读不到、这次没读时在标题行标出来；两边都读到（checked）是常态，不标。 */
const SOURCE_CHECK_LABEL = {
  unreadable: 'pending.source.unreadable',
  unchecked: 'pending.source.unchecked',
} as const satisfies Partial<Record<SourceCheck, LocaleKey>>

function SourceCheckChip({ value }: { value: SourceCheck | undefined }) {
  const t = useT()
  if (value !== 'unreadable' && value !== 'unchecked') return null
  return <span className="pm-pending-scope"><Chip variant="neutral">{t(SOURCE_CHECK_LABEL[value])}</Chip></span>
}

/**
 * 原位确认在问哪件事：rule 是直接处理之一（保留一方、确实不冲突、记成例外；垂直是删除这条、都保留），
 * adopt 是采纳（只有要删的那条含高危密钥时才确认），记下确认的是哪一份建议。
 */
type Asking = { kind: 'rule'; verdict: DirectVerdict } | { kind: 'adopt'; verdict: ResolveVerdict; suggestionId: string }

/** 冲突卡发出的命令：按要求应用（request）、采纳建议（adopt）、直接处理（other）。 */
type SentKind = 'request' | 'adopt' | 'other'
const sentKindOf = (command: MemoryCommand): SentKind =>
  (command.cmd !== 'apply-proposal' ? 'other' : command.proposal !== undefined ? 'request' : 'adopt')

/** 「并成版本」默认留作当前的那条：后记下的那条（同时记下的取 B）。 */
export function newerOf(left: MemoryCardData, right: MemoryCardData): string {
  return left.createdAt > right.createdAt ? left.id : right.id
}

/** 融合只完成一部分时留下了什么：kept 保留方停在融合稿、已记账可撤销；changed 保留方被别处接着改过；其余情况归 other。 */
type MergePartial = 'kept' | 'changed' | 'other'
function mergePartialOf(keeperId: string, recorded: readonly string[], unrecorded: readonly string[]): MergePartial {
  if (unrecorded.length === 0 && recorded.length === 1 && recorded[0] === keeperId) return 'kept'
  if (recorded.length === 0 && unrecorded.length === 1 && unrecorded[0] === keeperId) return 'changed'
  return 'other'
}

/** 记忆在结果和后果里的称呼：名称；这一方找不到时退回卡上的 A / B。 */
const nameOf = (memory: MemoryCardData | null, side: 'A' | 'B'): string => memory?.name ?? side

/** 融合方案（建议或按要求生成的）写进哪条、哪条并入删除：按方案里的操作，不在界面上重算合并规则。keeper 换成融合后的样子，keep、drop 是两条融合前的名称。 */
function mergeSidesOf(ops: readonly ProposalOp[], left: MemoryCardData | null, right: MemoryCardData | null) {
  const edit = ops.find(op => op.kind === 'edit')
  if (edit?.kind !== 'edit') return undefined
  const isRight = edit.memoryId === right?.id
  const keeper = isRight ? right : edit.memoryId === left?.id ? left : null
  if (keeper === null) return undefined
  const { content, name, summary, tags } = edit
  return { keeper: { ...keeper, content, name, summary, tags }, keep: keeper.name, drop: isRight ? nameOf(left, 'A') : nameOf(right, 'B') }
}

/**
 * 横向冲突卡（记忆页）A、B 下面的整块：处理建议块、说明行、按钮行（spec 故事 4–19、23、24）。
 * - 有建议时「采纳建议」（主按钮）发 apply-proposal，只带条目 id 和建议 id，一次落盘、不加确认——建议内容（融合稿也在）都在卡上，
 *   删掉的一方进最近删除、能撤销。保留一方时要删的那条含高危密钥会彻底删除，先原位确认（融合建议不会碰到：含高危密钥的不生成建议）。
 *   说明行写采纳后哪条去哪；建议回查过两条的出处时，前面先写这一句。
 * - 直接处理「保留 A / 保留 B / 都保留，不算冲突」不过模型：点了原位确认一句，再走现有裁决命令 resolve。
 * - 「补充要求」（两条都能交给模型时才有：带卡片版本、都不含密钥、会话没说拿不到模型）展开输入区（proposal.tsx）。
 *   有建议时按钮行只有「采纳建议」「补充要求」，直接处理挪进输入区的常用处理；没有建议时是三个直接处理加「补充要求」。
 *   拿不到「补充要求」时照旧给三个直接处理，用户不靠模型也能定。
 *   方案的「应用」发 apply-proposal 带方案（含依据版本）；回 stale 说明两条被改过，方案作废、输入区写明原因。
 * - 采纳时服务端回 stale（建议已换了一份，或两条在建议生成后被改过）：什么都没动。卡上这份建议当作失效，建议块写明原因、
 *   退化成没有建议的样子；视图带来另一份建议（id 不同）时照常显示。
 */
function HorizontalActions({ item, session, onDone, onRefused }: Pick<CardProps<'conflict-horizontal'>, 'item' | 'session' | 'onDone' | 'onRefused'>) {
  const t = useT()
  const gateway = useGateway()
  const { horizontal } = CONFLICT_ACTION_VERDICTS
  const [staleId, setStaleId] = useState<string | undefined>(undefined)
  const [asking, setAsking] = useState<Asking | undefined>(undefined)
  /** 点了「并成版本」、正在选留作当前的那条。 */
  const [isPickingVersions, setPickingVersions] = useState(false)
  /** 按要求应用回 stale 的次数：交给输入区作废手上的方案。 */
  const [voided, setVoided] = useState(0)
  /** 最近发出的是哪种命令：失败处理器拿不到命令，靠它分清 stale 是采纳建议的、按要求应用的，还是直接处理的（并成版本）。 */
  const sent = useRef<SentKind>('other')
  const slot = useRequestSlot(item.decisionId)
  // 只读这个会话已知的模型状态：页面加载时不问（问一次会在借来的会话日志里留一条记录）
  const model = gateway.useModel(session, { shouldAsk: false })
  const isStale = staleId !== undefined && (item.suggestion === undefined || item.suggestion.id === staleId)
  const suggestion = isStale ? undefined : item.suggestion
  const adopted = suggestion === undefined ? undefined : verdictOfAction(suggestion.action)
  const merging = suggestion?.action === 'merge' ? mergeSidesOf(suggestion.ops, item.left, item.right) : undefined
  const { left, right } = item
  const action = useCardAction(session, {
    onOk: (result, command) => {
      const proposal = command.cmd === 'apply-proposal' ? command.proposal : undefined
      const sides = proposal === undefined ? (command.cmd === 'apply-proposal' ? merging : undefined)
        : proposal.action === 'merge' ? mergeSidesOf(proposal.ops, left, right) : undefined
      if (sides === undefined) { resolvedTo(onDone, adopted)?.(result, command); return }
      onDone({
        kind: 'plan-merged', source: proposal !== undefined ? 'request' : 'suggestion', ...sides,
        ...(result.isPartial === true ? { partial: mergePartialOf(sides.keeper.id, result.memoryIds ?? [], result.unrecordedIds ?? []) } : {}),
        ...(result.decisionId !== undefined ? { decisionId: result.decisionId } : {}),
      })
    },
    onHandledElsewhere: onRefused,
    // 采纳建议、按要求应用回 stale 是建议或方案作废；直接处理（并成版本）回 stale 照常在卡上写原因。
    // 处理器按点击时那一次渲染取，记下的是当时卡上那份建议
    onFailed: (failure) => {
      if (failure.code !== 'stale' || sent.current === 'other') return false
      if (sent.current === 'request') { setVoided(n => n + 1); return true }
      if (suggestion === undefined) return false
      setStaleId(suggestion.id)
      return true
    },
  })
  const run = (command: MemoryCommand) => {
    sent.current = sentKindOf(command)
    action.run(command)
  }
  const reason = action.unavailable ?? (left === null || right === null ? t('conflict.missingHint') : undefined)
  const canRequest = left !== null && right !== null && isEditable(left) && isEditable(right) && model.status !== 'unavailable'
  const isRequesting = canRequest && slot.isOpen
  /** 每种裁决留哪边、删哪边；两边都留的不删。 */
  const sides = (verdict: ResolveVerdict) => (verdict === horizontal.keepA ? { keep: 'A', drop: 'B', loser: right } as const
    : verdict === horizontal.keepB ? { keep: 'B', drop: 'A', loser: left } as const : undefined)
  const isPurge = (verdict: ResolveVerdict) => sides(verdict)?.loser?.hasSecret === true
  const adopt = () => {
    if (suggestion !== undefined) run({ cmd: 'apply-proposal', decisionId: item.decisionId, suggestionId: suggestion.id })
  }
  const rule = (verdict: DirectVerdict) => { run({ cmd: 'resolve', decisionId: item.decisionId, verdict }) }
  /** 直接处理（按钮行或常用处理）：并成版本先选留作当前的那条，其余原位确认。 */
  const pick = (verdict: DirectVerdict) => {
    if (verdict === horizontal.asVersions) setPickingVersions(true)
    else setAsking({ kind: 'rule', verdict })
  }
  const send = (ask: Asking) => {
    setAsking(undefined)
    if (ask.kind === 'rule') { rule(ask.verdict); return }
    // 确认框开着时卡上的建议换了或没了：确认的是那一份，不拿它去采纳另一份，按失效处理
    if (suggestion?.id === ask.suggestionId) adopt()
    else setStaleId(ask.suggestionId)
  }

  // 采纳后果用名称指代被删的那条：说明行离 A、B 两张卡有一段距离
  const adoptNote = merging !== undefined ? t('pending.conflict.adoptNote', { drop: merging.drop })
    : adopted === undefined ? undefined
    : adopted === horizontal.keepBoth ? t('pending.conflict.adoptNoteKeepBoth')
      : t(isPurge(adopted) ? 'pending.conflict.adoptNotePurge' : 'pending.conflict.adoptNote', { drop: nameOf(sides(adopted)!.loser, sides(adopted)!.drop) })
  // 两条都回查到出处时说明行先交代一句（由服务端按实际放进提示词的片段定）；没回查到就不提
  const sourced = suggestion?.isSourced === true ? t('pending.suggestion.sourced') : undefined
  // 输入区开着时说明行写的是采纳建议的后果，先收起，免得和方案的去向混在一起
  const note = isRequesting ? undefined : sourced === undefined ? adoptNote : adoptNote === undefined ? sourced : t('conflict.twoSentences', { first: sourced, second: adoptNote })
  // 「都保留」拆成确实不冲突、记成例外（两条都留、记下结论），加上并成版本
  const direct = [
    [horizontal.keepA, t('pending.conflict.keepA')],
    [horizontal.keepB, t('pending.conflict.keepB')],
    [horizontal.asVersions, t('pending.conflict.asVersions')],
    [horizontal.notConflict, t('pending.conflict.notConflict')],
    [horizontal.exception, t('pending.conflict.exception')],
  ] as const
  const hasAdopt = adopted !== undefined || merging !== undefined
  /** 两边都留的直接处理的原位确认：问句和确认按钮。 */
  const keepPair = {
    [horizontal.notConflict]: { question: t('pending.conflict.confirmNotConflict'), label: t('pending.conflict.notConflict') },
    [horizontal.exception]: { question: t('pending.conflict.confirmException'), label: t('pending.conflict.exception') },
  } as Partial<Record<ResolveVerdict, { question: string; label: string }>>

  let row: ReactNode = null
  if (asking !== undefined && isPurge(asking.verdict)) {
    const { keep, drop } = sides(asking.verdict)!
    row = (
      <SecretDeleteConfirm
        showTitle={false}
        body={t('pending.conflict.confirmPurge', { keep, drop })}
        unavailable={action.unavailable}
        onCancel={() => { setAsking(undefined) }}
        onConfirm={() => { send(asking) }}
      />
    )
  } else if (asking !== undefined) {
    const side = sides(asking.verdict)
    const pair = keepPair[asking.verdict]
    row = (
      <div className="pm-conflict-actions">
        <SoftDeleteConfirm
          question={side === undefined ? pair?.question : t('pending.conflict.confirmKeep', { keep: side.keep, drop: side.drop })}
          confirmLabel={side === undefined ? pair?.label : t(side.keep === 'A' ? 'pending.conflict.keepA' : 'pending.conflict.keepB')}
          onCancel={() => { setAsking(undefined) }}
          onConfirm={() => { send(asking) }}
        />
      </div>
    )
  } else if (isPickingVersions && left !== null && right !== null) {
    row = (
      <ChoicePanel
        legend={t('pending.versions.pick')}
        options={[
          { value: left.id, label: t('pending.versions.side', { side: 'A', name: left.name }) },
          { value: right.id, label: t('pending.versions.side', { side: 'B', name: right.name }) },
        ]}
        initial={newerOf(left, right)}
        hint={t('pending.versions.hint')}
        confirmLabel={t('pending.conflict.asVersions')}
        unavailable={reason}
        onCancel={() => { setPickingVersions(false) }}
        onConfirm={(current) => {
          setPickingVersions(false)
          run({ cmd: 'resolve', decisionId: item.decisionId, verdict: horizontal.asVersions, current })
        }}
      />
    )
  } else if (!isRequesting) {
    row = (
      <div className="pm-conflict-actions">
        {hasAdopt
          ? (
            <Button variant="primary" unavailable={reason} onClick={() => { if (adopted !== undefined && isPurge(adopted) && suggestion !== undefined) setAsking({ kind: 'adopt', verdict: adopted, suggestionId: suggestion.id }); else adopt() }}>
              {t('pending.conflict.adopt')}
            </Button>
          )
          : null}
        {hasAdopt && canRequest
          ? null
          : direct.map(([verdict, label]) => (
            <Button key={verdict} unavailable={reason} onClick={() => { pick(verdict) }}>{label}</Button>
          ))}
        {canRequest ? <Button unavailable={reason} onClick={slot.open}>{t('pending.conflict.request')}</Button> : null}
      </div>
    )
  }
  return (
    <>
      {left !== null && right !== null
        ? (
          <SuggestionBlock
            decisionId={item.decisionId} left={left} right={right} suggestion={suggestion}
            noSuggestion={item.noSuggestion ?? (isStale ? { code: 'not-generated' } : undefined)} isGenerating={item.isGeneratingSuggestion === true}
            // 失效的提示只在视图没有更新的原因时写：之后生成失败、模型判断不了，写视图给的原因
            notice={isStale && (item.noSuggestion === undefined || item.noSuggestion.code === 'not-generated') ? t('pending.suggestion.stale') : undefined}
            session={session} onRefused={onRefused}
          />
        )
        : null}
      {note !== undefined ? <AdviceNote label="note">{note}</AdviceNote> : null}
      {isRequesting
        ? (
          <ProposalRequest
            decisionId={item.decisionId} left={left} right={right} session={session}
            unavailable={action.unavailable} isHidden={asking !== undefined || isPickingVersions} voided={voided}
            discardAsk={slot.isAskingDiscard
              ? <SoftDeleteConfirm question={t('library.edit.discard')} confirmLabel={t('library.edit.discardConfirm')} onCancel={slot.keep} onConfirm={slot.discard} />
              : undefined}
            onClose={slot.close}
            onPick={pick}
            onApply={(proposal) => { run({ cmd: 'apply-proposal', decisionId: item.decisionId, proposal }) }}
            onRefused={onRefused}
            onDirtyChange={slot.report}
          />
        )
        : null}
      {row}
      {action.feedback}
    </>
  )
}

export function VerticalCard({ item, session, now, typeLabel, onDone, onRefused }: CardProps<'conflict-vertical'>) {
  const t = useT()
  return (
    <div className="pm-pending-item">
      <VerticalConflictRuling
        layout="wide"
        memory={item.memory}
        baselineRef={item.baselineRef}
        now={now}
        title={titleOf(item, t, session)}
        typeLabel={typeLabel}
        projectName={projectNameOf(session)}
        headExtra={<ScopeChips />}
        footer={<VerticalActions item={item} session={session} onDone={onDone} onRefused={onRefused} />}
      />
    </div>
  )
}

/** 改写方案（建议或按要求生成的）落到这条记忆上的样子：按方案里的改写项，不在界面上重算。 */
function rewrittenOf(ops: readonly ProposalOp[], memory: MemoryCardData | null): MemoryCardData | undefined {
  const edit = ops.find(op => op.kind === 'edit')
  if (edit?.kind !== 'edit' || memory === null || edit.memoryId !== memory.id) return undefined
  const { content, name, summary, tags } = edit
  return { ...memory, content, name, summary, tags }
}

/**
 * 垂直冲突卡（记忆页）记忆下面的整块，结构同横向（HorizontalActions）：建议块、说明行、按钮行（spec 故事 5a、32–33）。
 * - 建议三种：改写这条记忆（带改写稿，采纳走 apply-proposal、记 plan-applied、可撤销）、以文件为准删除这条（记现有裁决 keep-right）、
 *   都保留（记 keep-both）。采纳只带条目 id 和建议 id；删除时这条含高危密钥会彻底删除，先原位确认。指令文件插件不改。
 * - 直接处理「以文件为准，删除这条」「都保留，不算冲突」不过模型：原位确认后走裁决命令 resolve（keep-right / keep-left）。
 * - 「补充要求」同横向，常用处理多一个「改写这条记忆」（填要求）。
 * - 补上建议、采纳、补充要求在哪个会话里都能做：服务端按这条记忆对应的指令文件核对。
 *   采纳时服务端回 stale（建议换了一份、记忆或指令文件改过）同横向：卡上这份建议当作失效。
 */
function VerticalActions({ item, session, onDone, onRefused }: Pick<CardProps<'conflict-vertical'>, 'item' | 'session' | 'onDone' | 'onRefused'>) {
  const t = useT()
  const gateway = useGateway()
  const { vertical } = CONFLICT_ACTION_VERDICTS
  const [staleId, setStaleId] = useState<string | undefined>(undefined)
  const [asking, setAsking] = useState<Asking | undefined>(undefined)
  const [voided, setVoided] = useState(0)
  const sent = useRef<SentKind>('other')
  const slot = useRequestSlot(item.decisionId)
  const model = gateway.useModel(session, { shouldAsk: false })
  const { memory } = item
  const isStale = staleId !== undefined && (item.suggestion === undefined || item.suggestion.id === staleId)
  const suggestion = isStale ? undefined : item.suggestion
  const adopted = suggestion === undefined ? undefined : verdictOfAction(suggestion.action)
  const rewriting = suggestion?.action === 'rewrite' ? rewrittenOf(suggestion.ops, memory) : undefined
  const action = useCardAction(session, {
    onOk: (result, command) => {
      const proposal = command.cmd === 'apply-proposal' ? command.proposal : undefined
      const rewritten = proposal === undefined ? (command.cmd === 'apply-proposal' ? rewriting : undefined)
        : proposal.action === 'rewrite' ? rewrittenOf(proposal.ops, memory) : undefined
      if (rewritten === undefined) { resolvedTo(onDone, adopted)?.(result, command); return }
      onDone({
        kind: 'plan-rewritten', source: proposal !== undefined ? 'request' : 'suggestion', memory: rewritten,
        ...(result.isPartial === true ? { isPartial: true } : {}), ...(result.decisionId !== undefined ? { decisionId: result.decisionId } : {}),
      })
    },
    onHandledElsewhere: onRefused,
    // 同横向：采纳建议、按要求应用回 stale 是建议或方案作废，直接处理的照常写原因
    onFailed: (failure) => {
      if (failure.code !== 'stale' || sent.current === 'other') return false
      if (sent.current === 'request') { setVoided(n => n + 1); return true }
      if (suggestion === undefined) return false
      setStaleId(suggestion.id)
      return true
    },
  })
  const run = (command: MemoryCommand) => {
    sent.current = sentKindOf(command)
    action.run(command)
  }
  const reason = action.unavailable ?? (memory === null ? t('conflict.missingHint') : undefined)
  const canRequest = memory !== null && isEditable(memory) && model.status !== 'unavailable'
  const isRequesting = canRequest && slot.isOpen
  const isPurge = (verdict: ResolveVerdict) => verdict === vertical.keepBaseline && memory?.hasSecret === true
  const adopt = () => {
    if (suggestion !== undefined) run({ cmd: 'apply-proposal', decisionId: item.decisionId, suggestionId: suggestion.id })
  }
  const send = (ask: Asking) => {
    setAsking(undefined)
    if (ask.kind === 'rule') { run({ cmd: 'resolve', decisionId: item.decisionId, verdict: ask.verdict }); return }
    if (suggestion?.id === ask.suggestionId) adopt()
    else setStaleId(ask.suggestionId)
  }

  const adoptNote = rewriting !== undefined ? t('pending.vertical.adoptNoteRewrite')
    : adopted === undefined ? undefined
    : adopted === vertical.keepBaseline ? t(isPurge(adopted) ? 'pending.vertical.adoptNotePurge' : 'pending.vertical.adoptNoteDelete')
      : t('pending.vertical.adoptNoteKeepBoth')
  const sourced = suggestion?.isSourced === true ? t('pending.vertical.sourced') : undefined
  const note = isRequesting ? undefined : sourced === undefined ? adoptNote : adoptNote === undefined ? sourced : t('conflict.twoSentences', { first: sourced, second: adoptNote })
  // 「都保留」拆成确实不冲突、记成例外（同横向）；只有一条记忆，没有并成版本
  const direct = [
    [vertical.keepBaseline, t('pending.vertical.delete')],
    [vertical.notConflict, t('pending.conflict.notConflict')],
    [vertical.exception, t('pending.conflict.exception')],
  ] as const
  const hasAdopt = adopted !== undefined || rewriting !== undefined

  let row: ReactNode = null
  if (asking !== undefined && isPurge(asking.verdict)) {
    row = (
      <SecretDeleteConfirm
        showTitle={false}
        body={t('pending.vertical.confirmPurge')}
        unavailable={action.unavailable}
        onCancel={() => { setAsking(undefined) }}
        onConfirm={() => { send(asking) }}
      />
    )
  } else if (asking !== undefined) {
    const isDelete = asking.verdict === vertical.keepBaseline
    const isException = asking.verdict === vertical.exception
    row = (
      <div className="pm-conflict-actions">
        <SoftDeleteConfirm
          question={t(isDelete ? 'pending.vertical.confirmDelete' : isException ? 'pending.vertical.confirmException' : 'pending.vertical.confirmNotConflict')}
          confirmLabel={t(isDelete ? 'pending.vertical.confirmDeleteLabel' : isException ? 'pending.conflict.exception' : 'pending.conflict.notConflict')}
          onCancel={() => { setAsking(undefined) }}
          onConfirm={() => { send(asking) }}
        />
      </div>
    )
  } else if (!isRequesting) {
    row = (
      <div className="pm-conflict-actions">
        {hasAdopt
          ? (
            <Button variant="primary" unavailable={reason} onClick={() => { if (adopted !== undefined && isPurge(adopted) && suggestion !== undefined) setAsking({ kind: 'adopt', verdict: adopted, suggestionId: suggestion.id }); else adopt() }}>
              {t('pending.conflict.adopt')}
            </Button>
          )
          : null}
        {hasAdopt && canRequest
          ? null
          : direct.map(([verdict, label]) => (
            <Button key={verdict} unavailable={reason} onClick={() => { setAsking({ kind: 'rule', verdict }) }}>{label}</Button>
          ))}
        {canRequest ? <Button unavailable={reason} onClick={slot.open}>{t('pending.conflict.request')}</Button> : null}
      </div>
    )
  }
  return (
    <>
      {memory !== null
        ? (
          <SuggestionBlock
            decisionId={item.decisionId} left={memory} suggestion={suggestion}
            noSuggestion={item.noSuggestion ?? (isStale ? { code: 'not-generated' } : undefined)} isGenerating={item.isGeneratingSuggestion === true}
            notice={isStale && (item.noSuggestion === undefined || item.noSuggestion.code === 'not-generated') ? t('pending.suggestion.staleVertical') : undefined}
            session={session} onRefused={onRefused}
          />
        )
        : null}
      {note !== undefined ? <AdviceNote label="note">{note}</AdviceNote> : null}
      {isRequesting
        ? (
          <ProposalRequest
            decisionId={item.decisionId} left={memory} session={session}
            unavailable={action.unavailable} isHidden={asking !== undefined} voided={voided}
            discardAsk={slot.isAskingDiscard
              ? <SoftDeleteConfirm question={t('library.edit.discard')} confirmLabel={t('library.edit.discardConfirm')} onCancel={slot.keep} onConfirm={slot.discard} />
              : undefined}
            onClose={slot.close}
            onPick={(verdict) => { setAsking({ kind: 'rule', verdict }) }}
            onApply={(proposal) => { run({ cmd: 'apply-proposal', decisionId: item.decisionId, proposal }) }}
            onRefused={onRefused}
            onDirtyChange={slot.report}
          />
        )
        : null}
      {row}
      {action.feedback}
    </>
  )
}

// —— 提升候选 ——

export function PromoteCard({ item, session, now, typeLabel, onDone, onRefused, promoteTarget }: CardProps<'promote-candidate'> & {
  /** 来自配置 governance.globalPromoteTarget；还没读到为 undefined。 */
  promoteTarget: 'global' | 'agents-md' | undefined
}) {
  const t = useT()
  const action = useCardAction(session, {
    onOk: (_result, command) => {
      if (command.cmd === 'promote') onDone({ kind: 'promoted', target: command.target })
      if (command.cmd === 'keep-local') onDone({ kind: 'kept-local' })
    },
    onHandledElsewhere: onRefused,
  })
  const other = otherProject(item.memory, session)
  const unavailable = action.unavailable ?? (item.memory === null ? t('conflict.missingHint') : undefined)
  const promoteLabel = promoteTarget === 'agents-md' ? t('pending.promote.agentsMd')
    : other !== undefined ? t('pending.promote.globalIn', { name: baseName(other) }) : t('pending.promote.global')
  return (
    <Card marker={<StatusMarker kind="pending" />} title={titleOf(item, t, session)}>
      {item.memory === null
        ? <p className="pm-pending-text">{t('conflict.missing')}</p>
        : <MemoryOf session={session} memory={item.memory} now={now} typeLabel={typeLabel} collapsible />}
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
      {action.feedback}
    </Card>
  )
}

// —— 超出上限 ——

export function OverflowCard({ item, session, onDone, onRefused, budget, onCleanup }: CardProps<'overflow'> & {
  budget: number | undefined
  /** 「整理记忆 ›」：去全部记忆，作用域是这张卡所在的那个。 */
  onCleanup: (scope: Scope) => void
}) {
  const t = useT()
  const gateway = useGateway()
  const action = useCardAction(session, { onOk: () => { onDone({ kind: 'dismissed' }) }, onHandledElsewhere: onRefused })
  // 建议值：下一档的起点向上取整到百，填了就不会在这一档再提醒
  const suggested = budget === undefined ? '' : String(Math.ceil(relaxedCap(budget, item.tier + 1) / 100) * 100)
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
      : t('pending.overflow.relax', { over, cap: formatNumber(relaxedCap(budget, item.tier)), budget: formatNumber(budget) })
    : budget === undefined ? t('pending.overflow.strictNoBudget') : t('pending.overflow.strict', { budget: formatNumber(budget) })
  return (
    <Card
      marker={<StatusMarker kind="pending" />}
      title={t('pending.overflow.title')}
      aside={<DismissButton label={t('pending.dismiss')} unavailable={action.unavailable ?? (saving ? t('pending.busy') : undefined)} onClick={() => { action.run({ cmd: 'dismiss-overflow', decisionId: item.decisionId }) }} />}
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
        <Button
          unavailable={saving ? t('pending.busy')
            : budget === undefined ? t('pending.promote.configLoading')
              : invalid ? t('pending.overflow.invalid', { budget: formatNumber(budget) }) : undefined}
          onClick={save}
        >
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
      {action.feedback}
    </Card>
  )
}

// —— 读不出的文件 ——

export function UnreadableCard({ item, session }: CardProps<'unreadable-file'>) {
  const t = useT()
  const gateway = useGateway()
  const action = useCardAction(session, {})
  const open = (how: 'open' | 'reveal') => {
    void gateway.openPath(item.filePath, how).then((ok) => { if (!ok) action.fail(t('pending.openFailed')) })
  }
  return (
    <Card marker={<StatusMarker kind="pending" />} title={t('pending.unreadable.title')}>
      <p className="pm-pending-path">{item.relativePath}</p>
      <pre className="pm-pending-error-text">{item.error}</pre>
      <AdviceNote>{t('pending.unreadable.body')}</AdviceNote>
      <div className="pm-pending-actions">
        <Button onClick={() => { open('reveal') }}>{t(isMac() ? 'pending.unreadable.revealMac' : 'pending.unreadable.revealOther')}</Button>
        <Button onClick={() => { open('open') }}>{t('pending.unreadable.open')}</Button>
      </div>
      {action.feedback}
    </Card>
  )
}

// —— 建议整理 ——

type AdviceAction = 'confirm' | 'delete' | 'promote' | 'move' | 'open' | 'modify'

/**
 * 每类建议的标题、动手前的说明和动作行（按 spec 表）。按钮顺序即显示顺序：退一步的幽灵按钮「打开文件」排在最左，
 * 推荐的排在最右。「不再提醒」不在动作行，是标题行右上角的叉（IgnoreButton）。
 * 内容重复这里是只有一条（和指令文件重复）的写法，两条以上见 AdviceGroupCard；放错层这里是项目 → 全局，全局那条见 MISPLACED_TO_PROJECT。
 */
const ADVICE_COPY = {
  expired: { title: 'pending.advice.expired.title', body: 'pending.advice.expired.body', actions: ['open', 'delete'] },
  // 很久没确认不给忽略：它的出路是「仍然有效」或删除
  stale: { title: 'pending.advice.stale.title', body: 'pending.advice.stale.body', actions: ['open', 'delete', 'confirm'] },
  bloat: { title: 'pending.advice.bloat.title', body: 'pending.advice.bloat.body', actions: ['open', 'modify'] },
  redundancy: { title: 'pending.advice.redundancy.title', body: 'pending.advice.redundancy.baselineBody', actions: ['open', 'delete'] },
  orphan: { title: 'pending.advice.orphan.title', body: 'pending.advice.orphan.body', actions: ['open'] },
  // 放错层只回答挪不挪：改写不换作用域
  misplaced: { title: 'pending.advice.misplaced.title', body: 'pending.advice.misplaced.toGlobalBody', actions: ['open', 'promote'] },
  unclear: { title: 'pending.advice.unclear.title', body: 'pending.advice.unclear.body', actions: ['open', 'modify'] },
} as const satisfies Record<AdviceType, { title: LocaleKey; body: LocaleKey; actions: readonly AdviceAction[] }>

/** 问题类型的显示名（卡片标题、不再提醒的列表）。 */
export function adviceTitle(type: AdviceType, t: Translate): string {
  return t(ADVICE_COPY[type].title)
}

/** 放错层里全局那条（该放项目）：「移到项目…」在卡片里选项目，和提升为全局对称。 */
const MISPLACED_TO_PROJECT = { body: 'pending.advice.misplaced.toProjectBody', actions: ['open', 'move'] } as const

/**
 * 标题行右上角的叉「不再提醒」：发 ignore-advice，带这一项的类型和全部记忆（内容重复是整组），每条带卡片上那一份的作用域和卡片版本。
 * 很久没确认的不给：它的出路是「仍然有效」或删除。
 */
function IgnoreButton({ item, action }: { item: Item<'advice'>; action: CardAction }) {
  const t = useT()
  if (item.type === 'stale') return null
  const memories = item.memories.map(m => ({ memoryId: m.id, layer: scopeOfMemory(m), base: baseOf(m) }))
  const command: MemoryCommand = { cmd: 'ignore-advice', type: item.type, memories }
  return <DismissButton label={t('pending.dismiss')} unavailable={action.unavailable} onClick={() => { action.run(command) }} />
}

export { baseOf, draftOf, isEditable }

/** 能让模型改的建议类型（服务端按它给默认要求）。 */
const isModelEditType = (type: AdviceType): type is ModelEditAdviceType => (MODEL_EDIT_ADVICE_TYPES as readonly AdviceType[]).includes(type)

/** 单条修改写入：按点「修改」那一刻的版本核对。 */
const editCommandOf = (memory: MemoryCardData, draft: EditDraft): MemoryCommand =>
  ({ cmd: 'edit-memory', memoryId: memory.id, layer: scopeOfMemory(memory), base: baseOf(memory), ...draft })

/** 改前字数：单条是那一条，合并是两条相加。 */
function charsBefore(memories: readonly MemoryCardData[], command: EditCommand): number {
  const ids = command.cmd === 'edit-memory' ? [command.memoryId] : command.memories.map(m => m.memoryId)
  return memories.filter(m => ids.includes(m.id)).reduce((n, m) => n + m.content.length, 0)
}

/**
 * 建议整理卡：不着色、不带状态标记。删除先原位确认「删除这条？ 删除 · 取消」，再走 forget（进最近删除），含密钥时原位改问彻底删除；
 * 提升为全局按记忆 id 发 promote-memory，结果和提升候选一样可撤销；移到项目在卡片里选好项目再发 move-memory，同样可撤销。
 * 「修改」在卡片里展开两段切换的面板（edit-modes.tsx）：手动改换出编辑框，保存发 edit-memory，同样可撤销；
 * 让模型改展开生成与对照，应用同样发 edit-memory。借来的会话拿不到模型时，面板里写原因、「生成修改」置灰。
 */
export function AdviceCard(props: CardProps<'advice'> & {
  /** 「移到项目…」列出的已知项目，按显示顺序。 */
  projects: readonly string[]
  /** 「移到项目…」默认选中的项目（当前页面的项目）。 */
  defaultProject: string | undefined
}) {
  const { item, session, now, typeLabel, onDone, onRefused, projects, defaultProject } = props
  const t = useT()
  const gateway = useGateway()
  /** 三条以上合并的应用回 stale、not-found 时交回工作区的那几条（同记忆查看的整理所选）。 */
  const onBehind = useRef<((memoryIds: readonly string[]) => void) | undefined>(undefined)
  const action = useCardAction(session, { onHandledElsewhere: onRefused, onFailed: (failure) => {
    const ids = failure.memoryIds
    if (onBehind.current === undefined || (failure.code !== 'stale' && failure.code !== 'not-found') || ids === undefined || ids.length === 0) return false
    onBehind.current(ids)
    return true
  }, onOk: (result, command) => {
    if (command.cmd === 'apply-edits') {
      // 只应用了一部分时只算仍是这次写下的
      const recorded = new Set(result.memoryIds ?? command.ops.map(op => op.memoryId))
      const done = command.ops.filter(op => recorded.has(op.memoryId))
      onDone({ kind: 'tidied', decisionId: result.decisionId, rewrites: done.filter(op => op.kind === 'edit').length, deletes: done.filter(op => op.kind === 'forget').length })
    }
    if (command.cmd === 'confirm') onDone({ kind: 'confirmed' })
    if (command.cmd === 'forget') onDone({ kind: 'deleted', memoryId: command.memoryId, scope: command.layer })
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
  } })
  // 点「修改」那一刻的那条记忆：之后视图刷新了（别处改过）也按它预填、按它的版本核对，免得用户照旧版改的稿子冲掉别处的改动
  const [modifying, setModifying] = useState<MemoryCardData>()
  const [isMoving, setMoving] = useState(false)
  const buttonsOf = (memory: MemoryCardData, deleteLabel = t('pending.advice.delete')): Record<AdviceAction, ReactNode> => {
    const scope = scopeOfMemory(memory)
    const open = () => { void gateway.openPath(memory.filePath, 'open').then((ok) => { if (!ok) action.fail(t('pending.openFailed')) }) }
    return {
      confirm: <Button key="confirm" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'confirm', memoryId: memory.id, layer: scope }) }}>{t('pending.advice.confirm')}</Button>,
      delete: (
        <DeleteWithConfirm
          key="delete"
          onDelete={() => { action.run({ cmd: 'forget', memoryId: memory.id, layer: scope }) }}
          trigger={open => <Button unavailable={action.unavailable} onClick={open}>{deleteLabel}</Button>}
        />
      ),
      promote: <Button key="promote" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'promote-memory', memoryId: memory.id, layer: scope }) }}>{t('pending.promote.global')}</Button>,
      move: <Button key="move" unavailable={action.unavailable} onClick={() => { setMoving(true) }}>{t('pending.move.move')}</Button>,
      open: <Button key="open" variant="ghost" onClick={open}>{t('pending.advice.open')}</Button>,
      modify: isEditable(memory)
        ? <Button key="modify" unavailable={action.unavailable} onClick={() => { setModifying(memory) }}>{t('pending.modify')}</Button>
        : null,
    }
  }
  if (item.type === 'redundancy' && item.memories.length > 1) {
    return (
      <AdviceGroupCard
        {...props}
        action={action}
        buttonsOf={buttonsOf}
        onApplyMany={(application, behind) => {
          onBehind.current = behind
          const { ops, keep } = application
          action.run({ cmd: 'apply-edits', ops, ...(keep.length > 0 ? { keep } : {}) })
        }}
      />
    )
  }
  const [memory] = item.memories
  const copy = item.type === 'misplaced' && memory.scope === 'global' ? { ...ADVICE_COPY.misplaced, ...MISPLACED_TO_PROJECT } : ADVICE_COPY[item.type]
  const buttons = buttonsOf(memory)
  const modelType = isModelEditType(item.type) ? item.type : undefined
  return (
    <Card title={t(copy.title)} aside={item.type === 'stale' || isMoving || modifying !== undefined ? undefined : <IgnoreButton item={item} action={action} />}>
      {isMoving
        ? (
          <>
            <div className="pm-pending-advice-memories"><MemoryOf session={session} memory={memory} now={now} typeLabel={typeLabel} /></div>
            <MovePanel
              projects={projects}
              initial={defaultProject}
              unavailable={action.unavailable}
              onCancel={() => { setMoving(false) }}
              onMove={(workspacePath) => { action.run({ cmd: 'move-memory', memoryId: memory.id, workspacePath }) }}
            />
          </>
        )
        : modifying !== undefined && modelType !== undefined
          ? (
            <EditModes
              onClose={() => { setModifying(undefined) }}
              model={report => (
                <>
                  <div className="pm-pending-advice-memories"><MemoryOf session={session} memory={modifying} now={now} typeLabel={typeLabel} /></div>
                  <ModelEditPanel
                    memories={[modifying]}
                    adviceType={modelType}
                    typeTitle={t(copy.title)}
                    base={draftOf(modifying)}
                    session={session}
                    unavailable={action.unavailable}
                    onClose={() => { setModifying(undefined) }}
                    onApply={(draft) => { action.run(editCommandOf(modifying, draft)) }}
                    onStateChange={report}
                  />
                </>
              )}
              manual={report => (
                <EditPanel
                  initial={draftOf(modifying)}
                  original={{ content: modifying.content, summary: modifying.summary, chars: modifying.content.length }}
                  isMerge={false}
                  unavailable={action.unavailable}
                  onCancel={() => { setModifying(undefined) }}
                  onSave={(draft) => { action.run(editCommandOf(modifying, draft)) }}
                  onStateChange={report}
                />
              )}
            />
          )
          : (
            <>
              <div className="pm-pending-advice-memories">{item.memories.map(m => <MemoryOf key={m.id} session={session} memory={m} now={now} typeLabel={typeLabel} />)}</div>
              <AdviceNote>{t(copy.body, { date: formatDay(memory.lastConfirmedAt, now, t) })}</AdviceNote>
              <div className="pm-pending-actions">{copy.actions.map(a => buttons[a])}</div>
            </>
          )}
      {action.feedback}
    </Card>
  )
}

/** 手动合并的预填：保留的那条（mergeKeeperIndex）正文在前、空行接另一条，名称和摘要取保留那条，标签取并集。 */
type Pair = readonly [MemoryCardData, MemoryCardData]

function mergeDraft(pair: Pair): { draft: EditDraft; chars: number } {
  const kept = pair[mergeKeeperIndex(pair)]
  const other = pair[1 - mergeKeeperIndex(pair)]!
  return {
    draft: { content: `${kept.content}\n\n${other.content}`, name: kept.name, summary: kept.summary, tags: [...new Set([...kept.tags, ...other.tags])] },
    chars: kept.content.length + other.content.length,
  }
}

/**
 * 三条以上内容重复时能交给「合并」的那几条：同整理所选的限制（同一作用域、不超过 MAX_BATCH_EDIT 条，按整组算），
 * 含密钥、读不到版本的不发给模型；剩下不到两条为 undefined。
 */
function mergeManyOf(memories: readonly MemoryCardData[]): MemoryCardData[] | undefined {
  const [first, ...rest] = memories.map(scopeOfMemory)
  if (memories.length > MAX_BATCH_EDIT || first === undefined || !rest.every(s => s !== undefined && sameScope(s, first))) return undefined
  const editable = memories.filter(isEditable)
  return editable.length >= 2 ? editable : undefined
}

/**
 * 互相重复的几条记忆一张卡：每条各自一栏，带自己的删除和打开文件。两条时左右并排，写「删除左边 / 删除右边」，
 * 两条都能改时再给「合并」（两段切换：让模型合并 | 手动合并）：合成保留的那条，另一条进最近删除。
 * 三条以上能合并时（mergeManyOf）「合并」在卡片里展开整理所选的三步（写要求 / 看计划 / 对照应用），要求预填「合成一条，各自独有的信息都留下」，
 * 应用发 apply-edits，结果卡写改写、删除几条，撤销同整理所选的撤销全部。
 */
function AdviceGroupCard({ item, session, now, typeLabel, action, buttonsOf, onApplyMany }: CardProps<'advice'> & {
  action: CardAction
  buttonsOf: (memory: MemoryCardData, deleteLabel?: string) => Record<AdviceAction, ReactNode>
  onApplyMany: (application: BatchApplication, onBehind: (memoryIds: readonly string[]) => void) => void
}) {
  const t = useT()
  const isPair = item.memories.length === 2
  const pair = isPair && item.memories.every(isEditable) ? [item.memories[0]!, item.memories[1]!] as const : undefined
  const many = isPair ? undefined : mergeManyOf(item.memories)
  // 点「合并」那一刻能合并的几条：之后视图刷新了也按它们的版本核对（同整理所选的卡片快照）
  const [mergingMany, setMergingMany] = useState<readonly MemoryCardData[]>()
  // 点「合并」那一刻的两条：之后视图刷新了也按它们预填、按它们的版本核对（同单条的修改）
  const [merging, setMerging] = useState<Pair>()
  if (mergingMany !== undefined) {
    return (
      <Card title={t('pending.advice.redundancy.title')}>
        <MergeMany
          memories={mergingMany}
          latest={item.memories}
          session={session}
          onBack={() => { setMergingMany(undefined) }}
          onApply={onApplyMany}
          applyUnavailable={action.unavailable}
          applyFeedback={action.feedback}
        />
      </Card>
    )
  }
  const merge = merging === undefined ? undefined : mergeDraft(merging)
  const mergeWith = (both: Pair, draft: EditDraft) => {
    const memories = both.map(m => ({ memoryId: m.id, layer: scopeOfMemory(m), base: baseOf(m) }))
    action.run({ cmd: 'merge-memories', memories: [memories[0]!, memories[1]!], ...draft })
  }
  const sides = [
    { label: 'pending.advice.redundancy.left', delete: 'pending.advice.redundancy.deleteLeft' },
    { label: 'pending.advice.redundancy.right', delete: 'pending.advice.redundancy.deleteRight' },
  ] as const
  return (
    <Card title={t('pending.advice.redundancy.title')} aside={merging !== undefined ? undefined : <IgnoreButton item={item} action={action} />}>
      <div className="pm-pending-advice-memories pm-pending-advice-group">
        {item.memories.map((m, i) => {
          const side = isPair ? sides[i] : undefined
          const buttons = buttonsOf(m, side === undefined ? undefined : t(side.delete))
          return (
            <section key={m.id} className="pm-pending-advice-side" aria-label={side === undefined ? m.name : t(side.label)}>
              <MemoryOf session={session} memory={m} now={now} typeLabel={typeLabel} />
              {merging !== undefined ? null : <div className="pm-pending-actions">{buttons.open}{buttons.delete}</div>}
            </section>
          )
        })}
      </div>
      {merging !== undefined && merge !== undefined
        ? (
          <EditModes
            isMerge
            onClose={() => { setMerging(undefined) }}
            model={report => (
              <ModelEditPanel
                memories={merging}
                adviceType="redundancy"
                typeTitle={t('pending.advice.redundancy.title')}
                base={merge.draft}
                keeper={mergeKeeperIndex(merging)}
                session={session}
                unavailable={action.unavailable}
                onClose={() => { setMerging(undefined) }}
                onApply={(draft) => { mergeWith(merging, draft) }}
                onStateChange={report}
              />
            )}
            manual={report => (
              <EditPanel
                initial={merge.draft}
                original={{ content: merge.draft.content, summary: merge.draft.summary, chars: merge.chars }}
                isMerge
                unavailable={action.unavailable}
                onCancel={() => { setMerging(undefined) }}
                onSave={(draft) => { mergeWith(merging, draft) }}
                onStateChange={report}
              />
            )}
          />
        )
          : (
            <>
              <AdviceNote>
                {t(isPair ? 'pending.advice.redundancy.body' : many !== undefined ? 'pending.advice.redundancy.manyBody' : 'pending.advice.redundancy.manyBodyNoMerge')}
              </AdviceNote>
              {pair !== undefined || many !== undefined
                ? (
                  <div className="pm-pending-actions">
                    <Button unavailable={action.unavailable} onClick={() => { if (pair !== undefined) setMerging(pair); else setMergingMany(many) }}>{t('pending.merge')}</Button>
                  </div>
                )
                : null}
            </>
          )}
      {action.feedback}
    </Card>
  )
}

/** 三条以上的「合并」：整理所选的工作区放进卡片，要求预填；收起时焦点回到「合并」。 */
function MergeMany({ memories, latest, session, onBack, onApply, applyUnavailable, applyFeedback }: {
  memories: readonly MemoryCardData[]
  latest: readonly MemoryCardData[]
  session: BorrowedSession
  onBack: () => void
  onApply: (application: BatchApplication, onBehind: (memoryIds: readonly string[]) => void) => void
  applyUnavailable: string | undefined
  applyFeedback: ReactNode
}) {
  const t = useT()
  const root = useRef<HTMLDivElement>(null)
  useReturnFocus(root)
  const [items] = useState(() => toBatchItems(memories))
  return (
    <div ref={root}>
      <BatchEdit
        items={items}
        latest={latest}
        session={session}
        initialRequest={t('pending.mergeMany.request')}
        titleOf={n => t('pending.mergeMany.title', { n })}
        backLabel={t('pending.mergeMany.back')}
        onBack={onBack}
        onApply={(application, _picked, behind) => { onApply(application, behind) }}
        applyUnavailable={applyUnavailable}
        applyFeedback={applyFeedback}
      />
    </div>
  )
}

// —— 结果卡：刚处理完留在原位，能撤销的带「撤销」 ——

/** memories：结果卡上显示的记忆，内容重复的一组忽略后整组都显示。 */
interface ResultCopy { memory?: MemoryCardData | null; memories?: readonly MemoryCardData[]; chip: string; body: string; undoable: boolean }

/** 结果卡的来由：按模型建议、按你的要求、你直接选的。 */
const byKeyOf = (source: ProposalSource | undefined): LocaleKey => (source === 'suggestion' ? 'pending.result.bySuggestion' : source === 'request' ? 'pending.result.byRequest' : 'pending.result.byChoice')

function resultCopy(item: PendingItem, outcome: Outcome, t: Translate): ResultCopy {
  if (outcome.kind === 'resolved' && item.kind === 'conflict-horizontal') {
    // 来由（按模型建议 / 你直接选的）在前，去向在后
    const by = (second: string) => t('conflict.twoSentences', { first: t(byKeyOf(outcome.source)), second })
    // 结果里用名称指代两条：卡片换成结果后只剩留下的那条，被删的那条已不在眼前
    const deleted = (name: string) => by(outcome.isHardDeleted ? t('conflict.purgedSide', { name }) : t('pending.result.deletedName', { name }))
    const [a, b] = [nameOf(item.left, 'A'), nameOf(item.right, 'B')]
    if (outcome.verdict === 'as-versions') {
      const versions = versionsOf(item.left, item.right, outcome.current)
      return { memory: versions?.current, chip: t('pending.result.asVersions'), body: by(versions === undefined ? t('pending.versions.hint') : t('pending.result.asVersionsBody', versions.names)), undoable: true }
    }
    if (outcome.verdict === 'not-conflict' || outcome.verdict === 'exception') return keptPairCopy(outcome, by, t, 'pending.result.keptPairBody')
    if (outcome.verdict === 'keep-left') return { memory: item.left, chip: t('pending.result.kept', { name: a }), body: deleted(b), undoable: outcome.isHardDeleted !== true }
    if (outcome.verdict === 'keep-right') return { memory: item.right, chip: t('pending.result.kept', { name: b }), body: deleted(a), undoable: outcome.isHardDeleted !== true }
    if (outcome.isUnrecorded) return { chip: t('pending.result.keptBoth'), body: by(t('pending.result.unrecordedBody')), undoable: false }
    return { chip: t('pending.result.keptBoth'), body: by(t('pending.result.keptBothBody')), undoable: true }
  }
  if (outcome.kind === 'resolved' && item.kind === 'conflict-vertical') {
    // 采纳建议、按要求应用的，来由在前（同横向）；直接选的照旧只写去向
    const by = (second: string) => (outcome.source === undefined ? second : t('conflict.twoSentences', { first: t(byKeyOf(outcome.source)), second }))
    if (outcome.verdict === CONFLICT_ACTION_VERDICTS.vertical.keepBaseline) {
      return outcome.isHardDeleted
        ? { chip: t('pending.result.followedBaseline'), body: by(t('conflict.purgedMemory')), undoable: false }
        : { chip: t('pending.result.followedBaseline'), body: by(t('pending.result.followedBaselineBody')), undoable: true }
    }
    if (outcome.verdict === 'not-conflict' || outcome.verdict === 'exception') return keptPairCopy(outcome, by, t, 'pending.result.keptWithBaselineBody')
    return { memory: item.memory, chip: t('pending.result.keptMemory'), body: by(t(outcome.isUnrecorded ? 'pending.result.unrecordedBody' : 'pending.result.keptMemoryBody')), undoable: outcome.isUnrecorded !== true }
  }
  const finding = findingResultCopy(item, outcome, t)
  if (finding !== undefined) return finding
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
    case 'deleted': {
      // 写明删的是哪一条：内容重复的一对删了一边，标题看不出是哪条
      const name = item.kind === 'advice' ? item.memories.find(m => m.id === outcome.memoryId)?.name : undefined
      return { chip: t('pending.result.deleted'), body: name === undefined ? t('pending.result.deletedBody') : t('pending.result.deletedNamedBody', { name }), undoable: true }
    }
    case 'ignored': {
      const ignored = item.kind === 'advice' && item.memories.length > 1 ? { memories: item.memories } : { memory }
      return { ...ignored, chip: t('pending.result.ignored'), body: t('pending.result.ignoredBody'), undoable: true }
    }
    case 'tidied':
      return {
        chip: t('pending.result.merged'), undoable: outcome.decisionId !== undefined,
        body: outcome.deletes > 0 ? t('pending.result.tidiedBody', { rewrites: outcome.rewrites, deletes: outcome.deletes }) : t('pending.result.tidiedBodyNoDelete', { rewrites: outcome.rewrites }),
      }
    case 'plan-merged':
      // 只完成了一部分：按实际留下的改动写；不是最常见的两种时不猜哪条成了，请用户看列表。
      // 保留方停在融合稿的，磁盘上已是融合后的名称，用它；其余用融合前的
      if (outcome.partial !== undefined) {
        const key = outcome.partial === 'kept' ? 'pending.result.mergePartialKept' : outcome.partial === 'changed' ? 'pending.result.mergePartialChanged'
          : outcome.decisionId !== undefined ? 'pending.result.mergePartialOtherUndoable' : 'pending.result.mergePartialOther'
        const keep = outcome.partial === 'kept' ? outcome.keeper.name : outcome.keep
        return { chip: t('pending.result.partial'), body: t(key, { keep, drop: outcome.drop }), undoable: outcome.decisionId !== undefined }
      }
      return {
        memory: outcome.keeper, chip: t('pending.result.mergedOne'), undoable: true,
        body: t('conflict.twoSentences', { first: t(byKeyOf(outcome.source)), second: t('pending.result.deletedName', { name: outcome.drop }) }),
      }
    case 'plan-rewritten':
      // 没有做完：不猜改写停在哪一版，请用户看列表；有可撤销的那一笔才给撤销
      if (outcome.isPartial === true) {
        return { chip: t('pending.result.partial'), body: t(outcome.decisionId !== undefined ? 'pending.result.rewritePartialUndoable' : 'pending.result.rewritePartial'), undoable: outcome.decisionId !== undefined }
      }
      return {
        memory: outcome.memory, chip: t('pending.result.rewritten'), undoable: true,
        body: t('conflict.twoSentences', { first: t(byKeyOf(outcome.source)), second: t('pending.result.rewrittenBody') }),
      }
    case 'resolved': throw new Error(`resolved outcome on ${item.kind}`)
    case 'edited': case 'merged': throw new Error(`${outcome.kind} outcome renders as EditedRow`)
  }
}

/** 冲突裁成确实不冲突、记成例外：两边都留（kept 是横向的两条、垂直的记忆和指令文件那句）；结论没记下时不给撤销。 */
function keptPairCopy(outcome: Extract<Outcome, { kind: 'resolved' }>, by: (second: string) => string, t: Translate, kept: LocaleKey): ResultCopy {
  const chip = t(outcome.verdict === 'not-conflict' ? 'pending.result.notConflict' : 'pending.result.exception')
  return outcome.isUnrecorded
    ? { chip, body: by(t('pending.result.unrecordedBody')), undoable: false }
    : { chip, body: by(t(kept)), undoable: true }
}

/** 并成版本留作当前的那条和另一条（名称）；current 不在这一对里、或有一条已经读不到时为 undefined。 */
function versionsOf(left: MemoryCardData | null, right: MemoryCardData | null, current: string | undefined) {
  const kept = [left, right].find(m => m !== null && m.id === current) ?? undefined
  const old = kept === left ? right : left
  return kept === undefined || old === null ? undefined : { current: kept, names: { current: kept.name, old: old.name } }
}

/** 体检的四种新发现处理后的结果；不是这四种时为 undefined。 */
function findingResultCopy(item: PendingItem, outcome: Outcome, t: Translate): ResultCopy | undefined {
  const dismissed = (chip: string): ResultCopy => ({ chip, body: t('pending.finding.dismissedBody'), undoable: true })
  if (outcome.kind === 'resolved') {
    switch (item.kind) {
      case 'missed-change':
        if (outcome.verdict === 'as-versions') {
          const versions = versionsOf(item.left, item.right, outcome.current)
          return { memory: versions?.current, chip: t('pending.result.asVersions'), body: versions === undefined ? t('pending.versions.hint') : t('pending.result.asVersionsBody', versions.names), undoable: true }
        }
        if (outcome.verdict === 'not-conflict') return { chip: t('pending.result.notConflict'), body: t('pending.result.keptPairBody'), undoable: true }
        return dismissed(t('pending.result.ignored'))
      case 'exception': return item.baselineRef !== undefined
        ? { chip: t('pending.result.ignored'), body: t('pending.finding.dismissedBodyBaseline'), undoable: true }
        : dismissed(t('pending.result.ignored'))
      case 'cross-duplicate': return dismissed(t('pending.crossDup.keep'))
      case 'premise-changed': return { memory: item.decision, chip: t('pending.result.reviewed'), body: t('pending.result.reviewedBody'), undoable: true }
      default: return undefined
    }
  }
  if (outcome.kind === 'promoted' && item.kind === 'cross-duplicate') {
    return { memory: item.memories.find(m => m?.id === outcome.memoryId), chip: t('pending.result.promoted'), body: t('pending.result.promotedBody'), undoable: true }
  }
  return undefined
}

export function ResultCard({ item, outcome, session, now, typeLabel, onUndone, onRefused }: {
  item: PendingItem
  outcome: Outcome
  session: BorrowedSession
  now: number
  typeLabel: (type: string) => string
  onUndone: () => void
  onRefused: () => void
}) {
  const t = useT()
  const action = useCardAction(session, { onOk: () => { onUndone() }, onHandledElsewhere: onRefused })
  if (outcome.kind === 'edited' || outcome.kind === 'merged') return <EditedRow item={item} outcome={outcome} action={action} />
  const copy = resultCopy(item, outcome, t)
  // 融合只完成一部分时可撤的是另记的那一笔，不是冲突条目；跨项目重复按记忆提升时撤的是提升那一笔
  const undoId = outcome.kind === 'plan-merged' || outcome.kind === 'plan-rewritten' ? outcome.decisionId
    : outcome.kind === 'promoted' && outcome.decisionId !== undefined ? outcome.decisionId
      : 'decisionId' in item ? item.decisionId : outcome.kind === 'moved' || outcome.kind === 'tidied' ? outcome.decisionId : undefined
  // 忽略不进账本，撤销就是取消忽略；删除进了最近删除，撤销就是恢复那一份；其余撤销按账本条目
  const undo: MemoryCommand | undefined = !copy.undoable ? undefined
    : outcome.kind === 'ignored' ? { cmd: 'unignore-advice', type: outcome.type, memoryIds: outcome.memoryIds }
    : outcome.kind === 'deleted' ? { cmd: 'restore', memoryId: outcome.memoryId, layer: outcome.scope }
    : undoId !== undefined ? { cmd: 'undo', decisionId: undoId } : undefined
  return (
    <Card marker={item.level === 'advice' ? undefined : <StatusMarker kind="done" />} title={titleOf(item, t, session)} focusable isResult>
      {copy.memory ? <MemoryOf session={session} memory={copy.memory} now={now} typeLabel={typeLabel} collapsible /> : null}
      {copy.memories !== undefined
        ? <div className="pm-pending-advice-group">{copy.memories.map(m => <MemoryOf key={m.id} session={session} memory={m} now={now} typeLabel={typeLabel} collapsible />)}</div>
        : null}
      <ResultLine
        chip={copy.chip}
        undo={undo !== undefined
          ? (
            <Button variant="ghost" unavailable={action.unavailable} onClick={() => { action.run(undo) }}>
              {t('pending.undo')}
            </Button>
          )
          : undefined}
      >
        {copy.body}
      </ResultLine>
      {action.feedback}
    </Card>
  )
}

/** 修改、合并的结果收成一行：结果 · 名称 · 字数变化，带撤销和打开文件（打开的是写完后的那个文件）。 */
function EditedRow({ item, outcome, action }: {
  item: PendingItem
  outcome: Extract<Outcome, { kind: 'edited' | 'merged' }>
  action: CardAction
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
            <Button variant="ghost" unavailable={action.unavailable} onClick={() => { action.run({ cmd: 'undo', decisionId: undoId }) }}>
              {t('pending.undo')}
            </Button>
          )
          : null}
        {filePath !== undefined ? <Button onClick={open}>{t('pending.advice.open')}</Button> : null}
      </div>
      {action.feedback}
    </article>
  )
}

/**
 * 「记忆查看」「最近删除」共用的几件小东西：视图没就绪时的一行说明、带参数打开时的目标行高亮、
 * 行尾动作（经命令往返模块）的结果提示与行内反馈、类型显示名。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MemoryCard, MemoryCommand } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import { useNavTarget, type NavStore, type NavTarget } from '../nav.ts'
import { CommandFeedback } from '../command/confirm.tsx'
import type { Ok } from '../command/protocol.ts'
import { useCommandRunner, type RunHandlers } from '../command/useCommandRunner.ts'
import { Icon } from '../ui/Icon.tsx'
import { prefersReducedMotion } from '../ui/motion.tsx'
import { typeLabel } from '../type-label.ts'

type LabelledView = ViewState<{ typeLabels?: Readonly<Record<string, string>> }>

/**
 * 几份视图的 typeLabels 合成一张表（注册表的 label，含切模板前的旧类型）。全部记忆、最近删除、待处理各自带
 * 本视图出现的类型，同一类型的显示名出自同一注册表，谁先谁后无所谓；没就绪的视图跳过。
 */
export function mergeTypeLabels(...views: readonly LabelledView[]): Record<string, string> {
  return Object.assign({}, ...views.map(v => v.status === 'ready' ? v.data.typeLabels ?? {} : {}))
}

/** hook：类型 id → 显示名（取法见 typeLabel）；视图里的名字取自全部记忆 / 最近删除 / 待处理里已就绪的那几份。 */
export function useTypeLabel(session: BorrowedSession): (type: string) => string {
  const gateway = useGateway()
  const t = useT()
  const library = gateway.useView(session, 'library')
  const deleted = gateway.useView(session, 'deleted')
  const pending = gateway.useView(session, 'pending')
  const customTypes = gateway.useConfig()?.customTypes
  const viewLabels = useMemo(() => mergeTypeLabels(library, deleted, pending), [library, deleted, pending])
  return useCallback((type: string) => typeLabel(t, type, { viewLabels, customTypes }), [t, viewLabels, customTypes])
}

/** 搜索框（记忆查看、最近删除顶部）：按名称、摘要、正文和标签筛，不分大小写。 */
export function SearchBox({ label, placeholder, value, onChange }: {
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="pm-search">
      <Icon name="search" size={14} />
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(event) => { onChange(event.target.value) }} />
    </label>
  )
}

export function matchesQuery(memory: MemoryCard, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [memory.name, memory.summary, memory.content, ...memory.tags].some(text => text.toLowerCase().includes(q))
}

/**
 * 视图还没就绪时的一行说明（role=status），各面板共用。idle（没有会话）写什么由调用方给：null 不画（由页面壳的空态负责）。
 * 视图已就绪时不画。
 */
export function ViewMessage({ state, idle, className = 'pm-tab-message' }: { state: ViewState<unknown>; idle: string | null; className?: string }) {
  const t = useT()
  if (state.status === 'ready' || (state.status === 'idle' && idle === null)) return null
  const text = state.status === 'error' ? t('view.error', { message: state.message }) : state.status === 'idle' ? idle : t(`view.${state.status}`)
  return <p className={className} role="status">{text}</p>
}

/**
 * 导航目标带 memoryId 且这一行在列表里时，高亮它一次并滚入视野。按目标对象认「一次」：
 * 视图刷新不重播，入口再导航一次（新目标）会重播。
 * revealId 是正在高亮或马上要高亮的那一条：所在的组据此在同一次渲染里展开，高亮开始时那一行已经在 DOM 里。
 * targetId 是导航目标那一条（在列表里时）：高亮播完它仍可接焦点，焦点不会因为去掉 tabindex 掉到页面上。
 * 高亮中途那一条不在列表里了（被搜索滤掉）：高亮就此收起，免得行回来时重播、抢走焦点。
 */
export function useFlashTarget(nav: NavStore, ids: readonly string[]): { flashId: string | undefined; revealId: string | undefined; targetId: string | undefined; clear: () => void } {
  const target = useNavTarget(nav)
  const present = target.memoryId !== undefined && ids.includes(target.memoryId)
  const handled = useRef<NavTarget | undefined>(undefined)
  const [flashId, setFlashId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!present || handled.current === target) return
    handled.current = target
    setFlashId(target.memoryId)
  }, [target, present])
  const isGone = flashId !== undefined && !ids.includes(flashId)
  useEffect(() => { if (isGone) setFlashId(undefined) }, [isGone])
  const upcoming = present && handled.current !== target ? target.memoryId : undefined
  return { flashId, revealId: flashId ?? upcoming, targetId: present ? target.memoryId : undefined, clear: () => { setFlashId(undefined) } }
}

/** 高亮动画时长：播完收起高亮类，下次导航到同一条才能重播。 */
export const FLASH_MS = 1800

/**
 * 高亮行：开始高亮时滚入视野，FLASH_MS 后回调收起。列表行是 li，待处理的卡是 div。
 * takesFocus：高亮时这一行接住焦点（状态条结果行的链接跳过来的）；系统减弱动态效果时不闪，改成焦点描边。
 * 描边跟着焦点走、不跟闪烁计时：这一行拿着焦点就在，焦点离开才去掉（闪完就消失的描边等于没给）。
 */
export function FlashRow({ flashing, onFlashEnd, className, children, as: Tag = 'li', takesFocus = false }: {
  flashing: boolean
  onFlashEnd: () => void
  className: string
  children: ReactNode
  as?: 'li' | 'div'
  takesFocus?: boolean
}) {
  const ref = useRef<HTMLLIElement & HTMLDivElement>(null)
  const end = useRef(onFlashEnd)
  end.current = onFlashEnd
  const [isRinged, setRinged] = useState(false)
  useEffect(() => {
    if (!flashing) return
    ref.current?.scrollIntoView?.({ block: 'center' })
    if (takesFocus) {
      ref.current?.focus({ preventScroll: true })
      if (prefersReducedMotion()) setRinged(true)
    }
    const timer = setTimeout(() => { end.current() }, FLASH_MS)
    return () => { clearTimeout(timer) }
  }, [flashing])
  const highlight = isRinged ? 'pm-flash-ring' : flashing ? 'pm-flash' : undefined
  return (
    <Tag
      ref={ref}
      className={highlight === undefined ? className : `${className} ${highlight}`}
      tabIndex={takesFocus ? -1 : undefined}
      onBlur={isRinged ? (event) => { if (event.target === event.currentTarget) setRinged(false) } : undefined}
    >
      {children}
    </Tag>
  )
}

/**
 * 列表上方的一行提示。purged：彻底删除了（含密钥的记忆，或最近删除里的一条），最近删除里没有它，提示里不带去那儿的链接；
 * elsewhere：这一条正在别处处理或刚处理完，这次什么都没动（那一行可能随之消失，所以提示不放在行里）。
 */
export type Notice = { kind: 'ok'; text: string } | { kind: 'purged'; text: string } | { kind: 'elsewhere'; text: string } | { kind: 'error'; text: string }

/** 成功后的提示；null = 不提示，结果由调用方原位画（onOk）。 */
type OkText = ((result: { decisionId?: string }) => string) | null

/**
 * 行尾动作：经命令往返模块按记忆 id 发命令，成功后的提示放在列表上方。跨项目确认、彻底删除确认（删除含密钥的记忆时
 * 服务端回 has-secret）和失败画在那一行（feedback），那一行已不在列表里时失败挪到列表上方（strayFailures）；
 * 别处已处理的提示放在列表上方。
 */
export function useRowActions(session: BorrowedSession) {
  const t = useT()
  const gateway = useGateway()
  const runner = useCommandRunner(session)
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  /** 发过命令的记忆 id：找那一行已不在列表里的失败用。 */
  const ran = useRef(new Set<string>())
  /** onFailed：同 RunHandlers，调用方就地处理的失败（记忆查看修改时的 stale）不再画在行里。 */
  const run = (memoryId: string, command: MemoryCommand, okText: OkText, onOk?: (result: Ok) => void, onFailed?: RunHandlers['onFailed']) => {
    setNotice(undefined)
    ran.current.add(memoryId)
    runner.run(memoryId, command, {
      onOk(result, sent) {
        // forget 回 has-secret 后改发的彻底删除：这一行不留结果，提示不可恢复
        if (sent.cmd !== command.cmd) { setNotice({ kind: 'purged', text: t('pending.secret.deletedNotice') }); return }
        onOk?.(result)
        setNotice(okText === null ? undefined : sent.cmd === 'hard-delete' ? { kind: 'purged', text: okText(result) } : { kind: 'ok', text: okText(result) })
      },
      onHandledElsewhere() { setNotice({ kind: 'elsewhere', text: t('command.handledElsewhere') }) },
      ...(onFailed !== undefined ? { onFailed } : {}),
    })
  }
  return {
    notice,
    /** 按钮的 unavailable：没有会话、这条正在处理或等确认时给原因。 */
    unavailable: runner.unavailable,
    run,
    /** 这一条的命令发出了、结果还没回来。 */
    isBusy(id: string): boolean { return runner.stateOf(id).kind === 'busy' },
    /** 这一行的确认与失败；没有时为 null。 */
    feedback(memoryId: string): ReactNode { return <CommandFeedback runner={runner} id={memoryId} /> },
    /** 失败的那一条已不在列表里（别处删掉、恢复了）：失败提示放在列表上方，不跟着那一行消失。shown：此刻列表里的记忆 id。 */
    strayFailures(shown: readonly string[]): ReactNode {
      const ids = new Set(shown)
      return [...ran.current].filter(id => !ids.has(id) && runner.stateOf(id).kind === 'failed')
        .map(id => <CommandFeedback key={id} runner={runner} id={id} />)
    },
    async open(path: string, action?: 'reveal') {
      if (!(await gateway.openPath(path, action))) setNotice({ kind: 'error', text: t('action.openFailed') })
    },
  }
}

export const sharedTabCss = `
.pm-search {
  display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 12px; border-radius: 12px;
  border: .5px solid var(--pm-line-input); color: var(--pm-text-2); background: transparent;
}
.pm-search input {
  flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent;
  font: inherit; font-size: 13px; color: var(--pm-text);
}
.pm-search input::placeholder { color: var(--pm-text-3); }
.pm-search:focus-within { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 0; }
.pm-tab-message { margin: 24px 0; text-align: center; font-size: 12px; color: var(--pm-text-2); }
.pm-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; container-type: inline-size; }
.pm-list-row {
  position: relative; display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 12px 12px 16px; border-radius: 10px;
}
.pm-list-row + .pm-list-row::after {
  content: ''; position: absolute; left: 16px; right: 12px; top: 0; border-top: .5px solid var(--pm-line);
}
.pm-list-row > .pm-mc { flex: 1; }
.pm-row-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.pm-row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex-shrink: 0; }
.pm-row-actions .pm-btn:not(.pm-btn--icon) { padding: 2px 10px; font-size: 12px; }
@container (max-width: 500px) {
  .pm-list-row { flex-direction: column; align-items: stretch; gap: 8px; }
}
.pm-flash { animation: pm-flash ${FLASH_MS}ms ease-out both; }
.pm-flash::before {
  content: ''; position: absolute; left: 4px; top: 9px; bottom: 9px; width: 2px; border-radius: 2px;
  background: var(--pm-accent); animation: pm-flash-bar ${FLASH_MS}ms ease-out both;
}
@keyframes pm-flash { 0%, 60% { background: var(--pm-accent-tint); } 100% { background: transparent; } }
@keyframes pm-flash-bar { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
.pm-root .pm-flash-ring { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 2px; }
`

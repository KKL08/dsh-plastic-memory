/**
 * 「全部记忆」「最近删除」共用的几件小东西：视图没就绪时的一行说明、带参数打开时的目标行高亮、
 * 行尾动作的进行中 / 结果提示与跨项目确认、类型显示名。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { MemoryCommand } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type ViewState } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import { useNavTarget, type NavStore, type NavTarget } from '../nav.ts'
import { CrossConfirm, crossConfirmCss, SecretDeleteConfirm } from '../pending/action.tsx'
import { keepFocusInPlace } from '../ui/focus-return.ts'

type LabelledView = ViewState<{ typeLabels?: Readonly<Record<string, string>> }>

/**
 * 几份视图的 typeLabels 合成一张表（注册表的 label，含切模板前的旧类型）。全部记忆、最近删除、待处理各自带
 * 本视图出现的类型，同一类型的显示名出自同一注册表，谁先谁后无所谓；没就绪的视图跳过。
 */
export function mergeTypeLabels(...views: readonly LabelledView[]): Record<string, string> {
  return Object.assign({}, ...views.map(v => v.status === 'ready' ? v.data.typeLabels ?? {} : {}))
}

/** hook：类型 id → 显示名，取自全部记忆 / 最近删除 / 待处理里已就绪的那几份；视图都没到、或认不出的类型显示 id。 */
export function useTypeLabel(session: BorrowedSession): (type: string) => string {
  const gateway = useGateway()
  const library = gateway.useView(session, 'library')
  const deleted = gateway.useView(session, 'deleted')
  const pending = gateway.useView(session, 'pending')
  const labels = useMemo(() => mergeTypeLabels(library, deleted, pending), [library, deleted, pending])
  return useCallback((type: string) => labels[type] ?? type, [labels])
}

/** 视图不是 ready 时的一行说明；idle（没有会话）由页面壳的空态负责，这里不画。 */
export function ViewMessage({ state }: { state: Exclude<ViewState<unknown>, { status: 'ready' }> }) {
  const t = useT()
  if (state.status === 'idle') return null
  const text = state.status === 'error' ? t('view.error', { message: state.message }) : t(`view.${state.status}`)
  return <p className="pm-tab-message">{text}</p>
}

/**
 * 导航目标带 memoryId 且这一行在列表里时，高亮它一次并滚入视野。按目标对象认「一次」：
 * 视图刷新不重播，入口再导航一次（新目标）会重播。
 */
export function useFlashTarget(nav: NavStore, ids: readonly string[]): { flashId: string | undefined; clear: () => void } {
  const target = useNavTarget(nav)
  const present = target.memoryId !== undefined && ids.includes(target.memoryId)
  const handled = useRef<NavTarget | undefined>(undefined)
  const [flashId, setFlashId] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!present || handled.current === target) return
    handled.current = target
    setFlashId(target.memoryId)
  }, [target, present])
  return { flashId, clear: () => { setFlashId(undefined) } }
}

/** 高亮动画时长：播完收起高亮类，下次导航到同一条才能重播。 */
export const FLASH_MS = 1800

/** 高亮行：开始高亮时滚入视野，FLASH_MS 后回调收起。列表行是 li，待处理的卡是 div。 */
export function FlashRow({ flashing, onFlashEnd, className, children, as: Tag = 'li' }: {
  flashing: boolean
  onFlashEnd: () => void
  className: string
  children: ReactNode
  as?: 'li' | 'div'
}) {
  const ref = useRef<HTMLLIElement & HTMLDivElement>(null)
  const end = useRef(onFlashEnd)
  end.current = onFlashEnd
  useEffect(() => {
    if (!flashing) return
    ref.current?.scrollIntoView?.({ block: 'center' })
    const timer = setTimeout(() => { end.current() }, FLASH_MS)
    return () => { clearTimeout(timer) }
  }, [flashing])
  return (
    <Tag ref={ref} className={flashing ? `${className} pm-flash` : className}>
      {children}
    </Tag>
  )
}

/** purged：含密钥的记忆已彻底删除，不进最近删除，提示里不带去那儿的链接。 */
export type Notice = { kind: 'ok'; text: string; memoryId: string } | { kind: 'purged'; text: string } | { kind: 'error'; text: string }

type OkText = (result: { decisionId?: string }) => string

/** 等跨项目确认的那一行：服务端拒了（什么都没动），用户点「继续处理」才带 allowCrossWorkspace 重发。 */
interface CrossPending { memoryId: string; workspacePath: string; command: MemoryCommand; okText: OkText }

/**
 * 行尾动作：进行中的记忆 id 和最近一次结果。命令失败显示宿主或执行器的原话。
 * 涉及其他项目时和待处理卡同一套流程：先不带 allowCrossWorkspace 发，服务端回 cross-workspace 就在那一行确认。
 * 删除含密钥的记忆时服务端回 has-secret（什么都没动），同样在那一行确认，用户点「彻底删除」才发 hard-delete。
 */
export function useRowActions(session: BorrowedSession) {
  const t = useT()
  const gateway = useGateway()
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<Notice | undefined>(undefined)
  const [cross, setCross] = useState<CrossPending | undefined>(undefined)
  /** forget 回了 has-secret 的那条命令：彻底删除沿用它指明的那一份，跨项目确认过的也不再问。 */
  const [secret, setSecret] = useState<Extract<MemoryCommand, { cmd: 'forget' }> | undefined>(undefined)
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  const mark = (id: string, on: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const run = async (memoryId: string, command: MemoryCommand, okText: OkText) => {
    if (sessionId === undefined) return
    keepFocusInPlace()
    mark(memoryId, true)
    const result = await gateway.execute(sessionId, command)
    mark(memoryId, false)
    const workspacePath = result.ok ? undefined : result.rejected?.[0]?.workspacePath
    const isAllowed = 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
    if (!result.ok && result.code === 'cross-workspace' && !isAllowed && workspacePath !== undefined) {
      setNotice(undefined)
      setCross({ memoryId, workspacePath, command, okText })
      return
    }
    if (!result.ok && result.code === 'has-secret' && command.cmd === 'forget') {
      setNotice(undefined)
      setSecret(command)
      return
    }
    setNotice(result.ok
      ? command.cmd === 'hard-delete' ? { kind: 'purged', text: okText(result) } : { kind: 'ok', text: okText(result), memoryId }
      : { kind: 'error', text: t('action.failed', { detail: result.detail ?? result.code }) })
  }
  return {
    notice,
    /** 按钮的 unavailable：没有会话、这条正在处理或等跨项目 / 彻底删除确认时给原因。 */
    unavailable(id: string, needsSession = true): string | undefined {
      if (needsSession && sessionId === undefined) return t('session.none.hint')
      return busy.has(id) || cross?.memoryId === id || secret?.memoryId === id ? t('action.busy') : undefined
    },
    run,
    /** 这一行的跨项目确认；不在等确认时为 null。 */
    crossConfirm(memoryId: string): ReactNode {
      if (cross?.memoryId !== memoryId) return null
      return (
        <CrossConfirm
          workspacePath={cross.workspacePath}
          onCancel={() => { setCross(undefined) }}
          onConfirm={() => {
            setCross(undefined)
            void run(cross.memoryId, { ...cross.command, allowCrossWorkspace: true } as MemoryCommand, cross.okText)
          }}
        />
      )
    },
    /** 这一行的彻底删除确认（forget 回了 has-secret）；不在等确认时为 null。 */
    secretConfirm(memoryId: string): ReactNode {
      if (secret?.memoryId !== memoryId) return null
      return (
        <SecretDeleteConfirm
          onCancel={() => { setSecret(undefined) }}
          onConfirm={() => {
            setSecret(undefined)
            void run(memoryId, { ...secret, cmd: 'hard-delete' }, () => t('pending.secret.deletedNotice'))
          }}
        />
      )
    },
    async open(path: string, action?: 'reveal') {
      if (!(await gateway.openPath(path, action))) setNotice({ kind: 'error', text: t('action.openFailed') })
    },
  }
}

export const sharedTabCss = crossConfirmCss + `
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
.pm-row-actions .pm-btn { padding: 2px 10px; font-size: 12px; }
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
`

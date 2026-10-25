/**
 * 输入框下方的「记忆」按钮（PRD 5.9 方案 A）：只有图标，不变色、不加点；这个会话没有记忆（会话视图不存在，
 * 或带入与新记都为空）时不渲染。点开的弹层对齐宿主 ContextMeter 弹层的版式：标题行占比 + 约已用 / 上限、
 * 三段作用域条与明细、带入与新记条数、超限行、「查看带入的记忆 ›」。
 *
 * 已用 = 会话视图三段（本项目、全局、固定说明）之和，和用量条同一口径；占比 = 已用 / 宿主 contextPressure 投影的
 * contextWindow（宿主公式的分母）；读不到窗口只写「约已用 / 上限」。超限行按计入上限的 usedTokens（服务端是否放宽按它定）。
 * 记忆 token 是插件估算，和宿主计数口径不同，所以一律带「约」。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { SessionView } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import type { ContextPressureProjection, SessionStandardProps } from '../host.ts'
import { formatNumber, useT } from '../i18n.tsx'
import { MemoryIcon } from '../MemoryIcon.tsx'
import { barScale, relaxedCap } from '../ui/ContextBudgetBar.tsx'

/** 分割占比句子用的标记，和宿主 ContextMeter 的 READING_SLOT 同法。 */
const READING_SLOT = '\u0000'
const PANEL_WIDTH = 264
const EDGE = 12

/** 记忆占上下文的读数；没有上下文窗口时为 null。不到 1% 写「<1%」，避免把有记忆写成 0%。 */
export function memoryShare(used: number, pressure: ContextPressureProjection | undefined): string | null {
  const window = pressure?.contextWindow
  if (window === undefined || window <= 0) return null
  const ratio = (used / window) * 100
  if (ratio > 0 && ratio < 1) return '<1%'
  return `${Math.min(100, Math.round(ratio))}%`
}

export function hasSessionMemory(view: SessionView | undefined): view is SessionView {
  return view !== undefined && (view.injectedIds.length > 0 || view.savedIds.length > 0)
}

export interface MemoryButtonProps extends Pick<SessionStandardProps, 'sessionId' | 'useProjection'> {
  /** 打开右侧栏记忆 tab；缺省（宿主没有右侧栏）时不画「查看带入的记忆 ›」。 */
  onOpenTab: (() => void) | undefined
  onHandle: () => void
}

export function MemoryButton({ sessionId, useProjection, onOpenTab, onHandle }: MemoryButtonProps) {
  const t = useT()
  const gateway = useGateway()
  const session = useMemo<BorrowedSession>(() => ({ kind: 'ready', sessionId, cwd: undefined }), [sessionId])
  const state = gateway.useView(session, 'session')
  const pressure = useProjection('contextPressure')
  const view = state.status === 'ready' ? state.data : undefined
  const visible = hasSessionMemory(view)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const open = position !== null && visible
  const close = () => { setPosition(null) }

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setPosition(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 焦点在弹层里时收起后还给按钮，不让它掉到 body
      const isInside = panelRef.current?.contains(document.activeElement) ?? false
      setPosition(null)
      if (isInside) triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!visible) return null

  const toggle = () => {
    if (open) { close(); return }
    const rect = rootRef.current!.getBoundingClientRect()
    const width = Math.min(PANEL_WIDTH, window.innerWidth - EDGE * 2)
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, EDGE), window.innerWidth - width - EDGE)
    setPosition({ left, bottom: window.innerHeight - rect.top + 8, width })
  }

  const { workspace, global, fixed } = view.tokens
  const used = workspace + global + fixed
  const share = memoryShare(used, pressure)
  const [headBefore = '', headAfter = ''] = t('composer.share', { percent: READING_SLOT }).split(READING_SLOT).map(s => s.trim())
  const scale = barScale(used, view.usedTokens, view.budget)
  const rows = [
    { key: 'workspace', label: t('composer.workspace'), n: workspace },
    { key: 'global', label: t('composer.global'), n: global },
    { key: 'fixed', label: t('composer.fixed'), n: fixed },
  ] as const
  const overflow = view.overflowMode === 'strict'
    ? (view.omittedCount > 0 ? t('composer.truncated', { n: formatNumber(view.omittedCount) }) : null)
    : (view.usedTokens > view.budget
      ? t('composer.relaxed', {
        over: formatNumber(view.usedTokens - view.budget),
        cap: formatNumber(relaxedCap(view.usedTokens, view.budget)),
      })
      : null)

  return (
    <span ref={rootRef} className="pm-composer">
      <button
        ref={triggerRef}
        type="button"
        className="pm-composer-trigger"
        aria-label={t('composer.button')}
        title={t('composer.button')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
      >
        <MemoryIcon size={14} />
      </button>
      {open && createPortal(
        <div ref={panelRef} className="pm-root pm-composer-panel" style={position!} role="dialog" aria-label={t('composer.dialog')}>
          <div className="pm-composer-header">
            {share === null ? null : (
              <>
                <span className="pm-composer-headline">{headBefore}</span>
                <span className="pm-composer-percent">{share}</span>
                <span className="pm-composer-headline">{headAfter}</span>
              </>
            )}
            <span className="pm-composer-figures">
              {t('composer.figures', { used: formatNumber(used), budget: formatNumber(view.budget) })}
            </span>
          </div>
          <div className="pm-composer-bar">
            {rows.filter(row => row.n > 0).map(row => (
              <i key={row.key} className={`pm-composer-seg pm-composer-tint--${row.key}`} style={{ width: `${(row.n / scale) * 100}%` }} />
            ))}
          </div>
          <dl className="pm-composer-rows">
            {rows.map(row => (
              <div key={row.key} className="pm-composer-row">
                <dt><i className={`pm-composer-swatch pm-composer-tint--${row.key}`} aria-hidden="true" />{row.label}</dt>
                <dd>{t('composer.approx', { n: formatNumber(row.n) })}</dd>
              </div>
            ))}
          </dl>
          <div className="pm-composer-line">
            {t('composer.counts', { injected: formatNumber(view.injectedIds.length), saved: formatNumber(view.savedIds.length) })}
          </div>
          {overflow === null ? null : (
            <div className="pm-composer-line">
              {overflow}
              <i className="pm-sep" aria-hidden="true">·</i>
              <button type="button" className="pm-link" onClick={() => { close(); onHandle() }}>{t('composer.handle')}</button>
            </div>
          )}
          {onOpenTab === undefined ? null : (
            <button type="button" className="pm-link pm-composer-open" onClick={() => { close(); onOpenTab() }}>
              {t('composer.viewInjected')}
            </button>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** 按钮对齐宿主 ContextMeter 的 trigger；弹层对齐它的 panel（菜单面：宿主菜单底色、prominent 投影）。 */
export const memoryButtonCss = `
.pm-composer-root { display: contents; }
.pm-composer { display: inline-flex; flex: none; }
.pm-composer-trigger {
  display: inline-flex; align-items: center; flex: none; padding: 1px 8px; border: none;
  border-radius: var(--dsw-radius-sm); background: transparent; color: var(--pm-text-3);
  /* 宿主 trigger 靠 20px 行高的读数撑到 22px；这里只有图标，直接给同样的高度，和用量按钮对齐 */
  height: calc(22px + var(--dsh-content-font-delta-secondary, 0px));
  cursor: pointer;
}
.pm-composer-trigger:hover, .pm-composer-trigger[aria-expanded='true'] { background: var(--pm-hover); color: var(--pm-text-2); }
.pm-composer-panel {
  position: fixed; z-index: 1100; padding: 12px; border-radius: var(--dsw-radius-lg);
  background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px; line-height: 20px; color: var(--pm-text-2); cursor: default;
}
.pm-composer-header { display: flex; align-items: center; gap: 6px; }
.pm-composer-headline { color: var(--pm-text-3); }
.pm-composer-headline:empty { display: none; }
.pm-composer-percent { font-weight: 500; color: var(--pm-text); }
.pm-composer-figures { margin-left: auto; font-weight: 500; font-variant-numeric: tabular-nums; color: var(--pm-text); }
.pm-composer-bar { display: flex; gap: 1px; margin: 10px 0 12px; height: 4px; border-radius: 999px; background: var(--pm-track); overflow: hidden; }
.pm-composer-seg { flex: none; min-width: 2px; height: 100%; border-radius: 1px; background: var(--pm-composer-tint); }
.pm-composer-swatch { display: inline-block; margin-right: 6px; width: 8px; height: 8px; border-radius: 2px; background: var(--pm-composer-tint); }
.pm-composer-tint--workspace { --pm-composer-tint: var(--pm-accent); }
.pm-composer-tint--global { --pm-composer-tint: var(--pm-accent-soft); }
.pm-composer-tint--fixed { --pm-composer-tint: var(--pm-caption); }
.pm-composer-rows { margin: 6px 0 0; }
.pm-composer-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 2px 0; }
.pm-composer-row dt { color: var(--pm-text-2); }
.pm-composer-row dd { margin: 0; font-variant-numeric: tabular-nums; color: var(--pm-text); }
.pm-composer-line { margin-top: 6px; }
.pm-composer-open { display: block; margin-top: 8px; }
`

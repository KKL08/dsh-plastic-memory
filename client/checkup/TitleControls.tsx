/**
 * 记忆页标题行右边的两个控件，都作用于左栏选中的范围（DESIGN.md Buttons「立即体检」「自动体检按钮」、Auto Checkup Menu）：
 * - 「自动体检 ⌄」写实际生效的频率，点开菜单改。「全部」的值是默认值；全局和项目的第一项是「跟随全部（当前值）」，
 *   选具体值就是单独设置（和默认值相同也算）。「全部」的菜单列出单独设置了的范围，每行能「改回跟随」，点了这一行消失、菜单不关。
 *   改了就发 set-auto-checkup；按钮和菜单只按体检视图显示，命令成功后服务端重写体检视图，各窗口读到同一份。
 * - 「立即体检」查这个范围，进行中显示「体检中…」并禁用（来源见 runs.ts），悬停写会查谁、记忆越多 token 越多。
 *   范围里还没有活跃记忆时不发命令，在按钮处弹出一句说明（弹层的关法和焦点回位同自动体检菜单）；按钮不置灰。
 * 体检在配置文件里关闭时，两个控件换成一行「体检已在配置文件里关闭」。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type FocusEvent, type MouseEvent } from 'react'
import {
  AUTO_CHECKUP_FOLLOW, AUTO_CHECKUP_MAX_DAYS, resolveAutoCheckup, scopeKey, SCOPE_KEYS,
  type AutoCheckupFrequency, type CheckupView, type GuiLayerRef,
} from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { baseName, formatNumber, useT, type Translate } from '../i18n.tsx'
import { scopeName, type PageScope } from '../nav.ts'
import { parsePositiveInt } from '../settings/config.ts'
import { Button } from '../ui/Button.tsx'
import type { CheckupRuns } from './runs.ts'

/** 「每 N 天」输入框起始的天数（当前不是每 N 天时）。 */
const DEFAULT_DAYS = 7
/** 菜单宽度与离视口左缘的最小距离：右对齐会伸出左缘时（窄窗口里控件折到第二行）改成左对齐。 */
const MENU_WIDTH = 272
const EDGE = 8
/** 「立即体检」说明弹层的宽度：右对齐伸出视口左缘时同样改左对齐。 */
const NOTE_WIDTH = 240

export function TitleControls({ scope, session, runs, checkups, isGovernanceEnabled, projectCount, isEmpty }: {
  scope: PageScope
  session: BorrowedSession
  runs: CheckupRuns
  /** 体检视图；还没读到时不画「自动体检」。 */
  checkups: CheckupView | undefined
  /** 配置文件里的 `governance.enabled`（读视图里的）。 */
  isGovernanceEnabled: boolean
  /** 「全部」体检会查几个项目（有活跃记忆的；标题行「N 个项目和全局」还算只剩最近删除的，可能更多）。 */
  projectCount: number
  /** 范围里没有活跃记忆（记忆查看的数据读到了、条数为 0）：点「立即体检」只弹说明。 */
  isEmpty: boolean
}) {
  const t = useT()
  if (!isGovernanceEnabled) return <p className="pm-head-off">{t('settings.governanceOff')}</p>
  return (
    <>
      {/* 换范围时收起菜单、清掉没生效的草稿 */}
      {checkups !== undefined ? <AutoCheckup key={scopeKey(scope)} scope={scope} session={session} view={checkups} /> : null}
      {/* 换范围时收起说明弹层 */}
      <RunCheckup key={`run:${scopeKey(scope)}`} scope={scope} runs={runs} projectCount={projectCount} isEmpty={isEmpty} />
    </>
  )
}

function busyHint(scope: PageScope, t: Translate): string {
  return scope.kind === 'all' ? t('checkup.run.busy.all')
    : scope.kind === 'global' ? t('checkup.run.busy.global')
      : t('checkup.run.busy.workspace', { name: baseName(scope.workspacePath) })
}

function RunCheckup({ scope, runs, projectCount, isEmpty }: { scope: PageScope; runs: CheckupRuns; projectCount: number; isEmpty: boolean }) {
  const t = useT()
  const noteId = useId()
  const [isNoteOpen, setNoteOpen] = useState(false)
  const [isStartAligned, setStartAligned] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const note = useRef<HTMLDivElement>(null)
  const busy = runs.busyScope(scope)
  const hint = scope.kind === 'all' ? t(projectCount === 1 ? 'checkup.run.hint.all.one' : 'checkup.run.hint.all', { n: formatNumber(projectCount) })
    : scope.kind === 'global' ? t('checkup.run.hint.global')
      : t('checkup.run.hint.workspace', { name: baseName(scope.workspacePath) })
  const button = () => root.current?.querySelector<HTMLButtonElement>('.pm-run') ?? null
  const close = (focusButton: boolean) => {
    setNoteOpen(false)
    if (focusButton) button()?.focus()
  }

  // 打开时焦点落进弹层，Esc 才关得掉
  useLayoutEffect(() => {
    if (isNoteOpen) note.current?.focus()
  }, [isNoteOpen])
  useEffect(() => {
    if (!isNoteOpen) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', onPointer, true)
    return () => { document.removeEventListener('pointerdown', onPointer, true) }
  }, [isNoteOpen])

  const onClick = () => {
    if (!isEmpty) { runs.run(scope); return }
    if (isNoteOpen) { close(false); return }
    setStartAligned((button()?.getBoundingClientRect().right ?? Infinity) - NOTE_WIDTH < EDGE)
    setNoteOpen(true)
  }
  const onNoteBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (next !== null && !root.current?.contains(next)) close(false)
  }
  const text = scope.kind === 'all' ? t('checkup.run.empty.all') : scope.kind === 'global' ? t('checkup.run.empty.global') : t('checkup.run.empty.workspace')
  return (
    <div ref={root} className="pm-run-wrap">
      <Button
        className={busy === undefined ? 'pm-run' : 'pm-run pm-run--busy'}
        title={hint}
        unavailable={busy === undefined ? undefined : busyHint(busy, t)}
        aria-haspopup={isEmpty ? 'dialog' : undefined}
        aria-expanded={isEmpty ? isNoteOpen : undefined}
        aria-controls={isNoteOpen ? noteId : undefined}
        onClick={onClick}
      >
        {busy === undefined
          ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
            </svg>
          )
          : <span className="pm-run-spinner" aria-hidden="true" />}
        {busy === undefined ? t('checkup.run') : t('checkup.running')}
      </Button>
      {isNoteOpen
        ? (
          <div
            ref={note}
            id={noteId}
            role="dialog"
            aria-labelledby={`${noteId}-text`}
            tabIndex={-1}
            className={isStartAligned ? 'pm-run-note pm-run-note--start' : 'pm-run-note'}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(true) } }}
            onBlur={onNoteBlur}
          >
            <p id={`${noteId}-text`} className="pm-run-note-text">{text}</p>
          </div>
        )
        : null}
    </div>
  )
}

/** 频率的叫法：仅手动 / 每天 / 每 N 天。 */
export function frequencyText(frequency: AutoCheckupFrequency, t: Translate): string {
  return frequency === 'manual' ? t('checkup.auto.manual') : frequency === 1 ? t('checkup.auto.daily') : t('checkup.auto.days', { n: formatNumber(frequency) })
}

/** 「每 N 天」的输入：只收 1–90 的整数；不合法为 undefined。 */
function parseDays(text: string): number | undefined {
  const n = parsePositiveInt(text)
  return n !== undefined && n <= AUTO_CHECKUP_MAX_DAYS ? n : undefined
}

type Choice = AutoCheckupFrequency | typeof AUTO_CHECKUP_FOLLOW

function AutoCheckup({ scope, session, view }: { scope: PageScope; session: BorrowedSession; view: CheckupView }) {
  const t = useT()
  const gateway = useGateway()
  const menuId = useId()
  const [isOpen, setOpen] = useState(false)
  const [isStartAligned, setStartAligned] = useState(false)
  const [draft, setDraft] = useState('')
  const [isDirty, setDirty] = useState(false)
  /** 刚点了「改回跟随」的范围键：视图跟上之前先藏起来，命令失败再放回。 */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  /** 最近一次 set-auto-checkup 没成功：按钮旁写一句，下一次成功或关菜单后收起。 */
  const [isFailed, setFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  /** 菜单开着：收起之后迟到的失焦、点击不再生效（免得同一个草稿发两次）。 */
  const isOpenNow = useRef(false)

  // 继承解析和服务端共用契约里的纯函数：视图里没有的新项目也按跟随算
  const settings = new Map<string, AutoCheckupFrequency>([[SCOPE_KEYS.all, view.defaultFrequency]])
  for (const s of view.scopes) if (s.isOwn) settings.set(scopeKey(s.scope), s.frequency)
  const { frequency, isOwn } = resolveAutoCheckup(settings, scope)
  const isAll = scope.kind === 'all'
  const isExplicit = isAll || isOwn
  const owned = isAll ? view.scopes.filter(s => s.isOwn && !hidden.has(scopeKey(s.scope))) : []
  const days = parseDays(draft)

  // 视图里已经不是单独设置了的，不用再藏
  useEffect(() => {
    setHidden(prev => prev.size === 0 ? prev : new Set([...prev].filter(key => view.scopes.some(s => s.isOwn && scopeKey(s.scope) === key))))
  }, [view])

  const title = isAll ? t('checkup.auto.title.all') : scope.kind === 'global' ? t('checkup.auto.title.global')
    : t('checkup.auto.title.workspace', { name: baseName(scope.workspacePath) })
  const value = frequencyText(frequency, t)
  const aria = t(isAll ? 'checkup.auto.aria' : isOwn ? 'checkup.auto.aria.own' : 'checkup.auto.aria.follow', { title, value })

  const items = () => [...menu.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? []]
  const close = (focusTrigger: boolean) => {
    isOpenNow.current = false
    setOpen(false)
    setFailed(false)
    if (focusTrigger) trigger.current?.focus()
  }
  const send = (target: PageScope, choice: Choice) => {
    if (session.kind !== 'ready') return Promise.resolve(false)
    return gateway.execute(session.sessionId, { cmd: 'set-auto-checkup', scope: target, frequency: choice }).then((r) => {
      setFailed(!r.ok)
      return r.ok
    })
  }
  const choose = (choice: Choice) => {
    close(true)
    void send(scope, choice)
  }
  /** 点菜单外、焦点离开菜单：改过的合法天数生效（失焦生效），其余照原样收起。 */
  const dismiss = () => {
    if (!isOpenNow.current) return
    if (isDirty && days !== undefined) void send(scope, days)
    close(false)
  }

  // 打开时焦点落在选中项（每 N 天落在输入框）
  useLayoutEffect(() => {
    if (!isOpen) return
    const list = items()
    ;(list.find(el => el.dataset.checked === 'true') ?? list[0])?.focus()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) dismiss() }
    document.addEventListener('pointerdown', onPointer, true)
    return () => { document.removeEventListener('pointerdown', onPointer, true) }
  })

  const toggle = () => {
    if (isOpen) { dismiss(); return }
    setDraft(typeof frequency === 'number' && frequency > 1 ? String(frequency) : String(DEFAULT_DAYS))
    setDirty(false)
    setStartAligned((trigger.current?.getBoundingClientRect().right ?? Infinity) - MENU_WIDTH < EDGE)
    isOpenNow.current = true
    setOpen(true)
  }
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
      return
    }
    // 菜单项上的回车、空格：当场选中（不等按钮的原生激活，空格要到松开才触发）
    const active = event.target
    if ((event.key === 'Enter' || event.key === ' ') && active instanceof HTMLButtonElement && menu.current?.contains(active)) {
      event.preventDefault()
      active.click()
      return
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const list = items()
    const at = list.indexOf(event.target as HTMLElement)
    // 焦点在菜单本身（点了菜单里的空白处）：下键到第一项，上键到最后一项
    const next = at === -1 ? (step === 1 ? 0 : list.length - 1) : (at + step + list.length) % list.length
    list[next]?.focus()
  }
  const onMenuBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null
    if (next !== null && (menu.current?.contains(next) || next === trigger.current)) return
    dismiss()
  }
  const unfollow = (target: GuiLayerRef, event: MouseEvent<HTMLButtonElement>) => {
    const key = scopeKey(target)
    // 这一行要消失：焦点先挪到下一行，没有就上一项
    const list = items()
    const at = list.indexOf(event.currentTarget)
    ;(list[at + 1] ?? list[at - 1])?.focus()
    setHidden(prev => new Set(prev).add(key))
    void send(target, AUTO_CHECKUP_FOLLOW).then((ok) => {
      if (!ok) setHidden((prev) => { const next = new Set(prev); next.delete(key); return next })
    })
  }

  const option = (choice: Exclude<Choice, number> | 1, name: string, hint: string, isChecked: boolean) => (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={isChecked}
      aria-label={name}
      aria-describedby={`${menuId}-${String(choice)}`}
      tabIndex={-1}
      data-menu-item=""
      data-checked={isChecked}
      className="pm-auto-option"
      onClick={() => { choose(choice) }}
    >
      <Check isChecked={isChecked} />
      <span className="pm-auto-option-name">{name}</span>
      <span id={`${menuId}-${String(choice)}`} className="pm-auto-option-hint">{hint}</span>
    </button>
  )
  const isDaysChecked = isExplicit && typeof frequency === 'number' && frequency > 1
  const isDraftInvalid = days === undefined
  const daysHintId = `${menuId}-days`
  const foot = isAll ? t(owned.length > 0 ? 'checkup.auto.foot.allOwn' : 'checkup.auto.foot.all')
    : scope.kind === 'global' ? t('checkup.auto.foot.global') : t('checkup.auto.foot.workspace', { name: baseName(scope.workspacePath) })

  return (
    <div ref={root} className="pm-auto">
      {isFailed ? <p className="pm-auto-failed" role="status">{t('checkup.auto.saveFailed')}</p> : null}
      <button
        ref={trigger}
        type="button"
        className="pm-auto-trigger"
        aria-label={aria}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onClick={toggle}
      >
        <span className="pm-auto-label">{t('checkup.auto')}</span>
        <span className="pm-auto-value">{value}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
        </svg>
      </button>
      {isOpen
        ? (
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={`${menuId}-title`}
            tabIndex={-1}
            className={isStartAligned ? 'pm-auto-menu pm-auto-menu--start' : 'pm-auto-menu'}
            onKeyDown={onMenuKey}
            onBlur={onMenuBlur}
          >
            <p id={`${menuId}-title`} className="pm-auto-menu-title">{title}</p>
            {isAll ? null : option(AUTO_CHECKUP_FOLLOW, t('checkup.auto.follow', { value: frequencyText(view.defaultFrequency, t) }), t('checkup.auto.follow.hint'), !isOwn)}
            {option('manual', t('checkup.auto.manual'), t('checkup.auto.manual.hint'), isExplicit && frequency === 'manual')}
            {option(1, t('checkup.auto.daily'), t('checkup.auto.daily.hint'), isExplicit && frequency === 1)}
            <div
              role="menuitemradio"
              aria-checked={isDaysChecked}
              aria-label={t('checkup.auto.days', { n: days === undefined ? 'N' : formatNumber(days) })}
              className="pm-auto-option"
              onClick={(event) => { if (event.target !== event.currentTarget.querySelector('input') && days !== undefined) choose(days) }}
            >
              <Check isChecked={isDaysChecked} />
              <span className="pm-auto-option-name">
                {t('checkup.auto.days.before')}
                <input
                  type="text"
                  inputMode="numeric"
                  className="pm-auto-days"
                  value={draft}
                  tabIndex={-1}
                  data-menu-item=""
                  data-checked={isDaysChecked}
                  // 外层的 menuitemradio 收不到焦点，选中状态并进输入框的名称里，焦点在这里也念得出
                  aria-label={t(isDaysChecked ? 'checkup.auto.days.input.checked' : 'checkup.auto.days.input')}
                  aria-describedby={daysHintId}
                  {...(isDraftInvalid ? { 'aria-invalid': true } : {})}
                  onChange={(event) => { setDraft(event.target.value); setDirty(true) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    if (days !== undefined) choose(days)
                  }}
                />
                {t('checkup.auto.days.after')}
              </span>
              <span id={daysHintId} className={isDraftInvalid ? 'pm-auto-option-hint pm-auto-option-hint--invalid' : 'pm-auto-option-hint'} role={isDraftInvalid ? 'status' : undefined}>
                {isDraftInvalid ? t('checkup.auto.days.invalid') : t('checkup.auto.days.hint')}
              </span>
            </div>
            {owned.length > 0
              ? (
                <ul role="group" aria-labelledby={`${menuId}-own`} className="pm-auto-own">
                  <li role="none" id={`${menuId}-own`} className="pm-auto-own-title">{t('checkup.auto.own.title')}</li>
                  {owned.map((s) => {
                    const name = scopeName(s.scope, t)
                    return (
                      <li role="none" key={scopeKey(s.scope)} className="pm-auto-own-row">
                        <span className="pm-auto-own-label">{t('checkup.auto.own.row', { name, value: frequencyText(s.frequency, t) })}</span>
                        <button
                          type="button"
                          role="menuitem"
                          tabIndex={-1}
                          data-menu-item=""
                          className="pm-link pm-auto-own-back"
                          aria-label={t('checkup.auto.own.backAria', { name })}
                          onClick={(event) => { unfollow(s.scope, event) }}
                        >
                          {t('checkup.auto.own.back')}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )
              : null}
            <p className="pm-auto-menu-foot">{t('checkup.auto.foot', { scope: foot, model: t('checkup.auto.foot.model') })}</p>
          </div>
        )
        : null}
    </div>
  )
}

function Check({ isChecked }: { isChecked: boolean }) {
  return (
    <span className="pm-auto-check" aria-hidden="true">
      {isChecked
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        : null}
    </span>
  )
}

export const titleControlsCss = `
.pm-head-off { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-btn.pm-run {
  height: 30px; gap: 6px; padding: 0 12px; border: 0; border-radius: 12px;
  background: var(--pm-hover); font-weight: 600; color: var(--pm-text);
}
.pm-btn.pm-run:hover:not([aria-disabled='true']), .pm-btn.pm-run:active:not([aria-disabled='true']) { background: var(--pm-pressed); }
.pm-btn.pm-run--busy, .pm-btn.pm-run--busy[aria-disabled='true'] { opacity: 1; font-weight: 400; color: var(--pm-text-2); }
.pm-run-spinner {
  width: 12px; height: 12px; border-radius: 999px; border: 1.5px solid currentColor; border-right-color: transparent;
  animation: pm-run-spin .8s linear infinite;
}
@keyframes pm-run-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .pm-run-spinner { animation-duration: 2.4s; } }
.pm-run-wrap { position: relative; display: inline-flex; }
.pm-run-note {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 20; width: 240px; box-sizing: border-box; padding: 10px 12px; border-radius: 14px;
  background: var(--pm-bg-raised); box-shadow: var(--dsw-elevation-panel); outline: none; text-align: left;
}
.pm-run-note--start { right: auto; left: 0; }
.pm-run-note-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-auto { position: relative; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 4px 8px; min-width: 0; }
.pm-auto-failed { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-auto-trigger {
  display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 8px 0 10px; border: 0; border-radius: 12px;
  background: transparent; font: inherit; font-size: 13px; line-height: 1.5; white-space: nowrap; color: var(--pm-text-2); cursor: pointer;
}
.pm-auto-trigger:hover, .pm-auto-trigger[aria-expanded='true'] { background: var(--pm-hover); }
.pm-auto-value { color: var(--pm-text); }
.pm-auto-menu {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 20; width: 272px; padding: 6px; border-radius: 14px;
  background: var(--pm-bg-raised); box-shadow: var(--dsw-elevation-panel); outline: none;
  display: flex; flex-direction: column; text-align: left;
}
.pm-auto-menu--start { right: auto; left: 0; }
.pm-auto-menu-title { margin: 0; padding: 6px 8px 4px; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-auto-option {
  display: grid; grid-template-columns: 16px minmax(0, 1fr); column-gap: 8px; align-items: center;
  width: 100%; padding: 6px 8px; border: 0; border-radius: 10px; background: transparent;
  font: inherit; text-align: left; color: var(--pm-text); cursor: pointer;
}
.pm-auto-option:hover, .pm-auto-option:focus-within { background: var(--pm-hover); }
.pm-auto-check { grid-row: 1; display: inline-flex; color: var(--pm-text); }
.pm-auto-option-name { grid-column: 2; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 1.5; }
.pm-auto-option-hint { grid-column: 2; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-auto-option-hint--invalid { color: var(--pm-error); }
.pm-auto-days {
  width: 52px; height: 26px; box-sizing: border-box; padding: 0 8px; border: .5px solid var(--pm-line-input); border-radius: 8px;
  background: var(--pm-bg); font: inherit; font-size: 13px; color: var(--pm-text);
}
.pm-auto-days:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.pm-auto-days[aria-invalid='true'] { border-color: var(--pm-error); }
.pm-auto-own { margin: 4px 0 0; padding: 6px 0 0; list-style: none; border-top: .5px solid var(--pm-line); }
.pm-auto-own-title { padding: 2px 8px 4px; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-auto-own-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; font-size: 13px; line-height: 1.5; }
.pm-auto-own-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-auto-own-back { flex-shrink: 0; font-size: 12px; }
.pm-auto-menu-foot { margin: 4px 0 0; padding: 8px 8px 4px; border-top: .5px solid var(--pm-line); font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
`

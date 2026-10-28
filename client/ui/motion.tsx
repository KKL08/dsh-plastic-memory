/**
 * 共用的入场动效：新条目入场（useArrivals + Arrival）、数字滚动（RollingNumber）、高度跟随（useHeightTransition）。
 * 只给挂着时新出现、新变化的东西播；首屏、换范围重挂时不动。减少动态效果时去掉位移和高度过渡，高亮（颜色）照留。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'
const ROLL_MS = 200
const HEIGHT_MS = 220

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface Arrivals {
  /** 这一条是挂载之后新出现、还没播过入场的。 */
  isNew(id: string): boolean
  /** 入场播过了：之后重挂（撤销、恢复后回来）不再播。 */
  settle(id: string): void
}

/**
 * 哪些条目是挂载之后新出现的。ids 还没就绪时传 undefined，第一份就绪的列表记作首屏，不算新；resetKey 变了重新记首屏。
 * 没来得及显示就离开列表的新条目也归入首屏。
 */
export function useArrivals(ids: readonly string[] | undefined, resetKey = ''): Arrivals {
  const state = useRef<{ key: string; baseline: Set<string> | undefined; arrived: Set<string> }>({ key: resetKey, baseline: undefined, arrived: new Set() })
  if (state.current.key !== resetKey) state.current = { key: resetKey, baseline: undefined, arrived: new Set() }
  const current = state.current
  if (ids !== undefined) {
    if (current.baseline === undefined) current.baseline = new Set(ids)
    const baseline = current.baseline
    const present = new Set(ids)
    for (const id of ids) if (!baseline.has(id)) current.arrived.add(id)
    for (const id of current.arrived) if (!present.has(id)) { current.arrived.delete(id); baseline.add(id) }
  }
  return {
    isNew: id => current.arrived.has(id),
    settle: (id) => { if (current.arrived.delete(id)) current.baseline?.add(id) },
  }
}

/**
 * 一条的入场：挂载时是新的就撑开位置再落进来（highlight 再亮一下银藤浅底），挂上就记为播过。
 * 入不入场在挂载时定下，之后结构不变：命令进行中视图刷新掉这一条时卡片不重挂。
 */
export function Arrival({ arrivals, id, highlight = false, children }: { arrivals: Arrivals; id: string; highlight?: boolean; children: ReactNode }) {
  const [isEntering] = useState(() => arrivals.isNew(id))
  useEffect(() => { if (isEntering) arrivals.settle(id) }, [])
  if (!isEntering) return children
  return <div className={highlight ? 'pm-arrive pm-arrive--highlight' : 'pm-arrive'}><div className="pm-arrive-body">{children}</div></div>
}

/** 在文案里放数字的占位：先用它取整句，再从这里切开，把数字换成 RollingNumber。 */
const NUMBER_SLOT = '\u0000'

/** 整句文案里的数字滚动：template 收占位、返回整句（通常是 t(key, { n: slot })）。 */
export function withRollingNumber(template: (slot: string) => string, value: number, text: string): ReactNode {
  const parts = template(NUMBER_SLOT).split(NUMBER_SLOT)
  // 占位没能原样留在句子里（翻译改了它）：照普通文案显示，不滚
  if (parts.length !== 2) return template(text)
  return <>{parts[0]}<RollingNumber value={value} text={text} />{parts[1]}</>
}

/** 数字变了就滚过去：变大从下往上，变小从上往下。text 是格式化后的显示值，value 只用来判断方向。 */
export function RollingNumber({ value, text }: { value: number; text: string }) {
  const prev = useRef({ value, text })
  const enter = useRef<HTMLSpanElement>(null)
  const leave = useRef<HTMLSpanElement>(null)
  const [leaving, setLeaving] = useState<{ text: string; dir: 1 | -1 } | undefined>(undefined)
  useLayoutEffect(() => {
    const last = prev.current
    prev.current = { value, text }
    if (last.value === value || prefersReducedMotion()) return
    const dir = value > last.value ? 1 : -1
    setLeaving({ text: last.text, dir })
    enter.current?.animate?.([{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: ROLL_MS, easing: EASE_OUT })
  }, [value, text])
  useLayoutEffect(() => {
    if (leaving === undefined) return
    const animation = leave.current?.animate?.(
      [{ transform: 'none', opacity: 1 }, { transform: `translateY(${-leaving.dir * 100}%)`, opacity: 0 }],
      { duration: ROLL_MS, easing: EASE_OUT, fill: 'forwards' },
    )
    if (animation === undefined) { setLeaving(undefined); return }
    animation.onfinish = () => { setLeaving(undefined) }
    return () => { animation.cancel() }
  }, [leaving])
  return (
    <span className="pm-roll">
      <span ref={enter}>{text}</span>
      {leaving === undefined ? null : <span ref={leave} aria-hidden="true">{leaving.text}</span>}
    </span>
  )
}

/**
 * contentKey 变了（内容换了）时，高度和上外边距从旧值过渡到新值；过渡中内容再换，从当前值接着走。
 * 内容没换的重渲染只更新量到的值，不播（窗口变宽变窄引起的折行不算）。
 */
export function useHeightTransition(ref: RefObject<HTMLElement | null>, contentKey: string): void {
  const last = useRef<{ key: string; height: number; margin: string } | undefined>(undefined)
  const running = useRef<Animation | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    if (running.current !== undefined && last.current?.key === contentKey) return
    const measure = () => ({ key: contentKey, height: el.getBoundingClientRect().height, margin: getComputedStyle(el).marginTop })
    const from = running.current === undefined ? last.current : measure()
    running.current?.cancel()
    running.current = undefined
    const to = measure()
    last.current = to
    if (from === undefined || from.key === contentKey || (from.height === to.height && from.margin === to.margin)) return
    if (prefersReducedMotion() || typeof el.animate !== 'function') return
    const animation = el.animate(
      [{ height: `${from.height}px`, marginTop: from.margin, overflow: 'hidden' }, { height: `${to.height}px`, marginTop: to.margin, overflow: 'hidden' }],
      { duration: HEIGHT_MS, easing: EASE_OUT },
    )
    running.current = animation
    animation.onfinish = () => { running.current = undefined }
  })
}

export const motionCss = `
.pm-arrive { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 260ms ${EASE_OUT}, margin-top 260ms ${EASE_OUT}; }
.pm-arrive-body {
  min-height: 0; overflow-clip-margin: 8px; animation: pm-arrive-clip 260ms;
  transition: opacity 200ms ease-out, transform 260ms ${EASE_OUT};
}
@starting-style {
  .pm-arrive { grid-template-rows: 0fr; margin-top: calc(-1 * var(--pm-arrive-gap, 0px)); }
  .pm-arrive-body { opacity: 0; transform: translateY(-8px); }
}
/* 只在撑开的这段时间裁切：之后焦点环、展开的按钮不被切掉 */
@keyframes pm-arrive-clip { from, to { overflow: clip; } }
.pm-arrive--highlight .pm-arrive-body { position: relative; isolation: isolate; }
.pm-arrive--highlight .pm-arrive-body::before {
  content: ''; position: absolute; inset: -6px -8px; z-index: -1; border-radius: 10px;
  animation: pm-arrive-tint 1800ms ease-out both;
}
@keyframes pm-arrive-tint { 0%, 60% { background: var(--pm-accent-tint); } 100% { background: transparent; } }
.pm-roll { display: inline-grid; vertical-align: top; overflow: hidden; }
.pm-roll > span { grid-area: 1 / 1; }
@media (prefers-reduced-motion: reduce) {
  .pm-arrive, .pm-arrive-body { transition: none; animation: none; }
}
`

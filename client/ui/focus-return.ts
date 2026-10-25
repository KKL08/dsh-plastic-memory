/**
 * 行内确认收起后的键盘焦点。确认里的按钮一卸载，焦点就掉到 body，键盘用户得从页首重新 Tab。
 * 规则：
 * 1. 回到打开确认的控件（行尾的删除、卡片上的动作按钮）。
 * 2. 那个控件已经不在了（这一行删掉了、卡片换成了结果），就在它原来的位置附近找：从它所在的那一块往后、再往前，
 *    优先找同名的按钮（下一行的「删除」），其次任一可 Tab 到的控件，最后是 tabIndex=-1 的提示（结果卡、
 *    「已彻底删除」那行说明）；这一层找不到就往外一层。只在插件自己的容器里找，不越过 body。
 * 3. 回到控件后再盯一会儿：确认里点的是「继续处理」「彻底删除」，那一行往往等视图刷新才消失，消失时按第 2 条接住焦点；
 *    焦点被用户挪走后就不再管。
 * 4. 不经确认的行内动作（直接删除、恢复、提升…）同样处理：动作发出时盯住焦点所在的控件（keepFocusInPlace），按第 3 条接住。
 */
import { useLayoutEffect, useState, type RefObject } from 'react'

/** 一个控件和它在 DOM 里的位置：每层祖先 + 这条路径在该祖先 children 里的序号（由近到远）。 */
interface Spot {
  el: HTMLElement
  label: string
  path: Array<{ parent: Element; index: number }>
}

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]'

function labelOf(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
}

function spotOf(el: HTMLElement): Spot {
  const path: Spot['path'] = []
  let node: Element = el
  while (node.parentElement !== null) {
    const parent: Element = node.parentElement
    path.push({ parent, index: Array.prototype.indexOf.call(parent.children, node) })
    node = parent
  }
  return { el, label: labelOf(el), path }
}

function usable(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && !el.matches(':disabled') && el.closest('[hidden], [inert]') === null
}

/** 在一块里挑落点：同名的可 Tab 控件 → 第一个可 Tab 控件 → 第一个 tabIndex=-1 的元素。 */
function pick(block: Element, label: string): HTMLElement | undefined {
  const all = [block, ...block.querySelectorAll(FOCUSABLE)].filter(el => el.matches(FOCUSABLE)).filter(usable)
  const tabbable = all.filter(el => el.tabIndex >= 0)
  return tabbable.find(el => labelOf(el) === label) ?? tabbable[0] ?? all[0]
}

/** 控件还在就是它；不在了按原位置就近找（见文件头第 2 条）。找不到返回 undefined。 */
function resolve(spot: Spot): HTMLElement | undefined {
  if (spot.el.isConnected) return spot.el
  const body = spot.el.ownerDocument.body
  for (const { parent, index } of spot.path) {
    if (parent === body || parent === spot.el.ownerDocument.documentElement) return undefined
    if (!parent.isConnected) continue
    const blocks = [...parent.children]
    const order = [...blocks.slice(index), ...blocks.slice(0, index).reverse()]
    for (const block of order) {
      const hit = pick(block, spot.label)
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

/** 焦点已经在别处（不是 body、也不是刚被移除的节点）时不抢。 */
function isFocusFree(doc: Document): boolean {
  const active = doc.activeElement
  return active === null || active === doc.body || !active.isConnected
}

let stopWatching: (() => void) | undefined

/** 盯着刚拿到焦点的控件：它被移除且焦点掉到 body 时，就近接住一次；焦点被挪走就停。 */
function watch(el: HTMLElement): void {
  stopWatching?.()
  const doc = el.ownerDocument
  let spot = spotOf(el)
  const observer = new MutationObserver(() => {
    // 控件还在时随布局更新位置，移除时用的是移除前那一刻的位置
    if (el.isConnected) { spot = spotOf(el); return }
    stop()
    if (isFocusFree(doc)) resolve(spot)?.focus()
  })
  const onFocusIn = (event: FocusEvent) => { if (event.target !== el) stop() }
  // 点空白处让控件失焦时也停；控件被移除引起的失焦交给 observer
  const onFocusOut = () => { queueMicrotask(() => { if (el.isConnected) stop() }) }
  function stop() {
    observer.disconnect()
    doc.removeEventListener('focusin', onFocusIn, true)
    el.removeEventListener('focusout', onFocusOut)
    if (stopWatching === stop) stopWatching = undefined
  }
  observer.observe(doc.documentElement, { childList: true, subtree: true })
  doc.addEventListener('focusin', onFocusIn, true)
  el.addEventListener('focusout', onFocusOut)
  stopWatching = stop
}

/** 开着的行内确认：收起后的焦点归 useReturnFocus 管，keepFocusInPlace 不插手。 */
const confirmGroups = new Set<HTMLElement>()

/** 行内动作发出时调用（见文件头第 4 条）。焦点不在控件上、或在行内确认里时什么都不做。 */
export function keepFocusInPlace(): void {
  const active = typeof document === 'undefined' ? null : document.activeElement
  if (!(active instanceof HTMLElement) || active === active.ownerDocument.body) return
  if ([...confirmGroups].some(group => group.contains(active))) return
  watch(active)
}

function returnFocus(spot: Spot): void {
  if (!isFocusFree(spot.el.ownerDocument)) return
  const target = resolve(spot)
  if (target === undefined) return
  target.focus()
  watch(target)
}

/**
 * 行内确认用：挂载时记下当时的焦点（就是打开它的控件）；卸载时焦点若还在确认里（或已掉到 body），
 * 等这次提交把新内容放进 DOM 后再按文件头的规则还回去。打开时焦点不在任何控件上，就以确认本身的位置为准就近找。
 */
export function useReturnFocus(group: RefObject<HTMLElement | null>): void {
  // 渲染时读：等提交时 autoFocus 已经把焦点挪进确认里了
  const [opener] = useState<Spot | undefined>(() => {
    const active = typeof document === 'undefined' ? null : document.activeElement
    return active instanceof HTMLElement && active !== document.body ? spotOf(active) : undefined
  })
  useLayoutEffect(() => {
    const el = group.current
    if (el === null) return
    const spot = opener ?? spotOf(el)
    confirmGroups.add(el)
    return () => {
      confirmGroups.delete(el)
      // 卸载时确认的节点还没移除，焦点在不在里面看得出来
      const active = el.ownerDocument.activeElement
      if (!isFocusFree(el.ownerDocument) && !el.contains(active)) return
      queueMicrotask(() => { returnFocus(spot) })
    }
  }, [group, opener])
}

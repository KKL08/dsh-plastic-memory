/**
 * 导航 store：宿主 `layout.selectPanel` 只收面板 id、不带参数，所以入口先把目标（视图 / 作用域 / 记忆 id）
 * 写进这里，再切面板；记忆页从这里读当前视图与作用域，页内切换也写回这里。
 */
import { useSyncExternalStore } from 'react'
import type { GuiLayerRef } from '../src/gui/contract.ts'
import type { HostContext } from './host.ts'

/** 左栏记忆页与左栏图标共用的 id（`main` 插槽的 key = `sidebar.panellist` 的 id）。 */
export const PANEL_ID = 'plastic-memory'

/** 右侧栏记忆 tab 的实现身份（宿主要求全局唯一，取包名），也是正文与标题插槽的 key。 */
export const SIDEBAR_TAB_ID = 'dsh-plastic-memory'
/** 右侧栏记忆 tab 的类型名（`openTab` 认它）。 */
export const SIDEBAR_TAB_KIND = 'plastic-memory'

export const MEMORY_TABS = ['pending', 'library', 'health', 'deleted'] as const
export type MemoryTab = (typeof MEMORY_TABS)[number]

export interface NavTarget {
  tab: MemoryTab
  /** 缺省 = 当前选中会话所在的项目，没有就是全局。 */
  scope?: GuiLayerRef
  /** 要滚入视野并高亮的记忆。 */
  memoryId?: string
}

export interface NavStore {
  get(): NavTarget
  subscribe(fn: () => void): () => void
  /** 整体替换目标。 */
  navigate(target: NavTarget): void
  /** 入口用：整体替换目标，并记下「这次打开来自入口」（openMemoryPage 先调它再切面板）。 */
  enter(target: NavTarget): void
  /**
   * 取走入口标记（取完即清）。记忆页挂载时据此判断：入口写过目标就照目标走，
   * 没有（点左栏图标、宿主恢复上次的面板）就按默认落点。
   */
  takeEntry(): boolean
  /** 页内用：只改给出的字段。 */
  update(patch: Partial<NavTarget>): void
  /** 跳到宿主插件页里本插件的配置（「去设置里打开 ›」）。 */
  openSettings(): void
}

export function createNavStore(initial: NavTarget = { tab: 'pending' }, opts: { openSettings?: () => void } = {}): NavStore {
  let target = initial
  let entered = false
  const listeners = new Set<() => void>()
  const set = (next: NavTarget) => { target = next; for (const fn of listeners) fn() }
  return {
    get: () => target,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    navigate: set,
    enter(next) { entered = true; set(next) },
    takeEntry() { const was = entered; entered = false; return was },
    update: patch => set({ ...target, ...patch }),
    openSettings: () => { opts.openSettings?.() },
  }
}

export function useNavTarget(nav: NavStore): NavTarget {
  return useSyncExternalStore(nav.subscribe, nav.get)
}

/** 入口直达记忆页：先写目标，再切面板。 */
export function openMemoryPage(ctx: Pick<HostContext, 'layout'>, nav: NavStore, target: NavTarget): void {
  nav.enter(target)
  ctx.layout.selectPanel(PANEL_ID)
}

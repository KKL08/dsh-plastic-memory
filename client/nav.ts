/**
 * 导航 store：宿主 `layout.selectPanel` 只收面板 id、不带参数，所以入口先把目标（视图 / 作用域 / 记忆 id）
 * 写进这里，再切面板；记忆页从这里读当前视图与作用域，页内切换也写回这里。
 * 另管两个依赖宿主可选服务的出口（插件页、右侧栏记忆 tab）：服务在才能用，不能用的入口不画。
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

/** 依赖宿主可选服务的出口：插件页里本插件的配置（pluginNavigation）、当前会话右侧栏的记忆 tab（sidebarRightTabs + sidebarRight）。 */
export type HostExit = 'settings' | 'sidebarTab'

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
  /** 跳到宿主插件页里本插件的配置（「去设置里打开 ›」）；出口不可用时什么都不做。 */
  openSettings(): void
  /** 打开当前会话右侧栏的记忆 tab；出口不可用时什么都不做。 */
  openSidebarTab(): void
  /** 出口现在能不能用（对应的宿主服务在不在）。 */
  canOpen(exit: HostExit): boolean
  /** apply 用：服务就位时给出打开函数，离开时给 undefined；通知订阅者。 */
  provide(exit: HostExit, open: (() => void) | undefined): void
}

export function createNavStore(
  initial: NavTarget = { tab: 'pending' },
  opts: { openSettings?: () => void; openSidebarTab?: () => void } = {},
): NavStore {
  let target = initial
  let entered = false
  const exits: Partial<Record<HostExit, () => void>> = { settings: opts.openSettings, sidebarTab: opts.openSidebarTab }
  const listeners = new Set<() => void>()
  const notify = () => { for (const fn of listeners) fn() }
  const set = (next: NavTarget) => { target = next; notify() }
  return {
    get: () => target,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    navigate: set,
    enter(next) { entered = true; set(next) },
    takeEntry() { const was = entered; entered = false; return was },
    update: patch => set({ ...target, ...patch }),
    openSettings: () => { exits.settings?.() },
    openSidebarTab: () => { exits.sidebarTab?.() },
    canOpen: exit => exits[exit] !== undefined,
    provide(exit, open) { exits[exit] = open; notify() },
  }
}

export function useNavTarget(nav: NavStore): NavTarget {
  return useSyncExternalStore(nav.subscribe, nav.get)
}

/** hook：出口能不能用；服务来去时重渲染。 */
export function useCanOpen(nav: NavStore, exit: HostExit): boolean {
  return useSyncExternalStore(nav.subscribe, () => nav.canOpen(exit))
}

/** 入口直达记忆页：先写目标，再切面板。 */
export function openMemoryPage(ctx: Pick<HostContext, 'layout'>, nav: NavStore, target: NavTarget): void {
  nav.enter(target)
  ctx.layout.selectPanel(PANEL_ID)
}

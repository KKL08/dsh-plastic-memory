/**
 * 导航 store：宿主 `layout.selectPanel` 只收面板 id、不带参数，所以入口先把目标（视图 / 作用域 / 记忆 id）
 * 写进这里，再切面板；记忆页从这里读当前视图与作用域，页内切换也写回这里。
 */
import { useSyncExternalStore } from 'react'
import type { GuiLayerRef } from '../src/gui/contract.ts'
import type { HostContext } from './host.ts'

/** 左栏记忆页与左栏图标共用的 id（`main` 插槽的 key = `sidebar.panellist` 的 id）。 */
export const PANEL_ID = 'plastic-memory'

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
  /** 入口用：整体替换目标。 */
  navigate(target: NavTarget): void
  /** 页内用：只改给出的字段。 */
  update(patch: Partial<NavTarget>): void
}

export function createNavStore(initial: NavTarget = { tab: 'pending' }): NavStore {
  let target = initial
  const listeners = new Set<() => void>()
  const set = (next: NavTarget) => { target = next; for (const fn of listeners) fn() }
  return {
    get: () => target,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    navigate: set,
    update: patch => set({ ...target, ...patch }),
  }
}

export function useNavTarget(nav: NavStore): NavTarget {
  return useSyncExternalStore(nav.subscribe, nav.get)
}

/** 入口直达记忆页：先写目标，再切面板。 */
export function openMemoryPage(ctx: Pick<HostContext, 'layout'>, nav: NavStore, target: NavTarget): void {
  nav.navigate(target)
  ctx.layout.selectPanel(PANEL_ID)
}

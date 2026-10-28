/**
 * 导航 store：宿主 `layout.selectPanel` 只收面板 id、不带参数，所以入口先把目标（视图 / 作用域 / 记忆 id）
 * 写进这里，再切面板；记忆页从这里读当前视图与作用域，页内切换也写回这里。
 * 另管两个依赖宿主可选服务的出口（插件页、右侧栏记忆 tab）：服务在才能用，不能用的入口不画。
 */
import { useSyncExternalStore } from 'react'
import { sameLayer, type GuiLayerRef, type PendingLevel, type ScopeRef } from '../src/gui/contract.ts'
import type { HostContext } from './host.ts'
import type { Translate } from './i18n.tsx'
import { baseName } from './path.ts'

/** 左栏记忆页与左栏图标共用的 id（`main` 插槽的 key = `sidebar.panellist` 的 id）。 */
export const PANEL_ID = 'plastic-memory'

/** 右侧栏记忆 tab 的实现身份（宿主要求全局唯一，取包名），也是正文与标题插槽的 key。 */
export const SIDEBAR_TAB_ID = 'dsh-plastic-memory'
/** 右侧栏记忆 tab 的类型名（`openTab` 认它）。 */
export const SIDEBAR_TAB_KIND = 'plastic-memory'

/** 记忆页的三个视图，按显示顺序：处理、记忆查看、最近删除。标识本身不随显示名变。 */
export const MEMORY_VIEWS = ['todo', 'library', 'deleted'] as const
export type MemoryView = (typeof MEMORY_VIEWS)[number]

/** 记忆页左栏选中的范围：全部，或一个作用域（全局、某个项目）。即契约里的范围（ScopeRef）。 */
export type PageScope = ScopeRef
export const ALL_SCOPE: PageScope = { kind: 'all' }

export function samePageScope(a: PageScope, b: PageScope): boolean {
  if (a.kind === 'all' || b.kind === 'all') return a.kind === b.kind
  return sameLayer(a, b)
}

/** 属于这些作用域的条目在不在这个范围里：「全部」包含一切。 */
export function isInScope(layers: readonly GuiLayerRef[], scope: PageScope): boolean {
  return scope.kind === 'all' || layers.some(layer => sameLayer(layer, scope))
}

/** 作用域的显示顺序：全局在前，项目按显示名（路径最后一段）的字母序，同名按路径。左栏和「全部」里的分段都按它。 */
export function compareLayers(a: GuiLayerRef, b: GuiLayerRef): number {
  if (a.kind === 'global' || b.kind === 'global') return a.kind === b.kind ? 0 : a.kind === 'global' ? -1 : 1
  return baseName(a.workspacePath).localeCompare(baseName(b.workspacePath)) || a.workspacePath.localeCompare(b.workspacePath)
}

/** 范围的显示名：「全部」、「全局」，项目写目录名（路径最后一段）。左栏、标题行、状态条、范围标签都用它。 */
export function scopeName(scope: PageScope, t: Translate): string {
  return scope.kind === 'all' ? t('scope.all') : scope.kind === 'global' ? t('scope.global') : baseName(scope.workspacePath)
}

export interface NavTarget {
  view: MemoryView
  /** 缺省：从对话进来时是那个对话的项目（对话不在项目里时是全局），否则是「全部」。 */
  scope?: PageScope
  /** 要滚入视野并高亮的记忆。 */
  memoryId?: string
  /**
   * 处理视图要定位的组：焦点落在组标题上，组不在了落在处理视图顶部。
   * 只对写它的那次导航有效：update 没给出它就清掉，免得切走再切回来又被拉过去。
   */
  level?: PendingLevel
  /**
   * 处理视图要跳到的第一条带「新」的条目（状态条结果行的链接）：todo = 先处理或等你决定里的，advice = 可以整理里的，any = 不限。
   * 滚到视野中间、闪一次并接住焦点；没有带「新」的落在处理视图顶部。和 level 一样只对写它的那次导航有效。
   */
  newItem?: NewItemJump
  /**
   * 从对话（右侧栏、对话卡、输入框「记忆」按钮）进来。那个对话就是当前选中的会话：它的项目在标题行和左栏标「当前对话」，
   * 没有记忆也列进左栏。
   */
  fromChat?: true
}

export type NewItemJump = 'todo' | 'advice' | 'any'

/** 改版前指向四个 tab 的导航目标，照常可用（见 toNavTarget）。缺省作用域按「全部」。 */
export const LEGACY_TABS = ['pending', 'health', 'library', 'deleted'] as const
export interface LegacyNavTarget {
  tab: (typeof LEGACY_TABS)[number]
  scope?: GuiLayerRef
  memoryId?: string
  level?: PendingLevel
}

const LEGACY_VIEW = { pending: 'todo', health: 'todo', library: 'library', deleted: 'deleted' } as const satisfies Record<LegacyNavTarget['tab'], MemoryView>

/** 旧目标映射：待处理、健康 → 处理（带组的照旧定位到组标题），全部记忆 → 记忆查看，最近删除 → 最近删除。新目标原样返回。 */
export function toNavTarget(target: NavTarget | LegacyNavTarget): NavTarget {
  if (!('tab' in target)) return target
  const { tab, ...rest } = target
  return { view: LEGACY_VIEW[tab], ...rest }
}

/** 依赖宿主可选服务的出口：插件页里本插件的配置（pluginNavigation）、当前会话右侧栏的记忆 tab（sidebarRightTabs + sidebarRight）。 */
export type HostExit = 'settings' | 'sidebarTab'

export interface NavStore {
  get(): NavTarget
  subscribe(fn: () => void): () => void
  /** 整体替换目标。 */
  navigate(target: NavTarget): void
  /** 入口用：整体替换目标（旧目标先映射），并记下「这次打开来自入口」（openMemoryPage 先调它再切面板）。 */
  enter(target: NavTarget | LegacyNavTarget): void
  /**
   * 取走入口标记（取完即清）。记忆页挂载时据此判断：入口写过目标就照目标走，
   * 没有（点左栏图标、宿主恢复上次的面板）就按默认落点。
   */
  takeEntry(): boolean
  /** 页内用：只改给出的字段；组定位（level）和跳到「新」（newItem）不沿用。 */
  update(patch: Partial<NavTarget>): void
  /** 跳到宿主插件页里本插件的配置（记忆页的「设置」）；出口不可用时什么都不做。 */
  openSettings(): void
  /** 打开当前会话右侧栏的记忆 tab；出口不可用时什么都不做。 */
  openSidebarTab(): void
  /** 出口现在能不能用（对应的宿主服务在不在）。 */
  canOpen(exit: HostExit): boolean
  /** apply 用：服务就位时给出打开函数，离开时给 undefined；通知订阅者。 */
  provide(exit: HostExit, open: (() => void) | undefined): void
}

export function createNavStore(
  initial: NavTarget = { view: 'todo' },
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
    enter(next) { entered = true; set(toNavTarget(next)) },
    takeEntry() { const was = entered; entered = false; return was },
    update(patch) { const { level: _level, newItem: _newItem, ...rest } = target; set({ ...rest, ...patch }) },
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

/** 入口直达记忆页：先写目标（旧目标先映射），再切面板。 */
export function openMemoryPage(ctx: Pick<HostContext, 'layout'>, nav: NavStore, target: NavTarget | LegacyNavTarget): void {
  nav.enter(target)
  ctx.layout.selectPanel(PANEL_ID)
}

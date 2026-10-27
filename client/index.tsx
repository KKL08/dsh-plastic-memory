/**
 * 浏览器半侧入口：注册双语文案、左栏图标（sidebar.panellist）与同 id 的记忆页（main）。
 * 导航 store 与宿主网关都在这里各建一份，所有插槽根共用（memoryRoot 每次页面加载最多问一次），组件只认网关接口。
 */
import { useMemo } from 'react'
import { createComposerDock, DOCK_ID, DOCK_ORDER } from './composer/dock.tsx'
import { registerChatCards } from './chat/index.tsx'
import { createHostGateway, GatewayProvider, type BindGateway } from './gateway.ts'
import type { HostContext, RootStandardProps } from './host.ts'
import { useHostTranslate } from './i18n.tsx'
import { en, NS, zh } from './locales.ts'
import { MemoryPage, memoryPageCss } from './MemoryPage.tsx'
import { NavIcon } from './NavIcon.tsx'
import { createNavStore, PANEL_ID, type NavStore } from './nav.ts'
import { registerSidebarTab } from './sidebar/register.tsx'
import { PACKAGE_NAME } from './settings/config.ts'
import { applySettings } from './settings/index.tsx'
import { PanelShell } from './ui/PanelShell.tsx'

export { PANEL_ID }
/** npm 包名：宿主插件页按它打开本插件的详情（配置区在详情页里）；定义在 settings/config.ts。 */
export { PACKAGE_NAME }

/** 核心依赖：缺一个宿主就不加载本插件。右侧栏、插件页导航、配置表单是可选服务，在 apply 里按需 `ctx.inject`。 */
export const inject = ['slots', 'locale', 'layout', 'remote', 'remote.commands', 'remote.workspaceFiles', 'remote.session']

function createMainPanel(ctx: HostContext, nav: NavStore, bind: BindGateway) {
  return function MemoryMainPanel(props: RootStandardProps) {
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    const t = useHostTranslate(ctx.locale, NS)
    return (
      <PanelShell gateway={gateway} t={t} className="pm-root--page" extraCss={memoryPageCss}>
        <MemoryPage nav={nav} />
      </PanelShell>
    )
  }
}

/** 左栏图标：根作用域插槽，除 `{size, active}` 外也拿得到会话列表与文件资源，自己借会话读待处理视图画圆点。 */
function createNavIcon(bind: BindGateway) {
  return function MemoryNavIcon(props: RootStandardProps & { size: number; active: boolean }) {
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    return <GatewayProvider value={gateway}><NavIcon size={props.size} active={props.active} /></GatewayProvider>
  }
}

export function apply(ctx: HostContext): void {
  ctx.locale.register(NS, { zh, en })
  const t = ctx.locale.bind(NS)
  const nav = createNavStore()
  // 宿主有插件页导航才有「设置」「去设置里打开 ›」
  ctx.inject(['pluginNavigation'], (scope) => {
    scope.effect(() => {
      nav.provide('settings', () => { scope.pluginNavigation.openBundle(PACKAGE_NAME) })
      return () => { nav.provide('settings', undefined) }
    }, 'plastic-memory: settings exit')
  })
  const bind = createHostGateway(ctx)
  const MainPanel = createMainPanel(ctx, nav, bind)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MainPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('nav.label'),
  }, createNavIcon(bind)))
  const Dock = createComposerDock(ctx, nav, bind, () => useHostTranslate(ctx.locale, NS))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: DOCK_ID, order: DOCK_ORDER }, Dock))
  registerChatCards(ctx, nav, bind)
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => { registerSidebarTab(scope, nav, bind, () => useHostTranslate(ctx.locale, NS)) })
  applySettings(ctx, nav, bind, () => useHostTranslate(ctx.locale, NS))
}

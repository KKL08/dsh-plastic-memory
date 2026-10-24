/**
 * 浏览器半侧入口：注册双语文案、左栏图标（sidebar.panellist）与同 id 的记忆页（main）。
 * 网关（宿主实现）与导航 store 在这里各建一份，所有插槽根共用；组件只认网关接口。
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { createComposerDock, DOCK_ID, DOCK_ORDER } from './composer/dock.tsx'
import { registerChatCards } from './chat/index.tsx'
import { createHostGateway } from './gateway.ts'
import type { HostContext, HostLocale, RootStandardProps } from './host.ts'
import type { Translate } from './i18n.tsx'
import { en, NS, zh } from './locales.ts'
import { healthCss } from './health/HealthTab.tsx'
import { MemoryIcon } from './MemoryIcon.tsx'
import { MemoryPage, memoryPageCss } from './MemoryPage.tsx'
import { createNavStore, PANEL_ID, type NavStore } from './nav.ts'
import { PanelShell } from './ui/PanelShell.tsx'

export { PANEL_ID }

export const inject = ['slots', 'locale', 'layout', 'sidebarRight', 'remote', 'remote.commands', 'remote.workspaceFiles', 'remote.session', 'pluginNavigation']

/** npm 包名：宿主插件页按它打开本插件的详情（配置区在详情页里）。 */
export const PACKAGE_NAME = 'dsh-plastic-memory'

/** 宿主 locale 的翻译函数；切语言或字典晚到时换一个新引用，让组件重渲染。 */
function useHostTranslate(locale: HostLocale): Translate {
  const subscribe = useCallback((fn: () => void) => locale.subscribe(fn), [locale])
  const snapshot = useSyncExternalStore(subscribe, () => locale.getSnapshot())
  return useMemo(() => {
    const bound = locale.bind(NS)
    return (key, params) => bound(key, params)
  }, [locale, snapshot])
}

function createMainPanel(ctx: HostContext, nav: NavStore) {
  const bind = createHostGateway(ctx)
  return function MemoryMainPanel(props: RootStandardProps) {
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    const t = useHostTranslate(ctx.locale)
    return (
      <PanelShell gateway={gateway} t={t} extraCss={memoryPageCss + healthCss}>
        <MemoryPage nav={nav} />
      </PanelShell>
    )
  }
}

export function apply(ctx: HostContext): void {
  ctx.locale.register(NS, { zh, en })
  const t = ctx.locale.bind(NS)
  const nav = createNavStore(undefined, { openSettings: () => { ctx.pluginNavigation.openBundle(PACKAGE_NAME) } })
  const MainPanel = createMainPanel(ctx, nav)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MainPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => t('nav.label'),
  }, MemoryIcon))
  const Dock = createComposerDock(ctx, nav, createHostGateway(ctx), () => useHostTranslate(ctx.locale))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: DOCK_ID, order: DOCK_ORDER }, Dock))
  registerChatCards(ctx, nav)
}

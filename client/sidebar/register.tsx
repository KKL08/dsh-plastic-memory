/**
 * 右侧栏「记忆」tab 的注册（ui-sidebar-right 的公开两段式）：
 * ① `ctx.sidebarRightTabs.register` 登记页面类 tab 类型（不认地址，按 kind 打开），带一条「开始」页入口；
 * ② 正文进 `sidebar.right.pane.tab`、标签名进 `sidebar.right.pane.tab.title`，key 都是类型的 id。
 * tab 不常驻：从「开始」页入口或 `openMemoryTab`（`ctx.sidebarRight.openTab`）打开。
 */
import { useMemo } from 'react'
import type { BindGateway } from '../gateway.ts'
import type { SessionStandardProps, SidebarHost } from '../host.ts'
import type { Translate } from '../i18n.tsx'
import { NS } from '../locales.ts'
import { MemoryIcon } from '../MemoryIcon.tsx'
import { openMemoryPage, SIDEBAR_TAB_ID, SIDEBAR_TAB_KIND, type NavStore } from '../nav.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { SidebarTab, sidebarTabCss } from './SidebarTab.tsx'

function GuideIcon({ size }: { size?: number | undefined }) {
  return <MemoryIcon size={size ?? 22} active={false} />
}

/**
 * 打开（或聚焦）当前会话右侧栏里的「记忆」tab，落在 tab 顶部。
 * 页面类 tab 不认地址，`openTab(kind)` 没有可以指向「某一段」的地址；宿主虽然允许带 `params`
 * （正文从 tab 信息的 `navigation.params` 读，每次打开 `revision` 加一），但这个 tab 只有一屏、没有要直达的子位置，
 * 所以不传参数。「开始」页入口卡由宿主自己按 kind 打开（`tab.actions.openTab(kind, {replaceTab: true})`），落点相同。
 */
export function openMemoryTab(ctx: Pick<SidebarHost, 'sidebarRight'>): void {
  ctx.sidebarRight.openTab(SIDEBAR_TAB_KIND)
}

/**
 * 在 `ctx.inject(['sidebarRightTabs', 'sidebarRight'], …)` 的子上下文里调用：登记 tab 类型、注册正文与标题，
 * 并把「打开记忆 tab」交给导航 store（输入框弹层的「查看带入的记忆 ›」靠它；kind 没登记时 openTab 会抛错，所以随登记一起给出）。
 */
export function registerSidebarTab(ctx: SidebarHost, nav: NavStore, bind: BindGateway, useTranslate: () => Translate): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => {
    nav.provide('sidebarTab', () => { openMemoryTab(ctx) })
    return () => { nav.provide('sidebarTab', undefined) }
  }, 'plastic-memory: sidebar tab exit')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SIDEBAR_TAB_ID,
    kind: SIDEBAR_TAB_KIND,
    title: () => t('sidebar.tab.title'),
    guide: [{
      id: 'memory',
      order: 40,
      title: () => t('sidebar.guide.title'),
      description: () => t('sidebar.guide.description'),
      icon: GuideIcon,
    }],
  }), 'plastic-memory: sidebar tab type')

  function MemorySidebarTab(props: SessionStandardProps) {
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    const translate = useTranslate()
    const cwd = props.useSessions(s => s.byId[props.sessionId]?.cwd)
    return (
      <PanelShell gateway={gateway} t={translate} className="pm-side-root" extraCss={sidebarTabCss}>
        <SidebarTab
          sessionId={props.sessionId}
          workspacePath={cwd}
          openPage={(target) => { openMemoryPage(ctx, nav, target) }}
        />
      </PanelShell>
    )
  }
  function MemorySidebarTitle() {
    const translate = useTranslate()
    return <><MemoryIcon size={16} active={false} />{translate('sidebar.tab.title')}</>
  }
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID }, MemorySidebarTab))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: SIDEBAR_TAB_ID }, MemorySidebarTitle))
}

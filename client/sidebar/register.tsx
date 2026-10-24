/**
 * 右侧栏「记忆」tab 的注册（ui-sidebar-right 的公开两段式）：
 * ① `ctx.sidebarRightTabs.register` 登记页面类 tab 类型（不认地址，按 kind 打开），带一条「开始」页入口；
 * ② 正文进 `sidebar.right.pane.tab`、标签名进 `sidebar.right.pane.tab.title`，key 都是类型的 id。
 * tab 不常驻：从「开始」页入口或 `openMemoryTab`（`ctx.sidebarRight.openTab`）打开。
 */
import { useMemo } from 'react'
import type { BindGateway } from '../gateway.ts'
import type { HostContext, SessionStandardProps, SidebarHost } from '../host.ts'
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

export function registerSidebarTab(ctx: HostContext & SidebarHost, nav: NavStore, bind: BindGateway, useTranslate: () => Translate): void {
  const t = ctx.locale.bind(NS)
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

  // 宿主启动时间：浏览器半侧拿不到宿主进程的启动时刻（boot 数据与 Remote 都没有），先用插件加载（≈ 页面加载）时刻代替。
  // 页面通常随宿主一起打开；刷新页面后，刷新前冻结的会话也会显示「重启后未重新带入」。
  const hostStartedAt = Date.now()
  function MemorySidebarTab(props: SessionStandardProps) {
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    const translate = useTranslate()
    const cwd = props.useSessions(s => s.byId[props.sessionId]?.cwd)
    return (
      <PanelShell gateway={gateway} t={translate} className="pm-side-root" extraCss={sidebarTabCss}>
        <SidebarTab
          sessionId={props.sessionId}
          workspacePath={cwd}
          hostStartedAt={hostStartedAt}
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

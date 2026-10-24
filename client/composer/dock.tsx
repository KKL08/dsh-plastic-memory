/**
 * `conversation.composer.dock` 的插槽根：用会话插槽自己的 sessionId 订阅「这次对话」视图，
 * 两个跳转接到宿主右侧栏（openTab）和记忆页待处理（nav store）。
 * 根节点 `display: contents`：没有记忆时 dock 的 flex 行里不留空项、不多占一个 gap。
 */
import { useMemo } from 'react'
import type { MemoryGateway } from '../gateway.ts'
import type { HostContext, RootStandardProps, SessionStandardProps } from '../host.ts'
import type { Translate } from '../i18n.tsx'
import { openMemoryPage, SIDEBAR_TAB_KIND, type NavStore } from '../nav.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { MemoryButton, memoryButtonCss } from './MemoryButton.tsx'

/** dock 条目 id。 */
export const DOCK_ID = 'plastic-memory'
/** 宿主 dock 自带的统计胶囊是 order 0、1；排在它们之后，紧挨 ContextMeter（宿主把它画在 dock 条目之后）。 */
export const DOCK_ORDER = 100

export function createComposerDock(
  ctx: Pick<HostContext, 'layout' | 'sidebarRight'>,
  nav: NavStore,
  bind: (props: RootStandardProps) => MemoryGateway,
  useTranslate: () => Translate,
) {
  return function MemoryComposerDock(props: SessionStandardProps) {
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    const t = useTranslate()
    return (
      <PanelShell gateway={gateway} t={t} className="pm-composer-root" extraCss={memoryButtonCss}>
        <MemoryButton
          sessionId={props.sessionId}
          useProjection={props.useProjection}
          onOpenTab={() => { ctx.sidebarRight.openTab(SIDEBAR_TAB_KIND) }}
          onHandle={() => { openMemoryPage(ctx, nav, { tab: 'pending' }) }}
        />
      </PanelShell>
    )
  }
}

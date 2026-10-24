/**
 * 浏览器半侧入口（walking skeleton）：左栏一个图标（sidebar.panellist）+ 同 id 的主面板（main）。
 * 页面上一个按钮借选中的会话执行 `/memory ping`，一块文字订阅 `<memoryRoot>/.state/gui/ping.json`
 * 的文件资源并显示版本与内容。
 */
import type { HostContext } from './host.ts'
import { MemoryIcon } from './MemoryIcon.tsx'
import { createMemoryPage } from './MemoryPage.tsx'

export const PANEL_ID = 'plastic-memory'

export const inject = ['slots', 'remote', 'remote.commands', 'remote.workspaceFiles']

export function apply(ctx: HostContext): void {
  const MemoryPage = createMemoryPage(ctx)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, MemoryPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    label: () => 'Memory',
  }, MemoryIcon))
}

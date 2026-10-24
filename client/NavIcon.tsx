/**
 * 左栏「记忆」图标（sidebar.panellist）：图标本身 + 待处理圆点。宿主没有给面板图标的徽标 API，
 * 插槽只给 `{size, active}` 和根作用域标准 props，所以图标自己借会话读待处理视图、自己画圆点。
 * 亮不亮点直接用视图的 dot：服务端已按「读不出的文件不亮点、密钥红三角盖过琥珀点」算好，裁决 / 忽略后视图重写，点跟着撤。
 * 无障碍名称由侧栏按注册时的 label 渲染、只在注册或切语言时重算，带不上状态；状态文字由记忆页 tab 计数、侧栏和状态卡兜底。
 */
import { useGateway } from './gateway.ts'
import { MemoryIcon, type IconMarker } from './MemoryIcon.tsx'

export function NavIcon({ size }: { size: number; active: boolean }) {
  const gateway = useGateway()
  // 待处理视图覆盖全部层，借哪个会话都一样
  const pending = gateway.useView(gateway.useSession(undefined), 'pending')
  const dot = pending.status === 'ready' ? pending.data.dot : 'none'
  const marker: IconMarker | undefined = dot === 'red' ? 'secret' : dot === 'amber' ? 'pending' : undefined
  return <MemoryIcon size={size} marker={marker} />
}

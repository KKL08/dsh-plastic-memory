/**
 * 宿主图标集里的线性图标（数据见 host-icons.ts，由 scripts/sync-host-icons.ts 生成）：16 栅格、1px 描边、currentColor。
 * 只做装饰，读屏名称由旁边的文字或外层按钮给。宿主集合里没有合适的就按同一规格自己画，不放进这里。
 */
import { createElement } from 'react'
import { HOST_ICON_DATA } from './host-icons.ts'

export type IconName = keyof typeof HOST_ICON_DATA

/** SVG 属性名 stroke-linecap → React 的 strokeLinecap。 */
const reactProp = (attr: string) => attr.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
const reactProps = (attrs: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [reactProp(k), v]))

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  const icon = HOST_ICON_DATA[name]
  return (
    <svg width={size} height={size} viewBox={icon.viewBox} fill="none" strokeWidth={icon.strokeWidth} {...reactProps(icon.root)} aria-hidden="true" className={className}>
      {icon.shapes.map((shape, i) => createElement(shape.tag, { key: i, ...reactProps(shape.attrs) }))}
    </svg>
  )
}

import { useId } from 'react'

/** 图标上的状态标记：琥珀圆点 = 等你决定；红色小三角 = 有密钥（盖过琥珀点）。 */
export type IconMarker = 'pending' | 'secret'

/** 标记的像素尺寸（DESIGN.md「Status Marker」：导航里圆点 7px，三角与 StatusMarker 的 nav 档同为 9px；与线条留约 1.5px 空隙）。 */
const DOT_PX = 7
const TRIANGLE_PX = 9
const GAP_PX = 1.5

/** 红三角：StatusMarker 的 14×14 路径按边长缩放、贴右上角。 */
function trianglePath(side: number): string {
  const k = side / 14
  const x0 = 24 - side
  return `M${x0 + 7 * k} ${1.4 * k}L${x0 + 13.2 * k} ${12.4 * k}H${x0 + 0.8 * k}Z`
}

/**
 * 左栏图标：侧栏给出边长，按钮与无障碍名称由侧栏负责，这里只画装饰性图形。
 * 带标记时贴右上角画圆点或三角，并用 SVG mask 把标记周围的图标线条挖掉，玻璃、暗色、实色侧栏上都不露光晕。
 * 图标在插槽根之外渲染，拿不到 `--pm-*` 令牌，颜色直接取宿主令牌。
 */
export function MemoryIcon({ size, marker }: { size: number; active: boolean; marker?: IconMarker | undefined }) {
  const maskId = `pm-nav-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const unit = 24 / size
  const gap = GAP_PX * unit
  const dotR = (DOT_PX / 2) * unit
  const side = TRIANGLE_PX * unit
  const lines = (
    <>
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </>
  )
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}
      {...(marker !== undefined ? { 'data-marker': marker } : {})}>
      {marker === undefined
        ? lines
        : (
          <>
            <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
              <rect x="-2" y="-2" width="28" height="28" fill="#fff" stroke="none" />
              {marker === 'pending'
                ? <circle cx={24 - dotR} cy={dotR} r={dotR + gap} fill="#000" stroke="none" />
                : <path d={trianglePath(side)} fill="#000" stroke="#000" strokeWidth={(1.2 * side) / 14 + 2 * gap} />}
            </mask>
            <g mask={`url(#${maskId})`}>{lines}</g>
            {marker === 'pending'
              ? <circle className="pm-nav-dot" cx={24 - dotR} cy={dotR} r={dotR} fill="var(--dsw-alias-state-warn-primary, #F59E0B)" stroke="none" />
              : (
                <path className="pm-nav-secret" d={trianglePath(side)} fill="var(--dsw-alias-state-error-primary, #EF4444)"
                  stroke="var(--dsw-alias-state-error-primary, #EF4444)" strokeWidth={(1.2 * side) / 14} />
              )}
          </>
        )}
    </svg>
  )
}

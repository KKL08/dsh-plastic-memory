import { useId } from 'react'

/** 图标上的状态标记：琥珀圆点 = 等你决定；红色小三角 = 有密钥（盖过琥珀点）。 */
export type IconMarker = 'pending' | 'secret'

// 标记的位置和挖洞范围取设计稿 Foundations「状态标记」（24 栅格，按 18px 导航图标定）：
// 圆点贴右上角，挖洞比圆点大一圈，留出约 1.5px 空隙；三角同理，挖洞用加粗描边扩出空隙。
const DOT = { cx: 20.4, cy: 3.6, r: 4.4, holeR: 6.4 }
const TRIANGLE = 'M20.5 -1.2L26.2 8.6H14.8Z'

/**
 * 记忆图标：鲸尾出水线稿（24 栅格、1.6 描边、currentColor），左栏、入口卡、右侧栏 tab、空状态、输入框按钮共用。
 * 只画鲸尾，不画整条鲸，避开 DeepSeek 标志。侧栏给出边长，按钮与无障碍名称由侧栏负责，这里只画装饰性图形。
 * 带标记时在右上角画圆点或三角，并用 SVG mask 把标记周围的线条挖掉，玻璃、暗色、实色侧栏上都不露光晕。
 * 图标在插槽根之外渲染，拿不到 `--pm-*` 令牌，颜色直接取宿主令牌。
 */
export function MemoryIcon({ size, marker }: { size: number; marker?: IconMarker | undefined }) {
  const maskId = `pm-nav-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const lines = (
    <>
      <path d="M12 13.2C9.5 12.6 4.6 11.2 3 7c2.8.1 6.2.8 8.1 1.6L12 9.8l.9-1.2c1.9-.8 5.3-1.5 8.1-1.6-1.6 4.2-6.5 5.6-9 6.2z" transform="translate(0 -1.2)" />
      <path d="M12 12v4.3" />
      <path d="M3.5 18.3c1.5 0 1.5-1.1 2.9-1.1s1.4 1.1 2.8 1.1 1.4-1.1 2.8-1.1 1.4 1.1 2.8 1.1 1.4-1.1 2.8-1.1 1.4 1.1 2.9 1.1" />
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
            <mask id={maskId} maskUnits="userSpaceOnUse" x="-4" y="-4" width="32" height="32">
              <rect x="-4" y="-4" width="32" height="32" fill="#fff" stroke="none" />
              {marker === 'pending'
                ? <circle cx={DOT.cx} cy={DOT.cy} r={DOT.holeR} fill="#000" stroke="none" />
                : <path d={TRIANGLE} fill="#000" stroke="#000" strokeWidth={3.6} />}
            </mask>
            <g mask={`url(#${maskId})`}>{lines}</g>
            {marker === 'pending'
              ? <circle className="pm-nav-dot" cx={DOT.cx} cy={DOT.cy} r={DOT.r} fill="var(--dsw-alias-state-warn-primary, #F59E0B)" stroke="none" />
              : (
                <path className="pm-nav-secret" d={TRIANGLE} fill="var(--dsw-alias-state-error-primary, #EF4444)"
                  stroke="var(--dsw-alias-state-error-primary, #EF4444)" strokeWidth={1} />
              )}
          </>
        )}
    </svg>
  )
}

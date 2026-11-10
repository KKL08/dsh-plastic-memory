/**
 * 叉：宿主图标集里没有，按「不再提醒」的规格画（10 栅格、描边 1.2、圆头、currentColor）。描边随尺寸缩放。
 * 用在「不再提醒」、编辑面板的标签、整理面板里移出一条；设置弹窗的关闭按钮规格不同（14 栅格、描边 1.4、方头），不用它。
 */
export function CrossIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <path d="m1.5 1.5 7 7m0-7-7 7" />
    </svg>
  )
}

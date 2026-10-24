/** 左栏图标：侧栏给出边长，按钮与无障碍名称由侧栏负责，这里只画装饰性图形。 */
export function MemoryIcon({ size }: { size: number; active: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" style={{ display: 'block' }}>
      <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </svg>
  )
}

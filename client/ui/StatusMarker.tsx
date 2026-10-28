/**
 * 状态标记（DESIGN.md「Status Marker」）：琥珀圆点 = 等你决定；红色小三角 = 有密钥（换形状照顾色弱）；
 * 绿色小圆点 = 运行中 / 良好；标注灰圆点 = 处理视图里已处理的条目；红色小圆点只给分数「有问题」那一档（分数旁的分档圆点：良好绿、需要留意琥珀、有问题红）。琥珀对白底只有 2.15:1，所以调用方要在同一行写清状态文字；
 * 传 label 时标记自己也带无障碍名称，不传则只是装饰。左栏图标上的抠洞版本在 MemoryIcon.tsx。
 */
export type MarkerKind = 'pending' | 'secret' | 'ok' | 'error' | 'done'

export function StatusMarker({ kind, size = 'page', label }: { kind: MarkerKind; size?: 'nav' | 'page'; label?: string }) {
  const a11y = label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }
  if (kind === 'secret') {
    const px = size === 'nav' ? 9 : 14
    return (
      <svg className={`pm-marker pm-marker--secret pm-marker--${size}`} width={px} height={px} viewBox="0 0 14 14" {...a11y}>
        <path d="M7 1.4 13.2 12.4H.8Z" fill="var(--pm-error)" stroke="var(--pm-error)" strokeWidth="1.2" strokeLinejoin="round" />
        {size === 'page' ? <path d="M7 5.2v3.4M7 10.4v.1" stroke="var(--pm-on-error)" strokeWidth="1.5" strokeLinecap="round" /> : null}
      </svg>
    )
  }
  return <span className={`pm-marker pm-marker--dot pm-marker--${kind} pm-marker--${size}`} {...a11y} />
}

export const statusMarkerCss = `
.pm-marker { display: inline-block; flex-shrink: 0; vertical-align: middle; }
.pm-marker--dot { width: 8px; height: 8px; border-radius: 999px; }
.pm-marker--dot.pm-marker--nav { width: 7px; height: 7px; }
.pm-marker--pending { background: var(--pm-warn); }
.pm-marker--ok { background: var(--pm-success); }
.pm-marker--error { background: var(--pm-error); }
.pm-marker--done { background: var(--pm-caption); }
`

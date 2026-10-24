/**
 * 体检横幅（DESIGN.md「Health Banner」）：浅灰底、圆角 16px、不描边——用色块和设置卡片的描边区分「状态」与「设置」。
 * 左边状态标记 + 一句结论，下面一行最近体检时间；右边动作（「立即体检」「打开记忆页」）。
 */
import type { ReactNode } from 'react'
import { StatusMarker, type MarkerKind } from './StatusMarker.tsx'

export interface HealthBannerProps {
  marker: MarkerKind
  /** 一句结论，例如「有 2 处冲突等你决定」。标记的状态靠这句文字兜底。 */
  conclusion: ReactNode
  /** 例如「上次体检：10 月 17 日」。 */
  detail?: ReactNode
  actions?: ReactNode
}

export function HealthBanner({ marker, conclusion, detail, actions }: HealthBannerProps) {
  return (
    <section className="pm-banner">
      <div className="pm-banner-main">
        <p className="pm-banner-title"><StatusMarker kind={marker} />{conclusion}</p>
        {detail !== undefined ? <p className="pm-banner-detail">{detail}</p> : null}
      </div>
      {actions !== undefined ? <div className="pm-banner-actions">{actions}</div> : null}
    </section>
  )
}

export const healthBannerCss = `
.pm-banner {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 14px 16px; border-radius: var(--dsw-radius-lg, 16px); background: var(--pm-bg-block);
}
.pm-banner-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pm-banner-title { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); }
.pm-banner-detail { margin: 0 0 0 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-banner-actions { display: flex; gap: 8px; flex-shrink: 0; }
`

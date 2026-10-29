/**
 * 插槽根的外壳：提供网关与翻译函数，套上 `.pm-root`（令牌在它上面定义），并随组件渲染一个 `<style>`——
 * 卸载即移除，不往 document.head 里留东西。每个插槽根各套一层；同时挂多个插槽时样式重复几份，内容相同、无副作用。
 */
import type { ReactNode } from 'react'
import { GatewayProvider, type MemoryGateway } from '../gateway.ts'
import { TranslateProvider, type Translate } from '../i18n.tsx'
import { adviceCss } from './Advice.tsx'
import { buttonCss } from './Button.tsx'
import { chipCss } from './Chip.tsx'
import { conflictRulingCss } from './ConflictRuling.tsx'
import { contextBudgetBarCss } from './ContextBudgetBar.tsx'
import { dismissButtonCss } from './DismissButton.tsx'
import { emptyStateCss } from './EmptyState.tsx'
import { healthBannerCss } from './HealthBanner.tsx'
import { memoryCardCss } from './MemoryCard.tsx'
import { motionCss } from './motion.tsx'
import { segmentedCss } from './Segmented.tsx'
import { settingsCss } from './Settings.tsx'
import { statusMarkerCss } from './StatusMarker.tsx'
import { themeCss } from './theme.ts'

export const PM_CSS = [
  themeCss, buttonCss, chipCss, statusMarkerCss, memoryCardCss, adviceCss, conflictRulingCss, contextBudgetBarCss,
  dismissButtonCss, emptyStateCss, healthBannerCss, motionCss, segmentedCss, settingsCss,
].join('')

export function PanelShell({ gateway, t, className, children, extraCss = '' }: {
  gateway: MemoryGateway
  t: Translate
  className?: string
  /** 某个插槽根自己的样式（如记忆页布局）。 */
  extraCss?: string
  children: ReactNode
}) {
  return (
    <GatewayProvider value={gateway}>
      <TranslateProvider value={t}>
        <div className={className === undefined ? 'pm-root' : `pm-root ${className}`}>
          <style data-plastic-memory="">{PM_CSS + extraCss}</style>
          {children}
        </div>
      </TranslateProvider>
    </GatewayProvider>
  )
}

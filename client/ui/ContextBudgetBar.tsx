/**
 * 上下文用量条（DESIGN.md「Context Budget Bar」）：6px 高，三段（本项目银藤、全局浅银藤、固定说明 caption 灰），
 * 三段之和就是总用量；右上「N 条 · 约 used / budget」，下面一行图例带数字，右边写状态。
 * 自动放宽模式下超出上限：满格换成当前档（上限 × (1 + 0.25n)），一条细线标出用户设的上限。
 * 快满时不变色，琥珀和红不进这条。token 是插件估算，所以带「约」。
 */
import { formatNumber, useT } from '../i18n.tsx'

export interface ContextBudgetBarProps {
  count: number
  budget: number
  tokens: { workspace: number; global: number; fixed: number }
  /** 计入上限的用量（会话视图的 usedTokens，固定尾注不计）；缺省按三段之和。是否放宽、放宽到哪一档按它算。 */
  limitTokens?: number
  /** 严格模式下没带入的记忆条数；> 0 时状态写「已到上限，N 条没带入 · 处理 ›」。 */
  droppedCount?: number
  onHandle?: () => void
}

/** 自动放宽的当前档：总量没超上限就是上限本身。 */
export function relaxedCap(total: number, budget: number): number {
  if (budget <= 0 || total <= budget) return budget
  return budget * (1 + 0.25 * Math.ceil((total - budget) / (budget * 0.25)))
}

/**
 * 用量条满格的刻度：按计入上限的用量（limited）放宽到的档；三段之和（used，含固定说明）更大时取三段之和，三段不溢出条外。
 * 记忆页右侧栏的用量条和输入框弹层的三段条共用。
 */
export function barScale(used: number, limited: number, budget: number): number {
  return Math.max(relaxedCap(limited, budget), used, 1)
}

export function ContextBudgetBar({ count, budget, tokens, limitTokens, droppedCount = 0, onHandle }: ContextBudgetBarProps) {
  const t = useT()
  const used = tokens.workspace + tokens.global + tokens.fixed
  const limited = limitTokens ?? used
  const cap = relaxedCap(limited, budget)
  const scale = barScale(used, limited, budget)
  const pct = (n: number) => `${(n / scale) * 100}%`
  const relaxed = limited > budget && droppedCount === 0
  return (
    <div className="pm-budget">
      <div className="pm-budget-summary">
        {t('budget.summary', { count: formatNumber(count), used: formatNumber(used), budget: formatNumber(budget) })}
      </div>
      <div
        className="pm-budget-bar"
        role="img"
        aria-label={t('budget.aria', {
          percent: Math.round((used / Math.max(budget, 1)) * 100),
          workspace: formatNumber(tokens.workspace), global: formatNumber(tokens.global), fixed: formatNumber(tokens.fixed),
        })}
      >
        <i className="pm-budget-seg pm-budget-seg--workspace" style={{ width: pct(tokens.workspace) }} />
        <i className="pm-budget-seg pm-budget-seg--global" style={{ width: pct(tokens.global) }} />
        <i className="pm-budget-seg pm-budget-seg--fixed" style={{ width: pct(tokens.fixed) }} />
        {relaxed ? <b className="pm-budget-limit" style={{ left: pct(budget) }} /> : null}
      </div>
      <div className="pm-budget-legend">
        <span>
          {t('budget.workspace', { n: formatNumber(tokens.workspace) })}
          <i className="pm-sep" aria-hidden="true">·</i>
          {t('budget.global', { n: formatNumber(tokens.global) })}
          <i className="pm-sep" aria-hidden="true">·</i>
          {t('budget.fixed', { n: formatNumber(tokens.fixed) })}
        </span>
        <span className="pm-budget-status">
          {droppedCount > 0
            ? (
              <>
                {t('budget.truncated', { n: formatNumber(droppedCount) })}
                {onHandle !== undefined
                  ? <><i className="pm-sep" aria-hidden="true">·</i><button type="button" className="pm-link" onClick={onHandle}>{t('budget.handle')}</button></>
                  : null}
              </>
            )
            : relaxed ? t('budget.relaxed', { cap: formatNumber(cap) }) : t('budget.allIn')}
        </span>
      </div>
    </div>
  )
}

export const contextBudgetBarCss = `
.pm-budget { display: flex; flex-direction: column; gap: 6px; }
.pm-budget-summary { align-self: flex-end; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-budget-bar { position: relative; display: flex; gap: 2px; height: 6px; border-radius: 6px; background: var(--pm-track); overflow: hidden; }
.pm-budget-seg { display: block; height: 100%; }
.pm-budget-seg--workspace { background: var(--pm-accent); }
.pm-budget-seg--global { background: var(--pm-accent-soft); }
.pm-budget-seg--fixed { background: var(--pm-caption); }
.pm-budget-limit { position: absolute; top: 0; bottom: 0; width: 1px; margin-left: -.5px; background: var(--pm-text); }
.pm-budget-legend { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
`

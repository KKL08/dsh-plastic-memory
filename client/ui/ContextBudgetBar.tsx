/**
 * 上下文用量条（DESIGN.md「Context Budget Bar」）：6px 高，三段（本项目银藤、全局浅银藤、固定说明 caption 灰）。
 * 右上「N 条 · 约 used / budget」的分子是计入上限的用量（会话视图的 usedTokens），不是三段之和：
 * 固定说明里只有标题和分组标题计入上限，导航图与固定尾注不计。固定说明段因此前面实色（标题）、后面斜纹（不计上限），
 * 下面一行是图例（色块 + 名称 + 数字），右边写状态。
 * 自动放宽模式下超出上限：满格换成当前档（上限 × (1 + 0.25n)），一条细线标出用户设的上限。
 * 快满时不变色，琥珀和红不进这条。token 是插件估算，所以带「约」。
 * 输入框弹层的三段条与明细共用这里的拆分、色段和色块。
 */
import { formatNumber, useT } from '../i18n.tsx'

interface BudgetUsage {
  /** 三段：本项目、全局、固定说明（标题、导航图、固定尾注）。 */
  tokens: { workspace: number; global: number; fixed: number }
  /** 计入上限的用量：两段记忆加标题和分组标题。 */
  usedTokens: number
}

/** 图例与明细的四项，也是色块的着色类名后缀。 */
export type BudgetPartKey = 'workspace' | 'global' | 'headings' | 'uncounted'
const BUDGET_PART_KEYS: readonly BudgetPartKey[] = ['workspace', 'global', 'headings', 'uncounted']

export interface BudgetParts extends Record<BudgetPartKey, number> {
  /** 三段之和：实际放进上下文的量。 */
  total: number
  /** 计入上限的量，即 usedTokens。 */
  counted: number
}

/** 会话视图契约不带固定说明的拆分：标题 = usedTokens − 两段记忆，不计上限 = 三段之和 − usedTokens。 */
export function budgetParts({ tokens, usedTokens }: BudgetUsage): BudgetParts {
  const { workspace, global, fixed } = tokens
  const headings = Math.min(Math.max(usedTokens - workspace - global, 0), fixed)
  return { total: workspace + global + fixed, counted: usedTokens, workspace, global, headings, uncounted: fixed - headings }
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

/** 条内三段（为 0 的段不画）：固定说明段里标题实色在前、不计上限的斜纹在后，按 token 分宽。 */
export function BudgetSegments({ parts, scale }: { parts: BudgetParts; scale: number }) {
  const pct = (n: number) => `${(n / scale) * 100}%`
  const fixed = parts.headings + parts.uncounted
  return (
    <>
      {parts.workspace > 0 ? <i className="pm-budget-seg pm-budget-tint--workspace" style={{ width: pct(parts.workspace) }} /> : null}
      {parts.global > 0 ? <i className="pm-budget-seg pm-budget-tint--global" style={{ width: pct(parts.global) }} /> : null}
      {fixed > 0
        ? (
          <i className="pm-budget-seg pm-budget-seg--fixed" style={{ width: pct(fixed) }}>
            {parts.headings > 0 ? <i className="pm-budget-tint--headings" style={{ flexGrow: parts.headings }} /> : null}
            {parts.uncounted > 0 ? <i className="pm-budget-tint--uncounted" style={{ flexGrow: parts.uncounted }} /> : null}
          </i>
        )
        : null}
    </>
  )
}

export function BudgetSwatch({ part }: { part: BudgetPartKey }) {
  return <i className={`pm-budget-swatch pm-budget-tint--${part}`} aria-hidden="true" />
}

/** 图例与明细列哪几项：本项目、全局总列；标题、不计上限为 0 时不列。 */
export function shownParts(parts: BudgetParts): BudgetPartKey[] {
  return BUDGET_PART_KEYS.filter(key => key === 'workspace' || key === 'global' || parts[key] > 0)
}

export interface ContextBudgetBarProps extends BudgetUsage {
  count: number
  budget: number
  /** 严格模式下没带入的记忆条数；> 0 时状态写「已到上限，N 条没带入 · 处理 ›」。 */
  droppedCount?: number
  onHandle?: () => void
}

export function ContextBudgetBar({ count, budget, tokens, usedTokens, droppedCount = 0, onHandle }: ContextBudgetBarProps) {
  const t = useT()
  const parts = budgetParts({ tokens, usedTokens })
  const cap = relaxedCap(parts.counted, budget)
  const scale = barScale(parts.total, parts.counted, budget)
  const relaxed = parts.counted > budget && droppedCount === 0
  return (
    <div className="pm-budget">
      <div className="pm-budget-summary">
        {t('budget.summary', { count: formatNumber(count), used: formatNumber(parts.counted), budget: formatNumber(budget) })}
      </div>
      <div
        className="pm-budget-bar"
        role="img"
        aria-label={t(parts.headings > 0 ? 'budget.aria' : 'budget.ariaNoHeadings', {
          percent: Math.round((parts.counted / Math.max(budget, 1)) * 100),
          workspace: formatNumber(parts.workspace), global: formatNumber(parts.global),
          headings: formatNumber(parts.headings), uncounted: formatNumber(parts.uncounted),
        })}
      >
        <BudgetSegments parts={parts} scale={scale} />
        {relaxed ? <b className="pm-budget-limit" style={{ left: `${(budget / scale) * 100}%` }} /> : null}
      </div>
      <div className="pm-budget-legend">
        <span className="pm-budget-keys">
          {shownParts(parts).map(key => (
            <span key={key} className="pm-budget-key">
              <BudgetSwatch part={key} />
              {t(key === 'uncounted' ? 'budget.keyUncounted' : 'budget.key', { name: t(`budget.part.${key}`), n: formatNumber(parts[key]) })}
            </span>
          ))}
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
.pm-budget-seg--fixed { display: flex; }
.pm-budget-seg--fixed > i { display: block; flex-basis: 0; min-width: 0; }
.pm-budget-tint--workspace { background: var(--pm-accent); }
.pm-budget-tint--global { background: var(--pm-accent-soft); }
.pm-budget-tint--headings { background: var(--pm-caption); }
/* 不计上限：caption 灰斜纹，空隙透出底轨（色块里透出面板底） */
.pm-budget-tint--uncounted { background: repeating-linear-gradient(-45deg, var(--pm-caption) 0 1.5px, transparent 1.5px 3.5px); }
.pm-budget-limit { position: absolute; top: 0; bottom: 0; width: 1px; margin-left: -.5px; background: var(--pm-text); }
/* 图例项和状态同排换行：窄栏里四项排不下时状态跟在最后一行，仍靠右 */
.pm-budget-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-budget-keys { display: contents; }
.pm-budget-status { margin-left: auto; }
.pm-budget-key { display: inline-flex; align-items: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pm-budget-swatch { display: inline-block; flex: none; width: 8px; height: 8px; margin-right: 6px; border-radius: 2px; }
.pm-budget-swatch.pm-budget-tint--uncounted { outline: .5px solid var(--pm-caption); outline-offset: -.5px; }
`

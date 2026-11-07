/**
 * 「整理所选」的工作区：记忆查看多选后点「整理所选…」，列表换成这一块（页头、状态条、三段切换照旧）。
 * 标题「整理所选的 N 条」，右上「返回列表」（回到多选，勾选保留），下面步骤条「写要求 / 看计划 / 对照应用」。
 * 工作区拿的是点下那一刻的卡片快照（含作用域和版本），之后视图刷新不改它：各步按快照显示原文，命令带快照里的版本核对。
 */
import { useEffect, useId, useRef } from 'react'
import { scopeOfMemory, type MemoryCard, type Scope } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'
import { baseOf } from '../pending/cards.tsx'
import { Button } from '../ui/Button.tsx'

/** 选中的一条：卡片快照，和命令里引用它的那一份（作用域、版本）。 */
export interface BatchItem {
  memory: MemoryCard
  ref: { memoryId: string; layer: Scope | undefined; base: { updatedAt: number; digest: string } }
}

export const toBatchItems = (memories: readonly MemoryCard[]): BatchItem[] =>
  memories.map(memory => ({ memory, ref: { memoryId: memory.id, layer: scopeOfMemory(memory), base: baseOf(memory) } }))

export const BATCH_STEPS = ['request', 'plan', 'apply'] as const
export type BatchStep = typeof BATCH_STEPS[number]

/** 步骤条：当前步加粗，之前的步前加「✓」。 */
export function BatchSteps({ current }: { current: BatchStep }) {
  const t = useT()
  const at = BATCH_STEPS.indexOf(current)
  return (
    <ol className="pm-batch-steps" aria-label={t('library.batch.steps')}>
      {BATCH_STEPS.map((step, i) => (
        <li
          key={step}
          className={['pm-batch-step', i === at ? 'pm-batch-step--current' : '', i < at ? 'pm-batch-step--done' : ''].filter(Boolean).join(' ')}
          aria-current={i === at ? 'step' : undefined}
        >
          {i < at ? <span aria-hidden="true">✓</span> : null}
          {t(`library.batch.step.${step}`)}
        </li>
      ))}
    </ol>
  )
}

export function BatchEdit({ items, onBack }: {
  items: readonly BatchItem[]
  /** 回到多选，勾选保留。 */
  onBack: () => void
}) {
  const t = useT()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  // 列表整块换掉了：焦点接到标题上，不掉到页面上
  useEffect(() => { title.current?.focus() }, [])
  return (
    <section className="pm-batch" aria-labelledby={titleId}>
      <div className="pm-batch-head">
        <h3 ref={title} id={titleId} className="pm-batch-title" tabIndex={-1}>{t('library.batch.title', { n: items.length })}</h3>
        <Button variant="ghost" onClick={onBack}>{t('library.batch.back')}</Button>
      </div>
      <BatchSteps current="request" />
    </section>
  )
}

export const batchEditCss = `
.pm-batch { display: flex; flex-direction: column; gap: 16px; }
.pm-batch-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pm-batch-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; color: var(--pm-text); outline: none; }
.pm-batch-steps { display: flex; flex-wrap: wrap; gap: 6px 20px; margin: 0; padding: 0; list-style: none; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-batch-step { display: inline-flex; gap: 4px; }
.pm-batch-step--current { font-weight: 600; color: var(--pm-text); }
`

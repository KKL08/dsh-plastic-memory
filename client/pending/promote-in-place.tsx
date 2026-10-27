/**
 * 新写入的提升候选就地处理（对话交付卡、右侧栏「这次新写入的」共用）：元信息带「可提升为全局」，下方「留在本项目」「提升为全局」。
 * 提升按记忆 id 发 promote-memory，留下发 keep-local-memory，都带这条所在的层；服务端认领这条的提升候选条目再做，
 * 不进待处理、不亮圆点。跨项目确认、失败原话沿用待处理卡（useItemAction）；别处正在处理或刚处理完时原位写「没有生效」。
 * 处理过的（这里、另一处或待处理里）换成结果 chip「已提升为全局」「留在本项目」，不再有按钮：状态读全部记忆视图，
 * 视图跟上之前用这次的结果。
 */
import { useState, type ReactNode } from 'react'
import type { GuiLayerRef, MemoryCard } from '../../src/gui/contract.ts'
import type { BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { ActionFeedback, useItemAction } from './action.tsx'

export type InPlacePromotion = 'candidate' | 'kept-local' | 'promoted'

/**
 * 全部记忆视图里这条新写入的记忆此刻的提升状态。新写入的总在项目里（模型没有直写全局的通道），在全局层就是提升过了。
 * 体检关闭时视图不标候选，这里也就不提示。
 */
export function promotionOf(card: MemoryCard | undefined): InPlacePromotion | undefined {
  if (card === undefined) return undefined
  return card.scope === 'global' ? 'promoted' : card.promotion
}

/** chip 放进记忆卡元信息末尾；controls 放在记忆卡下面（按钮、跨项目确认、失败原话、没有生效）。 */
export function usePromoteInPlace(session: BorrowedSession, memory: MemoryCard, layer: GuiLayerRef | undefined, state: InPlacePromotion | undefined): {
  chip: ReactNode
  controls: ReactNode
} {
  const t = useT()
  const [done, setDone] = useState<'promoted' | 'kept-local' | undefined>(undefined)
  const [isRefused, setRefused] = useState(false)
  const action = useItemAction(
    session,
    (command) => { setDone(command.cmd === 'promote-memory' ? 'promoted' : 'kept-local') },
    () => { setRefused(true) },
  )
  const shown = done ?? state
  const run = (cmd: 'promote-memory' | 'keep-local-memory') => {
    setRefused(false)
    action.run({ cmd, memoryId: memory.id, layer })
  }
  const chip = shown === 'candidate' ? <Chip variant="status" tone="warn">{t('pending.promote.candidate')}</Chip>
    : shown === 'promoted' ? <Chip variant="result">{t('pending.result.promoted')}</Chip>
    : shown === 'kept-local' ? <Chip variant="result">{t('pending.result.keptLocal')}</Chip>
    : null
  const controls = (
    <>
      {shown === 'candidate'
        ? (
          <div className="pm-pending-actions pm-promote-actions">
            <Button unavailable={action.unavailable} onClick={() => { run('keep-local-memory') }}>{t('pending.promote.keepLocal')}</Button>
            <Button unavailable={action.unavailable} onClick={() => { run('promote-memory') }}>{t('pending.promote.global')}</Button>
          </div>
        )
        : null}
      {isRefused ? <p className="pm-pending-text" role="alert" tabIndex={-1}>{t('pending.refused', { title: memory.name })}</p> : null}
      <ActionFeedback action={action} />
    </>
  )
  return { chip, controls }
}

/** 两处的行都窄，按钮用列表行尾的小号；失败原话同待处理卡，用正文色。 */
export const promoteInPlaceCss = `
.pm-promote-actions .pm-btn { padding: 2px 10px; font-size: 12px; }
.pm-pending-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
`

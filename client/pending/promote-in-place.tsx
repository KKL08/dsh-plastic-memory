/**
 * 新写入的提升候选就地处理（对话交付卡、右侧栏「这次新写入的」共用）：元信息带「可提升为全局」，下方「留在本项目」「提升为全局」。
 * 提升按记忆 id 发 promote-memory（只认此刻仍是候选的），去处同待处理的提升卡跟着配置 globalPromoteTarget：写进 AGENTS.md 时
 * 按钮写「写进 AGENTS.md」，结果「已写进 AGENTS.md」、不可撤销（项目里那条进了最近删除，这一行由上层留着结果）；配置还没读到时提升暂不可用。
 * 留下发 keep-local-memory，都带这条所在的层；不进待处理、不亮圆点。
 * 跨项目确认、失败原话沿用待处理卡（useItemAction）；别处正在处理或刚处理完时原位写「没有生效」。
 * 处理过的（这里、另一处或待处理里）换成结果 chip「已提升为全局」「留在本项目」，不再有按钮：状态读全部记忆视图。
 * 这里处理的，结果旁带「撤销」（按这次的 decisionId 发 undo，同待处理的结果卡），撤销后回到候选；
 * 这次的结果只顶到视图下一次变化为止，之后（含别处撤销、模型重新标记）跟着视图走。
 */
import { useState, type ReactNode } from 'react'
import type { GuiLayerRef, MemoryCard, MemoryCommand } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession, type PluginConfig } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { ActionFeedback, useItemAction } from './action.tsx'

/** wrote-agents-md 不来自视图（记忆已离开视图），由上层按这里的回调记着。 */
export type InPlacePromotion = 'candidate' | 'kept-local' | 'promoted' | 'wrote-agents-md'

/**
 * 全部记忆视图里这条新写入的记忆此刻的提升状态。新写入的总在项目里（模型没有直写全局的通道），在全局层就是提升过了。
 * 体检关闭时视图不标候选，这里也就不提示。
 */
export function promotionOf(card: MemoryCard | undefined): InPlacePromotion | undefined {
  if (card === undefined) return undefined
  return card.scope === 'global' ? 'promoted' : card.promotion
}

/** 就地提升发出的命令，去处按配置 governance.globalPromoteTarget。 */
export function inPlacePromoteCommand(memoryId: string, layer: GuiLayerRef | undefined, target: PluginConfig['globalPromoteTarget']): MemoryCommand {
  return { cmd: 'promote-memory', memoryId, layer, isCandidateRequired: true, ...(target === 'agents-md' ? { target: 'agents-md' as const } : {}) }
}

type Verdict = Exclude<InPlacePromotion, 'candidate'>

/** chip 放进记忆卡元信息末尾（结果 chip 后带「撤销」）；controls 放在记忆卡下面（按钮、跨项目确认、失败原话、没有生效）。 */
export function usePromoteInPlace(
  session: BorrowedSession, memory: MemoryCard, layer: GuiLayerRef | undefined, state: InPlacePromotion | undefined,
  /** 写进了 AGENTS.md：上层记下，记忆离开视图后这一行仍留着结果。 */
  onWroteAgentsMd?: () => void,
): {
  chip: ReactNode
  controls: ReactNode
} {
  const t = useT()
  const promoteTarget = useGateway().useConfig()?.globalPromoteTarget
  /** 这里做的决定，撤销用；decisionId 缺省（旧服务端）时不给撤销。 */
  const [decided, setDecided] = useState<{ verdict: Verdict; decisionId: string | undefined } | undefined>(undefined)
  /** 这次操作的结果，视图跟上之前顶着用。 */
  const [local, setLocal] = useState<InPlacePromotion | undefined>(undefined)
  const [isRefused, setRefused] = useState(false)
  // 视图一变就以视图为准；别处撤销、重新标记后这里的决定也不再算数
  const [seenState, setSeenState] = useState(state)
  if (seenState !== state) {
    setSeenState(state)
    setLocal(undefined)
    if (decided !== undefined && state !== decided.verdict) setDecided(undefined)
  }
  const action = useItemAction(
    session,
    (command, result) => {
      if (command.cmd === 'undo') {
        setDecided(undefined)
        setLocal('candidate')
        return
      }
      const verdict: Verdict = command.cmd !== 'promote-memory' ? 'kept-local' : command.target === 'agents-md' ? 'wrote-agents-md' : 'promoted'
      // 写进 AGENTS.md 不可撤销（同待处理卡）
      setDecided({ verdict, decisionId: verdict === 'wrote-agents-md' ? undefined : result.decisionId })
      setLocal(verdict)
      if (verdict === 'wrote-agents-md') onWroteAgentsMd?.()
    },
    () => { setRefused(true) },
  )
  const shown = local ?? state
  const run = (command: MemoryCommand) => {
    setRefused(false)
    action.run(command)
  }
  const undoId = decided !== undefined && shown === decided.verdict ? decided.decisionId : undefined
  const undo = undoId !== undefined
    ? (
      <Button variant="ghost" className="pm-promote-undo" unavailable={action.unavailable} onClick={() => { run({ cmd: 'undo', decisionId: undoId }) }}>
        {t('pending.undo')}
      </Button>
    )
    : null
  const chip = shown === 'candidate' ? <Chip variant="status" tone="warn">{t('pending.promote.candidate')}</Chip>
    : shown === 'promoted' ? <><Chip variant="result">{t('pending.result.promoted')}</Chip>{undo}</>
    : shown === 'kept-local' ? <><Chip variant="result">{t('pending.result.keptLocal')}</Chip>{undo}</>
    : shown === 'wrote-agents-md' ? <Chip variant="result">{t('pending.result.wroteAgentsMd')}</Chip>
    : null
  const controls = (
    <>
      {shown === 'candidate'
        ? (
          <div className="pm-pending-actions pm-promote-actions">
            <Button unavailable={action.unavailable} onClick={() => { run({ cmd: 'keep-local-memory', memoryId: memory.id, layer }) }}>{t('pending.promote.keepLocal')}</Button>
            <Button
              unavailable={action.unavailable ?? (promoteTarget === undefined ? t('pending.promote.configLoading') : undefined)}
              onClick={() => { if (promoteTarget !== undefined) run(inPlacePromoteCommand(memory.id, layer, promoteTarget)) }}
            >
              {t(promoteTarget === 'agents-md' ? 'pending.promote.agentsMd' : 'pending.promote.global')}
            </Button>
          </div>
        )
        : null}
      {isRefused ? <p className="pm-pending-text" role="alert" tabIndex={-1}>{t('pending.refused', { title: memory.name })}</p> : null}
      <ActionFeedback action={action} />
    </>
  )
  return { chip, controls }
}

/** 两处的行都窄，按钮用列表行尾的小号，「撤销」贴着结果 chip；失败原话、没有生效同待处理卡，用正文色，只管这两处的行。 */
export const promoteInPlaceCss = `
.pm-promote-actions .pm-btn { padding: 2px 10px; font-size: 12px; }
.pm-mc-meta .pm-promote-undo { margin-left: 4px; padding: 0 6px; font-size: 12px; line-height: 18px; }
:is(.pm-saved-row, .pm-side-saved) :is(.pm-pending-error, .pm-pending-text) { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
`

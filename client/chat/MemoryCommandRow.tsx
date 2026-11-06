/**
 * 面板发的 `/memory` 命令在对话里的那一行（`conversation.chat.commandview`，key = memory）。外观和记忆工具行一致，
 * 只有一行、不展开：反馈已在面板里原位给过，这里只留个痕迹。失败也是次文字色，写「没有成功」和原因。
 */
import { useMemo } from 'react'
import { maskSecrets } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'
import { Icon } from '../ui/Icon.tsx'
import { commandLine, type CommandOutcome } from './command-summary.ts'
import { memoryToolRowCss, type HostTranslate } from './MemoryToolRow.tsx'

const NOTE_KEYS = { awaiting: 'chat.command.awaiting', elsewhere: 'chat.command.elsewhere', busy: 'chat.command.busy' } as const

/** 宿主 CommandRowOwnerProps.node（CommandNode）里用到的字段。 */
export interface MemoryCommandNode {
  name: string | null
  args: string | null
  outcome: CommandOutcome
}

export function MemoryCommandRow({ node, hostT }: { node: MemoryCommandNode; hostT: HostTranslate }) {
  const t = useT()
  const line = useMemo(() => commandLine(node.args, node.outcome), [node.args, node.outcome])
  const text = useMemo(() => {
    const action = line.action === undefined ? t('chat.command.unknown') : t(line.action.key, line.action.params)
    if (line.state === 'error') {
      const reason = typeof line.reason === 'string' ? line.reason : t(line.reason.key, line.reason.params)
      return reason === '' ? t('chat.command.failed.noReason', { action }) : t('chat.command.failed', { action, reason })
    }
    if (line.state === 'running') return t('chat.command.running', { action })
    return line.note === undefined ? action : t(NOTE_KEYS[line.note], { action })
  }, [line, t])
  const status = line.state === 'running' ? 'row.running' : line.state === 'error' ? 'row.failed' : undefined
  return (
    <div className="pm-tr" data-command={node.name ?? undefined} data-state={line.state}>
      <style>{memoryToolRowCss}</style>
      {status !== undefined ? <span className="pm-tr-sr">{hostT(status)}</span> : null}
      <div className="pm-tr-disclosure">
        <div className="pm-tr-row">
          <span className="pm-tr-leading"><Icon name="sparkle" /></span>
          <span className="pm-tr-content">
            <span className="pm-tr-title">{t('chat.command.title')}</span>
            <span className="pm-tr-sep" aria-hidden="true" />
            <span className="pm-tr-summary">{maskSecrets(text, { severity: 'suspected' })}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

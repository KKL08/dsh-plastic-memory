/**
 * `/memory` 命令在对话里的那一行（`conversation.chat.commandview`，key = memory；面板发的、手敲的都走这里）。外观和
 * 记忆工具行一致：收起时一句话，反馈已在面板里原位给过，这里只留个痕迹，失败也是次文字色，写「没有成功」和原因；
 * 点开是完整的输入和返回（遮过密钥），手敲查询命令时看结果用。
 */
import { useCallback, useMemo, useState } from 'react'
import { useT } from '../i18n.tsx'
import { commandInput, commandLine, commandOutput, maskCard, type CommandOutcome } from './command-summary.ts'
import { RowView, type HostTranslate } from './MemoryToolRow.tsx'

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
  const [expanded, setExpanded] = useState(false)
  const toggle = useCallback(() => { setExpanded(value => !value) }, [])
  const input = useMemo(() => commandInput(node.args), [node.args])
  const output = useMemo(() => commandOutput(node.outcome), [node.outcome])
  return (
    <RowView
      attrs={node.name === null ? {} : { 'data-command': node.name }} state={line.state} title={t('chat.command.title')}
      summary={maskCard(text)} summaryClass="pm-tr-summary" input={input} output={output} isOutputError={false}
      expanded={expanded} toggle={toggle} hostT={hostT}
    />
  )
}

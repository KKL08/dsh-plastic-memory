/**
 * 九个记忆工具在折叠区里的行（`tool.call.toolview`，key = 工具名）。宿主绑定面：标记、类名结构和 CSS 照抄宿主
 * 通用工具行（ui-tool `GenericToolCard` → `ToolRow` → ui-primitives `DisclosureRow`，0.2.1-rc.2），图标、标题、
 * 输入 / 输出与运行状态的文案也用宿主的（`conversation` 命名空间），只把摘要换成一句话。
 * 没照抄的：运行中的 TextShimmer 扫光动画（只保留读屏用的状态文字）。
 * 摘要、输入、输出都先遮掉密钥片段再显示：参数是 agent 发的原文，没经过视图的遮盖。疑似密钥也遮（带 force 存下的
 * password= / api_key= 赋值），密钥一律不出现在对话卡里。
 */
import { useMemo, type KeyboardEvent } from 'react'
import { maskSecrets, type MaskOptions } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'
import { parseArgs, toolSummary, type MemoryToolName } from './tool-summary.ts'

const CARD_MASK: MaskOptions = { severity: 'suspected' }
const maskCard = (text: string) => maskSecrets(text, CARD_MASK)

/** 宿主 ToolResultNode 里用到的字段。 */
export interface ToolResultBlock {
  kind: 'tool-result'
  call: { name: string; argsRaw: string } | null
  content: readonly { type: string; text?: string }[]
  isError: boolean
  error?: { name: string; code: string }
}

/** 宿主 `tool.call.toolview` owner props（ToolCallOwnerProps）里用到的字段。 */
export type MemoryToolViewProps = {
  toolName: string
  useDisclosure: () => { readonly expanded: boolean; readonly toggle: () => void }
  inspect?: (() => void) | undefined
} & (
  | { phase: 'preparing'; block: unknown }
  | { phase: 'start'; block: { argsRaw: string } }
  | { phase: 'result'; block: ToolResultBlock }
)

/** 宿主 `conversation` 命名空间的翻译函数。 */
export type HostTranslate = (key: string) => string

type RowState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

/** 宿主 resultText：文本块原样，其他块转 JSON；失败且没有内容时写错误名与码。 */
function resultText(block: ToolResultBlock): string {
  const parts = block.content.map(b => (b.type === 'text' ? b.text ?? '' : JSON.stringify(b, null, 2)))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

function formatBody(argsRaw: string): string {
  try { return JSON.stringify(JSON.parse(argsRaw), null, 2) } catch { return argsRaw }
}

const firstLine = (text: string) => text.split('\n', 1)[0]!

const STATUS_KEY: Partial<Record<RowState, string>> = {
  preparing: 'row.preparing', running: 'row.running', error: 'row.failed', stopped: 'row.stopped',
}

const SparkleIcon = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" strokeWidth={1}>
    <path d="M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z" stroke="currentColor" />
    <path d="M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z" stroke="currentColor" />
    <path d="M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z" stroke="currentColor" />
  </svg>
)

const ChevronDown = ({ className }: { className?: string }) => (
  <svg width={14} height={14} className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true" strokeWidth={1}>
    <path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" stroke="currentColor" />
  </svg>
)

const ChevronUp = () => (
  <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" strokeWidth={1}>
    <path d="M12 10L8.70711 6.70711C8.31658 6.31658 7.68342 6.31658 7.29289 6.70711L4 10" stroke="currentColor" />
  </svg>
)

export function MemoryToolRow(props: MemoryToolViewProps & { hostT: HostTranslate }) {
  const { toolName, useDisclosure, inspect, hostT } = props
  const t = useT()
  const { expanded, toggle } = useDisclosure()
  const done = props.phase === 'result'
  const argsRaw = props.phase === 'result' ? props.block.call?.argsRaw ?? '' : props.phase === 'start' ? props.block.argsRaw : null
  const output = props.phase === 'result' ? maskCard(resultText(props.block)) || null : null
  const state: RowState = props.phase === 'preparing' ? 'preparing' : props.phase === 'start' ? 'running'
    : props.block.error?.code === 'interrupted' ? 'stopped' : props.block.isError ? 'error' : 'ok'

  const summaryText = useMemo(() => {
    if (state === 'error' && output !== null) return firstLine(output)
    const summary = toolSummary(toolName as MemoryToolName, parseArgs(argsRaw), done ? output ?? '' : null)
    if (summary === null) return ''
    const params = { ...summary.params }
    if (summary.scope !== undefined) params.scope = t(summary.scope.key, summary.scope.params)
    return maskCard(t(summary.key, params))
  }, [state, output, toolName, argsRaw, done, t])

  const bodyRaw = argsRaw === '' ? null : argsRaw
  const expandable = state !== 'preparing' && (bodyRaw !== null || output !== null)
  const open = expanded && expandable
  const status = STATUS_KEY[state]
  const title = hostT('tool.title.generic')
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    toggle()
  }
  const summaryClass = state === 'error' ? 'pm-tr-summary pm-tr-summary--error'
    : state === 'stopped' ? 'pm-tr-summary pm-tr-summary--stopped' : 'pm-tr-summary'

  return (
    <div className="pm-tr" data-tool={toolName} data-state={state}>
      <style>{memoryToolRowCss}</style>
      {status !== undefined ? <span className="pm-tr-sr">{hostT(status)}</span> : null}
      <div className="pm-tr-disclosure" data-open={open || undefined}>
        <div
          className="pm-tr-row"
          data-expandable={expandable || undefined}
          role={expandable ? 'button' : undefined}
          tabIndex={expandable ? 0 : undefined}
          aria-expanded={expandable ? open : undefined}
          onClick={expandable ? toggle : undefined}
          onKeyDown={expandable ? onKeyDown : undefined}
        >
          <span className="pm-tr-leading">
            {open ? <ChevronUp /> : expandable ? (
              <>
                <span className="pm-tr-icon-idle"><SparkleIcon /></span>
                <ChevronDown className="pm-tr-chevron-hover" />
              </>
            ) : <SparkleIcon />}
          </span>
          <span className="pm-tr-content">
            <span className="pm-tr-title">{title}</span>
            {summaryText !== '' ? (
              <>
                <span className="pm-tr-sep" aria-hidden="true" />
                <span className={summaryClass}>{summaryText}</span>
              </>
            ) : null}
          </span>
        </div>
        {open ? (
          <div className="pm-tr-body">
            <div className="pm-tr-io">
              {bodyRaw !== null ? (
                <div className="pm-tr-io-section">
                  <span className="pm-tr-io-label">{hostT('row.input')}</span>
                  <span className="pm-tr-io-text">{maskCard(formatBody(bodyRaw))}</span>
                </div>
              ) : null}
              {bodyRaw !== null && output !== null ? <span className="pm-tr-io-divider" aria-hidden="true" /> : null}
              {output !== null ? (
                <div className="pm-tr-io-section">
                  <span className="pm-tr-io-label">{hostT('row.output')}</span>
                  <span className="pm-tr-io-text" data-error={state === 'error' || undefined}>{output}</span>
                </div>
              ) : null}
            </div>
            {inspect !== undefined ? (
              <button type="button" className="pm-tr-inspect" onClick={inspect}>{hostT('row.inspect')}</button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** 照抄宿主 DisclosureRow.module.css + ToolRow.module.css 里通用行用到的规则，类名换成插件前缀。 */
export const memoryToolRowCss = `
.pm-tr { display: flex; flex-direction: column; }
.pm-tr-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.pm-tr-disclosure { display: flex; flex-direction: column; width: 100%; min-width: 0; }
.pm-tr-row {
  position: relative; overflow: hidden; display: flex; align-items: center;
  height: calc(24px + var(--dsh-content-font-delta, 0px)); min-width: 0;
  color: var(--dsw-alias-label-tertiary); transition: color 100ms ease;
}
.pm-tr-row[data-expandable] { cursor: pointer; }
.pm-tr-row:hover { color: var(--dsw-alias-label-secondary); }
.pm-tr-leading {
  position: relative; flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: calc(16px + var(--dsh-content-font-delta, 0px)); height: calc(16px + var(--dsh-content-font-delta, 0px));
  margin-right: 6px; color: inherit;
}
.pm-tr-leading svg { width: calc(14px + var(--dsh-content-font-delta, 0px)); height: calc(14px + var(--dsh-content-font-delta, 0px)); }
.pm-tr-icon-idle { display: inline-flex; opacity: 1; transition: opacity 100ms ease; }
.pm-tr-chevron-hover { position: absolute; inset: 0; margin: auto; opacity: 0; transition: opacity 100ms ease; }
.pm-tr-row:hover .pm-tr-icon-idle { opacity: 0; }
.pm-tr-row:hover .pm-tr-chevron-hover { opacity: 1; }
.pm-tr-content { display: flex; align-items: center; min-width: 0; max-width: 100%; }
.pm-tr-title {
  flex: none; font-weight: 400; font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: inherit;
}
.pm-tr-sep { flex: none; width: 2px; height: 2px; border-radius: 1px; margin: 0 8px; background: var(--dsw-alias-label-caption); }
.pm-tr-summary {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.pm-tr-summary--error { color: var(--dsw-alias-state-error-primary); }
.pm-tr-summary--stopped { color: var(--dsw-alias-state-warn-label); }
.pm-tr-body { display: flex; flex-direction: column; }
.pm-tr-io {
  display: flex; flex-direction: column; margin: 4px 0 4px 4px;
  border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-markdown-code-block); font: var(--dsw-font-markdown-code-block-small);
}
.pm-tr-io-section {
  display: grid; grid-template-columns: max-content 1fr; column-gap: 14px; align-items: baseline;
  padding: 12px 16px; max-height: 150px; overflow-y: auto;
}
.pm-tr-io-label { position: sticky; top: 0; align-self: start; color: var(--dsw-alias-label-caption); }
.pm-tr-io-divider { flex: none; height: 0.5px; background: var(--dsw-alias-border-l2); }
.pm-tr-io-text { min-width: 0; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary); }
.pm-tr-io-text[data-error] { color: var(--dsw-alias-state-error-primary); }
.pm-tr-inspect {
  display: inline-flex; align-self: flex-start; align-items: center; gap: 4px; margin: 4px 0 2px 4px; padding: 2px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: 999px; background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer;
  opacity: 0; transition: opacity 100ms ease;
}
.pm-tr:hover .pm-tr-inspect, .pm-tr-inspect:focus-visible { opacity: 1; }
.pm-tr-inspect:hover { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); }
@media (prefers-reduced-motion: reduce) { .pm-tr-row { transition: none; } }
`

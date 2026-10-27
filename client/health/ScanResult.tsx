/**
 * 体检的状态与结果行，记忆页页头「体检当前项目」和设置页状态卡「立即体检」共用。
 * 完成时写「体检完成：新增 N 条待处理 › · 新增 M 条建议 › · 查看分数 ›」（为 0 的段省略，都为 0 时「没有发现新问题 · 查看分数 ›」），
 * 宿主报了用量时这一行末尾写「本次用了约 N token」（实际用量，没报就不写）；
 * 体检的说明（内容检查没做完、分了几批、基线检查被跳过）附在后面；失败写原话并提示在对话里让 agent 体检。
 * 链接只给出要去的 tab 和待处理组，由调用方决定怎么去（页头在页内切换，设置页经导航直达记忆页）；体检本身原地跑，不自动跳转。
 * 命令回 busy（这个范围正在别处体检）不算失败：按钮显示「体检中…」并禁用，不写结果行；别处体检完重写了视图就恢复。
 * 新增建议落在建议整理组；新增待处理都在同一组时落在那一组，分在两组时落在待处理顶部。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryCommandResult } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { formatNumber, useT } from '../i18n.tsx'
import type { LegacyNavTarget } from '../nav.ts'

type Done = Extract<MemoryCommandResult, { ok: true }>
type ScanFailure = Extract<MemoryCommandResult, { ok: false }>
type ScanNote = NonNullable<Done['notes']>[number]

export type ScanState =
  | { kind: 'idle' }
  | { kind: 'running' }
  /** 范围正在别处体检（别的窗口、宿主进程或自动体检）：命令回 busy，这次没体检。 */
  | { kind: 'busy' }
  | { kind: 'done'; notes: readonly ScanNote[]; added: Done['added']; semanticBatches?: number; usageTokens?: number }
  | { kind: 'failed'; code: ScanFailure['code']; detail: string | undefined }

/** 发 `/memory scan` 并记下状态；组件卸载后回来的结果丢掉。 */
export function useScanCommand(session: BorrowedSession) {
  const gateway = useGateway()
  const [state, setState] = useState<ScanState>({ kind: 'idle' })
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  // 别处的体检做完会重写健康视图：读到新内容就不再显示「体检中…」
  const health = gateway.useView(session, 'health')
  const healthData = health.status === 'ready' ? health.data : undefined
  useEffect(() => { setState(s => (s.kind === 'busy' ? { kind: 'idle' } : s)) }, [healthData])
  const run = (workspacePath: string | undefined) => {
    if (session.kind !== 'ready') return
    setState({ kind: 'running' })
    void gateway.execute(session.sessionId, { cmd: 'scan', ...(workspacePath !== undefined ? { workspacePath } : {}) }).then((result) => {
      if (!live.current) return
      setState(result.ok
        ? {
            kind: 'done', notes: result.notes ?? [], added: result.added,
            ...(result.semanticBatches !== undefined ? { semanticBatches: result.semanticBatches } : {}),
            ...(result.usageTokens !== undefined ? { usageTokens: result.usageTokens } : {}),
          }
        : result.code === 'busy' ? { kind: 'busy' } : { kind: 'failed', code: result.code, detail: result.detail })
    })
  }
  return { state, run }
}

const Sep = () => <i className="pm-sep" aria-hidden="true">·</i>

/**
 * 完成或失败那一行的内容（放进调用方的 role=status 段落里）。
 * 体检关闭（命令返回 governance-disabled）写「体检已关闭」，off 是跟在后面的东西（页头的「去设置里打开 ›」）。
 */
export function ScanResult({ state, onOpen, off }: {
  state: Extract<ScanState, { kind: 'done' | 'failed' }>
  onOpen: (target: Pick<LegacyNavTarget, 'tab' | 'level'>) => void
  off?: ReactNode
}) {
  const t = useT()
  if (state.kind === 'failed') {
    if (state.code === 'governance-disabled') return <>{t('scan.off')}{off}</>
    const reason = state.code === 'llm-unavailable' ? t('scan.llmUnavailable') : t('scan.failed', { detail: state.detail ?? state.code })
    return <>{reason} {t('scan.askAgent')}</>
  }
  const link = (target: Pick<LegacyNavTarget, 'tab' | 'level'>, text: string) => <button type="button" className="pm-link" onClick={() => { onOpen(target) }}>{text}</button>
  const added = state.added
  const parts: ReactNode[] = []
  if (added !== undefined && added.pending > 0) {
    const level = added.pendingLevel
    parts.push(link({ tab: 'pending', ...(level !== undefined ? { level } : {}) }, t('scan.result.newPending', { n: formatNumber(added.pending) })))
  }
  // 英文单复数不同（中文两条同文）
  if (added !== undefined && added.advice > 0) parts.push(link({ tab: 'pending', level: 'advice' }, t(added.advice === 1 ? 'scan.result.newAdvice.one' : 'scan.result.newAdvice', { n: formatNumber(added.advice) })))
  parts.push(link({ tab: 'health' }, t('scan.result.scores')))
  return (
    <>
      {added === undefined
        // 旧服务端没给新增条数：只说做完了
        ? t('scan.done')
        : (
          <>
            {parts.length > 1 ? t('scan.result.done') : <>{t('scan.result.nothingNew')}<Sep /></>}
            {parts.map((part, i) => <span key={i}>{i > 0 ? <Sep /> : null}{part}</span>)}
          </>
        )}
      {state.usageTokens !== undefined
        // 用量连同前面的分隔点不拆行：放不下时整段折到下一行
        ? <span className="pm-scan-usage">{added === undefined ? null : <Sep />}{t('scan.usage', { n: formatNumber(state.usageTokens) })}</span>
        : null}
      {state.notes.includes('semantic-failed') ? <span className="pm-scan-note">{t('scan.note.semanticFailed')}</span> : null}
      {state.notes.includes('semantic-batched') && state.semanticBatches !== undefined
        ? <span className="pm-scan-note">{t('scan.note.semanticBatched', { n: formatNumber(state.semanticBatches) })}</span>
        : null}
      {state.notes.includes('baseline-session-scoped') ? <span className="pm-scan-note">{t('scan.note.baselineSessionScoped')}</span> : null}
    </>
  )
}

/**
 * 体检的状态与结果行，记忆页页头「体检当前项目」和设置页状态卡「立即体检」共用。
 * 完成时写「体检完成：新增 N 条待处理 › · 新增 M 条建议 › · 查看分数 ›」（为 0 的段省略，都为 0 时「没有发现新问题 · 查看分数 ›」），
 * 体检的说明（内容检查没做完、只查了一部分、基线检查被跳过）附在后面；失败写原话并提示在对话里让 agent 体检。
 * 链接只给出要去的 tab，由调用方决定怎么去（页头在页内切换，设置页经导航直达记忆页）；体检本身原地跑，不自动跳转。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryCommandResult } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { formatNumber, useT } from '../i18n.tsx'
import type { MemoryTab } from '../nav.ts'

type Done = Extract<MemoryCommandResult, { ok: true }>
type ScanFailure = Extract<MemoryCommandResult, { ok: false }>
type ScanNote = NonNullable<Done['notes']>[number]

export type ScanState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; notes: readonly ScanNote[]; added: Done['added'] }
  | { kind: 'failed'; code: ScanFailure['code']; detail: string | undefined }

/** 发 `/memory scan` 并记下状态；组件卸载后回来的结果丢掉。 */
export function useScanCommand(session: BorrowedSession) {
  const gateway = useGateway()
  const [state, setState] = useState<ScanState>({ kind: 'idle' })
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const run = (workspacePath: string | undefined) => {
    if (session.kind !== 'ready') return
    setState({ kind: 'running' })
    void gateway.execute(session.sessionId, { cmd: 'scan', ...(workspacePath !== undefined ? { workspacePath } : {}) }).then((result) => {
      if (!live.current) return
      setState(result.ok
        ? { kind: 'done', notes: result.notes ?? [], added: result.added }
        : { kind: 'failed', code: result.code, detail: result.detail })
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
  onOpen: (tab: MemoryTab) => void
  off?: ReactNode
}) {
  const t = useT()
  if (state.kind === 'failed') {
    if (state.code === 'governance-disabled') return <>{t('scan.off')}{off}</>
    const reason = state.code === 'llm-unavailable' ? t('scan.llmUnavailable') : t('scan.failed', { detail: state.detail ?? state.code })
    return <>{reason} {t('scan.askAgent')}</>
  }
  const link = (tab: MemoryTab, text: string) => <button type="button" className="pm-link" onClick={() => { onOpen(tab) }}>{text}</button>
  const added = state.added
  const parts: ReactNode[] = []
  if (added !== undefined && added.pending > 0) parts.push(link('pending', t('scan.result.newPending', { n: formatNumber(added.pending) })))
  if (added !== undefined && added.advice > 0) parts.push(link('pending', t('scan.result.newAdvice', { n: formatNumber(added.advice) })))
  parts.push(link('health', t('scan.result.scores')))
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
      {state.notes.includes('semantic-failed') ? <span className="pm-scan-note">{t('scan.note.semanticFailed')}</span> : null}
      {state.notes.includes('semantic-truncated') ? <span className="pm-scan-note">{t('scan.note.semanticTruncated')}</span> : null}
      {state.notes.includes('baseline-session-scoped') ? <span className="pm-scan-note">{t('scan.note.baselineSessionScoped')}</span> : null}
    </>
  )
}

/**
 * 记忆页（walking skeleton）：验证不绑定会话的主面板能否借一个会话读文件、发命令。
 * - 发：`ctx.remote.commands.execute(sessionId, '/memory ping', [])`，结果原样显示。
 * - 读：ping 结果里带 ping.json 的绝对路径（浏览器半侧不知道 memoryRoot），记下后用
 *   `dsh-resource://file/session/<sid>/<绝对路径>` 订阅版本，版本变了再经 workspaceFiles.read 读内容。
 */
import { useEffect, useState } from 'react'
import type { HostContext, RootStandardProps, SessionListState } from './host.ts'

const PATH_KEY = 'dsh-plastic-memory.gui.pingPath'

function loadPath(): string | undefined {
  try { return localStorage.getItem(PATH_KEY) ?? undefined } catch { return undefined }
}
function savePath(path: string): void {
  try { localStorage.setItem(PATH_KEY, path) } catch { /* 存不了就只在本页生效 */ }
}

/** 与宿主 sessionFileAddress 同一语法：逐段 encodeURIComponent，绝对路径的前导 / 留成空段。 */
export function fileAddress(sessionId: string, path: string): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':')
  return `dsh-resource://file/session/${enc(sessionId)}/${path.replace(/\\/g, '/').split('/').map(enc).join('/')}`
}

const STYLE = `
.pm-page { padding: 24px 32px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); height: 100%; overflow: auto; box-sizing: border-box; font-size: 13px; }
.pm-page h1 { font-size: 18px; font-weight: 600; margin: 0 0 16px; }
.pm-row { display: flex; gap: 8px; align-items: center; margin: 0 0 12px; flex-wrap: wrap; }
.pm-muted { color: var(--dsw-alias-label-secondary); }
.pm-btn { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 4px 12px; cursor: pointer; font: inherit; }
.pm-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pm-btn:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.pm-select { font: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 3px 8px; max-width: 420px; }
.pm-box { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 8px 12px; margin: 0 0 12px; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, monospace; font-size: 12px; }
`

export function createMemoryPage(ctx: HostContext) {
  return function MemoryPage({ useSessions, useResource }: RootStandardProps) {
    const list = useSessions((s: SessionListState) => s)
    const [picked, setPicked] = useState<string | undefined>(undefined)
    const [path, setPath] = useState<string | undefined>(loadPath)
    const [lastResult, setLastResult] = useState('')
    const [content, setContent] = useState('')

    const fallback = list.ids.find(id => list.byId[id]?.running) ?? list.ids[0]
    const sessionId = picked !== undefined && list.ids.includes(picked) ? picked : fallback
    const stat = useResource(sessionId !== undefined && path !== undefined ? fileAddress(sessionId, path) : '')
    const version = stat.value?.version

    useEffect(() => {
      if (sessionId === undefined || path === undefined || version === undefined) return
      let live = true
      void ctx.remote.workspaceFiles.read(sessionId, path, {}).then(r => {
        if (live) setContent(r.ok ? r.value.text : `read failed: ${r.error.code} ${r.error.message}`)
      })
      return () => { live = false }
    }, [sessionId, path, version])

    async function ping() {
      if (sessionId === undefined) return
      const startedAt = new Date().toISOString()
      try {
        const r = await ctx.remote.commands.execute(sessionId, '/memory ping', [])
        setLastResult(`${startedAt}\n${JSON.stringify(r, null, 2)}`)
        const text = r.ok && r.value?.result.kind === 'success' ? r.value.result.text : undefined
        const reported = text === undefined ? undefined : (JSON.parse(text) as { path?: unknown }).path
        if (typeof reported === 'string') { setPath(reported); savePath(reported) }
      } catch (err) {
        setLastResult(`${startedAt}\nthrown: ${String(err)}`)
      }
    }

    return (
      <div className="pm-page">
        <style>{STYLE}</style>
        <h1>Plastic Memory · walking skeleton</h1>
        {list.ids.length === 0
          ? <p className="pm-muted">没有会话（phase: {list.phase}）。开一个会话后这里可用。</p>
          : (
            <>
              <div className="pm-row">
                <span className="pm-muted">借用会话</span>
                <select className="pm-select" value={sessionId} onChange={e => setPicked(e.target.value)}>
                  {list.ids.map(id => (
                    <option key={id} value={id}>
                      {list.byId[id]?.running ? '● ' : '○ '}{list.byId[id]?.displayTitle ?? id}
                    </option>
                  ))}
                </select>
                <button type="button" className="pm-btn" onClick={() => void ping()}>/memory ping</button>
              </div>
              <p className="pm-muted">● = running。会话 {sessionId}，cwd {sessionId === undefined ? '' : list.byId[sessionId]?.cwd ?? '?'}</p>
            </>
          )}
        <div className="pm-muted">命令结果</div>
        <div className="pm-box">{lastResult || '（还没执行）'}</div>
        <div className="pm-muted">文件资源 {path ?? '（路径未知：先 ping 一次）'}</div>
        <div className="pm-box">
          {`status: ${stat.status}\nversion: ${version ?? '-'}${stat.failure ? `\nfailure: ${stat.failure.code} ${stat.failure.message}` : ''}\n\n${content}`}
        </div>
      </div>
    )
  }
}

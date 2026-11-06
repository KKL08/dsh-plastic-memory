// 借会话的挑选与项目归属：纯函数，按会话列表和服务端的归属对照断言挑中谁。
import { describe, expect, it } from 'vitest'
import { belongsTo, pickSession, workspaceOf } from './session-pick.ts'
import type { SessionListState, SessionSummary } from './host.ts'

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: id, running: false, updatedAt: 0, retainedBy: {}, ...patch }
}
function list(...rows: SessionSummary[]): SessionListState {
  return { ids: rows.map(r => r.id), byId: Object.fromEntries(rows.map(r => [r.id, r])), phase: 'ready' }
}

describe('pickSession：只有「无会话 / 有会话」两态', () => {
  it('一个会话都没有 → none', () => {
    expect(pickSession(list(), '/w/app')).toEqual({ kind: 'none' })
  })

  it('优先页面项目里最近更新的会话，其次当前选中，再其次最近更新的任一会话；子 agent 不借', () => {
    const rows = list(
      summary('old-app', { cwd: '/w/app', updatedAt: 1 }),
      summary('new-app', { cwd: '/w/app/', updatedAt: 5 }),
      summary('sub', { cwd: '/w/app', updatedAt: 9, origin: 'subagent' }),
      summary('selected', { cwd: '/w/other', updatedAt: 2, retainedBy: { mainView: 1 } }),
      summary('latest', { cwd: '/w/third', updatedAt: 8 }),
    )
    expect(pickSession(rows, '/w/app')).toEqual({ kind: 'ready', sessionId: 'new-app', cwd: '/w/app/' })
    expect(pickSession(rows, '/w/none')).toEqual({ kind: 'ready', sessionId: 'selected', cwd: '/w/other' })
    expect(pickSession(list(summary('a', { updatedAt: 1 }), summary('b', { updatedAt: 3 })), undefined))
      .toEqual({ kind: 'ready', sessionId: 'b', cwd: undefined })
  })

  it('历史会话（没在跑）照样能借', () => {
    expect(pickSession(list(summary('cold', { running: false })), undefined).kind).toBe('ready')
  })

  it('同一档里先借空闲的会话：项目里较旧的空闲会话胜过较新的、正在跑的', () => {
    const rows = list(
      summary('idle-app', { cwd: '/w/app', updatedAt: 1 }),
      summary('busy-app', { cwd: '/w/app', updatedAt: 5, running: true }),
    )
    expect(pickSession(rows, '/w/app')).toEqual({ kind: 'ready', sessionId: 'idle-app', cwd: '/w/app' })
    // 最后一档同理
    expect(pickSession(rows, undefined)).toEqual({ kind: 'ready', sessionId: 'idle-app', cwd: '/w/app' })
  })

  it('只有正在跑的会话时照样借，界面不至于不能用', () => {
    expect(pickSession(list(summary('busy', { cwd: '/w/app', running: true })), '/w/app'))
      .toEqual({ kind: 'ready', sessionId: 'busy', cwd: '/w/app' })
    expect(pickSession(list(summary('busy', { running: true })), undefined).kind).toBe('ready')
  })

  it('档位顺序不变：项目里正在跑的会话仍先于别处空闲的选中会话、最近会话；选中会话仍先于最近会话', () => {
    const rows = list(
      summary('busy-app', { cwd: '/w/app', updatedAt: 1, running: true }),
      summary('selected', { cwd: '/w/other', updatedAt: 2, retainedBy: { mainView: 1 } }),
      summary('latest', { cwd: '/w/third', updatedAt: 8 }),
    )
    expect(pickSession(rows, '/w/app')).toMatchObject({ sessionId: 'busy-app' })
    expect(pickSession(rows, '/w/none')).toMatchObject({ sessionId: 'selected' })
  })

  it('项目子目录里开的会话算这个项目的；共用前缀的兄弟目录不算', () => {
    const rows = list(
      summary('sub', { cwd: '/w/app/packages/core', updatedAt: 1 }),
      summary('sibling', { cwd: '/w/app-other', updatedAt: 9 }),
      summary('selected', { cwd: '/w/third', updatedAt: 2, retainedBy: { mainView: 1 } }),
    )
    expect(pickSession(rows, '/w/app')).toMatchObject({ sessionId: 'sub' })
    expect(pickSession(rows, '/w/app/')).toMatchObject({ sessionId: 'sub' })
    expect(pickSession(list(rows.byId.sibling!, rows.byId.selected!), '/w/app')).toMatchObject({ sessionId: 'selected' })
  })

  it('服务端记下的对照（原始 cwd → 项目）以它为准：软链接路径也算，cwd 在项目里、归属却是嵌套的子项目则不算', () => {
    const rows = list(
      summary('linked', { cwd: '/link/app', updatedAt: 1 }),
      summary('nested', { cwd: '/w/app/pkg', updatedAt: 9 }),
      summary('latest', { cwd: '/w/third', updatedAt: 5 }),
    )
    const map = { '/link/app': '/w/app', '/w/app/pkg': '/w/app/pkg' }
    expect(pickSession(rows, '/w/app', map)).toMatchObject({ sessionId: 'linked' })
    expect(pickSession(rows, '/w/app/pkg', map)).toMatchObject({ sessionId: 'nested' })
  })

  it('服务端没见过的会话按路径判断，取包含 cwd 的最深的已知项目：嵌套子项目里的会话归子项目', () => {
    const rows = list(
      summary('in-pkg', { cwd: '/w/app/pkg/src', updatedAt: 9 }),
      summary('in-app', { cwd: '/w/app/docs', updatedAt: 1 }),
    )
    // /w/app/pkg 是已知项目（对照里有别的会话归到它）
    const map = { '/elsewhere': '/w/app/pkg' }
    expect(pickSession(rows, '/w/app', map)).toMatchObject({ sessionId: 'in-app' })
    expect(pickSession(rows, '/w/app/pkg', map)).toMatchObject({ sessionId: 'in-pkg' })
    // 不知道 pkg 是项目时，两个都算 /w/app 的，照旧挑最近的
    expect(pickSession(rows, '/w/app')).toMatchObject({ sessionId: 'in-pkg' })
  })

  it('belongsTo / workspaceOf：对照优先，其次最深的已知项目，都没有时 workspaceOf 回原始 cwd', () => {
    const map = { '/link/app': '/w/app', '/x': '/w/app/pkg' }
    expect(belongsTo('/link/app/', '/w/app', map)).toBe(true)
    expect(belongsTo('/w/app/pkg/a', '/w/app', map)).toBe(false)
    expect(belongsTo('/w/app-other', '/w/app', map)).toBe(false)
    expect(belongsTo(undefined, '/w/app', map)).toBe(false)
    expect(workspaceOf('/link/app', map)).toBe('/w/app')
    expect(workspaceOf('/w/app/pkg/a', map)).toBe('/w/app/pkg')
    expect(workspaceOf('/w/new/sub', map)).toBe('/w/new/sub')
  })
})

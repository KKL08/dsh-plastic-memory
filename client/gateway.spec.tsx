// 宿主网关：它本身就是进程边界的适配层，这里给它一个假的宿主 ctx（远程调用 + 标准 props），断言它发出的命令与读出的视图。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { GUI_VIEW_VERSION, type PendingView } from '../src/gui/contract.ts'
import {
  CONFIG_ENTRY_ID, createHostGateway, decodeExecution, fileAddress, MEMORY_ROOT_KEY, parseView, pickSession, toPluginConfig, viewPath,
} from './gateway.ts'
import { fakeHostContext } from './test-utils.tsx'
import type { ConfigFormSnapshot, HostContext, ResourceSnapshot, SessionListState, SessionSummary, WorkspaceFileStat } from './host.ts'

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
})

describe('decodeExecution', () => {
  it('成功、失败都按契约 JSON 解析', () => {
    const ok = decodeExecution('undo', { ok: true, value: { commandId: 'c', result: { kind: 'success', text: '{"ok":true,"cmd":"undo","decisionId":"d1"}' } } })
    expect(ok).toEqual({ ok: true, cmd: 'undo', decisionId: 'd1' })
    const err = decodeExecution('forget', { ok: true, value: { commandId: 'c', result: { kind: 'error', text: '{"ok":false,"cmd":"forget","code":"not-found"}' } } })
    expect(err).toEqual({ ok: false, cmd: 'forget', code: 'not-found' })
  })

  it('宿主失败、无结果、非契约文本都折成 failed，原话进 detail', () => {
    expect(decodeExecution('scan', { ok: false, error: { code: 'session/writer-held', message: 'busy' } }))
      .toEqual({ ok: false, cmd: 'scan', code: 'failed', detail: 'session/writer-held: busy' })
    expect(decodeExecution('scan', { ok: true, value: undefined })).toMatchObject({ ok: false, code: 'failed' })
    expect(decodeExecution('scan', { ok: true, value: { commandId: 'c', result: { kind: 'error', text: 'unknown command' } } }))
      .toEqual({ ok: false, cmd: 'scan', code: 'failed', detail: 'unknown command' })
  })
})

describe('parseView', () => {
  const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'none', items: [], typeLabels: {} }
  it('合法视图 → ready；版本号不认识 → outdated；结构不对 → error', () => {
    expect(parseView('pending', JSON.stringify(pending))).toEqual({ status: 'ready', data: pending })
    expect(parseView('pending', JSON.stringify({ ...pending, version: GUI_VIEW_VERSION + 1 }))).toEqual({ status: 'outdated' })
    expect(parseView('pending', JSON.stringify({ version: GUI_VIEW_VERSION, dot: 'blue', items: [] })).status).toBe('error')
    expect(parseView('pending', '{').status).toBe('error')
  })

  it('视图路径与文件资源地址', () => {
    expect(viewPath('/h/memories/', 'pending', 's1')).toBe('/h/memories/.state/gui/pending.json')
    expect(viewPath('/h/memories', 'session', 's 1')).toBe('/h/memories/.state/gui/session-s%201.json')
    expect(fileAddress('s1', '/h/m/a b.json')).toBe('dsh-resource://file/session/s1//h/m/a%20b.json')
  })
})

describe('createHostGateway', () => {
  const pending: PendingView = { version: GUI_VIEW_VERSION, dot: 'amber', items: [], typeLabels: {} }
  const sessions = list(summary('s1', { cwd: '/w/app', retainedBy: { mainView: 1 } }))
  let executed: string[]
  let resources: Record<string, ResourceSnapshot<WorkspaceFileStat>>
  /** 假服务端的视图文件：refresh-views 写出 pending.json。 */
  let files: Record<string, string>
  const pendingPath = '/h/memories/.state/gui/pending.json'
  let openWorkspacePath: ReturnType<typeof vi.fn>

  function fakeCtx(overrides: Parameters<typeof fakeHostContext>[0] = {}): HostContext {
    return fakeHostContext({
      ...overrides,
      remote: {
        commands: {
          execute: vi.fn(async (_sid: string, line: string) => {
            executed.push(line)
            if (line === '/memory refresh-views') files[pendingPath] = JSON.stringify(pending)
            const text = line.startsWith('/memory info')
              ? JSON.stringify({ ok: true, cmd: 'info', info: { memoryRoot: '/h/memories', viewDir: '/h/memories/.state/gui', views: { pending: '', health: '', library: '', deleted: '' }, version: GUI_VIEW_VERSION } })
              : JSON.stringify({ ok: true, cmd: line.split(' ')[1] })
            return { ok: true as const, value: { commandId: 'c', result: { kind: 'success' as const, text } } }
          }),
        },
        workspaceFiles: {
          read: vi.fn(async (_sid: string, path: string) => files[path] === undefined
            ? { ok: false as const, error: { code: 'workspace-file/not-found', message: path } }
            : { ok: true as const, value: { absolutePath: path, version: 'v1', text: files[path] } }),
        },
        session: { openWorkspacePath },
        ...overrides.remote,
      },
    })
  }

  const props = {
    useSessions: <S,>(selector: (s: SessionListState) => S) => selector(sessions),
    useResource: (address: string) => resources[address] ?? { status: 'none' as const, value: undefined, failure: undefined },
  }

  beforeEach(() => {
    executed = []; resources = {}; files = {}; localStorage.clear()
    openWorkspacePath = vi.fn(async () => ({ ok: true as const, value: { opened: true } }))
  })
  afterEach(() => { localStorage.clear() })

  it('首次：借会话发 info，缓存 memoryRoot，再发一次 refresh-views；资源仍停在 not-found 也直接读出视图', async () => {
    resources[fileAddress('s1', pendingPath)] = { status: 'failed', value: undefined, failure: { code: 'workspace-file/not-found', message: '' } }
    const gateway = createHostGateway(fakeCtx())(props)
    const { result } = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'pending'))
    await waitFor(() => { expect(result.current).toEqual({ status: 'ready', data: pending }) })
    expect(executed).toEqual(['/memory info', '/memory refresh-views'])
    expect(localStorage.getItem(MEMORY_ROOT_KEY)).toBe('/h/memories')
  })

  it('文件缺失且刷新后仍读不到：missing；之后资源推来版本就按版本读', async () => {
    localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
    const address = fileAddress('s1', '/h/memories/.state/gui/library.json')
    resources[address] = { status: 'failed', value: undefined, failure: { code: 'workspace-file/not-found', message: '' } }
    const gateway = createHostGateway(fakeCtx())(props)
    const { result, rerender } = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'library'))
    await waitFor(() => { expect(executed).toEqual(['/memory refresh-views']) })
    expect(result.current).toEqual({ status: 'missing' })

    files['/h/memories/.state/gui/library.json'] = JSON.stringify({ version: GUI_VIEW_VERSION + 1 })
    resources[address] = { status: 'live', value: { absolutePath: 'x', version: 'v1' }, failure: undefined }
    rerender()
    await waitFor(() => { expect(result.current).toEqual({ status: 'outdated' }) })
  })

  it('localStorage 里已有 memoryRoot：不发命令直接订阅', async () => {
    localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
    resources[fileAddress('s1', pendingPath)] = { status: 'live', value: { absolutePath: 'x', version: 'v2' }, failure: undefined }
    files[pendingPath] = JSON.stringify(pending)
    const gateway = createHostGateway(fakeCtx())(props)
    const { result } = renderHook(() => gateway.useView(gateway.useSession(undefined), 'pending'))
    await waitFor(() => { expect(result.current.status).toBe('ready') })
    expect(executed).toEqual([])
  })

  it('没有会话：idle，不发命令', () => {
    const gateway = createHostGateway(fakeCtx())({ ...props, useSessions: <S,>(selector: (s: SessionListState) => S) => selector(list()) })
    const { result } = renderHook(() => gateway.useView(gateway.useSession(undefined), 'library'))
    expect(result.current).toEqual({ status: 'idle' })
    expect(executed).toEqual([])
  })

  it('execute 按契约编码命令并解析结果；当前工作区取选中会话的 cwd', async () => {
    const gateway = createHostGateway(fakeCtx())(props)
    expect(await gateway.execute('s1', { cmd: 'resolve', decisionId: 'd1', verdict: 'keep-both' })).toEqual({ ok: true, cmd: 'resolve' })
    expect(executed).toEqual(['/memory resolve {"decisionId":"d1","verdict":"keep-both"}'])
    const { result } = renderHook(() => gateway.useCurrentWorkspace())
    expect(result.current).toBe('/w/app')
  })

  it('openPath：打开只带 path，显示目录带 action: reveal；宿主拒绝或抛错都是 false', async () => {
    const gateway = createHostGateway(fakeCtx())(props)
    expect(await gateway.openPath('/m/app/a.md')).toBe(true)
    expect(await gateway.openPath('/m/app/a.md', 'reveal')).toBe(true)
    expect(openWorkspacePath.mock.calls.map(call => call[0])).toEqual([{ path: '/m/app/a.md' }, { path: '/m/app/a.md', action: 'reveal' }])
    openWorkspacePath.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/bad-request', message: 'no' } })
    expect(await gateway.openPath('/x')).toBe(false)
    openWorkspacePath.mockRejectedValueOnce(new Error('down'))
    expect(await gateway.openPath('/x')).toBe(false)
  })

  it('配置：按 entryId 取表单，ready 时折成界面用的几项；setConfig 走单字段 set', async () => {
    const value = { snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governance: { enabled: true, globalPromoteTarget: 'agents-md' } }
    let snapshot: ConfigFormSnapshot = { status: 'loading', value: undefined, revision: undefined, writable: true }
    const listeners = new Set<() => void>()
    const set = vi.fn(async () => true)
    const get = vi.fn(() => ({ getSnapshot: () => snapshot, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }, set, mutate: vi.fn(async () => true) }))
    const gateway = createHostGateway(fakeCtx({ configForms: { get } }))(props)
    const { result } = renderHook(() => gateway.useConfig())
    expect(result.current).toBeUndefined()
    act(() => { snapshot = { status: 'ready', value, revision: 1, writable: true }; for (const fn of listeners) fn() })
    expect(result.current).toEqual({ snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governanceEnabled: true, globalPromoteTarget: 'agents-md' })
    expect(get).toHaveBeenCalledWith(CONFIG_ENTRY_ID)
    expect(await gateway.setConfig('snapshotTokenBudget', 5000)).toBe(true)
    expect(set).toHaveBeenCalledWith('snapshotTokenBudget', 5000)
  })

  it('宿主不服务配置：useConfig 为 undefined，setConfig 为 false；结构不对的值不认', async () => {
    const gateway = createHostGateway(fakeCtx())(props)
    expect(renderHook(() => gateway.useConfig()).result.current).toBeUndefined()
    expect(await gateway.setConfig('snapshotTokenBudget', 5000)).toBe(false)
    expect(toPluginConfig({ snapshotTokenBudget: '4000' })).toBeUndefined()
  })

  it('打开文件 / 在文件管理器中显示走 session.openWorkspacePath；读文件走 workspaceFiles', async () => {
    const openWorkspacePath = vi.fn(async () => ({ ok: true as const, value: { opened: true } }))
    files['/m/a.md'] = '---\nname: a\n---\n正文'
    const gateway = createHostGateway(fakeCtx({ remote: { session: { openWorkspacePath } } }))(props)
    expect(await gateway.openPath('/m/a.md', 'open')).toBe(true)
    expect(await gateway.openPath('/m/a.md', 'reveal')).toBe(true)
    expect(openWorkspacePath.mock.calls).toEqual([[{ path: '/m/a.md' }], [{ path: '/m/a.md', action: 'reveal' }]])
    expect(await gateway.readFile('s1', '/m/a.md')).toBe('---\nname: a\n---\n正文')
    expect(await gateway.readFile('s1', '/m/none.md')).toBeUndefined()
  })
})

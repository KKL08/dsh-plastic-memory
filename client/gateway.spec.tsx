// 宿主网关：它本身就是进程边界的适配层，这里给它一个假的宿主 ctx（远程调用 + 标准 props），断言它发出的命令与读出的视图。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { GUI_VIEW_VERSION, GUI_WORKSPACE_MAP_FILE, type PendingView } from '../src/gui/contract.ts'
import {
  belongsTo, createHostGateway, decodeExecution, fileAddress, MEMORY_ROOT_CONFIG_KEY, MEMORY_ROOT_KEY, parseView, pickSession, toPluginConfig, viewPath,
  workspaceOf,
} from './gateway.ts'
import { createFakeConfigForm, DEFAULT_SECTION } from './settings/config-form.fake.ts'
import { ENTRY_ID } from './settings/config.ts'
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

  it('删除状态在插槽根之间共用：一处 forget / hard-delete 成功，另一处读到；restore 后去掉；失败不记', async () => {
    const bind = createHostGateway(fakeCtx())
    const a = bind(props)
    const b = bind({ ...props })
    const { result } = renderHook(() => b.useDeletions())
    const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
    await act(async () => { await a.execute('s1', { cmd: 'forget', memoryId: 'm1', layer }) })
    await act(async () => { await a.execute('s1', { cmd: 'hard-delete', memoryId: 'm2', layer }) })
    expect([...result.current]).toEqual([['m1', 'soft'], ['m2', 'hard']])
    await act(async () => { await a.execute('s1', { cmd: 'restore', memoryId: 'm1', layer }) })
    expect([...result.current]).toEqual([['m2', 'hard']])

    const failing = createHostGateway(fakeCtx({ remote: { commands: { execute: vi.fn(async () => ({ ok: false as const, error: { code: 'x', message: 'x' } })) } } }))(props)
    await act(async () => { await failing.execute('s1', { cmd: 'forget', memoryId: 'm3', layer }) })
    const { result: other } = renderHook(() => failing.useDeletions())
    expect(other.current.size).toBe(0)
  })

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
    // 缓存的根刷新后仍读不到：再问一次 info，根没变就留在 missing
    await waitFor(() => { expect(executed).toEqual(['/memory refresh-views', '/memory info']) })
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

  it('缓存的 memoryRoot 过期：刷新后仍读不到就再发一次 info，换成新根并从新路径读视图', async () => {
    localStorage.setItem(MEMORY_ROOT_KEY, '/old/memories')
    resources[fileAddress('s1', '/old/memories/.state/gui/pending.json')] = { status: 'failed', value: undefined, failure: { code: 'workspace-file/not-found', message: '' } }
    resources[fileAddress('s1', pendingPath)] = { status: 'live', value: { absolutePath: pendingPath, version: 'v1' }, failure: undefined }
    const gateway = createHostGateway(fakeCtx())(props)
    const { result } = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'pending'))
    await waitFor(() => { expect(result.current).toEqual({ status: 'ready', data: pending }) })
    expect(executed).toEqual(['/memory refresh-views', '/memory info'])
    expect(localStorage.getItem(MEMORY_ROOT_KEY)).toBe('/h/memories')
  })

  it('设置里改了 memoryRoot（旧目录还有视图文件）：配置值和缓存时不一样就丢掉缓存，发一次 info，再 refresh-views，从新根读', async () => {
    localStorage.setItem(MEMORY_ROOT_KEY, '/old/memories')
    localStorage.setItem(MEMORY_ROOT_CONFIG_KEY, '')
    files['/old/memories/.state/gui/pending.json'] = JSON.stringify({ ...pending, dot: 'none' })
    resources[fileAddress('s1', '/old/memories/.state/gui/pending.json')] = { status: 'live', value: { absolutePath: 'x', version: 'v1' }, failure: undefined }
    resources[fileAddress('s1', pendingPath)] = { status: 'live', value: { absolutePath: pendingPath, version: 'v1' }, failure: undefined }
    const form = createFakeConfigForm({ value: { ...DEFAULT_SECTION, memoryRoot: '/h/memories' } })
    const gateway = createHostGateway(fakeCtx({ configForms: { get: () => form } }))(props)
    const { result } = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'pending'))
    await waitFor(() => { expect(result.current).toEqual({ status: 'ready', data: pending }) })
    expect(executed).toEqual(['/memory info', '/memory refresh-views'])
    expect(localStorage.getItem(MEMORY_ROOT_KEY)).toBe('/h/memories')
    expect(localStorage.getItem(MEMORY_ROOT_CONFIG_KEY)).toBe('/h/memories')
  })

  it('配置值和缓存时一样：不发命令，直接用缓存的根', async () => {
    localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
    localStorage.setItem(MEMORY_ROOT_CONFIG_KEY, '')
    resources[fileAddress('s1', pendingPath)] = { status: 'live', value: { absolutePath: pendingPath, version: 'v1' }, failure: undefined }
    files[pendingPath] = JSON.stringify(pending)
    const form = createFakeConfigForm()
    const gateway = createHostGateway(fakeCtx({ configForms: { get: () => form } }))(props)
    const { result } = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'pending'))
    await waitFor(() => { expect(result.current.status).toBe('ready') })
    expect(executed).toEqual([])
  })

  it('页面开着时配置里的 memoryRoot 变了：同样丢掉缓存重来一次', async () => {
    localStorage.setItem(MEMORY_ROOT_KEY, '/old/memories')
    localStorage.setItem(MEMORY_ROOT_CONFIG_KEY, '')
    files['/old/memories/.state/gui/pending.json'] = JSON.stringify({ ...pending, dot: 'none' })
    resources[fileAddress('s1', '/old/memories/.state/gui/pending.json')] = { status: 'live', value: { absolutePath: 'x', version: 'v1' }, failure: undefined }
    resources[fileAddress('s1', pendingPath)] = { status: 'live', value: { absolutePath: pendingPath, version: 'v1' }, failure: undefined }
    const form = createFakeConfigForm()
    const gateway = createHostGateway(fakeCtx({ configForms: { get: () => form } }))(props)
    const { result } = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'pending'))
    await waitFor(() => { expect(result.current).toMatchObject({ status: 'ready', data: { dot: 'none' } }) })
    expect(executed).toEqual([])
    act(() => { form.externalChange([{ op: 'set', path: ['memoryRoot'], value: '/h/memories' }]) })
    await waitFor(() => { expect(result.current).toEqual({ status: 'ready', data: pending }) })
    expect(executed).toEqual(['/memory info', '/memory refresh-views'])
  })

  it('首次（没有缓存）拿到根时把当时的配置值一起记下', async () => {
    resources[fileAddress('s1', pendingPath)] = { status: 'failed', value: undefined, failure: { code: 'workspace-file/not-found', message: '' } }
    const form = createFakeConfigForm({ value: { ...DEFAULT_SECTION, memoryRoot: '~/mem' } })
    const gateway = createHostGateway(fakeCtx({ configForms: { get: () => form } }))(props)
    const { result } = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'pending'))
    await waitFor(() => { expect(result.current.status).toBe('ready') })
    expect(executed).toEqual(['/memory info', '/memory refresh-views'])
    expect(localStorage.getItem(MEMORY_ROOT_CONFIG_KEY)).toBe('~/mem')
  })

  it('info 失败后是 error；换一个会话时重试', async () => {
    const two = list(summary('s1', { cwd: '/w/a', updatedAt: 1 }), summary('s2', { cwd: '/w/b', updatedAt: 2 }))
    const ctx = fakeCtx()
    const execute = ctx.remote.commands.execute as ReturnType<typeof vi.fn>
    const ok = execute.getMockImplementation()!
    execute.mockImplementation(async (sid: string, line: string) => sid === 's1'
      ? (executed.push(line), { ok: false as const, error: { code: 'boom', message: 'no session' } })
      : ok(sid, line))
    resources[fileAddress('s2', pendingPath)] = { status: 'live', value: { absolutePath: pendingPath, version: 'v1' }, failure: undefined }
    files[pendingPath] = JSON.stringify(pending)
    const gateway = createHostGateway(ctx)({ ...props, useSessions: <S,>(selector: (s: SessionListState) => S) => selector(two) })
    const { result, rerender } = renderHook(({ ws }) => gateway.useView(gateway.useSession(ws), 'pending'), { initialProps: { ws: '/w/a' } })
    await waitFor(() => { expect(result.current).toEqual({ status: 'error', message: 'boom: no session' }) })
    rerender({ ws: '/w/a' })
    expect(executed).toEqual(['/memory info'])

    rerender({ ws: '/w/b' })
    await waitFor(() => { expect(result.current).toEqual({ status: 'ready', data: pending }) })
    expect(executed).toEqual(['/memory info', '/memory info', '/memory refresh-views'])
  })

  it('两个视图挂着不同会话、info 都失败：各试一次就停，不来回重试', async () => {
    const two = list(summary('s1', { cwd: '/w/a', updatedAt: 1 }), summary('s2', { cwd: '/w/b', updatedAt: 2 }))
    const ctx = fakeCtx()
    const execute = ctx.remote.commands.execute as ReturnType<typeof vi.fn>
    execute.mockImplementation(async (_sid: string, line: string) => (executed.push(line), { ok: false as const, error: { code: 'boom', message: 'no plugin' } }))
    const gateway = createHostGateway(ctx)({ ...props, useSessions: <S,>(selector: (s: SessionListState) => S) => selector(two) })
    const { result } = renderHook(() => [gateway.useView(gateway.useSession('/w/a'), 'pending'), gateway.useView(gateway.useSession('/w/b'), 'pending')])
    await waitFor(() => { expect(result.current.every(v => v.status === 'error')).toBe(true) })
    await new Promise(r => setTimeout(r, 50))
    expect(executed).toEqual(['/memory info', '/memory info'])
  })

  describe('refresh-views 失败后可重试', () => {
    const libraryPath = '/h/memories/.state/gui/library.json'
    const missing = { status: 'failed' as const, value: undefined, failure: { code: 'workspace-file/not-found', message: '' } }

    /** 缓存了根、library 视图缺失；refresh-views 的前 failures 次被会话拒绝。 */
    function setup(failures: number) {
      localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
      resources[fileAddress('s1', libraryPath)] = missing
      const ctx = fakeCtx()
      const execute = ctx.remote.commands.execute as ReturnType<typeof vi.fn>
      const ok = execute.getMockImplementation()!
      let left = failures
      execute.mockImplementation(async (sid: string, line: string) => {
        if (line === '/memory refresh-views' && left > 0) {
          left -= 1
          executed.push(line)
          return { ok: false as const, error: { code: 'session/writer-held', message: 'busy' } }
        }
        if (line === '/memory refresh-views') files[libraryPath] = JSON.stringify({ version: GUI_VIEW_VERSION + 1 })
        return ok(sid, line)
      })
      return createHostGateway(ctx)(props)
    }

    it('失败后再次进入会重发一次', async () => {
      const gateway = setup(1)
      const first = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'library'))
      await waitFor(() => { expect(executed).toEqual(['/memory refresh-views']) })
      expect(first.result.current).toEqual({ status: 'missing' })
      first.unmount()

      const second = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'library'))
      await waitFor(() => { expect(second.result.current).toEqual({ status: 'outdated' }) })
      expect(executed).toEqual(['/memory refresh-views', '/memory refresh-views'])
    })

    it('成功之后不再发', async () => {
      const gateway = setup(0)
      const first = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'library'))
      await waitFor(() => { expect(first.result.current).toEqual({ status: 'outdated' }) })
      first.unmount()

      const second = renderHook(() => gateway.useView(gateway.useSession('/w/app'), 'library'))
      await waitFor(() => { expect(second.result.current).toEqual({ status: 'outdated' }) })
      expect(executed).toEqual(['/memory refresh-views'])
    })

    it('同时多处要刷新只发一条', async () => {
      const gateway = setup(1)
      const { result } = renderHook(() => [
        gateway.useView(gateway.useSession('/w/app'), 'library'),
        gateway.useView(gateway.useSession('/w/app'), 'library'),
      ])
      await waitFor(() => { expect(executed).toEqual(['/memory refresh-views']) })
      await new Promise(r => setTimeout(r, 50))
      expect(executed).toEqual(['/memory refresh-views'])
      expect(result.current.every(v => v.status === 'missing')).toBe(true)
    })
  })

  it('没有会话：idle，不发命令', () => {
    const gateway = createHostGateway(fakeCtx())({ ...props, useSessions: <S,>(selector: (s: SessionListState) => S) => selector(list()) })
    const { result } = renderHook(() => gateway.useView(gateway.useSession(undefined), 'library'))
    expect(result.current).toEqual({ status: 'idle' })
    expect(executed).toEqual([])
  })

  it('execute 按契约编码命令并解析结果；当前工作区等对照读到再定', async () => {
    const gateway = createHostGateway(fakeCtx())(props)
    expect(await gateway.execute('s1', { cmd: 'resolve', decisionId: 'd1', verdict: 'keep-both' })).toEqual({ ok: true, cmd: 'resolve' })
    expect(executed).toEqual(['/memory resolve {"decisionId":"d1","verdict":"keep-both"}'])
    // 根还不知道、对照读不到：先是 loading
    const { result } = renderHook(() => gateway.useCurrentWorkspace())
    expect(result.current).toEqual({ status: 'loading' })
  })

  describe('会话归属与服务端一致', () => {
    const mapPath = `/h/memories/.state/gui/${GUI_WORKSPACE_MAP_FILE}`
    function withSessions(state: SessionListState) {
      return { ...props, useSessions: <S,>(selector: (s: SessionListState) => S) => selector(state) }
    }
    /** 服务端写出的对照文件，经 via 这个会话的文件通道可见。 */
    function serveMap(via: string, cwds: Record<string, string>) {
      files[mapPath] = JSON.stringify({ version: GUI_VIEW_VERSION, cwds })
      resources[fileAddress(via, mapPath)] = { status: 'live', value: { absolutePath: 'x', version: 'v1' }, failure: undefined }
    }
    function mapMissing(via: string) {
      resources[fileAddress(via, mapPath)] = { status: 'failed', value: undefined, failure: { code: 'workspace-file/not-found', message: '' } }
    }

    it('借会话：没选中的会话经软链接开在项目里，对照说它属于这个项目，就进项目这一档', async () => {
      localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
      serveMap('sel', { '/link/app': '/w/app' })
      const rows = list(
        summary('sel', { cwd: '/w/other', updatedAt: 9, retainedBy: { mainView: 1 } }),
        summary('linked', { cwd: '/link/app', updatedAt: 1 }),
      )
      const gateway = createHostGateway(fakeCtx())(withSessions(rows))
      const { result } = renderHook(() => gateway.useSession('/w/app'))
      await waitFor(() => { expect(result.current).toMatchObject({ sessionId: 'linked', workspaces: { '/link/app': '/w/app' } }) })
      // 只读文件，不为此发命令
      expect(executed).toEqual([])
    })

    it('借会话：服务端没见过的会话在嵌套子项目里，归子项目，不借给外层项目', async () => {
      localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
      serveMap('sel', { '/w/app/pkg': '/w/app/pkg' })
      const rows = list(
        summary('sel', { cwd: '/w/other', updatedAt: 1, retainedBy: { mainView: 1 } }),
        summary('in-pkg', { cwd: '/w/app/pkg/src', updatedAt: 9 }),
      )
      const gateway = createHostGateway(fakeCtx())(withSessions(rows))
      const { result } = renderHook(() => gateway.useSession('/w/app'))
      await waitFor(() => { expect(result.current).toMatchObject({ workspaces: { '/w/app/pkg': '/w/app/pkg' } }) })
      expect(result.current).toMatchObject({ sessionId: 'sel' })
    })

    it('当前工作区：对照还在读时是 loading，不先拿原始 cwd 顶上；读到后给服务端的项目', async () => {
      localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
      const rows = list(summary('sel', { cwd: '/link/app/sub', retainedBy: { mainView: 1 } }))
      const gateway = createHostGateway(fakeCtx())(withSessions(rows))
      const { result, rerender } = renderHook(() => gateway.useCurrentWorkspace())
      const seen = [result.current]
      expect(result.current).toEqual({ status: 'loading' })
      serveMap('sel', { '/link/app/sub': '/w/app' })
      rerender()
      await waitFor(() => { seen.push(result.current); expect(result.current).toEqual({ status: 'ready', workspacePath: '/w/app' }) })
      expect(seen.some(v => v.status === 'ready' && v.workspacePath !== '/w/app')).toBe(false)
      expect(executed).toEqual([])
    })

    it('当前工作区：对照文件确认不存在后才按路径判断（最深的已知项目，否则原始 cwd）', async () => {
      localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
      mapMissing('sel')
      const gateway = createHostGateway(fakeCtx())(withSessions(list(summary('sel', { cwd: '/w/app/sub', retainedBy: { mainView: 1 } }))))
      const { result } = renderHook(() => gateway.useCurrentWorkspace())
      expect(result.current).toEqual({ status: 'ready', workspacePath: '/w/app/sub' })
      // 不为对照发 refresh-views
      expect(executed).toEqual([])
    })

    it('当前工作区：对照里没有这个 cwd 时取包含它的最深已知项目', async () => {
      localStorage.setItem(MEMORY_ROOT_KEY, '/h/memories')
      serveMap('sel', { '/elsewhere': '/w/app' })
      const gateway = createHostGateway(fakeCtx())(withSessions(list(summary('sel', { cwd: '/w/app/sub', retainedBy: { mainView: 1 } }))))
      const { result } = renderHook(() => gateway.useCurrentWorkspace())
      await waitFor(() => { expect(result.current).toEqual({ status: 'ready', workspacePath: '/w/app' }) })
    })

    it('当前工作区：没有选中的会话时直接是 ready / undefined', () => {
      const gateway = createHostGateway(fakeCtx())(withSessions(list(summary('a'))))
      const { result } = renderHook(() => gateway.useCurrentWorkspace())
      expect(result.current).toEqual({ status: 'ready', workspacePath: undefined })
    })
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
    expect(get).toHaveBeenCalledWith(ENTRY_ID)
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

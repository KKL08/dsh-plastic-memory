// 对话里的两层卡：九个工具折叠行的摘要、交付卡出现的条件、删除 / 撤销发出的命令、「查看详情」的导航目标。
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { GUI_VIEW_VERSION, type LibraryView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createHostGateway } from '../gateway.ts'
import type { SessionListState } from '../host.ts'
import { createNavStore, PANEL_ID } from '../nav.ts'
import { fakeHostContext, NOW, renderInShell } from '../test-utils.tsx'
import { registerChatCards, type TurnTailProps } from './index.tsx'
import { MemoryToolRow, type MemoryToolViewProps } from './MemoryToolRow.tsx'
import { savedTurnDefinition, type SavedMemory, type SavedTurnData } from './saved-turn.ts'
import { SavedMemoriesCard } from './SavedMemoriesCard.tsx'
import { MEMORY_TOOLS } from './tool-summary.ts'

const HOST_ZH: Record<string, string> = {
  'tool.title.generic': '工具调用', 'row.input': '输入', 'row.output': '输出',
  'row.running': '运行中', 'row.preparing': '准备中', 'row.failed': '失败', 'row.stopped': '已停止',
}
const hostT = (key: string) => HOST_ZH[key] ?? key
const disclosure = () => {
  let expanded = false
  return () => ({ expanded, toggle: () => { expanded = !expanded } })
}

function result(toolName: string, args: object, text: string, isError = false): MemoryToolViewProps {
  return {
    toolName, useDisclosure: disclosure(), phase: 'result',
    block: { kind: 'tool-result', call: { name: toolName, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text }], isError },
  }
}

function rowSummary(props: MemoryToolViewProps): string {
  const { container } = renderInShell(<MemoryToolRow {...props} hostT={hostT} />)
  return container.querySelector('.pm-tr-summary')?.textContent ?? ''
}

const saveArgs = {
  action: 'create', name: '测试不 mock 数据库', type: 'preference', scope: 'workspace',
  content: '测试里不要 mock 数据库，用 testcontainers 起真实 Postgres。', summary: 'testcontainers', sourceMode: 'user-explicit',
}
const SAVED_TEXT = '已保存记忆 mem_1（preference，workspace）。下个会话注入；本会话若触发上下文压缩，压缩后即生效。'

describe('折叠行：照抄宿主通用工具行，只换摘要', () => {
  it('九个工具各一句摘要', () => {
    const hit = (id: string) => `[${id}] preference｜摘要\n原文`
    const cases: Array<[MemoryToolViewProps, string]> = [
      [result('memory_save', saveArgs, SAVED_TEXT), '已记住「测试不 mock 数据库」'],
      [result('memory_search', { query: '数据库' }, [hit('mem_1'), hit('mem_2')].join('\n\n')), '搜到 2 条「数据库」'],
      [result('memory_forget', { ids: ['mem_1', 'mem_2'], reason: '过时' }, '已遗忘 2 条记忆。'), '已删除 2 条记忆'],
      [result('memory_snapshot', { action: 'restore', snapshotId: 'snap_1' }, '已恢复 1 条记忆（mem_1）。'), '从快照 snap_1 恢复'],
      [result('memory_source', { memoryId: 'mem_1' }, '……'), '回查记忆出处 mem_1'],
      [result('memory_confirm', { action: 'refresh', memoryId: 'mem_1' }, '已确认记忆 mem_1 仍然准确'), '确认记忆仍然准确 mem_1'],
      [result('memory_scan', { scopes: ['/w/a', '/w/b'] }, '体检完成'), '体检 2 个项目'],
      [result('memory_health', { scope: 'all' }, '健康分'), '查看全部记忆的健康分'],
      [result('memory_promote', { ids: ['mem_1', 'mem_2'], target: 'agents-md' }, '已写入'), '把 2 条写进 AGENTS.md'],
    ]
    expect(cases.map(([props]) => props.toolName)).toEqual([...MEMORY_TOOLS])
    for (const [props, summary] of cases) expect(rowSummary(props)).toBe(summary)
  })

  it('结果决定措辞：疑似重复没记住、没搜到、全都不存在、作用域缺省为本项目', () => {
    expect(rowSummary(result('memory_save', saveArgs, '这个主题可能已有记忆：\n- mem_0：x'))).toBe('没有记住「测试不 mock 数据库」')
    expect(rowSummary(result('memory_save', { ...saveArgs, action: 'update', id: 'mem_1' }, '已更新记忆 mem_1。'))).toBe('已更新「测试不 mock 数据库」')
    expect(rowSummary(result('memory_search', { query: '数据库' }, '没有匹配的记忆。'))).toBe('没有搜到「数据库」')
    expect(rowSummary(result('memory_forget', { ids: ['mem_9'], reason: 'x' }, '以下记忆不存在：mem_9'))).toBe('没有可删除的记忆')
    expect(rowSummary(result('memory_scan', {}, 'ok'))).toBe('体检本项目')
  })

  it('标题、图标位、运行中与失败照宿主：还在跑时摘要按参数，失败时摘要是结果首行', () => {
    const running: MemoryToolViewProps = { toolName: 'memory_save', useDisclosure: disclosure(), phase: 'start', block: { argsRaw: JSON.stringify(saveArgs) } }
    const { container } = renderInShell(<MemoryToolRow {...running} hostT={hostT} />)
    expect(container.querySelector('.pm-tr-title')).toHaveTextContent('工具调用')
    expect(container.querySelector('.pm-tr-summary')).toHaveTextContent('正在记住「测试不 mock 数据库」')
    expect(container.querySelector('.pm-tr-sr')).toHaveTextContent('运行中')
    expect(rowSummary(result('memory_scan', {}, '拿不到模型\n详情', true))).toBe('拿不到模型')
  })

  it('点开后是宿主的输入 / 输出块', () => {
    let expanded = false
    const props: MemoryToolViewProps = { ...result('memory_save', saveArgs, SAVED_TEXT), useDisclosure: () => ({ expanded, toggle: () => { expanded = !expanded } }) }
    const { rerender } = renderInShell(<MemoryToolRow {...props} hostT={hostT} />)
    const row = screen.getByRole('button', { expanded: false })
    fireEvent.click(row)
    rerender(<MemoryToolRow {...props} hostT={hostT} />)
    expect(screen.getByText('输入')).toBeInTheDocument()
    expect(screen.getByText(SAVED_TEXT)).toBeInTheDocument()
  })
})

// —— 交付卡 ——

type Ev = { type: string; seq: number; time: number; surfaceOp?: string; data: unknown }

/** 把一轮事件喂给 Definition，得到挂在 Turn 上的数据（宿主引擎做的事）。 */
function turnData(events: Ev[]): SavedTurnData | undefined {
  let state: ReturnType<typeof savedTurnDefinition.start> | undefined
  for (const event of events) {
    const match = savedTurnDefinition.match(event)
    if (match === null) continue
    state = match.role === 'start' && state === undefined ? savedTurnDefinition.start({}, { event }) : savedTurnDefinition.update({ state: state! }, { event })
  }
  return savedTurnDefinition.buildLocationData({ state }, 'turn', null)?.value
}

const call = (seq: number, callId: string, name: string, args: object): Ev =>
  ({ type: 'tool/call', seq, time: NOW, data: { turn: 1, callId, name, arguments: JSON.stringify(args) } })
const res = (seq: number, callId: string, text: string, isError = false): Ev =>
  ({ type: 'tool/result', seq, time: NOW, surfaceOp: 'append', data: { turn: 1, message: { isError, content: [{ type: 'text', text }], source: { callId } } } })
const turnStart: Ev = { type: 'turn/start', seq: 1, time: NOW, data: { turn: 1 } }

describe('交付卡出现的条件', () => {
  it('只收本轮成功新记的 memory_save；更新、疑似重复、失败、别的工具都不算', () => {
    const data = turnData([
      turnStart,
      call(2, 'c1', 'memory_save', saveArgs), res(3, 'c1', SAVED_TEXT),
      call(4, 'c2', 'memory_save', { ...saveArgs, action: 'update', id: 'mem_0' }), res(5, 'c2', '已更新记忆 mem_0。'),
      call(6, 'c3', 'memory_save', saveArgs), res(7, 'c3', '这个主题可能已有记忆：\n- mem_0：x'),
      call(8, 'c4', 'memory_save', saveArgs), res(9, 'c4', 'boom', true),
      call(10, 'c5', 'memory_search', { query: 'x' }), res(11, 'c5', '已保存记忆 mem_x（a，global）'),
      call(12, 'c6', 'memory_save', { ...saveArgs, scope: 'global', name: '全局' }), res(13, 'c6', '已保存记忆 mem_2（preference，workspace）。'),
    ])
    expect(data?.saved.map(s => s.memory.id)).toEqual(['mem_1', 'mem_2'])
    // 作用域以服务端结果为准（全局候选可能降级到本项目）
    expect(data?.saved[1]!.memory).toMatchObject({ name: '全局', scope: 'workspace', content: saveArgs.content, sourceMode: 'user-explicit' })
  })

  it('本轮没有新记时没有 Turn 数据，交付卡不渲染', () => {
    expect(turnData([turnStart, call(2, 'c1', 'memory_search', { query: 'x' }), res(3, 'c1', '没有匹配的记忆。')])).toBeUndefined()
  })
})

const saved = (id: string, content: string, scope: 'global' | 'workspace' = 'workspace'): SavedMemory => ({
  callId: `c-${id}`, seq: 3,
  memory: { id, name: id, type: 'preference', scope, summary: '', content, tags: [], sourceMode: 'user-explicit', createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, filePath: '' },
})

describe('交付卡', () => {
  it('「这一轮记住了 N 条」，每条一张记忆卡；删除发 forget，原位留撤销提示，撤销发 restore', async () => {
    const gateway = createFakeGateway()
    const items = [saved('mem_1', '测试不 mock 数据库'), saved('mem_2', '提交信息用英文')]
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={items} now={NOW} openDetail={() => {}} deleted={new Set()} />, gateway)
    expect(screen.getByRole('heading', { name: '这一轮记住了 2 条' })).toBeInTheDocument()
    expect(screen.getByText('测试不 mock 数据库')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: '删除这条记忆' })[0]!)
    expect(await screen.findByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
    expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'forget', memoryId: 'mem_1' } }])
    expect(screen.queryByText('测试不 mock 数据库')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('测试不 mock 数据库')).toBeInTheDocument()
    expect(gateway.executed.at(-1)).toEqual({ sessionId: 's1', command: { cmd: 'restore', memoryId: 'mem_1' } })
  })

  it('记忆卡的类型写显示名（待处理视图的 typeLabels）', () => {
    const gateway = createFakeGateway({ views: { pending: { version: GUI_VIEW_VERSION, dot: 'none', items: [], typeLabels: { preference: '行为偏好' } } } })
    const { container } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} deleted={new Set()} />, gateway)
    expect(container.querySelector('.pm-mc-meta')).toHaveTextContent(/^行为偏好/)
  })

  it('待处理视图没有这个类型时，类型显示名取全部记忆视图的 typeLabels', () => {
    const library: LibraryView = { version: GUI_VIEW_VERSION, memoryRoot: '/m', layers: [], directoryIssues: [], typeLabels: { preference: '行为偏好' } }
    const gateway = createFakeGateway({ views: { library, pending: { version: GUI_VIEW_VERSION, dot: 'none', items: [], typeLabels: {} } } })
    const { container } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} deleted={new Set()} />, gateway)
    expect(container.querySelector('.pm-mc-meta')).toHaveTextContent(/^行为偏好/)
  })

  it('删除失败时原文还在，旁边写服务端原话', async () => {
    const gateway = createFakeGateway({ respond: () => ({ ok: false, code: 'not-found', detail: '记忆不存在' }) })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} deleted={new Set()} />, gateway)
    fireEvent.click(screen.getByRole('button', { name: '删除这条记忆' }))
    expect(await screen.findByText('没有成功：记忆不存在')).toBeInTheDocument()
    expect(screen.getByText('原文')).toBeInTheDocument()
  })
})

// —— 密钥不进对话卡（故事 42） ——

describe('密钥永远不出现在对话卡里', () => {
  const KEY = 'ghp_' + 'a1B2'.repeat(9)
  const secretArgs = { ...saveArgs, name: `token ${KEY}`, summary: `用 ${KEY}`, content: `部署用的 token 是 ${KEY}，别外传。` }

  it('交付卡：记忆卡的名字、摘要、原文都遮成 [已隐藏]', () => {
    const data = turnData([turnStart, call(2, 'c1', 'memory_save', secretArgs), res(3, 'c1', SAVED_TEXT)])
    expect(data?.saved).toHaveLength(1)
    expect(JSON.stringify(data)).not.toContain(KEY)
    const { container } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={data!.saved} now={NOW} openDetail={() => {}} deleted={new Set()} />, createFakeGateway())
    expect(container.textContent).not.toContain(KEY)
    expect(container.textContent).toContain('[已隐藏]')
  })

  it('折叠行：摘要和展开后的输入 / 输出都不带密钥', () => {
    let expanded = true
    const props: MemoryToolViewProps = { ...result('memory_save', secretArgs, `${SAVED_TEXT}\n${KEY}`), useDisclosure: () => ({ expanded, toggle: () => { expanded = !expanded } }) }
    const { container } = renderInShell(<MemoryToolRow {...props} hostT={hostT} />)
    expect(screen.getByText('输入')).toBeInTheDocument()
    expect(container.textContent).not.toContain(KEY)
    expect(container.querySelector('.pm-tr-summary')).toHaveTextContent('[已隐藏]')
  })

  it('带 force 存下的疑似密钥（password: …）同样不出现在交付卡和折叠行里', () => {
    const PASS = 'password: Hunter2-2026'
    const args = { ...saveArgs, name: `登录 ${PASS}`, content: `测试环境 ${PASS}，周五前改。`, force: true }
    const data = turnData([turnStart, call(2, 'c1', 'memory_save', args), res(3, 'c1', SAVED_TEXT)])
    const card = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={data!.saved} now={NOW} openDetail={() => {}} deleted={new Set()} />, createFakeGateway())
    expect(card.container.textContent).not.toContain('Hunter2-2026')
    expect(card.container.textContent).toContain('[已隐藏]')
    card.unmount()
    let expanded = true
    const props: MemoryToolViewProps = { ...result('memory_save', args, `${SAVED_TEXT}\n${PASS}`), useDisclosure: () => ({ expanded, toggle: () => { expanded = !expanded } }) }
    const { container } = renderInShell(<MemoryToolRow {...props} hostT={hostT} />)
    expect(container.textContent).not.toContain('Hunter2-2026')
  })
})

// —— 注册与导航 ——

function fakeHost() {
  const registered: Array<{ options: { name: string; key?: string; id?: string }; component: ComponentType<never> }> = []
  const execute = vi.fn(async (_sid: string, line: string) => ({ ok: true as const, value: { commandId: 'x', result: { kind: 'success' as const, text: JSON.stringify({ ok: true, cmd: line.split(' ')[1] }) } } }))
  const definitions: unknown[] = []
  const ctx = fakeHostContext({
    uiConversation: { events: { register: (def: unknown) => { definitions.push(def); return () => {} } } },
    slots: {
      inject: (_name, fn) => { fn(); return () => {} },
      register: (options, component) => { registered.push({ options, component: component as ComponentType<never> }); return () => {} },
    },
    remote: { commands: { execute } },
  })
  const nav = createNavStore()
  registerChatCards(ctx, nav, createHostGateway(ctx))
  return { ctx, nav, registered, definitions, execute }
}

function tailProps(data: SavedTurnData | undefined, cwd = '/w/app'): TurnTailProps {
  const sessions: SessionListState = { ids: ['s1'], byId: { s1: { id: 's1', displayTitle: 's1', running: false, cwd, updatedAt: 1, retainedBy: {} } }, phase: 'ready' }
  return {
    sessionId: 's1', seq: 10,
    turn: { end: { seq: 20 }, data: { source: () => ({ getSnapshot: () => data, subscribe: () => () => {} }) } },
    useSessions: selector => selector(sessions),
    useResource: () => ({ status: 'none', value: undefined, failure: undefined }),
  }
}

describe('注册', () => {
  it('九个工具名各注册一个折叠行；uiConversation 就位后注册 Turn 数据和交付卡', () => {
    const { registered, definitions } = fakeHost()
    expect(registered.filter(r => r.options.name === 'tool.call.toolview').map(r => r.options.key)).toEqual([...MEMORY_TOOLS])
    expect(registered.filter(r => r.options.name === 'conversation.chat.turnTail')).toHaveLength(1)
    expect(definitions).toEqual([savedTurnDefinition])
  })

  it('交付卡插槽：本轮没有新记时什么都不渲染；有时删除经宿主发 /memory forget', async () => {
    const { registered, execute } = fakeHost()
    const Tail = registered.find(r => r.options.name === 'conversation.chat.turnTail')!.component as ComponentType<TurnTailProps>
    const { container, unmount } = render(<Tail {...tailProps(undefined)} />)
    expect(container).toBeEmptyDOMElement()
    unmount()
    render(<Tail {...tailProps({ saved: [saved('mem_1', '原文')] })} />)
    fireEvent.click(screen.getByRole('button', { name: '删除这条记忆' }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('s1', '/memory forget {"memoryId":"mem_1"}', []))
  })

  it('每条各有「查看详情 ›」：先写导航目标（全部记忆 · 这条所在作用域 · 这条的 id），再切到记忆页', () => {
    const { registered, nav, ctx } = fakeHost()
    const Tail = registered.find(r => r.options.name === 'conversation.chat.turnTail')!.component as ComponentType<TurnTailProps>
    render(<Tail {...tailProps({ saved: [saved('mem_1', '原文'), saved('mem_g', '全局', 'global'), saved('mem_2', '二')] })} />)
    const links = screen.getAllByRole('button', { name: '查看详情 ›' })
    expect(links).toHaveLength(3)
    expect(links.map(link => link.closest('[data-memory-id]')?.getAttribute('data-memory-id'))).toEqual(['mem_1', 'mem_g', 'mem_2'])
    fireEvent.click(links[2]!)
    expect(nav.get()).toEqual({ tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/app' }, memoryId: 'mem_2' })
    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(PANEL_ID)
    fireEvent.click(links[1]!)
    expect(nav.get()).toEqual({ tab: 'library', scope: { kind: 'global' }, memoryId: 'mem_g' })
  })

  it('删掉的那条不再有「查看详情 ›」', () => {
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '一'), saved('mem_2', '二')]} now={NOW} openDetail={() => {}} deleted={new Set(['mem_1'])} />)
    expect(screen.getAllByRole('button', { name: '查看详情 ›' }).map(link => link.closest('[data-memory-id]')?.getAttribute('data-memory-id'))).toEqual(['mem_2'])
  })
})

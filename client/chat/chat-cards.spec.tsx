// 对话里的两层卡：九个工具折叠行的摘要、交付卡出现的条件、删除 / 撤销发出的命令、「查看详情」的导航目标。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentType } from 'react'
import { GUI_VIEW_VERSION, type DeletedView, type LibraryView, type MemoryCommand, type MemoryCommandResult, type SessionView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createHostGateway } from '../gateway.ts'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import type { SessionListState } from '../host.ts'
import { createNavStore, PANEL_ID } from '../nav.ts'
import { fakeHostContext, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { registerChatCards, type TurnTailProps } from './index.tsx'
import { MemoryToolRow, type MemoryToolViewProps } from './MemoryToolRow.tsx'
import { savedTurnDefinition, type SavedMemory, type SavedTurnData } from './saved-turn.ts'
import { SavedMemoriesCard, savedMemoriesCardCss } from './SavedMemoriesCard.tsx'
import { MEMORY_TOOLS } from './tool-summary.ts'
import { LibraryTab } from '../library/LibraryTab.tsx'
import { SidebarTab } from '../sidebar/SidebarTab.tsx'

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

describe('折叠行：对齐宿主通用工具行，只换摘要', () => {
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

/** 交付卡默认折叠：点折叠行展开。 */
const expand = (scope: Pick<typeof screen, 'getByRole'> = screen) => {
  fireEvent.click(scope.getByRole('button', { expanded: false, name: /^这轮记住了/ }))
}

/** 点垃圾桶，再点原位确认里的「删除」。 */
const remove = async (trash: HTMLElement) => {
  const row = trash.parentElement!
  await act(async () => { fireEvent.click(trash) })
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '删除' })) })
}

describe('交付卡默认折叠', () => {
  const named = (id: string, name: string, content: string): SavedMemory => {
    const item = saved(id, content)
    return { ...item, memory: { ...item.memory, name } }
  }
  const items = [named('mem_1', '测试不 mock 数据库', '测试里用真实 Postgres。'), named('mem_2', '提交信息用英文', '提交信息写英文。')]

  it('默认折叠成一行「这轮记住了 N 条新记忆：首条名称」：按钮语义、aria-expanded，记忆卡和删除都不显示', () => {
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={items} now={NOW} openDetail={() => {}} />)
    const toggle = screen.getByRole('button', { name: '这轮记住了 2 条新记忆：测试不 mock 数据库' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('测试里用真实 Postgres。')).toBeNull()
    expect(screen.queryByRole('button', { name: '删除这条记忆' })).toBeNull()
    expect(screen.queryByRole('button', { name: '查看详情 ›' })).toBeNull()
  })

  it('英文折叠行按条数写单复数：1 条 memory，多条 memories', () => {
    const inEnglish = (list: SavedMemory[]) => render(
      <PanelShell gateway={createFakeGateway()} t={createTranslator(en)}>
        <SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={list} now={NOW} openDetail={() => {}} />
      </PanelShell>,
    )
    const one = inEnglish([named('mem_1', 'Use a real database', 'x')])
    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('Remembered 1 new memory this turn: Use a real database')
    one.unmount()
    inEnglish(items.map(i => ({ ...i, memory: { ...i.memory, name: 'Use a real database' } })))
    expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('Remembered 2 new memories this turn: Use a real database')
  })

  it('首条名称单行截断：名称单独一段、完整名称在 title 里，样式不换行、超出写省略号；行尾是 ›', () => {
    const long = '一条名字很长很长的记忆，'.repeat(8)
    const { container } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[named('mem_1', long, '原文')]} now={NOW} openDetail={() => {}} />)
    const name = screen.getByText(long)
    expect(name).toHaveAttribute('title', long)
    expect(name.className).toBe('pm-saved-first')
    expect(savedMemoriesCardCss).toMatch(/\.pm-saved-first \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/)
    expect(container.querySelector('.pm-saved-chevron')).toHaveTextContent('›')
  })

  it('点一下展开成卡片（每条记忆卡、查看详情、删除），再点收起；展开状态不持久，重挂又是折叠', () => {
    const card = <SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={items} now={NOW} openDetail={() => {}} />
    const { unmount } = renderInShell(card)
    const toggle = screen.getByRole('button', { expanded: false })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAccessibleName('这一轮记住了 2 条')
    expect(screen.getByText('测试里用真实 Postgres。')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '删除这条记忆' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '查看详情 ›' })).toHaveLength(2)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('测试里用真实 Postgres。')).toBeNull()

    fireEvent.click(toggle)
    unmount()
    renderInShell(card)
    expect(screen.getByRole('button', { name: '这轮记住了 2 条新记忆：测试不 mock 数据库' })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('交付卡删除的原位确认', () => {
  const QUESTION = '删除这条？'

  it('点垃圾桶不直接删：图标位置换成「删除这条？ 删除 · 取消」，焦点在「取消」，什么命令都没发', async () => {
    const { gateway } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />)
    expand()
    const trash = screen.getByRole('button', { name: '删除这条记忆' })
    trash.focus()
    await act(async () => { fireEvent.click(trash) })
    const group = screen.getByRole('group', { name: QUESTION })
    const confirm = within(group)
    // 组名指向那句问话，不另写一份 aria-label
    expect(group).not.toHaveAttribute('aria-label')
    expect(group.getAttribute('aria-labelledby')).toBe(confirm.getByText(QUESTION).id)
    expect(confirm.getAllByRole('button').map(b => b.textContent)).toEqual(['删除', '取消'])
    expect(confirm.getByRole('button', { name: '取消' })).toHaveFocus()
    expect(screen.queryByRole('button', { name: '删除这条记忆' })).toBeNull()
    expect(screen.getByText('原文')).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
  })

  it('「取消」、Esc、焦点移走都收起确认，垃圾桶回来，什么都不发', async () => {
    const { gateway } = renderInShell(
      <>
        <button type="button">别处</button>
        <SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />
      </>,
    )
    expand()
    const open = async () => {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除这条记忆' })) })
      return within(screen.getByRole('group', { name: QUESTION }))
    }
    fireEvent.click((await open()).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('group', { name: QUESTION })).toBeNull()
    await waitFor(() => { expect(screen.getByRole('button', { name: '删除这条记忆' })).toHaveFocus() })

    fireEvent.keyDown((await open()).getByRole('button', { name: '取消' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: QUESTION })).toBeNull()

    await open()
    act(() => { screen.getByRole('button', { name: '别处' }).focus() })
    expect(screen.queryByRole('group', { name: QUESTION })).toBeNull()
    expect(screen.getByRole('button', { name: '别处' })).toHaveFocus()
    expect(screen.getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
  })
})

describe('交付卡删除确认：鼠标与指针', () => {
  const QUESTION = '删除这条？'
  const open = async () => {
    expand()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除这条记忆' })) })
    return within(screen.getByRole('group', { name: QUESTION }))
  }

  it('鼠标点「删除」时浏览器不把焦点给按钮（Safari）：「取消」失焦到页面上不收起，点击照常发 forget', async () => {
    // 真浏览器里焦点掉到 body 时文档仍有焦点
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    try {
      const { gateway } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />)
      const confirm = await open()
      const ok = confirm.getByRole('button', { name: '删除' })
      fireEvent.pointerDown(ok)
      fireEvent.mouseDown(ok)
      act(() => { confirm.getByRole('button', { name: '取消' }).blur() })
      expect(screen.getByRole('group', { name: QUESTION })).toBeInTheDocument()
      await act(async () => { fireEvent.click(ok) })
      expect(gateway.executed.map(e => e.command.cmd)).toEqual(['forget'])
    } finally {
      hasFocus.mockRestore()
    }
  })

  it('在确认以外按下指针就收起，什么都不发；在确认里按下（问话、按钮）不收', async () => {
    const { gateway } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />)
    const confirm = await open()
    fireEvent.pointerDown(confirm.getByText(QUESTION))
    fireEvent.pointerDown(confirm.getByRole('button', { name: '删除' }))
    expect(screen.getByRole('group', { name: QUESTION })).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByText('原文'))
    expect(screen.queryByRole('group', { name: QUESTION })).toBeNull()
    expect(screen.getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
  })
})

describe('交付卡', () => {
  it('「这一轮记住了 N 条」，每条一张记忆卡；删除发 forget，原位留撤销提示，撤销发 restore', async () => {
    const gateway = createFakeGateway()
    const items = [saved('mem_1', '测试不 mock 数据库'), saved('mem_2', '提交信息用英文')]
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={items} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    expect(screen.getByRole('heading', { name: '这一轮记住了 2 条' })).toBeInTheDocument()
    expect(screen.getByText('测试不 mock 数据库')).toBeInTheDocument()

    await remove(screen.getAllByRole('button', { name: '删除这条记忆' })[0]!)
    expect(await screen.findByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
    expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'forget', memoryId: 'mem_1', layer: { kind: 'workspace', workspacePath: '/w/app' } } }])
    expect(screen.queryByText('测试不 mock 数据库')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByText('测试不 mock 数据库')).toBeInTheDocument()
    expect(gateway.executed.at(-1)).toEqual({ sessionId: 's1', command: { cmd: 'restore', memoryId: 'mem_1', layer: { kind: 'workspace', workspacePath: '/w/app' } } })
  })

  it('本项目记忆：删除与撤销都带上会话所属项目的层（取会话视图里的项目，不用原始 cwd）', async () => {
    const session: SessionView = {
      version: GUI_VIEW_VERSION, sessionId: 's1', workspacePath: '/w/app', frozenAt: 2, origin: 'start', budget: 4000, overflowMode: 'relax',
      tokens: { workspace: 0, global: 0, fixed: 0 }, usedTokens: 0, injectedIds: [], coreIds: [], titleOnlyIds: [], omittedCount: 0, savedIds: [],
    }
    const gateway = createFakeGateway({ views: { session } })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app/packages/web" saved={[saved('mem_w', '提交前跑测试')]} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    await remove(screen.getByRole('button', { name: '删除这条记忆' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await screen.findByText('提交前跑测试')
    const layer = { kind: 'workspace', workspacePath: '/w/app' }
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'mem_w', layer },
      { cmd: 'restore', memoryId: 'mem_w', layer },
    ])
  })

  it('全局记忆：删除与撤销都带上全局层，服务端只动全局那一份', async () => {
    const gateway = createFakeGateway()
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_g', '回答用中文', 'global')]} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    await remove(screen.getByRole('button', { name: '删除这条记忆' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    await screen.findByText('回答用中文')
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'mem_g', layer: { kind: 'global' } },
      { cmd: 'restore', memoryId: 'mem_g', layer: { kind: 'global' } },
    ])
  })

  it('记忆卡的类型写显示名（待处理视图的 typeLabels）', () => {
    const gateway = createFakeGateway({ views: { pending: { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: { preference: '行为偏好' } } } })
    const { container } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    expect(container.querySelector('.pm-mc-meta')).toHaveTextContent(/^行为偏好/)
  })

  it('待处理视图没有这个类型时，类型显示名取全部记忆视图的 typeLabels', () => {
    const library: LibraryView = { version: GUI_VIEW_VERSION, memoryRoot: '/m', layers: [], directoryIssues: [], typeLabels: { preference: '行为偏好' } }
    const gateway = createFakeGateway({ views: { library, pending: { version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: {} } } })
    const { container } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    expect(container.querySelector('.pm-mc-meta')).toHaveTextContent(/^行为偏好/)
  })

  it('含密钥的记忆：forget 回 has-secret 时原位确认、不说可找回；「彻底删除」发 hard-delete，之后只留不可恢复的说明、没有撤销，卸载重挂也一样', async () => {
    const gateway = createFakeGateway({
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret' }
        : { ok: true, cmd: command.cmd, memoryIds: ['mem_1'] },
    })
    const card = <SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />
    const { unmount } = renderInShell(card, gateway)
    expand()
    await remove(screen.getByRole('button', { name: '删除这条记忆' }))
    expect(await screen.findByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(screen.getByText('原文')).toBeInTheDocument()
    expect(screen.queryByText(/14 天/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'mem_1', layer: { kind: 'workspace', workspacePath: '/w/app' } }, { cmd: 'hard-delete', memoryId: 'mem_1', layer: { kind: 'workspace', workspacePath: '/w/app' } }])
    expect(screen.queryByText('原文')).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()

    unmount()
    renderInShell(card, gateway)
    expand()
    expect(screen.getByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('含密钥确认时点「取消」：收起确认，原文和删除按钮照旧', async () => {
    const gateway = createFakeGateway({ respond: command => ({ ok: false, cmd: command.cmd, code: 'has-secret' }) })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    await remove(screen.getByRole('button', { name: '删除这条记忆' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))
    expect(screen.queryByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeNull()
    expect(screen.getByText('原文')).toBeInTheDocument()
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'mem_1', layer: { kind: 'workspace', workspacePath: '/w/app' } }])
  })

  it('含密钥确认收起后键盘焦点不丢：「取消」回到删除按钮；彻底删除后落到原位那行说明上', async () => {
    const gateway = createFakeGateway({
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret' }
        : { ok: true, cmd: command.cmd, memoryIds: ['mem_1'] },
    })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文'), saved('mem_2', '另一条')]} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    const row = within(screen.getAllByRole('button', { name: '删除这条记忆' })[0]!.closest<HTMLElement>('[data-memory-id]')!)
    const press = async (button: HTMLElement) => {
      button.focus()
      await act(async () => { fireEvent.click(button) })
    }
    await press(row.getByRole('button', { name: '删除这条记忆' }))
    await press(row.getByRole('button', { name: '删除' }))
    const cancel = await row.findByRole('button', { name: '取消' })
    await press(cancel)
    await waitFor(() => { expect(row.getByRole('button', { name: '删除这条记忆' })).toHaveFocus() })

    await press(row.getByRole('button', { name: '删除这条记忆' }))
    await press(row.getByRole('button', { name: '删除' }))
    const confirm = await screen.findByRole('button', { name: '彻底删除' })
    confirm.focus()
    fireEvent.click(confirm)
    await waitFor(() => { expect(screen.getByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')).toHaveFocus() })
  })

  it('删除后焦点落到原位的「撤销」，不掉到页面上', async () => {
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />)
    expand()
    const del = screen.getByRole('button', { name: '删除这条记忆' })
    del.focus()
    await act(async () => { fireEvent.click(del) })
    const ok = screen.getByRole('button', { name: '删除' })
    ok.focus()
    await act(async () => { fireEvent.click(ok) })
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
  })

  it('删除失败时原文还在，旁边写服务端原话', async () => {
    const gateway = createFakeGateway({ respond: () => ({ ok: false, code: 'not-found', detail: '记忆不存在' }) })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '原文')]} now={NOW} openDetail={() => {}} />, gateway)
    expand()
    await remove(screen.getByRole('button', { name: '删除这条记忆' }))
    expect(await screen.findByText('没有成功：记忆不存在')).toBeInTheDocument()
    expect(screen.getByText('原文')).toBeInTheDocument()
  })
})

describe('交付卡：提升候选就地处理', () => {
  const WS = '/w/app'
  const named = (id: string, name: string, content: string): SavedMemory => {
    const item = saved(id, content)
    return { ...item, memory: { ...item.memory, name, workspacePath: WS } }
  }
  const cand = named('mem_c', '都用 vitest', '所有项目都用 vitest。')
  const plain = named('mem_p', '提交信息用英文', '提交信息写英文。')
  /** 全部记忆视图：这几条在本项目，按 promotion 标状态；global 里的同 id 表示已提升。 */
  const libraryOf = (project: SavedMemory['memory'][], global: SavedMemory['memory'][] = []): LibraryView => ({
    version: GUI_VIEW_VERSION, memoryRoot: '/m', directoryIssues: [],
    layers: [{ layer: { kind: 'global' }, items: global }, { layer: { kind: 'workspace', workspacePath: WS }, items: project }],
  })
  const asCandidate = { ...cand.memory, promotion: 'candidate' as const }
  const layer = { kind: 'workspace', workspacePath: WS }
  const card = (gateway = createFakeGateway({ views: { library: libraryOf([asCandidate, plain.memory]) } })) => {
    const utils = renderInShell(<SavedMemoriesCard sessionId="s1" cwd={WS} saved={[plain, cand]} now={NOW} openDetail={() => {}} />, gateway)
    return { ...utils, gateway }
  }
  const row = (id: string) => within(document.querySelector<HTMLElement>(`.pm-saved-row[data-memory-id="${id}"]`)!)

  it('折叠行末尾加「· N 条可提升为全局」（按全部记忆视图里还是候选的数）；没有候选时不加', () => {
    const { unmount } = card()
    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle).toHaveTextContent('这轮记住了 2 条新记忆：提交信息用英文·1 条可提升为全局›')
    unmount()
    card(createFakeGateway({ views: { library: libraryOf([cand.memory, plain.memory]) } }))
    expect(screen.getByRole('button', { expanded: false })).not.toHaveTextContent('可提升为全局')
  })

  it('展开后候选那条的元信息带「可提升为全局」，下方「留在本项目」「提升为全局」；不是候选的没有', () => {
    card()
    expand()
    expect(row('mem_c').getByText('可提升为全局').closest('.pm-mc-meta')).not.toBeNull()
    expect(row('mem_c').getAllByRole('button').map(b => b.textContent)).toEqual(['留在本项目', '提升为全局', '查看详情 ›', ''])
    expect(row('mem_p').queryByText('可提升为全局')).toBeNull()
    expect(row('mem_p').queryByRole('button', { name: '提升为全局' })).toBeNull()
  })

  it('「提升为全局」按记忆 id 发 promote-memory（带层），成功后换成结果文字「已提升为全局」，不再有按钮', async () => {
    const { gateway } = card()
    expand()
    await act(async () => { fireEvent.click(row('mem_c').getByRole('button', { name: '提升为全局' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'promote-memory', memoryId: 'mem_c', layer }])
    expect(row('mem_c').getByText('已提升为全局')).toBeInTheDocument()
    expect(row('mem_c').queryByRole('button', { name: '提升为全局' })).toBeNull()
    expect(row('mem_c').queryByRole('button', { name: '留在本项目' })).toBeNull()
  })

  it('「留在本项目」发 keep-local-memory（带层），成功后换成结果文字「留在本项目」', async () => {
    const { gateway } = card()
    expand()
    await act(async () => { fireEvent.click(row('mem_c').getByRole('button', { name: '留在本项目' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'keep-local-memory', memoryId: 'mem_c', layer }])
    expect(row('mem_c').getByText('留在本项目').closest('.pm-chip')).not.toBeNull()
    expect(row('mem_c').queryByRole('button', { name: '留在本项目' })).toBeNull()
  })

  it('别处（右侧栏、待处理）处理过的按视图换成结果文字：提升了的在全局层，留下的标 kept-local；折叠行不再数它们', () => {
    const gateway = createFakeGateway({ views: { library: libraryOf([plain.memory], [{ ...cand.memory, scope: 'global', workspacePath: undefined }]) } })
    const { unmount } = card(gateway)
    expect(screen.getByRole('button', { expanded: false })).not.toHaveTextContent('可提升为全局')
    expand()
    expect(row('mem_c').getByText('已提升为全局')).toBeInTheDocument()
    expect(row('mem_c').queryByRole('button', { name: '提升为全局' })).toBeNull()
    // 作用域按全局那一份写，删除也落在全局
    expect(document.querySelector('.pm-saved-row[data-memory-id="mem_c"] .pm-mc-meta')).toHaveTextContent(/^preference·全局·/)
    unmount()
    card(createFakeGateway({ views: { library: libraryOf([{ ...cand.memory, promotion: 'kept-local' }, plain.memory]) } }))
    expand()
    expect(row('mem_c').getByText('留在本项目')).toBeInTheDocument()
    expect(row('mem_c').queryByRole('button', { name: '提升为全局' })).toBeNull()
  })

  it('别处正在处理或刚处理完（claimed / not-found）：原位写「没有生效」，用户看得出自己的选择没算数', async () => {
    const { gateway } = card(createFakeGateway({
      views: { library: libraryOf([asCandidate, plain.memory]) },
      respond: command => ({ ok: false, cmd: command.cmd, code: 'claimed' }),
    }))
    expand()
    await act(async () => { fireEvent.click(row('mem_c').getByRole('button', { name: '留在本项目' })) })
    expect(row('mem_c').getByRole('alert')).toHaveTextContent('你对「都用 vitest」的选择没有生效：它正在别处处理，或者刚在别处处理完。')
    // 那边的结果写进视图后换成结果文字，说明还留着
    act(() => { gateway.setView('library', libraryOf([plain.memory], [{ ...cand.memory, scope: 'global', workspacePath: undefined }])) })
    expect(row('mem_c').getByText('已提升为全局')).toBeInTheDocument()
    expect(row('mem_c').getByRole('alert')).toBeInTheDocument()
  })

  it('属于别的项目时服务端先拒：原位跨项目确认，「继续处理」带 allowCrossWorkspace 重发', async () => {
    const { gateway } = card(createFakeGateway({
      views: { library: libraryOf([asCandidate, plain.memory]) },
      respond: command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: true, cmd: command.cmd, memoryIds: ['mem_c'] }
        : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'mem_c', workspacePath: '/w/other' }] },
    }))
    expand()
    await act(async () => { fireEvent.click(row('mem_c').getByRole('button', { name: '提升为全局' })) })
    await act(async () => { fireEvent.click(row('mem_c').getByRole('button', { name: '继续处理' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'promote-memory', memoryId: 'mem_c', layer },
      { cmd: 'promote-memory', memoryId: 'mem_c', layer, allowCrossWorkspace: true },
    ])
    expect(row('mem_c').getByText('已提升为全局')).toBeInTheDocument()
  })

  it('英文：折叠行、chip 与两个按钮', () => {
    render(
      <PanelShell gateway={createFakeGateway({ views: { library: libraryOf([asCandidate, plain.memory]) } })} t={createTranslator(en)}>
        <SavedMemoriesCard sessionId="s1" cwd={WS} saved={[plain, cand]} now={NOW} openDetail={() => {}} />
      </PanelShell>,
    )
    const toggle = screen.getByRole('button', { expanded: false })
    expect(toggle).toHaveTextContent('1 could become global')
    fireEvent.click(toggle)
    expect(row('mem_c').getByText('Could become global')).toBeInTheDocument()
    expect(row('mem_c').getByRole('button', { name: 'Keep in this project' })).toBeInTheDocument()
    expect(row('mem_c').getByRole('button', { name: 'Make global' })).toBeInTheDocument()
  })
})

describe('交付卡与其他界面共用删除状态', () => {
  const WS = '/w/app'
  const fresh = (): SavedMemory => ({
    callId: 'c-n1', seq: 3,
    memory: { id: 'n1', name: 'n1', type: 'knowledge', scope: 'workspace', workspacePath: WS, summary: '', content: '报销截止每月 25 日。', tags: [], sourceMode: 'user-explicit', createdAt: NOW, updatedAt: NOW, lastConfirmedAt: NOW, filePath: '/m/app/n1.md' },
  })
  const libraryView = (): LibraryView => ({
    version: GUI_VIEW_VERSION, memoryRoot: '/m', directoryIssues: [],
    layers: [{ layer: { kind: 'workspace', workspacePath: WS }, items: [fresh().memory] }],
  })
  const sessionView: SessionView = {
    version: GUI_VIEW_VERSION, sessionId: 's1', workspacePath: WS, frozenAt: 2, origin: 'start', budget: 4000, overflowMode: 'relax',
    tokens: { workspace: 10, global: 0, fixed: 0 }, usedTokens: 10, injectedIds: [], coreIds: [], titleOnlyIds: [], omittedCount: 0, savedIds: ['n1'],
  }
  const secretFirst = (command: MemoryCommand): MemoryCommandResult => command.cmd === 'forget'
    ? { ok: false, cmd: command.cmd, code: 'has-secret' }
    : { ok: true, cmd: command.cmd, memoryIds: ['n1'] }
  const chatCard = () => within(screen.getByRole('region', { name: '这一轮记住了 1 条' }))
  const PURGED = '已彻底删除。如果它是真的凭证，记得去换一个新的。'

  it('右侧栏彻底删除后，交付卡里同一条换成不可恢复的说明，不再有删除按钮', async () => {
    const gateway = createFakeGateway({ views: { library: libraryView(), session: sessionView }, respond: secretFirst })
    renderInShell(
      <>
        <SidebarTab sessionId="s1" workspacePath={WS} openPage={() => {}} />
        <SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />
      </>,
      gateway,
    )
    expand(chatCard())
    const side = within(screen.getByRole('region', { name: '这次新写入的' }))
    await act(async () => { fireEvent.click(side.getByRole('button', { name: '删除这条记忆' })) })
    await act(async () => { fireEvent.click(side.getByRole('button', { name: '删除' })) })
    await act(async () => { fireEvent.click(side.getByRole('button', { name: '彻底删除' })) })
    expect(chatCard().getByText(PURGED)).toBeInTheDocument()
    expect(chatCard().queryByRole('button', { name: '删除这条记忆' })).toBeNull()
  })

  it('全部记忆里删除：交付卡里同一条换成「已删除」可撤销', async () => {
    const gateway = createFakeGateway({ views: { library: libraryView() } })
    const session = { kind: 'ready', sessionId: 's1', cwd: WS } as const
    const scope = { kind: 'workspace', workspacePath: WS } as const
    renderInShell(
      <>
        <LibraryTab nav={createNavStore()} scope={scope} session={session} now={NOW} />
        <SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />
      </>,
      gateway,
    )
    expand(chatCard())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })) })
    expect(chatCard().getByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
    expect(chatCard().queryByRole('button', { name: '删除这条记忆' })).toBeNull()
  })

  it('确认开着时别处删了这条：撤销回来后是垃圾桶，不带着没收起的确认', async () => {
    const gateway = createFakeGateway({ views: { library: libraryView() } })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />, gateway)
    expand(chatCard())
    await act(async () => { fireEvent.click(chatCard().getByRole('button', { name: '删除这条记忆' })) })
    expect(chatCard().getByRole('group', { name: '删除这条？' })).toBeInTheDocument()
    act(() => {
      gateway.setView('library', { ...libraryView(), layers: [{ layer: { kind: 'workspace' as const, workspacePath: WS }, items: [] }] })
      gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [{ memory: fresh().memory, deletedAt: NOW, purgeAt: NOW + 1 }] })
    })
    await act(async () => { fireEvent.click(chatCard().getByRole('button', { name: '撤销' })) })
    expect(chatCard().queryByRole('group', { name: '删除这条？' })).toBeNull()
    expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
  })

  it('对话里 agent 自己删掉（最近删除视图里有这条）：交付卡换成「已删除」可撤销；撤销后视图还没刷新也不弹回去', async () => {
    const gateway = createFakeGateway({ views: { library: libraryView() } })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />, gateway)
    expand(chatCard())
    expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    const gone = { ...libraryView(), layers: [{ layer: { kind: 'workspace' as const, workspacePath: WS }, items: [] }] }
    act(() => {
      gateway.setView('library', gone)
      gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [{ memory: fresh().memory, deletedAt: NOW, purgeAt: NOW + 1 }] })
    })
    expect(chatCard().getByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(chatCard().getByRole('button', { name: '撤销' })) })
    expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    act(() => { gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [] }) })
    expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
  })

  it('同 id 在两层都在用、在全部记忆里只删了别层那份：交付卡与右侧栏里这份照常显示，视图跟上后也不变', async () => {
    const globalCopy = { ...fresh().memory, scope: 'global' as const, workspacePath: undefined, filePath: '/m/global/n1.md' }
    const both: LibraryView = { ...libraryView(), layers: [{ layer: { kind: 'global' }, items: [globalCopy] }, ...libraryView().layers] }
    const gateway = createFakeGateway({ views: { library: both, session: sessionView } })
    const session = { kind: 'ready', sessionId: 's1', cwd: WS } as const
    renderInShell(
      <>
        <LibraryTab nav={createNavStore()} scope={{ kind: 'global' }} session={session} now={NOW} />
        <SidebarTab sessionId="s1" workspacePath={WS} openPage={() => {}} />
        <SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />
      </>,
      gateway,
    )
    expand(chatCard())
    const stillShown = () => {
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
      expect(within(screen.getByRole('region', { name: '这次新写入的' })).getByText('报销截止每月 25 日。')).toBeInTheDocument()
    }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'n1', layer: { kind: 'global' } }])
    stillShown()
    act(() => {
      gateway.setView('library', libraryView())
      gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [{ memory: globalCopy, deletedAt: NOW, purgeAt: NOW + 1 }] })
    })
    stillShown()
  })

  it('最近删除里有同 id 的副本、全部记忆里这条还在用（别层的副本被删）：不当成已删除', () => {
    const gateway = createFakeGateway({
      views: { library: libraryView(), deleted: { version: GUI_VIEW_VERSION, items: [{ memory: { ...fresh().memory, scope: 'global', workspacePath: undefined }, deletedAt: NOW, purgeAt: NOW + 1 }] } },
    })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />, gateway)
    expand(chatCard())
    expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
  })

  describe('agent 在对话里彻底删除（两份视图里都没有了）', () => {
    const emptyViews = (libraryAt: number | undefined, deletedAt = libraryAt): { library: LibraryView; deleted: DeletedView } => ({
      library: { ...libraryView(), layers: [], inactiveIds: [], hasUnreadFiles: false, ...(libraryAt === undefined ? {} : { generatedAt: libraryAt }) },
      deleted: { version: GUI_VIEW_VERSION, items: [], ...(deletedAt === undefined ? {} : { generatedAt: deletedAt }) },
    })
    const render = (gateway: ReturnType<typeof createFakeGateway>) => {
      renderInShell(<SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />, gateway)
      expand(chatCard())
    }

    it('晚于记下时刻的新视图到了：换成不可恢复的说明，没有删除按钮', () => {
      const gateway = createFakeGateway({ views: { library: libraryView(), deleted: { version: GUI_VIEW_VERSION, items: [], generatedAt: NOW - 10 } } })
      render(gateway)
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
      const next = emptyViews(NOW + 1000)
      act(() => { gateway.setView('library', next.library); gateway.setView('deleted', next.deleted) })
      expect(chatCard().getByText(PURGED)).toBeInTheDocument()
      expect(chatCard().queryByRole('button', { name: '删除这条记忆' })).toBeNull()
    })

    it('被取代了（视图把它列在不在用的 id 里）：不判彻底删除，照常显示', () => {
      const gateway = createFakeGateway({ views: { library: libraryView(), deleted: { version: GUI_VIEW_VERSION, items: [] } } })
      render(gateway)
      const next = emptyViews(NOW + 1000)
      act(() => { gateway.setView('library', { ...next.library, inactiveIds: ['n1'] }); gateway.setView('deleted', next.deleted) })
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
      expect(chatCard().queryByText(PURGED)).toBeNull()
    })

    it('有读不出的文件（可能就是它被改坏了）、或视图没给出不在用的 id：不判彻底删除', () => {
      const gateway = createFakeGateway({ views: { library: libraryView(), deleted: { version: GUI_VIEW_VERSION, items: [] } } })
      render(gateway)
      const next = emptyViews(NOW + 1000)
      act(() => { gateway.setView('library', { ...next.library, hasUnreadFiles: true }); gateway.setView('deleted', next.deleted) })
      expect(chatCard().queryByText(PURGED)).toBeNull()
      const { inactiveIds: _omit, ...legacy } = next.library
      act(() => { gateway.setView('library', legacy); gateway.setView('deleted', next.deleted) })
      expect(chatCard().queryByText(PURGED)).toBeNull()
    })

    it('视图里从没出现过这条（收集落在记下与写盘之间）：只是缺席，不判彻底删除', () => {
      render(createFakeGateway({ views: emptyViews(NOW + 1000) }))
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
      expect(chatCard().queryByText(PURGED)).toBeNull()
    })

    it('视图生成在记下之前（刚记下、视图还没写）：不判彻底删除', () => {
      const views = emptyViews(NOW - 1000)
      render(createFakeGateway({ views }))
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
      expect(chatCard().queryByText(PURGED)).toBeNull()
    })

    it('旧视图文件没有 generatedAt：不判彻底删除', () => {
      render(createFakeGateway({ views: emptyViews(undefined) }))
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    })

    it('两份视图不是同一次收集写的：不判彻底删除', () => {
      render(createFakeGateway({ views: emptyViews(NOW + 1000, NOW + 2000) }))
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    })

    it('交付卡里刚恢复、视图还没跟上：不判彻底删除', async () => {
      const gateway = createFakeGateway({ views: { library: libraryView(), deleted: { version: GUI_VIEW_VERSION, items: [] } } })
      render(gateway)
      await remove(chatCard().getByRole('button', { name: '删除这条记忆' }))
      await act(async () => { fireEvent.click(chatCard().getByRole('button', { name: '撤销' })) })
      const next = emptyViews(NOW + 1000)
      act(() => { gateway.setView('library', next.library); gateway.setView('deleted', next.deleted) })
      expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    })
  })

  it('刚记下、视图里还没有这条：不当成已删除', () => {
    const gateway = createFakeGateway({
      views: { library: { ...libraryView(), layers: [] }, deleted: { version: GUI_VIEW_VERSION, items: [] } },
    })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />, gateway)
    expand(chatCard())
    expect(chatCard().getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    expect(chatCard().queryByText(PURGED)).toBeNull()
  })

  it('交付卡里删除后最近删除视图还没刷新：仍显示「已删除」，不弹回去', async () => {
    const gateway = createFakeGateway({ views: { library: libraryView(), deleted: { version: GUI_VIEW_VERSION, items: [] } } })
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />, gateway)
    expand(chatCard())
    await remove(chatCard().getByRole('button', { name: '删除这条记忆' }))
    act(() => { gateway.setView('deleted', { version: GUI_VIEW_VERSION, items: [] }) })
    expect(chatCard().getByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
  })

  it('交付卡里删除后，右侧栏「这次新写入的」里同一条也去掉', async () => {
    const gateway = createFakeGateway({ views: { library: libraryView(), session: sessionView } })
    renderInShell(
      <>
        <SidebarTab sessionId="s1" workspacePath={WS} openPage={() => {}} />
        <SavedMemoriesCard sessionId="s1" cwd={WS} saved={[fresh()]} now={NOW} openDetail={() => {}} />
      </>,
      gateway,
    )
    expand(chatCard())
    await remove(chatCard().getByRole('button', { name: '删除这条记忆' }))
    expect(screen.queryByRole('region', { name: '这次新写入的' })).toBeNull()
    await act(async () => { fireEvent.click(chatCard().getByRole('button', { name: '撤销' })) })
    expect(within(screen.getByRole('region', { name: '这次新写入的' })).getByText('报销截止每月 25 日。')).toBeInTheDocument()
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
    const { container } = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={data!.saved} now={NOW} openDetail={() => {}} />, createFakeGateway())
    expect(container.textContent).not.toContain(KEY)
    expect(container.textContent).toContain('[已隐藏]')
    expand()
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
    const card = renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={data!.saved} now={NOW} openDetail={() => {}} />, createFakeGateway())
    expect(card.container.textContent).not.toContain('Hunter2-2026')
    expand()
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
    expand()
    await remove(screen.getByRole('button', { name: '删除这条记忆' }))
    await waitFor(() => expect(execute).toHaveBeenCalledWith('s1', '/memory forget {"memoryId":"mem_1","layer":{"kind":"workspace","workspacePath":"/w/app"}}', []))
  })

  it('每条各有「查看详情 ›」：先写导航目标（全部记忆 · 这条所在作用域 · 这条的 id），再切到记忆页', () => {
    const { registered, nav, ctx } = fakeHost()
    const Tail = registered.find(r => r.options.name === 'conversation.chat.turnTail')!.component as ComponentType<TurnTailProps>
    render(<Tail {...tailProps({ saved: [saved('mem_1', '原文'), saved('mem_g', '全局', 'global'), saved('mem_2', '二')] })} />)
    expand()
    const links = screen.getAllByRole('button', { name: '查看详情 ›' })
    expect(links).toHaveLength(3)
    expect(links.map(link => link.closest('[data-memory-id]')?.getAttribute('data-memory-id'))).toEqual(['mem_1', 'mem_g', 'mem_2'])
    fireEvent.click(links[2]!)
    expect(nav.get()).toEqual({ tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/app' }, memoryId: 'mem_2' })
    expect(ctx.layout.selectPanel).toHaveBeenCalledWith(PANEL_ID)
    fireEvent.click(links[1]!)
    expect(nav.get()).toEqual({ tab: 'library', scope: { kind: 'global' }, memoryId: 'mem_g' })
  })

  it('删掉的那条不再有「查看详情 ›」', async () => {
    renderInShell(<SavedMemoriesCard sessionId="s1" cwd="/w/app" saved={[saved('mem_1', '一'), saved('mem_2', '二')]} now={NOW} openDetail={() => {}} />)
    expand()
    await remove(screen.getAllByRole('button', { name: '删除这条记忆' })[0]!)
    expect(screen.getAllByRole('button', { name: '查看详情 ›' }).map(link => link.closest('[data-memory-id]')?.getAttribute('data-memory-id'))).toEqual(['mem_2'])
  })
})

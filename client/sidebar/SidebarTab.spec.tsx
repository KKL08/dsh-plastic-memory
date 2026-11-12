// 右侧栏「记忆」tab：四种状态、用量条口径与两种超限、就地裁决与撤销、新记的实时增加、底部入口跳转。全部对内存假网关。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  GUI_VIEW_VERSION,
  type HealthView, type LibraryView, type MemoryCard, type ModelChange, type PendingItem, type PendingView, type ProposalAction, type ProposalOp, type SessionView,
} from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import type { PluginConfig } from '../gateway.ts'
import { createNavStore, openMemoryPage, PANEL_ID } from '../nav.ts'
import { memory, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { SidebarTab, sidebarTabCss } from './SidebarTab.tsx'
import { conflictRulingCss } from '../ui/ConflictRuling.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'

const WS = '/w/app'
/** 插件本次加载时刻（健康视图的 bootedAt）。 */
const BOOTED = 1_000

const pref = memory({ id: 'p1', type: 'preference', content: '测试用真实 Postgres。' })
const pref2 = memory({ id: 'p2', type: 'preference', content: '测试里 mock 数据库就行。' })
const proj = memory({ id: 'j1', type: 'project', content: 'merge freeze 到 3 月 5 日。' })
const glob = memory({ id: 'g1', type: 'profile', scope: 'global', workspacePath: undefined, content: '用户是数据工程师。' })

function library(...items: MemoryCard[]): LibraryView {
  return {
    version: GUI_VIEW_VERSION, memoryRoot: '/m', directoryIssues: [],
    layers: [
      { layer: { kind: 'global' }, items: items.filter(m => m.scope === 'global') },
      { layer: { kind: 'workspace', workspacePath: WS }, items: items.filter(m => m.scope === 'workspace') },
    ],
  }
}

function snapshot(overrides: Partial<SessionView> = {}): SessionView {
  return {
    version: GUI_VIEW_VERSION, sessionId: 's1', workspacePath: WS, frozenAt: BOOTED + 1, origin: 'start', budget: 4000, overflowMode: 'relax',
    tokens: { workspace: 1870, global: 1050, fixed: 200 }, usedTokens: 2920,
    injectedIds: ['p1', 'j1', 'g1'], coreIds: ['p1', 'p2', 'g1'], titleOnlyIds: [], omittedCount: 0, savedIds: [],
    ...overrides,
  }
}

/** null = 视图没带 bootedAt（旧服务端）。 */
function health(bootedAt: number | null = BOOTED): HealthView {
  return { version: GUI_VIEW_VERSION, governanceEnabled: true, ...(bootedAt === null ? {} : { bootedAt }), layers: [] }
}

function pending(...items: PendingItem[]): PendingView {
  return { version: GUI_VIEW_VERSION, dot: items.length > 0 ? 'amber' : 'none', items, levelCounts: levelCountsOf(items), typeLabels: {} }
}

const conflict: PendingItem = { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'pd_1', firstSeenAt: 1, summary: '', left: pref, right: pref2 }
const REASON = 'A 是后来明确说的，B 是早先的临时做法。'
/** 带处理建议的冲突（结论按参数）：只留一条的另一条删除，都保留不动，融合把稿写进 A、删 B。 */
function suggested(action: ProposalAction, id = 'sg_1', item: PendingItem = conflict): PendingItem {
  const ops: ProposalOp[] = action === 'keep-a' ? [{ kind: 'keep', memoryId: 'p1' }, { kind: 'forget', memoryId: 'p2' }]
    : action === 'keep-b' ? [{ kind: 'forget', memoryId: 'p1' }, { kind: 'keep', memoryId: 'p2' }]
      : action === 'keep-both' ? [{ kind: 'keep', memoryId: 'p1' }, { kind: 'keep', memoryId: 'p2' }]
        : [{ kind: 'edit', memoryId: 'p1', content: '集成测试用真实 Postgres，单元测试可以 mock。', name: pref.name, summary: pref.summary, tags: [] }, { kind: 'forget', memoryId: 'p2' }]
  return { ...item, suggestion: { id, action, reason: REASON, ops, isSourced: false } } as PendingItem
}
/** 建议保留 A 的冲突：右侧栏能直接采纳。 */
const adoptable = suggested('keep-a')
const promote: PendingItem = { kind: 'promote-candidate', level: 'your-call', decisionId: 'pd_2', firstSeenAt: 1, memory: proj }
const vertical: PendingItem = { kind: 'conflict-vertical', level: 'your-call', decisionId: 'pd_v', firstSeenAt: 1, summary: '', memory: proj, baselineRef: 'AGENTS.md：merge freeze' }

/** 插件配置，去处按参数。 */
function configWith(globalPromoteTarget: PluginConfig['globalPromoteTarget']): PluginConfig {
  return { snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governanceEnabled: true, globalPromoteTarget, accent: 'ella', customTypes: {} }
}

function setup(views: FakeGatewayInit['views'], respond?: FakeGatewayInit['respond'], config: PluginConfig = configWith('plugin-global')) {
  const gateway = createFakeGateway({ views: { health: health(), ...views }, ...(respond === undefined ? {} : { respond }), config })
  const openPage = vi.fn()
  const utils = renderInShell(<SidebarTab sessionId="s1" workspacePath={WS} openPage={openPage} />, gateway)
  return { ...utils, gateway, openPage }
}

/** 点行尾垃圾桶，再点原位确认里的「删除」。 */
async function remove(trash: HTMLElement) {
  const row = trash.parentElement!
  await act(async () => { fireEvent.click(trash) })
  await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '删除' })) })
}

describe('SidebarTab 四种状态', () => {
  it('无记忆：首次空状态，说明记忆从哪来', () => {
    setup({ library: library(), session: snapshot({ injectedIds: [], tokens: { workspace: 0, global: 0, fixed: 0 }, usedTokens: 0 }), pending: pending() })
    expect(screen.getByText('还没有记忆')).toBeInTheDocument()
    expect(screen.getByText(/agent 在对话里记下你的偏好/)).toBeInTheDocument()
    expect(screen.queryByText('对话开始时带入的记忆')).toBeNull()
  })

  it('有全局没本项目：提示本项目还没有记忆，列出带入的全局记忆，不写「本项目 0 条」', () => {
    setup({ library: library(glob), session: snapshot({ injectedIds: ['g1'] }), pending: pending() })
    expect(screen.getByText('本项目还没有记忆，这次带入的都是全局记忆。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '用户画像 1 全文' }))
    expect(screen.getByText('用户是数据工程师。')).toBeInTheDocument()
    expect(screen.queryByText(/本项目 0 条/)).toBeNull()
  })

  it('正常：面包屑「本项目 /」次文字色，用量条带「约」，带入的记忆按类型分组带数，底部写本项目条数', () => {
    const { container, openPage } = setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending() })
    const crumb = container.querySelector('.pm-side-crumb')!
    expect(crumb).toHaveTextContent('本项目 / app')
    expect(crumb.querySelector('.pm-side-crumb-scope')).toHaveTextContent('本项目 /')
    expect(screen.getByText('3 条 · 约 2,920 / 4,000')).toBeInTheDocument()
    expect(screen.getByText('全部带入')).toBeInTheDocument()
    const groups = within(screen.getByRole('region', { name: '带入的记忆' }))
    expect(groups.getByRole('heading', { name: '行为偏好 1 全文' })).toBeInTheDocument()
    expect(groups.getByRole('heading', { name: '项目信息 1 只带摘要' })).toBeInTheDocument()
    expect(groups.getByRole('heading', { name: '用户画像 1 全文' })).toBeInTheDocument()
    expect(screen.queryByText('本项目还没有记忆，这次带入的都是全局记忆。')).toBeNull()
    expect(screen.queryByText(/处待处理/)).toBeNull()
    expect(screen.getByText(/本项目 2 条记忆/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '在记忆页查看 ›' }))
    expect(openPage).toHaveBeenCalledWith({ view: 'library', scope: { kind: 'workspace', workspacePath: WS }, fromChat: true })
  })

  it('frozenAt 早于插件本次加载（健康视图 bootedAt）：写「重启前带入的记忆」（快照一直在对话里），不画过时的用量条', () => {
    const { container } = setup({ library: library(pref, proj, glob), session: snapshot({ frozenAt: BOOTED - 1 }), pending: pending() })
    expect(screen.getByText('重启前带入的记忆')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek Harness 重启过，对话里仍是重启前带入的这份记忆。继续对话后这里会更新；记忆有变化时会补发最新的一份。')).toBeInTheDocument()
    expect(container.querySelector('.pm-budget')).toBeNull()
  })

  it('健康视图没带 bootedAt：判断不了是否重启过，照常画用量条', () => {
    const { container } = setup({ library: library(pref, proj, glob), session: snapshot({ frozenAt: BOOTED - 1 }), pending: pending(), health: health(null) })
    expect(screen.queryByText('重启前带入的记忆')).toBeNull()
    expect(container.querySelector('.pm-budget')).not.toBeNull()
  })

  it('自定义类型的分组标题写注册表显示名（待处理视图的 typeLabels）', () => {
    const note = memory({ id: 'n1', type: 'domain-term', content: '「灰度」指先放给一小部分用户。' })
    setup({ library: library(note), session: snapshot({ injectedIds: ['n1'] }), pending: { ...pending(), typeLabels: { 'domain-term': '术语' } } })
    expect(within(screen.getByRole('region', { name: '带入的记忆' })).getByRole('heading', { name: '术语 1 只带摘要' })).toBeInTheDocument()
  })

  it('会话视图还没有（这次对话没组装过快照）：说明发出第一条消息后才有', () => {
    setup({ library: library(pref), pending: pending() })
    expect(screen.getByText('这次对话还没带入记忆')).toBeInTheDocument()
  })
})

describe('SidebarTab 用量条', () => {
  it('少量记忆：分子是计入上限的用量（不是三段之和 777），图例是色块 + 名称 + 数字，固定说明标「不计上限」', () => {
    const { container } = setup({
      library: library(pref, proj, glob),
      session: snapshot({ tokens: { workspace: 88, global: 93, fixed: 596 }, usedTokens: 211 }),
      pending: pending(),
    })
    const usage = within(screen.getByRole('region', { name: '对话开始时带入的记忆' }))
    expect(usage.getByText('3 条 · 约 211 / 4,000')).toBeInTheDocument()
    expect(container.querySelector('.pm-side-usage')).not.toHaveTextContent('777')
    expect(usage.getByRole('img')).toHaveAttribute('aria-label', '已用上限的 5%：本项目 88，全局 93，标题 30；固定说明 566，不计上限')
    expect([...container.querySelectorAll('.pm-side-usage .pm-budget-key')].map(k => k.textContent))
      .toEqual(['本项目 88', '全局 93', '标题 30', '固定说明 566（不计上限）'])
    expect(container.querySelector('.pm-side-usage .pm-budget-swatch.pm-budget-tint--uncounted')).not.toBeNull()
    expect(container.querySelector('.pm-side-usage .pm-budget-seg--fixed > .pm-budget-tint--uncounted')).not.toBeNull()
    expect(usage.getByText('全部带入')).toBeInTheDocument()
  })

  it('严格模式：「已到上限，N 条没带入 · 处理 ›」，处理跳记忆页待处理', () => {
    const { openPage } = setup({
      library: library(pref, proj, glob),
      session: snapshot({ overflowMode: 'strict', omittedCount: 2, usedTokens: 4000, tokens: { workspace: 2800, global: 1200, fixed: 200 } }),
      pending: pending(),
    })
    expect(screen.getByText('3 条 · 约 4,000 / 4,000')).toBeInTheDocument()
    expect(screen.getByText(/已到上限，2 条没带入/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '处理 ›' }))
    expect(openPage).toHaveBeenCalledWith({ view: 'todo', scope: { kind: 'workspace', workspacePath: WS }, fromChat: true })
  })

  it('自动放宽：计入上限的用量超过上限时写「已放宽到 N」', () => {
    setup({
      library: library(pref, proj, glob),
      session: snapshot({ usedTokens: 4600, tokens: { workspace: 3000, global: 1600, fixed: 200 } }),
      pending: pending(),
    })
    expect(screen.getByText('3 条 · 约 4,600 / 4,000')).toBeInTheDocument()
    expect(screen.getByText('已放宽到 5,000')).toBeInTheDocument()
  })
})

describe('SidebarTab 快照来历与分组', () => {
  it('对话开始时冻结的：标题写「对话开始时带入的记忆」，条下说明搜索到的不计入', () => {
    setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending() })
    const usage = within(screen.getByRole('region', { name: '对话开始时带入的记忆' }))
    expect(usage.getByRole('heading', { name: '对话开始时带入的记忆' })).toBeInTheDocument()
    expect(usage.getByText('对话中搜索到的记忆算普通上下文，不计入这里。')).toBeInTheDocument()
    expect(screen.queryByText('压缩后重新带入的记忆')).toBeNull()
  })

  it('成功压缩后重建的：标题写「压缩后重新带入的记忆」，说明行照旧', () => {
    setup({ library: library(pref, proj, glob), session: snapshot({ origin: 'compacted', compactedAt: BOOTED + 1 }), pending: pending() })
    const usage = within(screen.getByRole('region', { name: '压缩后重新带入的记忆' }))
    expect(usage.getByText('对话中搜索到的记忆算普通上下文，不计入这里。')).toBeInTheDocument()
    expect(screen.queryByText('对话开始时带入的记忆')).toBeNull()
  })

  it('空组不显示：快照没带入任何记忆时没有「带入的记忆」，没有新写入时没有「这次新写入的」', () => {
    setup({ library: library(pref), session: snapshot({ injectedIds: [], coreIds: [], titleOnlyIds: [], usedTokens: 0, tokens: { workspace: 0, global: 0, fixed: 40 } }), pending: pending() })
    expect(screen.getByRole('region', { name: '对话开始时带入的记忆' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '带入的记忆' })).toBeNull()
    expect(screen.queryByRole('region', { name: '这次新写入的' })).toBeNull()
  })

  it('续上已有轮次的会话（重启后、插件重载后）首次冻结的：标题写「重新带入的记忆」', () => {
    setup({ library: library(pref, proj, glob), session: snapshot({ origin: 'resumed' }), pending: pending() })
    const usage = within(screen.getByRole('region', { name: '重新带入的记忆' }))
    expect(usage.getByText('对话中搜索到的记忆算普通上下文，不计入这里。')).toBeInTheDocument()
    expect(screen.queryByText('对话开始时带入的记忆')).toBeNull()
  })

  it('对话中补发了新快照（配置热更新、记忆变了）：标题写「对话中重新带入的记忆」', () => {
    setup({ library: library(pref, proj, glob), session: snapshot({ origin: 'refreshed' }), pending: pending() })
    expect(screen.getByRole('region', { name: '对话中重新带入的记忆' })).toBeInTheDocument()
    expect(screen.queryByText('对话开始时带入的记忆')).toBeNull()
  })

  it('带入的记忆按组标出全文（core 区）与只带摘要（索引行）', () => {
    const { container } = setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending() })
    const marks = [...container.querySelectorAll('.pm-side-group-title')].map(h => h.textContent)
    expect(marks).toEqual(['行为偏好 1 ·全文', '项目信息 1 ·只带摘要', '用户画像 1 ·全文'])
  })

  it('索引行不带摘要的类型（如参考引用）标「只带标题」', () => {
    const ref = memory({ id: 'r1', type: 'reference', content: '看板在 Linear 的 INGEST 项目。' })
    const { container } = setup({ library: library(pref, ref), session: snapshot({ injectedIds: ['p1', 'r1'], titleOnlyIds: ['r1'] }), pending: pending() })
    expect([...container.querySelectorAll('.pm-side-group-title')].map(h => h.textContent)).toEqual(['行为偏好 1 ·全文', '参考引用 1 ·只带标题'])
  })

  it('一组里带入方式不一致（全文与索引行混着）时不标', () => {
    const { container } = setup({ library: library(pref, pref2), session: snapshot({ injectedIds: ['p1', 'p2'], coreIds: ['p1'] }), pending: pending() })
    expect([...container.querySelectorAll('.pm-side-group-title')].map(h => h.textContent)).toEqual(['行为偏好 2'])
  })

  it('这次新写入的注明压缩后或下个对话带入；新快照里已经有的移进带入的记忆，不重复列', () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const later = memory({ id: 'n2', type: 'knowledge', content: '周五不发版。' })
    const { gateway } = setup({ library: library(pref, proj, glob, fresh, later), session: snapshot({ savedIds: ['n1', 'n2'] }), pending: pending() })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(saved.getByText('压缩后或下个对话带入')).toBeInTheDocument()
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()
    expect(saved.getByText('周五不发版。')).toBeInTheDocument()

    act(() => { gateway.setView('session', snapshot({ origin: 'compacted', injectedIds: ['p1', 'j1', 'g1', 'n1'], savedIds: ['n1', 'n2'] })) })
    const savedAfter = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(savedAfter.queryByText('报销截止每月 25 日。')).toBeNull()
    expect(savedAfter.getByText('周五不发版。')).toBeInTheDocument()
    const injected = within(screen.getByRole('region', { name: '带入的记忆' }))
    expect(injected.getByRole('heading', { name: '事实与经验 1 只带摘要' })).toBeInTheDocument()
    fireEvent.click(injected.getByRole('button', { name: '事实与经验 1 只带摘要' }))
    expect(screen.getAllByText('报销截止每月 25 日。')).toHaveLength(1)

    act(() => { gateway.setView('session', snapshot({ origin: 'compacted', injectedIds: ['p1', 'j1', 'g1', 'n1', 'n2'], savedIds: ['n1', 'n2'] })) })
    expect(screen.queryByRole('region', { name: '这次新写入的' })).toBeNull()
    expect(screen.getByText('周五不发版。')).toBeInTheDocument()
  })
})

describe('SidebarTab 这次新写入的', () => {
  it('对话里新写入的一行带入场动效和银藤高亮；打开右侧栏时已有的不带', () => {
    const earlier = memory({ id: 'n0', type: 'knowledge', content: '周五不发版。' })
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { gateway } = setup({ library: library(pref, proj, glob, earlier), session: snapshot({ savedIds: ['n0'] }), pending: pending() })
    expect(screen.getByText('周五不发版。').closest('.pm-arrive')).toBeNull()
    act(() => {
      gateway.setView('library', library(pref, proj, glob, earlier, fresh))
      gateway.setView('session', snapshot({ savedIds: ['n0', 'n1'] }))
    })
    expect(screen.getByText('报销截止每月 25 日。').closest('.pm-arrive')).toHaveClass('pm-arrive--highlight')
    expect(screen.getByText('周五不发版。').closest('.pm-arrive')).toBeNull()
  })

  it('memory_save 后会话视图版本变化，新记的实时增加；行尾删除发 forget', async () => {
    const { gateway } = setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending() })
    expect(screen.queryByText('这次新写入的')).toBeNull()
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    act(() => {
      gateway.setView('library', library(pref, proj, glob, fresh))
      gateway.setView('session', snapshot({ savedIds: ['n1'] }))
    })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } }])
    expect(screen.queryByText('报销截止每月 25 日。')).toBeNull()
  })

  it('删除后原位留「已删除」和「撤销」（幽灵按钮，同对话卡的文案）；视图刷新后这一行还在；撤销发 restore，视图刷新回来前照原样画那条', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const other = memory({ id: 'n2', type: 'knowledge', content: '周报周五发。' })
    const { gateway } = setup({ library: library(pref, proj, glob, fresh, other), session: snapshot({ savedIds: ['n1', 'n2'] }), pending: pending() })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    await remove(saved.getAllByRole('button', { name: '删除这条记忆' })[0]!)
    expect(saved.queryByText('报销截止每月 25 日。')).toBeNull()
    expect(saved.getByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
    const undo = saved.getByRole('button', { name: '撤销' })
    expect(undo).toHaveClass('pm-btn--ghost')
    // 删掉的那条离开全部记忆视图：这一行还在原位，后面那条照旧
    act(() => { gateway.setView('library', library(pref, proj, glob, other)) })
    expect(saved.getByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
    expect(saved.getByText('周报周五发。')).toBeInTheDocument()

    await act(async () => { fireEvent.click(saved.getByRole('button', { name: '撤销' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } },
      { cmd: 'restore', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } },
    ])
    expect(saved.queryByText('已删除。14 天内也能在最近删除里找回。')).toBeNull()
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()
    act(() => { gateway.setView('library', library(pref, proj, glob, fresh, other)) })
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()
    expect(saved.getAllByRole('button', { name: '删除这条记忆' })).toHaveLength(2)
  })

  it('撤销删除失败不写原因（同对话卡）：还是「已删除」和「撤销」', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    setup(
      { library: library(pref, proj, glob, fresh), session: snapshot({ savedIds: ['n1'] }), pending: pending() },
      command => command.cmd === 'restore' ? { ok: false, cmd: command.cmd, code: 'failed', detail: '磁盘满了' } : { ok: true, cmd: command.cmd, memoryIds: ['n1'] },
    )
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    await act(async () => { fireEvent.click(saved.getByRole('button', { name: '撤销' })) })
    expect(screen.queryByText(/磁盘满了/)).toBeNull()
    expect(saved.getByText('已删除。14 天内也能在最近删除里找回。')).toBeInTheDocument()
    expect(saved.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('别处删掉的新写入（全部记忆、对话卡）：这里照旧直接去掉，不留撤销行', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { gateway } = setup({ library: library(pref, proj, glob, fresh), session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    await act(async () => { await gateway.execute('s1', { cmd: 'forget', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } }) })
    expect(screen.queryByRole('region', { name: '这次新写入的' })).toBeNull()
    expect(screen.queryByText('已删除。14 天内也能在最近删除里找回。')).toBeNull()
  })

  it('普通记忆在这里软删、之后在最近删除里彻底删掉：不写含密钥那句「已彻底删除」', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { gateway } = setup({ library: library(pref, proj, glob, fresh), session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    await remove(within(screen.getByRole('region', { name: '这次新写入的' })).getByRole('button', { name: '删除这条记忆' }))
    expect(screen.queryByText('报销截止每月 25 日。')).toBeNull()
    await act(async () => { await gateway.execute('s1', { cmd: 'hard-delete', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } }) })
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['forget', 'hard-delete'])
    expect(screen.queryByText(/已彻底删除/)).toBeNull()
  })

  it('确认开着时这条从列表里没了（别处删了）：再回来时是垃圾桶，不带着没收起的确认', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { gateway } = setup({ library: library(pref, proj, glob, fresh), session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    await act(async () => { fireEvent.click(within(screen.getByRole('region', { name: '这次新写入的' })).getByRole('button', { name: '删除这条记忆' })) })
    expect(screen.getByRole('group', { name: '删除这条？' })).toBeInTheDocument()
    act(() => { gateway.setView('library', library(pref, proj, glob)) })
    expect(screen.queryByRole('region', { name: '这次新写入的' })).toBeNull()
    act(() => { gateway.setView('library', library(pref, proj, glob, fresh)) })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(saved.queryByRole('group', { name: '删除这条？' })).toBeNull()
    expect(saved.getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
  })

  it('点垃圾桶不直接删：原位换成「删除这条？ 删除 · 取消」，焦点在「取消」；「取消」、Esc、焦点移走都收起，什么都不发', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { gateway } = setup({ library: library(pref, proj, glob, fresh), session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    const open = async () => {
      const trash = saved.getByRole('button', { name: '删除这条记忆' })
      trash.focus()
      await act(async () => { fireEvent.click(trash) })
      return within(saved.getByRole('group', { name: '删除这条？' }))
    }
    const confirm = await open()
    expect(confirm.getAllByRole('button').map(b => b.textContent)).toEqual(['删除', '取消'])
    expect(confirm.getByRole('button', { name: '取消' })).toHaveFocus()
    expect(saved.queryByRole('button', { name: '删除这条记忆' })).toBeNull()
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()

    fireEvent.click(confirm.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(saved.getByRole('button', { name: '删除这条记忆' })).toHaveFocus() })
    fireEvent.keyDown((await open()).getByRole('button', { name: '取消' }), { key: 'Escape' })
    expect(saved.queryByRole('group', { name: '删除这条？' })).toBeNull()
    await open()
    act(() => { screen.getByRole('button', { name: '在记忆页查看 ›' }).focus() })
    expect(saved.queryByRole('group', { name: '删除这条？' })).toBeNull()
    expect(saved.getByRole('button', { name: '删除这条记忆' })).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
  })

  it('含密钥的记忆：forget 回 has-secret 时原位确认；取消收起；「彻底删除」发 hard-delete，原位留不可恢复的说明', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { gateway } = setup(
      { library: library(pref, proj, glob, fresh), session: snapshot({ savedIds: ['n1'] }), pending: pending() },
      command => command.cmd === 'forget' ? { ok: false, cmd: command.cmd, code: 'has-secret' } : { ok: true, cmd: command.cmd, memoryIds: ['n1'] },
    )
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    expect(saved.getByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(saved.getByRole('button', { name: '删除这条记忆' })).toHaveAttribute('aria-disabled', 'true')
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()

    fireEvent.click(saved.getByRole('button', { name: '取消' }))
    expect(saved.queryByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeNull()
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    await act(async () => { fireEvent.click(saved.getByRole('button', { name: '彻底删除' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'forget', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } },
      { cmd: 'forget', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } },
      { cmd: 'hard-delete', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } },
    ])
    expect(saved.queryByText('报销截止每月 25 日。')).toBeNull()
    expect(saved.getByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(screen.queryByText(/14 天/)).toBeNull()
  })
})

describe('SidebarTab 这次新写入的：模型改写、替代', () => {
  const rewritten = memory({ id: 'p1', type: 'preference', content: '测试用 SQLite。' })
  const newer = memory({ id: 'n1', type: 'preference', name: '测试数据库', content: '测试统一用 SQLite。' })
  const rewrite: ModelChange = {
    decisionId: 'pd_r', kind: 'rewrite', memoryId: 'p1', before: pref, sessionId: 's1', callId: 'c1', at: BOOTED + 5, state: 'undoable',
  }
  const supersede: ModelChange = {
    decisionId: 'pd_s', kind: 'supersede', memoryId: 'p2', by: 'n1', before: { ...pref2, name: '旧的测试约定' }, sessionId: 's1', callId: 'c2', at: BOOTED + 6, state: 'undoable',
  }
  const withChanges = (changes: ModelChange[], ...items: MemoryCard[]): LibraryView => ({ ...library(rewritten, proj, glob, ...items), modelChanges: changes })

  it('早于这份快照、别的会话的改动不认领（没有新记时这一组只因本会话的改动出现）', () => {
    const early = { ...rewrite, decisionId: 'pd_e', at: BOOTED }
    const other = { ...rewrite, decisionId: 'pd_o', sessionId: 's2' }
    setup({ library: withChanges([early, other]), session: snapshot(), pending: pending() })
    expect(screen.queryByRole('region', { name: '这次新写入的' })).toBeNull()
  })

  it('改写：显示改后的那条、带「已改写」，「改前 / 改后 ›」展开对照；「撤销修改」按这次改动发 undo，不用原位确认', async () => {
    const { gateway } = setup({ library: withChanges([rewrite]), session: snapshot(), pending: pending() })
    const group = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(group.getByText('已改写').closest('.pm-change-head')).not.toBeNull()
    expect(group.getAllByText('测试用 SQLite。')[0]).toBeVisible()
    expect(group.getByText('测试用真实 Postgres。')).not.toBeVisible()
    fireEvent.click(group.getByRole('button', { name: '改前 / 改后 ›' }))
    expect(group.getByText('测试用真实 Postgres。')).toBeVisible()
    await act(async () => { fireEvent.click(group.getByRole('button', { name: '撤销修改' })) })
    expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'undo', decisionId: 'pd_r' } }])
    expect(group.getByText('已撤销')).toBeInTheDocument()
  })

  it('同一条改写了几次只列最近那次；这次对话里新记的那条又被改写，不另列（新写入那行已经是它）', () => {
    const first = { ...rewrite, decisionId: 'pd_r1', at: BOOTED + 5, state: 'changed' as const }
    const latest = { ...rewrite, decisionId: 'pd_r2', callId: 'c3', at: BOOTED + 9 }
    const ofNew = { ...rewrite, decisionId: 'pd_n', memoryId: 'n1', before: newer, at: BOOTED + 7 }
    setup({ library: withChanges([latest, first, ofNew], newer), session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    const group = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(group.getAllByText('已改写')).toHaveLength(1)
    expect(group.getAllByRole('button', { name: '撤销修改' })).toHaveLength(1)
    expect(group.queryByText('之后又改过，没法直接撤销')).toBeNull()
  })

  it('替代：写「「新」替代了「旧」」，撤销按这次替代发 undo；之后又改过的只写说明', async () => {
    const { gateway } = setup({ library: withChanges([supersede, { ...rewrite, state: 'changed' }], newer), session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    const group = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(group.getByText('「测试数据库」替代了「旧的测试约定」')).toBeInTheDocument()
    expect(group.getByText('之后又改过，没法直接撤销')).toBeInTheDocument()
    expect(group.getAllByRole('button', { name: '撤销修改' })).toHaveLength(1)
    await act(async () => { fireEvent.click(group.getByRole('button', { name: '撤销修改' })) })
    expect(gateway.executed).toEqual([{ sessionId: 's1', command: { cmd: 'undo', decisionId: 'pd_s' } }])
  })
})

describe('SidebarTab 英文单复数', () => {
  it('本项目只有 1 条、只带入 1 条时用单数，多条用复数', () => {
    const gateway = createFakeGateway({ views: { health: health(), library: library(pref, glob), session: snapshot({ injectedIds: ['p1'] }), pending: pending() } })
    const { unmount } = render(<PanelShell gateway={gateway} t={createTranslator(en)}><SidebarTab sessionId="s1" workspacePath={WS} openPage={vi.fn()} /></PanelShell>)
    expect(screen.getByText(/^1 memory in this project/)).toBeInTheDocument()
    expect(screen.getByText(/^1 memory · ~/)).toBeInTheDocument()
    unmount()
    const many = createFakeGateway({ views: { health: health(), library: library(pref, proj, glob), session: snapshot(), pending: pending() } })
    render(<PanelShell gateway={many} t={createTranslator(en)}><SidebarTab sessionId="s1" workspacePath={WS} openPage={vi.fn()} /></PanelShell>)
    expect(screen.getByText(/^2 memories in this project/)).toBeInTheDocument()
    expect(screen.getByText(/^3 memories · ~/)).toBeInTheDocument()
  })

  it('中文：1 条也照旧', () => {
    setup({ library: library(pref, glob), session: snapshot({ injectedIds: ['p1'] }), pending: pending() })
    expect(screen.getByText(/^本项目 1 条记忆/)).toBeInTheDocument()
    expect(screen.getByText(/^1 条 · 约/)).toBeInTheDocument()
  })
})

describe('SidebarTab 这次新写入的：提升候选就地处理', () => {
  const cand = memory({ id: 'n1', type: 'knowledge', content: '所有项目都用 vitest。', promotion: 'candidate' })
  const plain = memory({ id: 'n2', type: 'knowledge', content: '提交信息写英文。' })
  const layer = { kind: 'workspace', workspacePath: WS }
  const views = (...items: MemoryCard[]) => ({ library: library(pref, proj, glob, ...items), session: snapshot({ savedIds: items.map(m => m.id) }), pending: pending() })
  const row = (id: string) => within(document.querySelector<HTMLElement>(`.pm-side-saved[data-memory-id="${id}"]`)!)

  it('候选那条下方是建议区（来由和后果）和「留在本项目」「提升为全局」，元信息行不挂状态；不是候选的没有', () => {
    setup(views(cand, plain))
    expect(row('n1').getByText(/^这条看起来适合所有项目。/).closest('.pm-advice')).not.toBeNull()
    expect(row('n1').queryByText('可提升为全局')).toBeNull()
    expect(row('n1').getByRole('button', { name: '留在本项目' })).toBeInTheDocument()
    expect(row('n1').getByRole('button', { name: '提升为全局' })).toBeInTheDocument()
    expect(row('n2').queryByText(/这条看起来适合所有项目/)).toBeNull()
    expect(row('n2').queryByRole('button', { name: '提升为全局' })).toBeNull()
  })

  it('「提升为全局」发 promote-memory、「留在本项目」发 keep-local-memory（带层），成功后换成结果文字、不再有按钮', async () => {
    const other = memory({ id: 'n3', type: 'knowledge', content: '文档用中文。', promotion: 'candidate' })
    const { gateway } = setup(views(cand, other))
    await act(async () => { fireEvent.click(row('n1').getByRole('button', { name: '提升为全局' })) })
    await act(async () => { fireEvent.click(row('n3').getByRole('button', { name: '留在本项目' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'promote-memory', memoryId: 'n1', layer, isCandidateRequired: true },
      { cmd: 'keep-local-memory', memoryId: 'n3', layer },
    ])
    expect(row('n1').getByText('已提升为全局')).toBeInTheDocument()
    expect(row('n3').getByText('留在本项目').closest('.pm-result-line')).toHaveTextContent('留在本项目以后不再提示这条。')
    for (const id of ['n1', 'n3']) expect(row(id).queryByRole('button', { name: '提升为全局' })).toBeNull()
  })

  it.each([
    ['提升为全局', '已提升为全局'],
    ['留在本项目', '留在本项目'],
  ])('「%s」之后结果文字旁有「撤销」：按这次的 decisionId 发 undo，撤销后回到候选、两个按钮都在', async (button, result) => {
    const { gateway } = setup(views(cand, plain), command => command.cmd === 'undo'
      ? { ok: true, cmd: command.cmd, decisionId: command.decisionId, memoryIds: ['n1'] }
      : { ok: true, cmd: command.cmd, decisionId: 'pd_9', memoryIds: ['n1'] })
    await act(async () => { fireEvent.click(row('n1').getByRole('button', { name: button })) })
    expect(row('n1').getByText(result).closest('.pm-result-line')).not.toBeNull()
    await act(async () => { fireEvent.click(row('n1').getByRole('button', { name: '撤销' })) })
    expect(gateway.executed.map(e => e.command).at(-1)).toEqual({ cmd: 'undo', decisionId: 'pd_9' })
    expect(row('n1').getByText(/^这条看起来适合所有项目。/)).toBeInTheDocument()
    expect(row('n1').getByRole('button', { name: '留在本项目' })).toBeInTheDocument()
    expect(row('n1').getByRole('button', { name: '提升为全局' })).toBeInTheDocument()
    expect(row('n1').queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('新写入的候选就地提升再撤销：只发提升与撤销两条命令，底部不出现「还有 N 处待处理」', async () => {
    const { gateway } = setup(views(cand, plain), command => command.cmd === 'undo'
      ? { ok: true, cmd: command.cmd, decisionId: command.decisionId, memoryIds: ['n1'] }
      : { ok: true, cmd: command.cmd, decisionId: 'pd_9', memoryIds: ['n1'] })
    await act(async () => { fireEvent.click(row('n1').getByRole('button', { name: '提升为全局' })) })
    act(() => { gateway.setView('library', library(pref, proj, glob, { ...cand, scope: 'global', workspacePath: undefined, promotion: undefined }, plain)) })
    await act(async () => { fireEvent.click(row('n1').getByRole('button', { name: '撤销' })) })
    // 服务端撤销后：记忆回到候选，账本里那条移除（待处理视图照旧为空）
    act(() => { gateway.setView('library', library(pref, proj, glob, cand, plain)) })
    act(() => { gateway.setView('pending', pending()) })
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['promote-memory', 'undo'])
    expect(row('n1').getByRole('button', { name: '提升为全局' })).toBeInTheDocument()
    expect(screen.queryByText(/处待处理/)).toBeNull()
    expect(screen.getByText(/本项目 \d+ 条记忆/)).toBeInTheDocument()
  })

  it('去处配置成写进 AGENTS.md：按钮与命令跟着配置；成功后换成「已写进 AGENTS.md」，记忆离开视图后这一行仍留着结果、不给撤销', async () => {
    const { gateway } = setup(views(cand, plain), undefined, configWith('agents-md'))
    expect(row('n1').queryByRole('button', { name: '提升为全局' })).toBeNull()
    await act(async () => { fireEvent.click(row('n1').getByRole('button', { name: '写进 AGENTS.md' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'promote-memory', memoryId: 'n1', layer, isCandidateRequired: true, target: 'agents-md' }])
    act(() => { gateway.setView('library', library(pref, proj, glob, plain)) })
    expect(row('n1').getByText('已写进 AGENTS.md')).toBeInTheDocument()
    expect(row('n1').queryByRole('button', { name: '撤销' })).toBeNull()
    expect(row('n1').queryByRole('button', { name: '留在本项目' })).toBeNull()
  })

  it('配置还没读到：提升按钮暂不可用', () => {
    const { gateway } = setup(views(cand, plain))
    act(() => { gateway.setConfigValue(undefined) })
    expect(row('n1').getByRole('button', { name: '提升为全局' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('别处（对话卡片、待处理）处理过的按视图换成结果文字：提升了的在全局层，留下的标 kept-local', () => {
    const promoted = { ...cand, scope: 'global' as const, workspacePath: undefined, promotion: undefined }
    const kept = memory({ id: 'n3', type: 'knowledge', content: '文档用中文。', promotion: 'kept-local' })
    setup(views(promoted, kept))
    expect(row('n1').getByText('已提升为全局')).toBeInTheDocument()
    expect(row('n3').getByText('留在本项目')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '提升为全局' })).toBeNull()
    expect(screen.queryByRole('button', { name: '留在本项目' })).toBeNull()
  })

  it('别处正在处理或刚处理完：原位写「没有生效」', async () => {
    setup(views(cand), command => ({ ok: false, cmd: command.cmd, code: 'not-found' }))
    for (const name of ['提升为全局', '留在本项目']) {
      await act(async () => { fireEvent.click(row('n1').getByRole('button', { name })) })
      expect(row('n1').getByRole('alert')).toHaveTextContent(`你对「${cand.name}」的选择没有生效：它正在别处处理，或者刚在别处处理完。`)
    }
  })
})

describe('SidebarTab 同 id 的多份副本', () => {
  const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。', updatedAt: 100 })
  const withScopes = (...extra: LibraryView['layers']) => {
    const base = library(pref, proj, glob, fresh)
    return { ...base, layers: [...base.layers, ...extra] }
  }

  it('别的项目里有同 id 的更新副本：只看会话看得见的层，显示并删除本项目那份', async () => {
    const elsewhere = memory({ id: 'n1', type: 'knowledge', content: '别的项目的同 id 副本', workspacePath: '/w/blog', updatedAt: 999 })
    const { gateway } = setup({
      library: withScopes({ layer: { kind: 'workspace', workspacePath: '/w/blog' }, items: [elsewhere] }),
      session: snapshot({ savedIds: ['n1'] }), pending: pending(),
    })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(saved.getByText('报销截止每月 25 日。')).toBeInTheDocument()
    expect(screen.queryByText('别的项目的同 id 副本')).toBeNull()
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'n1', layer: { kind: 'workspace', workspacePath: WS } }])
  })

  it('全局和本项目各有一份：取服务端会取的那份，updatedAt 新者优先，相同时本项目优先', async () => {
    const newerGlobal = memory({ id: 'n1', type: 'knowledge', scope: 'global', workspacePath: undefined, content: '全局更新的那份', updatedAt: 200 })
    const view = library(pref, proj, glob, fresh)
    const layers = view.layers.map(l => (l.layer.kind === 'global' ? { ...l, items: [...l.items, newerGlobal] } : l))
    const first = setup({ library: { ...view, layers }, session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    expect(saved.getByText('全局更新的那份')).toBeInTheDocument()
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    expect(first.gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'n1', layer: { kind: 'global' } }])
    first.unmount()

    const sameAge = { ...newerGlobal, content: '全局同龄的那份', updatedAt: 100 }
    const tied = view.layers.map(l => (l.layer.kind === 'global' ? { ...l, items: [...l.items, sameAge] } : l))
    setup({ library: { ...view, layers: tied }, session: snapshot({ savedIds: ['n1'] }), pending: pending() })
    expect(within(screen.getByRole('region', { name: '这次新写入的' })).getByText('报销截止每月 25 日。')).toBeInTheDocument()
  })
})

describe('SidebarTab 就地裁决', () => {
  it('冲突卡在「等你决定」段里；采纳后结果留原位，撤销后冲突回来、建议还在', async () => {
    const { gateway } = setup({
      library: library(pref, pref2, proj, glob),
      session: snapshot({ injectedIds: ['p1', 'j1', 'p2', 'g1'] }),
      pending: pending(adoptable),
    })
    const group = within(screen.getByRole('region', { name: '等你决定' }))
    expect(group.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '带入的记忆' })).getByRole('heading', { name: '行为偏好 2 全文' })).toBeInTheDocument()

    await act(async () => { fireEvent.click(group.getByRole('button', { name: '采纳建议' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'apply-proposal', decisionId: 'pd_1', suggestionId: 'sg_1' }])
    // 视图刷新：冲突出了待处理，B 被删
    act(() => {
      gateway.setView('pending', pending())
      gateway.setView('library', library(pref, proj, glob))
    })
    expect(screen.queryByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeNull()
    expect(screen.getByText('已保留 A')).toBeInTheDocument()
    expect(screen.getByText(/按模型建议处理。B 已删除，14 天内可恢复。/)).toBeInTheDocument()
    // 删掉一条只影响之后的组装：这次对话冻结的快照里还是两条
    expect(screen.getByText('这次对话里已带入的不变，压缩后或下个对话起生效。')).toBeInTheDocument()
    // 「撤销」和别处一样是标准尺寸的幽灵按钮
    expect(screen.getByRole('button', { name: '撤销' })).toHaveClass('pm-btn--ghost')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(gateway.executed.map(e => e.command)[1]).toEqual({ cmd: 'undo', decisionId: 'pd_1' })
    expect(screen.queryByText('已保留 A')).toBeNull()
    act(() => {
      gateway.setView('pending', pending(adoptable))
      gateway.setView('library', library(pref, pref2, proj, glob))
    })
    expect(screen.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
    expect(group.getByText('保留 A')).toBeInTheDocument()
    expect(group.getByRole('button', { name: '采纳建议' })).toBeInTheDocument()
  })

  it('PA-46 失败的提示各处一致：英文同一句，正文色（不另起红字）', async () => {
    const gateway = createFakeGateway({
      views: { health: health(), library: library(pref, pref2), session: snapshot({ injectedIds: ['p1'] }), pending: pending(adoptable) },
      respond: () => ({ ok: false, code: 'failed', detail: 'cannot locate the losing memory' }),
      config: configWith('plugin-global'),
    })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><SidebarTab sessionId="s1" workspacePath={WS} openPage={vi.fn()} /></PanelShell>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Adopt suggestion' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('Did not work: cannot locate the losing memory')
    expect(screen.getByRole('alert')).toHaveClass('pm-pending-error')
    expect(sidebarTabCss).not.toContain('pm-side-error')
  })

  it('侧栏窄：建议那一行和按钮行放不下时换行，不强制一行、不溢出', () => {
    expect(sidebarTabCss).not.toMatch(/\.pm-conflict-actions \{[^}]*nowrap/)
    expect(sidebarTabCss).toMatch(/\.pm-side-suggestion \{[^}]*overflow-wrap: anywhere/)
    expect(conflictRulingCss).toMatch(/\.pm-conflict-actions \{[^}]*flex-wrap: wrap/)
  })

  it('PA-45 撤销回 stale：写本地文案，不显示服务端的中文原话', async () => {
    const gateway = createFakeGateway({
      views: { health: health(), library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(suggested('keep-both')) },
      respond: command => command.cmd === 'undo'
        ? { ok: false, cmd: command.cmd, code: 'stale', detail: '记忆之后又被改过，未做任何改动' }
        : { ok: true, cmd: command.cmd, decisionId: 'pd_1' },
      config: configWith('plugin-global'),
    })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><SidebarTab sessionId="s1" workspacePath={WS} openPage={vi.fn()} /></PanelShell>)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Adopt suggestion' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Undo' })) })
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['apply-proposal', 'undo'])
    expect(screen.getByRole('alert')).toHaveTextContent('Did not work: This memory changed afterwards, so undoing would overwrite those changes. Nothing was undone.')
    expect(screen.queryByText(/未做任何改动/)).toBeNull()
  })

  it('采纳失败：原位写宿主原话，冲突卡还在', async () => {
    setup(
      { library: library(pref, pref2), session: snapshot({ injectedIds: ['p1'] }), pending: pending(adoptable) },
      () => ({ ok: false, code: 'failed', detail: '定位不到败方记忆' }),
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(screen.getByRole('alert')).toHaveTextContent('没有成功：定位不到败方记忆')
    expect(screen.getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
  })
})

describe('SidebarTab 冲突行的处理建议', () => {
  const yourCall = () => within(screen.getByRole('region', { name: '等你决定' }))
  const todo = { view: 'todo', scope: { kind: 'workspace', workspacePath: WS }, fromChat: true, level: 'your-call' }

  it.each([
    ['keep-a', '保留 A', '采纳后 B 进最近删除，14 天内可恢复。', '已保留 A', /按模型建议处理。B 已删除，14 天内可恢复。/],
    ['keep-b', '保留 B', '采纳后 A 进最近删除，14 天内可恢复。', '已保留 B', /按模型建议处理。A 已删除，14 天内可恢复。/],
    ['keep-both', '都保留（不算冲突）', '采纳后两条都留着，以后体检不再把它们当冲突。', '两条都保留', /按模型建议处理。以后体检不再把它们当冲突。/],
  ] as const)('建议 %s：A、B 下面一行「模型建议：%s」，不显示理由；说明采纳后哪条去哪；「采纳建议」只带条目 id 和建议 id，结果写来由', async (action, conclusion, note, chip, body) => {
    const { gateway, container } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending(suggested(action)) })
    const line = container.querySelector('.pm-side-suggestion')!
    expect(line).toHaveTextContent(`模型建议：${conclusion}`)
    expect(line.querySelector('strong')).toHaveTextContent(conclusion)
    // 在 A、B 两张卡之后
    expect(line.closest('.pm-conflict-footer')?.previousElementSibling).toHaveClass('pm-conflict-sides')
    expect(screen.queryByText(REASON)).toBeNull()
    expect(yourCall().getByText(note)).toBeInTheDocument()
    expect(container.querySelector('.pm-suggestion')).toBeNull()

    await act(async () => { fireEvent.click(yourCall().getByRole('button', { name: '采纳建议' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'apply-proposal', decisionId: 'pd_1', suggestionId: 'sg_1' }])
    act(() => { gateway.setView('pending', pending()) })
    expect(screen.getByText(chip)).toBeInTheDocument()
    expect(screen.getByText(body)).toBeInTheDocument()
  })

  it('有可采纳的建议时，后面跟「在记忆页处理 ›」：不想按建议处理的出口，落在记忆页的「等你决定」', () => {
    const { openPage, gateway } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending(adoptable) })
    const buttons = yourCall().getAllByRole('button').filter(b => b.closest('.pm-conflict-actions') !== null)
    expect(buttons.map(b => b.textContent)).toEqual(['采纳建议', '在记忆页处理 ›'])
    expect(buttons[0]).toHaveClass('pm-btn--primary')
    fireEvent.click(buttons[1]!)
    expect(openPage).toHaveBeenCalledWith(todo)
    expect(gateway.executed).toHaveLength(0)
  })

  it('模型判断不了：写明需要用户来定，没有「采纳建议」，只给「在记忆页处理 ›」', () => {
    const undecided = { ...conflict, noSuggestion: { code: 'undecided', reason: '分不出哪条对' } } as PendingItem
    const { container } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending(undecided) })
    expect(screen.getByText('模型判断不了该怎么处理，需要你来定。')).toBeInTheDocument()
    expect(container.querySelector('.pm-side-suggestion')).toBeNull()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
  })

  it('融合建议：一行「模型建议：融合成一条」，不放融合稿和对照，没有「采纳建议」，是「在记忆页处理 ›」', () => {
    const { container, openPage } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending(suggested('merge')) })
    expect(container.querySelector('.pm-side-suggestion')).toHaveTextContent('模型建议：融合成一条')
    expect(screen.queryByText('集成测试用真实 Postgres，单元测试可以 mock。')).toBeNull()
    expect(screen.queryByText(/看和原文的对照/)).toBeNull()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    // 融合时采纳后哪条去哪写不下，不画说明
    expect(container.querySelector('.pm-conflict-footer .pm-advice')).toBeNull()
    fireEvent.click(yourCall().getByRole('button', { name: '在记忆页处理 ›' }))
    expect(openPage).toHaveBeenCalledWith(todo)
  })

  it.each([
    ['任一条含高危密钥', { noSuggestion: { code: 'has-secret' } }],
    ['还没生成', { noSuggestion: { code: 'not-generated' } }],
    ['生成失败', { noSuggestion: { code: 'failed', cause: { kind: 'model-error', message: 'timeout' } } }],
    ['模型判断不了', { noSuggestion: { code: 'undecided', reason: '两条都没写日期。' } }],
    ['一方定位不到', { right: null }],
  ] as const)('没有建议（%s）：不写建议那一行，没有「采纳建议」「补上建议」，只有「在记忆页处理 ›」', (_label, patch) => {
    const { container, openPage } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending({ ...conflict, ...patch } as PendingItem) })
    expect(container.querySelector('.pm-side-suggestion')).toBeNull()
    expect(screen.queryByText(/模型建议/)).toBeNull()
    expect(screen.queryByText('两条都没写日期。')).toBeNull()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    expect(screen.queryByRole('button', { name: /补上建议|再试一次/ })).toBeNull()
    expect(container.querySelectorAll('.pm-conflict-actions button')).toHaveLength(1)
    fireEvent.click(yourCall().getByRole('button', { name: '在记忆页处理 ›' }))
    expect(openPage).toHaveBeenCalledWith(todo)
  })

  it('采纳时建议已失效（服务端回 stale）：不落盘、不写通用的失败，原位写明失效，退化成没有建议；视图带来另一份建议时照常显示', async () => {
    const { gateway, container } = setup(
      { library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending(adoptable) },
      command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '建议已失效，未做任何改动' }),
    )
    await act(async () => { fireEvent.click(yourCall().getByRole('button', { name: '采纳建议' })) })
    expect(screen.getByRole('status')).toHaveTextContent('这两条刚被改过，建议已失效。下次体检会重新给建议。')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/未做任何改动/)).toBeNull()
    expect(container.querySelector('.pm-side-suggestion')).toBeNull()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    expect(yourCall().getByRole('button', { name: '在记忆页处理 ›' })).toBeInTheDocument()
    expect(yourCall().getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()

    // 视图还是那一份：照旧失效
    act(() => { gateway.setView('pending', pending(suggested('keep-a'))) })
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    // 新的一份（id 不同）
    act(() => { gateway.setView('pending', pending(suggested('keep-b', 'sg_2'))) })
    expect(container.querySelector('.pm-side-suggestion')).toHaveTextContent('模型建议：保留 B')
    expect(screen.queryByRole('status')).toBeNull()
    expect(yourCall().getByRole('button', { name: '采纳建议' })).toBeInTheDocument()
  })

  it('英文界面：Model suggests 一行、Adopt suggestion、和底部入口同名的 Handle on the Memory page', () => {
    const gateway = createFakeGateway({ views: { health: health(), library: library(pref, pref2), session: snapshot({ injectedIds: ['p1'] }), pending: pending(suggested('keep-both')) } })
    const { container } = render(<PanelShell gateway={gateway} t={createTranslator(en)}><SidebarTab sessionId="s1" workspacePath={WS} openPage={vi.fn()} /></PanelShell>)
    expect(container.querySelector('.pm-side-suggestion')).toHaveTextContent('Model suggests: Keep both (not a conflict)')
    expect(screen.getByRole('button', { name: 'Adopt suggestion' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Handle on the Memory page ›' })).toBeInTheDocument()
  })
})

describe('SidebarTab 别处已经在处理同一条冲突', () => {
  const refused = '你的选择没有生效：这条冲突正在别处处理，或者刚在别处处理完。'

  it.each(['claimed', 'not-found'] as const)('采纳回 %s：原位写明没有生效；别处的裁决写进视图、冲突卡消失后提示还在', async (code) => {
    const { gateway } = setup(
      { library: library(pref, pref2, proj, glob), session: snapshot({ injectedIds: ['p1', 'j1', 'p2', 'g1'] }), pending: pending(suggested('keep-b')) },
      command => ({ ok: false, cmd: command.cmd, code, detail: '待决项 pd_1 正在被另一次裁决处理，未做任何改动。' }),
    )
    const group = within(screen.getByRole('region', { name: '等你决定' }))
    await act(async () => { fireEvent.click(group.getByRole('button', { name: '采纳建议' })) })
    expect(group.getByRole('alert')).toHaveTextContent(refused)
    expect(screen.queryByText(/正在被另一次裁决处理/)).toBeNull()

    // 另一个标签页保留了 A：冲突出了待处理，B 被删
    act(() => {
      gateway.setView('pending', pending())
      gateway.setView('library', library(pref, proj, glob))
    })
    expect(screen.queryByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeNull()
    expect(screen.queryByText('已保留 B')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent(refused)
  })

  it('带入的记忆都没了：提示留在空状态上面', async () => {
    const { gateway } = setup(
      { library: library(pref, pref2), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending(adoptable) },
      command => ({ ok: false, cmd: command.cmd, code: 'claimed' }),
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    act(() => {
      gateway.setView('pending', pending())
      gateway.setView('library', library())
    })
    expect(screen.getByText('还没有记忆')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(refused)
  })
})

describe('SidebarTab 一条冲突同时只发一次裁决', () => {
  it('采纳还没回来时做了别的动作（删新记的）：那条冲突仍不可再采纳，不会发出第二次', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    let finish: (() => void) | undefined
    const { gateway } = setup(
      { library: library(pref, pref2, fresh), session: snapshot({ injectedIds: ['p1', 'p2'], savedIds: ['n1'] }), pending: pending(adoptable) },
      command => command.cmd === 'apply-proposal'
        ? new Promise(resolve => { finish = () => { resolve({ ok: true, cmd: command.cmd, decisionId: 'pd_1' }) } })
        : { ok: true, cmd: command.cmd, memoryIds: ['n1'] },
    )
    const group = within(screen.getByRole('region', { name: '等你决定' }))
    await act(async () => { fireEvent.click(group.getByRole('button', { name: '采纳建议' })) })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    expect(group.getByRole('button', { name: '采纳建议' })).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { fireEvent.click(group.getByRole('button', { name: '采纳建议' })) })
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['apply-proposal', 'forget'])
    await act(async () => { finish!() })
    expect(screen.getByText('已保留 A')).toBeInTheDocument()
  })
})

describe('SidebarTab 跨项目确认', () => {
  it('对方属于别的项目：服务端拒了就原位确认，「继续处理」带 allowCrossWorkspace 重发；「取消」什么都不发', async () => {
    const other = memory({ id: 'p2', type: 'preference', workspacePath: '/w/blog', content: '测试里 mock 数据库就行。' })
    const cross = suggested('keep-both', 'sg_1', { ...conflict, right: other } as PendingItem)
    const { gateway } = setup(
      { library: library(pref, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(cross) },
      command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: true, cmd: command.cmd }
        : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'p2', workspacePath: '/w/blog' }] },
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(screen.getByText('这条记忆属于 blog 项目，不是当前项目。确定在这里处理它吗？')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '采纳建议' })).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText(/属于 blog 项目/)).toBeNull()
    expect(gateway.executed).toHaveLength(1)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '继续处理' })) })
    expect(gateway.executed.map(e => e.command).at(-1)).toEqual({ cmd: 'apply-proposal', decisionId: 'pd_1', suggestionId: 'sg_1', allowCrossWorkspace: true })
    expect(screen.getByText('按模型建议处理。以后体检不再把它们当冲突。')).toBeInTheDocument()
    expect(screen.queryByText(/属于 blog 项目/)).toBeNull()
  })
})

describe('SidebarTab 裁决结论没记下', () => {
  it('结果带 isUnrecorded（升级前导入、缺指纹的冲突）：写下次体检可能还会报，不给撤销', async () => {
    setup(
      { library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(suggested('keep-both')) },
      command => ({ ok: true, cmd: command.cmd, decisionId: 'pd_1', isUnrecorded: true }),
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(screen.getByText('按模型建议处理。这次的决定没能记下，下次体检可能还会报。')).toBeInTheDocument()
    expect(screen.queryByText(/以后体检不再把它们当冲突。/)).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })
})

describe('SidebarTab 裁决删掉的一方含密钥', () => {
  it('PA-11 结果带 isHardDeleted：写已彻底删除、提醒换凭证，不给撤销', async () => {
    setup(
      { library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(adoptable) },
      command => ({ ok: true, cmd: command.cmd, decisionId: 'pd_1', isHardDeleted: true }),
    )
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(screen.getByText('按模型建议处理。B 含密钥，已彻底删除。如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(screen.queryByText(/B 已删除，14 天内可恢复。/)).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })
})

describe('SidebarTab 冲突对方在别的项目', () => {
  it('那一方的元信息写项目名；本项目这一方写「本项目」，不再两边都不写作用域', () => {
    const other = memory({ id: 'p2', type: 'preference', workspacePath: '/w/blog', content: '测试里 mock 数据库就行。' })
    const { container } = setup({ library: library(pref, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending({ ...conflict, right: other } as PendingItem) })
    const metas = [...container.querySelectorAll('.pm-conflict .pm-mc-meta')].map(el => el.textContent)
    expect(metas).toHaveLength(2)
    expect(metas[0]).toMatch(/本项目你/)
    expect(metas[1]).toMatch(/blog你/)
  })

  it('两方都在本项目：照旧不写作用域（面包屑已经交代）', () => {
    const { container } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(conflict) })
    const metas = [...container.querySelectorAll('.pm-conflict .pm-mc-meta')].map(el => el.textContent)
    expect(metas.some(text => /本项目|blog/.test(text ?? ''))).toBe(false)
  })
})

describe('SidebarTab 就地裁决：和基线冲突', () => {
  /** 带处理建议的基线冲突（结论按参数）。 */
  function verticalSuggested(action: 'rewrite' | 'delete' | 'keep-both', item: PendingItem = vertical): PendingItem {
    const memoryId = item.kind === 'conflict-vertical' ? item.memory!.id : ''
    const ops: ProposalOp[] = action === 'delete' ? [{ kind: 'forget', memoryId }]
      : action === 'keep-both' ? [{ kind: 'keep', memoryId }]
        : [{ kind: 'edit', memoryId, content: 'web/ 下 merge freeze 到 3 月 5 日，其余照 AGENTS.md。', name: proj.name, summary: proj.summary, tags: [] }]
    return { ...item, suggestion: { id: 'sg_v', action, reason: REASON, ops, isSourced: false, baselineWorkspace: WS } } as PendingItem
  }
  const yourCall = () => within(screen.getByRole('region', { name: '等你决定' }))

  it('带入的记忆和基线冲突：冲突卡在「等你决定」段里，写明基线不会被删除；没有建议时只有「在记忆页处理 ›」，不再有直接裁决的按钮', () => {
    const { container, openPage, gateway } = setup({ library: library(pref, proj), session: snapshot({ injectedIds: ['p1', 'j1'] }), pending: pending(vertical) })
    expect(yourCall().getByRole('heading', { name: '这条记忆和基线矛盾，等你决定' })).toBeInTheDocument()
    expect(yourCall().getByText('指令文件不会被改动，处理只针对这条记忆。')).toBeInTheDocument()
    expect(screen.getAllByText('merge freeze 到 3 月 5 日。')).toHaveLength(1)
    expect(screen.queryByText(/处待处理/)).toBeNull()
    expect(container.querySelector('.pm-side-suggestion')).toBeNull()
    expect([...container.querySelectorAll('.pm-conflict-actions button')].map(b => b.textContent)).toEqual(['在记忆页处理 ›'])
    fireEvent.click(yourCall().getByRole('button', { name: '在记忆页处理 ›' }))
    expect(openPage).toHaveBeenCalledWith({ view: 'todo', scope: { kind: 'workspace', workspacePath: WS }, fromChat: true, level: 'your-call' })
    expect(gateway.executed).toHaveLength(0)
  })

  it.each([
    ['delete', '以文件为准，删除这条', '采纳后这条记忆进最近删除，14 天内可恢复。', '已按基线', /按模型建议处理。这条记忆已删除，14 天内可恢复。/],
    ['keep-both', '都保留（不算冲突）', '采纳后这条记忆留着，它和指令文件都不变时不再报。', '已保留这条记忆', /按模型建议处理。基线和记忆都不变时不再报。/],
  ] as const)('故事 32：建议 %s：一行「模型建议：%s」，说明采纳后的去向；「采纳建议」只带条目 id 和建议 id，结果写来由、可撤销', async (action, conclusion, note, chip, body) => {
    const { gateway, container } = setup({ library: library(pref, proj), session: snapshot({ injectedIds: ['p1', 'j1'] }), pending: pending(verticalSuggested(action)) })
    expect(container.querySelector('.pm-side-suggestion')).toHaveTextContent(`模型建议：${conclusion}`)
    expect(screen.queryByText(REASON)).toBeNull()
    expect(yourCall().getByText(note)).toBeInTheDocument()
    expect([...container.querySelectorAll('.pm-conflict-actions button')].map(b => b.textContent)).toEqual(['采纳建议', '在记忆页处理 ›'])
    await act(async () => { fireEvent.click(yourCall().getByRole('button', { name: '采纳建议' })) })
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'apply-proposal', decisionId: 'pd_v', suggestionId: 'sg_v' }])
    act(() => { gateway.setView('pending', pending()) })
    expect(screen.getByText(chip)).toBeInTheDocument()
    expect(screen.getByText(body)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(gateway.executed.map(e => e.command)[1]).toEqual({ cmd: 'undo', decisionId: 'pd_v' })
  })

  it('故事 32：建议改写这条记忆：一行「模型建议：改写这条记忆」，不放改写稿，没有「采纳建议」，只有「在记忆页处理 ›」', () => {
    const { container } = setup({ library: library(pref, proj), session: snapshot({ injectedIds: ['p1', 'j1'] }), pending: pending(verticalSuggested('rewrite')) })
    expect(container.querySelector('.pm-side-suggestion')).toHaveTextContent('模型建议：改写这条记忆')
    expect(screen.queryByText(/web\/ 下 merge freeze/)).toBeNull()
    expect([...container.querySelectorAll('.pm-conflict-actions button')].map(b => b.textContent)).toEqual(['在记忆页处理 ›'])
  })

  it('故事 5a：会话不在这条记忆的项目里（全局记忆的建议是别的项目里生成的）：不写建议、不给「采纳建议」，只有「在记忆页处理 ›」', () => {
    const onGlobal = { ...verticalSuggested('delete', { ...vertical, memory: glob } as PendingItem) } as PendingItem
    const suggestion = { ...(onGlobal as Extract<PendingItem, { kind: 'conflict-vertical' }>).suggestion!, baselineWorkspace: '/w/other' }
    const { container } = setup({ library: library(pref, glob), session: snapshot({ injectedIds: ['p1', 'g1'] }), pending: pending({ ...onGlobal, suggestion } as PendingItem) })
    expect(container.querySelector('.pm-side-suggestion')).toBeNull()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    expect(yourCall().getByRole('button', { name: '在记忆页处理 ›' })).toBeInTheDocument()
  })

  it('建议整理不进右侧栏，也不算进底部「本项目还有 N 处待处理」', () => {
    const advice: PendingItem = { kind: 'advice', level: 'advice', type: 'stale', memories: [proj] }
    setup({ library: library(pref, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(vertical, advice) })
    expect(screen.getByText(/本项目还有 1 处待处理/)).toBeInTheDocument()
  })

  it('记忆没带入的基线冲突不挂出来，只在底部计数', () => {
    setup({ library: library(pref, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(vertical) })
    expect(screen.queryByRole('heading', { name: '这条记忆和基线矛盾，等你决定' })).toBeNull()
    expect(screen.getByText(/本项目还有 1 处待处理/)).toBeInTheDocument()
  })
})

describe('SidebarTab 底部入口', () => {
  it('其余待处理只在底部带数字（就地显示的冲突不算），经导航 store 跳记忆页待处理', () => {
    const gateway = createFakeGateway({
      views: {
        library: library(pref, pref2, proj, glob),
        session: snapshot({ injectedIds: ['p1', 'j1'] }),
        pending: pending(conflict, promote),
      },
    })
    const nav = createNavStore({ view: 'library' })
    const layout = { selectPanel: vi.fn() }
    const { container } = renderInShell(
      <SidebarTab sessionId="s1" workspacePath={WS} openPage={(target) => { openMemoryPage({ layout }, nav, target) }} />,
      gateway,
    )
    expect(screen.getByText(/本项目还有 1 处待处理/)).toBeInTheDocument()
    fireEvent.click(within(container.querySelector<HTMLElement>('.pm-side-footer')!).getByRole('button', { name: '在记忆页处理 ›' }))
    expect(nav.get()).toEqual({ view: 'todo', scope: { kind: 'workspace', workspacePath: WS }, fromChat: true })
    expect(layout.selectPanel).toHaveBeenCalledWith(PANEL_ID)
  })
})

describe('SidebarTab 项目路径的写法', () => {
  it('PA-22：会话视图的项目路径带末尾分隔符、记忆和待处理里不带：认成同一个项目，命令里的作用域仍是记录里的原路径', async () => {
    const { container, gateway } = setup({
      library: library(pref, pref2, proj, glob),
      session: snapshot({ workspacePath: `${WS}/`, injectedIds: ['p1', 'g1'], savedIds: ['p2'] }),
      pending: pending(vertical),
    })
    expect(container.querySelector('.pm-side-crumb')).toHaveTextContent('本项目 / app')
    expect(screen.getByText(/本项目还有 1 处待处理/)).toBeInTheDocument()
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    await remove(saved.getByRole('button', { name: '删除这条记忆' }))
    expect(gateway.executed.map(e => e.command)).toEqual([{ cmd: 'forget', memoryId: 'p2', layer: { kind: 'workspace', workspacePath: WS } }])
  })
})

describe('SidebarTab 确认收起后的键盘焦点', () => {
  /** 键盘用户按回车：焦点先落在按钮上再触发点击。 */
  const press = async (button: HTMLElement) => {
    button.focus()
    await act(async () => { fireEvent.click(button) })
  }

  it('普通删除：确认后这一行换成「已删除」，焦点落到原位的「撤销」；撤销后回到这一行的删除按钮', async () => {
    const one = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const two = memory({ id: 'n2', type: 'knowledge', content: '周报周五发。' })
    setup({ library: library(pref, proj, glob, one, two), session: snapshot({ savedIds: ['n1', 'n2'] }), pending: pending() })
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    const [first] = saved.getAllByRole('button', { name: '删除这条记忆' })
    await press(first!)
    await press(saved.getByRole('button', { name: '删除' }))
    expect(saved.queryByText('报销截止每月 25 日。')).toBeNull()
    await waitFor(() => { expect(saved.getByRole('button', { name: '撤销' })).toHaveFocus() })
    await press(saved.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(saved.getAllByRole('button', { name: '删除这条记忆' })[0]).toHaveFocus() })
  })

  it('含密钥确认：「取消」回到删除按钮；彻底删除后落到原位那行说明上', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    setup(
      { library: library(pref, proj, glob, fresh), session: snapshot({ savedIds: ['n1'] }), pending: pending() },
      command => command.cmd === 'forget' ? { ok: false, cmd: command.cmd, code: 'has-secret' } : { ok: true, cmd: command.cmd, memoryIds: ['n1'] },
    )
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    const del = () => saved.getByRole('button', { name: '删除这条记忆' })
    await press(del())
    await press(saved.getByRole('button', { name: '删除' }))
    await press(saved.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(del()).toHaveFocus() })

    await press(del())
    await press(saved.getByRole('button', { name: '删除' }))
    await press(saved.getByRole('button', { name: '彻底删除' }))
    await waitFor(() => { expect(saved.getByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')).toHaveFocus() })
  })

  it('彻底删除后下面只剩底部入口：焦点落在原位那行说明上，不跑到「在记忆页查看」', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    setup(
      { library: library(glob, fresh), session: snapshot({ injectedIds: [], savedIds: ['n1'] }), pending: pending() },
      command => command.cmd === 'forget' ? { ok: false, cmd: command.cmd, code: 'has-secret' } : { ok: true, cmd: command.cmd, memoryIds: ['n1'] },
    )
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    await press(saved.getByRole('button', { name: '删除这条记忆' }))
    await press(saved.getByRole('button', { name: '删除' }))
    // 不包 act：命令返回后网关记删除和本组件收尾分两次提交，同浏览器里一样
    const purge = saved.getByRole('button', { name: '彻底删除' })
    purge.focus()
    fireEvent.click(purge)
    await waitFor(() => { expect(screen.getByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')).toHaveFocus() })
  })

  it('彻底删除的是最后一条记忆：「还没有记忆」出来后那行说明还在，焦点落在它上面', async () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { gateway } = setup(
      { library: library(fresh), session: snapshot({ injectedIds: [], savedIds: ['n1'] }), pending: pending() },
      command => command.cmd === 'forget' ? { ok: false, cmd: command.cmd, code: 'has-secret' } : { ok: true, cmd: command.cmd, memoryIds: ['n1'] },
    )
    const saved = within(screen.getByRole('region', { name: '这次新写入的' }))
    await press(saved.getByRole('button', { name: '删除这条记忆' }))
    await press(saved.getByRole('button', { name: '删除' }))
    await press(saved.getByRole('button', { name: '彻底删除' }))
    act(() => { gateway.setView('library', library()) })
    expect(screen.getByText('还没有记忆')).toBeInTheDocument()
    const note = screen.getByText('已彻底删除。如果它是真的凭证，记得去换一个新的。')
    await waitFor(() => { expect(note).toHaveFocus() })
  })

  it('撤销裁决：撤销生效、视图还没带回冲突时「等你决定」段不消失，原位画回冲突卡（建议还在），焦点落在「采纳建议」；视图带回后卡片不重挂、焦点不动', async () => {
    const { gateway } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2', 'j1'] }), pending: pending(adoptable) })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    act(() => {
      gateway.setView('pending', pending())
      gateway.setView('library', library(pref, proj))
    })
    await press(screen.getByRole('button', { name: '撤销' }))
    // 中间态：撤销已生效，待处理视图里还没有这条冲突
    const yourCall = screen.getByRole('region', { name: '等你决定' })
    const card = within(yourCall).getByRole('heading', { name: '两条记忆互相矛盾，等你决定' }).closest('article')!
    expect(within(card).getByText('测试里 mock 数据库就行。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '等你决定 1' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(card).getByText('保留 A')).toBeInTheDocument()
    await waitFor(() => { expect(within(card).getByRole('button', { name: '采纳建议' })).toHaveFocus() })

    act(() => {
      gateway.setView('pending', pending(adoptable))
      gateway.setView('library', library(pref, pref2, proj))
    })
    expect(within(yourCall).getAllByRole('article')).toHaveLength(1)
    expect(within(yourCall).getByRole('article')).toBe(card)
    expect(within(card).getByRole('button', { name: '采纳建议' })).toHaveFocus()
  })

  it('撤销后视图还没带回冲突时可以接着采纳：再发 apply-proposal，换成新的结果卡', async () => {
    const { gateway } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2', 'j1'] }), pending: pending(adoptable) })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    act(() => { gateway.setView('pending', pending()) })
    await press(screen.getByRole('button', { name: '撤销' }))
    await press(await screen.findByRole('button', { name: '采纳建议' }))
    const adopt = { cmd: 'apply-proposal', decisionId: 'pd_1', suggestionId: 'sg_1' }
    expect(gateway.executed.map(e => e.command)).toEqual([adopt, { cmd: 'undo', decisionId: 'pd_1' }, adopt])
    expect(screen.getByText('已保留 A')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
  })

  it('跨项目确认：「取消」回到「采纳建议」；「继续处理」采纳完落到结果的「撤销」', async () => {
    const other = memory({ id: 'p2', type: 'preference', workspacePath: '/w/blog', content: '测试里 mock 数据库就行。' })
    const cross = suggested('keep-both', 'sg_1', { ...conflict, right: other } as PendingItem)
    setup(
      { library: library(pref, proj), session: snapshot({ injectedIds: ['p1'] }), pending: pending(cross) },
      command => 'allowCrossWorkspace' in command && command.allowCrossWorkspace === true
        ? { ok: true, cmd: command.cmd }
        : { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'p2', workspacePath: '/w/blog' }] },
    )
    const keepBoth = screen.getByRole('button', { name: '采纳建议' })
    await press(keepBoth)
    await press(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(keepBoth).toHaveFocus() })

    await press(keepBoth)
    await press(screen.getByRole('button', { name: '继续处理' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
  })
})

describe('类型显示名', () => {
  const proc = memory({ id: 'c1', type: 'procedure', content: '发版先跑全量测试。' })

  it('PA-20：改过名的预设类型按配置里的名字分组（和记忆查看、设置页同名）', () => {
    setup({ library: library(proc), session: snapshot({ injectedIds: ['c1'] }), pending: pending() }, undefined,
      { ...configWith('plugin-global'), customTypes: { procedure: { label: '发版手册' } } })
    const groups = within(screen.getByRole('region', { name: '带入的记忆' }))
    expect(groups.getByRole('heading', { name: /^发版手册 1/ })).toBeInTheDocument()
    expect(groups.queryByRole('heading', { name: /^可复用流程/ })).toBeNull()
  })

  it('PA-20：英文界面下内置、预设类型都写英文名', () => {
    const gateway = createFakeGateway({ views: { health: health(), library: library(pref, proc, glob), session: snapshot({ injectedIds: ['p1', 'c1', 'g1'] }), pending: pending() } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><SidebarTab sessionId="s1" workspacePath={WS} openPage={vi.fn()} /></PanelShell>)
    const groups = within(screen.getByRole('region', { name: 'Brought-in memories' }))
    expect(groups.getAllByRole('heading', { level: 3 }).map(h => h.textContent?.split(/\s\d/)[0])).toEqual(['Preference', 'Procedure', 'Profile'])
  })
})

describe('SidebarTab 折叠与「等你决定」', () => {
  const yourCall = () => screen.getByRole('region', { name: '等你决定' })
  const injected = () => screen.getByRole('region', { name: '带入的记忆' })

  it('带入的记忆各类型组默认收起：标题是整行按钮（aria-expanded / aria-controls），点开露出记忆卡并撑开，再点收起', () => {
    setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending() })
    const toggle = screen.getByRole('button', { name: '行为偏好 1 全文' })
    expect(toggle.closest('h3')).toHaveClass('pm-side-group-title')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(body).not.toBeVisible()
    expect(screen.queryByText('测试用真实 Postgres。')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(body).getByText('测试用真实 Postgres。').closest('.pm-arrive')).not.toBeNull()
    expect(screen.getByRole('button', { name: '项目信息 1 只带摘要' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('测试用真实 Postgres。')).toBeNull()
  })

  it('没有待裁决也没有结果卡：不画「等你决定」', () => {
    setup({ library: library(pref, proj, glob), session: snapshot(), pending: pending(promote) })
    expect(screen.queryByRole('region', { name: '等你决定' })).toBeNull()
  })

  it('有待决冲突：「等你决定」在「这次新写入的」之后、「带入的记忆」之前，标题带琥珀圆点和条数、默认展开（首屏不播撑开）；冲突双方照常列在各自类型组，组仍收起、不带标记', () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    const { container } = setup({
      library: library(pref, pref2, proj, glob, fresh),
      session: snapshot({ injectedIds: ['p1', 'j1', 'p2', 'g1'], savedIds: ['n1'] }),
      pending: pending(conflict, vertical),
    })
    expect([...container.querySelectorAll('.pm-side > section')].map(s => s.getAttribute('aria-label')))
      .toEqual(['对话开始时带入的记忆', '这次新写入的', '等你决定', '带入的记忆'])
    const head = screen.getByRole('button', { name: '等你决定 2' })
    expect(head.closest('h2')).toHaveClass('pm-side-title')
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(head.querySelector('.pm-marker--pending')).not.toBeNull()
    expect(yourCall().querySelector('.pm-arrive')).toBeNull()
    expect(within(yourCall()).getByRole('heading', { name: '两条记忆互相矛盾，等你决定' })).toBeInTheDocument()
    expect(within(yourCall()).getByRole('heading', { name: '这条记忆和基线矛盾，等你决定' })).toBeInTheDocument()

    expect(injected().querySelector('.pm-conflict, .pm-marker')).toBeNull()
    const prefs = within(injected()).getByRole('button', { name: '行为偏好 2 全文' })
    expect(prefs).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(prefs)
    expect(within(injected()).getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(within(injected()).getByText('测试里 mock 数据库就行。')).toBeInTheDocument()
  })

  it('同一条记忆既有横向又有基线冲突：两张卡都在「等你决定」，底部不再算它们', () => {
    const onPref: PendingItem = { ...vertical, decisionId: 'pd_v2', memory: pref } as PendingItem
    setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2'] }), pending: pending(conflict, onPref) })
    expect(screen.getByRole('button', { name: '等你决定 2' })).toBeInTheDocument()
    expect(within(yourCall()).getAllByRole('article')).toHaveLength(2)
    expect(screen.queryByText(/处待处理/)).toBeNull()
  })

  it('「等你决定」可以收起，视图刷新后照旧收起；只剩结果卡时标题不写条数、不带圆点；收起后新冲突进来，标题重新带圆点和条数', async () => {
    const { gateway } = setup({ library: library(pref, pref2, proj), session: snapshot({ injectedIds: ['p1', 'p2', 'j1'] }), pending: pending(adoptable) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    act(() => {
      gateway.setView('pending', pending())
      gateway.setView('library', library(pref, proj))
    })
    const head = screen.getByRole('button', { name: '等你决定' })
    expect(head.querySelector('.pm-marker')).toBeNull()
    expect(within(yourCall()).getByText('已保留 A')).toBeInTheDocument()

    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('已保留 A')).toBeNull()
    act(() => { gateway.setView('pending', pending(vertical)) })
    const again = screen.getByRole('button', { name: '等你决定 1' })
    expect(again).toHaveAttribute('aria-expanded', 'false')
    expect(again.querySelector('.pm-marker--pending')).not.toBeNull()
    expect(screen.queryByRole('heading', { name: '这条记忆和基线矛盾，等你决定' })).toBeNull()
  })

  it('三个段标题文字从同一处起：折叠箭头放在标题行末尾，「等你决定」的琥珀圆点跟在条数后面，不挤在文字前', () => {
    const fresh = memory({ id: 'n1', type: 'knowledge', content: '报销截止每月 25 日。' })
    setup({ library: library(pref, pref2, proj, fresh), session: snapshot({ injectedIds: ['p1', 'p2', 'j1'], savedIds: ['n1'] }), pending: pending(conflict) })
    for (const name of ['等你决定 1', '行为偏好 2 全文']) {
      const head = screen.getByRole('button', { name })
      // 按钮里先是标题文字，箭头在最后
      expect(head.firstElementChild).toHaveClass('pm-side-fold-label')
      expect(head.lastElementChild?.tagName.toLowerCase()).toBe('svg')
      expect(head.querySelector('.pm-side-fold-label')!.firstChild?.nodeType).toBe(Node.TEXT_NODE)
    }
    const label = screen.getByRole('button', { name: '等你决定 1' }).querySelector('.pm-side-fold-label')!
    expect(label.lastElementChild).toHaveClass('pm-marker--pending')
  })

  it('英文：段标题写 Waiting on you', () => {
    const gateway = createFakeGateway({ views: { health: health(), library: library(pref, pref2), session: snapshot({ injectedIds: ['p1'] }), pending: pending(conflict) } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><SidebarTab sessionId="s1" workspacePath={WS} openPage={vi.fn()} /></PanelShell>)
    expect(screen.getByRole('button', { name: 'Waiting on you 1' })).toHaveAttribute('aria-expanded', 'true')
  })
})

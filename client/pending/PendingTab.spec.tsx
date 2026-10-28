import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type AdviceType, type HealthView, type MemoryCard, type MemoryCommand, type MemoryCommandResult, type PendingItem, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { useGateway, type PluginConfig } from '../gateway.ts'
import { FLASH_MS } from '../library/shared.tsx'
import { ALL_SCOPE, createNavStore, type NavStore, type PageScope } from '../nav.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'

// 待处理 tab：给定一份待处理视图，断言每类卡渲染出什么、点按钮向网关发了什么命令。

const SESSION = { kind: 'ready', sessionId: 's1', cwd: '/w/app' } as const
const config: PluginConfig = { snapshotTokenBudget: 4000, snapshotOverflow: 'relax', governanceEnabled: true, globalPromoteTarget: 'plugin-global' }

const A = memory({ id: 'a', content: '测试用真实 Postgres。', sourceMode: 'user-explicit' })
const B = memory({ id: 'b', content: '测试里 mock 数据库就行。', sourceMode: 'agent-inferred' })
const horizontal: PendingItem = { kind: 'conflict-horizontal', level: 'your-call', decisionId: 'd-h', firstSeenAt: 1, summary: '测试里怎么准备数据库，两条记忆互相矛盾', left: A, right: B, preferredId: 'a' }
const vertical: PendingItem = { kind: 'conflict-vertical', level: 'your-call', decisionId: 'd-v', firstSeenAt: 2, summary: '包管理器和基线矛盾', memory: memory({ id: 'v', content: '用 npm。' }), baselineRef: 'AGENTS.md：用 pnpm' }
const promote: PendingItem = { kind: 'promote-candidate', level: 'your-call', decisionId: 'd-p', firstSeenAt: 3, memory: memory({ id: 'p', content: '所有项目都用 vitest。' }) }
const secret: PendingItem = { kind: 'secret', level: 'must-fix', memory: memory({ id: 's', content: '部署 token [已隐藏]', filePath: '/m/app/deploy.md' }) }
const overflow: PendingItem = { kind: 'overflow', level: 'your-call', decisionId: 'd-o', firstSeenAt: 4, mode: 'relax', tier: 1, workspacePath: '/w/app' }
const unreadable: PendingItem = {
  kind: 'unreadable-file', level: 'must-fix', layer: { kind: 'workspace', workspacePath: '/w/app' }, filePath: '/m/app/broken.md', relativePath: 'app/broken.md',
  error: 'YAMLException: unexpected end of the stream within a flow collection (2:8)',
}

const tidy: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 't1', name: '很长的一条', digest: 'sha1:t1', filePath: '/m/app/t1.md' })] }

const view = (...items: PendingItem[]): PendingView => ({ version: GUI_VIEW_VERSION, dot: 'amber', items, levelCounts: levelCountsOf(items), typeLabels: { preference: '行为偏好' } })
const scannedHealth = (at: number | null): HealthView => ({
  version: GUI_VIEW_VERSION,
  governanceEnabled: true,
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 1, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0, lastCheckupAt: at, overflow: null, ignored: [], deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } } }],
})

function setup(items: PendingItem[], init: FakeGatewayInit = {}, nav: NavStore = createNavStore()) {
  const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(...items), health: scannedHealth(NOW) }, ...init })
  const utils = renderInShell(<PendingTab nav={nav} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} />, gateway)
  const commands = () => gateway.executed.map(e => e.command)
  return { ...utils, gateway, commands }
}

describe('待处理：按级别分组', () => {
  it('先处理在前、等你决定在后，组标题带条数；组内按视图顺序出卡', () => {
    setup([secret, unreadable, horizontal, vertical, promote, overflow])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['先处理 2', '等你决定 4'])
    const mustFix = screen.getByRole('region', { name: '先处理 2' })
    expect(within(mustFix).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['这条记忆里有密钥', '有个文件读不出来'])
    expect(within(screen.getByRole('region', { name: '等你决定 4' })).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      '测试里怎么准备数据库，两条记忆互相矛盾', '包管理器和基线矛盾', '这条适合所有项目', '带入的记忆超出上限',
    ])
  })

  it('密钥标红，读不出的文件同在先处理组、标琥珀圆点（标题和上面对齐）', () => {
    setup([secret, unreadable])
    const mustFix = screen.getByRole('region', { name: '先处理 2' })
    const [secretCard, fileCard] = within(mustFix).getAllByRole('article')
    expect(within(secretCard!).getByRole('img', { name: '有密钥要处理' })).toBeInTheDocument()
    expect(fileCard!.querySelector('.pm-pending-head .pm-marker--pending')).not.toBeNull()
  })

  it('某一级没有待处理项：整组不画', () => {
    setup([horizontal])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['等你决定 1'])
    expect(screen.queryByRole('region', { name: /先处理/ })).toBeNull()
  })

  it('只有先处理：只画这一组', () => {
    setup([unreadable])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['先处理 1'])
  })

  it('三组按「先处理 / 等你决定 / 可以整理」排；「可以整理」标题后写「· 处理或选择不再提醒后不扣分」，另两组不写', () => {
    setup([secret, horizontal, tidy])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['先处理 1', '等你决定 1', '可以整理 1'])
    expect(screen.getAllByText('处理或选择不再提醒后不扣分')).toHaveLength(1)
    const note = screen.getByText('处理或选择不再提醒后不扣分')
    expect(note.closest('section')).toBe(screen.getByRole('region', { name: /^可以整理/ }))
  })

  it('全部处理完：组上方写「都处理完了，agent 之后按你的决定来。」，结果卡还在原位', async () => {
    const { gateway } = setup([horizontal, tidy])
    expect(screen.queryByText('都处理完了，agent 之后按你的决定来。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    await screen.findByText('已按 A')
    act(() => { gateway.setView('pending', view(tidy)) })
    // 还剩一条可以整理：不算处理完
    expect(screen.queryByText('都处理完了，agent 之后按你的决定来。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '不再提醒' }))
    await screen.findByText('不再扣分；内容改了会重新提醒。')
    const done = screen.getByText('都处理完了，agent 之后按你的决定来。')
    // 在第一组上面
    expect(done.compareDocumentPosition(screen.getAllByRole('heading', { level: 2 })[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('裁决后结果卡留在原来那一组；组标题的数只算还在等你的', async () => {
    setup([secret, horizontal, promote])
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    await screen.findByText('已按 A')
    const yourCall = screen.getByRole('region', { name: '等你决定 1' })
    expect(within(yourCall).getByText('已按 A')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '先处理 1' })).toBeInTheDocument()
    // 标记列不空出来：处理完换成灰圆点，标题不往左跳
    expect(within(yourCall).getByText('已按 A').closest('article')!.querySelector('.pm-pending-head .pm-marker--done')).not.toBeNull()
  })
})

describe('待处理：各类卡', () => {

  it('横向冲突：A / B 原文、类型显示名，各自卡底写选它会删掉哪条；三个按钮各发对应 verdict', async () => {
    const { commands } = setup([horizontal])
    const a = screen.getByRole('region', { name: '记忆 A' })
    expect(within(a).getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(within(a).getByText('行为偏好')).toBeInTheDocument()
    expect(within(a).getByText('B 会删掉，14 天内可恢复')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '记忆 B' })).getByText('A 会删掉，14 天内可恢复')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '以 B 为准' }))
    await waitFor(() => { expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-right' }]) })
  })

  it('横向冲突：「都保留」并进普通动作行，左边写决定前按哪条、都保留的后果；裁决不加确认，结果带撤销', async () => {
    const { commands } = setup([horizontal])
    const keepBoth = screen.getByRole('button', { name: '都保留' })
    const row = keepBoth.closest('.pm-conflict-row')!
    expect(row).not.toBeNull()
    expect(row).toHaveTextContent('决定之前，agent 按你明确说过的 A 来做。两条都对就选都保留，以后不再算冲突。')
    expect(row.querySelectorAll('button')).toHaveLength(1)
    expect(document.querySelector('.pm-keep-line')).toBeNull()
    fireEvent.click(keepBoth)
    await screen.findByText('以后体检不再把它们当冲突。')
    expect(screen.queryByRole('group')).toBeNull()
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-both' }])
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('偏好方不是你明确说过的：只写按哪条', () => {
    setup([{ ...horizontal, preferredId: 'b' } as PendingItem])
    expect(screen.getByText(/决定之前，agent 按 B 来做。/)).toBeInTheDocument()
  })

  it('垂直冲突：写明基线不会被删除；「以基线为准」= keep-right、「保留这条记忆」= keep-left', async () => {
    const { commands, gateway } = setup([vertical])
    expect(screen.getByText('AGENTS.md 是基线，不会被删除。')).toBeInTheDocument()
    expect(screen.getByText('基线：AGENTS.md：用 pnpm')).toBeInTheDocument()
    expect(screen.getByText(/以基线为准会删掉这条记忆，14 天内可恢复/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保留这条记忆' }))
    await screen.findByText('已保留这条记忆')
    act(() => { gateway.setView('pending', view(vertical)) })
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-v' }) })
    fireEvent.click(await screen.findByRole('button', { name: '以基线为准' }))
    await screen.findByText('这条记忆已删除，14 天内可恢复。')
    expect(commands()).toEqual([
      { cmd: 'resolve', decisionId: 'd-v', verdict: 'keep-left' },
      { cmd: 'undo', decisionId: 'd-v' },
      { cmd: 'resolve', decisionId: 'd-v', verdict: 'keep-right' },
    ])
  })

  it('提升候选：「提升为全局」直接发 promote（不再弹确认），结果可撤销；「留在本项目」发 keep-local', async () => {
    const { commands } = setup([promote])
    expect(screen.getByText('提升后所有项目都会带入它，14 天内可撤销。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    await screen.findByText('已提升为全局')
    expect(screen.getByText('所有项目都会带入它，14 天内可撤销。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'promote', decisionId: 'd-p', target: 'global' }])
  })

  it('留在本项目：结果写「以后不再提示这条」', async () => {
    const { commands } = setup([promote])
    fireEvent.click(screen.getByRole('button', { name: '留在本项目' }))
    await screen.findByText('以后不再提示这条。')
    expect(commands()).toEqual([{ cmd: 'keep-local', decisionId: 'd-p' }])
  })

  it('候选在本项目里：标题和按钮不写项目名', () => {
    setup([promote])
    expect(screen.getByRole('heading', { name: '这条适合所有项目' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提升为全局' })).toBeInTheDocument()
  })

  it('提升目标是 AGENTS.md：按钮改「写进 AGENTS.md」并说明插件不再管理；结果不能撤销', async () => {
    const { commands } = setup([promote], { config: { ...config, globalPromoteTarget: 'agents-md' } })
    expect(screen.getByText('之后由你自己维护：插件不再体检它，它也不会过期。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '写进 AGENTS.md' }))
    await screen.findByText('已写进 AGENTS.md')
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    expect(commands()).toEqual([{ cmd: 'promote', decisionId: 'd-p', target: 'agents-md' }])
  })

  it('候选在别的项目里：标题写明项目名，按钮「提升 X 里的这条」；还没读到配置时提升按钮不可用', () => {
    const other: PendingItem = { ...promote, memory: memory({ id: 'p2', workspacePath: '/w/blog' }) } as PendingItem
    setup([other], { config: undefined })
    expect(screen.getByRole('heading', { name: 'blog 里的这条适合所有项目' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '提升 blog 里的这条' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '提升 blog 里的这条' })).toHaveAttribute('title', '正在读取设置…')
  })

  it('别的项目里的记忆：卡上元信息写项目名，不写「本项目」；本项目的照旧写「本项目」', () => {
    const other: PendingItem = { ...promote, memory: memory({ id: 'p2', workspacePath: '/w/blog' }) } as PendingItem
    const cross: PendingItem = { ...horizontal, right: memory({ id: 'b2', content: '博客里 mock 数据库。', workspacePath: '/w/blog' }) } as PendingItem
    const { container } = setup([other, cross])
    const metas = [...container.querySelectorAll('.pm-mc-meta')].map(el => el.textContent)
    expect(metas).toHaveLength(3)
    expect(metas[0]).toMatch(/·blog·/)
    expect(metas[1]).toMatch(/·本项目·/)
    expect(metas[2]).toMatch(/·blog·/)
  })

  it('候选是否在别的项目：按会话归属判断（对照里的软链接、项目子目录都算本项目；嵌套子项目里的会话看外层的记忆算别的项目）', () => {
    const check = (session: { kind: 'ready'; sessionId: string; cwd: string; workspaces?: Record<string, string> }, heading: string) => {
      const gateway = createFakeGateway({ session, config, views: { pending: view(promote), health: scannedHealth(NOW) } })
      const { unmount } = renderInShell(<PendingTab nav={createNavStore()} session={session} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} />, gateway)
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
      unmount()
    }
    check({ kind: 'ready', sessionId: 's1', cwd: '/link/app', workspaces: { '/link/app': '/w/app' } }, '这条适合所有项目')
    check({ kind: 'ready', sessionId: 's1', cwd: '/w/app/sub' }, '这条适合所有项目')
    check({ kind: 'ready', sessionId: 's1', cwd: '/w/app/pkg', workspaces: { '/w/app/pkg': '/w/app/pkg' } }, 'app 里的这条适合所有项目')
  })

  it('超限：「整理记忆 ›」去全部记忆，作用域是这张卡那一层（项目或全局），不发命令', () => {
    const nav = createNavStore()
    const global: PendingItem = { kind: 'overflow', level: 'your-call', decisionId: 'd-g', firstSeenAt: 5, mode: 'strict', tier: 0 }
    const { commands } = setup([overflow, global], {}, nav)
    const [projectLink, globalLink] = screen.getAllByRole('button', { name: '整理记忆 ›' })
    fireEvent.click(projectLink!)
    expect(nav.get()).toMatchObject({ view: 'library', scope: { kind: 'workspace', workspacePath: '/w/app' }, memoryId: undefined })
    fireEvent.click(globalLink!)
    expect(nav.get()).toMatchObject({ view: 'library', scope: { kind: 'global' }, memoryId: undefined })
    expect(commands()).toEqual([])
  })

  it('超限：写出超出量与放宽到的档位；右上角叉「不再提醒」发 dismiss-overflow', async () => {
    const { commands } = setup([overflow])
    expect(screen.getByText('超出上限 25% 以上，已自动放宽到 5,000（上限 4,000）。')).toBeInTheDocument()
    // 范围由胶囊或当前范围交代，不再另写一行「在 X 项目里」
    expect(screen.queryByText('在 app 项目里')).toBeNull()
    const dismiss = screen.getByRole('button', { name: '不再提醒' })
    expect(dismiss).toHaveClass('pm-dismiss')
    expect(dismiss.closest('.pm-pending-head')).not.toBeNull()
    fireEvent.click(dismiss)
    await screen.findByText('用量再升一档时再提醒你。')
    expect(commands()).toEqual([{ cmd: 'dismiss-overflow', decisionId: 'd-o' }])
    // 忽略的提醒可撤销：撤销发 undo，提醒卡回来
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-o' })
    expect(screen.getByRole('button', { name: '不再提醒' })).toBeInTheDocument()
  })

  it('超限：「调高上限」走单字段配置写入，默认填下一档；不比当前上限大的值不写', async () => {
    const { gateway } = setup([overflow])
    const input = screen.getByRole('textbox', { name: /调高上限/ })
    expect(input).toHaveValue('6000')
    fireEvent.change(input, { target: { value: '3000' } })
    expect(screen.getByText('填一个比 4,000 大的整数。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(gateway.configWrites).toEqual([])
    fireEvent.change(input, { target: { value: '5500' } })
    expect(screen.getByText('触发新上限前不会再提醒。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText('上限已调到 5,500')
    expect(gateway.configWrites).toEqual([{ field: 'snapshotTokenBudget', value: 5500 }])
    expect(gateway.executed).toEqual([])
  })

  it('严格模式超限：写 95%', () => {
    setup([{ ...overflow, mode: 'strict', tier: 0 } as PendingItem])
    expect(screen.getByText('已用到上限 4,000 的 95%，再多的记忆不会带入。')).toBeInTheDocument()
  })

  it('读不出的文件：相对路径 + 解析器原话；「打开文件」「在…中显示」走宿主打开', async () => {
    const { gateway } = setup([unreadable])
    expect(screen.getByText('app/broken.md')).toBeInTheDocument()
    expect(screen.getByText(unreadable.kind === 'unreadable-file' ? unreadable.error : '')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }))
    fireEvent.click(screen.getByRole('button', { name: /中显示/ }))
    await waitFor(() => { expect(gateway.opened).toEqual([{ path: '/m/app/broken.md' }, { path: '/m/app/broken.md', action: 'reveal' }]) })
  })

  it('命令失败：原话显示在卡片里', async () => {
    setup([promote], { respond: () => ({ ok: false, code: 'governance-disabled', detail: '体检已关闭，可在插件设置里打开' }) })
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没有完成：体检已关闭，可在插件设置里打开')
  })
})

describe('待处理：密钥', () => {
  it('原文打码；「显示」只在本机读文件临时展开，「隐藏」收起；「打开文件改写」打开那个文件', async () => {
    const { gateway } = setup([secret], { files: { '/m/app/deploy.md': '---\nname: deploy\n---\n部署 token sk-live-123' } })
    expect(screen.getByText('部署 token [已隐藏]')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示' }))
    expect(await screen.findByText('部署 token sk-live-123')).toBeInTheDocument()
    expect(gateway.reads).toEqual(['/m/app/deploy.md'])
    fireEvent.click(screen.getByRole('button', { name: '隐藏' }))
    expect(screen.getByText('部署 token [已隐藏]')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开文件改写' }))
    await waitFor(() => { expect(gateway.opened).toEqual([{ path: '/m/app/deploy.md' }]) })
    expect(gateway.executed).toEqual([])
  })

  it('「彻底删除…」就地确认：默认焦点在「取消」，写清不进最近删除、快照副本也抹掉；取消什么都不发', () => {
    const { gateway } = setup([secret])
    fireEvent.click(screen.getByRole('button', { name: '彻底删除…' }))
    expect(screen.getByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '彻底删除…' })).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
  })

  it('确认后发 hard-delete，卡片换成收尾语，没有撤销', async () => {
    const { commands } = setup([secret, promote])
    fireEvent.click(screen.getByRole('button', { name: '彻底删除…' }))
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    expect(commands()).toEqual([{ cmd: 'hard-delete', memoryId: 's', layer: { kind: 'workspace', workspacePath: '/w/app' } }])
  })
})

describe('待处理：裁决后结果留原位、撤销', () => {
  it('裁决 → 原位结果卡（视图还没重写也不重复）→ 撤销发 undo → 视图带回冲突后只剩一张卡', async () => {
    const { gateway, commands } = setup([secret, horizontal, promote])
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    await screen.findByText('B 已删除，14 天内可恢复。')
    // 视图还是旧的（仍含这条冲突）：只显示结果卡，位置不变
    expect(screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      '这条记忆里有密钥', '测试里怎么准备数据库，两条记忆互相矛盾', '这条适合所有项目',
    ])
    expect(screen.getByText('已按 A')).toBeInTheDocument()
    expect(screen.getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '以 B 为准' })).toBeNull()

    // 视图重写：冲突已不在待处理里，结果卡仍在原位
    act(() => { gateway.setView('pending', view(secret, promote)) })
    expect(screen.getAllByRole('heading', { level: 3 })[1]).toHaveTextContent('测试里怎么准备数据库')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    // 撤销生效、视图还没带回来：原样显示冲突卡，能接着裁决
    expect(await screen.findByRole('button', { name: '以 B 为准' })).toBeInTheDocument()
    expect(commands()).toEqual([
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' },
      { cmd: 'undo', decisionId: 'd-h' },
    ])

    act(() => { gateway.setView('pending', view(secret, horizontal, promote)) })
    expect(screen.getAllByRole('button', { name: '以 B 为准' })).toHaveLength(1)
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3)
  })

  it('都保留：结果写「以后体检不再把它们当冲突」，可撤销', async () => {
    const { commands } = setup([horizontal])
    fireEvent.click(screen.getByRole('button', { name: '都保留' }))
    await screen.findByText('以后体检不再把它们当冲突。')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-h' }) })
  })
})

describe('待处理：别处已经在处理同一条', () => {
  const refused = '你对「测试里怎么准备数据库，两条记忆互相矛盾」的选择没有生效：它正在别处处理，或者刚在别处处理完。'
  const claimed = (command: MemoryCommand) => ({ ok: false as const, cmd: command.cmd, code: 'claimed' as const, detail: '待决项 d-h 正在被另一次裁决处理，未做任何改动。' })

  it('另一个标签页同时裁决（claimed）：写明你的选择没有生效，不显示原话；卡随视图更新消失后提示仍在原位', async () => {
    const { gateway } = setup([secret, horizontal, promote], { respond: claimed })
    fireEvent.click(screen.getByRole('button', { name: '以 B 为准' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(refused)
    expect(screen.queryByText(/正在被另一次裁决处理/)).toBeNull()
    expect(screen.queryByText('已按 B')).toBeNull()

    // 另一个标签页的裁决写进视图：这条冲突出了待处理
    act(() => { gateway.setView('pending', view(secret, promote)) })
    expect(screen.queryByRole('button', { name: '以 B 为准' })).toBeNull()
    const notice = screen.getByRole('alert')
    expect(notice).toHaveTextContent(refused)
    // 留在冲突原来的位置：密钥卡之后、提升候选之前
    const [secretTitle, promoteTitle] = screen.getAllByRole('heading', { level: 3 })
    expect(secretTitle!.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notice.compareDocumentPosition(promoteTitle!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('最后一张卡也没了：提示留在空状态上面', async () => {
    const { gateway } = setup([horizontal], { respond: claimed })
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    await screen.findByRole('alert')
    act(() => { gateway.setView('pending', view()) })
    expect(screen.getByText('没有要处理的事')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(refused)
  })

  it.each([
    ['提升为全局', 'claimed', '这条适合所有项目'],
    ['留在本项目', 'not-found', '这条适合所有项目'],
    ['不再提醒', 'claimed', '带入的记忆超出上限'],
    ['以基线为准', 'not-found', '包管理器和基线矛盾'],
  ] as const)('「%s」回 %s：同样提示，卡消失后还在', async (button, code, title) => {
    const { gateway } = setup([vertical, promote, overflow], {
      respond: command => ({ ok: false, cmd: command.cmd, code, detail: `不存在或已处理：${'decisionId' in command ? command.decisionId : ''}` }),
    })
    fireEvent.click(screen.getByRole('button', { name: button }))
    const text = `你对「${title}」的选择没有生效：它正在别处处理，或者刚在别处处理完。`
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    act(() => { gateway.setView('pending', view()) })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('可以整理的叉「不再提醒」回 not-found（记忆已在别处删掉）：同样提示，不显示原话', async () => {
    const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 'bl', filePath: '/m/app/bl.md', digest: 'sha1:bl' })] }
    setup([bloat], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found', detail: '不存在或已处理：bl' }) })
    fireEvent.click(screen.getByRole('button', { name: '不再提醒' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('你对「内容过长」的选择没有生效：它正在别处处理，或者刚在别处处理完。')
    expect(screen.queryByText(/不存在或已处理/)).toBeNull()
  })

  it('放错层「提升为全局」回 not-found（别处已提升或删掉）：同样提示，不显示原话', async () => {
    const misplaced: PendingItem = { kind: 'advice', level: 'advice', type: 'misplaced', memories: [memory({ id: 'mu', filePath: '/m/app/mu.md', digest: 'sha1:mu' })] }
    const { gateway } = setup([misplaced], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found', detail: '不存在或已处理：mu' }) })
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    const text = '你对「放错层」的选择没有生效：它正在别处处理，或者刚在别处处理完。'
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(screen.queryByText(/不存在或已处理/)).toBeNull()
    act(() => { gateway.setView('pending', view()) })
    expect(screen.getByRole('alert')).toHaveTextContent(text)
  })

  it('结果卡上的撤销碰上别处正在处理（claimed）：结果卡不动，上面写明没有生效', async () => {
    const respond = (command: MemoryCommand) => command.cmd === 'undo' ? claimed(command) : { ok: true as const, cmd: command.cmd }
    setup([horizontal], { respond })
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(refused)
    expect(screen.getByText('已按 A')).toBeInTheDocument()
  })

  it('之后在任一张卡上做成了一件事：提示收起', async () => {
    let calls = 0
    const respond = (command: MemoryCommand) => { calls += 1; return calls === 1 ? claimed(command) : { ok: true as const, cmd: command.cmd } }
    setup([horizontal, promote], { respond })
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    await screen.findByText('已提升为全局')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('待处理：跨项目先确认', () => {
  it('服务端拒（cross-workspace）→ 卡片里写明项目、什么都没动；「继续处理」带 allowCrossWorkspace 重发；「取消」不重发', async () => {
    let calls = 0
    const respond = (command: MemoryCommand) => {
      calls += 1
      return calls === 1 || !('allowCrossWorkspace' in command && command.allowCrossWorkspace)
        ? { ok: false as const, cmd: command.cmd, code: 'cross-workspace' as const, rejected: [{ id: 'a', workspacePath: '/w/blog' }] }
        : { ok: true as const, cmd: command.cmd }
    }
    const { commands } = setup([horizontal], { respond })
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    expect(await screen.findByText('这条记忆属于 blog 项目，不是当前项目。确定在这里处理它吗？')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '以 B 为准' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText(/属于 blog 项目/)).toBeNull()
    expect(commands()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    fireEvent.click(await screen.findByRole('button', { name: '继续处理' }))
    await screen.findByText('已按 A')
    expect(commands()).toEqual([
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' },
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' },
      { cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left', allowCrossWorkspace: true },
    ])
  })
})

describe('待处理：确认收起后的键盘焦点', () => {
  /** 键盘用户按回车：焦点先落在按钮上再触发点击。 */
  const press = async (button: HTMLElement) => {
    button.focus()
    await act(async () => { fireEvent.click(button) })
  }

  it('不用确认的动作：卡片换成结果卡后焦点落到结果卡的「撤销」', async () => {
    setup([promote])
    await press(screen.getByRole('button', { name: '提升为全局' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
  })

  it('视图先于命令结果刷新（宿主先推了新版本）：卡片留在原位、焦点不动，结果回来后换成结果卡，焦点落到「撤销」', async () => {
    let answer: (() => void) | undefined
    const { gateway } = setup([promote, vertical], {
      respond: command => new Promise((resolve) => { answer = () => { resolve({ ok: true, cmd: command.cmd }) } }),
    })
    const button = screen.getByRole('button', { name: '提升为全局' })
    await press(button)
    act(() => { gateway.setView('pending', view(vertical)) })
    expect(button).toHaveFocus()
    expect(screen.getByRole('heading', { level: 2, name: '等你决定 2' })).toBeInTheDocument()
    await act(async () => { answer?.() })
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('撤销')
  })

  it('密钥卡：「取消」回到「彻底删除…」；确认删除后落到原位的结果卡上', async () => {
    setup([secret, promote])
    await press(screen.getByRole('button', { name: '彻底删除…' }))
    await press(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '彻底删除…' })).toHaveFocus() })

    await press(screen.getByRole('button', { name: '彻底删除…' }))
    await press(screen.getByRole('button', { name: '彻底删除' }))
    const result = (await screen.findByText('如果它是真的凭证，记得去换一个新的。')).closest('article')
    await waitFor(() => { expect(result).toHaveFocus() })
  })

  it('跨项目确认：「取消」回到裁决按钮；「继续处理」裁决完落到结果卡的「撤销」', async () => {
    const respond = (command: MemoryCommand) => 'allowCrossWorkspace' in command && command.allowCrossWorkspace
      ? { ok: true as const, cmd: command.cmd }
      : { ok: false as const, cmd: command.cmd, code: 'cross-workspace' as const, rejected: [{ id: 'a', workspacePath: '/w/blog' }] }
    setup([horizontal], { respond })
    const keepA = screen.getByRole('button', { name: '以 A 为准' })
    await press(keepA)
    await press(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(keepA).toHaveFocus() })

    await press(keepA)
    await press(screen.getByRole('button', { name: '继续处理' }))
    await screen.findByText('已按 A')
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
  })
})

describe('待处理：两态与空状态', () => {
  it('没有会话：读不到视图，提示先开会话', () => {
    const gateway = createFakeGateway({ session: { kind: 'none' }, config, views: { pending: view(horizontal) } })
    renderInShell(<PendingTab nav={createNavStore()} session={{ kind: 'none' }} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('开一个会话后这里可用')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('有结果卡时会话没了：撤销不可用并提示「先开一个会话」', async () => {
    // 和页面一样从网关借会话
    function Tab() {
      return <PendingTab nav={createNavStore()} session={useGateway().useSession('/w/app')} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} />
    }
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(horizontal), health: scannedHealth(NOW) } })
    renderInShell(<Tab />, gateway)
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    await screen.findByText('已按 A')
    act(() => { gateway.setSession({ kind: 'none' }) })
    const undo = screen.getByRole('button', { name: '撤销' })
    expect(undo).toHaveAttribute('aria-disabled', 'true')
    expect(undo).toHaveAttribute('title', '先开一个会话')
    fireEvent.click(undo)
    expect(gateway.executed.map(e => e.command.cmd)).toEqual(['resolve'])
  })

  it('三组都空：「没有要处理的事」加上次体检时间，不画组标题，没有体检按钮', () => {
    setup([], { views: { pending: view(), health: scannedHealth(new Date(2026, 9, 15, 9).getTime()) } })
    expect(screen.getByRole('status')).toHaveTextContent('没有要处理的事')
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 15 日。新的冲突和建议会出现在这里。')
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('三组都空、从没体检过：写「还没体检过」，不提体检按钮，也不放按钮', () => {
    setup([], { views: { pending: view(), health: scannedHealth(null) } })
    expect(screen.getByRole('status')).toHaveTextContent('没有要处理的事')
    expect(screen.getByRole('status')).toHaveTextContent('还没体检过。新的冲突和建议会出现在这里。')
    expect(screen.getByRole('status')).not.toHaveTextContent('体检当前项目')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('上次体检按选中的范围取：项目范围只看那个项目，「全部」取最近一次', () => {
    const layer = (l: HealthView['layers'][number]['layer'], at: number | null): HealthView['layers'][number] => ({
      layer: l, totalMemories: 1, score: 1, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0, lastCheckupAt: at, overflow: null, ignored: [],
      deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } },
    })
    const health: HealthView = {
      version: GUI_VIEW_VERSION,
      governanceEnabled: true,
      layers: [layer({ kind: 'global' }, new Date(2026, 9, 16, 9).getTime()), layer({ kind: 'workspace', workspacePath: '/w/app' }, new Date(2026, 9, 3, 9).getTime())],
    }
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(), health } })
    const { unmount } = renderInShell(<PendingTab nav={createNavStore()} session={SESSION} scope={{ kind: 'workspace', workspacePath: '/w/app' }} workspacePath="/w/app" now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 3 日')
    unmount()
    renderInShell(<PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('上次体检 10 月 16 日')
  })

  it('配置文件关掉体检：写明在配置文件里关闭，没有可点的东西（界面上不提供打开体检）', () => {
    setup([], { views: { pending: view(), health: { ...scannedHealth(NOW), governanceEnabled: false } } }, createNavStore(undefined, { openSettings: vi.fn() }))
    expect(screen.getByRole('status')).toHaveTextContent('体检已在配置文件里关闭')
    expect(screen.getByRole('status')).toHaveTextContent('governance.enabled')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('体检开关以健康视图为准（和健康 tab、页头一致），不看插件配置', () => {
    setup([], { config: { ...config, governanceEnabled: false } })
    expect(screen.getByRole('status')).not.toHaveTextContent('体检已在配置文件里关闭')
  })
})

// 入口带记忆 id 打开待处理：含这条记忆的卡（冲突任一方、提升候选、密钥）滚入视野并高亮一次。
describe('待处理：直达某条记忆', () => {
  const scrollIntoView = vi.fn()
  beforeEach(() => { vi.useFakeTimers(); scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
  afterEach(() => { vi.useRealTimers(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })
  const cardOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('.pm-pending-row')!

  it('记忆在横向冲突的 B 方：那张冲突卡高亮并滚入视野，播完收起', () => {
    const nav = createNavStore({ view: 'todo', memoryId: 'b' })
    setup([vertical, horizontal, promote], {}, nav)
    const row = cardOf('测试里怎么准备数据库，两条记忆互相矛盾')
    expect(row).toHaveClass('pm-flash')
    expect(document.querySelectorAll('.pm-flash')).toHaveLength(1)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(row)
    act(() => { vi.advanceTimersByTime(FLASH_MS) })
    expect(row).not.toHaveClass('pm-flash')
  })

  it('提升候选、垂直冲突、密钥都认它们那条记忆；入口换一条再高亮一次', () => {
    const nav = createNavStore({ view: 'todo', memoryId: 'p' })
    setup([secret, vertical, promote], {}, nav)
    expect(cardOf('这条适合所有项目')).toHaveClass('pm-flash')
    act(() => { nav.navigate({ view: 'todo', memoryId: 'v' }) })
    expect(cardOf('包管理器和基线矛盾')).toHaveClass('pm-flash')
    act(() => { nav.navigate({ view: 'todo', memoryId: 's' }) })
    expect(cardOf('这条记忆里有密钥')).toHaveClass('pm-flash')
  })

  it('目标不在待处理里：不高亮、不滚动', () => {
    setup([horizontal], {}, createNavStore({ view: 'todo', memoryId: 'nope' }))
    expect(document.querySelector('.pm-flash')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})

// 健康页「去处理 ›」带组标识进来：焦点落在那一组的标题上并滚入视野；组已经没有了（处理完）就落在待处理顶部。
describe('待处理：定位到组', () => {
  const scrollIntoView = vi.fn()
  beforeEach(() => { scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
  afterEach(() => { delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })
  const advice: PendingItem = { kind: 'advice', level: 'advice', type: 'expired', memories: [memory({ id: 'e1', validTo: NOW - 1 })] }
  const top = () => document.querySelector('.pm-pending')

  it('三组各自能定位：焦点在组标题上，标题滚入视野', () => {
    for (const [level, heading] of [['must-fix', '先处理 1'], ['your-call', '等你决定 1'], ['advice', '可以整理 1']] as const) {
      const { unmount } = setup([secret, horizontal, advice], {}, createNavStore({ view: 'todo', level }))
      const title = screen.getByRole('heading', { level: 2, name: heading })
      expect(title).toHaveFocus()
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(title)
      unmount()
    }
  })

  it('那一组已经没有了：焦点落在待处理顶部', () => {
    setup([secret, advice], {}, createNavStore({ view: 'todo', level: 'your-call' }))
    expect(top()).toHaveFocus()
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(top())
  })

  it('待处理全空：同样落在顶部（空状态在里面）', () => {
    setup([], {}, createNavStore({ view: 'todo', level: 'advice' }))
    expect(top()).toHaveFocus()
    expect(top()).toHaveTextContent('没有要处理的事')
  })

  it('视图晚到：到了再定位', () => {
    const nav = createNavStore({ view: 'todo', level: 'advice' })
    const { gateway } = setup([], { views: { pending: { status: 'loading' }, health: scannedHealth(NOW) } }, nav)
    expect(document.body).toHaveFocus()
    act(() => { gateway.setView('pending', view(secret, advice)) })
    expect(screen.getByRole('heading', { level: 2, name: '可以整理 1' })).toHaveFocus()
  })

  it('只定位一次：视图刷新不再抢焦点；不带组标识进来不动焦点', () => {
    const nav = createNavStore({ view: 'todo', level: 'advice' })
    const { gateway } = setup([secret, advice], {}, nav)
    const ignore = screen.getByRole('button', { name: '不再提醒' })
    ignore.focus()
    act(() => { gateway.setView('pending', view(secret, horizontal, advice)) })
    expect(ignore).toHaveFocus()
    act(() => { nav.update({ view: 'todo' }) })
    expect(ignore).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})

// —— 键盘（故事 50）：裁决、提升、删除都是原生 button，能 Tab 到；焦点环用宿主令牌（见 ui/basics.spec 的主题检查） ——

describe('键盘', () => {
  it('裁决 / 提升 / 删除控件都是原生 button，不在 Tab 序列外', () => {
    setup([secret, horizontal, vertical, promote])
    const names = ['以 A 为准', '以 B 为准', '都保留', '以基线为准', '保留这条记忆', '提升为全局', '留在本项目', '彻底删除…']
    for (const name of names) {
      const button = screen.getByRole('button', { name })
      expect(button.tagName).toBe('BUTTON')
      expect(button).not.toBeDisabled()
      expect(button.tabIndex).toBe(0)
      button.focus()
      expect(document.activeElement).toBe(button)
    }
  })
})

// —— 可以整理（spec「可以整理的动作」）：卡片不着色、动作按问题类型；删除走 forget，含密钥改走彻底删除确认 ——

describe('待处理：可以整理', () => {
  const advice = (type: AdviceType, id: string, overrides: Partial<MemoryCard> = {}): PendingItem => ({
    kind: 'advice', level: 'advice', type, memories: [memory({ id, name: `记忆 ${id}`, filePath: `/m/app/${id}.md`, digest: `sha1:${id}`, ...overrides })],
  })
  const expired = advice('expired', 'e1', { validTo: NOW - 1 })
  const stale = advice('stale', 's1', { lastConfirmedAt: new Date(2026, 5, 1).getTime() })
  const bloat = advice('bloat', 'b1')
  const orphan = advice('orphan', 'o1')
  const baselineDup = advice('redundancy', 'rb')
  const toGlobal = advice('misplaced', 'mu')
  const toProject = advice('misplaced', 'md', { scope: 'global', workspacePath: undefined, filePath: '/m/global/md.md' })
  const unclear = advice('unclear', 'u1')
  const duplicates = [
    memory({ id: 'r1', content: '左边的内容。', filePath: '/m/app/r1.md', digest: 'sha1:r1' }),
    memory({ id: 'r2', content: '右边的内容。', filePath: '/m/app/r2.md', digest: 'sha1:r2' }),
  ]
  const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: duplicates }
  const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
  const groupOf = () => screen.getByRole('region', { name: /^可以整理/ })
  const cardOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('article')!
  /** 原位确认里的「删除」。 */
  const confirmIn = (scope: HTMLElement) => within(within(scope).getByRole('group', { name: '删除这条？' })).getByRole('button', { name: '删除' })

  it('可以整理组排在最后，组名带条数；卡片不着色、不带状态标记', () => {
    setup([secret, horizontal, expired, stale, bloat, orphan])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['先处理 1', '等你决定 1', '可以整理 4'])
    expect(within(groupOf()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      '已过有效期', '很久没确认', '内容过长', '指向的旧记忆已不在',
    ])
    expect(groupOf().querySelector('.pm-marker')).toBeNull()
  })

  // 动作行：退一步的幽灵按钮（「忽略」「打开文件」）排在最左，推荐的在最右
  it.each([
    ['已过有效期', expired, true, ['打开文件', '删除']],
    ['很久没确认', stale, false, ['打开文件', '删除', '仍然有效']],
    ['内容过长', bloat, true, ['打开文件', '直接改', '让模型改']],
    ['指向的旧记忆已不在', orphan, true, ['打开文件']],
    ['内容重复', baselineDup, true, ['打开文件', '删除']],
    ['放错层', toGlobal, true, ['打开文件', '提升为全局']],
    ['放错层', toProject, true, ['打开文件', '移到项目…']],
    ['表述不清', unclear, true, ['打开文件', '直接改', '让模型改']],
  ] as const)('%s：动作行按 spec 表；能忽略的在标题行右上角放叉「不再提醒」', (title, item, isDismissible, buttons) => {
    setup([item])
    expect(cardOf(title).querySelector(`[data-memory-id="${item.kind === 'advice' ? item.memories[0]!.id : ''}"]`)).not.toBeNull()
    const row = cardOf(title).querySelector('.pm-pending-actions')!
    expect([...row.querySelectorAll('button')].map(b => b.textContent)).toEqual([...buttons])
    const dismiss = cardOf(title).querySelector('.pm-pending-head .pm-dismiss')
    expect(dismiss === null ? null : dismiss.getAttribute('aria-label')).toBe(isDismissible ? '不再提醒' : null)
    for (const b of row.querySelectorAll('button')) {
      expect(b.classList.contains('pm-btn--ghost')).toBe(b.textContent === '打开文件')
      expect(b.classList.contains('pm-btn--quiet')).toBe(false)
    }
  })

  it('叉「不再提醒」发 ignore-advice（类型 + 每条记忆的层和卡片版本），原位换成结果卡；撤销发 unignore-advice，撤销后回到原卡片', async () => {
    const { gateway, commands } = setup([bloat])
    fireEvent.click(within(cardOf('内容过长')).getByRole('button', { name: '不再提醒' }))
    await screen.findByText('不再扣分；内容改了会重新提醒。')
    expect(screen.getByText('不再扣分；内容改了会重新提醒。').closest('article')).toHaveTextContent('不再提醒')
    // 视图重写后这一项不在了，结果卡照旧留在原位
    act(() => { gateway.setView('pending', view()) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    const base = { updatedAt: bloat.kind === 'advice' ? bloat.memories[0]!.updatedAt : 0, digest: 'sha1:b1' }
    expect(commands()).toEqual([
      { cmd: 'ignore-advice', type: 'bloat', memories: [{ memoryId: 'b1', layer, base }] },
      { cmd: 'unignore-advice', type: 'bloat', memoryIds: ['b1'] },
    ])
    act(() => { gateway.setView('pending', view(bloat)) })
    expect(within(cardOf('内容过长')).getByRole('button', { name: '不再提醒' })).toBeInTheDocument()
    expect(screen.queryByText('不再扣分；内容改了会重新提醒。')).toBeNull()
  })

  it('内容重复的一对：两侧动作行都是「打开文件」（幽灵）在左、删除在右', () => {
    setup([pair])
    const sides = [...cardOf('内容重复').querySelectorAll('.pm-pending-advice-side .pm-pending-actions')]
    expect(sides.map(row => [...row.querySelectorAll('button')].map(b => b.textContent))).toEqual([
      ['打开文件', '删除左边'], ['打开文件', '删除右边'],
    ])
  })

  it('内容重复的一组：标题行右上角一个叉「不再提醒」，带上整组的记忆 id', async () => {
    const { commands } = setup([pair])
    const ignore = within(cardOf('内容重复')).getByRole('button', { name: '不再提醒' })
    expect(ignore).toHaveClass('pm-dismiss')
    expect(ignore.closest('.pm-pending-head')).not.toBeNull()
    fireEvent.click(ignore)
    await screen.findByText('不再扣分；内容改了会重新提醒。')
    expect(commands()).toEqual([{ cmd: 'ignore-advice', type: 'redundancy', memories: duplicates.map(m => ({ memoryId: m.id, layer, base: { updatedAt: m.updatedAt, digest: m.digest } })) }])
  })

  it('说明按情形写：和指令文件重复、该放全局、只和项目有关、表述不清、内容过长', () => {
    setup([baselineDup, toGlobal, toProject, unclear, bloat])
    for (const text of [
      '指令文件（AGENTS.md 等）里已经写了同样的内容，这条可以删掉。删除后 14 天内可在「最近删除」恢复。',
      '这条看起来对所有项目都适用，现在只放在一个项目里。提升为全局后所有项目都会带入它，14 天内可撤销。',
      '这条看起来只和某个项目有关，放在全局会被带进每个项目的对话。移到项目后只在那个项目里带入，14 天内可撤销。',
      '换一个没有上下文的新对话，agent 很难照这条去做。把缺的背景、对象或条件写清楚。原文没写的背景，模型补不上，要你写给它。',
      '内容很长，带入对话时占用较多。精简成要点更好。',
    ]) expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('内容重复的两条在同一张卡上左右并排，各自「删除左边 / 删除右边」「打开文件」；删除发 forget（带层）', async () => {
    const { gateway, commands } = setup([pair])
    const card = cardOf('内容重复')
    expect(screen.getByText('两条说的是同一件事，留一条就够。删掉的那条 14 天内可在「最近删除」恢复。')).toBeInTheDocument()
    const left = within(card).getByRole('region', { name: '左边这条' })
    const right = within(card).getByRole('region', { name: '右边这条' })
    expect(within(left).getByText('左边的内容。')).toBeInTheDocument()
    expect(within(right).getByText('右边的内容。')).toBeInTheDocument()
    expect(within(card).getAllByRole('button').map(b => b.textContent)).toEqual(['不再提醒', '打开文件', '删除左边', '打开文件', '删除右边', '直接合并', '让模型合并'])
    for (const b of card.querySelectorAll('.pm-btn')) expect(b.classList.contains('pm-btn--ghost')).toBe(b.textContent === '打开文件')

    await act(async () => { fireEvent.click(within(right).getByRole('button', { name: '打开文件' })) })
    expect(gateway.opened).toEqual([{ path: '/m/app/r2.md' }])
    fireEvent.click(within(right).getByRole('button', { name: '删除右边' }))
    expect(commands()).toEqual([])
    fireEvent.click(confirmIn(right))
    await screen.findByText('已删除')
    expect(commands()).toEqual([{ cmd: 'forget', memoryId: 'r2', layer }])
  })

  it('三条以上互相重复：每条一栏，按钮写「删除」，栏名是记忆名', async () => {
    const { commands } = setup([{ kind: 'advice', level: 'advice', type: 'redundancy', memories: [...duplicates, memory({ id: 'r3', name: '第三条' })] }])
    const card = cardOf('内容重复')
    expect(screen.getByText('这几条说的是同一件事，留一条就够。删掉的 14 天内可在「最近删除」恢复。')).toBeInTheDocument()
    expect(within(card).getAllByRole('button').map(b => b.textContent)).toEqual(['不再提醒', '打开文件', '删除', '打开文件', '删除', '打开文件', '删除'])
    const third = within(card).getByRole('region', { name: '第三条' })
    fireEvent.click(within(third).getByRole('button', { name: '删除' }))
    fireEvent.click(confirmIn(third))
    await screen.findByText('已删除')
    expect(commands()).toEqual([{ cmd: 'forget', memoryId: 'r3', layer }])
  })

  it('内容重复删掉的那条含密钥：原位改问彻底删除，「彻底删除」发 hard-delete 删的还是那一条', async () => {
    const { commands } = setup([pair], {
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret' }
        : { ok: true, cmd: command.cmd, memoryIds: ['r1'] },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除左边' })) })
    await act(async () => { fireEvent.click(confirmIn(cardOf('内容重复'))) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
    await screen.findByText('已彻底删除')
    expect(commands()).toEqual([{ cmd: 'forget', memoryId: 'r1', layer }, { cmd: 'hard-delete', memoryId: 'r1', layer }])
  })

  it('放错层（项目 → 全局）：「提升为全局」按记忆 id 发 promote-memory（带层），结果可撤销，撤销发 undo', async () => {
    const { commands } = setup([toGlobal], {
      respond: command => command.cmd === 'promote-memory'
        ? { ok: true, cmd: command.cmd, decisionId: 'pd_m', memoryIds: ['mu'], snapshotId: 'snap_1' }
        : { ok: true, cmd: command.cmd },
    })
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    await screen.findByText('已提升为全局')
    expect(screen.getByText('所有项目都会带入它，14 天内可撤销。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands()).toEqual([{ cmd: 'promote-memory', memoryId: 'mu', layer }, { cmd: 'undo', decisionId: 'pd_m' }])
  })

  it('「仍然有效」发 confirm（带这条记忆的层），原位换成结果卡', async () => {
    const { commands } = setup([stale])
    fireEvent.click(screen.getByRole('button', { name: '仍然有效' }))
    await screen.findByText('已确认仍然有效')
    expect(commands()).toEqual([{ cmd: 'confirm', memoryId: 's1', layer }])
    expect(screen.getByText('确认时间已更新，这条不再算作很久没确认。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('「删除」先原位确认，点确认里的「删除」才发 forget（带层），结果写可在最近删除恢复', async () => {
    const { commands } = setup([expired])
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(commands()).toEqual([])
    fireEvent.click(confirmIn(cardOf('已过有效期')))
    await screen.findByText('已删除')
    expect(commands()).toEqual([{ cmd: 'forget', memoryId: 'e1', layer }])
    expect(screen.getByText('14 天内可在「最近删除」恢复。')).toBeInTheDocument()
  })

  it('删除后结果行可撤销：撤销发 restore（带层），卡片回来、按钮照旧', async () => {
    const { gateway, commands } = setup([expired, pair])
    fireEvent.click(within(cardOf('已过有效期')).getByRole('button', { name: '删除' }))
    fireEvent.click(confirmIn(cardOf('已过有效期')))
    await screen.findByText('已删除')
    act(() => { gateway.setView('pending', view(pair)) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(within(cardOf('已过有效期')).getByRole('button', { name: '删除' })).toBeInTheDocument()
    // 成对的那张删右边：撤销恢复的是右边那条
    fireEvent.click(screen.getByRole('button', { name: '删除右边' }))
    fireEvent.click(confirmIn(within(cardOf('内容重复')).getByRole('region', { name: '右边这条' })))
    await screen.findByText('已删除')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands()).toEqual([
      { cmd: 'forget', memoryId: 'e1', layer },
      { cmd: 'restore', memoryId: 'e1', layer },
      { cmd: 'forget', memoryId: 'r2', layer },
      { cmd: 'restore', memoryId: 'r2', layer },
    ])
  })

  it('删除含密钥的记忆：forget 回 has-secret（什么都没动），原位出现彻底删除确认；取消不发，「彻底删除」发 hard-delete', async () => {
    const { commands } = setup([stale], {
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret', detail: '记忆 s1 含密钥，删除后不可恢复，未做任何改动' }
        : { ok: true, cmd: command.cmd, memoryIds: ['s1'] },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })) })
    await act(async () => { fireEvent.click(confirmIn(cardOf('很久没确认'))) })
    const card = cardOf('很久没确认')
    expect(within(card).getByText('这条记忆里有密钥')).toBeInTheDocument()
    expect(within(card).getByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '删除' })).toHaveAttribute('aria-disabled', 'true')
    expect(within(card).queryByText(/记忆 s1 含密钥/)).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(within(card).queryByText('这条记忆里有密钥')).toBeNull()

    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '删除' })) })
    await act(async () => { fireEvent.click(confirmIn(card)) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
    await screen.findByText('已彻底删除')
    expect(commands()).toEqual([
      { cmd: 'forget', memoryId: 's1', layer },
      { cmd: 'forget', memoryId: 's1', layer },
      { cmd: 'hard-delete', memoryId: 's1', layer },
    ])
  })

  // 三个场景各自一例：合在一个用例里单例耗时贴着 5 秒上限
  it.each([
    ['删除', () => cardOf('已过有效期')],
    ['删除左边', () => within(cardOf('内容重复')).getByRole('region', { name: '左边这条' })],
    ['删除右边', () => within(cardOf('内容重复')).getByRole('region', { name: '右边这条' })],
  ] as const)('建议卡的「%s」：第一下不发命令，原位换成「删除这条？ 删除 · 取消」；「取消」、Esc 都收起，什么都不发', (name, scopeOf) => {
    const { commands } = setup([expired, pair])
    const scope = scopeOf()
    fireEvent.click(within(scope).getByRole('button', { name }))
    const confirm = within(within(scope).getByRole('group', { name: '删除这条？' }))
    expect(confirm.getAllByRole('button').map(b => b.textContent)).toEqual(['删除', '取消'])
    expect(confirm.getByRole('button', { name: '取消' })).toHaveFocus()
    fireEvent.click(confirm.getByRole('button', { name: '取消' }))
    expect(within(scope).queryByRole('group', { name: '删除这条？' })).toBeNull()
    fireEvent.click(within(scope).getByRole('button', { name }))
    fireEvent.keyDown(within(scope).getByRole('button', { name: '取消' }), { key: 'Escape' })
    expect(within(scope).queryByRole('group', { name: '删除这条？' })).toBeNull()
    expect(within(scope).getByRole('button', { name })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('建议卡的删除确认：焦点移到别的控件、在确认区外按下指针都收起，什么都不发', () => {
    const { commands } = setup([expired, bloat])
    const card = cardOf('已过有效期')
    fireEvent.click(within(card).getByRole('button', { name: '删除' }))
    const other = within(cardOf('内容过长')).getByRole('button', { name: '打开文件' })
    fireEvent.blur(within(card).getByRole('button', { name: '取消' }), { relatedTarget: other })
    expect(within(card).queryByRole('group', { name: '删除这条？' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '删除' }))
    fireEvent.pointerDown(cardOf('内容过长'))
    expect(within(card).queryByRole('group', { name: '删除这条？' })).toBeNull()
    expect(commands()).toEqual([])
  })

  it('「打开文件」打开这条记忆的文件；打不开时卡片里说明', async () => {
    const { gateway } = setup([bloat], { openOk: false })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开文件' })) })
    expect(gateway.opened).toEqual([{ path: '/m/app/b1.md' }])
    expect(within(cardOf('内容过长')).getByRole('alert')).toHaveTextContent('没能打开文件。')
  })

  it('组内先显示 5 条，其余收进「展开其余 N 条」；点开后全部显示、按钮收起', () => {
    const many = Array.from({ length: 7 }, (_, i) => advice('bloat', `b${i}`))
    setup(many)
    expect(within(groupOf()).getAllByRole('article')).toHaveLength(5)
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['可以整理 7'])
    fireEvent.click(screen.getByRole('button', { name: '展开其余 2 条' }))
    expect(within(groupOf()).getAllByRole('article')).toHaveLength(7)
    expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
  })

  it('只折叠可以整理：等你决定超过 5 条也全部显示', () => {
    const conflicts = Array.from({ length: 6 }, (_, i) => ({ ...horizontal, decisionId: `d${i}`, summary: `冲突 ${i}` }) as PendingItem)
    setup(conflicts)
    expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
    expect(screen.getByText('冲突 5')).toBeInTheDocument()
  })

  it('直达的记忆在折叠里：这一组自动展开，那张卡高亮', () => {
    Element.prototype.scrollIntoView = vi.fn()
    try {
      const many = Array.from({ length: 7 }, (_, i) => advice('bloat', `b${i}`))
      setup(many, {}, createNavStore({ view: 'todo', memoryId: 'b6' }))
      expect(within(groupOf()).getAllByRole('article')).toHaveLength(7)
      expect(document.querySelector('[data-memory-id="b6"]')!.closest('.pm-pending-row')).toHaveClass('pm-flash')
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})

describe('可以整理：不再提醒的条目', () => {
  const healthLayer = (layer: HealthView['layers'][number]['layer'], ignored: HealthView['layers'][number]['ignored']): HealthView['layers'][number] => ({
    layer, totalMemories: 3, score: 90, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0, lastCheckupAt: NOW, overflow: null, ignored,
    deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } },
  })
  const app = { kind: 'workspace', workspacePath: '/w/app' } as const
  const health: HealthView = {
    version: GUI_VIEW_VERSION,
    governanceEnabled: true,
    layers: [
      healthLayer({ kind: 'global' }, [{ type: 'unclear', memories: [{ id: 'g1', name: '模糊那条', summary: '' }] }]),
      healthLayer(app, [
        { type: 'bloat', memories: [{ id: 'i1', name: '太长那条', summary: '' }] },
        { type: 'redundancy', memories: [{ id: 'i2', name: '甲', summary: '' }, { id: 'i3', name: '乙', summary: '' }] },
      ]),
    ],
  }
  function render(items: PendingItem[], scope: PageScope) {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(...items), health } })
    renderInShell(<PendingTab nav={createNavStore()} session={SESSION} scope={scope} workspacePath={scope.kind === 'workspace' ? scope.workspacePath : undefined} now={NOW} />, gateway)
    return { gateway, commands: () => gateway.executed.map(e => e.command) }
  }
  const ignoredList = () => screen.getByRole('list', { name: /^不再提醒的/ })

  it('「可以整理」组底部一行「不再提醒的 N 条 查看」，默认收起；只算这个范围的', () => {
    render([tidy], app)
    const group = screen.getByRole('region', { name: /^可以整理/ })
    expect(within(group).getByText('不再提醒的 2 条')).toBeInTheDocument()
    const toggle = within(group).getByRole('button', { name: '查看' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: /^不再提醒的/ })).toBeNull()
    // 在组里最后
    expect(group.lastElementChild).toContainElement(toggle)
  })

  it('展开逐条写问题类型和记忆名，每条「恢复提醒」发 unignore-advice（类型 + 全部记忆 id）', async () => {
    const { commands } = render([tidy], app)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
    const rows = within(ignoredList()).getAllByRole('listitem')
    expect(rows.map(r => r.textContent)).toEqual(['内容过长 · 太长那条恢复提醒', '内容重复 · 甲 · 乙恢复提醒'])
    await act(async () => { fireEvent.click(within(rows[1]!).getByRole('button', { name: '恢复提醒' })) })
    expect(commands()).toEqual([{ cmd: 'unignore-advice', type: 'redundancy', memoryIds: ['i2', 'i3'] }])
  })

  it('「全部」里列所有范围的，每条带范围胶囊', () => {
    render([tidy], ALL_SCOPE)
    expect(screen.getByText('不再提醒的 3 条')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    const rows = within(ignoredList()).getAllByRole('listitem')
    expect(rows.map(r => r.querySelector('.pm-chip')?.textContent)).toEqual(['全局', 'app', 'app'])
  })

  it('选了具体范围不带范围胶囊', () => {
    render([tidy], app)
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(ignoredList().querySelector('.pm-chip')).toBeNull()
  })

  it('这个范围没有忽略过：不画这一行', () => {
    render([tidy], { kind: 'workspace', workspacePath: '/w/other' })
    expect(screen.queryByText(/^不再提醒的/)).toBeNull()
  })

  it('没有可以整理的条目、别的组有：「可以整理」组只画「不再提醒的 N 条」这一行', () => {
    render([horizontal], app)
    const group = screen.getByRole('region', { name: /^可以整理/ })
    expect(within(group).getByText('不再提醒的 2 条')).toBeInTheDocument()
    expect(within(group).queryByRole('article')).toBeNull()
  })

  it('三组都空：照常是空状态，「不再提醒的 N 条」跟在下面', () => {
    render([], app)
    expect(screen.getByRole('status')).toHaveTextContent('没有要处理的事')
    expect(screen.getByText('不再提醒的 2 条')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })
})

describe('待处理：直接改与直接合并', () => {
  const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
  const long = `发版流程：${'先跑测试再打包，'.repeat(30)}`
  const target = memory({ id: 'b1', name: '发版流程', type: 'project', content: long, summary: '发版的步骤', tags: ['发版', 'npm'], digest: 'sha1:b1', updatedAt: 111, filePath: '/m/app/b1.md' })
  const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [target] }
  const stale: PendingItem = { kind: 'advice', level: 'advice', type: 'stale', memories: [memory({ id: 's9', name: '很久的', digest: 'sha1:s9' })] }
  const base = { updatedAt: 111, digest: 'sha1:b1' }
  const edited = { ok: true as const, cmd: 'edit-memory', decisionId: 'pd_e', memoryIds: ['b1'], snapshotId: 'snap_e', filePath: '/m/app/release.md' }
  const respondEdit = (command: MemoryCommand): MemoryCommandResult => (command.cmd === 'edit-memory' ? edited : { ok: true, cmd: command.cmd })
  const startEdit = () => { fireEvent.click(screen.getByRole('button', { name: '直接改' })) }
  const save = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) }) }

  it('点「直接改」：正文变成预填的编辑框，原来的按钮行收起；保存发 edit-memory（带层和卡片版本），名称、摘要、标签照原样', async () => {
    const { commands } = setup([bloat], { respond: respondEdit })
    startEdit()
    const box = screen.getByRole('textbox', { name: '正文' })
    expect(box).toHaveValue(long)
    expect(screen.queryByRole('button', { name: '打开文件' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '名称' })).toBeNull()
    expect(screen.getByRole('button', { name: '取消' })).toHaveClass('pm-btn--ghost')
    expect(screen.getByRole('button', { name: '保存' })).toHaveClass('pm-btn--primary')
    const next = '1. 跑测试\n2. 发版'
    fireEvent.change(box, { target: { value: next } })
    expect(screen.getByText(`${long.length} 字 → ${next.length} 字`)).toBeInTheDocument()
    await save()
    expect(commands()).toEqual([{ cmd: 'edit-memory', memoryId: 'b1', layer, base, content: next, name: '发版流程', summary: '发版的步骤', tags: ['发版', 'npm'] }])
  })

  it('「更多」展开名称、摘要、标签，底部写明类型改不了；标签点 × 移除、回车添加（空的和重复的不加）；保存带上改过的三项', async () => {
    const { commands } = setup([bloat], { respond: respondEdit })
    startEdit()
    const more = screen.getByRole('button', { name: '更多' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(more)
    expect(screen.getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('类型改不了：换类型要先删再记')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '发版步骤' } })
    fireEvent.change(screen.getByRole('textbox', { name: '摘要' }), { target: { value: '发版前后的固定步骤' } })
    fireEvent.click(screen.getByRole('button', { name: '移除标签 npm' }))
    const tagInput = screen.getByRole('textbox', { name: '标签' })
    for (const value of ['release', '发版', '  ']) {
      fireEvent.change(tagInput, { target: { value } })
      fireEvent.keyDown(tagInput, { key: 'Enter' })
    }
    expect(screen.getByRole('button', { name: '移除标签 release' })).toBeInTheDocument()
    await save()
    expect(commands()).toEqual([{ cmd: 'edit-memory', memoryId: 'b1', layer, base, content: long, name: '发版步骤', summary: '发版前后的固定步骤', tags: ['发版', 'release'] }])
  })

  it('正文改了、摘要没动：提示摘要还是旧的，不挡保存；点「去改摘要」展开更多并聚焦摘要，改了摘要提示消失', () => {
    setup([bloat])
    startEdit()
    expect(screen.queryByText('正文改了，摘要还是旧的')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '短了' } })
    expect(screen.getByText('正文改了，摘要还是旧的')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('button', { name: '去改摘要' }))
    const summary = screen.getByRole('textbox', { name: '摘要' })
    expect(summary).toHaveFocus()
    fireEvent.change(summary, { target: { value: '新的摘要' } })
    expect(screen.queryByText('正文改了，摘要还是旧的')).toBeNull()
  })

  it('正文或名称清空：保存不可用；「取消」收起编辑框、回到原来的卡片，不发命令', () => {
    const { commands } = setup([bloat])
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('textbox', { name: '正文' })).toBeNull()
    expect(screen.getByRole('button', { name: '直接改' })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('保存后卡片收成一行「已修改 · 名称 · 字数变化」；打开文件打开写完后的文件，撤销发 undo，撤销后回到原卡片', async () => {
    const { commands, gateway } = setup([bloat], { respond: respondEdit })
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: '跑测试再发' } })
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: '发版步骤' } })
    await save()
    expect(screen.getByText('已修改')).toBeInTheDocument()
    expect(screen.getByText(`发版步骤 · ${long.length} 字 → 5 字`)).toBeInTheDocument()
    // 「撤销」和别的结果行一样 600
    expect(screen.getByRole('button', { name: '撤销' })).toHaveClass('pm-btn--ghost', 'pm-pending-undo')
    expect(screen.getByRole('button', { name: '打开文件' })).toHaveClass('pm-btn--secondary')
    expect(screen.queryByRole('textbox', { name: '正文' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开文件' })) })
    expect(gateway.opened).toEqual([{ path: '/m/app/release.md' }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'pd_e' })
    expect(await screen.findByRole('button', { name: '直接改' })).toBeInTheDocument()
  })

  it('含密钥的记忆不给「直接改」「直接合并」', () => {
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [memory({ id: 'x1', digest: 'sha1:x1', hasSecret: true }), memory({ id: 'x2', digest: 'sha1:x2' })] }
    setup([{ ...bloat, memories: [{ ...target, hasSecret: true }] }, pair])
    expect(screen.queryByRole('button', { name: '直接改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '直接合并' })).toBeNull()
  })

  it('新内容有高危密钥：卡片里写原因，编辑框留着可以接着改', async () => {
    setup([bloat], { respond: command => ({ ok: false, cmd: command.cmd, code: 'secret-critical', detail: '检测到高危密钥（sk- 系列密钥），未保存' }) })
    startEdit()
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。改写成不含密钥的说法再存。')
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toHaveAttribute('aria-disabled')
  })

  // 厂商形状的假密钥运行时拼接，源码里不出现完整字面量
  const criticalKey = 'sk-' + 'TESTONLY'.padEnd(24, 'a')

  it('新内容有高危密钥：本地就拦住，不发命令（命令文本会进借用会话的日志），提示同服务端拦下时', async () => {
    const { commands } = setup([bloat], { respond: respondEdit })
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: `发版用 ${criticalKey}` } })
    await save()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。改写成不含密钥的说法再存。')
    expect(screen.getByRole('textbox', { name: '正文' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toHaveAttribute('aria-disabled')
  })

  it('名称里有高危密钥：同样本地拦住，不发命令', async () => {
    const { commands } = setup([bloat], { respond: respondEdit })
    startEdit()
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.change(screen.getByRole('textbox', { name: '名称' }), { target: { value: criticalKey } })
    await save()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。')
  })

  it('新内容只是像密钥：照常发给服务端，由它回疑似再确认', async () => {
    const { commands } = setup([bloat], { respond: command => (command.cmd === 'edit-memory' && command.force !== true ? { ok: false, cmd: command.cmd, code: 'secret-suspected' } : edited) })
    startEdit()
    fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: 'password: abc12345' } })
    await save()
    expect(commands().map(c => c.cmd)).toEqual(['edit-memory'])
    expect(screen.getByText('内容里有像密钥的片段。确定不是密钥再保存。')).toBeInTheDocument()
  })

  it('新内容像密钥：卡片里再确认一次，「仍然保存」带 force 重发', async () => {
    const { commands } = setup([bloat], {
      respond: command => (command.cmd === 'edit-memory' && command.force !== true ? { ok: false, cmd: command.cmd, code: 'secret-suspected' } : edited),
    })
    startEdit()
    await save()
    expect(screen.getByText('内容里有像密钥的片段。确定不是密钥再保存。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '仍然保存' })) })
    await screen.findByText('已修改')
    expect(commands().map(c => c.cmd === 'edit-memory' && c.force)).toEqual([undefined, true])
  })

  it('记忆在卡片加载后被改过：写明刷新后再改', async () => {
    setup([bloat], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '这条记忆刚被改过' }) })
    startEdit()
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('这条记忆刚被改过，刷新后再改。')
  })

  it('保存中只锁这张卡：保存、取消置灰，别的卡照常可用', async () => {
    setup([bloat, stale], { respond: command => (command.cmd === 'edit-memory' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    startEdit()
    await save()
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '取消' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: '仍然有效' })).not.toHaveAttribute('aria-disabled')
  })

  it('同卡别的动作在进行：「直接改」置灰', async () => {
    setup([bloat], { respond: command => (command.cmd === 'ignore-advice' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提醒' })) })
    expect(screen.getByRole('button', { name: '直接改' })).toHaveAttribute('aria-disabled', 'true')
  })

  describe('直接合并', () => {
    const left = memory({ id: 'r1', name: '翻译腔', content: '避免翻译腔。', summary: '少翻译腔', tags: ['中文'], createdAt: 2, updatedAt: 21, digest: 'sha1:r1' })
    const right = memory({ id: 'r2', name: '被字句', content: '少用被字句。', summary: '少被字句', tags: ['写作', '中文'], createdAt: 1, updatedAt: 22, digest: 'sha1:r2' })
    const pairOf = (...memories: MemoryCard[]): PendingItem => ({ kind: 'advice', level: 'advice', type: 'redundancy', memories })
    const merged = { ok: true as const, cmd: 'merge-memories', decisionId: 'pd_m', memoryIds: ['r2', 'r1'], snapshotId: 'snap_m', filePath: '/m/app/r2.md' }

    it('编辑框预填两条正文（保留的那条在前，空行分隔）；更多里是保留那条的名称、摘要和两条标签的并集；底部写明另一条进最近删除', async () => {
      const { commands } = setup([pairOf(left, right)], { respond: command => (command.cmd === 'merge-memories' ? merged : { ok: true, cmd: command.cmd }) })
      fireEvent.click(screen.getByRole('button', { name: '直接合并' }))
      expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('少用被字句。\n\n避免翻译腔。')
      expect(screen.getByText('保存后另一条进最近删除')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '删除左边' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: '更多' }))
      expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('被字句')
      expect(screen.getByRole('textbox', { name: '摘要' })).toHaveValue('少被字句')
      await save()
      expect(commands()).toEqual([{
        cmd: 'merge-memories',
        memories: [{ memoryId: 'r1', layer, base: { updatedAt: 21, digest: 'sha1:r1' } }, { memoryId: 'r2', layer, base: { updatedAt: 22, digest: 'sha1:r2' } }],
        content: '少用被字句。\n\n避免翻译腔。', name: '被字句', summary: '少被字句', tags: ['写作', '中文'],
      }])
      expect(screen.getByText('已合并')).toBeInTheDocument()
      expect(screen.getByText(`被字句 · 12 字 → 14 字`)).toBeInTheDocument()
    })

    it('合并后的内容有高危密钥：本地拦住，不发命令', async () => {
      const { commands } = setup([pairOf(left, right)], { respond: command => (command.cmd === 'merge-memories' ? merged : { ok: true, cmd: command.cmd }) })
      fireEvent.click(screen.getByRole('button', { name: '直接合并' }))
      fireEvent.change(screen.getByRole('textbox', { name: '正文' }), { target: { value: `两条合一：${criticalKey}` } })
      await save()
      expect(commands()).toEqual([])
      expect(screen.getByRole('alert')).toHaveTextContent('内容里有高危密钥，没有保存。')
    })

    it('一条全局一条项目：保留全局那条，预填它的名称', () => {
      const global = { ...left, scope: 'global', workspacePath: undefined } as MemoryCard
      setup([pairOf(right, global)])
      fireEvent.click(screen.getByRole('button', { name: '直接合并' }))
      expect(screen.getByRole('textbox', { name: '正文' })).toHaveValue('避免翻译腔。\n\n少用被字句。')
      fireEvent.click(screen.getByRole('button', { name: '更多' }))
      expect(screen.getByRole('textbox', { name: '名称' })).toHaveValue('翻译腔')
    })
  })
})

describe('待处理：让模型改与让模型合并', () => {
  const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
  const target = memory({ id: 'b1', name: '发版流程', type: 'project', content: '先跑测试，再打包，再发版。', summary: '发版的步骤', tags: ['发版'], digest: 'sha1:b1', updatedAt: 111 })
  const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [target] }
  const stale: PendingItem = { kind: 'advice', level: 'advice', type: 'stale', memories: [memory({ id: 's9', name: '很久的', digest: 'sha1:s9' })] }
  const base = { updatedAt: 111, digest: 'sha1:b1' }
  const drafted = (draft: object): MemoryCommandResult => ({ ok: true, cmd: 'draft-edit', draft: { content: '先跑单测，再发版。', summary: '发版的步骤', ...draft }, model: 'deepseek-v4-flash' } as MemoryCommandResult)
  const edited = { ok: true as const, cmd: 'edit-memory', decisionId: 'pd_e', memoryIds: ['b1'], snapshotId: 'snap_e', filePath: '/m/app/b1.md' }
  /** 生成回给定的稿子，其余命令照常成功。 */
  const respondWith = (draft: object = {}) => (command: MemoryCommand): MemoryCommandResult =>
    command.cmd === 'draft-edit' ? drafted(draft) : command.cmd === 'edit-memory' ? edited : { ok: true, cmd: command.cmd }
  const open = (name = '让模型改') => { fireEvent.click(screen.getByRole('button', { name })) }
  const generate = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成修改' })) }) }
  const textOf = (pane: string, tag: 'del' | 'ins') => [...screen.getByRole('region', { name: pane }).querySelectorAll(tag)].map(e => e.textContent).join('|')

  it('「让模型改」在「直接改」右边；点开就地写要求，说明按哪类建议默认处理、用哪个模型；「取消」收起，不发命令', () => {
    const { commands } = setup([bloat], { model: 'deepseek-v4-flash' })
    expect(within(screen.getByRole('article')).getAllByRole('button').map(b => b.textContent)).toEqual(['不再提醒', '打开文件', '直接改', '让模型改'])
    open()
    expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「内容过长」默认处理' })).toHaveValue('')
    // 改的过程中右上角的叉收起
    expect(screen.queryByRole('button', { name: '不再提醒' })).toBeNull()
    expect(screen.getByText('用当前模型 deepseek-v4-flash 生成，先给你看结果再决定')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '直接改' })).toBeNull()
    expect(screen.getByRole('button', { name: '取消' })).toHaveClass('pm-btn--ghost')
    expect(screen.getByRole('button', { name: '生成修改' })).toHaveClass('pm-btn--primary')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '让模型改' })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('拿不到模型名：提示只写后半句', () => {
    setup([bloat])
    open()
    expect(screen.getByText('先给你看结果再决定')).toBeInTheDocument()
  })

  it('生成：发 draft-edit（建议类型、层、要求）；结果左右对照，删掉的划线、新增的高亮，下面一行字数变化；这时什么都没写', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '命令保留原样' } })
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'b1', layer }], request: '命令保留原样' }])
    expect(textOf('原文', 'del')).toContain('打包')
    expect(textOf('改后', 'ins')).toContain('单测')
    expect(textOf('原文', 'ins')).toBe('')
    expect(textOf('改后', 'del')).toBe('')
    expect(screen.getByText('13 字 → 9 字')).toBeInTheDocument()
    expect(screen.getAllByRole('button').slice(-3).map(b => b.textContent)).toEqual(['放弃', '再改改', '应用'])
  })

  it('要求里有高危密钥：本地拦住，不发 draft-edit，就地写明原因', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: `把 ${'sk-' + 'TESTONLY'.padEnd(24, 'a')} 删掉` } })
    await generate()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toBeInTheDocument()
  })

  it('没写要求：draft-edit 不带 request', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'b1', layer }] }])
  })

  it('摘要、名称、标签变了也对照显示；没变的不显示', async () => {
    setup([bloat], { respond: respondWith({ summary: '发版两步', name: '发版步骤' }) })
    open()
    await generate()
    const after = screen.getByRole('region', { name: '改后' })
    expect(within(after).getByText('摘要')).toBeInTheDocument()
    expect(within(after).getByText('名称')).toBeInTheDocument()
    expect(within(after).queryByText('标签')).toBeNull()
    expect(textOf('改后', 'ins')).toContain('两步')
  })

  it('应用：发 edit-memory（卡片版本 + 改后稿，模型没改的名称、标签沿用原值），之后同直接改：收成一行，可撤销', async () => {
    const { commands } = setup([bloat], { respond: respondWith({ summary: '发版两步' }) })
    open()
    await generate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'edit-memory', memoryId: 'b1', layer, base, content: '先跑单测，再发版。', name: '发版流程', summary: '发版两步', tags: ['发版'] })
    expect(screen.getByText('已修改')).toBeInTheDocument()
    expect(screen.getByText('发版流程 · 13 字 → 9 字')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'pd_e' })
  })

  it('「放弃」收起，不写', async () => {
    const { commands } = setup([bloat], { respond: respondWith() })
    open()
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(screen.getByRole('button', { name: '让模型改' })).toBeInTheDocument()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit'])
  })

  it('再改改：回到输入框，第二次请求带上一稿与新要求', async () => {
    const { commands } = setup([bloat], { respond: respondWith({ name: '发版步骤' }) })
    open()
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '再改改' }))
    const box = screen.getByRole('textbox', { name: /想怎么改/ })
    expect(box).toHaveValue('')
    fireEvent.change(box, { target: { value: '再短一点' } })
    await generate()
    expect(commands().at(-1)).toEqual({
      cmd: 'draft-edit', adviceType: 'bloat', memories: [{ memoryId: 'b1', layer }], request: '再短一点',
      previous: { content: '先跑单测，再发版。', summary: '发版的步骤', name: '发版步骤', tags: ['发版'] },
    })
  })

  it('生成中只锁这张卡：显示「正在生成修改……」和「停止」，别的卡照常可用', async () => {
    setup([bloat, stale], { respond: command => (command.cmd === 'draft-edit' ? new Promise<never>(() => {}) : { ok: true, cmd: command.cmd }) })
    open()
    await generate()
    expect(screen.getByText('正在生成修改……')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止' })).toHaveClass('pm-btn--ghost')
    expect(screen.queryByRole('button', { name: '生成修改' })).toBeNull()
    expect(screen.getByRole('button', { name: '仍然有效' })).not.toHaveAttribute('aria-disabled')
  })

  it('停止：回到输入框（写的要求还在），之后到达的结果直接丢弃，不显示、不写', async () => {
    let resolve: (r: MemoryCommandResult) => void = () => {}
    const { commands } = setup([bloat], {
      respond: command => (command.cmd === 'draft-edit' ? new Promise<MemoryCommandResult>((r) => { resolve = r }) : { ok: true, cmd: command.cmd }),
    })
    open()
    fireEvent.change(screen.getByRole('textbox', { name: /想怎么改/ }), { target: { value: '短一点' } })
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(screen.getByRole('textbox', { name: /想怎么改/ })).toHaveValue('短一点')
    await act(async () => { resolve(drafted({})) })
    expect(screen.queryByRole('region', { name: '改后' })).toBeNull()
    expect(screen.getByRole('button', { name: '生成修改' })).toBeInTheDocument()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit'])
  })

  it.each([
    ['输出不合格式', { ok: false, cmd: 'draft-edit', code: 'llm-invalid-output', detail: '模型的输出不是要求的 JSON 格式' }, '模型返回的内容格式不对，再试一次。'],
    ['模型报错', { ok: false, cmd: 'draft-edit', code: 'llm-failed', detail: 'rate limited' }, '模型出错了：rate limited'],
    ['拿不到模型', { ok: false, cmd: 'draft-edit', code: 'llm-unavailable', detail: '借用的会话拿不到模型' }, '拿不到当前会话的模型。'],
  ] as const)('生成失败（%s）：卡片写原因，可以重试', async (_label, failure, message) => {
    const replies: MemoryCommandResult[] = [failure as MemoryCommandResult, drafted({})]
    const { commands } = setup([bloat], { respond: command => (command.cmd === 'draft-edit' ? replies.shift()! : { ok: true, cmd: command.cmd }) })
    open()
    await generate()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    await generate()
    expect(screen.getByRole('region', { name: '改后' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(commands().map(c => c.cmd)).toEqual(['draft-edit', 'draft-edit'])
  })

  it('表述不清也给「让模型改」，默认按「表述不清」处理', async () => {
    const { commands } = setup([{ ...bloat, type: 'unclear' }], { respond: respondWith() })
    open()
    expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「表述不清」默认处理' })).toBeInTheDocument()
    await generate()
    expect(commands()[0]).toMatchObject({ cmd: 'draft-edit', adviceType: 'unclear' })
  })

  it('页面加载时不问模型，点开「让模型改」「让模型合并」才问', () => {
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [memory({ id: 'r1', digest: 'sha1:r1' }), memory({ id: 'r2', digest: 'sha1:r2' })] }
    const { gateway } = setup([bloat, pair], { model: 'deepseek-v4-flash' })
    expect(gateway.modelRequests).toEqual([])
    open()
    expect(gateway.modelRequests.at(-1)).toBe('s1')
  })

  it('模型不可用：按钮照常能点；点开后面板里写原因，「生成修改」不可用，不发请求', async () => {
    const { commands } = setup([bloat], { model: null })
    expect(screen.getByRole('button', { name: '让模型改' })).not.toHaveAttribute('aria-disabled')
    open()
    expect(screen.getByText('拿不到当前会话的模型。')).toBeInTheDocument()
    expect(screen.queryByText('先给你看结果再决定')).toBeNull()
    expect(screen.getByRole('button', { name: '生成修改' })).toHaveAttribute('aria-disabled', 'true')
    await generate()
    expect(commands()).toEqual([])
  })

  it('含密钥的记忆：没有「让模型改」「让模型合并」，也不发请求', () => {
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [memory({ id: 'x1', digest: 'sha1:x1', hasSecret: true }), memory({ id: 'x2', digest: 'sha1:x2' })] }
    const { commands } = setup([{ ...bloat, memories: [{ ...target, hasSecret: true }] }, pair])
    expect(screen.queryByRole('button', { name: '让模型改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '让模型合并' })).toBeNull()
    expect(commands()).toEqual([])
  })

  describe('让模型合并', () => {
    const left = memory({ id: 'r1', name: '翻译腔', content: '避免翻译腔。', summary: '少翻译腔', tags: ['中文'], createdAt: 2, updatedAt: 21, digest: 'sha1:r1' })
    const right = memory({ id: 'r2', name: '被字句', content: '少用被字句。', summary: '少被字句', tags: ['写作', '中文'], createdAt: 1, updatedAt: 22, digest: 'sha1:r2' })
    const pair: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [left, right] }
    const merged = { ok: true as const, cmd: 'merge-memories', decisionId: 'pd_m', memoryIds: ['r2', 'r1'], snapshotId: 'snap_m', filePath: '/m/app/r2.md' }
    const respond = (command: MemoryCommand): MemoryCommandResult => (command.cmd === 'draft-edit'
      ? { ok: true, cmd: 'draft-edit', draft: { content: '中文写作避免翻译腔，少用被字句。', summary: '中文写作要自然' } }
      : command.cmd === 'merge-memories' ? merged : { ok: true, cmd: command.cmd })

    it('「让模型合并」在「直接合并」右边；结果左边两条原文、右边合并稿，标明保留哪条的 id，不高亮', async () => {
      const { commands } = setup([pair], { respond })
      expect(within(screen.getByRole('article')).getAllByRole('button').slice(-2).map(b => b.textContent)).toEqual(['直接合并', '让模型合并'])
      open('让模型合并')
      expect(screen.getByRole('textbox', { name: '想怎么改？不写也行，会按「内容重复」默认处理' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '不再提醒' })).toBeNull()
      await generate()
      expect(commands()).toEqual([{ cmd: 'draft-edit', adviceType: 'redundancy', memories: [{ memoryId: 'r1', layer }, { memoryId: 'r2', layer }] }])
      const before = screen.getByRole('region', { name: '两条原文' })
      expect(within(before).getByText('避免翻译腔。')).toBeInTheDocument()
      expect(within(before).getByText('少用被字句。')).toBeInTheDocument()
      // r2 创建较早，按票 08 的规则保留它：它是右边那条
      const after = screen.getByRole('region', { name: '合并后（保留右边那条的 id）' })
      expect(within(after).getByText('中文写作避免翻译腔，少用被字句。')).toBeInTheDocument()
      expect(document.querySelectorAll('.pm-model-compare del, .pm-model-compare ins')).toHaveLength(0)
      expect(screen.getByText(/应用后左边那条进最近删除，14 天内可恢复/)).toBeInTheDocument()
    })

    it('应用：发 merge-memories（两条的卡片版本，名称取保留那条、标签取并集），应用后收成「已合并」一行', async () => {
      const { commands } = setup([pair], { respond })
      open('让模型合并')
      await generate()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
      expect(commands().at(-1)).toEqual({
        cmd: 'merge-memories',
        memories: [{ memoryId: 'r1', layer, base: { updatedAt: 21, digest: 'sha1:r1' } }, { memoryId: 'r2', layer, base: { updatedAt: 22, digest: 'sha1:r2' } }],
        content: '中文写作避免翻译腔，少用被字句。', name: '被字句', summary: '中文写作要自然', tags: ['写作', '中文'],
      })
      expect(screen.getByText('已合并')).toBeInTheDocument()
    })
  })
})

// —— 放错层只回答挪不挪：项目 → 全局是提升，全局 → 项目是移到项目（行内选项目） ——

describe('待处理：放错层只给挪层', () => {
  const toGlobal: PendingItem = { kind: 'advice', level: 'advice', type: 'misplaced', memories: [memory({ id: 'mu', name: '记忆 mu', filePath: '/m/app/mu.md', digest: 'sha1:mu' })] }
  const toProject: PendingItem = {
    kind: 'advice', level: 'advice', type: 'misplaced',
    memories: [memory({ id: 'md', name: '记忆 md', scope: 'global', workspacePath: undefined, filePath: '/m/global/md.md', digest: 'sha1:md' })],
  }
  /** 借来的会话带着归属对照：已知项目是 app、blog（两个 cwd 落在 blog）。 */
  const session = { kind: 'ready', sessionId: 's1', cwd: '/w/app', workspaces: { '/w/app': '/w/app', '/w/blog': '/w/blog', '/w/blog/web': '/w/blog' } } as const
  /** pageProject：页面作用域的项目，null = 页面在全局。 */
  function setupMove(items: PendingItem[], init: FakeGatewayInit = {}, pageProject: string | null = '/w/app') {
    const gateway = createFakeGateway({ session, config, views: { pending: view(...items), health: scannedHealth(NOW) }, ...init })
    renderInShell(<PendingTab nav={createNavStore()} session={session} scope={ALL_SCOPE} workspacePath={pageProject ?? undefined} now={NOW} />, gateway)
    return { gateway, commands: () => gateway.executed.map(e => e.command) }
  }
  const cardOf = () => screen.getByRole('heading', { level: 3, name: '放错层' }).closest('article')!
  const openPicker = () => { fireEvent.click(within(cardOf()).getByRole('button', { name: '移到项目…' })) }

  it('两个方向都没有「直接改」「让模型改」', () => {
    setupMove([toGlobal, toProject])
    for (const card of screen.getAllByRole('article')) {
      expect(within(card).queryByRole('button', { name: '直接改' })).toBeNull()
      expect(within(card).queryByRole('button', { name: '让模型改' })).toBeNull()
    }
  })

  it('项目 → 全局：叉「不再提醒」发 ignore-advice，「打开文件」打开那条记忆的文件', async () => {
    const { gateway, commands } = setupMove([toGlobal])
    fireEvent.click(within(cardOf()).getByRole('button', { name: '打开文件' }))
    expect(gateway.opened).toEqual([{ path: '/m/app/mu.md' }])
    fireEvent.click(within(cardOf()).getByRole('button', { name: '不再提醒' }))
    await screen.findByText('不再扣分；内容改了会重新提醒。')
    expect(commands()).toEqual([{ cmd: 'ignore-advice', type: 'misplaced', memories: [{ memoryId: 'mu', layer: { kind: 'workspace', workspacePath: '/w/app' }, base: { updatedAt: toGlobal.kind === 'advice' ? toGlobal.memories[0]!.updatedAt : 0, digest: 'sha1:mu' } }] }])
  })

  it('全局 → 项目：点「移到项目…」在卡片里展开已知项目，默认选当前页面的项目；「取消」收起，什么都不发', () => {
    const { commands } = setupMove([toProject])
    openPicker()
    const group = within(cardOf()).getByRole('group', { name: '移到哪个项目' })
    expect(within(group).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['/w/app', '/w/blog'])
    expect(within(group).getByRole('radio', { name: /^app/ })).toBeChecked()
    expect(within(cardOf()).queryByRole('button', { name: '不再提醒' })).toBeNull()
    fireEvent.click(within(cardOf()).getByRole('button', { name: '取消' }))
    expect(within(cardOf()).queryByRole('group', { name: '移到哪个项目' })).toBeNull()
    expect(within(cardOf()).getByRole('button', { name: '移到项目…' })).toBeInTheDocument()
    expect(commands()).toEqual([])
  })

  it('页面在全局：默认选借来的会话所在的项目；全部记忆里有记忆的项目也列出来', () => {
    setupMove([toProject], {
      currentWorkspace: '/w/blog',
      views: {
        pending: view(toProject), health: scannedHealth(NOW),
        library: { version: GUI_VIEW_VERSION, layers: [{ layer: { kind: 'global' }, items: [] }, { layer: { kind: 'workspace', workspacePath: '/w/docs' }, items: [] }] } as never,
      },
    }, null)
    openPicker()
    const group = within(cardOf()).getByRole('group', { name: '移到哪个项目' })
    expect(within(group).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['/w/blog', '/w/app', '/w/docs'])
    expect(within(group).getByRole('radio', { name: /^blog/ })).toBeChecked()
  })

  it('选好项目点「移过去」才发 move-memory；结果卡写「已移到 <项目名>」，撤销发 undo', async () => {
    const { commands } = setupMove([toProject], {
      respond: command => command.cmd === 'move-memory'
        ? { ok: true, cmd: command.cmd, decisionId: 'pd_mv', memoryIds: ['md'], snapshotId: 'snap_1', filePath: '/m/blog/md.md' }
        : { ok: true, cmd: command.cmd },
    })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('radio', { name: /^blog/ }))
    expect(commands()).toEqual([])
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    await screen.findByText('已移到 blog')
    expect(screen.getByText('只在这个项目里带入，14 天内可撤销。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands()).toEqual([{ cmd: 'move-memory', memoryId: 'md', workspacePath: '/w/blog' }, { cmd: 'undo', decisionId: 'pd_mv' }])
  })

  it('目标不是借来的会话所在项目：服务端拒（cross-workspace）→ 行内写明要移去的项目；「继续处理」带 allowCrossWorkspace 重发', async () => {
    const { commands } = setupMove([toProject], {
      respond: command => command.cmd === 'move-memory' && command.allowCrossWorkspace !== true
        ? { ok: false, cmd: command.cmd, code: 'cross-workspace', rejected: [{ id: 'md', workspacePath: '/w/blog' }] }
        : { ok: true, cmd: command.cmd, decisionId: 'pd_mv' },
    })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('radio', { name: /^blog/ }))
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    expect(await screen.findByText('要移去的 blog 不是当前项目。确定从这里移过去吗？')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续处理' }))
    await screen.findByText('已移到 blog')
    expect(commands()).toEqual([
      { cmd: 'move-memory', memoryId: 'md', workspacePath: '/w/blog' },
      { cmd: 'move-memory', memoryId: 'md', workspacePath: '/w/blog', allowCrossWorkspace: true },
    ])
  })

  it('目标项目已有同一条（target-taken）：卡片里写明没有移动', async () => {
    setupMove([toProject], { respond: command => ({ ok: false, cmd: command.cmd, code: 'target-taken', detail: '已有' }) })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('这个项目里已经有同一条记忆（也可能在最近删除里），没有移动。')
  })

  it('别处已移走或删掉（not-found）：卡片外提示没有生效', async () => {
    setupMove([toProject], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found', detail: '不存在或已处理：md' }) })
    openPicker()
    fireEvent.click(within(cardOf()).getByRole('button', { name: '移过去' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('你对「放错层」的选择没有生效：它正在别处处理，或者刚在别处处理完。')
  })

  it('一个已知项目都没有：写明原因，「移过去」不可用', () => {
    const lonely = { kind: 'ready', sessionId: 's1', cwd: undefined } as const
    const gateway = createFakeGateway({ session: lonely, config, views: { pending: view(toProject), health: scannedHealth(NOW) } })
    renderInShell(<PendingTab nav={createNavStore()} session={lonely} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    openPicker()
    expect(within(cardOf()).getByText('还没有已知的项目：在某个项目里开过对话后，它会出现在这里。')).toBeInTheDocument()
    expect(within(cardOf()).getByRole('button', { name: '移过去' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('展开时焦点落在选中的项目上', () => {
    setupMove([toProject])
    openPicker()
    expect(within(cardOf()).getByRole('radio', { name: /^app/ })).toHaveFocus()
  })

  it('一个已知项目都没有：展开时焦点落在「取消」，不随收起的「移到项目…」掉到页面上', () => {
    const lonely = { kind: 'ready', sessionId: 's1', cwd: undefined } as const
    const gateway = createFakeGateway({ session: lonely, config, views: { pending: view(toProject), health: scannedHealth(NOW) } })
    renderInShell(<PendingTab nav={createNavStore()} session={lonely} scope={ALL_SCOPE} workspacePath={undefined} now={NOW} />, gateway)
    openPicker()
    expect(within(cardOf()).getByRole('button', { name: '取消' })).toHaveFocus()
  })
})

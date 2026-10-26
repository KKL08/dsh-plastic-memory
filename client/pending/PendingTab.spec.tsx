import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type AdviceType, type HealthView, type MemoryCard, type MemoryCommand, type PendingItem, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { useGateway, type PluginConfig } from '../gateway.ts'
import { FLASH_MS } from '../library/shared.tsx'
import { createNavStore, type NavStore } from '../nav.ts'
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

const view = (...items: PendingItem[]): PendingView => ({ version: GUI_VIEW_VERSION, dot: 'amber', items, levelCounts: levelCountsOf(items), typeLabels: { preference: '行为偏好' } })
const scannedHealth = (at: number | null): HealthView => ({
  version: GUI_VIEW_VERSION,
  governanceEnabled: true,
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 1, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0, semanticCachedAt: at, overflow: null }],
})

function setup(items: PendingItem[], init: FakeGatewayInit = {}, nav: NavStore = createNavStore()) {
  const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(...items), health: scannedHealth(NOW) }, ...init })
  const utils = renderInShell(<PendingTab nav={nav} session={SESSION} workspacePath="/w/app" now={NOW} />, gateway)
  const commands = () => gateway.executed.map(e => e.command)
  return { ...utils, gateway, commands }
}

describe('待处理：按级别分组', () => {
  it('高优问题在前、待你处理在后，组标题带条数；组内按视图顺序出卡', () => {
    setup([secret, unreadable, horizontal, vertical, promote, overflow])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['高优问题 2', '待你处理 4'])
    const mustFix = screen.getByRole('region', { name: '高优问题 2' })
    expect(within(mustFix).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['这条记忆里有密钥', '有个文件读不出来'])
    expect(within(screen.getByRole('region', { name: '待你处理 4' })).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      '测试里怎么准备数据库，两条记忆互相矛盾', '包管理器和基线矛盾', '这条适合所有项目', '带入的记忆超出上限',
    ])
  })

  it('密钥标红，读不出的文件同在高优问题组但不标红', () => {
    setup([secret, unreadable])
    const mustFix = screen.getByRole('region', { name: '高优问题 2' })
    const [secretCard, fileCard] = within(mustFix).getAllByRole('article')
    expect(within(secretCard!).getByRole('img', { name: '有密钥要处理' })).toBeInTheDocument()
    expect(fileCard!.querySelector('.pm-marker')).toBeNull()
  })

  it('某一级没有待处理项：整组不画', () => {
    setup([horizontal])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['待你处理 1'])
    expect(screen.queryByRole('region', { name: /高优问题/ })).toBeNull()
  })

  it('只有高优问题：只画这一组', () => {
    setup([unreadable])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['高优问题 1'])
  })

  it('裁决后结果卡留在原来那一组；组标题的数只算还在等你的', async () => {
    setup([secret, horizontal, promote])
    fireEvent.click(screen.getByRole('button', { name: '以 A 为准' }))
    await screen.findByText('已按 A')
    const yourCall = screen.getByRole('region', { name: '待你处理 1' })
    expect(within(yourCall).getByText('已按 A')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '高优问题 1' })).toBeInTheDocument()
  })
})

describe('待处理：各类卡', () => {

  it('横向冲突：A / B 原文、类型显示名、「决定前 agent 按哪条来」，后果在动手前就写着；三个按钮各发对应 verdict', async () => {
    const { commands } = setup([horizontal])
    expect(screen.getByText('决定前 agent 按你明确说过的 A 来。')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '记忆 A' })).getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: '记忆 A' })).getByText('行为偏好')).toBeInTheDocument()
    expect(screen.getByText(/以 A 为准会删掉 B，以 B 为准会删掉 A，14 天内可恢复。都保留：以后体检不再把它们当冲突。/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '以 B 为准' }))
    await waitFor(() => { expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-right' }]) })
  })

  it('偏好方不是你明确说过的：只写按哪条', () => {
    setup([{ ...horizontal, preferredId: 'b' } as PendingItem])
    expect(screen.getByText('决定前 agent 按 B 来。')).toBeInTheDocument()
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
      const { unmount } = renderInShell(<PendingTab nav={createNavStore()} session={session} workspacePath="/w/app" now={NOW} />, gateway)
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
    expect(nav.get()).toMatchObject({ tab: 'library', scope: { kind: 'workspace', workspacePath: '/w/app' }, memoryId: undefined })
    fireEvent.click(globalLink!)
    expect(nav.get()).toMatchObject({ tab: 'library', scope: { kind: 'global' }, memoryId: undefined })
    expect(commands()).toEqual([])
  })

  it('超限：写出超出量与放宽到的档位；「忽略」发 dismiss-overflow', async () => {
    const { commands } = setup([overflow])
    expect(screen.getByText('超出上限 25% 以上，已自动放宽到 5,000（上限 4,000）。')).toBeInTheDocument()
    expect(screen.getByText('在 app 项目里')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    await screen.findByText('已忽略')
    expect(commands()).toEqual([{ cmd: 'dismiss-overflow', decisionId: 'd-o' }])
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
    expect(screen.getByText('目前没有要处理的事')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(refused)
  })

  it.each([
    ['提升为全局', 'claimed', '这条适合所有项目'],
    ['留在本项目', 'not-found', '这条适合所有项目'],
    ['忽略', 'claimed', '带入的记忆超出上限'],
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
    renderInShell(<PendingTab nav={createNavStore()} session={{ kind: 'none' }} workspacePath={undefined} now={NOW} />, gateway)
    expect(screen.getByRole('status')).toHaveTextContent('开一个会话后这里可用')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('有结果卡时会话没了：撤销不可用并提示「先开一个会话」', async () => {
    // 和页面一样从网关借会话
    function Tab() {
      return <PendingTab nav={createNavStore()} session={useGateway().useSession('/w/app')} workspacePath="/w/app" now={NOW} />
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

  it('待处理为空：一句结论，说明待处理收什么，再写上次体检时间；不画组标题，没有按钮', () => {
    setup([], { views: { pending: view(), health: scannedHealth(new Date(2026, 9, 15, 9).getTime()) } })
    expect(screen.getByRole('status')).toHaveTextContent('目前没有要处理的事')
    expect(screen.getByRole('status')).toHaveTextContent('密钥、读不出的文件、互相矛盾的记忆、超限提醒和适合提升为全局的记忆会出现在这里。')
    expect(screen.getByRole('status')).toHaveTextContent('上次体检：10 月 15 日')
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('从没体检过：只说明体检是什么，不放按钮（「体检当前项目」在页头）', () => {
    setup([], { views: { pending: view(), health: scannedHealth(null) } })
    expect(screen.getByRole('status')).toHaveTextContent('还没做过体检')
    expect(screen.getByRole('status')).toHaveTextContent('点右上角「体检当前项目」开始')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('体检关闭：「去设置里打开 ›」是唯一能点的，打开插件设置页', () => {
    const openSettings = vi.fn()
    setup([], { views: { pending: view(), health: { ...scannedHealth(NOW), governanceEnabled: false } } }, createNavStore(undefined, { openSettings }))
    expect(screen.getByRole('status')).toHaveTextContent('体检已关闭')
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['去设置里打开 ›'])
    fireEvent.click(screen.getByRole('button', { name: '去设置里打开 ›' }))
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('体检关闭、宿主没有插件页导航：只有说明，不画「去设置里打开 ›」', () => {
    setup([], { views: { pending: view(), health: { ...scannedHealth(NOW), governanceEnabled: false } } })
    expect(screen.getByRole('status')).toHaveTextContent('体检已关闭')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('体检开关以健康视图为准（和健康 tab、页头一致），不看插件配置', () => {
    setup([], { config: { ...config, governanceEnabled: false } })
    expect(screen.getByRole('status')).not.toHaveTextContent('体检已关闭')
  })
})

// 入口带记忆 id 打开待处理：含这条记忆的卡（冲突任一方、提升候选、密钥）滚入视野并高亮一次。
describe('待处理：直达某条记忆', () => {
  const scrollIntoView = vi.fn()
  beforeEach(() => { vi.useFakeTimers(); scrollIntoView.mockClear(); Element.prototype.scrollIntoView = scrollIntoView })
  afterEach(() => { vi.useRealTimers(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })
  const cardOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('.pm-pending-row')!

  it('记忆在横向冲突的 B 方：那张冲突卡高亮并滚入视野，播完收起', () => {
    const nav = createNavStore({ tab: 'pending', memoryId: 'b' })
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
    const nav = createNavStore({ tab: 'pending', memoryId: 'p' })
    setup([secret, vertical, promote], {}, nav)
    expect(cardOf('这条适合所有项目')).toHaveClass('pm-flash')
    act(() => { nav.navigate({ tab: 'pending', memoryId: 'v' }) })
    expect(cardOf('包管理器和基线矛盾')).toHaveClass('pm-flash')
    act(() => { nav.navigate({ tab: 'pending', memoryId: 's' }) })
    expect(cardOf('这条记忆里有密钥')).toHaveClass('pm-flash')
  })

  it('目标不在待处理里：不高亮、不滚动', () => {
    setup([horizontal], {}, createNavStore({ tab: 'pending', memoryId: 'nope' }))
    expect(document.querySelector('.pm-flash')).toBeNull()
    expect(scrollIntoView).not.toHaveBeenCalled()
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

// —— 建议整理（spec「建议整理的动作」）：卡片不着色、动作按问题类型；删除走 forget，含密钥改走彻底删除确认 ——

describe('待处理：建议整理', () => {
  const advice = (type: AdviceType, id: string, overrides: Partial<MemoryCard> = {}): PendingItem => ({
    kind: 'advice', level: 'advice', type, memories: [memory({ id, name: `记忆 ${id}`, filePath: `/m/app/${id}.md`, ...overrides })],
  })
  const expired = advice('expired', 'e1', { validTo: NOW - 1 })
  const stale = advice('stale', 's1', { lastConfirmedAt: new Date(2026, 5, 1).getTime() })
  const bloat = advice('bloat', 'b1')
  const orphan = advice('orphan', 'o1')
  const layer = { kind: 'workspace', workspacePath: '/w/app' } as const
  const groupOf = () => screen.getByRole('region', { name: /^建议整理/ })
  const cardOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('article')!

  it('建议整理组排在最后，组名带条数；卡片不着色、不带状态标记', () => {
    setup([secret, horizontal, expired, stale, bloat, orphan])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['高优问题 1', '待你处理 1', '建议整理 4'])
    expect(within(groupOf()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      '已过有效期', '很久没确认', '内容过长', '指向的旧记忆已不在',
    ])
    expect(groupOf().querySelector('.pm-marker')).toBeNull()
  })

  it.each([
    ['已过有效期', expired, ['删除', '打开文件']],
    ['很久没确认', stale, ['仍然有效', '删除', '打开文件']],
    ['内容过长', bloat, ['打开文件']],
    ['指向的旧记忆已不在', orphan, ['打开文件']],
  ] as const)('%s：动作按 spec 表', (title, item, buttons) => {
    setup([item])
    expect(cardOf(title).querySelector(`[data-memory-id="${item.kind === 'advice' ? item.memories[0]!.id : ''}"]`)).not.toBeNull()
    expect(within(cardOf(title)).getAllByRole('button').map(b => b.textContent)).toEqual([...buttons])
  })

  it('「仍然有效」发 confirm（带这条记忆的层），原位换成结果卡', async () => {
    const { commands } = setup([stale])
    fireEvent.click(screen.getByRole('button', { name: '仍然有效' }))
    await screen.findByText('已确认仍然有效')
    expect(commands()).toEqual([{ cmd: 'confirm', memoryId: 's1', layer }])
    expect(screen.getByText('确认时间已更新，这条不再算作很久没确认。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('「删除」发 forget（带层），结果写可在最近删除恢复', async () => {
    const { commands } = setup([expired])
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await screen.findByText('已删除')
    expect(commands()).toEqual([{ cmd: 'forget', memoryId: 'e1', layer }])
    expect(screen.getByText('14 天内可在「最近删除」恢复。')).toBeInTheDocument()
  })

  it('删除含密钥的记忆：forget 回 has-secret（什么都没动），原位出现彻底删除确认；取消不发，「彻底删除」发 hard-delete', async () => {
    const { commands } = setup([stale], {
      respond: command => command.cmd === 'forget'
        ? { ok: false, cmd: command.cmd, code: 'has-secret', detail: '记忆 s1 含密钥，删除后不可恢复，未做任何改动' }
        : { ok: true, cmd: command.cmd, memoryIds: ['s1'] },
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除' })) })
    const card = cardOf('很久没确认')
    expect(within(card).getByText('这条记忆里有密钥')).toBeInTheDocument()
    expect(within(card).getByText('彻底删除后不进最近删除、不能恢复，以前快照里的副本也会抹掉。')).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: '删除' })).toHaveAttribute('aria-disabled', 'true')
    expect(within(card).queryByText(/记忆 s1 含密钥/)).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '取消' }))
    expect(within(card).queryByText('这条记忆里有密钥')).toBeNull()

    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '删除' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
    await screen.findByText('已彻底删除')
    expect(commands()).toEqual([
      { cmd: 'forget', memoryId: 's1', layer },
      { cmd: 'forget', memoryId: 's1', layer },
      { cmd: 'hard-delete', memoryId: 's1', layer },
    ])
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
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['建议整理 7'])
    fireEvent.click(screen.getByRole('button', { name: '展开其余 2 条' }))
    expect(within(groupOf()).getAllByRole('article')).toHaveLength(7)
    expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
  })

  it('只折叠建议整理：待你处理超过 5 条也全部显示', () => {
    const conflicts = Array.from({ length: 6 }, (_, i) => ({ ...horizontal, decisionId: `d${i}`, summary: `冲突 ${i}` }) as PendingItem)
    setup(conflicts)
    expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
    expect(screen.getByText('冲突 5')).toBeInTheDocument()
  })

  it('直达的记忆在折叠里：这一组自动展开，那张卡高亮', () => {
    Element.prototype.scrollIntoView = vi.fn()
    try {
      const many = Array.from({ length: 7 }, (_, i) => advice('bloat', `b${i}`))
      setup(many, {}, createNavStore({ tab: 'pending', memoryId: 'b6' }))
      expect(within(groupOf()).getAllByRole('article')).toHaveLength(7)
      expect(document.querySelector('[data-memory-id="b6"]')!.closest('.pm-pending-row')).toHaveClass('pm-flash')
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })
})

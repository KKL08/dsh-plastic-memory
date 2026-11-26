import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { type PendingItem } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { ALL_SCOPE, createNavStore } from '../nav.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'
import { config, horizontal, vertical, promote, secret, overflow, unreadable, tidy, view, scannedHealth, setup, ruleConflict, ruleVertical } from './test-pending.tsx'


describe('待处理：按级别分组', () => {
  it('页面开着时新来的条目带入场动效（撑开再落进来），打开时已有的不带', () => {
    const { gateway } = setup([horizontal])
    const arrivalOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('.pm-pending-row')!.querySelector(':scope > .pm-arrive > .pm-arrive-body > article')
    expect(arrivalOf('测试里怎么准备数据库，两条记忆互相矛盾')).toBeNull()
    act(() => { gateway.setView('pending', view(secret, horizontal)) })
    expect(arrivalOf('这条记忆里有密钥')).not.toBeNull()
    expect(arrivalOf('测试里怎么准备数据库，两条记忆互相矛盾')).toBeNull()
  })

  it('新来的卡命令进行中、视图先刷新掉它：卡片不重挂，按钮仍是进行中', async () => {
    const { gateway } = setup([secret], { respond: () => new Promise<never>(() => {}) })
    act(() => { gateway.setView('pending', view(secret, horizontal)) })
    const card = screen.getByRole('heading', { level: 3, name: '测试里怎么准备数据库，两条记忆互相矛盾' }).closest('article')!
    fireEvent.click(within(card).getByRole('button', { name: '保留 A' }))
    await act(async () => { fireEvent.click(within(card.querySelector('.pm-soft-confirm') as HTMLElement).getByRole('button', { name: '保留 A' })) })
    act(() => { gateway.setView('pending', view(secret)) })
    const after = screen.getByRole('heading', { level: 3, name: '测试里怎么准备数据库，两条记忆互相矛盾' }).closest('article')!
    expect(after).toBe(card)
  })

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
    ruleConflict('保留 A')
    await screen.findByText('已保留「postgres-in-tests」')
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
    // 没处理过的卡不带结果卡的淡入
    expect(document.querySelector('.pm-pending-item--result')).toBeNull()
    ruleConflict('保留 A')
    await screen.findByText('已保留「postgres-in-tests」')
    const yourCall = screen.getByRole('region', { name: '等你决定 1' })
    expect(within(yourCall).getByText('已保留「postgres-in-tests」')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '先处理 1' })).toBeInTheDocument()
    // 标记列不空出来：处理完换成灰圆点，标题不往左跳
    expect(within(yourCall).getByText('已保留「postgres-in-tests」').closest('article')!.querySelector('.pm-pending-head .pm-marker--done')).not.toBeNull()
    expect(within(yourCall).getByText('已保留「postgres-in-tests」').closest('article')).toHaveClass('pm-pending-item--result')
  })
})

describe('待处理：各类卡', () => {

  it('横向冲突：A / B 原文、类型显示名；「保留 B」确认后发对应 verdict', async () => {
    const { commands } = setup([horizontal])
    const a = screen.getByRole('region', { name: '记忆 A' })
    expect(within(a).getByText('测试用真实 Postgres。')).toBeInTheDocument()
    expect(within(a).getByText('行为偏好')).toBeInTheDocument()
    ruleConflict('保留 B')
    await waitFor(() => { expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-right' }]) })
  })

  it('横向冲突：没有可采纳的建议时五个直接处理一排、不带说明行（后果写在各自的原位确认里），决定前按哪条写在标题下；结果带撤销', async () => {
    const { commands } = setup([horizontal])
    const row = screen.getByRole('button', { name: '确实不冲突' }).closest('.pm-conflict-actions')!
    expect([...row.querySelectorAll('button')].map(b => b.textContent)).toEqual(['保留 A', '保留 B', '并成版本', '确实不冲突', '记成例外'])
    expect(row.previousElementSibling).toBeNull()
    expect(screen.getByText('决定之前，agent 按你明确说过的 A 来做。')).toBeInTheDocument()
    expect(document.querySelector('.pm-keep-line')).toBeNull()
    ruleConflict('确实不冲突')
    await screen.findByText('按你的选择处理。两条都留着；它们都不变时，体检不再报这一对。')
    expect(screen.queryByRole('group')).toBeNull()
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'not-conflict' }])
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('偏好方不是你明确说过的：只写按哪条', () => {
    setup([{ ...horizontal, preferredId: 'b' } as PendingItem])
    expect(screen.getByText(/决定之前，agent 按 B 来做。/)).toBeInTheDocument()
  })

  it('垂直冲突：写明指令文件不会被改动、处理只针对这条记忆；直接处理原位确认后走裁决：「确实不冲突」= not-conflict、「以文件为准，删除这条」= keep-right', async () => {
    const { commands, gateway } = setup([vertical])
    expect(screen.getByText('指令文件不会被改动，处理只针对这条记忆。')).toBeInTheDocument()
    expect(screen.getByText('基线：AGENTS.md：用 pnpm')).toBeInTheDocument()
    ruleVertical('确实不冲突')
    await screen.findByText('已标为不冲突')
    act(() => { gateway.setView('pending', view(vertical)) })
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-v' }) })
    await screen.findByRole('button', { name: '以文件为准，删除这条' })
    ruleVertical('以文件为准，删除这条')
    await screen.findByText('这条记忆已删除，14 天内可恢复。')
    expect(commands()).toEqual([
      { cmd: 'resolve', decisionId: 'd-v', verdict: 'not-conflict' },
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
    expect(screen.getByText('之后由你自己维护：插件不再体检它，有效期也不再生效。')).toBeInTheDocument()
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

  it('候选在别的项目里：处理后结果卡的标题仍写项目名，和处理前一致', async () => {
    const other: PendingItem = { ...promote, memory: memory({ id: 'p2', workspacePath: '/w/blog' }) } as PendingItem
    setup([other])
    fireEvent.click(screen.getByRole('button', { name: '留在本项目' }))
    await screen.findByText('以后不再提示这条。')
    expect(screen.getByRole('heading', { name: 'blog 里的这条适合所有项目' })).toBeInTheDocument()
  })

  it('别的项目里的记忆：卡上元信息写项目名，不写「本项目」；本项目的照旧写「本项目」', () => {
    const other: PendingItem = { ...promote, memory: memory({ id: 'p2', workspacePath: '/w/blog' }) } as PendingItem
    const cross: PendingItem = { ...horizontal, right: memory({ id: 'b2', content: '博客里 mock 数据库。', workspacePath: '/w/blog' }) } as PendingItem
    const { container } = setup([other, cross])
    const metas = [...container.querySelectorAll('.pm-mc-meta')].map(el => el.textContent)
    expect(metas).toHaveLength(3)
    expect(metas[0]).toMatch(/^行为偏好blog你/)
    expect(metas[1]).toMatch(/^行为偏好本项目你/)
    expect(metas[2]).toMatch(/^行为偏好blog你/)
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

  it('超限：还没读到设置时「保存」的提示写正在读取设置，不写缺数字的「填一个比  大的整数」', () => {
    setup([overflow], { config: undefined })
    expect(screen.getByRole('button', { name: '保存' })).toHaveAttribute('title', '正在读取设置…')
  })

  it('超限：保存上限期间右上角的叉「不再提醒」不可用', async () => {
    const { gateway, commands } = setup([overflow])
    let finish: ((ok: boolean) => void) | undefined
    gateway.setConfig = () => new Promise<boolean>((resolve) => { finish = resolve })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    const dismiss = screen.getByRole('button', { name: '不再提醒' })
    expect(dismiss).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(dismiss)
    expect(commands()).toEqual([])
    await act(async () => { finish?.(true) })
    await screen.findByText('上限已调到 6,000')
  })

  it('严格模式超限：写 95%', () => {
    setup([{ ...overflow, mode: 'strict', tier: 0 } as PendingItem])
    expect(screen.getByText('已用到上限 4,000 的 95%，再多的记忆不会带入。')).toBeInTheDocument()
  })

  it('读不出的文件：相对路径 + 解析器原话；「打开文件」「在…中显示」走宿主打开', async () => {
    const { gateway } = setup([unreadable])
    expect(screen.getByText('app/broken.md')).toBeInTheDocument()
    expect(screen.getByText(unreadable.kind === 'unreadable-file' ? unreadable.error : '')).toBeInTheDocument()
    expect(screen.getByText('这个文件现在读不出来，里面的记忆不会带入对话。打开文件改好格式后，下次打开记忆页时这条提醒会消失，记忆恢复带入。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开文件' }))
    fireEvent.click(screen.getByRole('button', { name: /中显示/ }))
    await waitFor(() => { expect(gateway.opened).toEqual([{ path: '/m/app/broken.md' }, { path: '/m/app/broken.md', action: 'reveal' }]) })
  })

  it('命令失败：原话显示在卡片里', async () => {
    setup([promote], { respond: () => ({ ok: false, code: 'governance-disabled', detail: '体检已关闭，可在配置文件里把 governance.enabled 改成 true 打开' }) })
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('没有成功：体检已关闭，可在配置文件里把 governance.enabled 改成 true 打开')
  })
})
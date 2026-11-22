import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type AdviceType, type HealthView, type MemoryCard, type PendingItem } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { ALL_SCOPE, createNavStore, type PageScope } from '../nav.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'
import { SESSION, config, horizontal, secret, tidy, view, setup } from './test-pending.tsx'


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
    memory({ id: 'r1', name: 'pg-real', content: '左边的内容。', filePath: '/m/app/r1.md', digest: 'sha1:r1' }),
    memory({ id: 'r2', name: 'pg-mock', content: '右边的内容。', filePath: '/m/app/r2.md', digest: 'sha1:r2' }),
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
    // 卡片只带中性的基础样式类，没有标记、着色一类的修饰类
    const cards = within(groupOf()).getAllByRole('article')
    expect(cards).toHaveLength(4)
    for (const card of cards) expect([...card.classList]).toEqual(['pm-pending-item'])
  })

  // 动作行：退一步的幽灵按钮（「忽略」「打开文件」）排在最左，推荐的在最右
  it.each([
    ['已过有效期', expired, true, ['打开文件', '删除']],
    ['很久没确认', stale, false, ['打开文件', '删除', '仍然有效']],
    ['内容过长', bloat, true, ['打开文件', '修改']],
    ['指向的旧记忆已不在', orphan, true, ['打开文件']],
    ['内容重复', baselineDup, true, ['打开文件', '删除']],
    ['放错层', toGlobal, true, ['打开文件', '提升为全局']],
    ['放错层', toProject, true, ['打开文件', '移到项目…']],
    ['表述不清', unclear, true, ['打开文件', '修改']],
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
    // 结果卡两条都显示，不只左边那条
    const result = screen.getByText('不再扣分；内容改了会重新提醒。').closest('article')!
    expect(within(result).getByText('左边的内容。')).toBeInTheDocument()
    expect(within(result).getByText('右边的内容。')).toBeInTheDocument()
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
    expect(screen.getByText('这两条内容有重叠。说的是同一件事，留一条就够；各有要保留的细节，再用「合并」；其实是两件事，点右上角不再提醒。删掉的那条 14 天内可在「最近删除」恢复。')).toBeInTheDocument()
    const left = within(card).getByRole('region', { name: '左边这条' })
    const right = within(card).getByRole('region', { name: '右边这条' })
    expect(within(left).getByText('左边的内容。')).toBeInTheDocument()
    expect(within(right).getByText('右边的内容。')).toBeInTheDocument()
    expect(within(card).getAllByRole('button').map(b => b.textContent)).toEqual(['不再提醒', '打开文件', '删除左边', '打开文件', '删除右边', '合并'])
    for (const b of card.querySelectorAll('.pm-btn')) expect(b.classList.contains('pm-btn--ghost')).toBe(b.textContent === '打开文件')

    await act(async () => { fireEvent.click(within(right).getByRole('button', { name: '打开文件' })) })
    expect(gateway.opened).toEqual([{ path: '/m/app/r2.md' }])
    fireEvent.click(within(right).getByRole('button', { name: '删除右边' }))
    expect(commands()).toEqual([])
    fireEvent.click(confirmIn(right))
    await screen.findByText('已删除')
    expect(commands()).toEqual([{ cmd: 'forget', memoryId: 'r2', layer }])
    // 结果卡写明删的是哪一条
    expect(screen.getByText('「pg-mock」14 天内可在「最近删除」恢复。')).toBeInTheDocument()
  })

  it('三条以上互相重复：每条一栏，按钮写「删除」，栏名是记忆名', async () => {
    const { commands } = setup([{ kind: 'advice', level: 'advice', type: 'redundancy', memories: [...duplicates, memory({ id: 'r3', name: '第三条', scope: 'global', workspacePath: undefined })] }])
    const card = cardOf('内容重复')
    expect(screen.getByText('这几条内容有重叠。说的是同一件事，留一条就够；其实是不同的事，点右上角不再提醒。')).toBeInTheDocument()
    expect(within(card).getAllByRole('button').map(b => b.textContent)).toEqual(['不再提醒', '打开文件', '删除', '打开文件', '删除', '打开文件', '删除'])
    // 不能合并（跨了作用域）：卡片底部不留空的动作行
    expect(card.querySelector('.pm-pending-body > .pm-pending-actions')).toBeNull()
    const third = within(card).getByRole('region', { name: '第三条' })
    fireEvent.click(within(third).getByRole('button', { name: '删除' }))
    fireEvent.click(confirmIn(third))
    await screen.findByText('已删除')
    expect(commands()).toEqual([{ cmd: 'forget', memoryId: 'r3', layer: { kind: 'global' } }])
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
    expect(screen.getByText('「记忆 e1」14 天内可在「最近删除」恢复。')).toBeInTheDocument()
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
    const more = screen.getByRole('button', { name: '展开其余 2 条' })
    more.focus()
    fireEvent.click(more)
    expect(within(groupOf()).getAllByRole('article')).toHaveLength(7)
    expect(screen.queryByRole('button', { name: /展开其余/ })).toBeNull()
    // 按钮没了，焦点交给新露出的第一条，不掉回页首
    expect(document.activeElement).toBe(within(groupOf()).getAllByRole('article')[5]!.closest('.pm-pending-row'))
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
  const healthScope = (scope: HealthView['layers'][number]['layer'], ignored: HealthView['layers'][number]['ignored']): HealthView['layers'][number] => ({
    layer: scope, totalMemories: 3, score: 90, tier: 'green', gate: { secret: false }, issues: [], lastCheckupAt: NOW, ignored,
    deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } },
  })
  const app = { kind: 'workspace', workspacePath: '/w/app' } as const
  const health: HealthView = {
    version: GUI_VIEW_VERSION,
    governanceEnabled: true,
    layers: [
      healthScope({ kind: 'global' }, [{ type: 'unclear', memories: [{ id: 'g1', name: '模糊那条', summary: '' }] }]),
      healthScope(app, [
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
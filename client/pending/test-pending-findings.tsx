import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { type MemoryCommand, type MemoryCommandResult, type PendingItem, type Suggestion } from '../../src/gui/contract.ts'
import { createNavStore } from '../nav.ts'
import { memory, NOW } from '../test-utils.tsx'
import { A, B, horizontal, vertical, view, setup } from './test-pending.tsx'

// 体检的四种新发现（漏记的变化、例外提示、依据已变、跨项目重复）的卡，冲突卡的回查标记和新裁决（确实不冲突、记成例外、并成版本）。
// 断言卡上显示什么、每个按钮发出的命令和参数；每种卡只给自己能用的裁决（VERDICTS_BY_KIND），表外的组合不出按钮。

type Item<K extends PendingItem['kind']> = Extract<PendingItem, { kind: K }>

const OLD = memory({ id: 'old', name: 'port-8100', content: '服务监听 8100。', createdAt: NOW - 9 * 86_400_000 })
const NEW = memory({ id: 'new', name: 'port-8200', content: '服务监听 8200。', createdAt: NOW - 86_400_000 })
const missed: Item<'missed-change'> = { kind: 'missed-change', level: 'advice', decisionId: 'd-m', firstSeenAt: 1, summary: '端口从 8100 改成了 8200', left: OLD, right: NEW, current: 'new' }
const RULE = memory({ id: 'rule', name: 'pnpm-everywhere', content: '一律用 pnpm。', scope: 'global', workspacePath: undefined })
const NARROW = memory({ id: 'narrow', name: 'scripts-npm', content: 'scripts/ 下的老脚本用 npm。' })
const exception: Item<'exception'> = { kind: 'exception', level: 'advice', decisionId: 'd-e', firstSeenAt: 2, summary: '老脚本目录另用 npm', memories: [RULE, NARROW] }
const verticalException: Item<'exception'> = { kind: 'exception', level: 'advice', decisionId: 'd-e2', firstSeenAt: 3, summary: '这个项目的发布另有流程', memories: [NARROW], baselineRef: 'AGENTS.md：发布走 CI' }
const DECISION = memory({ id: 'dec', name: '暂停归档', type: 'decision', content: '归档容量够用，先暂停自动归档。' })
const PREMISE = memory({ id: 'cap', name: '归档容量', content: '归档盘只剩 5%。' })
const premise: Item<'premise-changed'> = { kind: 'premise-changed', level: 'your-call', decisionId: 'd-p', firstSeenAt: 4, summary: '「暂停归档」依据的「归档容量」改过了', decision: DECISION, premise: PREMISE }
const IN_APP = memory({ id: 'x', name: 'commit-style', content: '提交标题用祈使句。', workspacePath: '/w/app', filePath: '/m/app/x.md' })
const IN_BLOG = memory({ id: 'y', name: 'commit-style', content: '提交标题写成祈使句。', workspacePath: '/w/blog', filePath: '/m/blog/y.md' })
const cross: Item<'cross-duplicate'> = { kind: 'cross-duplicate', level: 'your-call', decisionId: 'd-x', firstSeenAt: 5, summary: '两个项目各记了一遍提交规范', memories: [IN_APP, IN_BLOG], promoteId: 'y' }

const cardOf = (title: string) => screen.getByRole('heading', { level: 3, name: title }).closest('article') as HTMLElement
/** 卡片的动作行（不含标题行右上角的叉、原位确认、选择面板）。 */
const actionsOf = (card: HTMLElement) => [...card.querySelectorAll(':scope .pm-pending-actions > button, :scope .pm-conflict-actions > button')].map(b => b.textContent)
const conflictCard = () => (screen.getByText(horizontal.summary).closest('.pm-pending-item') as HTMLElement)
const conflictRow = () => conflictCard().querySelector('.pm-conflict-actions') as HTMLElement
const labelsOf = (row: HTMLElement) => [...row.querySelectorAll('button')].map(b => b.textContent)
/** 所有裁决值对应的按钮名：表外的组合不出按钮。 */
const VERDICT_LABELS = ['保留 A', '保留 B', '都保留，不算冲突', '确实不冲突', '记成例外', '并成版本']

describe('处理视图：四种新发现的分组', () => {
  it('依据已变、跨项目重复在「等你决定」（排在冲突后面）；漏记的变化、例外提示在「可以整理」', () => {
    setup([horizontal, premise, cross, missed, exception])
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['等你决定 3', '可以整理 2'])
    expect(within(screen.getByRole('region', { name: '等你决定 3' })).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      horizontal.summary, '决定的依据改过了', '几个项目各记了同一件事',
    ])
    expect(within(screen.getByRole('region', { name: /^可以整理/ })).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual([
      '漏记了一次变化', '一条是另一条的例外',
    ])
    // 等你决定的两种带琥珀圆点，可以整理的两种不带标记
    expect(cardOf('决定的依据改过了').querySelector('.pm-pending-head .pm-marker--pending')).not.toBeNull()
    expect(cardOf('几个项目各记了同一件事').querySelector('.pm-pending-head .pm-marker--pending')).not.toBeNull()
    expect(cardOf('漏记了一次变化').querySelector('.pm-marker')).toBeNull()
    expect(cardOf('一条是另一条的例外').querySelector('.pm-marker')).toBeNull()
  })
})

describe('漏记的变化', () => {
  it('两条并排，建议留作当前的那条带标注；建议写明哪条是现在的、并成版本的后果；动作行只有「确实不冲突」「并成版本」，右上角是「不再提醒」', () => {
    setup([missed])
    const card = cardOf('漏记了一次变化')
    expect(within(card).getByText('服务监听 8100。')).toBeInTheDocument()
    expect(within(card).getByText('服务监听 8200。')).toBeInTheDocument()
    const current = within(card).getByText('建议留作当前')
    expect(current.closest('section')).toBe(within(card).getByRole('region', { name: 'port-8200' }))
    expect(within(card).getAllByText('建议留作当前')).toHaveLength(1)
    expect(within(card).getByText('端口从 8100 改成了 8200。「port-8200」像是现在的状态，「port-8100」是之前的。并成版本后「port-8100」成为「port-8200」的历史版本，不再带入对话，可以撤销；两条说的是不同的事，就点「确实不冲突」。')).toBeInTheDocument()
    expect(actionsOf(card)).toEqual(['确实不冲突', '并成版本'])
    expect(within(card).getByRole('button', { name: '不再提醒' })).toBeInTheDocument()
    for (const label of ['保留 A', '保留 B', '都保留，不算冲突', '记成例外']) expect(within(card).queryByRole('button', { name: label })).toBeNull()
  })

  it('「并成版本」先在卡里选留作当前的那条（默认是建议的那条），确认后发 resolve as-versions 带 current；结果写明谁并进了谁，带撤销', async () => {
    const { commands } = setup([missed])
    fireEvent.click(screen.getByRole('button', { name: '并成版本' }))
    const panel = screen.getByRole('group', { name: '哪条是现在的状态？' })
    expect(within(panel).getByRole('radio', { name: 'port-8200' })).toBeChecked()
    expect(within(panel).getByRole('radio', { name: 'port-8100' })).not.toBeChecked()
    expect(commands()).toEqual([])
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '并成版本' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-m', verdict: 'as-versions', current: 'new' }])
    expect(await screen.findByText('已并成版本')).toBeInTheDocument()
    expect(screen.getByText('「port-8100」成了「port-8200」的历史版本，不再带入对话。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-m' })
  })

  it('可以改选留作当前的那条；没有建议时默认选后记下的那条；「取消」收起、什么都不发', async () => {
    const { commands } = setup([{ ...missed, current: undefined } as PendingItem])
    expect(screen.queryByText('建议留作当前')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '并成版本' }))
    const panel = () => screen.getByRole('group', { name: '哪条是现在的状态？' })
    expect(within(panel()).getByRole('radio', { name: 'port-8200' })).toBeChecked()
    fireEvent.click(within(panel()).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('group', { name: '哪条是现在的状态？' })).toBeNull()
    expect(commands()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '并成版本' }))
    fireEvent.click(within(panel()).getByRole('radio', { name: 'port-8100' }))
    await act(async () => { fireEvent.click(within(panel()).getByRole('button', { name: '并成版本' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-m', verdict: 'as-versions', current: 'old' }])
  })

  it('「确实不冲突」发 resolve not-conflict；右上角「不再提醒」发 resolve dismiss；两种结果都能撤销', async () => {
    const first = setup([missed])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确实不冲突' })) })
    expect(first.commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-m', verdict: 'not-conflict' }])
    expect(await screen.findByText('已标为不冲突')).toBeInTheDocument()
    expect(screen.getByText('两条都留着；它们都不变时，体检不再报这一对。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
    first.unmount()

    const second = setup([missed])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提醒' })) })
    expect(second.commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-m', verdict: 'dismiss' }])
    expect(await screen.findByText('这几条都不变时不再提醒。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(second.commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-m' })
  })
})

describe('漏记的变化：面板与失败', () => {
  it('选择面板开着时有一条变成读不到：面板收起，右上角「不再提醒」回来', () => {
    const { gateway } = setup([missed])
    fireEvent.click(screen.getByRole('button', { name: '并成版本' }))
    expect(screen.getByRole('group', { name: '哪条是现在的状态？' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '不再提醒' })).toBeNull()
    act(() => { gateway.setView('pending', view({ ...missed, left: null } as PendingItem)) })
    expect(screen.queryByRole('group', { name: '哪条是现在的状态？' })).toBeNull()
    expect(screen.getByRole('button', { name: '不再提醒' })).toBeInTheDocument()
  })

  it('并成版本回 stale（两条体检后改过或不在用）：卡上写这次没处理、下次体检会重新判断，不写「重新打开修改」', async () => {
    setup([missed], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '这两条记忆已改变或不在用，保留条目，请重新体检。' }) as MemoryCommandResult })
    fireEvent.click(screen.getByRole('button', { name: '并成版本' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('group', { name: '哪条是现在的状态？' })).getByRole('button', { name: '并成版本' })) })
    expect(await screen.findByText(/这两条在体检之后改过或不在用了，这次没有处理。下次体检会重新判断。/)).toBeInTheDocument()
    expect(screen.queryByText(/重新打开修改/)).toBeNull()
  })
})

describe('例外提示', () => {
  it('横向两条并排、建议写明怎么用；只有右上角「不再提醒」，没有动作行；点了发 resolve dismiss', async () => {
    const { commands } = setup([exception])
    const card = cardOf('一条是另一条的例外')
    expect(within(card).getByText('一律用 pnpm。')).toBeInTheDocument()
    expect(within(card).getByText('scripts/ 下的老脚本用 npm。')).toBeInTheDocument()
    expect(within(card).getByText('老脚本目录另用 npm。两条都对：在更窄的范围里按它来，其余照通用的那条。看过了就点右上角不再提醒。')).toBeInTheDocument()
    expect(actionsOf(card)).toEqual([])
    for (const label of VERDICT_LABELS) expect(within(card).queryByRole('button', { name: label })).toBeNull()
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '不再提醒' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-e', verdict: 'dismiss' }])
    expect(await screen.findByText('这几条都不变时不再提醒。')).toBeInTheDocument()
  })

  it('纵向（一条记忆加指令文件出处）：标题和说明写这条记忆和指令文件，写出指令文件里的出处；不再提醒后的结果也这样写', async () => {
    setup([verticalException])
    const card = cardOf('这条记忆是指令文件的例外')
    expect(within(card).getByText('指令文件：AGENTS.md：发布走 CI')).toBeInTheDocument()
    expect(within(card).getByText('scripts/ 下的老脚本用 npm。')).toBeInTheDocument()
    expect(within(card).getByText('这个项目的发布另有流程。两边都对：在这条记忆管的范围里按它来，其余照指令文件。看过了就点右上角不再提醒。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '不再提醒' })) })
    expect(await screen.findByText('这条记忆和指令文件都不变时不再提醒。')).toBeInTheDocument()
  })
})

describe('依据已变', () => {
  it('决定和它依据的那条分开标出；说明请你复查；动作行只有「仍然成立」，发 resolve dismiss；结果带撤销', async () => {
    const { commands } = setup([premise])
    const card = cardOf('决定的依据改过了')
    expect(within(within(card).getByRole('region', { name: '决定' })).getByText('归档容量够用，先暂停自动归档。')).toBeInTheDocument()
    expect(within(within(card).getByRole('region', { name: '依据' })).getByText('归档盘只剩 5%。')).toBeInTheDocument()
    expect(within(card).getByText(/「归档容量」在这条决定记下之后改过了，复查「暂停归档」还成不成立。/)).toBeInTheDocument()
    expect(actionsOf(card)).toEqual(['仍然成立'])
    for (const label of VERDICT_LABELS) expect(within(card).queryByRole('button', { name: label })).toBeNull()
    expect(within(card).queryByRole('button', { name: '不再提醒' })).toBeNull()
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '仍然成立' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-p', verdict: 'dismiss' }])
    expect(await screen.findByText('已复查')).toBeInTheDocument()
    expect(screen.getByText('仍按这条决定来；依据再改时会再提醒你。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-p' })
  })

  it('「去改这条决定 ›」跳到记忆查看、定位到这条决定，不发命令', () => {
    const nav = createNavStore()
    const { commands } = setup([premise], {}, nav)
    fireEvent.click(screen.getByRole('button', { name: '去改这条决定 ›' }))
    expect(nav.get()).toMatchObject({ view: 'library', scope: { kind: 'workspace', workspacePath: '/w/app' }, memoryId: 'dec' })
    expect(commands()).toEqual([])
  })
})

describe('跨项目重复', () => {
  const promoted = (command: MemoryCommand): MemoryCommandResult =>
    (command.cmd === 'promote-memory' ? { ok: true, cmd: 'promote-memory', decisionId: 'pd_promote', memoryIds: [command.memoryId] } : { ok: true, cmd: command.cmd }) as MemoryCommandResult

  it('各项目里的那几条都标出项目名，建议提升的那条带标注；动作行「留在各自项目」「提升为全局」', () => {
    setup([cross])
    const card = cardOf('几个项目各记了同一件事')
    expect(within(within(card).getByRole('region', { name: 'commit-style · app' })).getByText('提交标题用祈使句。')).toBeInTheDocument()
    const blog = within(card).getByRole('region', { name: 'commit-style · blog' })
    expect(within(blog).getByText('blog')).toBeInTheDocument()
    expect(within(blog).getByText('建议提升这条')).toBeInTheDocument()
    expect(within(card).getAllByText('建议提升这条')).toHaveLength(1)
    expect(actionsOf(card)).toEqual(['留在各自项目', '提升为全局'])
    for (const label of VERDICT_LABELS) expect(within(card).queryByRole('button', { name: label })).toBeNull()
  })

  it('「提升为全局」先选提升哪一条（默认是建议的那条），确认后走现有的按记忆提升；结果按提升那一笔撤销', async () => {
    const { commands } = setup([cross], { respond: promoted })
    fireEvent.click(screen.getByRole('button', { name: '提升为全局' }))
    const panel = screen.getByRole('group', { name: '提升哪一条？' })
    expect(within(panel).getByRole('radio', { name: 'commit-style · blog' })).toBeChecked()
    fireEvent.click(within(panel).getByRole('radio', { name: 'commit-style · app' }))
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '提升为全局' })) })
    expect(commands()).toEqual([{ cmd: 'promote-memory', memoryId: 'x', layer: { kind: 'workspace', workspacePath: '/w/app' } }])
    expect(await screen.findByText('已提升为全局')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'pd_promote' })
  })

  it('成员所在项目这次没读全、没读到的那条（null）：写找不到，提升只能选读到的那条', () => {
    setup([{ ...cross, memories: [IN_APP, null], promoteId: undefined } as PendingItem])
    const card = cardOf('几个项目各记了同一件事')
    expect(within(card).getByText('这条记忆找不到了，可能已经被删除。')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: '提升为全局' }))
    expect(within(screen.getByRole('group', { name: '提升哪一条？' })).getAllByRole('radio').map(r => r.closest('label')?.textContent)).toEqual(['commit-style · app'])
  })

  it('「留在各自项目」发 resolve dismiss；结果带撤销', async () => {
    const { commands } = setup([cross])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '留在各自项目' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-x', verdict: 'dismiss' }])
    expect(await screen.findByText('这几条都不变时不再提醒。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })
})

describe('四种发现的说明句', () => {
  it('摘要自带句末标点（末尾带空白也算）时不再补句号', () => {
    setup([
      { ...missed, summary: '端口从 8100 改成了 8200。' },
      { ...exception, summary: '老脚本目录另用 npm！ ' },
      { ...premise, summary: '「暂停归档」的依据改过了？', decision: null },
      { ...cross, summary: 'Two projects keep the same rule.' },
    ])
    expect(screen.getByText(/^端口从 8100 改成了 8200。「port-8200」像是现在的状态/)).toBeInTheDocument()
    expect(screen.getByText('老脚本目录另用 npm！两条都对：在更窄的范围里按它来，其余照通用的那条。看过了就点右上角不再提醒。')).toBeInTheDocument()
    expect(screen.getByText('「暂停归档」的依据改过了？')).toBeInTheDocument()
    expect(screen.getByText(/^Two projects keep the same rule\.提升为全局后/)).toBeInTheDocument()
  })
})

describe('冲突：回查标记与新裁决', () => {
  it.each([
    ['unreadable', '出处读不到'],
    ['unchecked', '出处这次没读'],
  ] as const)('回查结果 %s：标题行标「%s」', (sourceCheck, label) => {
    setup([{ ...horizontal, sourceCheck } as PendingItem])
    const head = conflictCard().querySelector('.pm-conflict-head, header') as HTMLElement
    expect(within(head).getByText(label)).toBeInTheDocument()
  })

  it('回查过、两边都读到（checked）和没回查过的：都不标', () => {
    const first = setup([{ ...horizontal, sourceCheck: 'checked' } as PendingItem])
    for (const label of ['出处读不到', '出处这次没读', '已对照出处']) expect(screen.queryByText(label)).toBeNull()
    first.unmount()
    setup([horizontal])
    for (const label of ['出处读不到', '出处这次没读', '已对照出处']) expect(screen.queryByText(label)).toBeNull()
  })

  it('直接处理一排：保留 A、保留 B、并成版本、确实不冲突、记成例外（「都保留」拆成确实不冲突和记成例外）', () => {
    setup([horizontal])
    expect(labelsOf(conflictRow())).toEqual(['保留 A', '保留 B', '并成版本', '确实不冲突', '记成例外'])
  })

  it.each([
    ['确实不冲突', '确实不冲突？两条都留着，以后体检不再报它们', 'not-conflict', '已标为不冲突'],
    ['记成例外', '记成例外？两条都留着，以后体检不再报它们', 'exception', '已记成例外'],
  ] as const)('「%s」原位确认后发对应裁决；结果带撤销', async (label, question, verdict, chip) => {
    const { commands } = setup([horizontal])
    fireEvent.click(within(conflictRow()).getByRole('button', { name: label }))
    expect(commands()).toEqual([])
    await act(async () => { fireEvent.click(within(screen.getByRole('group', { name: question })).getByRole('button', { name: label })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict }])
    expect(await screen.findByText(chip)).toBeInTheDocument()
    expect(screen.getByText('按你的选择处理。两条都留着；它们都不变时，体检不再报这一对。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('「并成版本」在卡里选留作当前的那条（默认后记下的那条，可改选），确认后发 resolve as-versions 带 current', async () => {
    const older = { ...A, createdAt: NOW - 5 * 86_400_000 }
    const newer = { ...B, createdAt: NOW - 86_400_000 }
    const { commands } = setup([{ ...horizontal, left: older, right: newer } as PendingItem])
    fireEvent.click(within(conflictRow()).getByRole('button', { name: '并成版本' }))
    const panel = screen.getByRole('group', { name: '哪条是现在的状态？' })
    expect(within(panel).getByRole('radio', { name: 'B · mock-db-in-tests' })).toBeChecked()
    fireEvent.click(within(panel).getByRole('radio', { name: 'A · postgres-in-tests' }))
    await act(async () => { fireEvent.click(within(panel).getByRole('button', { name: '并成版本' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'as-versions', current: 'a' }])
    expect(await screen.findByText('已并成版本')).toBeInTheDocument()
    expect(screen.getByText('按你的选择处理。「mock-db-in-tests」成了「postgres-in-tests」的历史版本，不再带入对话。')).toBeInTheDocument()
  })

  it('有建议时直接并成版本回 stale：说明这次没处理、下次体检会重新判断；建议照旧在，不当成建议失效', async () => {
    const keepA: Suggestion = { id: 'sg_1', action: 'keep-a', reason: 'A 是你明确说过的。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] }
    const item = { ...horizontal, left: { ...A, digest: 'sha1:a' }, right: { ...B, digest: 'sha1:b' }, suggestion: keepA } as PendingItem
    setup([item], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '这两条记忆已改变或不在用，保留条目，请重新体检。' }) as MemoryCommandResult })
    fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
    fireEvent.click(within(screen.getByRole('group', { name: '常用处理（可选）' })).getByRole('button', { name: '并成版本' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('group', { name: '哪条是现在的状态？' })).getByRole('button', { name: '并成版本' })) })
    expect(await screen.findByText(/这两条在体检之后改过或不在用了，这次没有处理。下次体检会重新判断。/)).toBeInTheDocument()
    expect(screen.queryByText(/建议已失效/)).toBeNull()
    expect(screen.getByText('A 是你明确说过的。')).toBeInTheDocument()
  })

  it('有建议、能补充要求时：常用处理里是保留 A、保留 B、两者融合、并成版本、确实不冲突、记成例外；「记成例外」交回卡片原位确认', async () => {
    const keepA: Suggestion = { id: 'sg_1', action: 'keep-a', reason: 'A 是你明确说过的。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] }
    const item = { ...horizontal, left: { ...A, digest: 'sha1:a' }, right: { ...B, digest: 'sha1:b' }, suggestion: keepA } as PendingItem
    const { commands } = setup([item])
    fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
    const candidates = screen.getByRole('group', { name: '常用处理（可选）' })
    expect(within(candidates).getAllByRole('button').map(b => b.textContent)).toEqual(['保留 A', '保留 B', '两者融合', '并成版本', '确实不冲突', '记成例外'])
    fireEvent.click(within(candidates).getByRole('button', { name: '记成例外' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('group', { name: '记成例外？两条都留着，以后体检不再报它们' })).getByRole('button', { name: '记成例外' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'exception' }])
  })
})

describe('垂直冲突：「都保留」拆成确实不冲突和记成例外', () => {
  const V = memory({ id: 'v', content: '用 npm。', digest: 'sha1:v', updatedAt: 333 })
  const verticalCard = () => (screen.getByText(vertical.summary).closest('.pm-pending-item') as HTMLElement)
  const verticalRow = () => verticalCard().querySelector('.pm-conflict-actions') as HTMLElement

  it('直接处理一排：以文件为准，删除这条、确实不冲突、记成例外；没有「并成版本」，也没有「都保留，不算冲突」', () => {
    setup([vertical])
    expect(labelsOf(verticalRow())).toEqual(['以文件为准，删除这条', '确实不冲突', '记成例外'])
    for (const label of ['并成版本', '都保留，不算冲突']) expect(within(verticalCard()).queryByRole('button', { name: label })).toBeNull()
  })

  it.each([
    ['确实不冲突', '确实不冲突？这条记忆和指令文件都留着，以后体检不再报它们', 'not-conflict', '已标为不冲突'],
    ['记成例外', '记成例外？这条记忆和指令文件都留着，以后体检不再报它们', 'exception', '已记成例外'],
  ] as const)('「%s」原位确认后发对应裁决；问句和结果写这条记忆和指令文件，带撤销', async (label, question, verdict, chip) => {
    const { commands } = setup([vertical])
    fireEvent.click(within(verticalRow()).getByRole('button', { name: label }))
    expect(commands()).toEqual([])
    await act(async () => { fireEvent.click(within(screen.getByRole('group', { name: question })).getByRole('button', { name: label })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-v', verdict }])
    expect(await screen.findByText(chip)).toBeInTheDocument()
    expect(screen.getByText('这条记忆和指令文件都留着；它们都不变时，体检不再报。')).toBeInTheDocument()
    expect(screen.queryByText(/两条|这一对/)).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-v' })
  })

  it('补充要求的常用处理：以文件为准，删除这条、改写这条记忆、确实不冲突、记成例外；「确实不冲突」交回卡片原位确认', async () => {
    const { commands } = setup([{ ...vertical, memory: V, noSuggestion: { code: 'not-generated' } } as PendingItem])
    fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
    const candidates = screen.getByRole('group', { name: '常用处理（可选）' })
    expect(within(candidates).getAllByRole('button').map(b => b.textContent)).toEqual(['以文件为准，删除这条', '改写这条记忆', '确实不冲突', '记成例外'])
    fireEvent.click(within(candidates).getByRole('button', { name: '确实不冲突' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('group', { name: '确实不冲突？这条记忆和指令文件都留着，以后体检不再报它们' })).getByRole('button', { name: '确实不冲突' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-v', verdict: 'not-conflict' }])
  })
})

describe('同一条目换了种类', () => {
  const conflictSameId = (): PendingItem => ({ ...horizontal, decisionId: 'd-m' }) as PendingItem

  it('漏记的变化点了「不再提醒」、视图刷掉它之后，同一 id 又挂出冲突：结果卡让位，新冲突的直接处理照常出', async () => {
    const { gateway } = setup([missed])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提醒' })) })
    expect(await screen.findByText('这几条都不变时不再提醒。')).toBeInTheDocument()
    act(() => { gateway.setView('pending', view()) })
    expect(screen.getByText('这几条都不变时不再提醒。')).toBeInTheDocument()
    act(() => { gateway.setView('pending', view(conflictSameId())) })
    expect(screen.queryByText('这几条都不变时不再提醒。')).toBeNull()
    expect(labelsOf(conflictRow())).toEqual(['保留 A', '保留 B', '并成版本', '确实不冲突', '记成例外'])
  })

  it('命令刚成功、视图还没刷新时仍是旧的那条：结果卡留着，旧卡不回来', async () => {
    const { gateway } = setup([missed])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提醒' })) })
    expect(await screen.findByText('这几条都不变时不再提醒。')).toBeInTheDocument()
    act(() => { gateway.setView('pending', view(missed)) })
    expect(screen.getByText('这几条都不变时不再提醒。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '并成版本' })).toBeNull()
  })

  it('旧种类的命令迟到成功时，视图里已经是同一 id 的新种类：新卡留着，不被旧结果遮住', async () => {
    let finish: (result: MemoryCommandResult) => void = () => {}
    const { gateway, commands } = setup([missed], { respond: () => new Promise<MemoryCommandResult>((resolve) => { finish = resolve }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '不再提醒' })) })
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-m', verdict: 'dismiss' }])
    act(() => { gateway.setView('pending', view(conflictSameId())) })
    await act(async () => { finish({ ok: true, cmd: 'resolve', decisionId: 'd-m' } as MemoryCommandResult) })
    expect(screen.queryByText('这几条都不变时不再提醒。')).toBeNull()
    expect(labelsOf(conflictRow())).toEqual(['保留 A', '保留 B', '并成版本', '确实不冲突', '记成例外'])
  })

  it('冲突卡上写了一半的补充要求：体检把这一对改判成漏记的变化后换成新种类的卡，原来的草稿不带过去，改判回冲突时也不再出现', () => {
    const keepA: Suggestion = { id: 'sg_1', action: 'keep-a', reason: 'A 是你明确说过的。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] }
    const conflict = { ...horizontal, left: { ...A, digest: 'sha1:a' }, right: { ...B, digest: 'sha1:b' }, suggestion: keepA } as PendingItem
    const { gateway } = setup([conflict])
    fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
    fireEvent.change(screen.getByRole('textbox', { name: '想怎么处理这两条？' }), { target: { value: '写了一半的要求' } })
    expect(screen.getByDisplayValue('写了一半的要求')).toBeInTheDocument()

    const changed: PendingItem = { kind: 'missed-change', level: 'advice', decisionId: 'd-h', firstSeenAt: 1, summary: '数据库准备方式变过', left: A, right: B, current: 'b' }
    act(() => { gateway.setView('pending', view(changed)) })
    expect(cardOf('漏记了一次变化')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '想怎么处理这两条？' })).toBeNull()
    expect(screen.queryByDisplayValue('写了一半的要求')).toBeNull()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()

    act(() => { gateway.setView('pending', view(conflict)) })
    expect(labelsOf(conflictRow())).toEqual(['采纳建议', '补充要求'])
    expect(screen.queryByRole('textbox', { name: '想怎么处理这两条？' })).toBeNull()
    expect(screen.queryByDisplayValue('写了一半的要求')).toBeNull()
  })
})

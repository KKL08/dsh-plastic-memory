import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type MemoryCommand, type MemoryCommandResult, type PendingItem, type Suggestion } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { ALL_SCOPE, createNavStore } from '../nav.ts'
import { memory, NOW } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { SESSION, config, A, B, horizontal, vertical, view, scannedHealth, setup } from './test-pending.tsx'


describe('横向冲突卡：补充要求（票 07）', () => {
  type Horizontal = Extract<PendingItem, { kind: 'conflict-horizontal' }>
  // 视图里的卡都带内容摘要；补充要求要带卡片版本，没有摘要的卡不给这个入口
  const A2 = { ...A, digest: 'sha1:a', updatedAt: 111 }
  const B2 = { ...B, digest: 'sha1:b', updatedAt: 222 }
  const card = (extra: Partial<Horizontal> = {}): PendingItem => ({ ...horizontal, left: A2, right: B2, ...extra }) as PendingItem
  const keepA: Suggestion = { id: 'sg_1', action: 'keep-a', reason: 'A 是你明确说过的，B 是推断的。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] }
  const DIRECT = ['保留 A', '保留 B', '并成版本', '确实不冲突', '记成例外']
  const CANDIDATES = ['保留 A', '保留 B', '两者融合', '并成版本', '确实不冲突', '记成例外']
  const BASES = [{ updatedAt: 111, digest: 'sha1:a' }, { updatedAt: 222, digest: 'sha1:b' }]
  const basis = { conflictFingerprint: 'cf', memories: [{ memoryId: 'a', fingerprint: 'fa', scopeKey: 'w' }, { memoryId: 'b', fingerprint: 'fb', scopeKey: 'w' }] }
  const MERGED_TEXT = '集成测试用真实 Postgres，单元测试可以 mock 数据库。'
  const mergeProposal = {
    action: 'merge', reason: '照你说的写清了各自的场景。', basis,
    ops: [{ kind: 'edit', memoryId: 'a', content: MERGED_TEXT, name: A.name, summary: A.summary, tags: [] }, { kind: 'forget', memoryId: 'b' }],
  } as const
  const keepAProposal = { action: 'keep-a', reason: '你要以 A 为准。', basis, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] } as const
  const keepBothProposal = { action: 'keep-both', reason: '你说两条都对。', basis, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'keep', memoryId: 'b' }] } as const
  const drafted = (proposal: object) => (command: MemoryCommand): MemoryCommandResult => (command.cmd === 'draft-proposal'
    ? { ok: true, cmd: 'draft-proposal', proposal, model: 'deepseek-v4-flash' }
    : { ok: true, cmd: command.cmd, decisionId: 'd-h', memoryIds: ['a', 'b'], snapshotId: 'snap' }) as MemoryCommandResult
  const rowOf = () => document.querySelector('.pm-conflict-actions') as HTMLElement | null
  const labelsOf = (row: HTMLElement) => [...row.querySelectorAll('button')].map(b => b.textContent)
  const box = () => screen.getByRole('textbox', { name: '想怎么处理这两条？' })
  const open = () => { fireEvent.click(screen.getByRole('button', { name: '补充要求' })) }
  const write = (text: string) => { fireEvent.change(box(), { target: { value: text } }) }
  const generate = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成处理方案' })) }) }
  const footLabels = () => [...(document.querySelector('.pm-proposal .pm-edit-foot') as HTMLElement).querySelectorAll('button')].map(b => b.textContent)

  it('有建议：按钮行是「采纳建议」「补充要求」（直接处理挪进候选项）；没有建议：五个直接处理加「补充要求」；含密钥或卡上没有版本：只有五个直接处理', () => {
    const first = setup([card({ suggestion: keepA })])
    expect(labelsOf(rowOf()!)).toEqual(['采纳建议', '补充要求'])
    expect(screen.getByRole('button', { name: '补充要求' })).not.toHaveClass('pm-btn--primary')
    first.unmount()
    const second = setup([card({ noSuggestion: { code: 'not-generated' } })])
    expect(labelsOf(rowOf()!)).toEqual([...DIRECT, '补充要求'])
    second.unmount()
    const third = setup([card({ right: { ...B2, hasSecret: true }, noSuggestion: { code: 'has-secret' } })])
    expect(labelsOf(rowOf()!)).toEqual(DIRECT)
    third.unmount()
    setup([withoutDigest({ suggestion: keepA })])
    expect(labelsOf(rowOf()!)).toEqual(['采纳建议', ...DIRECT])
  })
  const withoutDigest = (extra: Partial<Horizontal>): PendingItem => ({ ...horizontal, ...extra }) as PendingItem

  it('这个会话已知拿不到模型（同页别处问过）：有建议时「采纳建议」后面是五个直接处理，没有建议时只有五个直接处理，都不给「补充要求」', () => {
    const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 'bl', digest: 'sha1:bl' })] }
    const other: PendingItem = { ...card({ noSuggestion: { code: 'not-generated' } }), decisionId: 'd-h2', summary: '另一条冲突' } as PendingItem
    setup([card({ suggestion: keepA }), other, bloat], { model: null })
    const rowIn = (title: string) => (screen.getByText(title).closest('.pm-pending-item') as HTMLElement).querySelector('.pm-conflict-actions') as HTMLElement
    expect(labelsOf(rowIn(horizontal.summary))).toEqual(['采纳建议', '补充要求'])
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    expect(labelsOf(rowIn(horizontal.summary))).toEqual(['采纳建议', ...DIRECT])
    expect(labelsOf(rowIn('另一条冲突'))).toEqual(DIRECT)
    expect(screen.queryByRole('button', { name: '补充要求' })).toBeNull()
  })

  it('点「补充要求」：按钮行换成输入区（标签、常用处理、文本框、说明）；空着时「生成处理方案」置灰并提示；「取消」回到原来的按钮', () => {
    const { commands } = setup([card({ suggestion: keepA })], { model: 'deepseek-v4-flash' })
    open()
    expect(rowOf()).toBeNull()
    expect(screen.queryByText('采纳后「mock-db-in-tests」进最近删除，14 天内可恢复。')).toBeNull()
    expect(box()).toHaveValue('')
    expect(box()).toHaveAttribute('placeholder', '也可以直接写你的要求，例如：以 A 为准，但把 B 里的端口号并进来。')
    expect(within(screen.getByRole('group', { name: '常用处理（可选）' })).getAllByRole('button').map(b => b.textContent)).toEqual(CANDIDATES)
    expect(screen.getByText('模型按两条原文和你的要求给出处理方案，先给你看结果再决定。它只用原文和你写的信息。会消耗少量 token。')).toBeInTheDocument()
    expect(footLabels()).toEqual(['取消', '生成处理方案'])
    expect(screen.getByRole('button', { name: '生成处理方案' })).toHaveClass('pm-btn--primary')
    expect(screen.getByRole('button', { name: '生成处理方案' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getAllByText('先写要求，或从常用处理里选一个').length).toBeGreaterThan(0)
    write('以 A 为准')
    expect(screen.getByRole('button', { name: '生成处理方案' })).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(labelsOf(rowOf()!)).toEqual(['采纳建议', '补充要求'])
    expect(commands()).toEqual([])
  })

  it('文本框有内容时底栏只写「用当前模型 {模型} 生成」；清空后换回提示', () => {
    setup([card({ suggestion: keepA })], { model: 'deepseek-v4-flash' })
    open()
    const hint = () => document.querySelector('.pm-proposal .pm-edit-foot .pm-edit-hint')
    write('以 A 为准')
    expect(hint()).toHaveTextContent(/^用当前模型 deepseek-v4-flash 生成$/)
    write('')
    expect(hint()).toHaveTextContent(/^先写要求，或从常用处理里选一个$/)
  })

  it('「两者融合」把要求填进文本框，可以接着改；生成发 draft-proposal（条目 id、要求、两条的卡片版本）', async () => {
    const { commands } = setup([card({ suggestion: keepA })], { respond: drafted(mergeProposal) })
    open()
    fireEvent.click(within(screen.getByRole('group', { name: '常用处理（可选）' })).getByRole('button', { name: '两者融合' }))
    expect(box()).toHaveValue('把两条融合成一条，写清各自适用的条件。')
    write('把两条融合成一条，写清各自适用的条件。集成测试那条为准。')
    await generate()
    expect(commands()).toEqual([{ cmd: 'draft-proposal', decisionId: 'd-h', request: '把两条融合成一条，写清各自适用的条件。集成测试那条为准。', bases: BASES }])
  })

  it('候选项「保留 A」不过模型：原位确认后走现有裁决；确认里点「取消」回到输入区，写的要求还在', async () => {
    const { commands } = setup([card({ suggestion: keepA })])
    open()
    write('先写一半')
    fireEvent.click(within(screen.getByRole('group', { name: '常用处理（可选）' })).getByRole('button', { name: '保留 A' }))
    const group = screen.getByRole('group', { name: '保留 A，B 进最近删除？' })
    fireEvent.click(within(group).getByRole('button', { name: '取消' }))
    expect(box()).toHaveValue('先写一半')
    fireEvent.click(within(screen.getByRole('group', { name: '常用处理（可选）' })).getByRole('button', { name: '确实不冲突' }))
    fireEvent.click(within(screen.getByRole('group', { name: '确实不冲突？两条都留着，以后体检不再报它们' })).getByRole('button', { name: '确实不冲突' }))
    expect(await screen.findByText('已标为不冲突')).toBeInTheDocument()
    expect(screen.getByText('按你的选择处理。两条都留着；它们都不变时，体检不再报这一对。')).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'not-conflict' }])
  })

  it('融合方案：结论和说明，写进哪条，原文和融合稿对照；按钮「取消」「改要求」「应用」；应用发 apply-proposal 带方案，结果卡写「按你的要求处理。」、可撤销', async () => {
    const { commands } = setup([card({ suggestion: keepA })], { respond: drafted(mergeProposal) })
    open()
    write('两者融合')
    await generate()
    const area = document.querySelector('.pm-proposal') as HTMLElement
    expect(within(area).getByText('融合成一条').tagName).toBe('STRONG')
    expect(within(area).getByText('照你说的写清了各自的场景。')).toBeInTheDocument()
    expect(within(area).getByText('融合后（写进 A，B 进最近删除）')).toBeInTheDocument()
    expect(within(area).getByRole('region', { name: '原文' })).toBeInTheDocument()
    expect(within(area).getByRole('region', { name: '改后' })).toHaveTextContent(MERGED_TEXT)
    expect(footLabels()).toEqual(['取消', '改要求', '应用'])
    expect(commands()).toEqual([{ cmd: 'draft-proposal', decisionId: 'd-h', request: '两者融合', bases: BASES }])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'apply-proposal', decisionId: 'd-h', proposal: mergeProposal })
    expect(await screen.findByText('已融合成一条')).toBeInTheDocument()
    expect(screen.getByText('按你的要求处理。「mock-db-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
    expect(screen.getByText(MERGED_TEXT)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-h' }) })
  })

  it('看方案时点「取消」：方案收起，回到建议态（建议块、说明行和「采纳建议」「补充要求」都在），什么都不发', async () => {
    const { commands } = setup([card({ suggestion: keepA })], { respond: drafted(mergeProposal) })
    open()
    write('两者融合')
    await generate()
    expect(footLabels()).toEqual(['取消', '改要求', '应用'])
    fireEvent.click(within(document.querySelector('.pm-proposal') as HTMLElement).getByRole('button', { name: '取消' }))
    expect(document.querySelector('.pm-proposal')).toBeNull()
    expect(screen.queryByRole('textbox', { name: '想怎么处理这两条？' })).toBeNull()
    expect(within(document.querySelector('.pm-suggestion') as HTMLElement).getByText('A 是你明确说过的，B 是推断的。')).toBeInTheDocument()
    expect(screen.getByText('采纳后「mock-db-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    expect(labelsOf(rowOf()!)).toEqual(['采纳建议', '补充要求'])
    expect(commands()).toEqual([{ cmd: 'draft-proposal', decisionId: 'd-h', request: '两者融合', bases: BASES }])
  })

  it('只留一条的方案、要删的那条变成含密钥（版本没变也一样）：方案区收起，不再给「应用」，也就不会写「进最近删除」', async () => {
    const { gateway } = setup([card({ noSuggestion: { code: 'not-generated' } })], { respond: drafted(keepAProposal) })
    open()
    write('以 A 为准')
    await generate()
    expect(screen.getByText('应用后「mock-db-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    act(() => { gateway.setView('pending', view(card({ noSuggestion: { code: 'not-generated' }, right: { ...B2, hasSecret: true } }))) })
    expect(document.querySelector('.pm-proposal')).toBeNull()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect(screen.queryByText(/进最近删除/)).toBeNull()
  })

  it('只留一条的方案：留下的那条原样显示、另一条用名称写进最近删除；应用后写保留了哪条、「按你的要求处理。」', async () => {
    const { commands } = setup([card({ noSuggestion: { code: 'not-generated' } })], { respond: drafted(keepAProposal) })
    open()
    write('以 A 为准')
    await generate()
    const area = document.querySelector('.pm-proposal') as HTMLElement
    expect(within(area).getByText('保留 A').tagName).toBe('STRONG')
    expect(within(area).getByText(A.content)).toBeInTheDocument()
    expect(within(area).getByText('应用后「mock-db-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'apply-proposal', decisionId: 'd-h', proposal: keepAProposal })
    expect(await screen.findByText('已保留「postgres-in-tests」')).toBeInTheDocument()
    expect(screen.getByText('按你的要求处理。「mock-db-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
  })

  it('都保留的方案：一句话；应用后「两条都保留」「按你的要求处理。」', async () => {
    setup([card({ suggestion: keepA })], { respond: drafted(keepBothProposal) })
    open()
    write('两条都对')
    await generate()
    expect(within(document.querySelector('.pm-proposal') as HTMLElement).getByText('两条都留着，以后体检不再把它们当冲突。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    expect(await screen.findByText('两条都保留')).toBeInTheDocument()
    expect(screen.getByText('按你的要求处理。以后体检不再把它们当冲突。')).toBeInTheDocument()
  })

  it('做不到：只有一句说明，没有「应用」，只有「取消」「改要求」', async () => {
    setup([card({ suggestion: keepA })], { respond: () => ({ ok: true, cmd: 'draft-proposal', infeasible: { reason: '两条里都没有端口号，没法并进来。' } }) })
    open()
    write('把端口号并进来')
    await generate()
    const area = document.querySelector('.pm-proposal') as HTMLElement
    expect(within(area).getByText('做不到')).toBeInTheDocument()
    expect(within(area).getByText('两条里都没有端口号，没法并进来。')).toBeInTheDocument()
    expect(footLabels()).toEqual(['取消', '改要求'])
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
  })

  it('「改要求」：文本框清空等新要求，下一次带上此前的要求和上一份方案（不带依据版本）', async () => {
    const { commands } = setup([card({ suggestion: keepA })], { respond: drafted(keepAProposal) })
    open()
    write('以 A 为准')
    await generate()
    fireEvent.click(screen.getByRole('button', { name: '改要求' }))
    expect(box()).toHaveValue('')
    write('还是融合吧')
    await generate()
    expect(commands().at(-1)).toEqual({
      cmd: 'draft-proposal', decisionId: 'd-h', request: '还是融合吧', bases: BASES, priorRequests: ['以 A 为准'],
      previous: { action: 'keep-a', reason: '你要以 A 为准。', ops: keepAProposal.ops },
    })
  })

  it('生成中只锁这张卡：显示「正在生成处理方案……」和「停止」，别的卡照常可点；停止后回到输入区、要求还在，迟到的结果丢弃', async () => {
    let answer!: (r: MemoryCommandResult) => void
    const other: PendingItem = { ...card({ noSuggestion: { code: 'not-generated' } }), decisionId: 'd-h2', summary: '另一条冲突' } as PendingItem
    setup([card({ suggestion: keepA }), other], { respond: command => (command.cmd === 'draft-proposal' ? new Promise((resolve) => { answer = resolve }) : { ok: true, cmd: command.cmd }) })
    fireEvent.click(screen.getAllByRole('button', { name: '补充要求' })[0]!)
    write('两者融合')
    await generate()
    expect(screen.getByText('正在生成处理方案……')).toBeInTheDocument()
    const otherCard = screen.getByText('另一条冲突').closest('.pm-pending-item') as HTMLElement
    expect(within(otherCard).getByRole('button', { name: '保留 A' })).not.toHaveAttribute('aria-disabled')
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(box()).toHaveValue('两者融合')
    await act(async () => { answer(drafted(mergeProposal)({ cmd: 'draft-proposal', decisionId: 'd-h', request: '两者融合', bases: BASES as never })) })
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect(box()).toHaveValue('两者融合')
  })

  it('要求里有高危密钥：本地拦住，不发送，写明原因', async () => {
    const { commands } = setup([card({ suggestion: keepA })])
    open()
    write(`把 ${'sk-' + 'TESTONLY'.padEnd(24, 'a')} 并进来`)
    await generate()
    expect(commands()).toEqual([])
    expect(screen.getByRole('alert')).toHaveTextContent('要求里有高危密钥，没有发送。去掉密钥再生成。')
  })

  it('融合稿像密钥：卡片里再确认一次，「仍然保存」带 allowSecret 重发', async () => {
    const { commands } = setup([card({ suggestion: keepA })], {
      respond: command => (command.cmd === 'apply-proposal' && command.allowSecret !== true ? { ok: false, cmd: command.cmd, code: 'secret-suspected' } : drafted(mergeProposal)(command)),
    })
    open()
    write('两者融合')
    await generate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '仍然保存' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'apply-proposal', decisionId: 'd-h', proposal: mergeProposal, allowSecret: true })
    expect(await screen.findByText('已融合成一条')).toBeInTheDocument()
  })

  it('应用时两条已被别处改过（stale）：方案作废，回到输入区并提示，什么都没落', async () => {
    setup([card({ suggestion: keepA })], {
      respond: command => (command.cmd === 'apply-proposal' ? { ok: false, cmd: command.cmd, code: 'stale', memoryIds: ['a', 'b'] } : drafted(mergeProposal)(command)),
    })
    open()
    write('两者融合')
    await generate()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
    expect(await screen.findByText('这两条刚被改过，已换成最新内容。请重新处理。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect(box()).toBeInTheDocument()
    expect(screen.queryByText('已融合成一条')).toBeNull()
  })

  it('生成时两条已被别处改过（draft-proposal 回 stale）：不出方案，回到输入区并提示，写的要求还在', async () => {
    setup([card({ suggestion: keepA })], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', memoryIds: ['a', 'b'] }) as MemoryCommandResult })
    open()
    write('两者融合')
    await generate()
    expect(await screen.findByText('这两条刚被改过，已换成最新内容。请重新处理。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
    expect(screen.queryByText('正在生成处理方案……')).toBeNull()
    expect(box()).toHaveValue('两者融合')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('看方案时视图带来新版本（别处改了 B）：方案作废并提示', async () => {
    const { gateway } = setup([card({ suggestion: keepA })], { respond: drafted(mergeProposal) })
    open()
    write('两者融合')
    await generate()
    expect(screen.getByRole('button', { name: '应用' })).toBeInTheDocument()
    act(() => { gateway.setView('pending', view(card({ suggestion: keepA, right: { ...B2, updatedAt: 333, content: '别处改了' } }))) })
    expect(await screen.findByText('这两条刚被改过，已换成最新内容。请重新处理。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '应用' })).toBeNull()
  })

  it('同一时刻只展开一个输入区：另一张卡点「补充要求」，这张写了内容先原位问；没写内容直接换过去', async () => {
    const other: PendingItem = { ...card({ noSuggestion: { code: 'not-generated' } }), decisionId: 'd-h2', summary: '另一条冲突' } as PendingItem
    setup([card({ suggestion: keepA }), other])
    const requestOn = (title: string) => within(screen.getByText(title).closest('.pm-pending-item') as HTMLElement).getByRole('button', { name: '补充要求' })
    fireEvent.click(requestOn('另一条冲突'))
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    // 没写内容：直接换
    fireEvent.click(requestOn(horizontal.summary))
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    write('写了一半')
    fireEvent.click(requestOn('另一条冲突'))
    const ask = screen.getByRole('group', { name: '放弃刚写的内容？' })
    fireEvent.click(within(ask).getByRole('button', { name: '取消' }))
    expect(box()).toHaveValue('写了一半')
    fireEvent.click(requestOn('另一条冲突'))
    fireEvent.click(within(screen.getByRole('group', { name: '放弃刚写的内容？' })).getByRole('button', { name: '放弃' }))
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(box()).toHaveValue('')
    expect(within(screen.getByText('另一条冲突').closest('.pm-pending-item') as HTMLElement).getByRole('textbox')).toBeInTheDocument()
  })

  it('这张卡的候选项正在原位确认时，另一张卡点「补充要求」：「放弃刚写的内容？」照样看得见', () => {
    const other: PendingItem = { ...card({ noSuggestion: { code: 'not-generated' } }), decisionId: 'd-h2', summary: '另一条冲突' } as PendingItem
    setup([card({ suggestion: keepA }), other])
    const requestOn = (title: string) => within(screen.getByText(title).closest('.pm-pending-item') as HTMLElement).getByRole('button', { name: '补充要求' })
    fireEvent.click(requestOn(horizontal.summary))
    write('写了一半')
    fireEvent.click(within(screen.getByRole('group', { name: '常用处理（可选）' })).getByRole('button', { name: '保留 A' }))
    fireEvent.click(requestOn('另一条冲突'))
    const ask = screen.getByRole('group', { name: '放弃刚写的内容？' })
    expect(ask.closest('[hidden]')).toBeNull()
  })

  it('生成时条目已在别处处理（not-found）：交给列表提示别处已处理', async () => {
    setup([card({ suggestion: keepA })], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found' }) as MemoryCommandResult })
    open()
    write('两者融合')
    await generate()
    await waitFor(() => { expect(document.querySelector('.pm-pending-refused')).not.toBeNull() })
  })

  it('英文界面：入口、输入区和结果卡都有英文', async () => {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(card({ suggestion: keepA })), health: scannedHealth(NOW) }, respond: drafted(keepAProposal) })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} /></PanelShell>)
    fireEvent.click(screen.getByRole('button', { name: 'Say how' }))
    expect(within(screen.getByRole('group', { name: 'Common choices (optional)' })).getAllByRole('button').map(b => b.textContent)).toEqual(['Keep A', 'Keep B', 'Merge the two', 'Merge as versions', 'Not a conflict', 'Mark as exception'])
    fireEvent.change(screen.getByRole('textbox', { name: 'How should these two be handled?' }), { target: { value: 'go with A' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Make a plan' })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply' })) })
    expect(await screen.findByText('Done as you asked. “mock-db-in-tests” was deleted and can be restored within 14 days.')).toBeInTheDocument()
  })
})

describe('垂直冲突卡：同一张处理卡（票 10）', () => {
  type Vertical = Extract<PendingItem, { kind: 'conflict-vertical' }>
  // 记忆在借来的会话所在项目里（/w/app），带卡片版本
  const V = memory({ id: 'v', content: '用 npm。', digest: 'sha1:v', updatedAt: 333 })
  const card = (extra: Partial<Vertical> = {}): PendingItem => ({ ...vertical, memory: V, ...extra }) as PendingItem
  const REWRITTEN = 'web/ 目录下用 npm，其余照 AGENTS.md 用 pnpm。'
  const rewrite: Suggestion = {
    id: 'sg_r', action: 'rewrite', reason: '这条记忆只管 web 目录。', isSourced: false, baselineWorkspace: '/w/app',
    ops: [{ kind: 'edit', memoryId: 'v', content: REWRITTEN, name: V.name, summary: V.summary, tags: [] }],
  }
  const del: Suggestion = { id: 'sg_d', action: 'delete', reason: '指令文件已经写清楚了。', isSourced: false, baselineWorkspace: '/w/app', ops: [{ kind: 'forget', memoryId: 'v' }] }
  const both: Suggestion = { id: 'sg_b', action: 'keep-both', reason: '两边讲的是不同的事。', isSourced: false, baselineWorkspace: '/w/app', ops: [{ kind: 'keep', memoryId: 'v' }] }
  const DIRECT = ['以文件为准，删除这条', '确实不冲突', '记成例外']
  const rowOf = () => document.querySelector('.pm-conflict-actions') as HTMLElement | null
  const labelsOf = (row: HTMLElement) => [...row.querySelectorAll('button')].map(b => b.textContent)
  const adopted = (command: MemoryCommand): MemoryCommandResult => ({ ok: true, cmd: command.cmd, decisionId: 'd-v', memoryIds: ['v'], snapshotId: 'snap' }) as MemoryCommandResult

  it('没有建议：建议块写还没让模型看过，按钮行是三个直接处理加「补充要求」；「补上建议」只发 suggest', async () => {
    const { commands } = setup([card({ noSuggestion: { code: 'not-generated' } })])
    expect(screen.getByText('这条还没有建议')).toBeInTheDocument()
    expect(screen.getByText('还没让模型看过这条记忆和指令文件。')).toBeInTheDocument()
    expect(labelsOf(rowOf()!)).toEqual([...DIRECT, '补充要求'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '补上建议' })) })
    expect(commands()).toEqual([{ cmd: 'suggest', decisionId: 'd-v' }])
  })

  it('回查过出处：说明行写回查的是这条记忆的出处', () => {
    setup([card({ suggestion: { ...rewrite, isSourced: true } })])
    expect(screen.getByText('建议是回查这条记忆的出处后给出的。采纳后这条记忆换成改写稿，可以撤销。')).toBeInTheDocument()
  })

  it('改写建议：加粗结论、理由、改写稿和对照；说明行写换成改写稿；采纳只带条目 id 和建议 id，结果卡「已改写这条记忆」显示改写后的内容、写来由，撤销发 undo（冲突条目）', async () => {
    const { commands } = setup([card({ suggestion: rewrite })], { respond: adopted })
    expect(screen.getByText('改写这条记忆').tagName).toBe('STRONG')
    expect(screen.getByText('这条记忆只管 web 目录。')).toBeInTheDocument()
    expect(screen.getByText('改写后（写回这条记忆，指令文件不改）')).toBeInTheDocument()
    expect(screen.getByText(REWRITTEN)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '看和原文的对照 ›' }))
    expect(screen.getByRole('region', { name: '原文' })).toHaveTextContent('用 npm。')
    expect(screen.getByText('采纳后这条记忆换成改写稿，可以撤销。')).toBeInTheDocument()
    expect(labelsOf(rowOf()!)).toEqual(['采纳建议', '补充要求'])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(commands()).toEqual([{ cmd: 'apply-proposal', decisionId: 'd-v', suggestionId: 'sg_r' }])
    expect(await screen.findByText('已改写这条记忆')).toBeInTheDocument()
    expect(screen.getByText('按模型建议处理。指令文件没有改动。')).toBeInTheDocument()
    expect(screen.getByText(REWRITTEN)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })) })
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-v' })
  })

  it('删除建议：说明行写进最近删除；采纳不加确认，结果「已按基线」「按模型建议处理。」、可撤销', async () => {
    const { commands } = setup([card({ suggestion: del })], { respond: adopted })
    expect(screen.getByText('以文件为准，删除这条').tagName).toBe('STRONG')
    expect(screen.getByText('采纳后这条记忆进最近删除，14 天内可恢复。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(commands()).toEqual([{ cmd: 'apply-proposal', decisionId: 'd-v', suggestionId: 'sg_d' }])
    expect(await screen.findByText('已按基线')).toBeInTheDocument()
    expect(screen.getByText('按模型建议处理。这条记忆已删除，14 天内可恢复。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('删除建议、这条含高危密钥：说明行和确认都写彻底删除，确认后才发 apply-proposal；结果没有撤销', async () => {
    const { commands } = setup([card({ memory: { ...V, hasSecret: true }, suggestion: del })], {
      respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-v', isHardDeleted: true }) as MemoryCommandResult,
    })
    expect(screen.getByText('这条记忆含密钥，采纳后将彻底删除、不可恢复。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    expect(screen.getByText('以文件为准：这条记忆含密钥，将彻底删除、不可恢复。')).toBeInTheDocument()
    expect(commands()).toEqual([])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '彻底删除' })) })
    expect(commands()).toEqual([{ cmd: 'apply-proposal', decisionId: 'd-v', suggestionId: 'sg_d' }])
    expect(await screen.findByText(/按模型建议处理。这条记忆含密钥，已彻底删除。/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('都保留建议：采纳后「已保留这条记忆」「按模型建议处理。基线和记忆都不变时不再报。」', async () => {
    setup([card({ suggestion: both })], { respond: adopted })
    expect(screen.getByText('采纳后这条记忆留着，它和指令文件都不变时不再报。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(await screen.findByText('已保留这条记忆')).toBeInTheDocument()
    expect(screen.getByText('按模型建议处理。基线和记忆都不变时不再报。')).toBeInTheDocument()
  })

  it.each([
    ['项目记忆，会话在别的项目', { memory: { ...V, workspacePath: '/w/other' }, suggestion: rewrite }],
    ['全局记忆，建议是在别的项目的会话里生成的', { memory: { ...V, scope: 'global', workspacePath: undefined }, suggestion: { ...rewrite, baselineWorkspace: '/w/other' } }],
    ['全局记忆，建议是在没有项目的会话里生成的', { memory: { ...V, scope: 'global', workspacePath: undefined }, suggestion: { ...rewrite, baselineWorkspace: 'global' } }],
  ] as const)('会话在哪个项目都不影响处理（%s）：照样显示建议、给「采纳建议」「补充要求」', (_label, extra) => {
    setup([card(extra as Partial<Vertical>)])
    expect(screen.getByText(REWRITTEN)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '采纳建议' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '补充要求' })).toBeInTheDocument()
  })

  it('会话不在这条记忆的项目里、还没有建议：照样给「补上建议」', () => {
    setup([card({ memory: { ...V, workspacePath: '/w/other' }, noSuggestion: { code: 'not-generated' } })])
    expect(screen.getByRole('button', { name: '补上建议' })).toBeInTheDocument()
  })

  it('体检时读不到指令文件：写原因，给「补上建议」', () => {
    setup([card({ noSuggestion: { code: 'no-baseline' } })])
    expect(screen.getByText('这条记忆对应的指令文件读不到，或在体检后改过。重新体检后再试。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '补上建议' })).toBeInTheDocument()
  })

  it('补上建议时服务端回缺基线（指令文件读不到或在体检后改过）：原位写原因', async () => {
    setup([card({ noSuggestion: { code: 'not-generated' } })], {
      respond: command => ({ ok: false, cmd: command.cmd, code: 'no-baseline', detail: '这条记忆对应的指令文件读不到，或在体检后改过。重新体检后再试。未做任何改动' }) as MemoryCommandResult,
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '补上建议' })) })
    expect(await screen.findByRole('alert')).toHaveTextContent('这条记忆对应的指令文件读不到，或在体检后改过。重新体检后再试。')
  })

  it('含高危密钥：写这条记忆里有密钥、不会发给模型，没有「补上建议」「补充要求」', () => {
    setup([card({ memory: { ...V, hasSecret: true }, noSuggestion: { code: 'has-secret' } })])
    expect(screen.getByText('这条记忆里有密钥，不会发给模型。可以直接选下面的处理方式。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /补上建议|补充要求/ })).toBeNull()
    expect(labelsOf(rowOf()!)).toEqual(DIRECT)
  })

  it('采纳时建议已失效（服务端回 stale）：不落盘，退化成没有建议并写明原因，只剩直接处理和「补充要求」', async () => {
    setup([card({ suggestion: rewrite })], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '建议已失效' }) as MemoryCommandResult })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '采纳建议' })) })
    expect(await screen.findByText('这条记忆或指令文件刚被改过，建议已失效。下次体检会重新给建议，现在可以直接选处理方式。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    expect(labelsOf(rowOf()!)).toEqual([...DIRECT, '补充要求'])
  })

  describe('补充要求', () => {
    const basis = { conflictFingerprint: 'cf', memories: [{ memoryId: 'v', fingerprint: 'fv', scopeKey: '/w/app' }], baseline: { workspace: '/w/app', fingerprint: 'bf' } }
    const rewriteProposal = { action: 'rewrite', reason: '照你说的写清了范围。', basis, ops: [{ kind: 'edit', memoryId: 'v', content: REWRITTEN, name: V.name, summary: V.summary, tags: [] }] } as const
    const deleteProposal = { action: 'delete', reason: '你要以文件为准。', basis, ops: [{ kind: 'forget', memoryId: 'v' }] } as const
    const drafted = (proposal: object) => (command: MemoryCommand): MemoryCommandResult => (command.cmd === 'draft-proposal'
      ? { ok: true, cmd: 'draft-proposal', proposal, model: 'deepseek-v4-flash' }
      : { ok: true, cmd: command.cmd, decisionId: 'd-v', memoryIds: ['v'], snapshotId: 'snap' }) as MemoryCommandResult
    const box = () => screen.getByRole('textbox', { name: '想怎么处理这条记忆？' })
    const candidates = () => within(screen.getByRole('group', { name: '常用处理（可选）' }))

    it('常用处理是四个候选项；「改写这条记忆」填要求；生成发 draft-proposal 带这一条的卡片版本；改写方案对照；应用发 apply-proposal 带方案，结果卡写「按你的要求处理。」', async () => {
      const { commands } = setup([card({ noSuggestion: { code: 'not-generated' } })], { respond: drafted(rewriteProposal) })
      fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
      expect(candidates().getAllByRole('button').map(b => b.textContent)).toEqual(['以文件为准，删除这条', '改写这条记忆', '确实不冲突', '记成例外'])
      expect(screen.getByText('模型按这条记忆、指令文件和你的要求给出处理方案，先给你看结果再决定。它只用原文和你写的信息。会消耗少量 token。')).toBeInTheDocument()
      fireEvent.click(candidates().getByRole('button', { name: '改写这条记忆' }))
      expect(box()).toHaveValue('改写这条记忆，写清它和指令文件各管什么。')
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成处理方案' })) })
      expect(commands()).toEqual([{ cmd: 'draft-proposal', decisionId: 'd-v', request: '改写这条记忆，写清它和指令文件各管什么。', bases: [{ updatedAt: 333, digest: 'sha1:v' }] }])
      const area = document.querySelector('.pm-proposal') as HTMLElement
      expect(within(area).getByText('改写这条记忆').tagName).toBe('STRONG')
      expect(within(area).getByText('改写后（写回这条记忆，指令文件不改）')).toBeInTheDocument()
      expect(within(area).getByRole('region', { name: '改后' })).toHaveTextContent(REWRITTEN)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
      expect(commands().at(-1)).toEqual({ cmd: 'apply-proposal', decisionId: 'd-v', proposal: rewriteProposal })
      expect(await screen.findByText('已改写这条记忆')).toBeInTheDocument()
      expect(screen.getByText('按你的要求处理。指令文件没有改动。')).toBeInTheDocument()
    })

    it('删除方案：一句话写去向；应用后「已按基线」「按你的要求处理。」', async () => {
      setup([card({ noSuggestion: { code: 'not-generated' } })], { respond: drafted(deleteProposal) })
      fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
      fireEvent.change(box(), { target: { value: '以文件为准' } })
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成处理方案' })) })
      expect(within(document.querySelector('.pm-proposal') as HTMLElement).getByText('应用后这条记忆进最近删除，14 天内可恢复。')).toBeInTheDocument()
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '应用' })) })
      expect(await screen.findByText('已按基线')).toBeInTheDocument()
      expect(screen.getByText('按你的要求处理。这条记忆已删除，14 天内可恢复。')).toBeInTheDocument()
    })

    it('候选项「以文件为准，删除这条」不过模型：原位确认后发 resolve keep-right', async () => {
      const { commands } = setup([card({ noSuggestion: { code: 'not-generated' } })])
      fireEvent.click(screen.getByRole('button', { name: '补充要求' }))
      fireEvent.click(candidates().getByRole('button', { name: '以文件为准，删除这条' }))
      fireEvent.click(within(screen.getByRole('group', { name: '以文件为准，这条记忆进最近删除？' })).getByRole('button', { name: '删除这条' }))
      expect(await screen.findByText('已按基线')).toBeInTheDocument()
      expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-v', verdict: 'keep-right' }])
    })
  })

  it('「全部补上」算上垂直冲突，会话不在它的项目里也算；读不到指令文件的也算', () => {
    const h = { ...horizontal, noSuggestion: { code: 'not-generated' } } as PendingItem
    const first = setup([h, card({ noSuggestion: { code: 'not-generated' } })])
    expect(screen.getByText('2 条还没有建议')).toBeInTheDocument()
    first.unmount()
    setup([h, card({ memory: { ...V, workspacePath: '/w/other' }, noSuggestion: { code: 'not-generated' } }), { ...card({ noSuggestion: { code: 'no-baseline' } }), decisionId: 'd-v2', memory: { ...V, id: 'v2' } } as PendingItem])
    expect(screen.getByText('3 条还没有建议')).toBeInTheDocument()
  })

  it('英文界面：候选项、结论和缺基线的说明', () => {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(card({ suggestion: del }), { ...card({ noSuggestion: { code: 'no-baseline' } }), decisionId: 'd-v2', memory: { ...V, id: 'v2', workspacePath: '/w/other' } } as PendingItem), health: scannedHealth(NOW) } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} /></PanelShell>)
    expect(screen.getByText('Go with the file, delete this one', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('The instruction file for this memory could not be read, or it changed after the checkup. Run a checkup and try again.')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Not a conflict' }).length).toBeGreaterThan(0)
  })
})
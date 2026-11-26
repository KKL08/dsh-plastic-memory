import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type MemoryCommandResult, type PendingItem, type Suggestion } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGatewayInit } from '../gateway.fake.ts'
import { ALL_SCOPE, createNavStore } from '../nav.ts'
import { memory, NOW } from '../test-utils.tsx'
import { PendingTab } from './PendingTab.tsx'
import { WAIT_FOR_VIEW_MS } from './suggestion.tsx'
import { createTranslator } from '../i18n.tsx'
import { en, zh } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { Icon } from '../ui/Icon.tsx'
import { SESSION, config, A, B, horizontal, view, scannedHealth, setup } from './test-pending.tsx'


describe('横向冲突卡的处理建议', () => {
  type Horizontal = Extract<PendingItem, { kind: 'conflict-horizontal' }>
  const withState = (extra: Partial<Horizontal>): PendingItem => ({ ...horizontal, ...extra }) as PendingItem
  const keepA: Suggestion = { id: 'sg_1', action: 'keep-a', reason: 'A 是你明确说过的，B 是推断的。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] }
  const mergeEdit = { kind: 'edit', memoryId: 'a', content: '集成测试用真实 Postgres，单元测试可以 mock 数据库。', name: A.name, summary: A.summary, tags: [] } as const satisfies Suggestion['ops'][number]
  const merged: Suggestion = { id: 'sg_2', action: 'merge', reason: '两边各有适用场景。', isSourced: false, ops: [{ ...mergeEdit, tags: [] }, { kind: 'forget', memoryId: 'b' }] }
  const block = () => document.querySelector('.pm-suggestion') as HTMLElement

  it('有建议：模型图标、加粗的结论、一句理由；直接处理的按钮照旧，没有「补上建议」', () => {
    setup([withState({ suggestion: keepA })])
    expect(block().querySelector('.pm-icon, svg')).not.toBeNull()
    expect(within(block()).getByText('保留 A').tagName).toBe('STRONG')
    expect(within(block()).getByText('A 是你明确说过的，B 是推断的。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /补上建议/ })).toBeNull()
    expect(screen.getByRole('button', { name: '保留 B' })).toBeInTheDocument()
  })

  it.each([
    ['keep-b', '保留 B'],
    ['keep-both', '都保留（不算冲突）'],
  ] as const)('结论 %s 写成「%s」', (action, label) => {
    setup([withState({ suggestion: { ...keepA, action, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'keep', memoryId: 'b' }] } })])
    expect(within(block()).getByText(label)).toBeInTheDocument()
  })

  it('融合：直接显示融合稿和写进哪条（按实际保留方），点「看和原文的对照」原位展开、再点收起', () => {
    setup([withState({ suggestion: merged })])
    expect(within(block()).getByText('融合成一条')).toBeInTheDocument()
    expect(within(block()).getByText('集成测试用真实 Postgres，单元测试可以 mock 数据库。')).toBeInTheDocument()
    expect(within(block()).getByText('融合后（写进 A，B 进最近删除）')).toBeInTheDocument()
    const toggle = within(block()).getByRole('button', { name: /看和原文的对照/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(block()).getByRole('region', { name: '原文' })).toBeInTheDocument()
    fireEvent.click(within(block()).getByRole('button', { name: /收起对照/ }))
    expect(within(block()).queryByRole('region', { name: '原文' })).toBeNull()
  })

  it('融合写进 B 时文案跟着写', () => {
    setup([withState({ suggestion: { ...merged, ops: [{ kind: 'forget', memoryId: 'a' }, { ...mergeEdit, tags: [], memoryId: 'b' }] } })])
    expect(within(block()).getByText('融合后（写进 B，A 进最近删除）')).toBeInTheDocument()
  })

  it('含高危密钥：写明哪条有密钥、不会发给模型，没有「补上建议」', () => {
    setup([withState({ right: { ...B, hasSecret: true }, noSuggestion: { code: 'has-secret' } })])
    expect(within(block()).getByText('这次没有建议')).toBeInTheDocument()
    expect(within(block()).getByText('B 里有密钥，不会发给模型。可以直接选下面的处理方式。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /补上建议/ })).toBeNull()
  })

  it('还没生成：页面加载时不问模型；点「补上建议」只发 suggest，生成中显示「正在生成建议……」，视图带来建议后原位换成建议', async () => {
    const { gateway, commands } = setup([withState({ noSuggestion: { code: 'not-generated' } })], {
      respond: command => (command.cmd === 'suggest' ? { ok: true, cmd: 'suggest', decisionId: 'd-h' } : { ok: true, cmd: command.cmd }),
    })
    expect(gateway.modelRequests).toEqual([])
    expect(within(block()).getByText('这条还没有建议')).toBeInTheDocument()
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByText('正在生成建议……')).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'suggest', decisionId: 'd-h' }])
    // 命令回来了、视图还没换：仍在等
    await waitFor(() => { expect(gateway.executed).toHaveLength(1) })
    expect(within(block()).getByText('正在生成建议……')).toBeInTheDocument()
    act(() => { gateway.setView('pending', view(withState({ suggestion: keepA }))) })
    expect(await within(block()).findByText('保留 A')).toBeInTheDocument()
    expect(within(block()).queryByText('正在生成建议……')).toBeNull()
  })

  it('「补上建议」「再试一次」按钮带模型图标（和建议块上的同一个），读屏名称仍只是按钮文字', () => {
    const modelIcon = render(<Icon name="sparkle" size={14} />).container.querySelector('svg')!
    for (const [noSuggestion, label] of [[{ code: 'not-generated' }, '补上建议'], [{ code: 'failed', cause: { kind: 'model-error', hostCode: 'RATE_LIMIT', message: '429' } }, '再试一次']] as const) {
      const card = setup([withState({ noSuggestion })])
      const icon = within(block()).getByRole('button', { name: label }).querySelector('svg')
      expect(icon).not.toBeNull()
      expect(icon!.isEqualNode(modelIcon)).toBe(true)
      expect(icon).toHaveAttribute('aria-hidden', 'true')
      card.unmount()
    }
  })

  it('命令成功而视图一直没带来建议：等够时间回到「补上建议」，不一直转', async () => {
    vi.useFakeTimers()
    try {
      setup([withState({ noSuggestion: { code: 'not-generated' } })], {
        respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-h' }) as MemoryCommandResult,
      })
      fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) }) // 命令结果回来，开始等视图
      await act(async () => { await vi.advanceTimersByTimeAsync(WAIT_FOR_VIEW_MS - 1) })
      expect(within(block()).getByText('正在生成建议……')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(within(block()).queryByText('正在生成建议……')).toBeNull()
      expect(within(block()).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('「停止」只是不再等：回到没有建议，迟到的失败不显示', async () => {
    let answer!: (r: MemoryCommandResult) => void
    setup([withState({ noSuggestion: { code: 'not-generated' } })], { respond: () => new Promise((resolve) => { answer = resolve }) })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    fireEvent.click(await within(block()).findByRole('button', { name: '停止' }))
    expect(within(block()).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
    await act(async () => { answer({ ok: false, cmd: 'suggest', code: 'llm-failed', detail: '限流' }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(block()).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
  })

  it('生成失败（视图带原因）：写原因，按钮变成「再试一次」', () => {
    setup([withState({ noSuggestion: { code: 'failed', cause: { kind: 'model-error', hostCode: 'RATE_LIMIT', message: '429' } } })])
    expect(within(block()).getByText('这条还没有建议')).toBeInTheDocument()
    expect(within(block()).getByText('上次没生成成：请求太频繁，被限流了。')).toBeInTheDocument()
    expect(within(block()).getByRole('button', { name: '再试一次' })).toBeInTheDocument()
  })

  it('稿里带进了密钥被丢弃：原因写清楚', () => {
    setup([withState({ noSuggestion: { code: 'failed', cause: { kind: 'secret-in-draft' } } })])
    expect(within(block()).getByText('上次没生成成：模型给的稿里带进了原文没有的密钥，已丢弃。')).toBeInTheDocument()
  })

  it('命令失败：原位写原因，按钮变成「再试一次」', async () => {
    setup([withState({ noSuggestion: { code: 'not-generated' } })], { respond: () => ({ ok: false, cmd: 'suggest', code: 'llm-failed', detail: '连不上' }) })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByRole('alert')).toHaveTextContent('模型出错了：连不上')
    expect(within(block()).getByRole('button', { name: '再试一次' })).toBeInTheDocument()
  })

  it('拿不到模型：写原因，不再显示「补上建议」', async () => {
    setup([withState({ noSuggestion: { code: 'not-generated' } })], { respond: () => ({ ok: false, cmd: 'suggest', code: 'llm-unavailable' }) })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByText('拿不到当前会话的模型。')).toBeInTheDocument()
    expect(within(block()).queryByRole('button', { name: /补上建议|再试一次/ })).toBeNull()
  })

  /** 待处理 tab 换一个借来的会话重画（会话由页面传进来）。 */
  function setupSwitchable(items: PendingItem[], init: FakeGatewayInit) {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(...items), health: scannedHealth(NOW) }, ...init })
    const ui = (session: { kind: 'ready'; sessionId: string; cwd: string }) => (
      <PanelShell gateway={gateway} t={createTranslator(zh)}>
        <PendingTab nav={createNavStore()} session={session} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} />
      </PanelShell>
    )
    const { rerender } = render(ui(SESSION))
    return { gateway, switchTo: (sessionId: string) => { rerender(ui({ ...SESSION, sessionId })) } }
  }

  it('拿不到模型不随会话保留：换了会话重新给「补上建议」', async () => {
    const { gateway, switchTo } = setupSwitchable([withState({ noSuggestion: { code: 'not-generated' } })], {
      respond: () => ({ ok: false, cmd: 'suggest', code: 'llm-unavailable' }),
    })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByText('拿不到当前会话的模型。')).toBeInTheDocument()
    switchTo('s2')
    expect(within(block()).queryByText('拿不到当前会话的模型。')).toBeNull()
    expect(within(block()).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
    expect(gateway.modelRequests).toEqual([])
  })

  it('这个会话已知拿不到模型（同页别处问过）：直接写原因、不给按钮，建议块自己不问', () => {
    const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 'bl', digest: 'sha1:bl' })] }
    const { gateway } = setup([withState({ noSuggestion: { code: 'not-generated' } }), bloat], { model: null })
    expect(within(block()).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    expect(gateway.modelRequests.length).toBeGreaterThan(0)
    expect(new Set(gateway.modelRequests)).toEqual(new Set(['s1']))
    expect(within(block()).getByText('拿不到当前会话的模型。')).toBeInTheDocument()
    expect(within(block()).queryByRole('button', { name: /补上建议|再试一次/ })).toBeNull()
  })

  it('生成中换了会话：回到没有建议，旧会话迟到的失败不显示', async () => {
    let answer!: (r: MemoryCommandResult) => void
    const { switchTo } = setupSwitchable([withState({ noSuggestion: { code: 'not-generated' } })], { respond: () => new Promise((resolve) => { answer = resolve }) })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByText('正在生成建议……')).toBeInTheDocument()
    switchTo('s2')
    expect(within(block()).queryByText('正在生成建议……')).toBeNull()
    expect(within(block()).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
    await act(async () => { answer({ ok: false, cmd: 'suggest', code: 'llm-failed', detail: '限流' }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(block()).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
  })

  it('写入时条目正被别处认领：回到可再点的样子，不提示别处已处理；条目不在了才提示', async () => {
    let code: 'claimed' | 'not-found' = 'claimed'
    setup([withState({ noSuggestion: { code: 'not-generated' } })], { respond: () => ({ ok: false, cmd: 'suggest', code }) })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByRole('button', { name: '补上建议' })).toBeInTheDocument()
    expect(document.querySelector('.pm-pending-refused')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    code = 'not-found'
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    await waitFor(() => { expect(document.querySelector('.pm-pending-refused')).not.toBeNull() })
  })

  it('命令失败的结果到达时视图里的原因已经变了：让给视图，不再显示本地的错误行', async () => {
    let answer!: (r: MemoryCommandResult) => void
    const { gateway } = setup([withState({ noSuggestion: { code: 'not-generated' } })], { respond: () => new Promise((resolve) => { answer = resolve }) })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByText('正在生成建议……')).toBeInTheDocument()
    act(() => { gateway.setView('pending', view(withState({ noSuggestion: { code: 'failed', cause: { kind: 'model-error', hostCode: 'RATE_LIMIT' } } }))) })
    await act(async () => { answer({ ok: false, cmd: 'suggest', code: 'llm-failed', detail: '限流' }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(within(block()).getByText('上次没生成成：请求太频繁，被限流了。')).toBeInTheDocument()
    expect(within(block()).getByRole('button', { name: '再试一次' })).toBeInTheDocument()
  })

  it('命令成功的结果到达时视图里的原因已经变了：直接显示视图的，不再等', async () => {
    let answer!: (r: MemoryCommandResult) => void
    const { gateway } = setup([withState({ noSuggestion: { code: 'not-generated' } })], { respond: () => new Promise((resolve) => { answer = resolve }) })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    expect(await within(block()).findByText('正在生成建议……')).toBeInTheDocument()
    act(() => { gateway.setView('pending', view(withState({ noSuggestion: { code: 'undecided', reason: '需要你确认用哪个。' } }))) })
    await act(async () => { answer({ ok: true, cmd: 'suggest', decisionId: 'd-h' }) })
    expect(within(block()).queryByText('正在生成建议……')).toBeNull()
    expect(within(block()).getByText('需要你确认用哪个。')).toBeInTheDocument()
  })

  it('模型判断不了哪条对：如实写明加它说的理由，下面仍给「再试一次」，不按错误显示', () => {
    setup([withState({ noSuggestion: { code: 'undecided', reason: '两条都没写适用场景，需要你确认这个项目用哪个。' } })])
    expect(within(block()).getByText('模型判断不了哪条对').tagName).toBe('STRONG')
    expect(within(block()).getByText('两条都没写适用场景，需要你确认这个项目用哪个。')).toBeInTheDocument()
    expect(within(block()).queryByText('这条还没有建议')).toBeNull()
    expect(within(block()).getByRole('button', { name: '再试一次' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(block().querySelector('.pm-pending-error')).toBeNull()
  })

  it('点「补上建议」后模型判断不了：视图带来原因后原位换成如实说明', async () => {
    const { gateway } = setup([withState({ noSuggestion: { code: 'not-generated' } })], {
      respond: () => ({ ok: true, cmd: 'suggest', decisionId: 'd-h' }),
    })
    fireEvent.click(within(block()).getByRole('button', { name: '补上建议' }))
    await waitFor(() => { expect(gateway.executed).toHaveLength(1) })
    act(() => { gateway.setView('pending', view(withState({ noSuggestion: { code: 'undecided', reason: '日期一样，分不出。' } }))) })
    expect(await within(block()).findByText('模型判断不了哪条对')).toBeInTheDocument()
    expect(within(block()).getByText('日期一样，分不出。')).toBeInTheDocument()
  })
})

describe('体检之后的建议：「正在生成」、名额用完、「全部补上」（票 08）', () => {
  type Horizontal = Extract<PendingItem, { kind: 'conflict-horizontal' }>
  const keepA: Suggestion = { id: 'sg_1', action: 'keep-a', reason: 'A 是你明确说过的。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] }
  /** 第 n 条横向冲突（各自两条记忆）。 */
  const pair = (n: number, extra: Partial<Horizontal>): PendingItem => ({
    ...horizontal, decisionId: `d${n}`, summary: `第 ${n} 对互相矛盾`, preferredId: `a${n}`,
    left: memory({ id: `a${n}`, name: `A${n}`, content: `A${n} 的内容` }), right: memory({ id: `b${n}`, name: `B${n}`, content: `B${n} 的内容` }), ...extra,
  }) as PendingItem
  const blocks = () => [...document.querySelectorAll<HTMLElement>('.pm-suggestion')]
  const row = () => document.querySelector('.pm-suggest-all') as HTMLElement | null
  const missing = { noSuggestion: { code: 'not-generated' } } as const

  it('后续段正在生成的卡写「正在生成建议……」，不给「补上建议」也不给「停止」；建议随视图补上', async () => {
    const { gateway } = setup([pair(1, { ...missing, isGeneratingSuggestion: true })])
    const [card] = blocks()
    expect(within(card!).getByRole('status')).toHaveTextContent('正在生成建议……')
    expect(within(card!).queryByRole('button')).toBeNull()
    act(() => { gateway.setView('pending', view(pair(1, { suggestion: keepA }))) })
    expect(await within(blocks()[0]!).findByText('保留 A')).toBeInTheDocument()
  })

  it('自动体检名额用完：写原因，给「补上建议」', () => {
    setup([pair(1, { noSuggestion: { code: 'quota-exhausted' } })])
    const [card] = blocks()
    expect(within(card!).getByText('这条还没有建议')).toBeInTheDocument()
    expect(within(card!).getByText('自动体检这次给的建议条数到上限了，没轮到这条。')).toBeInTheDocument()
    expect(within(card!).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
  })

  it('两条以上没有建议才有「全部补上」；有建议、正在生成、含密钥、判断不了的不算', () => {
    setup([
      pair(1, missing),
      pair(2, { noSuggestion: { code: 'quota-exhausted' } }),
      pair(3, { noSuggestion: { code: 'failed', cause: { kind: 'model-error', hostCode: 'RATE_LIMIT' } } }),
      pair(4, { suggestion: keepA }),
      pair(5, { ...missing, isGeneratingSuggestion: true }),
      pair(6, { noSuggestion: { code: 'has-secret' } }),
      pair(7, { noSuggestion: { code: 'undecided', reason: '分不出。' } }),
    ])
    expect(row()).toHaveTextContent('3 条还没有建议')
    // 在「等你决定」标题下面
    expect(row()!.closest('section')?.querySelector('h2')).toHaveTextContent('等你决定')
    expect(within(row()!).getByRole('button', { name: '全部补上' })).toBeInTheDocument()
  })

  it('只有一条没有建议：不显示「全部补上」', () => {
    setup([pair(1, missing), pair(2, { suggestion: keepA })])
    expect(row()).toBeNull()
  })

  it('这个会话已知拿不到模型时不显示「全部补上」', () => {
    const bloat: PendingItem = { kind: 'advice', level: 'advice', type: 'bloat', memories: [memory({ id: 'bl', digest: 'sha1:bl' })] }
    setup([pair(1, missing), pair(2, missing), bloat], { model: null })
    expect(row()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    expect(row()).toBeNull()
  })

  it('依次发：一条回来再发下一条，行内写进度，正在生成的那张卡写「正在生成」；全部发完回到原样', async () => {
    const answers: Array<(r: MemoryCommandResult) => void> = []
    const { gateway, commands } = setup([pair(1, missing), pair(2, missing), pair(3, missing)], {
      respond: () => new Promise((resolve) => { answers.push(resolve) }),
    })
    fireEvent.click(within(row()!).getByRole('button', { name: '全部补上' }))
    expect(await within(row()!).findByText('正在生成建议 1 / 3……')).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'suggest', decisionId: 'd1' }])
    expect(within(blocks()[0]!).getByText('正在生成建议……')).toBeInTheDocument()
    expect(within(blocks()[1]!).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
    // 第一条写成了、视图带来建议；第二条接着发
    act(() => { gateway.setView('pending', view(pair(1, { suggestion: keepA }), pair(2, missing), pair(3, missing))) })
    await act(async () => { answers[0]!({ ok: true, cmd: 'suggest', decisionId: 'd1' }) })
    expect(await within(row()!).findByText('正在生成建议 2 / 3……')).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'suggest', decisionId: 'd1' }, { cmd: 'suggest', decisionId: 'd2' }])
    expect(within(blocks()[0]!).getByText('保留 A')).toBeInTheDocument()
    expect(within(blocks()[1]!).getByText('正在生成建议……')).toBeInTheDocument()
    // 第二条没生成成：卡上由视图写原因，接着发第三条
    await act(async () => { answers[1]!({ ok: false, cmd: 'suggest', code: 'llm-failed', detail: '限流' }) })
    expect(await within(row()!).findByText('正在生成建议 3 / 3……')).toBeInTheDocument()
    await act(async () => { answers[2]!({ ok: true, cmd: 'suggest', decisionId: 'd3' }) })
    expect(commands().map(c => c.cmd === 'suggest' ? c.decisionId : c.cmd)).toEqual(['d1', 'd2', 'd3'])
    await waitFor(() => { expect(within(row()!).queryByRole('status')).toBeNull() })
    expect(within(row()!).getByRole('button', { name: '全部补上' })).toBeInTheDocument()
  })

  it('轮到时已经不缺建议的（别处生成了、处理掉了）跳过，不发', async () => {
    const answers: Array<(r: MemoryCommandResult) => void> = []
    const { gateway, commands } = setup([pair(1, missing), pair(2, missing), pair(3, missing)], {
      respond: () => new Promise((resolve) => { answers.push(resolve) }),
    })
    fireEvent.click(within(row()!).getByRole('button', { name: '全部补上' }))
    await waitFor(() => { expect(answers).toHaveLength(1) })
    act(() => { gateway.setView('pending', view(pair(1, missing), pair(3, missing))) })
    await act(async () => { answers[0]!({ ok: true, cmd: 'suggest', decisionId: 'd1' }) })
    expect(await within(row()!).findByText('正在生成建议 3 / 3……')).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'suggest', decisionId: 'd1' }, { cmd: 'suggest', decisionId: 'd3' }])
  })

  it('「停止」：不再发下一条、不再等；已发出的那条照常写入，随视图出现，已生成的保留', async () => {
    const answers: Array<(r: MemoryCommandResult) => void> = []
    const { gateway, commands } = setup([pair(1, missing), pair(2, missing), pair(3, missing)], {
      respond: () => new Promise((resolve) => { answers.push(resolve) }),
    })
    fireEvent.click(within(row()!).getByRole('button', { name: '全部补上' }))
    fireEvent.click(await within(row()!).findByRole('button', { name: '停止' }))
    expect(row()).toHaveTextContent('3 条还没有建议')
    expect(within(blocks()[0]!).getByRole('button', { name: '补上建议' })).toBeInTheDocument()
    // 已发出的那条回来了、视图带来它的建议：不再发下一条
    act(() => { gateway.setView('pending', view(pair(1, { suggestion: keepA }), pair(2, missing), pair(3, missing))) })
    await act(async () => { answers[0]!({ ok: true, cmd: 'suggest', decisionId: 'd1' }) })
    expect(commands()).toEqual([{ cmd: 'suggest', decisionId: 'd1' }])
    expect(within(blocks()[0]!).getByText('保留 A')).toBeInTheDocument()
    expect(row()).toHaveTextContent('2 条还没有建议')
  })

  it('发出去才知道拿不到模型：停下，行内写原因，不再发', async () => {
    const { commands } = setup([pair(1, missing), pair(2, missing)], { respond: () => ({ ok: false, cmd: 'suggest', code: 'llm-unavailable' }) })
    fireEvent.click(within(row()!).getByRole('button', { name: '全部补上' }))
    await waitFor(() => { expect(row()).toHaveAttribute('role', 'alert') })
    expect(row()).toHaveTextContent('拿不到当前会话的模型。')
    expect(commands()).toEqual([{ cmd: 'suggest', decisionId: 'd1' }])
    expect(screen.queryByRole('button', { name: '全部补上' })).toBeNull()
  })

  it('英文界面的进度和按钮', async () => {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(pair(1, missing), pair(2, missing)), health: scannedHealth(NOW) }, respond: () => new Promise(() => {}) })
    render(
      <PanelShell gateway={gateway} t={createTranslator(en)}>
        <PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} />
      </PanelShell>,
    )
    expect(row()).toHaveTextContent('2 without a suggestion')
    fireEvent.click(within(row()!).getByRole('button', { name: 'Suggest all' }))
    expect(await within(row()!).findByText('Generating suggestions 1 / 2…')).toBeInTheDocument()
  })
})

describe('横向冲突卡：采纳建议、直接处理（票 05）', () => {
  type Horizontal = Extract<PendingItem, { kind: 'conflict-horizontal' }>
  const withState = (extra: Partial<Horizontal>): PendingItem => ({ ...horizontal, ...extra }) as PendingItem
  const keepA: Suggestion = { id: 'sg_1', action: 'keep-a', reason: 'A 是你明确说过的，B 是推断的。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'forget', memoryId: 'b' }] }
  const keepBoth: Suggestion = { id: 'sg_3', action: 'keep-both', reason: '两条说的是不同场景。', isSourced: false, ops: [{ kind: 'keep', memoryId: 'a' }, { kind: 'keep', memoryId: 'b' }] }
  const merged: Suggestion = {
    id: 'sg_2', action: 'merge', reason: '两边各有适用场景。', isSourced: false,
    // 融合稿的名称和两条原名都不同：锁住结果里各处取的是融合前还是融合后的名称
    ops: [{ kind: 'edit', memoryId: 'a', content: '集成测试用真实 Postgres。', name: 'db-in-tests', summary: A.summary, tags: [] }, { kind: 'forget', memoryId: 'b' }],
  }
  const DIRECT = ['保留 A', '保留 B', '并成版本', '确实不冲突', '记成例外']
  const rowOf = () => document.querySelector('.pm-conflict-actions') as HTMLElement
  const labelsOf = (row: HTMLElement) => [...row.querySelectorAll('button')].map(b => b.textContent)
  const press = async (button: HTMLElement) => {
    button.focus()
    await act(async () => { fireEvent.click(button) })
  }

  it('建议保留 A：说明行写采纳后果，按钮行「采纳建议」（主按钮）在前；点了直接发 apply-proposal（只带条目 id 和建议 id），不加确认', async () => {
    const { commands } = setup([withState({ suggestion: keepA })])
    expect(screen.getByText('采纳后「mock-db-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    expect(labelsOf(rowOf())).toEqual(['采纳建议', ...DIRECT])
    const adopt = screen.getByRole('button', { name: '采纳建议' })
    expect(adopt).toHaveClass('pm-btn--primary')
    expect(adopt.tagName).toBe('BUTTON')
    await press(adopt)
    expect(screen.queryByRole('group')).toBeNull()
    await waitFor(() => { expect(commands()).toEqual([{ cmd: 'apply-proposal', decisionId: 'd-h', suggestionId: 'sg_1' }]) })
  })

  it('采纳后结果卡：「已保留」写留下那条的名称，写「按模型建议处理。」和去向（被删那条也写名称），带撤销、焦点落在「撤销」；撤销发 undo，视图带回后建议还在', async () => {
    const { gateway, commands } = setup([withState({ suggestion: keepA })], { respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-h' }) as MemoryCommandResult })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('已保留「postgres-in-tests」')).toBeInTheDocument()
    expect(screen.getByText('按模型建议处理。「mock-db-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
    act(() => { gateway.setView('pending', view()) })
    await press(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-h' }) })
    act(() => { gateway.setView('pending', view(withState({ suggestion: keepA }))) })
    expect(await screen.findByRole('button', { name: '采纳建议' })).toBeInTheDocument()
    expect(screen.getByText('A 是你明确说过的，B 是推断的。')).toBeInTheDocument()
  })

  it('建议都保留：说明行写两条都留着；采纳后「两条都保留」「按模型建议处理。以后体检不再把它们当冲突。」，可撤销', async () => {
    setup([withState({ suggestion: keepBoth })])
    expect(screen.getByText('采纳后两条都留着，以后体检不再把它们当冲突。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('两条都保留')).toBeInTheDocument()
    expect(screen.getByText('按模型建议处理。以后体检不再把它们当冲突。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销' })).toBeInTheDocument()
  })

  it('建议回查过两条的出处：说明行先写这一句，再写采纳后果；没回查到时不写', () => {
    const first = setup([withState({ suggestion: { ...keepA, isSourced: true } })])
    expect(screen.getByText('建议是回查两条的出处后给出的。采纳后「mock-db-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    first.unmount()
    const second = setup([withState({ suggestion: { ...keepBoth, isSourced: true } })])
    expect(screen.getByText('建议是回查两条的出处后给出的。采纳后两条都留着，以后体检不再把它们当冲突。')).toBeInTheDocument()
    second.unmount()
    setup([withState({ suggestion: keepA })])
    expect(screen.queryByText(/出处/)).toBeNull()
  })

  it('英文界面：回查过出处的说明行', () => {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(withState({ suggestion: { ...keepA, isSourced: true } })), health: scannedHealth(NOW) } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} /></PanelShell>)
    expect(screen.getByText('This suggestion was made after looking up the conversations both memories came from. If you adopt it, “mock-db-in-tests” moves to Recently deleted and can be restored within 14 days.')).toBeInTheDocument()
  })

  it('建议保留 B：说明行和结果都用名称指代，B 留下、A 进最近删除', async () => {
    setup([withState({ suggestion: { ...keepA, action: 'keep-b', ops: [{ kind: 'forget', memoryId: 'a' }, { kind: 'keep', memoryId: 'b' }] } })])
    expect(screen.getByText('采纳后「postgres-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('已保留「mock-db-in-tests」')).toBeInTheDocument()
    expect(screen.getByText('按模型建议处理。「postgres-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
  })

  it('融合建议：说明行用名称写采纳后被并入的那条去哪，「采纳建议」在前；点了直接发 apply-proposal，不加确认', async () => {
    const { commands } = setup([withState({ suggestion: merged })])
    expect(screen.getByText('采纳后「mock-db-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    expect(labelsOf(rowOf())).toEqual(['采纳建议', ...DIRECT])
    await press(screen.getByRole('button', { name: '采纳建议' }))
    expect(screen.queryByRole('group')).toBeNull()
    await waitFor(() => { expect(commands()).toEqual([{ cmd: 'apply-proposal', decisionId: 'd-h', suggestionId: 'sg_2' }]) })
  })

  it('采纳融合后结果卡：「已融合成一条」，保留的那条显示融合稿，写来由和去向，撤销发 undo（冲突条目）', async () => {
    const { commands } = setup([withState({ suggestion: merged })], {
      respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-h', memoryIds: ['a', 'b'], snapshotId: 'snap' }) as MemoryCommandResult,
    })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('已融合成一条')).toBeInTheDocument()
    expect(screen.getByText('按模型建议处理。「mock-db-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
    expect(screen.getByText('集成测试用真实 Postgres。')).toBeInTheDocument()
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
    await press(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-h' }) })
  })

  it('采纳融合后撤销被拒（融合稿落盘后又被改过，服务端回 stale）：结果卡写明没有撤销，融合结果照旧显示', async () => {
    const { commands } = setup([withState({ suggestion: merged })], {
      respond: command => (command.cmd === 'undo'
        ? { ok: false, cmd: command.cmd, code: 'stale', detail: '融合稿之后又被改过' }
        : { ok: true, cmd: command.cmd, decisionId: 'd-h', memoryIds: ['a', 'b'], snapshotId: 'snap' }) as MemoryCommandResult,
    })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('已融合成一条')).toBeInTheDocument()
    await press(screen.getByRole('button', { name: '撤销' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('这条记忆之后又被改过，撤销会冲掉之后的改动，没有撤销。')
    expect(commands().at(-1)).toEqual({ cmd: 'undo', decisionId: 'd-h' })
    expect(screen.getByText('已融合成一条')).toBeInTheDocument()
    expect(screen.getByText('集成测试用真实 Postgres。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
  })

  it('融合稿写进 B 时：说明行和结果都写 A 的名称进最近删除', async () => {
    const intoB: Suggestion = { ...merged, ops: [{ kind: 'forget', memoryId: 'a' }, { ...merged.ops[0]!, memoryId: 'b' } as Suggestion['ops'][number]] }
    setup([withState({ suggestion: intoB })], { respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-h' }) as MemoryCommandResult })
    expect(screen.getByText('采纳后「postgres-in-tests」进最近删除，14 天内可恢复。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('按模型建议处理。「postgres-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
  })

  it.each([
    ['退回时写盘出错、融合稿还在', { decisionId: 'pd_batch', memoryIds: ['a'], unrecordedIds: [] }, '「db-in-tests」已写成融合稿，「mock-db-in-tests」没有删除。撤销可把「db-in-tests」退回原样。', { cmd: 'undo', decisionId: 'pd_batch' }],
    ['退回前 A 又被别处改过', { memoryIds: [], unrecordedIds: ['a'] }, '「mock-db-in-tests」没有删除；「postgres-in-tests」退回前又被别处改过，停在那边的版本。', undefined],
    ['A 已退回、B 仍被删', { decisionId: 'pd_batch', memoryIds: ['b'], unrecordedIds: [] }, '这次融合没有做完，「postgres-in-tests」、「mock-db-in-tests」现在的内容以记忆列表为准。撤销可退回这次留下的改动。', { cmd: 'undo', decisionId: 'pd_batch' }],
    ['两条都被别处改过', { memoryIds: [], unrecordedIds: ['a', 'b'] }, '这次融合没有做完，「postgres-in-tests」、「mock-db-in-tests」现在的内容以记忆列表为准。', undefined],
  ] as const)('采纳融合只完成了一部分（%s）：结果卡用名称如实写，能撤的按那一笔撤', async (_label, partial, body, undo) => {
    const { commands } = setup([withState({ suggestion: merged })], {
      respond: command => ({ ok: true, cmd: command.cmd, snapshotId: 'snap', isPartial: true, ...partial }) as unknown as MemoryCommandResult,
    })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('只完成了一部分')).toBeInTheDocument()
    expect(screen.getByText(body)).toBeInTheDocument()
    if (undo === undefined) {
      expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
      return
    }
    await press(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual(undo) })
  })

  it.each([
    ['还没生成', { noSuggestion: { code: 'not-generated' } }],
    ['生成失败', { noSuggestion: { code: 'failed', cause: { kind: 'unparseable' } } }],
    ['模型判断不了', { noSuggestion: { code: 'undecided', reason: '两条都没写日期。' } }],
    ['含高危密钥', { right: { ...B, hasSecret: true }, noSuggestion: { code: 'has-secret' } }],
  ] as const)('没有建议（%s）：按钮行是直接处理的五个按钮，没有「采纳建议」', (_label, extra) => {
    setup([withState(extra as Partial<Horizontal>)])
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    expect(labelsOf(rowOf())).toEqual(DIRECT)
  })

  it('直接点「保留 A」：原位确认「保留 A，B 进最近删除？」，确认后走现有裁决命令；结果写「按你的选择处理。」', async () => {
    const { commands } = setup([withState({ noSuggestion: { code: 'not-generated' } })])
    await press(screen.getByRole('button', { name: '保留 A' }))
    const group = screen.getByRole('group', { name: '保留 A，B 进最近删除？' })
    expect(commands()).toEqual([])
    await press(within(group).getByRole('button', { name: '保留 A' }))
    await waitFor(() => { expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' }]) })
    expect(await screen.findByText('已保留「postgres-in-tests」')).toBeInTheDocument()
    expect(screen.getByText('按你的选择处理。「mock-db-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
    await waitFor(() => { expect(screen.getByRole('button', { name: '撤销' })).toHaveFocus() })
  })

  it('有建议时也能不采纳、直接选：「保留 B」确认后发 resolve keep-right，结果写「按你的选择处理。」', async () => {
    const { commands } = setup([withState({ suggestion: keepA })])
    fireEvent.click(screen.getByRole('button', { name: '保留 B' }))
    fireEvent.click(within(screen.getByRole('group', { name: '保留 B，A 进最近删除？' })).getByRole('button', { name: '保留 B' }))
    expect(await screen.findByText('已保留「mock-db-in-tests」')).toBeInTheDocument()
    expect(screen.getByText('按你的选择处理。「postgres-in-tests」已删除，14 天内可恢复。')).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-right' }])
  })

  it('「确实不冲突」：确认「确实不冲突？两条都留着，以后体检不再报它们」后发 resolve not-conflict', async () => {
    const { commands } = setup([withState({ noSuggestion: { code: 'not-generated' } })])
    fireEvent.click(screen.getByRole('button', { name: '确实不冲突' }))
    fireEvent.click(within(screen.getByRole('group', { name: '确实不冲突？两条都留着，以后体检不再报它们' })).getByRole('button', { name: '确实不冲突' }))
    expect(await screen.findByText('已标为不冲突')).toBeInTheDocument()
    expect(screen.getByText('按你的选择处理。两条都留着；它们都不变时，体检不再报这一对。')).toBeInTheDocument()
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'not-conflict' }])
  })

  it('原位确认点「取消」：什么都不发，焦点回到原来的按钮', async () => {
    const { commands } = setup([withState({ noSuggestion: { code: 'not-generated' } })])
    await press(screen.getByRole('button', { name: '保留 A' }))
    await press(within(screen.getByRole('group')).getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '保留 A' })).toHaveFocus() })
    expect(commands()).toEqual([])
  })

  it('败方含高危密钥：确认写「将彻底删除、不可恢复」；彻底删除后结果卡没有撤销', async () => {
    const { commands } = setup([withState({ right: { ...B, hasSecret: true }, noSuggestion: { code: 'has-secret' } })], {
      respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-h', isHardDeleted: true }) as MemoryCommandResult,
    })
    await press(screen.getByRole('button', { name: '保留 A' }))
    expect(screen.getByText('保留 A：B 含密钥，将彻底删除、不可恢复。')).toBeInTheDocument()
    expect(commands()).toEqual([])
    await press(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('已保留「postgres-in-tests」')).toBeInTheDocument()
    expect(screen.getByText('按你的选择处理。「mock-db-in-tests」含密钥，已彻底删除。如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    expect(commands()).toEqual([{ cmd: 'resolve', decisionId: 'd-h', verdict: 'keep-left' }])
  })

  it('采纳时要删的那条含高危密钥：说明行和确认都写「将彻底删除、不可恢复」，确认后才发 apply-proposal；结果卡写按模型建议、没有撤销', async () => {
    const { commands } = setup([withState({ right: { ...B, hasSecret: true }, suggestion: keepA })], {
      respond: command => ({ ok: true, cmd: command.cmd, decisionId: 'd-h', isHardDeleted: true }) as MemoryCommandResult,
    })
    expect(screen.getByText('「mock-db-in-tests」含密钥，采纳后将彻底删除、不可恢复。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    expect(screen.getByText('保留 A：B 含密钥，将彻底删除、不可恢复。')).toBeInTheDocument()
    expect(commands()).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
    expect(await screen.findByText('按模型建议处理。「mock-db-in-tests」含密钥，已彻底删除。如果它是真的凭证，记得去换一个新的。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
    expect(commands()).toEqual([{ cmd: 'apply-proposal', decisionId: 'd-h', suggestionId: 'sg_1' }])
  })

  it('另一方含密钥、要删的这条不含：照常软删确认', () => {
    setup([withState({ right: { ...B, hasSecret: true }, noSuggestion: { code: 'has-secret' } })])
    fireEvent.click(screen.getByRole('button', { name: '保留 B' }))
    expect(screen.getByRole('group', { name: '保留 B，A 进最近删除？' })).toBeInTheDocument()
  })

  it('采纳时建议已失效（服务端回 stale）：不落盘，卡片退化成没有建议、写明原因，只剩直接处理的按钮，不报通用错误', async () => {
    setup([withState({ suggestion: keepA })], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '建议已失效', memoryIds: ['a', 'b'] }) as MemoryCommandResult })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    expect(await screen.findByText('这两条刚被改过，建议已失效。下次体检会重新给建议，现在可以直接选处理方式。')).toBeInTheDocument()
    expect(screen.queryByText('A 是你明确说过的，B 是推断的。')).toBeNull()
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    expect(labelsOf(rowOf())).toEqual(DIRECT)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('已保留「postgres-in-tests」')).toBeNull()
    // 焦点不掉到页首：落在卡上剩下的控件
    await waitFor(() => { expect(document.activeElement?.closest('.pm-pending-item')).not.toBeNull() })
  })

  it('建议失效后视图带来更新的原因（模型判断不了）：写视图给的原因，不再写「建议已失效」', async () => {
    const { gateway } = setup([withState({ suggestion: keepA })], { respond: command => ({ ok: false, cmd: command.cmd, code: 'stale', detail: '建议已失效', memoryIds: ['a', 'b'] }) as MemoryCommandResult })
    await press(screen.getByRole('button', { name: '采纳建议' }))
    await screen.findByText(/建议已失效/)
    act(() => { gateway.setView('pending', view(withState({ noSuggestion: { code: 'undecided', reason: '两条同一天写的，分不出哪条对。' } }))) })
    expect(await screen.findByText('模型判断不了哪条对')).toBeInTheDocument()
    expect(screen.getByText('两条同一天写的，分不出哪条对。')).toBeInTheDocument()
    expect(screen.queryByText(/建议已失效/)).toBeNull()
  })

  it('彻底删除的确认开着时卡上的建议换了一份：确认不发命令，按失效处理，显示新的一份', async () => {
    const secretB = { ...B, hasSecret: true as const }
    const keepASecret = withState({ right: secretB, suggestion: keepA })
    const { gateway, commands } = setup([keepASecret])
    await press(screen.getByRole('button', { name: '采纳建议' }))
    const confirm = await screen.findByRole('button', { name: '彻底删除' })
    act(() => { gateway.setView('pending', view(withState({ right: secretB, suggestion: { ...keepA, id: 'sg_9', reason: '换了一份理由。' } }))) })
    await press(confirm)
    expect(commands()).toEqual([])
    expect(await screen.findByText('换了一份理由。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '采纳建议' })).toBeInTheDocument()
  })

  it('建议失效后视图带来新的一份（id 不同）：显示新建议，「采纳建议」回来、发新 id', async () => {
    const { gateway, commands } = setup([withState({ suggestion: keepA })], {
      respond: command => (command.cmd === 'apply-proposal' && command.suggestionId === 'sg_1'
        ? { ok: false, cmd: command.cmd, code: 'stale', detail: '建议已失效', memoryIds: ['a', 'b'] }
        : { ok: true, cmd: command.cmd, decisionId: 'd-h' }) as MemoryCommandResult,
    })
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    await screen.findByText(/建议已失效/)
    // 视图还带着同一份旧建议：仍按失效处理
    act(() => { gateway.setView('pending', view(withState({ suggestion: keepA }))) })
    expect(screen.queryByRole('button', { name: '采纳建议' })).toBeNull()
    act(() => { gateway.setView('pending', view(withState({ suggestion: { ...keepBoth, id: 'sg_9' } }))) })
    fireEvent.click(await screen.findByRole('button', { name: '采纳建议' }))
    await waitFor(() => { expect(commands().at(-1)).toEqual({ cmd: 'apply-proposal', decisionId: 'd-h', suggestionId: 'sg_9' }) })
  })

  it('采纳在途：按钮都不可用（不发第二次）；其它失败原位报错，卡片照旧', async () => {
    let answer!: (r: MemoryCommandResult) => void
    const { commands } = setup([withState({ suggestion: keepA })], { respond: () => new Promise((resolve) => { answer = resolve }) })
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '采纳建议' })).toHaveAttribute('aria-disabled', 'true') })
    expect(screen.getByRole('button', { name: '保留 A' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    expect(commands()).toHaveLength(1)
    await act(async () => { answer({ ok: false, cmd: 'apply-proposal', code: 'failed', detail: '磁盘满了' } as MemoryCommandResult) })
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘满了')
    expect(screen.getByRole('button', { name: '采纳建议' })).not.toHaveAttribute('aria-disabled')
    expect(screen.getByText('A 是你明确说过的，B 是推断的。')).toBeInTheDocument()
  })

  it('采纳时条目已在别处处理（not-found）：交给列表提示别处已处理', async () => {
    setup([withState({ suggestion: keepA })], { respond: command => ({ ok: false, cmd: command.cmd, code: 'not-found' }) as MemoryCommandResult })
    fireEvent.click(screen.getByRole('button', { name: '采纳建议' }))
    await waitFor(() => { expect(document.querySelector('.pm-pending-refused')).not.toBeNull() })
  })

  it('英文界面：按钮、说明行、结果卡都有英文', async () => {
    const gateway = createFakeGateway({ session: SESSION, config, views: { pending: view(withState({ suggestion: keepA })), health: scannedHealth(NOW) } })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><PendingTab nav={createNavStore()} session={SESSION} scope={ALL_SCOPE} workspacePath="/w/app" now={NOW} /></PanelShell>)
    expect(screen.getByText('If you adopt it, “mock-db-in-tests” moves to Recently deleted and can be restored within 14 days.')).toBeInTheDocument()
    expect(labelsOf(rowOf())).toEqual(['Adopt suggestion', 'Keep A', 'Keep B', 'Merge as versions', 'Not a conflict', 'Mark as exception'])
    fireEvent.click(screen.getByRole('button', { name: 'Adopt suggestion' }))
    expect(await screen.findByText('Kept “postgres-in-tests”')).toBeInTheDocument()
    expect(screen.getByText('Done as the model suggested. “mock-db-in-tests” was deleted and can be restored within 14 days.')).toBeInTheDocument()
  })
})
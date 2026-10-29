// 插件设置页：三组设置的渲染、revision 冻结与冲突提示、非法值、配置文件关掉体检时置灰、状态卡。场景与类型见 Scenes.spec.tsx。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type LibraryView, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en, zh } from '../locales.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { PanelShell } from '../ui/PanelShell.tsx'
import { createFakeConfigForm, DEFAULT_SECTION, type FakeConfigForm } from './config-form.fake.ts'
import { SettingsPage } from './SettingsPage.tsx'
import { summarize } from './StatusCard.tsx'

const t = createTranslator(zh)

const library = (count: number, memoryRoot = '/home/me/.dsh/memories'): LibraryView => ({
  version: GUI_VIEW_VERSION, memoryRoot, directoryIssues: [],
  layers: [{ layer: { kind: 'global' }, items: Array.from({ length: count }, (_, i) => memory({ id: `m${i}` })) }],
})
const health = (lastCheckupAt: number | null): HealthView => ({
  version: GUI_VIEW_VERSION,
  governanceEnabled: true,
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 90, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0, lastCheckupAt, overflow: null, ignored: [], deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } } }],
})
const pending = (items: PendingView['items'] = []): PendingView => ({ version: GUI_VIEW_VERSION, dot: 'none', items, levelCounts: levelCountsOf(items), typeLabels: {} })

function setup(opts: { value?: Record<string, unknown>; views?: boolean; writable?: boolean } = {}) {
  const form = createFakeConfigForm({ ...(opts.value ? { value: opts.value } : {}), ...(opts.writable === false ? { writable: false } : {}) })
  const gateway = createFakeGateway(opts.views === false ? {} : { views: { pending: pending(), health: health(NOW), library: library(3) } })
  const onOpen = vi.fn()
  const view = renderInShell(<SettingsPage form={form} onOpenMemoryPage={onOpen} now={NOW} />, gateway)
  return { form, onOpen, ...view }
}

const section = (patch: Record<string, unknown>) => ({ ...structuredClone(DEFAULT_SECTION), ...patch })
const tab = (group: string, name: string) => within(screen.getByRole('tablist', { name: group })).getByRole('tab', { name })
const radio = (name: string) => screen.getByRole('radio', { name })
const save = () => screen.getByRole('button', { name: '保存' })

const confirmDialog = () => screen.getByRole('dialog', { name: '保存这些改动？' })

/** 点保存，再在确认弹窗里点保存。 */
async function clickSave(form: FakeConfigForm) {
  const before = form.calls.length
  fireEvent.click(save())
  await act(async () => { fireEvent.click(within(confirmDialog()).getByRole('button', { name: '保存' })) })
  await waitFor(() => { expect(form.calls.length).toBe(before + 1) })
}

describe('三组设置的渲染', () => {
  it('记什么：场景单选列表、我加的类型一览', () => {
    setup({ value: section({ template: 'office', customTypes: { 'domain-term': { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' } } }) })
    expect(screen.getByRole('heading', { name: '记什么' })).toBeInTheDocument()
    expect(radio('办公')).toBeChecked()
    expect(radio('编码')).not.toBeChecked()
    expect(radio('通用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '术语' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '管理 ›' })).toBeInTheDocument()
  })

  it('怎么用：上限数字、超出上限两种模式的说明、溯源三档', () => {
    setup({ value: section({ snapshotTokenBudget: 6000, snapshotOverflow: 'strict', evidenceLookup: 'active' }) })
    expect(screen.getByLabelText('自动带入的记忆上限（token）')).toHaveValue('6000')
    expect(screen.getByText(/^默认 4,000，/)).toBeInTheDocument()
    expect(tab('超出上限时', '严格按上限')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/自动放宽：超出的照常带入/)).toBeInTheDocument()
    expect(screen.getByText(/严格按上限：超出的不带入/)).toBeInTheDocument()
    expect(tab('溯源记忆出处', '主动积极')).toHaveAttribute('aria-selected', 'true')
    expect(tab('溯源记忆出处', '仅你要求时')).toBeInTheDocument()
    expect(tab('溯源记忆出处', '遇到矛盾或高风险时')).toBeInTheDocument()
  })

  it('怎么管：没有体检开关和自动体检占位；灵敏度说明带数值、AGENTS.md 说明插件不再管理、最近删除入口、memoryRoot 只读', () => {
    const { onOpen } = setup({ value: section({ governance: { enabled: true, health: { sensitivity: 'conservative' }, globalPromoteTarget: 'agents-md' } }) })
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByText('记忆体检')).toBeNull()
    expect(screen.queryByText('规划中')).toBeNull()
    expect(screen.queryByRole('tablist', { name: '自动体检' })).toBeNull()
    expect(screen.queryByText('体检已在配置文件里关闭')).toBeNull()
    expect(screen.getByText('健康分低于 60 分、或冲突等了 14 天以上时提醒你。')).toBeInTheDocument()
    fireEvent.click(tab('提醒的灵敏度', '积极'))
    expect(screen.getByText('健康分低于 80 分、或冲突等了 3 天以上时提醒你。')).toBeInTheDocument()
    expect(screen.getByText(/插件不再管理这些内容/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看最近删除 ›' }))
    expect(onOpen).toHaveBeenCalledWith({ view: 'deleted', scope: { kind: 'all' } })
    expect(screen.getByText('/home/me/.dsh/memories')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '记忆文件位置' })).toBeNull()
  })

  it('还没读到视图时 memoryRoot 显示配置值，都没有就提示开会话', () => {
    const { unmount } = setup({ views: false, value: section({ memoryRoot: '/data/mem' }) })
    expect(screen.getByText('/data/mem')).toBeInTheDocument()
    unmount()
    setup({ views: false })
    expect(screen.getByText('开一个会话后显示实际路径。')).toBeInTheDocument()
  })

  it('配置还在加载时只显示一行；宿主不服务这份配置时只显示提示', () => {
    const form = createFakeConfigForm({ status: 'loading' })
    const { unmount } = renderInShell(<SettingsPage form={form} onOpenMemoryPage={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在读取配置…')
    unmount()
    renderInShell(<SettingsPage form={createFakeConfigForm({ status: 'unavailable' })} onOpenMemoryPage={() => {}} />)
    expect(screen.getByText('DeepSeek Harness 暂时没有提供这份配置。')).toBeInTheDocument()
  })
})

describe('保存：revision 冻结、冲突、非法值', () => {
  it('点保存先弹窗列出改了哪几项（名称：旧值 → 新值），取消不提交、草稿保留', () => {
    const { form } = setup()
    fireEvent.click(radio('办公'))
    fireEvent.change(screen.getByLabelText('自动带入的记忆上限（token）'), { target: { value: '5000' } })
    fireEvent.click(tab('提醒的灵敏度', '积极'))
    fireEvent.click(save())
    const items = within(confirmDialog()).getAllByRole('listitem').map(el => el.textContent)
    expect(items).toEqual([
      '当前场景：编码 → 办公',
      '自动带入的记忆上限（token）：4000 → 5000',
      '提醒的灵敏度：标准 → 积极',
    ])
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(form.calls).toHaveLength(0)
    expect(radio('办公')).toBeChecked()
    expect(save()).toBeEnabled()
  })

  it('没有改动时保存置灰；多项改动一次 mutate，带开始编辑时的 revision；保存后回到干净状态', async () => {
    const { form } = setup()
    expect(save()).toBeDisabled()
    fireEvent.click(tab('超出上限时', '严格按上限'))
    fireEvent.change(screen.getByLabelText('自动带入的记忆上限（token）'), { target: { value: '5000' } })
    fireEvent.click(tab('提醒的灵敏度', '积极'))
    expect(screen.getByText('已有对话的下一条消息会重新载入记忆，多消耗一些 token。')).toBeInTheDocument()
    await clickSave(form)
    expect(form.calls).toEqual([{
      expectedRevision: 1,
      ops: [
        { op: 'set', path: ['snapshotTokenBudget'], value: 5000 },
        { op: 'set', path: ['snapshotOverflow'], value: 'strict' },
        { op: 'set', path: ['governance', 'health', 'sensitivity'], value: 'proactive' },
      ],
    }])
    await waitFor(() => { expect(save()).toBeDisabled() })
    expect(form.value.snapshotTokenBudget).toBe(5000)
    expect(screen.queryByText(/重新载入记忆/)).toBeNull()
  })

  it('编辑中别处改了配置：保存仍带冻结的 revision，被拒后提示冲突、锁住保存；载入最新配置后按新 revision 再改', async () => {
    const { form } = setup()
    fireEvent.click(tab('溯源记忆出处', '主动积极'))
    act(() => { form.externalChange([{ op: 'set', path: ['template'], value: 'office' }]) })
    expect(radio('办公')).toBeChecked()
    await clickSave(form)
    expect(form.calls[0]!.expectedRevision).toBe(1)
    expect(await screen.findByRole('alert')).toHaveTextContent('这份配置刚在别处改过，你的改动没有保存。')
    expect(save()).toBeDisabled()
    expect(form.value.evidenceLookup).toBe('strict')

    fireEvent.click(screen.getByRole('button', { name: '载入最新配置' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(tab('溯源记忆出处', '遇到矛盾或高风险时')).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(tab('溯源记忆出处', '主动积极'))
    await clickSave(form)
    expect(form.calls[1]!.expectedRevision).toBe(2)
    await waitFor(() => { expect(form.value.evidenceLookup).toBe('active') })
    expect(form.value.template).toBe('office')
  })

  it('非法上限就地标红、不提交', () => {
    const { form } = setup()
    const input = screen.getByLabelText('自动带入的记忆上限（token）')
    for (const bad of ['-5', '0', '3.5', 'abc', '']) {
      fireEvent.change(input, { target: { value: bad } })
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByText('填一个大于 0 的整数。')).toBeInTheDocument()
      expect(save()).toBeDisabled()
    }
    fireEvent.click(save())
    expect(form.calls).toHaveLength(0)
  })

  it('宿主校验拒绝（revision 没变）：提示保存失败，草稿保留可再试', async () => {
    const { form } = setup()
    fireEvent.click(radio('办公'))
    form.rejectNext()
    await clickSave(form)
    expect(await screen.findByText('没有保存成功，再试一次。')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(radio('办公')).toBeChecked()
    await clickSave(form)
    await waitFor(() => { expect(form.value.template).toBe('office') })
  })

  it('配置只读时控件禁用', () => {
    setup({ writable: false })
    expect(screen.getByText('当前配置是只读的，改不了。')).toBeInTheDocument()
    expect(radio('办公')).toBeDisabled()
    expect(screen.getByRole('button', { name: '新建场景' })).toBeDisabled()
    expect(tab('提醒的灵敏度', '积极')).toBeDisabled()
  })
})

describe('上限说明：按字符估算的口径', () => {
  const description = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-describedby')!)

  it('写明默认 4,000 约合多少字，以及中日韩文字、全角标点与其余字符各按多少估算', () => {
    setup()
    const hint = description(screen.getByLabelText('自动带入的记忆上限（token）'))
    expect(hint).toHaveTextContent('默认 4,000，约合 6,700 个汉字或 13,000 个英文字符：中日韩文字和全角标点每个按 0.6 token 估算，其余字符按 0.3。')
    expect(hint).toHaveTextContent('对话中检索到的记忆不计入。')
  })

  it('英文文案同一口径', () => {
    render(<PanelShell gateway={createFakeGateway()} t={createTranslator(en)}><SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} /></PanelShell>)
    const hint = description(screen.getByLabelText('Auto-loaded memory limit (tokens)'))
    expect(hint).toHaveTextContent('Default 4,000, about 6,700 Chinese characters or 13,000 English characters: each CJK character or full-width punctuation mark counts as 0.6 tokens, any other character 0.3.')
    expect(hint).toHaveTextContent("Memories found by search during a chat don't count.")
  })
})

describe('用户词典路径', () => {
  it('设置页不再显示这一项；保存别的项时不写回、不清掉配置文件里的路径', async () => {
    const { form } = setup({ value: section({ search: { userDictionaryPath: '/opt/dict/domain.txt' } }) })
    expect(screen.queryByText('用户词典路径')).toBeNull()
    fireEvent.change(screen.getByLabelText('自动带入的记忆上限（token）'), { target: { value: '5000' } })
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['snapshotTokenBudget'], value: 5000 }])
    expect(form.value.search).toEqual({ userDictionaryPath: '/opt/dict/domain.txt' })
  })
})

describe('配置文件关掉体检时置灰', () => {
  const off = (enabled: boolean) => section({ governance: { enabled, health: { sensitivity: 'normal' }, globalPromoteTarget: 'plugin-global' } })

  it('灵敏度、跨项目去向置灰保留，说明都写「体检已在配置文件里关闭」；界面上没有能打开它的开关', () => {
    setup({ value: off(false) })
    for (const group of ['提醒的灵敏度', '跨项目的记忆放到']) {
      const list = screen.getByRole('tablist', { name: group })
      for (const button of within(list).getAllByRole('tab')) expect(button).toBeDisabled()
      const item = list.closest('.pm-setting')!
      expect(item).toHaveClass('pm-setting--disabled')
      expect(item.querySelector('.pm-setting-hint')).toHaveTextContent(/^体检已在配置文件里关闭$/)
    }
    expect(screen.queryByRole('switch')).toBeNull()
    // 不依赖体检的项照常可改
    expect(radio('办公')).toBeEnabled()
  })

  it('别处在配置文件里打开体检后，两项恢复可用、说明换回原文', () => {
    const { form } = setup({ value: off(false) })
    act(() => { form.externalChange([{ op: 'set', path: ['governance', 'enabled'], value: true }]) })
    expect(tab('提醒的灵敏度', '积极')).toBeEnabled()
    expect(tab('跨项目的记忆放到', 'AGENTS.md')).toBeEnabled()
    expect(screen.getByText('健康分低于 70 分、或冲突等了 7 天以上时提醒你。')).toBeInTheDocument()
    expect(screen.queryByText('体检已在配置文件里关闭')).toBeNull()
  })

  it('英文文案同一口径', () => {
    const enT = createTranslator(en)
    expect(enT('settings.governanceOff')).toBe('Checkups are turned off in the config file')
  })
})

describe('状态卡', () => {
  const views = (p = pending(), h = health(NOW), l = library(3)) => ({ pending: p, health: h, library: l })
  const conflict = { kind: 'conflict-horizontal' as const, level: 'your-call' as const, decisionId: 'd', firstSeenAt: NOW, summary: 's', left: null, right: null }
  const unreadable = { kind: 'unreadable-file' as const, level: 'must-fix' as const, layer: { kind: 'global' as const }, filePath: '/f', relativePath: 'f', error: 'e' }

  it('英文记忆数按单复数：1 memory、3 memories；中文不变', () => {
    const enT = createTranslator(en)
    expect(summarize(views(pending(), health(NOW), library(1)), false, NOW, enT).detail).toBe('1 memory')
    expect(summarize(views(), false, NOW, enT).detail).toBe('3 memories')
    expect(summarize(views(pending(), health(NOW), library(1)), false, NOW, t).detail).toBe('共 1 条记忆')
  })

  it('结论按优先级：配置文件关掉体检 → 密钥 → 等你决定 → 没有记忆 → 没体检 → 良好', () => {
    expect(summarize(views(), false, NOW, t)).toEqual({ conclusion: '体检已在配置文件里关闭', detail: '共 3 条记忆' })
    expect(summarize(views(pending([{ kind: 'secret', level: 'must-fix', memory: memory() }, conflict])), true, NOW, t).marker).toBe('secret')
    expect(summarize(views(pending([conflict, conflict, unreadable])), true, NOW, t))
      .toEqual({ marker: 'pending', conclusion: '有 2 处等你决定', detail: '共 3 条记忆 · 上次体检：刚刚' })
    expect(summarize(views(pending(), health(null), library(0)), true, NOW, t)).toEqual({ conclusion: '还没有记忆' })
    expect(summarize(views(pending(), health(null)), true, NOW, t)).toEqual({ conclusion: '有记忆，还没体检过', detail: '共 3 条记忆 · 还没体检过' })
    expect(summarize(views(pending(), health(new Date(2026, 9, 3).getTime())), true, NOW, t))
      .toEqual({ marker: 'ok', conclusion: '状态良好', detail: '共 3 条记忆 · 上次体检：10 月 3 日' })
  })

  it('分级后口径不变：「等你决定」只数密钥以外要你拍板的事，不算同在高优问题组的读不出的文件', () => {
    expect(summarize(views(pending([unreadable, unreadable, conflict])), true, NOW, t).conclusion).toBe('有 1 处等你决定')
    expect(summarize(views(pending([unreadable])), true, NOW, t)).toEqual({ marker: 'ok', conclusion: '状态良好', detail: '共 3 条记忆 · 上次体检：刚刚' })
  })

  it('建议整理不算「等你决定」：只有建议时仍是状态良好', () => {
    const advice = { kind: 'advice' as const, level: 'advice' as const, type: 'stale' as const, memories: [memory()] }
    expect(summarize(views(pending([advice, advice, conflict])), true, NOW, t).conclusion).toBe('有 1 处等你决定')
    expect(summarize(views(pending([advice])), true, NOW, t)).toEqual({ marker: 'ok', conclusion: '状态良好', detail: '共 3 条记忆 · 上次体检：刚刚' })
  })

  it('只有结论、条数和上次体检、「打开记忆页 ›」：没有「立即体检」、token 说明和体检结果行', () => {
    const { container } = setup()
    const banner = container.querySelector('.pm-banner') as HTMLElement
    expect(within(banner).getByText('状态良好')).toBeInTheDocument()
    expect(within(banner).getByText('共 3 条记忆 · 上次体检：刚刚')).toBeInTheDocument()
    expect(within(banner).getAllByRole('button').map(b => b.textContent)).toEqual(['打开记忆页 ›'])
    expect(screen.queryByRole('button', { name: /立即体检|正在体检|再试一次/ })).toBeNull()
    expect(banner).not.toHaveTextContent(/token/)
    expect(within(banner).queryByRole('status')).toBeNull()
  })

  it('「打开记忆页 ›」落在「全部」的处理视图，不管有没有等你决定的事', () => {
    const { onOpen, gateway } = setup()
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ view: 'todo', scope: { kind: 'all' } })
    act(() => { gateway.setView('pending', pending([conflict])) })
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ view: 'todo', scope: { kind: 'all' } })
  })

  it('结论取配置文件里的体检开关；没有会话时只写一句提示', () => {
    const { gateway } = setup({ value: section({ governance: { enabled: false, health: { sensitivity: 'normal' }, globalPromoteTarget: 'plugin-global' } }) })
    expect(screen.getAllByText('体检已在配置文件里关闭')[0]).toHaveClass('pm-banner-title')
    act(() => { gateway.setSession({ kind: 'none' }) })
    expect(screen.getByText('开一个会话后这里显示记忆状态')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '打开记忆页 ›' })).toBeInTheDocument()
  })
})

describe('记忆文件位置「在访达中显示」', () => {
  it('有实际路径时可以在访达中显示；宿主拒绝时写一句', async () => {
    const gateway = createFakeGateway({ views: { pending: pending(), health: health(NOW), library: library(3, '/home/me/.dsh/memories') }, openOk: false })
    renderInShell(<SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '在访达中显示' })) })
    expect(gateway.opened).toEqual([{ path: '/home/me/.dsh/memories', action: 'reveal' }])
    expect(screen.getByText('没能打开，DeepSeek Harness 拒绝了这个路径。')).toBeInTheDocument()
  })

  it('还不知道路径时没有这个按钮', () => {
    renderInShell(<SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} />, createFakeGateway())
    expect(screen.queryByRole('button', { name: '在访达中显示' })).toBeNull()
  })
})

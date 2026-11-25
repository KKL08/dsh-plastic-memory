// 插件设置页：三组设置的渲染、revision 冻结与冲突提示、非法值、配置文件关掉体检时置灰、状态卡。场景与类型见 Scenes.spec.tsx。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type CheckupView, type HealthView, type LibraryView, type MemoryCommand, type MemoryCommandResult, type ModelChoices, type ModelSelection, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import type { ViewState } from '../gateway.ts'
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
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 90, tier: 'green', gate: { secret: false }, issues: [], lastCheckupAt, ignored: [], deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } } }],
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
  it('记什么：场景、记忆类型各一张列表，页面上不写当前场景的说明', () => {
    setup({ value: section({ template: 'office', customTypes: { 'domain-term': { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' } } }) })
    expect(screen.getByRole('heading', { name: '记什么' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '场景' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '记忆类型' })).toBeInTheDocument()
    expect(radio('办公')).toBeChecked()
    expect(radio('编码')).not.toBeChecked()
    expect(radio('通用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑 术语' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '管理 ›' })).toBeNull()
    expect(screen.queryByText(/^当前：/)).toBeNull()
  })

  it('四组各一张设置卡，组标题在卡外；「记什么」的场景和记忆类型都在它那张卡里', () => {
    const { container } = setup()
    const groups = [...container.querySelectorAll('.pm-group')]
    expect(groups.map(group => group.querySelector('.pm-group-title')!.textContent)).toEqual(['记什么', '怎么用', '怎么管', '外观'])
    for (const group of groups) {
      expect(group.querySelectorAll(':scope > .pm-group-card')).toHaveLength(1)
      expect(group.querySelector('.pm-group-card')!.contains(group.querySelector('.pm-group-title'))).toBe(false)
    }
    const what = groups[0]!.querySelector('.pm-group-card') as HTMLElement
    expect(within(what).getByRole('heading', { name: '场景' })).toBeInTheDocument()
    expect(within(what).getByRole('heading', { name: '记忆类型' })).toBeInTheDocument()
    expect(within(what).getByRole('radiogroup', { name: '场景' })).toBeInTheDocument()
  })

  it('怎么用：上限数字、超出上限两种模式的说明、溯源三档', () => {
    setup({ value: section({ snapshotTokenBudget: 6000, snapshotOverflow: 'strict', evidenceLookup: 'active' }) })
    expect(screen.getByLabelText('对话开始时自动带入的记忆上限（token）')).toHaveValue('6000')
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

  it('外观：主题色两档，默认艾拉主题色；改成大肥鱼主题色确认后写 accent', async () => {
    const { form } = setup()
    expect(screen.getByRole('heading', { name: '外观' })).toBeInTheDocument()
    expect(tab('主题色', '艾拉主题色')).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(tab('主题色', '大肥鱼主题色'))
    fireEvent.click(save())
    expect(within(confirmDialog()).getAllByRole('listitem').map(el => el.textContent)).toEqual(['主题色：艾拉主题色 → 大肥鱼主题色'])
    expect(within(confirmDialog()).queryByText(/重新带入记忆/)).toBeNull()
    await act(async () => { fireEvent.click(within(confirmDialog()).getByRole('button', { name: '保存' })) })
    await waitFor(() => { expect(form.calls).toHaveLength(1) })
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['accent'], value: 'blue-whale' }])
    expect(screen.queryByText(/重新带入记忆/)).toBeNull()
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
    fireEvent.change(screen.getByLabelText('对话开始时自动带入的记忆上限（token）'), { target: { value: '5000' } })
    fireEvent.click(tab('提醒的灵敏度', '积极'))
    fireEvent.click(save())
    const items = within(confirmDialog()).getAllByRole('listitem').map(el => el.textContent)
    expect(items).toEqual([
      '当前场景：编码 → 办公',
      '对话开始时自动带入的记忆上限（token）：4000 → 5000',
      '提醒的灵敏度：标准 → 积极',
    ])
    expect(within(confirmDialog()).getByText('保存后不再新增「可复用流程」类记忆，已有的仍会带入、能搜到。')).toBeInTheDocument()
    expect(within(confirmDialog()).getByText('保存后，已开着的对话发下一条消息时会重新带入记忆，这条消息多用一些 token。')).toBeInTheDocument()
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(form.calls).toHaveLength(0)
    expect(radio('办公')).toBeChecked()
    expect(save()).toBeEnabled()
  })

  it('确认弹窗打开时焦点在弹层的「关闭」上，Esc 关闭后焦点回到「保存」，不提交', async () => {
    const { form } = setup()
    fireEvent.click(radio('办公'))
    save().focus()
    fireEvent.click(save())
    await waitFor(() => { expect(within(confirmDialog()).getByRole('button', { name: '关闭' })).toHaveFocus() })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => { expect(save()).toHaveFocus() })
    expect(form.calls).toHaveLength(0)
  })

  it('确认弹窗里点「保存」后焦点落在保存行（保存按钮这时置灰），不掉回页首', async () => {
    const { form } = setup()
    fireEvent.click(radio('办公'))
    save().focus()
    await clickSave(form)
    await waitFor(() => { expect(save()).toBeDisabled() })
    expect(save().closest('.pm-form-footer')).toHaveFocus()
  })

  it('没有改动时保存置灰；多项改动一次 mutate，带开始编辑时的 revision；保存后回到干净状态', async () => {
    const { form } = setup()
    expect(save()).toBeDisabled()
    fireEvent.click(tab('超出上限时', '严格按上限'))
    fireEvent.change(screen.getByLabelText('对话开始时自动带入的记忆上限（token）'), { target: { value: '5000' } })
    fireEvent.click(tab('提醒的灵敏度', '积极'))
    expect(screen.queryByText(/重新带入记忆/)).toBeNull()
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
    expect(screen.queryByText(/重新带入记忆/)).toBeNull()
  })

  it('保存行写还有几项改动没保存（和确认框的行数一致），没有改动时不写', async () => {
    const { form } = setup()
    expect(screen.queryByText(/项改动未保存/)).toBeNull()
    fireEvent.click(radio('办公'))
    expect(save()).toHaveAccessibleDescription('1 项改动未保存')
    fireEvent.click(tab('提醒的灵敏度', '积极'))
    expect(screen.getByText('2 项改动未保存')).toBeInTheDocument()
    await clickSave(form)
    await waitFor(() => { expect(screen.queryByText(/项改动未保存/)).toBeNull() })
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
    const input = screen.getByLabelText('对话开始时自动带入的记忆上限（token）')
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
    expect(screen.getByRole('button', { name: '新建类型' })).toBeDisabled()
    expect(tab('提醒的灵敏度', '积极')).toBeDisabled()
  })
})

describe('上限说明：默认值约合多少字', () => {
  const description = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-describedby')!)

  it('写明默认 4,000 约合多少字，不展开按字符换算的口径', () => {
    setup()
    const hint = description(screen.getByLabelText('对话开始时自动带入的记忆上限（token）'))
    expect(hint).toHaveTextContent('默认 4,000，约合 6,700 个汉字或 13,000 个英文字符。')
    expect(hint).not.toHaveTextContent('0.6 token')
    expect(hint).toHaveTextContent('对话中检索到的记忆不计入。')
  })

  it('英文文案同一口径', () => {
    render(<PanelShell gateway={createFakeGateway()} t={createTranslator(en)}><SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} /></PanelShell>)
    const hint = description(screen.getByLabelText('Limit for memories auto-loaded at chat start (tokens)'))
    expect(hint).toHaveTextContent('Default 4,000, about 6,700 Chinese characters or 13,000 English characters.')
    expect(hint).not.toHaveTextContent('0.6 tokens')
    expect(hint).toHaveTextContent("Memories found by search during a chat don't count.")
  })
})

describe('用户词典路径', () => {
  it('设置页不再显示这一项；保存别的项时不写回、不清掉配置文件里的路径', async () => {
    const { form } = setup({ value: section({ search: { userDictionaryPath: '/opt/dict/domain.txt' } }) })
    expect(screen.queryByText('用户词典路径')).toBeNull()
    fireEvent.change(screen.getByLabelText('对话开始时自动带入的记忆上限（token）'), { target: { value: '5000' } })
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

  describe('没查全', () => {
    const layer = health(NOW).layers[0]!
    const coverage = (never: number) => ({
      total: 3, checkedNow: 3 - never, never, changed: 0, awaiting: 0, oldestCheckedAt: NOW, baseline: 'read' as const, isReadComplete: true, stopped: 'cap' as const,
    })
    const project = (path: string, patch: Partial<HealthView['layers'][number]>) => ({ ...layer, layer: { kind: 'workspace' as const, workspacePath: path }, ...patch })
    const withLayers = (layers: HealthView['layers']): HealthView => ({ ...health(NOW), layers })

    it('有记忆、从没体检过的范围算没查全：别的范围查过时不说「状态良好」', () => {
      const h = withLayers([layer, project('/w/a', { totalMemories: 2, lastCheckupAt: null })])
      expect(summarize(views(pending(), h), true, NOW, t)).toEqual({ conclusion: '上次体检没查全', detail: '共 3 条记忆 · 上次体检：刚刚' })
      // 没有记忆的范围从没体检过不算
      expect(summarize(views(pending(), withLayers([layer, project('/w/a', { totalMemories: 0, lastCheckupAt: null })])), true, NOW, t).conclusion).toBe('状态良好')
    })

    it('只有一个范围没查全：写它还有几条没查到；几个范围没查全：说有几个范围，不把含全局的条数相加', () => {
      expect(summarize(views(pending(), withLayers([layer, project('/w/a', { coverage: coverage(2) })])), true, NOW, t).conclusion).toBe('上次体检还有 2 条没查到')
      const many = withLayers([{ ...layer, coverage: coverage(1) }, project('/w/a', { coverage: coverage(2) }), project('/w/b', { totalMemories: 1, lastCheckupAt: null })])
      expect(summarize(views(pending(), many), true, NOW, t).conclusion).toBe('有 3 个范围上次体检没查全')
      expect(summarize(views(pending(), many), true, NOW, createTranslator(en)).conclusion).toBe('3 scopes were not fully checked in the last checkup')
      expect(summarize(views(pending(), withLayers([layer, project('/w/a', { coverage: coverage(1) })])), true, NOW, createTranslator(en)).conclusion)
        .toBe('1 memory not checked in the last checkup')
    })
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
  const onPlatform = (platform: string) => { vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform) }
  afterEach(() => { vi.restoreAllMocks() })

  it.each([
    ['MacIntel', '在访达中显示'],
    ['Win32', '在文件夹中显示'],
    ['Linux x86_64', '在文件夹中显示'],
  ])('按平台写：%s 上是「%s」', (platform, label) => {
    onPlatform(platform)
    setup()
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
  })

  it('有实际路径时可以在访达中显示；宿主拒绝时写一句', async () => {
    onPlatform('MacIntel')
    const gateway = createFakeGateway({ views: { pending: pending(), health: health(NOW), library: library(3, '/home/me/.dsh/memories') }, openOk: false })
    renderInShell(<SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '在访达中显示' })) })
    expect(gateway.opened).toEqual([{ path: '/home/me/.dsh/memories', action: 'reveal' }])
    expect(screen.getByText('没能打开，DeepSeek Harness 拒绝了这个路径。')).toBeInTheDocument()
  })

  it('还不知道路径时没有这个按钮', () => {
    renderInShell(<SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} />, createFakeGateway())
    expect(screen.queryByRole('button', { name: /中显示$/ })).toBeNull()
  })
})

describe('体检用的模型', () => {
  const CHOICES: ModelChoices = [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-pro', name: 'DeepSeek Pro', efforts: [{ id: 'high', name: '高' }] }] },
    { id: 'provider-x', name: 'Provider X', models: [{ id: 'model-x', name: 'Model X', efforts: [] }] },
  ]
  const checkups = (model: ModelSelection | null): CheckupView => ({ version: GUI_VIEW_VERSION, governanceEnabled: true, defaultFrequency: 'manual', allResult: null, model, scopes: [] })

  function setupModel(opts: { model?: ModelSelection | null; checkupsView?: ViewState<CheckupView>; value?: Record<string, unknown>; respond?: (command: MemoryCommand) => MemoryCommandResult | Promise<MemoryCommandResult>; session?: 'none' } = {}) {
    const gateway = createFakeGateway({
      views: { pending: pending(), health: health(NOW), library: library(3), checkups: opts.checkupsView ?? checkups(opts.model ?? null) },
      respond: opts.respond ?? (command => command.cmd === 'list-models' ? { ok: true, cmd: command.cmd, providers: CHOICES } : { ok: true, cmd: command.cmd }),
      ...(opts.session === 'none' ? { session: { kind: 'none' } as const } : {}),
    })
    const form = createFakeConfigForm(opts.value ? { value: opts.value } : {})
    renderInShell(<SettingsPage form={form} onOpenMemoryPage={() => {}} now={NOW} />, gateway)
    return { gateway, form, picker: () => screen.getByRole('combobox', { name: '体检用的模型' }) }
  }
  const sent = (gateway: ReturnType<typeof createFakeGateway>, cmd: MemoryCommand['cmd']) => gateway.executed.filter(e => e.command.cmd === cmd).map(e => e.command)

  it('在「怎么管」里，按提供方分组列出 DeepSeek Harness 里能选的模型，当前跟随默认模型', async () => {
    const { gateway, picker } = setupModel()
    const manage = screen.getAllByRole('heading', { level: 2 }).find(h => h.textContent === '怎么管')!.closest('.pm-group') as HTMLElement
    expect(within(manage).getByRole('combobox', { name: '体检用的模型' })).toBeInTheDocument()
    await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
    expect((picker() as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('跟随默认模型')
    expect(sent(gateway, 'list-models')).toEqual([{ cmd: 'list-models' }])
  })

  it('体检视图里没有所选模型这一项（上一个发布版的进程写的）：按跟随默认模型显示，照常能选', async () => {
    const { model: _model, ...older } = checkups(null)
    const gateway = createFakeGateway({
      views: { pending: pending(), health: health(NOW), library: library(3), checkups: older },
      respond: command => command.cmd === 'list-models' ? { ok: true, cmd: command.cmd, providers: CHOICES } : { ok: true, cmd: command.cmd },
    })
    renderInShell(<SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} />, gateway)
    const picker = screen.getByRole('combobox', { name: '体检用的模型' })
    await waitFor(() => { expect(picker.querySelectorAll('optgroup')).toHaveLength(2) })
    expect((picker as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('跟随默认模型')
    expect(picker).toBeEnabled()
  })

  it('当前值取体检视图里存的选择，带推理强度', async () => {
    setupModel({ model: { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' } })
    await waitFor(() => { expect((screen.getByRole('combobox', { name: '体检用的模型' }) as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('DeepSeek Pro') })
    expect((screen.getByRole('combobox', { name: '推理强度' }) as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('高')
  })

  it('选一个模型立即存（自动体检的键），不进保存行；改回跟随存 null', async () => {
    const { gateway, picker } = setupModel()
    await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
    const modelX = [...picker().querySelectorAll('option')].find(o => o.textContent === 'Model X')!
    await act(async () => { fireEvent.change(picker(), { target: { value: modelX.value } }) })
    expect(sent(gateway, 'set-model-selection')).toEqual([{ cmd: 'set-model-selection', key: 'checkup', selection: { provider: 'provider-x', model: 'model-x' } }])
    expect((picker() as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('Model X')
    expect(screen.queryByText(/项改动未保存/)).toBeNull()
    expect(save()).toBeDisabled()
    await act(async () => { fireEvent.change(picker(), { target: { value: '' } }) })
    expect(sent(gateway, 'set-model-selection').at(-1)).toEqual({ cmd: 'set-model-selection', key: 'checkup', selection: null })
  })

  it('选推理强度：和模型一起存', async () => {
    const { gateway } = setupModel({ model: { provider: 'deepseek-official', model: 'deepseek-pro' } })
    const effort = await screen.findByRole('combobox', { name: '推理强度' })
    await act(async () => { fireEvent.change(effort, { target: { value: 'high' } }) })
    expect(sent(gateway, 'set-model-selection')).toEqual([{ cmd: 'set-model-selection', key: 'checkup', selection: { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' } }])
  })

  it('没存上：退回原来的值并说明', async () => {
    const { picker } = setupModel({
      respond: command => command.cmd === 'list-models' ? { ok: true, cmd: command.cmd, providers: CHOICES } : { ok: false, cmd: command.cmd, code: 'invalid-args' },
    })
    await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
    const modelX = [...picker().querySelectorAll('option')].find(o => o.textContent === 'Model X')!
    await act(async () => { fireEvent.change(picker(), { target: { value: modelX.value } }) })
    expect((picker() as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('跟随默认模型')
    expect(screen.getByText('没存上，再选一次试试。')).toBeInTheDocument()
  })

  it('列模型失败：说明没读到，只剩跟随', async () => {
    const { picker } = setupModel({ respond: command => ({ ok: false, cmd: command.cmd, code: 'failed' }) })
    expect(await screen.findByText('没读到能选的模型，稍后再打开这页试试。')).toBeInTheDocument()
    expect([...picker().querySelectorAll('option')].map(o => o.textContent)).toEqual(['跟随默认模型'])
  })

  it('每个提供方都没读到：说明没读到，不说 DeepSeek Harness 里没有模型；选过的模型不标成现在用不了', async () => {
    const { picker } = setupModel({
      model: { provider: 'provider-x', model: 'model-x' },
      respond: command => command.cmd === 'list-models'
        ? { ok: true, cmd: command.cmd, providers: [{ id: 'deepseek-official', name: 'DeepSeek', models: [], listFailed: true }, { id: 'provider-x', name: 'Provider X', models: [], listFailed: true }] }
        : { ok: true, cmd: command.cmd },
    })
    expect(await screen.findByText('没读到能选的模型，稍后再打开这页试试。')).toBeInTheDocument()
    expect(screen.queryByText(/还没有能选的模型/)).toBeNull()
    expect((picker() as HTMLSelectElement).selectedOptions[0]).toHaveTextContent(/^model-x$/)
  })

  it('部分提供方没读到：照常列出读到的，注明哪个提供方没读到；选过的模型属于没读到的提供方时不标成现在用不了', async () => {
    const { picker } = setupModel({
      model: { provider: 'provider-x', model: 'model-x' },
      respond: command => command.cmd === 'list-models'
        ? { ok: true, cmd: command.cmd, providers: [CHOICES[0]!, { id: 'provider-x', name: 'Provider X', models: [], listFailed: true }] }
        : { ok: true, cmd: command.cmd },
    })
    expect(await screen.findByText('没读到 Provider X 的模型，稍后再打开这页试试。')).toBeInTheDocument()
    expect([...picker().querySelectorAll('optgroup')].map(g => g.label)).toEqual(['DeepSeek'])
    expect((picker() as HTMLSelectElement).selectedOptions[0]).toHaveTextContent(/^model-x$/)
    expect(screen.queryByText('没读到能选的模型，稍后再打开这页试试。')).toBeNull()
  })

  it('没有会话：置灰，说明开一个会话后才能选，不发命令', () => {
    const { gateway, picker } = setupModel({ session: 'none' })
    expect(picker()).toBeDisabled()
    expect(screen.getByText('开一个会话后才能选模型。')).toBeInTheDocument()
    expect(gateway.executed).toEqual([])
  })

  it('配置文件关掉体检：置灰保留，说明换成原因，不列模型', () => {
    const { gateway, picker } = setupModel({ value: section({ governance: { enabled: false, health: { sensitivity: 'normal' }, globalPromoteTarget: 'plugin-global' } }) })
    expect(picker()).toBeDisabled()
    const item = picker().closest('.pm-setting')!
    expect(item).toHaveClass('pm-setting--disabled')
    expect(item.querySelector(':scope > .pm-setting-hint')).toHaveTextContent(/^体检已在配置文件里关闭$/)
    expect(sent(gateway, 'list-models')).toEqual([])
  })

  /** 存选择的命令由测试手动回：每发一次记一个待回的结果，按需要的先后 resolve。 */
  function heldSaves() {
    const held: Array<(result: MemoryCommandResult) => void> = []
    const respond = (command: MemoryCommand): MemoryCommandResult | Promise<MemoryCommandResult> => {
      if (command.cmd === 'list-models') return { ok: true, cmd: command.cmd, providers: CHOICES }
      return new Promise<MemoryCommandResult>((resolve) => { held.push(resolve) })
    }
    /** 回第 i 次（从 0 数）存选择的结果。 */
    const answer = async (i: number, ok: boolean) => {
      await act(async () => { held[i]!(ok ? { ok: true, cmd: 'set-model-selection' } : { ok: false, cmd: 'set-model-selection', code: 'failed' }) })
    }
    return { respond, answer, count: () => held.length }
  }
  const optionOf = (picker: HTMLElement, name: string) => [...picker.querySelectorAll('option')].find(o => o.textContent === name)!
  const selected = (combobox: HTMLElement) => (combobox as HTMLSelectElement).selectedOptions[0]
  const effortPicker = () => screen.getByRole('combobox', { name: '推理强度' })

  describe('连续选：保存一次只发一个', () => {
    it('选模型后紧接着选推理强度：第二次排在第一次存好之后才发；第一次存好、视图换成第一次的值时推理强度不跳回', async () => {
      const saves = heldSaves()
      const { gateway, picker } = setupModel({ respond: saves.respond })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'DeepSeek Pro').value } }) })
      await act(async () => { fireEvent.change(effortPicker(), { target: { value: 'high' } }) })
      // 第一次还没回：第二次不发，界面先显示选的
      expect(sent(gateway, 'set-model-selection')).toEqual([{ cmd: 'set-model-selection', key: 'checkup', selection: { provider: 'deepseek-official', model: 'deepseek-pro' } }])
      expect(selected(effortPicker())).toHaveTextContent('高')
      await saves.answer(0, true)
      act(() => { gateway.setView('checkups', checkups({ provider: 'deepseek-official', model: 'deepseek-pro' })) })
      expect(selected(effortPicker())).toHaveTextContent('高')
      expect(sent(gateway, 'set-model-selection').at(-1)).toEqual({ cmd: 'set-model-selection', key: 'checkup', selection: { provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' } })
      await saves.answer(1, true)
      act(() => { gateway.setView('checkups', checkups({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })) })
      expect(selected(effortPicker())).toHaveTextContent('高')
      expect(saves.count()).toBe(2)
    })

    it('在途时连选几次：只补发最后一次，中间的不发', async () => {
      const saves = heldSaves()
      const { gateway, picker } = setupModel({ respond: saves.respond })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'Model X').value } }) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'DeepSeek Pro').value } }) })
      await act(async () => { fireEvent.change(picker(), { target: { value: '' } }) })
      expect(selected(picker())).toHaveTextContent('跟随默认模型')
      await saves.answer(0, true)
      expect(sent(gateway, 'set-model-selection').map(c => c.cmd === 'set-model-selection' ? c.selection : undefined)).toEqual([{ provider: 'provider-x', model: 'model-x' }, null])
      await saves.answer(1, true)
      expect(selected(picker())).toHaveTextContent('跟随默认模型')
    })

    it('旧的一次没存上、后面还有排着的：不回滚新的选择，不提示没存上', async () => {
      const saves = heldSaves()
      const { picker } = setupModel({ respond: saves.respond })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'Model X').value } }) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'DeepSeek Pro').value } }) })
      await saves.answer(0, false)
      expect(selected(picker())).toHaveTextContent('DeepSeek Pro')
      expect(screen.queryByText('没存上，再选一次试试。')).toBeNull()
      await saves.answer(1, true)
      expect(selected(picker())).toHaveTextContent('DeepSeek Pro')
      expect(screen.queryByText('没存上，再选一次试试。')).toBeNull()
    })

    it('最后一次没存上：退回视图里的值并提示；再选一次开始保存时提示清掉', async () => {
      const saves = heldSaves()
      const { picker } = setupModel({ respond: saves.respond })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'Model X').value } }) })
      await saves.answer(0, false)
      expect(selected(picker())).toHaveTextContent('跟随默认模型')
      expect(screen.getByText('没存上，再选一次试试。')).toBeInTheDocument()
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'Model X').value } }) })
      expect(screen.queryByText('没存上，再选一次试试。')).toBeNull()
      expect(selected(picker())).toHaveTextContent('Model X')
    })

    it('保存还在途时别的窗口改了视图：先不让位，仍显示刚选的', async () => {
      const saves = heldSaves()
      const { gateway, picker } = setupModel({ respond: saves.respond })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'Model X').value } }) })
      act(() => { gateway.setView('checkups', checkups({ provider: 'deepseek-official', model: 'deepseek-pro' })) })
      expect(selected(picker())).toHaveTextContent('Model X')
    })

    it('存好了但视图没跟上：先显示选的；视图之后再变一次（别的窗口改回去了）就以视图为准', async () => {
      const saves = heldSaves()
      const { gateway, picker } = setupModel({ respond: saves.respond })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'Model X').value } }) })
      await saves.answer(0, true)
      expect(selected(picker())).toHaveTextContent('Model X')
      // 重读到的视图内容和之前一样（别的窗口把选择改回了跟随）：不卡在刚选的值上
      act(() => { gateway.setView('checkups', checkups(null)) })
      expect(selected(picker())).toHaveTextContent('跟随默认模型')
    })
  })

  describe('体检视图没读到、会话没了', () => {
    it.each([
      ['还在读', { status: 'loading' } as const],
      ['读出错', { status: 'error', message: 'boom' } as const],
      ['还没生成', { status: 'missing' } as const],
    ])('体检视图%s：选择器置灰，不当成「跟随默认模型」让人选', async (_label, view) => {
      const { picker } = setupModel({ checkupsView: view })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      expect(picker()).toBeDisabled()
    })

    it('体检视图读到后恢复可选，显示存的选择', async () => {
      const { gateway, picker } = setupModel({ checkupsView: { status: 'loading' } })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      act(() => { gateway.setView('checkups', checkups({ provider: 'provider-x', model: 'model-x' })) })
      expect(picker()).toBeEnabled()
      expect(selected(picker())).toHaveTextContent('Model X')
    })

    it('会话没了：列表没读到的提示收起，已读的模型清掉', async () => {
      const { gateway, picker } = setupModel({
        respond: command => command.cmd === 'list-models'
          ? { ok: true, cmd: command.cmd, providers: [CHOICES[0]!, { id: 'provider-x', name: 'Provider X', models: [], listFailed: true }] }
          : { ok: true, cmd: command.cmd },
      })
      expect(await screen.findByText('没读到 Provider X 的模型，稍后再打开这页试试。')).toBeInTheDocument()
      act(() => { gateway.setSession({ kind: 'none' }) })
      expect(screen.queryByText(/没读到/)).toBeNull()
      expect(picker().querySelectorAll('optgroup')).toHaveLength(0)
      expect(screen.getByText('开一个会话后才能选模型。')).toBeInTheDocument()
    })

    it('列模型失败后会话没了：不再提示没读到', async () => {
      const { gateway } = setupModel({ respond: command => ({ ok: false, cmd: command.cmd, code: 'failed' }) })
      expect(await screen.findByText('没读到能选的模型，稍后再打开这页试试。')).toBeInTheDocument()
      act(() => { gateway.setSession({ kind: 'none' }) })
      expect(screen.queryByText(/没读到/)).toBeNull()
    })

    it('没存上之后会话没了、或配置文件关掉体检：不再提示没存上', async () => {
      const { gateway, form, picker } = setupModel({
        respond: command => command.cmd === 'list-models' ? { ok: true, cmd: command.cmd, providers: CHOICES } : { ok: false, cmd: command.cmd, code: 'failed' },
      })
      await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
      await act(async () => { fireEvent.change(picker(), { target: { value: optionOf(picker(), 'Model X').value } }) })
      expect(screen.getByText('没存上，再选一次试试。')).toBeInTheDocument()
      act(() => { form.externalChange([{ op: 'set', path: ['governance', 'enabled'], value: false }]) })
      expect(screen.queryByText('没存上，再选一次试试。')).toBeNull()
      act(() => { form.externalChange([{ op: 'set', path: ['governance', 'enabled'], value: true }]) })
      expect(screen.getByText('没存上，再选一次试试。')).toBeInTheDocument()
      act(() => { gateway.setSession({ kind: 'none' }) })
      expect(screen.queryByText('没存上，再选一次试试。')).toBeNull()
    })
  })

  it('英文文案同一口径', () => {
    const enT = createTranslator(en)
    expect(enT('settings.checkupModel.label')).toBe('Model for checkups')
    expect(enT('settings.checkupModel.follow')).toBe('Follow the default model')
    expect(enT('settings.checkupModel.listPartial', { providers: 'Provider X' })).toBe("Couldn't load the models from Provider X. Reopen this page to try again.")
  })
})

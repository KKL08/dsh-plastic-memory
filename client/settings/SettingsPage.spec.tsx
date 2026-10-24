// 插件设置页：三组设置的渲染、「我加的类型」弹层必填校验、revision 冻结与冲突提示、非法值、体检关闭时置灰、状态卡。
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type LibraryView, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { zh } from '../locales.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { createFakeConfigForm, DEFAULT_SECTION, type FakeConfigForm } from './config-form.fake.ts'
import { SettingsPage } from './SettingsPage.tsx'
import { summarize } from './StatusCard.tsx'

const t = createTranslator(zh)

const library = (count: number, memoryRoot = '/Users/me/.dsh/memories'): LibraryView => ({
  version: GUI_VIEW_VERSION, memoryRoot, directoryIssues: [],
  layers: [{ layer: { kind: 'global' }, items: Array.from({ length: count }, (_, i) => memory({ id: `m${i}` })) }],
})
const health = (semanticCachedAt: number | null): HealthView => ({
  version: GUI_VIEW_VERSION,
  governanceEnabled: true,
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 90, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0, semanticCachedAt, overflow: null }],
})
const pending = (items: PendingView['items'] = []): PendingView => ({ version: GUI_VIEW_VERSION, dot: 'none', items, typeLabels: {} })

function setup(opts: { value?: Record<string, unknown>; views?: boolean; writable?: boolean } = {}) {
  const form = createFakeConfigForm({ ...(opts.value ? { value: opts.value } : {}), ...(opts.writable === false ? { writable: false } : {}) })
  const gateway = createFakeGateway(opts.views === false ? {} : { views: { pending: pending(), health: health(NOW), library: library(3) } })
  const onOpen = vi.fn()
  const view = renderInShell(<SettingsPage form={form} onOpenMemoryPage={onOpen} now={NOW} />, gateway)
  return { form, onOpen, ...view }
}

const section = (patch: Record<string, unknown>) => ({ ...structuredClone(DEFAULT_SECTION), ...patch })
const tab = (group: string, name: string) => within(screen.getByRole('tablist', { name: group })).getByRole('tab', { name })
const save = () => screen.getByRole('button', { name: '保存' })

async function clickSave(form: FakeConfigForm) {
  const before = form.calls.length
  await act(async () => { fireEvent.click(save()) })
  await waitFor(() => { expect(form.calls.length).toBe(before + 1) })
}

describe('三组设置的渲染', () => {
  it('记什么：模板三档、我加的类型列表', () => {
    setup({ value: section({ template: 'office', customTypes: { 'meeting-note': { label: '会议纪要', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' } } }) })
    expect(screen.getByRole('heading', { name: '记什么' })).toBeInTheDocument()
    expect(tab('场景模板', '办公')).toHaveAttribute('aria-selected', 'true')
    expect(tab('场景模板', '编码')).toHaveAttribute('aria-selected', 'false')
    expect(tab('场景模板', '仅通用')).toBeInTheDocument()
    expect(screen.getByText('会议纪要')).toBeInTheDocument()
    expect(screen.getByText('meeting-note')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑 会议纪要' })).toBeInTheDocument()
  })

  it('怎么用：上限数字、超出上限两种模式的说明、溯源三档', () => {
    setup({ value: section({ snapshotTokenBudget: 6000, snapshotOverflow: 'strict', evidenceLookup: 'active' }) })
    expect(screen.getByLabelText('每次对话带入的记忆上限')).toHaveValue('6000')
    expect(screen.getByText('默认 4,000。')).toBeInTheDocument()
    expect(tab('超出上限时', '严格按上限')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/自动放宽：超出的照常带入/)).toBeInTheDocument()
    expect(screen.getByText(/严格按上限：超出的不带入/)).toBeInTheDocument()
    expect(tab('溯源记忆出处', '主动积极')).toHaveAttribute('aria-selected', 'true')
    expect(tab('溯源记忆出处', '仅你要求时')).toBeInTheDocument()
    expect(tab('溯源记忆出处', '遇到矛盾或高风险时')).toBeInTheDocument()
  })

  it('怎么管：体检开关、自动体检禁用带「规划中」、灵敏度说明带数值、AGENTS.md 说明插件不再管理、最近删除入口、memoryRoot 只读', () => {
    const { onOpen } = setup({ value: section({ governance: { enabled: true, health: { sensitivity: 'conservative' }, globalPromoteTarget: 'agents-md' } }) })
    expect(screen.getByRole('switch', { name: '记忆体检' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('规划中')).toBeInTheDocument()
    for (const name of ['关闭', '每天', '每 7 天']) expect(tab('自动体检', name)).toBeDisabled()
    expect(screen.getByText('健康分低于 60 分、或冲突等了 14 天以上时提醒你。')).toBeInTheDocument()
    fireEvent.click(tab('提醒的灵敏度', '积极'))
    expect(screen.getByText('健康分低于 80 分、或冲突等了 3 天以上时提醒你。')).toBeInTheDocument()
    expect(screen.getByText(/插件不再管理这些内容/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看最近删除 ›' }))
    expect(onOpen).toHaveBeenCalledWith('deleted')
    expect(screen.getByText('/Users/me/.dsh/memories')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '记忆文件位置' })).toBeNull()
  })

  it('还没读到视图时 memoryRoot 显示配置值，都没有就提示开会话', () => {
    const { unmount } = setup({ views: false, value: section({ memoryRoot: '/data/mem' }) })
    expect(screen.getByText('/data/mem')).toBeInTheDocument()
    unmount()
    setup({ views: false })
    expect(screen.getByText('开一个会话后显示实际路径。')).toBeInTheDocument()
  })

  it('模板切换后提示后果', () => {
    setup()
    expect(screen.queryByText(/旧模板独有类型的记忆仍会带入/)).toBeNull()
    fireEvent.click(tab('场景模板', '仅通用'))
    expect(screen.getByText('切换后，旧模板独有类型的记忆仍会带入、能搜到，agent 不再新增这类记忆。')).toBeInTheDocument()
  })

  it('配置还在加载时只显示一行；宿主不服务这份配置时只显示提示', () => {
    const form = createFakeConfigForm({ status: 'loading' })
    const { unmount } = renderInShell(<SettingsPage form={form} onOpenMemoryPage={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在读取配置…')
    unmount()
    renderInShell(<SettingsPage form={createFakeConfigForm({ status: 'unavailable' })} onOpenMemoryPage={() => {}} />)
    expect(screen.getByText('宿主暂时没有提供这份配置。')).toBeInTheDocument()
  })
})

describe('我加的类型：增删改弹层', () => {
  const openAdd = () => { fireEvent.click(screen.getByRole('button', { name: '添加类型' })) }
  const dialog = () => screen.getByRole('dialog', { name: '添加类型' })
  const fill = (label: string, value: string) => { fireEvent.change(within(dialog()).getByLabelText(label), { target: { value } }) }

  it('必填项没填不能确定，逐项就地提示', () => {
    setup()
    openAdd()
    fireEvent.click(within(dialog()).getByRole('button', { name: '确定' }))
    expect(dialog()).toBeInTheDocument()
    expect(within(dialog()).getAllByText('必填。')).toHaveLength(6)
    expect(within(dialog()).getByLabelText('中文名')).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog()).getByLabelText('过期天数')).not.toHaveAttribute('aria-invalid')
  })

  it('英文名格式、内置重名、过期天数非法各有提示', () => {
    setup()
    openAdd()
    fill('英文名', 'Meeting Note')
    fill('过期天数', '0')
    fireEvent.click(within(dialog()).getByRole('button', { name: '确定' }))
    expect(within(dialog()).getByText('只能用小写英文字母和连字符，例如 meeting-note。')).toBeInTheDocument()
    expect(within(dialog()).getByText('填一个大于 0 的整数，或者留空。')).toBeInTheDocument()
    fill('英文名', 'preference')
    expect(within(dialog()).getByText('和内置类型重名了，换一个。')).toBeInTheDocument()
  })

  it('填齐后进列表；保存一次提交，过期天数留空写 null', async () => {
    const { form } = setup()
    openAdd()
    fill('中文名', '会议纪要')
    fill('英文名', 'meeting-note')
    fill('说明', '会上定下的事')
    fill('什么时候记', '开完会')
    fireEvent.click(within(dialog()).getByRole('tab', { name: '搜索' }))
    fireEvent.click(within(dialog()).getByRole('tab', { name: '高' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: '确定' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('会议纪要')).toBeInTheDocument()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{
      op: 'set', path: ['customTypes', 'meeting-note'],
      value: { label: '会议纪要', description: '会上定下的事', whenToSave: '开完会', recall: 'search', decayDays: null, governancePriority: 'high' },
    }])
  })

  it('编辑时英文名只读、可改其他字段；删除写 unset', async () => {
    const type = { label: '会议纪要', description: 'd', whenToSave: 'w', recall: 'search', decayDays: 30, governancePriority: 'medium' }
    const { form } = setup({ value: section({ customTypes: { 'meeting-note': type, 'todo': { ...type, label: '待办' } } }) })
    fireEvent.click(screen.getByRole('button', { name: '编辑 会议纪要' }))
    const edit = screen.getByRole('dialog', { name: '编辑类型' })
    expect(within(edit).getByLabelText('英文名')).toHaveAttribute('readonly')
    expect(within(edit).getByLabelText('过期天数')).toHaveValue('30')
    fireEvent.change(within(edit).getByLabelText('过期天数'), { target: { value: '' } })
    fireEvent.click(within(edit).getByRole('button', { name: '确定' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 待办' }))
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([
      { op: 'set', path: ['customTypes', 'meeting-note'], value: { ...type, decayDays: null } },
      { op: 'unset', path: ['customTypes', 'todo'] },
    ])
  })

  it('取消不改草稿', () => {
    setup()
    openAdd()
    fill('中文名', '会议纪要')
    fireEvent.click(within(dialog()).getByRole('button', { name: '取消' }))
    expect(screen.queryByText('会议纪要')).toBeNull()
    expect(save()).toBeDisabled()
  })
})

describe('保存：revision 冻结、冲突、非法值', () => {
  it('没有改动时保存置灰；多项改动一次 mutate，带开始编辑时的 revision；保存后回到干净状态', async () => {
    const { form } = setup()
    expect(save()).toBeDisabled()
    fireEvent.click(tab('超出上限时', '严格按上限'))
    fireEvent.change(screen.getByLabelText('每次对话带入的记忆上限'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('switch', { name: '记忆体检' }))
    expect(screen.getByText('已有对话的下一条消息会重新载入记忆，多消耗一些 token。')).toBeInTheDocument()
    await clickSave(form)
    expect(form.calls).toEqual([{
      expectedRevision: 1,
      ops: [
        { op: 'set', path: ['snapshotTokenBudget'], value: 5000 },
        { op: 'set', path: ['snapshotOverflow'], value: 'strict' },
        { op: 'set', path: ['governance', 'enabled'], value: false },
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
    expect(tab('场景模板', '办公')).toHaveAttribute('aria-selected', 'true')
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
    const input = screen.getByLabelText('每次对话带入的记忆上限')
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
    fireEvent.click(tab('场景模板', '办公'))
    form.rejectNext()
    await clickSave(form)
    expect(await screen.findByText('没有保存成功，再试一次。')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(tab('场景模板', '办公')).toHaveAttribute('aria-selected', 'true')
    await clickSave(form)
    await waitFor(() => { expect(form.value.template).toBe('office') })
  })

  it('配置只读时控件禁用', () => {
    setup({ writable: false })
    expect(screen.getByText('当前配置是只读的，改不了。')).toBeInTheDocument()
    expect(tab('场景模板', '办公')).toBeDisabled()
    expect(screen.getByRole('switch', { name: '记忆体检' })).toBeDisabled()
  })
})

describe('体检关闭时置灰', () => {
  it('自动体检、灵敏度、跨项目去向置灰保留；打开后后两项可用', () => {
    setup({ value: section({ governance: { enabled: false, health: { sensitivity: 'normal' }, globalPromoteTarget: 'plugin-global' } }) })
    const disabledGroups = ['自动体检', '提醒的灵敏度', '跨项目的记忆放到']
    for (const group of disabledGroups) {
      const list = screen.getByRole('tablist', { name: group })
      for (const button of within(list).getAllByRole('tab')) expect(button).toBeDisabled()
      expect(list.closest('.pm-setting')).toHaveClass('pm-setting--disabled')
    }
    expect(screen.getByText('健康分低于 70 分、或冲突等了 7 天以上时提醒你。')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: '记忆体检' }))
    expect(tab('提醒的灵敏度', '积极')).toBeEnabled()
    expect(tab('跨项目的记忆放到', 'AGENTS.md')).toBeEnabled()
    expect(tab('自动体检', '每天')).toBeDisabled()
  })
})

describe('状态卡', () => {
  const views = (p = pending(), h = health(NOW), l = library(3)) => ({ pending: p, health: h, library: l })

  it('结论按优先级：体检关闭 → 密钥 → 等你决定 → 没有记忆 → 没体检 → 良好', () => {
    const conflict = { kind: 'conflict-horizontal' as const, decisionId: 'd', firstSeenAt: NOW, summary: 's', left: null, right: null }
    const unreadable = { kind: 'unreadable-file' as const, layer: { kind: 'global' as const }, filePath: '/f', relativePath: 'f', error: 'e' }
    expect(summarize(views(), false, NOW, t)).toEqual({ conclusion: '体检已关闭', detail: '共 3 条记忆' })
    expect(summarize(views(pending([{ kind: 'secret', memory: memory() }, conflict])), true, NOW, t).marker).toBe('secret')
    expect(summarize(views(pending([conflict, conflict, unreadable])), true, NOW, t))
      .toEqual({ marker: 'pending', conclusion: '有 2 处等你决定', detail: '共 3 条记忆 · 上次体检：刚刚' })
    expect(summarize(views(pending(), health(null), library(0)), true, NOW, t)).toEqual({ conclusion: '还没有记忆' })
    expect(summarize(views(pending(), health(null)), true, NOW, t)).toEqual({ conclusion: '有记忆，还没体检过', detail: '共 3 条记忆 · 还没体检过' })
    expect(summarize(views(pending(), health(new Date(2026, 9, 3).getTime())), true, NOW, t))
      .toEqual({ marker: 'ok', conclusion: '状态良好', detail: '共 3 条记忆 · 上次体检：10 月 3 日' })
  })

  it('读视图渲染结论，「打开记忆页 ›」直达待处理；没有会话时只写一句提示', () => {
    const { onOpen, gateway } = setup()
    expect(screen.getByText('状态良好')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(onOpen).toHaveBeenCalledWith('pending')
    act(() => { gateway.setSession({ kind: 'none' }) })
    expect(screen.getByText('开一个会话后这里显示记忆状态')).toBeInTheDocument()
  })
})

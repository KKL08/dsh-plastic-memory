// 设置页的分页和检索、对话记录库、模型选择读不出：页内顶部标签、每页的小节、新加的几项设置的读写和说明。
import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type CheckupView, type HealthView, type LibraryView, type MemoryCommand, type MemoryCommandResult, type ModelChoices, type PendingView, type SelectionRead } from '../../src/gui/contract.ts'
import { createFakeGateway, type FakeGateway } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en, zh } from '../locales.ts'
import { memory, NOW, levelCountsOf, renderInShell } from '../test-utils.tsx'
import { PanelShell } from '../ui/PanelShell.tsx'
import { createFakeConfigForm, DEFAULT_SECTION, type FakeConfigForm } from './config-form.fake.ts'
import { SettingsPage } from './SettingsPage.tsx'

const CHOICES: ModelChoices = [
  { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-pro', name: 'DeepSeek Pro', efforts: [] }] },
  { id: 'provider-x', name: 'Provider X', models: [{ id: 'model-x', name: 'Model X', efforts: [] }] },
]
const library = (): LibraryView => ({
  version: GUI_VIEW_VERSION, memoryRoot: '/home/me/.dsh/memories', directoryIssues: [],
  layers: [{ layer: { kind: 'global' }, items: [memory({ id: 'm1' })] }],
})
const health = (): HealthView => ({
  version: GUI_VIEW_VERSION, governanceEnabled: true,
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 90, tier: 'green', gate: { secret: false }, issues: [], lastCheckupAt: NOW, ignored: [], deductions: { rule: { points: 0, types: [] }, content: { points: 0, types: [] }, freshness: { points: 0, types: [] } } }],
})
const pending = (): PendingView => ({ version: GUI_VIEW_VERSION, dot: 'none', items: [], levelCounts: levelCountsOf([]), typeLabels: {} })
const checkups = (selections?: { checkup: SelectionRead; expansion: SelectionRead }, model: CheckupView['model'] = null): CheckupView => ({
  version: GUI_VIEW_VERSION, governanceEnabled: true, defaultFrequency: 'manual', allResult: null, model, scopes: [], ...(selections !== undefined ? { selections } : {}),
})

type Records = Extract<MemoryCommandResult, { ok: true }>['dialogueRecords']

function setup(opts: {
  value?: Record<string, unknown>
  view?: CheckupView
  /** dialogue-records-state 依次回的状态；用完了重复最后一个。'failed' = 读不出。 */
  records?: Array<Records | 'failed'>
  respond?: (command: MemoryCommand) => MemoryCommandResult | Promise<MemoryCommandResult> | undefined
  session?: 'none'
} = {}) {
  const records = [...(opts.records ?? [{ status: 'ready' }])]
  const gateway = createFakeGateway({
    views: { pending: pending(), health: health(), library: library(), checkups: opts.view ?? checkups({ checkup: null, expansion: null }) },
    respond: (command) => {
      const custom = opts.respond?.(command)
      if (custom !== undefined) return custom
      if (command.cmd === 'list-models') return { ok: true, cmd: command.cmd, providers: CHOICES }
      if (command.cmd === 'dialogue-records-state') {
        const next = records.length > 1 ? records.shift()! : records[0]!
        return next === 'failed' ? { ok: false, cmd: command.cmd, code: 'failed' } : { ok: true, cmd: command.cmd, dialogueRecords: next }
      }
      return { ok: true, cmd: command.cmd }
    },
    ...(opts.session === 'none' ? { session: { kind: 'none' } as const } : {}),
  })
  const form = createFakeConfigForm({ value: opts.value ?? structuredClone(DEFAULT_SECTION) })
  const view = renderInShell(<SettingsPage form={form} onOpenMemoryPage={() => {}} now={NOW} />, gateway)
  return { form, ...view }
}

const section = (patch: Record<string, unknown>) => ({ ...structuredClone(DEFAULT_SECTION), ...patch })
const pageTab = (name: RegExp | string) => within(screen.getByRole('tablist', { name: '设置分页' })).getByRole('tab', { name })
const open = (name: string) => { fireEvent.click(pageTab(new RegExp(`^${name}`))) }
const panel = () => screen.getByRole('tabpanel')
const seg = (group: string, name: string) => within(screen.getByRole('tablist', { name: group })).getByRole('tab', { name })
const sw = (name: string) => screen.getByRole('switch', { name })
const save = () => screen.getByRole('button', { name: '保存' })
const sent = (gateway: FakeGateway, cmd: MemoryCommand['cmd']) => gateway.executed.filter(e => e.command.cmd === cmd).map(e => e.command)
const confirmLines = () => within(screen.getByRole('dialog', { name: '保存这些改动？' })).getAllByRole('listitem').map(el => el.textContent)

async function clickSave(form: FakeConfigForm) {
  const before = form.calls.length
  fireEvent.click(save())
  await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: '保存这些改动？' })).getByRole('button', { name: '保存' })) })
  await waitFor(() => { expect(form.calls.length).toBe(before + 1) })
}

describe('页内顶部标签', () => {
  it('四个标签：记什么、怎么用、怎么管、外观；打开时停在「记什么」，只显示它那一页', () => {
    setup()
    const tabs = within(screen.getByRole('tablist', { name: '设置分页' })).getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['记什么', '怎么用', '怎么管', '外观'])
    expect(pageTab('记什么')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(within(panel()).getByRole('radiogroup', { name: '场景' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '检索结果附带原话' })).toBeNull()
  })

  it('点标签换页，选中的滑块平移到那一格', () => {
    const { container } = setup()
    const indicator = container.querySelector('.pm-settings-tabs .pm-tabs-indicator') as HTMLElement
    expect(indicator.style.transform).toBe('translateX(0%)')
    open('怎么管')
    expect(pageTab('怎么管')).toHaveAttribute('aria-selected', 'true')
    expect(indicator.style.transform).toBe('translateX(200%)')
    expect(within(panel()).getByRole('heading', { name: '体检' })).toBeInTheDocument()
  })

  it('键盘：方向键切到相邻的标签，焦点跟过去；Home、End 到两头', () => {
    setup()
    pageTab('记什么').focus()
    fireEvent.keyDown(pageTab('记什么'), { key: 'ArrowRight' })
    expect(pageTab('怎么用')).toHaveAttribute('aria-selected', 'true')
    expect(pageTab('怎么用')).toHaveFocus()
    fireEvent.keyDown(pageTab('怎么用'), { key: 'End' })
    expect(pageTab('外观')).toHaveFocus()
    fireEvent.keyDown(pageTab('外观'), { key: 'ArrowRight' })
    expect(pageTab('记什么')).toHaveAttribute('aria-selected', 'true')
  })

  it('切标签不丢草稿：别的页上改了的值还在，保存一次写进几页的改动', async () => {
    const { form } = setup()
    open('怎么用')
    fireEvent.change(screen.getByLabelText('带入上限（token）'), { target: { value: '5000' } })
    open('外观')
    fireEvent.click(seg('主题色', '大肥鱼主题色'))
    open('记什么')
    open('怎么用')
    expect(screen.getByLabelText('带入上限（token）')).toHaveValue('5000')
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([
      { op: 'set', path: ['snapshotTokenBudget'], value: 5000 },
      { op: 'set', path: ['accent'], value: 'blue-whale' },
    ])
  })

  it('有未保存修改的页，标签上带一个小圆点；保存行写几项、在哪几页；保存后圆点消失', async () => {
    const { form } = setup()
    open('怎么管')
    fireEvent.click(seg('提醒的灵敏度', '积极'))
    open('外观')
    fireEvent.click(seg('主题色', '大肥鱼主题色'))
    open('怎么用')
    expect(pageTab(/^怎么管/)).toHaveAccessibleName('怎么管，有未保存的修改')
    expect(pageTab(/^外观/)).toHaveAccessibleName('外观，有未保存的修改')
    expect(pageTab('怎么用')).toHaveAccessibleName('怎么用')
    expect(pageTab('记什么')).toHaveAccessibleName('记什么')
    expect(screen.getByText('2 项改动未保存（怎么管、外观）')).toBeInTheDocument()
    await clickSave(form)
    expect(pageTab('怎么管')).toHaveAccessibleName('怎么管')
    expect(screen.queryByText(/项改动未保存/)).toBeNull()
  })

  it('保存按钮在每一页都是同一个，始终在页面上', () => {
    setup()
    for (const name of ['记什么', '怎么用', '怎么管', '外观']) {
      open(name)
      expect(screen.getAllByRole('button', { name: '保存' })).toHaveLength(1)
    }
  })
})

describe('「怎么用」：带入、检索、核对', () => {
  it('三个小节，标题和一句说明在卡外；不出现「出处」「溯源」「高级设置」「检索输出长度」和工具结果开关', () => {
    setup()
    open('怎么用')
    const sections = within(panel()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(sections).toEqual(['带入', '检索', '核对'])
    expect(within(panel()).getByText('对话开始时自动给 agent，每次对话花一笔固定的。').closest('.pm-group-card')).toBeNull()
    const names = [...panel().querySelectorAll('.pm-sec-title, .pm-setting-label')].map(el => el.textContent).join('|')
    expect(names).not.toMatch(/出处|溯源|高级设置|检索输出长度/)
    expect(screen.queryByRole('switch', { name: /工具结果/ })).toBeNull()
  })

  it('检索小节的顺序：检索来源、附带原话、其他原话、扩查、扩查用的模型（缩进的子项）；卡下脚注讲对话记录库', () => {
    setup()
    open('怎么用')
    const search = within(panel()).getByRole('heading', { name: '检索' }).closest('section')!
    const labels = [...search.querySelectorAll('.pm-setting-label')].map(el => el.textContent)
    expect(labels).toEqual(['检索来源', '检索结果附带原话', '每次检索带的其他原话', '扩查', '扩查用的模型'])
    expect(search.querySelectorAll('.pm-setting--sub .pm-setting-label')[0]).toHaveTextContent('扩查用的模型')
    expect(within(search).getByText(/查原话、附带原话都要用到对话记录库：本机多存的一份对话文本，首次使用时在后台建。/)).toBeInTheDocument()
  })

  it('旧配置文件（没有 search 段）打开不报错：检索来源两者都查、附带原话开、5 段、扩查开、扩查用的模型跟随对话的模型', async () => {
    setup()
    open('怎么用')
    expect(seg('检索来源', '两者都查')).toHaveAttribute('aria-selected', 'true')
    expect(sw('检索结果附带原话')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('group', { name: '每次检索带的其他原话' })).toHaveTextContent('5 段（约 1,500 token）')
    expect(sw('扩查')).toHaveAttribute('aria-checked', 'true')
    const picker = screen.getByRole('combobox', { name: '扩查用的模型' }) as HTMLSelectElement
    expect(picker.selectedOptions[0]).toHaveTextContent('跟随对话的模型')
  })

  it('读配置里写的值', () => {
    setup({ value: section({ search: { source: 'dialogue', memoryQuotes: false, dialogueTokenBudget: 2400, queryExpansion: false } }) })
    open('怎么用')
    expect(seg('检索来源', '只查原话')).toHaveAttribute('aria-selected', 'true')
    expect(sw('检索结果附带原话')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('group', { name: '每次检索带的其他原话' })).toHaveTextContent('8 段（约 2,400 token）')
    expect(sw('扩查')).toHaveAttribute('aria-checked', 'false')
  })

  it('检索来源、附带原话、扩查改了进草稿，保存写各自的配置键；确认框用新的项名', async () => {
    const { form } = setup()
    open('怎么用')
    fireEvent.click(seg('检索来源', '只查原话'))
    fireEvent.click(sw('检索结果附带原话'))
    fireEvent.click(sw('扩查'))
    expect(sw('检索结果附带原话')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(save())
    expect(confirmLines()).toEqual(['检索来源：两者都查 → 只查原话', '检索结果附带原话：开 → 关', '扩查：开 → 关'])
    // 检索来源、附带原话会让开着的对话重新带入记忆
    expect(screen.getByText(/重新带入记忆/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: '保存这些改动？' })).getByRole('button', { name: '保存' })) })
    expect(form.value.search).toMatchObject({ source: 'dialogue', memoryQuotes: false, queryExpansion: false })
  })

  it('「附带原话」只是一个开关，没有分档', () => {
    setup()
    open('怎么用')
    const item = sw('检索结果附带原话').closest('.pm-setting')!
    expect(within(item as HTMLElement).queryByRole('tablist')).toBeNull()
  })

  it('其他原话：每点一次变一段（300 token），到 10 段加号不可点、到 2 段减号不可点；存进配置的值和显示一致', async () => {
    const { form } = setup()
    open('怎么用')
    const group = () => screen.getByRole('group', { name: '每次检索带的其他原话' })
    const more = () => within(group()).getByRole('button', { name: '多一段' })
    const less = () => within(group()).getByRole('button', { name: '少一段' })
    fireEvent.click(more())
    expect(group()).toHaveTextContent('6 段（约 1,800 token）')
    for (let i = 0; i < 4; i += 1) fireEvent.click(more())
    expect(group()).toHaveTextContent('10 段（约 3,000 token）')
    expect(more()).toBeDisabled()
    for (let i = 0; i < 8; i += 1) fireEvent.click(less())
    expect(group()).toHaveTextContent('2 段（约 600 token）')
    expect(less()).toBeDisabled()
    fireEvent.click(more())
    fireEvent.click(save())
    expect(confirmLines()).toEqual(['每次检索带的其他原话：5 段（约 1,500 token） → 3 段（约 900 token）'])
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog', { name: '保存这些改动？' })).getByRole('button', { name: '保存' })) })
    await waitFor(() => { expect(form.calls).toHaveLength(1) })
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['search', 'dialogueTokenBudget'], value: 900 }])
  })

  it('检索来源是「只查记忆」：其他原话、扩查、扩查用的模型置灰，说明换成原因', () => {
    setup({ value: section({ search: { source: 'memory' } }) })
    open('怎么用')
    expect(within(screen.getByRole('group', { name: '每次检索带的其他原话' })).getByRole('button', { name: '多一段' })).toBeDisabled()
    expect(sw('扩查')).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '扩查用的模型' })).toBeDisabled()
    expect(screen.getAllByText('检索来源是「只查记忆」时用不上。')).toHaveLength(3)
  })

  it('扩查关着：扩查用的模型置灰，说明「扩查关着时用不上。」', () => {
    setup({ value: section({ search: { queryExpansion: false } }) })
    open('怎么用')
    expect(screen.getByRole('combobox', { name: '扩查用的模型' })).toBeDisabled()
    expect(screen.getByText('扩查关着时用不上。')).toBeInTheDocument()
  })

  it('核对的说明跟着「附带原话」换', () => {
    setup()
    open('怎么用')
    expect(screen.getByText(/^附带的原话不够时（要更前后的上下文、要工具输出，或这条没附原话）/)).toBeInTheDocument()
    fireEvent.click(sw('检索结果附带原话'))
    expect(screen.getByText('agent 回到这条记忆产生的那次对话，核对当时的原话、原因和约束。')).toBeInTheDocument()
    expect(seg('什么时候回去核对', '遇到矛盾或高风险时')).toHaveAttribute('aria-selected', 'true')
  })
})

describe('扩查用的模型', () => {
  it('当前值取体检视图里扩查的选择；选一个立即存（扩查的键），不进保存行', async () => {
    const { gateway } = setup({ view: checkups({ checkup: null, expansion: { provider: 'provider-x', model: 'model-x' } }) })
    open('怎么用')
    const picker = () => screen.getByRole('combobox', { name: '扩查用的模型' }) as HTMLSelectElement
    await waitFor(() => { expect(picker().selectedOptions[0]).toHaveTextContent('Model X') })
    const pro = [...picker().querySelectorAll('option')].find(o => o.textContent === 'DeepSeek Pro')!
    await act(async () => { fireEvent.change(picker(), { target: { value: pro.value } }) })
    expect(sent(gateway, 'set-model-selection')).toEqual([{ cmd: 'set-model-selection', key: 'expansion', selection: { provider: 'deepseek-official', model: 'deepseek-pro' } }])
    expect(screen.queryByText(/项改动未保存/)).toBeNull()
  })

  it('两个模型选择器共用一次列模型', async () => {
    const { gateway } = setup()
    await waitFor(() => { expect(sent(gateway, 'list-models')).toHaveLength(1) })
    open('怎么管')
    open('怎么用')
    expect(sent(gateway, 'list-models')).toHaveLength(1)
  })

  it('上一个发布版写的体检视图（没有 selections）：两个选择器都写「无法确认当前选择」、置灰，不按 model 猜、不显示成跟随', async () => {
    setup({ view: checkups(undefined, { provider: 'provider-x', model: 'model-x' }) })
    open('怎么用')
    const expansion = screen.getByRole('combobox', { name: '扩查用的模型' }) as HTMLSelectElement
    await waitFor(() => { expect(expansion.selectedOptions[0]).toHaveTextContent('无法确认当前选择') })
    expect(expansion).toBeDisabled()
    open('怎么管')
    const checkup = screen.getByRole('combobox', { name: '体检用的模型' }) as HTMLSelectElement
    expect(checkup.selectedOptions[0]).toHaveTextContent('无法确认当前选择')
    expect(checkup).toBeDisabled()
  })
})

describe('模型选择读不出', () => {
  it('体检用的模型、扩查用的模型：显示「读不出当前选择」加一句说明，不显示成跟随', async () => {
    setup({ view: checkups({ checkup: 'unreadable', expansion: 'unreadable' }) })
    open('怎么管')
    const checkup = screen.getByRole('combobox', { name: '体检用的模型' }) as HTMLSelectElement
    await waitFor(() => { expect(checkup.selectedOptions[0]).toHaveTextContent('读不出当前选择') })
    expect(screen.getByText('保存的模型选择读不出，体检先停下。重新选一次就能恢复。')).toBeInTheDocument()
    open('怎么用')
    const expansion = screen.getByRole('combobox', { name: '扩查用的模型' }) as HTMLSelectElement
    expect(expansion.selectedOptions[0]).toHaveTextContent('读不出当前选择')
    expect(screen.getByText('保存的模型选择读不出，扩查先停下。重新选一次就能恢复。')).toBeInTheDocument()
  })

  it('重新选一次：存下新选的，视图换成读得出的值后说明消失；选「跟随」也算重选', async () => {
    const { gateway } = setup({ view: checkups({ checkup: 'unreadable', expansion: null }) })
    open('怎么管')
    const picker = () => screen.getByRole('combobox', { name: '体检用的模型' }) as HTMLSelectElement
    await waitFor(() => { expect(picker().querySelectorAll('optgroup')).toHaveLength(2) })
    await act(async () => { fireEvent.change(picker(), { target: { value: '' } }) })
    expect(sent(gateway, 'set-model-selection')).toEqual([{ cmd: 'set-model-selection', key: 'checkup', selection: null }])
    expect(picker().selectedOptions[0]).toHaveTextContent('跟随默认模型')
    act(() => { gateway.setView('checkups', checkups({ checkup: null, expansion: null })) })
    expect(screen.queryByText(/读不出/)).toBeNull()
  })

  it('没选过（文件不存在）时照常显示跟随，没有读不出的说明', () => {
    setup()
    open('怎么管')
    expect((screen.getByRole('combobox', { name: '体检用的模型' }) as HTMLSelectElement).selectedOptions[0]).toHaveTextContent('跟随默认模型')
    expect(screen.queryByText(/读不出/)).toBeNull()
  })

  it('英文界面：读不出的选项和说明都是英文', async () => {
    const gateway = createFakeGateway({
      views: { pending: pending(), health: health(), library: library(), checkups: checkups({ checkup: 'unreadable', expansion: 'unreadable' }) },
      respond: command => command.cmd === 'list-models' ? { ok: true, cmd: command.cmd, providers: CHOICES } : { ok: true, cmd: command.cmd, dialogueRecords: { status: 'none' } },
    })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} /></PanelShell>)
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Settings sections' })).getByRole('tab', { name: 'How to manage' }))
    expect((screen.getByRole('combobox', { name: 'Model for checkups' }) as HTMLSelectElement).selectedOptions[0]).toHaveTextContent("Couldn't read the current choice")
    expect(screen.getByText("The saved model choice couldn't be read, so checkups are paused. Choose again to fix it.")).toBeInTheDocument()
  })
})

describe('「怎么管」：体检、记忆梦境、存储', () => {
  it('三个小节；体检卡下脚注讲自动体检在哪设；记忆梦境标「实验性」，这一版只有一句说明、没有设置项', () => {
    setup()
    open('怎么管')
    expect(within(panel()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['体检', '记忆梦境（BrewingDreams） 实验性', '存储'])
    expect(screen.getByText('自动体检多久一次，在记忆页标题行按范围设。')).toBeInTheDocument()
    const dreams = within(panel()).getByRole('heading', { name: /^记忆梦境/ }).closest('section')!
    expect(within(dreams).getByText('实验性')).toHaveClass('pm-chip--neutral')
    expect(within(dreams).queryByRole('switch')).toBeNull()
    expect(within(dreams).queryByRole('combobox')).toBeNull()
    expect(screen.queryByText('历史版本保留')).toBeNull()
  })

  it('状态变了时提醒复查：开关标「实验性」，缺省关，改了写 governance.relatedRecheck', async () => {
    const { form } = setup()
    open('怎么管')
    const toggle = sw('状态变了时，提醒复查相关的决定')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(within(toggle.closest('.pm-setting') as HTMLElement).getByText('实验性')).toBeInTheDocument()
    fireEvent.click(toggle)
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['governance', 'relatedRecheck'], value: true }])
  })

  it('配置文件关掉体检：复查提醒开关置灰，说明换成原因', () => {
    setup({ value: section({ governance: { enabled: false, health: { sensitivity: 'normal' }, globalPromoteTarget: 'plugin-global' } }) })
    open('怎么管')
    expect(sw('状态变了时，提醒复查相关的决定')).toBeDisabled()
    expect(sw('状态变了时，提醒复查相关的决定').closest('.pm-setting')).toHaveClass('pm-setting--disabled')
  })

  it('存储的顺序：对话记录库、删除的记忆、记忆文件位置', () => {
    setup()
    open('怎么管')
    const storage = within(panel()).getByRole('heading', { name: '存储' }).closest('section')!
    expect([...storage.querySelectorAll('.pm-setting-label')].map(el => el.textContent)).toEqual(['对话记录库', '删除的记忆', '记忆文件位置'])
  })
})

describe('对话记录库', () => {
  const records = () => within(panel()).getByText('对话记录库', { selector: '.pm-setting-label' }).closest('.pm-setting') as HTMLElement

  it('说明写明本机多一份对话文本、首次使用时在后台建、关掉可以删除', () => {
    setup()
    open('怎么管')
    const hint = within(records()).getByText(/^对话记录库是本机多存的一份对话文本/)
    expect(hint).toHaveTextContent('首次使用时在后台建')
    expect(hint).toHaveTextContent('两样都关掉后，可以删除对话记录库')
  })

  it.each([
    [{ status: 'ready' } as const, '可以用了', ''],
    [{ status: 'building', sessions: 128 } as const, '正在后台建，已覆盖 128 个会话', '建好之前，只搜已覆盖的会话。'],
    [{ status: 'rebuilding' } as const, '正在重建', '重建期间照常用旧的，建好后自动换上。'],
    [{ status: 'none' } as const, '还没建', '用到原话时在后台建。'],
  ])('打开设置页时现取一次状态：%o', async (state, title, detail) => {
    const { gateway } = setup({ records: [state] })
    open('怎么管')
    expect(await within(records()).findByText(title)).toBeInTheDocument()
    if (detail !== '') expect(within(records()).getByText(detail)).toBeInTheDocument()
    expect(sent(gateway, 'dialogue-records-state')).toHaveLength(1)
  })

  it('没建、也用不上：写现在用不上、不会建；没有删除按钮', async () => {
    setup({ records: [{ status: 'none' }], value: section({ search: { source: 'memory', memoryQuotes: false } }) })
    open('怎么管')
    expect(await within(records()).findByText('现在用不上，不会建。')).toBeInTheDocument()
    expect(within(records()).queryByRole('button', { name: '删除对话记录库…' })).toBeNull()
  })

  it('状态读不出：写读不到，不显示成没建；照样能点删除', async () => {
    setup({ records: ['failed'] })
    open('怎么管')
    expect(await within(records()).findByText('读不到对话记录库的状态')).toBeInTheDocument()
    expect(within(records()).queryByText('还没建')).toBeNull()
    expect(within(records()).getByRole('button', { name: '删除对话记录库…' })).toBeInTheDocument()
  })

  it('删除先原位确认：点下时现查一次状态，确认才删；删完再取一次状态', async () => {
    const { gateway } = setup({ records: [{ status: 'ready' }, { status: 'ready' }, { status: 'none' }] })
    open('怎么管')
    await within(records()).findByText('可以用了')
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    expect(sent(gateway, 'dialogue-records-state')).toHaveLength(2)
    expect(sent(gateway, 'delete-dialogue-records')).toEqual([])
    const ask = within(records()).getByRole('group', { name: '删除对话记录库' })
    expect(ask).toHaveTextContent('删除对话记录库？会话日志不受影响。检索查原话或附带原话还开着，下次用到时会在后台重建。')
    await act(async () => { fireEvent.click(within(ask).getByRole('button', { name: '删除' })) })
    expect(sent(gateway, 'delete-dialogue-records')).toEqual([{ cmd: 'delete-dialogue-records' }])
    expect(sent(gateway, 'dialogue-records-state')).toHaveLength(3)
    expect(await within(records()).findByText('还没建')).toBeInTheDocument()
  })

  it('确认时取消：不删，按钮回来', async () => {
    const { gateway } = setup()
    open('怎么管')
    await within(records()).findByText('可以用了')
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    fireEvent.click(within(within(records()).getByRole('group', { name: '删除对话记录库' })).getByRole('button', { name: '取消' }))
    expect(within(records()).queryByRole('group', { name: '删除对话记录库' })).toBeNull()
    expect(within(records()).getByRole('button', { name: '删除对话记录库…' })).toBeInTheDocument()
    expect(sent(gateway, 'delete-dialogue-records')).toEqual([])
  })

  it('点下时现查发现已经没有库了：不弹确认，状态换成没建', async () => {
    const { gateway } = setup({ records: [{ status: 'ready' }, { status: 'none' }] })
    open('怎么管')
    await within(records()).findByText('可以用了')
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    expect(within(records()).queryByRole('group', { name: '删除对话记录库' })).toBeNull()
    expect(within(records()).getByText('还没建')).toBeInTheDocument()
    expect(sent(gateway, 'delete-dialogue-records')).toEqual([])
  })

  it('用不上时确认文字只说删本机这份', async () => {
    setup({ value: section({ search: { source: 'memory', memoryQuotes: false } }) })
    open('怎么管')
    await within(records()).findByText('可以用了')
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    expect(within(records()).getByRole('group', { name: '删除对话记录库' })).toHaveTextContent('删除对话记录库？只删本机这份对话文本，会话日志不受影响。')
  })

  it('删除失败：说明没删掉，状态不改成没建', async () => {
    setup({ respond: command => command.cmd === 'delete-dialogue-records' ? { ok: false, cmd: command.cmd, code: 'failed' } : undefined })
    open('怎么管')
    await within(records()).findByText('可以用了')
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    await act(async () => { fireEvent.click(within(within(records()).getByRole('group', { name: '删除对话记录库' })).getByRole('button', { name: '删除' })) })
    expect(within(records()).getByText('没删掉，再试一次。')).toBeInTheDocument()
    expect(within(records()).getByText('可以用了')).toBeInTheDocument()
    expect(within(records()).queryByText('还没建')).toBeNull()
  })

  it('没有会话：不发命令，写开一个会话后才能查看', () => {
    const { gateway } = setup({ session: 'none' })
    open('怎么管')
    expect(within(records()).getByText('开一个会话后才能查看和删除。')).toBeInTheDocument()
    expect(sent(gateway, 'dialogue-records-state')).toEqual([])
  })

  it('保存后对话记录库不再用得上、库还在：原位问要不要删，点了照样先确认；不自动删', async () => {
    const { form, gateway } = setup()
    open('怎么用')
    fireEvent.click(seg('检索来源', '只查记忆'))
    fireEvent.click(sw('检索结果附带原话'))
    await clickSave(form)
    open('怎么管')
    expect(await within(records()).findByText('对话记录库已不再使用，要删掉吗？')).toBeInTheDocument()
    expect(sent(gateway, 'delete-dialogue-records')).toEqual([])
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    expect(within(records()).getByRole('group', { name: '删除对话记录库' })).toBeInTheDocument()
  })

  it('在「怎么用」保存后：保存行旁边就看得到要不要删的提示，点「前往存储」切到「怎么管」、焦点落到存储里的删除按钮', async () => {
    const { form } = setup()
    open('怎么用')
    fireEvent.click(seg('检索来源', '只查记忆'))
    fireEvent.click(sw('检索结果附带原话'))
    await clickSave(form)
    const goto = await screen.findByRole('button', { name: '前往存储' })
    expect(goto.closest('p')).toHaveTextContent('对话记录库已不再使用，要删掉吗？')
    expect(goto).toBeVisible()
    expect(within(panel()).queryByText('对话记录库已不再使用，要删掉吗？')).toBeNull()
    fireEvent.click(goto)
    expect(pageTab('怎么管')).toHaveAttribute('aria-selected', 'true')
    expect(within(records()).getByRole('button', { name: '删除对话记录库…' })).toHaveFocus()
    // 到了存储这一页只留原位那一句
    expect(screen.getAllByText('对话记录库已不再使用，要删掉吗？')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: '前往存储' })).toBeNull()
  })

  it('保存后现查读不到状态：照写读不到，不问要不要删', async () => {
    const { form } = setup({ records: [{ status: 'ready' }, 'failed'] })
    open('怎么用')
    fireEvent.click(seg('检索来源', '只查记忆'))
    fireEvent.click(sw('检索结果附带原话'))
    await clickSave(form)
    open('怎么管')
    expect(await within(records()).findByText('读不到对话记录库的状态')).toBeInTheDocument()
    expect(screen.queryByText(/已不再使用/)).toBeNull()
  })

  it('问过之后又用得上了（改回来再保存）：不再问', async () => {
    const { form } = setup()
    open('怎么用')
    fireEvent.click(seg('检索来源', '只查记忆'))
    fireEvent.click(sw('检索结果附带原话'))
    await clickSave(form)
    await screen.findByRole('button', { name: '前往存储' })
    fireEvent.click(seg('检索来源', '两者都查'))
    await clickSave(form)
    open('怎么管')
    await within(records()).findByText('可以用了')
    expect(screen.queryByText(/已不再使用/)).toBeNull()
  })

  it('换了会话：先前的提示和确认都收掉，按新会话重取状态', async () => {
    const { form, gateway } = setup()
    open('怎么用')
    fireEvent.click(seg('检索来源', '只查记忆'))
    fireEvent.click(sw('检索结果附带原话'))
    await clickSave(form)
    await screen.findByRole('button', { name: '前往存储' })
    open('怎么管')
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    expect(within(records()).getByRole('group', { name: '删除对话记录库' })).toBeInTheDocument()
    await act(async () => { gateway.setSession({ kind: 'ready', sessionId: 's2', cwd: undefined }) })
    expect(within(records()).queryByRole('group', { name: '删除对话记录库' })).toBeNull()
    expect(screen.queryByText(/已不再使用/)).toBeNull()
    expect(gateway.executed.filter(e => e.command.cmd === 'dialogue-records-state').at(-1)?.sessionId).toBe('s2')
  })

  it('确认展开时会话断开：确认收掉，只写开一个会话后才能查看', async () => {
    const { gateway } = setup()
    open('怎么管')
    await within(records()).findByText('可以用了')
    await act(async () => { fireEvent.click(within(records()).getByRole('button', { name: '删除对话记录库…' })) })
    act(() => { gateway.setSession({ kind: 'none' }) })
    expect(within(records()).queryByRole('group', { name: '删除对话记录库' })).toBeNull()
    expect(within(records()).getByText('开一个会话后才能查看和删除。')).toBeInTheDocument()
  })

  it('切会话前发出的状态查询晚回来：不盖掉新会话的状态', async () => {
    let release: (() => void) | undefined
    const { gateway } = setup({
      respond: (command) => {
        if (command.cmd !== 'dialogue-records-state' || release !== undefined) return undefined
        return new Promise((resolve) => { release = () => { resolve({ ok: true, cmd: command.cmd, dialogueRecords: { status: 'building', sessions: 9 } }) } })
      },
      records: [{ status: 'ready' }],
    })
    open('怎么管')
    await act(async () => { gateway.setSession({ kind: 'ready', sessionId: 's2', cwd: undefined }) })
    expect(await within(records()).findByText('可以用了')).toBeInTheDocument()
    await act(async () => { release!() })
    expect(within(records()).getByText('可以用了')).toBeInTheDocument()
    expect(within(records()).queryByText(/已覆盖 9 个会话/)).toBeNull()
  })

  it('点删除后现查还没回来：按钮置灰，连点也只查一次', async () => {
    let release: (() => void) | undefined
    let count = 0
    const { gateway } = setup({
      respond: (command) => {
        if (command.cmd !== 'dialogue-records-state' || ++count === 1) return undefined
        return new Promise((resolve) => { release = () => { resolve({ ok: true, cmd: command.cmd, dialogueRecords: { status: 'ready' } }) } })
      },
    })
    open('怎么管')
    await within(records()).findByText('可以用了')
    const button = within(records()).getByRole('button', { name: '删除对话记录库…' })
    await act(async () => { fireEvent.click(button) })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    await act(async () => { fireEvent.click(button) })
    expect(sent(gateway, 'dialogue-records-state')).toHaveLength(2)
    await act(async () => { release!() })
    expect(within(records()).getByRole('group', { name: '删除对话记录库' })).toBeInTheDocument()
  })

  it('保存后用不上了、但库本来就没建：不问', async () => {
    const { form } = setup({ records: [{ status: 'none' }] })
    open('怎么用')
    fireEvent.click(seg('检索来源', '只查记忆'))
    fireEvent.click(sw('检索结果附带原话'))
    await clickSave(form)
    open('怎么管')
    await within(records()).findByText('还没建')
    expect(within(records()).queryByText(/已不再使用/)).toBeNull()
  })
})

describe('英文文案', () => {
  it('复查提醒的说明用记忆页那个标签的实际名字（中英各一）', () => {
    for (const locale of [zh, en]) {
      const t = createTranslator(locale)
      expect(t('settings.recheck.hint')).toContain(t('tab.todo'))
    }
  })


  it('分页、小节、新加的几项都有英文', async () => {
    const gateway = createFakeGateway({
      views: { pending: pending(), health: health(), library: library(), checkups: checkups({ checkup: null, expansion: null }) },
      respond: command => command.cmd === 'list-models' ? { ok: true, cmd: command.cmd, providers: CHOICES } : { ok: true, cmd: command.cmd, dialogueRecords: { status: 'building', sessions: 1 } },
    })
    render(<PanelShell gateway={gateway} t={createTranslator(en)}><SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} /></PanelShell>)
    const tabs = within(screen.getByRole('tablist', { name: 'Settings sections' }))
    expect(tabs.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['What to remember', 'How to use', 'How to manage', 'Appearance'])
    fireEvent.click(tabs.getByRole('tab', { name: 'How to use' }))
    expect(within(panel()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Brought in', 'Search', 'Checking'])
    expect(screen.getByRole('switch', { name: 'Attach source quotes to results' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Other quotes per search' })).toHaveTextContent('5 passages (about 1,500 tokens)')
    expect(screen.getByRole('switch', { name: 'Query expansion' })).toBeInTheDocument()
    expect((screen.getByRole('combobox', { name: 'Model for query expansion' }) as HTMLSelectElement).selectedOptions[0]).toHaveTextContent("Follow the chat's model")
    fireEvent.click(tabs.getByRole('tab', { name: 'How to manage' }))
    expect(within(panel()).getAllByRole('heading', { level: 3 }).map(h => h.textContent)).toEqual(['Checkups', 'BrewingDreams Experimental', 'Storage'])
    expect(await screen.findByText('Building in the background: 1 session covered')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Suggest rechecking related decisions when a state changes' })).toBeInTheDocument()
  })
})

// 插件设置页：三组设置的渲染、「我加的类型」弹层必填校验、revision 冻结与冲突提示、非法值、体检关闭时置灰、状态卡。
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type HealthView, type LibraryView, type MemoryCommandResult, type PendingView } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en, zh } from '../locales.ts'
import { memory, NOW, renderInShell, levelCountsOf } from '../test-utils.tsx'
import { PanelShell } from '../ui/PanelShell.tsx'
import { createFakeConfigForm, DEFAULT_SECTION, type FakeConfigForm } from './config-form.fake.ts'
import { SettingsPage } from './SettingsPage.tsx'
import { openTarget, summarize } from './StatusCard.tsx'

const t = createTranslator(zh)

const library = (count: number, memoryRoot = '/home/me/.dsh/memories'): LibraryView => ({
  version: GUI_VIEW_VERSION, memoryRoot, directoryIssues: [],
  layers: [{ layer: { kind: 'global' }, items: Array.from({ length: count }, (_, i) => memory({ id: `m${i}` })) }],
})
const health = (lastCheckupAt: number | null): HealthView => ({
  version: GUI_VIEW_VERSION,
  governanceEnabled: true,
  layers: [{ layer: { kind: 'global' }, totalMemories: 1, score: 90, tier: 'green', gate: { secret: false }, issues: [], staleCount: 0, lastCheckupAt, overflow: null, ignored: [] }],
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
  it('记什么：模板三档、我加的类型列表', () => {
    setup({ value: section({ template: 'office', customTypes: { 'domain-term': { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' } } }) })
    expect(screen.getByRole('heading', { name: '记什么' })).toBeInTheDocument()
    expect(tab('场景模板', '办公')).toHaveAttribute('aria-selected', 'true')
    expect(tab('场景模板', '编码')).toHaveAttribute('aria-selected', 'false')
    expect(tab('场景模板', '通用')).toBeInTheDocument()
    expect(screen.getByText('术语')).toBeInTheDocument()
    expect(screen.getByText('domain-term')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑 术语' })).toBeInTheDocument()
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
    expect(onOpen).toHaveBeenCalledWith({ tab: 'deleted' })
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

  it('模板按通用、编码、办公排列，说明随选中项列出这一档的类型', () => {
    setup()
    const names = within(screen.getByRole('tablist', { name: '场景模板' })).getAllByRole('tab').map(el => el.textContent)
    expect(names).toEqual(['通用', '编码', '办公'])
    expect(screen.getByText('在通用五类之外，多一类「可复用流程」。')).toBeInTheDocument()
    fireEvent.click(tab('场景模板', '办公'))
    expect(screen.getByText(/^在通用五类之外，多「决定」「承诺」「人物」三类。/)).toBeInTheDocument()
    fireEvent.click(tab('场景模板', '通用'))
    expect(screen.getByText(/^用五类通用记忆：用户画像、行为偏好、事实与经验、项目信息、参考引用。/)).toBeInTheDocument()
  })

  it('切换模板会少掉类型时，提示少掉的是哪几类；只多不少时不提示', () => {
    setup()
    expect(screen.queryByText(/不再新增/)).toBeNull()
    fireEvent.click(tab('场景模板', '通用'))
    expect(screen.getByText('用五类通用记忆：用户画像、行为偏好、事实与经验、项目信息、参考引用。切换后不再新增「可复用流程」类记忆，已有的仍会带入、能搜到。')).toBeInTheDocument()
    fireEvent.click(tab('场景模板', '办公'))
    expect(screen.getByText('在通用五类之外，多「决定」「承诺」「人物」三类。切换后不再新增「可复用流程」类记忆，已有的仍会带入、能搜到。')).toBeInTheDocument()
  })

  it('从通用切到编码只多不少，不提示后果', () => {
    setup({ value: section({ template: 'custom' }) })
    fireEvent.click(tab('场景模板', '编码'))
    expect(screen.getByText('在通用五类之外，多一类「可复用流程」。')).toBeInTheDocument()
    expect(screen.queryByText(/不再新增/)).toBeNull()
  })

  it('从办公切到通用，列出少掉的三类', () => {
    setup({ value: section({ template: 'office' }) })
    fireEvent.click(tab('场景模板', '通用'))
    expect(screen.getByText(/切换后不再新增「决定」「承诺」「人物」类记忆，已有的仍会带入、能搜到。$/)).toBeInTheDocument()
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

  it('召回方式默认「搜索」、治理优先级默认「中」，不点也能确定', async () => {
    const { form } = setup()
    openAdd()
    expect(within(dialog()).getByRole('tab', { name: '搜索' })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog()).getByRole('tab', { name: '中' })).toHaveAttribute('aria-selected', 'true')
    fill('中文名', '术语')
    fill('英文名', 'domain-term')
    fill('说明', '团队内部说法和它的意思')
    fill('什么时候记', '第一次解释一个说法时')
    fireEvent.click(within(dialog()).getByRole('button', { name: '确定' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{
      op: 'set', path: ['customTypes', 'domain-term'],
      value: { label: '术语', description: '团队内部说法和它的意思', whenToSave: '第一次解释一个说法时', recall: 'search', decayDays: null, governancePriority: 'medium' },
    }])
  })

  it('必填项没填不能确定，逐项就地提示', () => {
    setup()
    openAdd()
    fireEvent.click(within(dialog()).getByRole('button', { name: '确定' }))
    expect(dialog()).toBeInTheDocument()
    expect(within(dialog()).getAllByText('必填。')).toHaveLength(4)
    expect(within(dialog()).getByLabelText('中文名')).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog()).getByLabelText('过期天数')).not.toHaveAttribute('aria-invalid')
  })

  it('英文名格式、内置重名、过期天数非法各有提示', () => {
    setup()
    openAdd()
    fill('英文名', 'Meeting Note')
    fill('过期天数', '0')
    fireEvent.click(within(dialog()).getByRole('button', { name: '确定' }))
    expect(within(dialog()).getByText('只能用小写英文字母和连字符，例如 domain-term。')).toBeInTheDocument()
    expect(within(dialog()).getByText('填一个大于 0 的整数，或者留空。')).toBeInTheDocument()
    fill('英文名', 'preference')
    expect(within(dialog()).getByText('和内置类型重名了，换一个。')).toBeInTheDocument()
  })

  it('填齐后进列表；保存一次提交，过期天数留空写 null', async () => {
    const { form } = setup()
    openAdd()
    fill('中文名', '术语')
    fill('英文名', 'domain-term')
    fill('说明', '团队内部说法和它的意思')
    fill('什么时候记', '第一次解释一个说法时')
    fireEvent.click(within(dialog()).getByRole('tab', { name: '搜索' }))
    fireEvent.click(within(dialog()).getByRole('tab', { name: '高' }))
    fireEvent.click(within(dialog()).getByRole('button', { name: '确定' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('术语')).toBeInTheDocument()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{
      op: 'set', path: ['customTypes', 'domain-term'],
      value: { label: '术语', description: '团队内部说法和它的意思', whenToSave: '第一次解释一个说法时', recall: 'search', decayDays: null, governancePriority: 'high' },
    }])
  })

  it('编辑时英文名只读、可改其他字段；删除写 unset', async () => {
    const type = { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: 30, governancePriority: 'medium' }
    const { form } = setup({ value: section({ customTypes: { 'domain-term': type, 'todo': { ...type, label: '待办' } } }) })
    fireEvent.click(screen.getByRole('button', { name: '编辑 术语' }))
    const edit = screen.getByRole('dialog', { name: '编辑类型' })
    expect(within(edit).getByLabelText('英文名')).toHaveAttribute('readonly')
    expect(within(edit).getByLabelText('过期天数')).toHaveValue('30')
    fireEvent.change(within(edit).getByLabelText('过期天数'), { target: { value: '' } })
    fireEvent.click(within(edit).getByRole('button', { name: '确定' }))
    fireEvent.click(screen.getByRole('button', { name: '删除 待办' }))
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([
      { op: 'set', path: ['customTypes', 'domain-term'], value: { ...type, decayDays: null } },
      { op: 'unset', path: ['customTypes', 'todo'] },
    ])
  })

  it('取消不改草稿', () => {
    setup()
    openAdd()
    fill('中文名', '术语')
    fireEvent.click(within(dialog()).getByRole('button', { name: '取消' }))
    expect(screen.queryByText('术语')).toBeNull()
    expect(save()).toBeDisabled()
  })
})

describe('保存：revision 冻结、冲突、非法值', () => {
  it('点保存先弹窗列出改了哪几项（名称：旧值 → 新值），取消不提交、草稿保留', () => {
    const { form } = setup()
    fireEvent.click(tab('场景模板', '办公'))
    fireEvent.change(screen.getByLabelText('自动带入的记忆上限（token）'), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('switch', { name: '记忆体检' }))
    fireEvent.click(save())
    const items = within(confirmDialog()).getAllByRole('listitem').map(el => el.textContent)
    expect(items).toEqual([
      '场景模板：编码 → 办公',
      '自动带入的记忆上限（token）：4000 → 5000',
      '记忆体检：开 → 关',
    ])
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(form.calls).toHaveLength(0)
    expect(tab('场景模板', '办公')).toHaveAttribute('aria-selected', 'true')
    expect(save()).toBeEnabled()
  })

  it('确认弹窗里自定义类型按新增、修改、删除汇总名称', async () => {
    const type = { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' }
    const { form } = setup({ value: section({ customTypes: { 'domain-term': type, 'todo': { ...type, label: '待办' } } }) })
    fireEvent.click(screen.getByRole('button', { name: '删除 待办' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑 术语' }))
    fireEvent.change(within(screen.getByRole('dialog', { name: '编辑类型' })).getByLabelText('过期天数'), { target: { value: '30' } })
    fireEvent.click(within(screen.getByRole('dialog', { name: '编辑类型' })).getByRole('button', { name: '确定' }))
    fireEvent.click(screen.getByRole('button', { name: '添加类型' }))
    const add = () => screen.getByRole('dialog', { name: '添加类型' })
    for (const [label, value] of [['中文名', '学习目标'], ['英文名', 'learning-goal'], ['说明', 'd'], ['什么时候记', 'w']] as const) {
      fireEvent.change(within(add()).getByLabelText(label), { target: { value } })
    }
    fireEvent.click(within(add()).getByRole('button', { name: '确定' }))
    fireEvent.click(save())
    expect(within(confirmDialog()).getAllByRole('listitem').map(el => el.textContent))
      .toEqual(['我加的类型：新增「学习目标」；修改「术语」；删除「待办」'])
    await act(async () => { fireEvent.click(within(confirmDialog()).getByRole('button', { name: '保存' })) })
    await waitFor(() => { expect(form.calls).toHaveLength(1) })
  })

  it('没有改动时保存置灰；多项改动一次 mutate，带开始编辑时的 revision；保存后回到干净状态', async () => {
    const { form } = setup()
    expect(save()).toBeDisabled()
    fireEvent.click(tab('超出上限时', '严格按上限'))
    fireEvent.change(screen.getByLabelText('自动带入的记忆上限（token）'), { target: { value: '5000' } })
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
  const field = () => screen.getByLabelText('用户词典路径')
  /** 输入框经 aria-describedby 关联的说明。 */
  const description = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-describedby')!)

  it('归在「怎么用」，默认空；说明写明追加在内置词典之上、要绝对路径、没装 @node-rs/jieba 时不生效，并给「词 词频 词性」示例、注明词频必填', () => {
    setup()
    const how = screen.getByRole('heading', { name: '怎么用' }).closest('section')!
    expect(within(how).getByLabelText('用户词典路径')).toHaveValue('')
    const hint = description(field())
    expect(hint).toHaveTextContent('追加在内置词典之上，留空只用内置词典。要填绝对路径；没装 @node-rs/jieba 时不生效。')
    expect(hint).toHaveTextContent('每行「词 词频 词性」，词频必填，例如 插件记忆 10 n')
  })

  it('已配置时显示配置的路径', () => {
    setup({ value: section({ search: { userDictionaryPath: '/opt/dict/domain.txt' } }) })
    expect(field()).toHaveValue('/opt/dict/domain.txt')
  })

  it('填写后保存写 search.userDictionaryPath（去掉首尾空白），不提示重新载入记忆；只填空白不算改动', async () => {
    const { form } = setup()
    fireEvent.change(field(), { target: { value: '   ' } })
    expect(save()).toBeDisabled()
    fireEvent.change(field(), { target: { value: ' /opt/dict/domain.txt ' } })
    expect(screen.queryByText(/重新载入记忆/)).toBeNull()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['search', 'userDictionaryPath'], value: '/opt/dict/domain.txt' }])
    await waitFor(() => { expect(field()).toHaveValue('/opt/dict/domain.txt') })
    expect(save()).toBeDisabled()
  })

  it('清空后保存写 unset，回到只用内置词典；确认弹窗里这一项写成「路径 → 未设」', async () => {
    const { form } = setup({ value: section({ search: { userDictionaryPath: '/opt/dict/domain.txt' } }) })
    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.click(save())
    expect(within(confirmDialog()).getAllByRole('listitem').map(el => el.textContent)).toEqual(['用户词典路径：/opt/dict/domain.txt → 未设'])
    await act(async () => { fireEvent.click(within(confirmDialog()).getByRole('button', { name: '保存' })) })
    expect(form.calls[0]!.ops).toEqual([{ op: 'unset', path: ['search', 'userDictionaryPath'] }])
    await waitFor(() => { expect(form.value.search).toEqual({}) })
  })

  it('英文文案同样写明追加、绝对路径、没装 @node-rs/jieba 时不生效与词典格式', () => {
    render(<PanelShell gateway={createFakeGateway()} t={createTranslator(en)}><SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} /></PanelShell>)
    const input = screen.getByLabelText('User dictionary path')
    expect(input).toHaveValue('')
    const hint = description(input)
    expect(hint).toHaveTextContent('Added on top of the built-in dictionary; leave empty to use the built-in one only. Must be an absolute path; has no effect unless @node-rs/jieba is installed.')
    expect(hint).toHaveTextContent('One entry per line as “word frequency tag”; the frequency is required, for example 插件记忆 10 n')
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
  const conflict = { kind: 'conflict-horizontal' as const, level: 'your-call' as const, decisionId: 'd', firstSeenAt: NOW, summary: 's', left: null, right: null }
  const unreadable = { kind: 'unreadable-file' as const, level: 'must-fix' as const, layer: { kind: 'global' as const }, filePath: '/f', relativePath: 'f', error: 'e' }

  it('英文记忆数按单复数：1 memory、3 memories；中文不变', () => {
    const enT = createTranslator(en)
    expect(summarize(views(pending(), health(NOW), library(1)), false, NOW, enT).detail).toBe('1 memory')
    expect(summarize(views(), false, NOW, enT).detail).toBe('3 memories')
    expect(summarize(views(pending(), health(NOW), library(1)), false, NOW, t).detail).toBe('共 1 条记忆')
  })

  it('结论按优先级：体检关闭 → 密钥 → 等你决定 → 没有记忆 → 没体检 → 良好', () => {
    expect(summarize(views(), false, NOW, t)).toEqual({ conclusion: '体检已关闭', detail: '共 3 条记忆' })
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

  it('建议整理不算「等你决定」：只有建议时仍是状态良好，「打开记忆页 ›」去健康', () => {
    const advice = { kind: 'advice' as const, level: 'advice' as const, type: 'stale' as const, memories: [memory()] }
    expect(summarize(views(pending([advice, advice, conflict])), true, NOW, t).conclusion).toBe('有 1 处等你决定')
    expect(summarize(views(pending([advice])), true, NOW, t)).toEqual({ marker: 'ok', conclusion: '状态良好', detail: '共 3 条记忆 · 上次体检：刚刚' })
    expect(openTarget(pending([advice]))).toBe('health')
  })

  it('读视图渲染结论；没有等你决定的事时「打开记忆页 ›」去健康；没有会话时只写一句提示', () => {
    const { onOpen, gateway } = setup()
    expect(screen.getByText('状态良好')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(onOpen).toHaveBeenCalledWith({ tab: 'health' })
    act(() => { gateway.setSession({ kind: 'none' }) })
    expect(screen.getByText('开一个会话后这里显示记忆状态')).toBeInTheDocument()
  })

  it('有等你决定的事（含密钥）时「打开记忆页 ›」去待处理；只有读不出的文件仍去健康', () => {
    const { onOpen, gateway } = setup()
    act(() => { gateway.setView('pending', pending([conflict])) })
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ tab: 'pending' })
    act(() => { gateway.setView('pending', pending([{ kind: 'secret', level: 'must-fix', memory: memory() }])) })
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ tab: 'pending' })
    act(() => { gateway.setView('pending', pending([unreadable])) })
    fireEvent.click(screen.getByRole('button', { name: '打开记忆页 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ tab: 'health' })
  })
})

describe('状态卡「立即体检」', () => {
  let onOpen = vi.fn()
  let container: HTMLElement
  function render(init: Parameters<typeof createFakeGateway>[0] = {}, value?: Record<string, unknown>) {
    const gateway = createFakeGateway({ views: { pending: pending(), health: health(NOW), library: library(3) }, ...init })
    onOpen = vi.fn()
    container = renderInShell(<SettingsPage form={createFakeConfigForm(value ? { value } : {})} onOpenMemoryPage={onOpen} now={NOW} />, gateway).container
    return gateway
  }
  const button = () => screen.getByRole('button', { name: /立即体检|正在体检|再试一次/ })
  /** 按钮下面那一行。 */
  const statusLine = () => container.querySelector('.pm-status-scan')!
  const scanned = (patch: Partial<Extract<MemoryCommandResult, { ok: true }>> = {}): MemoryCommandResult =>
    ({ ok: true, cmd: 'scan', notes: [], added: { pending: 0, advice: 0 }, ...patch })
  async function scan(result: MemoryCommandResult) {
    render({ respond: () => result })
    await act(async () => { fireEvent.click(button()) })
  }

  it('有新增：和页头同一行，链接经导航直达记忆页对应的 tab 和组', async () => {
    await scan(scanned({ added: { pending: 1, advice: 2, pendingLevel: 'must-fix' } }))
    // 原地跑：完成后不自动跳走
    expect(onOpen).not.toHaveBeenCalled()
    expect(statusLine()).toHaveTextContent(/^体检完成：新增 1 条待处理 ›·新增 2 条建议 ›·查看分数 ›$/)
    fireEvent.click(screen.getByRole('button', { name: '新增 1 条待处理 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ tab: 'pending', level: 'must-fix' })
    fireEvent.click(screen.getByRole('button', { name: '新增 2 条建议 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ tab: 'pending', level: 'advice' })
    fireEvent.click(screen.getByRole('button', { name: '查看分数 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ tab: 'health' })
  })

  it('新增的待处理分在两组：链接落在待处理顶部（不带组）', async () => {
    await scan(scanned({ added: { pending: 2, advice: 0 } }))
    fireEvent.click(screen.getByRole('button', { name: '新增 2 条待处理 ›' }))
    expect(onOpen).toHaveBeenLastCalledWith({ tab: 'pending' })
  })

  it('只有建议：没有「待处理」那段', async () => {
    await scan(scanned({ added: { pending: 0, advice: 1 } }))
    expect(statusLine()).toHaveTextContent(/^体检完成：新增 1 条建议 ›·查看分数 ›$/)
  })

  it('没有新增：写没有发现新问题；基线检查被跳过的说明附在后面', async () => {
    await scan(scanned({ notes: ['baseline-session-scoped'] }))
    expect(statusLine()).toHaveTextContent(/^没有发现新问题·查看分数 ›这次没有对照本项目的 AGENTS.md 检查冲突/)
    expect(within(statusLine() as HTMLElement).getAllByRole('button').map(b => b.textContent)).toEqual(['查看分数 ›'])
  })

  it('内容检查没做完、分了批：说明附在后面', async () => {
    await scan(scanned({ added: { pending: 1, advice: 0 }, notes: ['semantic-failed', 'semantic-batched'], semanticBatches: 2 }))
    expect(statusLine()).toHaveTextContent(/^体检完成：新增 1 条待处理 ›·查看分数 ›内容检查没有完成，这次只更新了规则检查。记忆较多，分 2 批检查，不同批之间的冲突和重复可能查不出。$/)
  })

  it('宿主报了用量：结果行末尾写实际用量；没报就不写', async () => {
    await scan(scanned({ usageTokens: 12345 }))
    expect(statusLine()).toHaveTextContent(/^没有发现新问题·查看分数 ›·本次用了约 12,345 token$/)
    cleanup()
    await scan(scanned())
    expect(statusLine()).not.toHaveTextContent(/token/)
  })

  it('按钮下常驻一行 token 消耗说明；体检关闭、没有可用会话时不写', () => {
    const gateway = render()
    expect(container.querySelector('.pm-scan-hint')).toHaveTextContent(/^会用当前对话的模型检查记忆内容，记忆越多，用的 token 越多。$/)
    act(() => { gateway.setSession({ kind: 'none' }) })
    expect(container.querySelector('.pm-scan-hint')).toBeNull()
    cleanup()
    render({}, section({ governance: { enabled: false, health: { sensitivity: 'standard' }, globalPromoteTarget: 'plugin-global' } }))
    expect(container.querySelector('.pm-scan-hint')).toBeNull()
  })

  it('命令回来说体检已关闭：只写体检已关闭', async () => {
    await scan({ ok: false, cmd: 'scan', code: 'governance-disabled', detail: '体检已关闭，可在插件设置里打开' })
    expect(statusLine()).toHaveTextContent(/^体检已关闭$/)
  })

  it('发 /memory scan，体检当前选中会话所在的项目；进行中按钮禁用，完成后写一句（没带新增条数时只写体检完成）', async () => {
    let finish: (r: { ok: true; cmd: 'scan' }) => void = () => {}
    const gateway = render({ currentWorkspace: '/w/app', respond: () => new Promise((resolve) => { finish = resolve }) })
    fireEvent.click(button())
    expect(gateway.executed).toEqual([{ sessionId: 'fake-session', command: { cmd: 'scan', workspacePath: '/w/app' } }])
    expect(button()).toHaveTextContent('正在体检…')
    expect(button()).toBeDisabled()
    await act(async () => { finish({ ok: true, cmd: 'scan' }) })
    expect(button()).toHaveTextContent('立即体检')
    expect(screen.getByText('体检完成。')).toBeInTheDocument()
  })

  it('插件页没有选中的会话时体检全部层', async () => {
    const gateway = render()
    await act(async () => { fireEvent.click(button()) })
    expect(gateway.executed[0]!.command).toEqual({ cmd: 'scan' })
  })

  it('失败：原位写原因并提示在对话里让 agent 体检，按钮变「再试一次」', async () => {
    render({ respond: () => ({ ok: false, cmd: 'scan', code: 'llm-unavailable', detail: 'x' }) })
    await act(async () => { fireEvent.click(button()) })
    expect(screen.getByText(/借用的会话拿不到模型/)).toHaveTextContent('可以在对话里让 agent 体检。')
    expect(button()).toHaveTextContent('再试一次')
  })

  it('体检关闭或没有会话：按钮不可用，点了不发命令', () => {
    const gateway = render({}, section({ governance: { enabled: false, health: { sensitivity: 'standard' }, globalPromoteTarget: 'plugin-global' } }))
    expect(button()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button())
    act(() => { gateway.setSession({ kind: 'none' }) })
    expect(button()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button())
    expect(gateway.executed).toEqual([])
  })
})

describe('记忆文件位置「在访达中显示」', () => {
  it('有实际路径时可以在访达中显示；宿主拒绝时写一句', async () => {
    const gateway = createFakeGateway({ views: { pending: pending(), health: health(NOW), library: library(3, '/home/me/.dsh/memories') }, openOk: false })
    renderInShell(<SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} />, gateway)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '在访达中显示' })) })
    expect(gateway.opened).toEqual([{ path: '/home/me/.dsh/memories', action: 'reveal' }])
    expect(screen.getByText('没能打开，宿主拒绝了这个路径。')).toBeInTheDocument()
  })

  it('还不知道路径时没有这个按钮', () => {
    renderInShell(<SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} />, createFakeGateway())
    expect(screen.queryByRole('button', { name: '在访达中显示' })).toBeNull()
  })
})

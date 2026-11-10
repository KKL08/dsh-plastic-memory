// 设置页「记什么」：场景列表、记忆类型列表、场景弹层、类型表单、改名与删除的迁移。
import { describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GUI_VIEW_VERSION, type DeletedView, type LibraryView, type MemoryCommand, type MemoryCommandResult } from '../../src/gui/contract.ts'
import { createFakeGateway } from '../gateway.fake.ts'
import { memory, NOW, renderInShell } from '../test-utils.tsx'
import { createFakeConfigForm, DEFAULT_SECTION, type FakeConfigForm } from './config-form.fake.ts'
import { nextSceneId, TYPE_DEFINITIONS } from './config.ts'
import { SettingsPage } from './SettingsPage.tsx'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { PanelShell } from '../ui/PanelShell.tsx'

const term = { label: '术语', description: 'd', whenToSave: 'w', recall: 'search', decayDays: null, governancePriority: 'medium' }
const client = { ...term, label: '客户名' }
const GENERAL = ['profile', 'preference', 'knowledge', 'project', 'reference']

const library = (types: string[]): LibraryView => ({
  version: GUI_VIEW_VERSION, memoryRoot: '/m', directoryIssues: [],
  layers: [{ layer: { kind: 'global' }, items: types.map((type, i) => memory({ id: `m${i}`, type })) }],
})
const deleted = (types: string[]): DeletedView => ({
  version: GUI_VIEW_VERSION,
  items: types.map((type, i) => ({ memory: memory({ id: `d${i}`, type }), deletedAt: NOW, purgeAt: NOW + 1 })),
})

function setup(opts: {
  value?: Record<string, unknown>
  memories?: string[]
  /** 传 true 时全部记忆视图还在读（有会话、条数读不到）。 */
  isLibraryLoading?: boolean
  deletedMemories?: string[]
  hasSession?: boolean
  respond?: (command: MemoryCommand) => MemoryCommandResult
} = {}) {
  const form = createFakeConfigForm({ value: { ...structuredClone(DEFAULT_SECTION), ...opts.value } })
  const gateway = createFakeGateway({
    views: { library: opts.isLibraryLoading ? { status: 'loading' } : library(opts.memories ?? []), ...(opts.deletedMemories ? { deleted: deleted(opts.deletedMemories) } : {}) },
    ...(opts.hasSession === false ? { session: { kind: 'none' } } : {}),
    ...(opts.respond ? { respond: opts.respond } : {}),
  })
  const view = renderInShell(<SettingsPage form={form} onOpenMemoryPage={() => {}} now={NOW} />, gateway)
  return { form, ...view }
}

const radio = (name: string) => screen.getByRole('radio', { name })
const button = (name: string, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name })
const dialog = (name: string) => screen.getByRole('dialog', { name })
const check = (scope: HTMLElement, name: string) => within(scope).getByRole('checkbox', { name })
const confirmLines = () => within(dialog('保存这些改动？')).getAllByRole('listitem').map(el => el.textContent)
const typesRegion = () => screen.getByRole('region', { name: '记忆类型' })
/** 记忆类型卡（三组里任一组），按开头的中文名找。 */
const typeRow = (label: string) => within(typesRegion()).getAllByRole('listitem').find(el => el.textContent!.startsWith(label))!
/** 记忆类型的一组卡（通用五类、预设、我加的）上的标题；新建卡没有标题，不算。 */
const typeTitles = (group: string) => within(within(typesRegion()).getByRole('list', { name: group })).getAllByRole('listitem')
  .flatMap(el => el.querySelector('.pm-tile-title')?.textContent ?? [])
/** 新建按钮所在的卡：断言它是哪张列表的最后一项。 */
const lastTileOf = (entry: HTMLElement) => {
  const item = entry.closest('li')!
  return { item, list: item.parentElement!, isLast: item.parentElement!.lastElementChild === item }
}

async function clickSave(form: FakeConfigForm) {
  const before = form.calls.length
  fireEvent.click(button('保存'))
  await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
  await waitFor(() => { expect(form.calls.length).toBe(before + 1) })
}

function fillType(scope: HTMLElement, fields: { label: string; name: string }) {
  for (const [label, value] of [['中文名', fields.label], ['英文名', fields.name], ['说明', 'd'], ['什么时候记', 'w']] as const) {
    fireEvent.change(within(scope).getByLabelText(label), { target: { value } })
  }
}

describe('场景列表', () => {
  it('通用、编码、办公和自建场景一行一个，写出组成；当前场景选中；通用没有编辑、删除', () => {
    setup({ value: { template: 'scene-1', customTypes: { term }, scenes: { coding: { label: '编码', types: [...GENERAL, 'procedure'] }, office: { label: '办公', types: [...GENERAL, 'decision'] }, 'scene-1': { label: '写作', types: ['preference', 'reference', 'decision', 'term'] } } } })
    expect(screen.getAllByRole('radio').map(el => el.getAttribute('aria-label'))).toEqual(['通用', '编码', '办公', '写作'])
    expect(radio('写作')).toBeChecked()
    expect(radio('通用')).toHaveAccessibleDescription('用户画像、行为偏好、事实与经验、项目信息、参考引用')
    expect(radio('编码')).toHaveAccessibleDescription('通用五类 + 可复用流程')
    expect(radio('写作')).toHaveAccessibleDescription('行为偏好、参考引用 + 决定 + 术语')
    expect(screen.queryByRole('button', { name: '编辑场景 通用' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除场景 通用' })).toBeNull()
    expect(button('编辑场景 写作')).toBeInTheDocument()
  })

  it('选中另一个场景并保存，写 template；页面上不写说明，少掉的类型在确认框里写明', async () => {
    const { form } = setup()
    fireEvent.click(radio('通用'))
    fireEvent.click(radio('办公'))
    expect(screen.queryByText(/不再新增/)).toBeNull()
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['当前场景：编码 → 办公'])
    expect(within(dialog('保存这些改动？')).getByText('保存后不再新增「可复用流程」类记忆，已有的仍会带入、能搜到。')).toBeInTheDocument()
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    await waitFor(() => { expect(form.calls).toHaveLength(1) })
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['template'], value: 'office' }])
  })

  it('换场景没有少掉的类型时，确认框不写这句', () => {
    setup({ value: { template: 'custom' } })
    fireEvent.click(radio('编码'))
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['当前场景：通用 → 编码'])
    expect(within(dialog('保存这些改动？')).queryByText(/不再新增/)).toBeNull()
  })

  it('配置里当前场景指向不存在的场景时显示通用', () => {
    setup({ value: { template: 'scene-gone' } })
    expect(radio('通用')).toBeChecked()
  })

  it('改过的编码标「已改」、多「恢复默认」，点了回到出厂组成', async () => {
    const { form } = setup({ value: { scenes: { coding: { label: '编码', types: ['preference', 'procedure'] }, office: { label: '办公', types: [...GENERAL, 'decision'] } } } })
    expect(screen.getByText('已改')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '办公恢复默认' })).toBeNull()
    fireEvent.click(button('编码恢复默认'))
    expect(screen.queryByText('已改')).toBeNull()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['scenes', 'coding'], value: { label: '编码', types: [...GENERAL, 'procedure'] } }])
  })

  it('删除走原位确认；删掉当前场景时换回通用，确认弹窗写明', async () => {
    const { form } = setup()
    fireEvent.click(button('删除场景 编码'))
    expect(screen.getByText('删除「编码」？当前场景会换回通用。')).toBeInTheDocument()
    fireEvent.click(button('取消'))
    expect(radio('编码')).toBeInTheDocument()
    fireEvent.click(button('删除场景 编码'))
    fireEvent.click(button('删除'))
    expect(screen.queryByRole('radio', { name: '编码' })).toBeNull()
    expect(radio('通用')).toBeChecked()
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['当前场景：编码 → 通用', '场景：删除「编码」'])
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['template'], value: 'custom' }, { op: 'unset', path: ['scenes', 'coding'] }])
  })

  it('通用以外最多 5 个场景：新建按钮上写还能建几个，满了按钮置灰', () => {
    const scene = (label: string) => ({ label, types: ['profile'] })
    setup({ value: { scenes: { coding: scene('编码'), office: scene('办公'), a: scene('a'), b: scene('b') } } })
    expect(button('新建场景')).toHaveAccessibleDescription('还能建 1 个')
    expect(button('新建场景')).toBeEnabled()
    fireEvent.click(button('删除场景 a'))
    fireEvent.click(button('删除'))
    expect(screen.getByText('还能建 2 个')).toBeInTheDocument()
  })

  it('配置里手写超过 5 个时照常显示，按钮置灰、写还能建 0 个', () => {
    const scene = (label: string) => ({ label, types: ['profile'] })
    setup({ value: { scenes: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, scene(id)])) } })
    expect(screen.getAllByRole('radio')).toHaveLength(7)
    expect(screen.getByText('还能建 0 个')).toBeInTheDocument()
    expect(button('新建场景')).toBeDisabled()
    expect(lastTileOf(button('新建场景')).isLast).toBe(true)
  })

  it('新建场景是场景网格的最后一张卡，「还能建几个」在卡里', () => {
    setup()
    const { item, list, isLast } = lastTileOf(button('新建场景'))
    expect(list).toBe(screen.getByRole('radiogroup', { name: '场景' }))
    expect(list).toHaveClass('pm-tiles')
    expect(isLast).toBe(true)
    expect(within(item).getByText('还能建 3 个')).toBeInTheDocument()
    fireEvent.click(button('新建场景'))
    expect(dialog('新建场景')).toBeInTheDocument()
  })
})

describe('场景弹层', () => {
  it('新建：默认勾上通用五类，可以去掉，从预设里勾；确定后进列表，保存写 scenes 的新 id', async () => {
    const { form } = setup()
    fireEvent.click(button('新建场景'))
    const d = dialog('新建场景')
    for (const label of ['用户画像', '行为偏好', '事实与经验', '项目信息', '参考引用']) expect(check(d, label)).toBeChecked()
    expect(check(d, '决定')).not.toBeChecked()
    expect(within(d).queryByRole('checkbox', { name: '承诺' })).toBeNull()
    fireEvent.change(within(d).getByLabelText('场景名'), { target: { value: ' 写作 ' } })
    fireEvent.click(check(d, '用户画像'))
    fireEvent.click(check(d, '决定'))
    expect(within(d).getByText('已选 5 / 8')).toBeInTheDocument()
    fireEvent.click(button('确定', d))
    expect(radio('写作')).not.toBeChecked()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{
      op: 'set', path: ['scenes', nextSceneId([], NOW)], value: { label: '写作', types: ['preference', 'knowledge', 'project', 'reference', 'decision'] },
    }])
  })

  it('场景名必填、不和其他场景重名；一类不勾不能确定', () => {
    setup()
    fireEvent.click(button('新建场景'))
    const d = dialog('新建场景')
    for (const label of ['用户画像', '行为偏好', '事实与经验', '项目信息', '参考引用']) fireEvent.click(check(d, label))
    fireEvent.click(button('确定', d))
    expect(within(d).getByText('必填。')).toBeInTheDocument()
    expect(within(d).getByText('至少勾一类。')).toBeInTheDocument()
    fireEvent.change(within(d).getByLabelText('场景名'), { target: { value: '办公' } })
    expect(within(d).getByText('已经有这个名字的场景了。')).toBeInTheDocument()
  })

  it('最多 8 类：勾满后其余置灰', () => {
    const types = Object.fromEntries(['a', 'b', 'c'].map(n => [`t-${n}`, { ...term, label: `类${n}` }]))
    setup({ value: { customTypes: types } })
    fireEvent.click(button('编辑场景 编码'))
    const d = dialog('编辑场景')
    fireEvent.click(check(d, '决定'))
    fireEvent.click(check(d, '类a'))
    expect(within(d).getByText('已选 8 / 8')).toBeInTheDocument()
    expect(check(d, '类b')).toBeDisabled()
    expect(check(d, '用户画像')).toBeEnabled()
  })

  it('编辑编码：不能改名；去掉通用类型后确定，标「已改」', () => {
    setup()
    fireEvent.click(button('编辑场景 编码'))
    const d = dialog('编辑场景')
    expect(within(d).queryByLabelText('场景名')).toBeNull()
    fireEvent.click(check(d, '用户画像'))
    fireEvent.click(button('确定', d))
    expect(screen.getByText('已改')).toBeInTheDocument()
    expect(radio('编码')).toHaveAccessibleDescription('行为偏好、事实与经验、项目信息、参考引用 + 可复用流程')
  })

  it('编辑自建场景：可以改名、增减类型，保存写回同一个 id', async () => {
    const { form } = setup({ value: { scenes: { 'scene-1': { label: '写作', types: ['preference', 'reference'] } } } })
    fireEvent.click(button('编辑场景 写作'))
    const d = dialog('编辑场景')
    fireEvent.change(within(d).getByLabelText('场景名'), { target: { value: '写稿' } })
    fireEvent.click(check(d, '参考引用'))
    fireEvent.click(check(d, '决定'))
    fireEvent.click(button('确定', d))
    expect(radio('写稿')).toHaveAccessibleDescription('行为偏好 + 决定')
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['scenes', 'scene-1'], value: { label: '写稿', types: ['preference', 'decision'] } }])
  })

  it('弹层是一次事务：勾选和新建的类型在取消后全部撤销', () => {
    setup()
    fireEvent.click(button('编辑场景 编码'))
    fireEvent.click(check(dialog('编辑场景'), '决定'))
    fireEvent.click(button('＋ 新建类型', dialog('编辑场景')))
    fillType(dialog('新建类型'), { label: '术语', name: 'domain-term' })
    fireEvent.click(button('确定', dialog('新建类型')))
    expect(check(dialog('编辑场景'), '术语')).toBeChecked()
    fireEvent.click(button('取消', dialog('编辑场景')))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: '编辑 术语' })).toBeNull()
    expect(button('保存')).toBeDisabled()
  })

  it('弹层里新建类型：同一个弹层换成表单（有「‹ 返回」），确定后自动勾进这个场景；场景满了照样能建、不勾并提示', async () => {
    const types = Object.fromEntries(['a', 'b'].map(n => [`t-${n}`, { ...term, label: `类${n}` }]))
    const { form } = setup({ value: { customTypes: types } })
    fireEvent.click(button('编辑场景 编码'))
    fireEvent.click(button('＋ 新建类型', dialog('编辑场景')))
    const typeForm = dialog('新建类型')
    expect(within(typeForm).getByRole('tab', { name: '搜索' })).toHaveAttribute('aria-selected', 'true')
    expect(within(typeForm).getByRole('tab', { name: '中' })).toHaveAttribute('aria-selected', 'true')
    expect(button('‹ 返回', typeForm)).toBeInTheDocument()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fillType(typeForm, { label: '术语', name: 'domain-term' })
    fireEvent.click(button('确定', typeForm))
    const d = dialog('编辑场景')
    expect(check(d, '术语')).toBeChecked()
    fireEvent.click(check(d, '类a'))
    expect(within(d).getByText('已选 8 / 8')).toBeInTheDocument()
    fireEvent.click(button('＋ 新建类型', d))
    fillType(dialog('新建类型'), { label: '客户名', name: 'client' })
    fireEvent.click(button('确定', dialog('新建类型')))
    expect(check(dialog('编辑场景'), '客户名')).not.toBeChecked()
    expect(within(dialog('编辑场景')).getByText('已满 8 类，去掉一类后才能勾上「客户名」。')).toBeInTheDocument()
    fireEvent.click(button('确定', dialog('编辑场景')))
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['场景：修改「编码」', '我加的类型：新增「术语」「客户名」'])
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    await waitFor(() => { expect(form.calls).toHaveLength(1) })
    expect(form.value.scenes).toMatchObject({ coding: { types: [...GENERAL, 'procedure', 'domain-term', 't-a'] } })
  })

  it('类型表单：必填项、英文名格式、内置重名、中文名重复、衰退天数各有提示；「‹ 返回」回到勾选', () => {
    setup({ value: { customTypes: { term } } })
    fireEvent.click(button('新建场景'))
    fireEvent.click(button('＋ 新建类型', dialog('新建场景')))
    const f = dialog('新建类型')
    fireEvent.click(button('确定', f))
    expect(within(f).getAllByText('必填。')).toHaveLength(4)
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'Meeting Note' } })
    fireEvent.change(within(f).getByLabelText('衰退天数'), { target: { value: '0' } })
    fireEvent.change(within(f).getByLabelText('中文名'), { target: { value: '决定' } })
    expect(within(f).getByText('只能用小写英文字母和连字符，例如 domain-term。')).toBeInTheDocument()
    expect(within(f).getByText('填一个大于 0 的整数，或者留空。')).toBeInTheDocument()
    expect(within(f).getByText('已经有叫「决定」的类型了。')).toBeInTheDocument()
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'preference' } })
    expect(within(f).getByText('和内置类型重名了，换一个。')).toBeInTheDocument()
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'term' } })
    expect(within(f).getByText('已经有这个英文名了。')).toBeInTheDocument()
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'commitment' } })
    expect(within(f).queryByText('已经有这个英文名了。')).toBeNull()
    fireEvent.click(button('‹ 返回', f))
    expect(dialog('新建场景')).toBeInTheDocument()
  })

  it('预设改了中文名，出厂中文名仍算占用：「恢复默认」后不会和新建的类型重名', () => {
    setup({ value: { customTypes: { procedure: { ...TYPE_DEFINITIONS.procedure, label: '我的流程' } } } })
    fireEvent.click(button('新建场景'))
    fireEvent.click(button('＋ 新建类型', dialog('新建场景')))
    const f = dialog('新建类型')
    fireEvent.click(button('确定', f))
    fireEvent.change(within(f).getByLabelText('中文名'), { target: { value: '可复用流程' } })
    expect(within(f).getByText('已经有叫「可复用流程」的类型了。')).toBeInTheDocument()
    fireEvent.change(within(f).getByLabelText('中文名'), { target: { value: '我的流程' } })
    expect(within(f).getByText('已经有叫「我的流程」的类型了。')).toBeInTheDocument()
  })
})

describe('记忆类型列表', () => {
  const pool = {
    customTypes: { 'domain-term': term, client },
    scenes: { coding: { label: '编码', types: [...GENERAL, 'domain-term'] }, office: { label: '办公', types: [...GENERAL, 'decision'] } },
  }

  const withCounts = () => setup({ value: pool, memories: ['domain-term', 'domain-term', 'profile'], deletedMemories: ['domain-term'] })

  it('类型卡分三组：通用五类、预设、我加的', () => {
    withCounts()
    expect(typeTitles('通用五类')).toEqual(['用户画像', '行为偏好', '事实与经验', '项目信息', '参考引用'])
    expect(typeTitles('预设')).toEqual(['可复用流程', '决定'])
    expect(typeTitles('我加的')).toEqual(['术语', '客户名'])
  })

  it('新建类型是「我加的」网格的最后一张卡；还没有自己加的类型时组里只有这一张', () => {
    setup()
    const mine = within(typesRegion()).getByRole('list', { name: '我加的' })
    expect(mine).toHaveClass('pm-tiles')
    expect(within(mine).getAllByRole('listitem')).toHaveLength(1)
    expect(lastTileOf(button('新建类型', mine)).isLast).toBe(true)
    fireEvent.click(button('新建类型', mine))
    fillType(dialog('新建类型'), { label: '术语', name: 'domain-term' })
    fireEvent.click(button('确定', dialog('新建类型')))
    expect(typeTitles('我加的')).toEqual(['术语'])
    expect(lastTileOf(button('新建类型', mine)).isLast).toBe(true)
  })

  it('每张类型卡写哪些场景在用、存了几条（最近删除里的也算）', () => {
    withCounts()
    expect(within(typeRow('用户画像')).getByText('通用、编码、办公在用 · 1 条记忆')).toBeInTheDocument()
    expect(within(typeRow('可复用流程')).getByText('没有场景在用 · 0 条记忆')).toBeInTheDocument()
    expect(within(typeRow('决定')).getByText('办公在用 · 0 条记忆')).toBeInTheDocument()
    expect(within(typeRow('术语')).getByText('编码在用 · 3 条记忆')).toBeInTheDocument()
    expect(within(typeRow('客户名')).getByText('没有场景在用 · 0 条记忆')).toBeInTheDocument()
  })

  it('通用只有查看；预设、我加的有编辑、删除', () => {
    withCounts()
    expect(within(typeRow('用户画像')).getAllByRole('button').map(el => el.getAttribute('aria-label'))).toEqual(['查看 用户画像'])
    expect(within(typeRow('决定')).getAllByRole('button').map(el => el.getAttribute('aria-label'))).toEqual(['编辑 决定', '删除 决定'])
    expect(button('编辑 术语', typeRow('术语'))).toBeInTheDocument()
    expect(button('删除 客户名', typeRow('客户名'))).toBeInTheDocument()
  })

  it('我加的类型卡带英文名，预设不带', () => {
    withCounts()
    expect(within(typeRow('术语')).getByText('domain-term')).toBeInTheDocument()
    expect(within(typeRow('决定')).queryByText('decision')).toBeNull()
  })

  it('条数读不到时只写哪些场景在用', () => {
    setup({ value: pool, isLibraryLoading: true })
    expect(within(typeRow('术语')).getByText('编码在用')).toBeInTheDocument()
  })

  it('新建类型直接打开表单：没有「‹ 返回」，确定后进页面草稿，不勾进任何场景', async () => {
    const { form } = setup()
    fireEvent.click(button('新建类型'))
    const f = dialog('新建类型')
    expect(within(f).queryByRole('button', { name: '‹ 返回' })).toBeNull()
    fillType(f, { label: '术语', name: 'domain-term' })
    fireEvent.click(button('确定', f))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(typeRow('术语')).getByText('没有场景在用 · 0 条记忆')).toBeInTheDocument()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['customTypes', 'domain-term'], value: term }])
  })

  it('「怎么用」选填：新建时不填照样能确定；填了就写进 customTypes', async () => {
    const { form } = setup()
    fireEvent.click(button('新建类型'))
    const f = dialog('新建类型')
    expect(within(f).getByLabelText('带入后怎么用')).toHaveValue('')
    fillType(f, { label: '术语', name: 'domain-term' })
    fireEvent.change(within(f).getByLabelText('带入后怎么用'), { target: { value: '遇到这个词时按记下的含义理解' } })
    fireEvent.click(button('确定', f))
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['customTypes', 'domain-term'], value: { ...term, howToUse: '遇到这个词时按记下的含义理解' } }])
  })

  it('编辑直接打开表单：没有「‹ 返回」，确定后直接进页面草稿', async () => {
    const { form } = setup({ value: { customTypes: { 'domain-term': term } } })
    fireEvent.click(button('编辑 术语'))
    const f = dialog('编辑类型')
    expect(within(f).queryByRole('button', { name: '‹ 返回' })).toBeNull()
    fireEvent.change(within(f).getByLabelText('衰退天数'), { target: { value: '30' } })
    fireEvent.click(button('确定', f))
    expect(screen.queryByRole('dialog')).toBeNull()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['customTypes', 'domain-term'], value: { ...term, decayDays: 30 } }])
  })

  it('删除走行内确认：写明哪些场景在用；取消收起，确认后进草稿', async () => {
    const { form } = setup({ value: pool })
    fireEvent.click(button('删除 术语'))
    expect(within(typeRow('术语')).getByText('删除「术语」？编码在用，会一起去掉。')).toBeInTheDocument()
    fireEvent.click(button('取消', typeRow('术语')))
    expect(screen.queryByText(/^删除「术语」？/)).toBeNull()
    fireEvent.click(button('删除 客户名'))
    fireEvent.click(button('删除', typeRow('客户名')))
    expect(within(typesRegion()).queryByText('客户名')).toBeNull()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'unset', path: ['customTypes', 'client'] }])
  })
})

describe('通用、预设类型', () => {
  const edited = { ...TYPE_DEFINITIONS.procedure, decayDays: 60 }

  it('查看通用类型：只读弹层写出定义原文，没有输入框，关闭就收起', () => {
    setup()
    fireEvent.click(button('查看 用户画像'))
    const f = dialog('用户画像')
    expect(within(f).getByText('profile')).toBeInTheDocument()
    expect(within(f).getByText(TYPE_DEFINITIONS.profile.whenToSave)).toBeInTheDocument()
    expect(within(f).getByText('带入后怎么用')).toBeInTheDocument()
    expect(within(f).getByText(TYPE_DEFINITIONS.profile.howToUse!)).toBeInTheDocument()
    expect(within(f).getByText('常驻')).toBeInTheDocument()
    expect(within(f).getByText('不衰退')).toBeInTheDocument()
    expect(within(f).queryByRole('textbox')).toBeNull()
    expect(within(f).queryByRole('button', { name: '确定' })).toBeNull()
    fireEvent.click(within(f).getAllByRole('button', { name: '关闭' }).at(-1)!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('编辑预设：预填出厂定义、英文名不能改；改了标「已改」，保存写同名 customTypes', async () => {
    const { form } = setup()
    fireEvent.click(button('编辑 可复用流程'))
    const f = dialog('编辑类型')
    expect(within(f).getByLabelText('中文名')).toHaveValue('可复用流程')
    expect(within(f).getByLabelText('英文名')).toHaveValue('procedure')
    expect(within(f).getByLabelText('英文名')).toHaveAttribute('readonly')
    fireEvent.change(within(f).getByLabelText('衰退天数'), { target: { value: '60' } })
    fireEvent.click(button('确定', f))
    expect(within(typeRow('可复用流程')).getByText('已改')).toBeInTheDocument()
    expect(button('可复用流程恢复默认', typeRow('可复用流程'))).toBeInTheDocument()
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['预设类型：修改「可复用流程」'])
    fireEvent.click(button('取消', dialog('保存这些改动？')))
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['customTypes', 'procedure'], value: edited }])
  })

  it('改过的预设点恢复默认：去掉改动，保存时 unset 同名 customTypes', async () => {
    const { form } = setup({ value: { customTypes: { procedure: edited } } })
    expect(within(typeRow('可复用流程')).getByText('已改')).toBeInTheDocument()
    fireEvent.click(button('可复用流程恢复默认'))
    expect(within(typeRow('可复用流程')).queryByText('已改')).toBeNull()
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['预设类型：恢复默认「可复用流程」'])
    fireEvent.click(button('取消', dialog('保存这些改动？')))
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'unset', path: ['customTypes', 'procedure'] }])
  })

  it('编辑预设改回和出厂一样：等于恢复默认', async () => {
    const { form } = setup({ value: { customTypes: { procedure: edited } } })
    fireEvent.click(button('编辑 可复用流程'))
    fireEvent.change(within(dialog('编辑类型')).getByLabelText('衰退天数'), { target: { value: '90' } })
    fireEvent.click(button('确定', dialog('编辑类型')))
    expect(within(typeRow('可复用流程')).queryByText('已改')).toBeNull()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'unset', path: ['customTypes', 'procedure'] }])
  })

  it('删除预设：原位确认、从场景里去掉；卡换成「已删除」一行，编码不算改过；保存写 removedPresetTypes', async () => {
    const { form } = setup({ memories: [] })
    fireEvent.click(button('删除 可复用流程'))
    expect(within(typeRow('可复用流程')).getByText('删除「可复用流程」？编码在用，会一起去掉。')).toBeInTheDocument()
    fireEvent.click(button('删除', typeRow('可复用流程')))
    expect(typeTitles('预设')).toEqual(['决定'])
    expect(within(typesRegion()).getByText('已删除：可复用流程')).toBeInTheDocument()
    expect(radio('编码')).toHaveAccessibleDescription('通用五类')
    expect(within(radio('编码').closest('li')!).queryByText('已改')).toBeNull()
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['场景：修改「编码」', '预设类型：删除「可复用流程」'])
    fireEvent.click(button('取消', dialog('保存这些改动？')))
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([
      { op: 'set', path: ['removedPresetTypes'], value: ['procedure'] },
      { op: 'set', path: ['scenes', 'coding'], value: { label: '编码', types: GENERAL } },
    ])
  })

  it('恢复预设：回到预设组、用出厂定义；删除时选的移到最近删除一并撤销，场景不自动勾回', async () => {
    const { form } = setup({ memories: ['decision'] })
    fireEvent.click(button('删除 决定'))
    fireEvent.click(button('移到最近删除', typeRow('决定')))
    fireEvent.click(button('恢复 决定'))
    expect(typeTitles('预设')).toEqual(['可复用流程', '决定'])
    expect(within(typesRegion()).queryByText(/^已删除/)).toBeNull()
    expect(within(radio('办公').closest('li')!).getByText('已改')).toBeInTheDocument()
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['场景：修改「办公」'])
    fireEvent.click(button('取消', dialog('保存这些改动？')))
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([{ op: 'set', path: ['scenes', 'office'], value: { label: '办公', types: GENERAL } }])
  })

  it('配置里删掉的预设：卡片不出现，恢复后保存写回空列表；编码点恢复默认勾回', async () => {
    const { form } = setup({ value: { removedPresetTypes: ['procedure'], scenes: { coding: { label: '编码', types: GENERAL }, office: { label: '办公', types: [...GENERAL, 'decision'] } } } })
    expect(within(radio('编码').closest('li')!).queryByText('已改')).toBeNull()
    fireEvent.click(button('恢复 可复用流程'))
    fireEvent.click(button('编码恢复默认'))
    expect(radio('编码')).toHaveAccessibleDescription('通用五类 + 可复用流程')
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([
      { op: 'set', path: ['removedPresetTypes'], value: [] },
      { op: 'set', path: ['scenes', 'coding'], value: { label: '编码', types: [...GENERAL, 'procedure'] } },
    ])
  })

  it('类型卡原位确认收起后焦点不丢：取消回到「删除」，删掉回到组标题，恢复落到恢复的那张卡', () => {
    setup({ memories: [] })
    fireEvent.click(button('删除 决定'))
    fireEvent.click(button('取消', typeRow('决定')))
    expect(button('删除 决定')).toHaveFocus()
    fireEvent.click(button('删除 决定'))
    fireEvent.keyDown(button('取消', typeRow('决定')), { key: 'Escape' })
    expect(button('删除 决定')).toHaveFocus()
    fireEvent.click(button('删除 决定'))
    fireEvent.click(button('删除', typeRow('决定')))
    expect(within(typesRegion()).getByRole('heading', { name: '预设' })).toHaveFocus()
    fireEvent.click(button('恢复 决定'))
    expect(button('编辑 决定')).toHaveFocus()
  })

  it('删场景时取消：焦点回到这张场景卡的「删除」', () => {
    setup()
    fireEvent.click(button('删除场景 编码'))
    fireEvent.click(button('取消', radio('编码').closest('li')!))
    expect(button('删除场景 编码')).toHaveFocus()
  })

  it('删掉场景：焦点落到「场景」小标题，不掉回页首', () => {
    setup()
    fireEvent.click(button('删除场景 编码'))
    fireEvent.click(button('删除', radio('编码').closest('li')!))
    expect(screen.queryByRole('radio', { name: '编码' })).toBeNull()
    expect(screen.getByRole('heading', { name: '场景' })).toHaveFocus()
  })

  it('场景弹层里删类型：取消回到这一行的「删除」，删掉后落到「新建类型」', () => {
    setup({ value: { customTypes: { term }, scenes: { coding: { label: '编码', types: [...GENERAL, 'term'] }, office: { label: '办公', types: [...GENERAL, 'decision'] } } } })
    fireEvent.click(button('编辑场景 编码'))
    const d = dialog('编辑场景')
    const confirm = () => within(d).getByRole('group', { name: /^删除「术语」/ })
    fireEvent.click(button('删除 术语', d))
    fireEvent.click(button('取消', confirm()))
    expect(button('删除 术语', d)).toHaveFocus()
    fireEvent.click(button('删除 术语', d))
    fireEvent.click(button('删除', confirm()))
    expect(button('＋ 新建类型', d)).toHaveFocus()
  })

  it('新建类型用了已删的预设英文名：提示在预设里恢复', () => {
    setup({ value: { removedPresetTypes: ['decision'] } })
    fireEvent.click(button('新建类型'))
    const f = dialog('新建类型')
    fillType(f, { label: '决策', name: 'decision' })
    fireEvent.click(button('确定', f))
    expect(within(f).getByText('这是已删除的预设类型，在预设里点「恢复」就能用。')).toBeInTheDocument()
  })

  it('场景弹层：改过的预设留在预设组、显示改过的名字，删掉的不出现', () => {
    setup({ value: { customTypes: { procedure: { ...edited, label: '我的流程' } }, removedPresetTypes: ['decision'] } })
    fireEvent.click(button('编辑场景 编码'))
    const f = dialog('编辑场景')
    const preset = within(f).getByRole('group', { name: '预设' })
    expect(within(preset).getAllByRole('checkbox').map(el => el.closest('div')!.textContent)).toEqual(['我的流程'])
    expect(within(within(f).getByRole('group', { name: '我加的（所有场景共用）' })).queryAllByRole('checkbox')).toEqual([])
  })
})

describe('改名与删除：已有记忆怎么办', () => {
  const pool = { customTypes: { 'domain-term': term, client }, scenes: { coding: { label: '编码', types: [...GENERAL, 'domain-term'] }, office: { label: '办公', types: [...GENERAL, 'client'] } } }

  it('没存过记忆的类型直接改名，场景组成跟着换', async () => {
    const { form, gateway } = setup({ value: pool })
    fireEvent.click(button('编辑 术语'))
    fireEvent.change(within(dialog('编辑类型')).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', dialog('编辑类型')))
    expect(screen.queryByRole('dialog')).toBeNull()
    await clickSave(form)
    expect(form.calls[0]!.ops).toEqual([
      { op: 'set', path: ['customTypes', 'glossary'], value: term },
      { op: 'unset', path: ['customTypes', 'domain-term'] },
      { op: 'set', path: ['scenes', 'coding'], value: { label: '编码', types: [...GENERAL, 'glossary'] } },
    ])
    expect(gateway.executed).toEqual([])
  })

  it('存过记忆的改名先二选一；跟着改名在保存时先写配置、再迁移', async () => {
    const { form, gateway } = setup({ value: pool, memories: ['domain-term', 'domain-term'] })
    fireEvent.click(button('编辑 术语'))
    const f = dialog('编辑类型')
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', f))
    expect(within(f).getByText('「术语」存过 2 条记忆，改名后：')).toBeInTheDocument()
    fireEvent.click(button('跟着改名', f))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['场景：修改「编码」', '「术语」改名为 glossary，2 条记忆跟着改'])
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    await waitFor(() => { expect(gateway.executed).toHaveLength(1) })
    expect(form.calls).toHaveLength(1)
    expect(gateway.executed[0]!.command).toEqual({ cmd: 'migrate-type', from: 'domain-term', action: 'retype', to: 'glossary' })
  })

  it('改名时问旧记忆怎么办：焦点在「取消」；Esc 只收起这一问，表单和改了的英文名都还在', () => {
    setup({ value: pool, memories: ['domain-term'] })
    fireEvent.click(button('编辑 术语'))
    const f = dialog('编辑类型')
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', f))
    expect(button('取消', f)).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(dialog('编辑类型')).toBeInTheDocument()
    expect(within(f).queryByRole('button', { name: '跟着改名' })).toBeNull()
    expect(within(f).getByLabelText('英文名')).toHaveValue('glossary')
  })

  it('删掉当前场景里的类型：选移到最近删除时，确认框不写已有的仍会带入；选保留记忆时照写', () => {
    const removeTerm = (choice: string) => {
      fireEvent.click(button('删除 术语'))
      fireEvent.click(button(choice, typeRow('术语')))
      fireEvent.click(button('保存'))
    }
    const first = setup({ value: pool, memories: ['domain-term'] })
    removeTerm('移到最近删除')
    expect(within(dialog('保存这些改动？')).queryByText(/不再新增「术语」/)).toBeNull()
    first.unmount()
    setup({ value: pool, memories: ['domain-term'] })
    removeTerm('保留记忆')
    expect(within(dialog('保存这些改动？')).getByText('保存后不再新增「术语」类记忆，已有的仍会带入、能搜到。')).toBeInTheDocument()
  })

  it('删除时写明别的场景也在用；存过记忆的二选一，移到最近删除在保存后执行，含密钥的单独提示', async () => {
    const { form, gateway } = setup({
      value: pool, memories: ['client'],
      respond: command => ({ ok: true, cmd: command.cmd, migrated: 0, skippedSecrets: 1 }),
    })
    fireEvent.click(button('编辑场景 编码'))
    const d = dialog('编辑场景')
    fireEvent.click(button('删除 客户名', d))
    expect(within(d).getByText('删除「客户名」？办公也在用，会一起去掉。存过 1 条记忆。')).toBeInTheDocument()
    expect(button('保留记忆', d)).toBeEnabled()
    fireEvent.click(button('移到最近删除', d))
    fireEvent.click(button('确定', d))
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['场景：修改「办公」', '我加的类型：删除「客户名」', '「客户名」在用的记忆移到最近删除'])
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    await waitFor(() => { expect(gateway.executed).toHaveLength(1) })
    expect(gateway.executed[0]!.command).toEqual({ cmd: 'migrate-type', from: 'client', action: 'forget' })
    expect(form.value.scenes).toMatchObject({ office: { types: GENERAL } })
    expect(await screen.findByText('1 条含密钥的记忆没有移到最近删除，去记忆页处理。')).toBeInTheDocument()
  })

  it('删掉会让别的场景一类不剩时不给删，原位提示', () => {
    setup({ value: { ...pool, scenes: { ...pool.scenes, 'scene-1': { label: '写作', types: ['client'] } } } })
    fireEvent.click(button('删除 客户名'))
    expect(within(typeRow('客户名')).getByText('「写作」只剩这一类，先给它加别的类型再删。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保留记忆' })).toBeNull()
  })

  it('迁移失败时提示配置已保存、可以重试；重试只发还没做完的', async () => {
    let fails = true
    const { form, gateway } = setup({
      value: pool, memories: ['domain-term'],
      respond: command => fails ? { ok: false, cmd: command.cmd, code: 'failed', message: 'x' } as never : { ok: true, cmd: command.cmd, migrated: 1 },
    })
    fireEvent.click(button('编辑 术语'))
    fireEvent.change(within(dialog('编辑类型')).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', dialog('编辑类型')))
    fireEvent.click(button('跟着改名', dialog('编辑类型')))
    await clickSave(form)
    expect(await screen.findByText('配置已保存，有记忆没迁过去。')).toBeInTheDocument()
    fails = false
    await act(async () => { fireEvent.click(button('重试')) })
    await waitFor(() => { expect(screen.queryByText('配置已保存，有记忆没迁过去。')).toBeNull() })
    expect(gateway.executed.map(e => e.command)).toEqual([
      { cmd: 'migrate-type', from: 'domain-term', action: 'retype', to: 'glossary' },
      { cmd: 'migrate-type', from: 'domain-term', action: 'retype', to: 'glossary' },
    ])
  })

  it('有会话但条数还没读到：按存过记忆处理，选跟着改名照样记下迁移、保存后执行', async () => {
    const { form, gateway } = setup({ value: pool, isLibraryLoading: true })
    fireEvent.click(button('编辑 术语'))
    const f = dialog('编辑类型')
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', f))
    expect(within(f).getByText('「术语」可能存过记忆，改名后：')).toBeInTheDocument()
    fireEvent.click(button('跟着改名', f))
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['场景：修改「编码」', '「术语」改名为 glossary，已有记忆跟着改'])
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    await waitFor(() => { expect(gateway.executed).toHaveLength(1) })
    expect(form.calls).toHaveLength(1)
    expect(gateway.executed[0]!.command).toEqual({ cmd: 'migrate-type', from: 'domain-term', action: 'retype', to: 'glossary' })
  })

  it('改名跟着改之后又删掉、选保留记忆：记忆留在原名下，不迁移；确认框写删除', async () => {
    const { form, gateway } = setup({ value: pool, memories: ['domain-term'] })
    fireEvent.click(button('编辑 术语'))
    const f = dialog('编辑类型')
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', f))
    fireEvent.click(button('跟着改名', f))
    fireEvent.click(button('删除 术语'))
    fireEvent.click(button('保留记忆', typeRow('术语')))
    fireEvent.click(button('保存'))
    expect(confirmLines()).toEqual(['场景：修改「编码」', '我加的类型：删除「术语」'])
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    await waitFor(() => { expect(form.calls).toHaveLength(1) })
    expect(gateway.executed).toEqual([])
  })

  it('迁移失败后没点重试、又改了别的设置保存：没做完的迁移随这次保存再执行', async () => {
    let fails = true
    const { form, gateway } = setup({
      value: pool, memories: ['domain-term'],
      respond: command => fails ? { ok: false, cmd: command.cmd, code: 'failed', message: 'x' } as never : { ok: true, cmd: command.cmd, migrated: 1 },
    })
    fireEvent.click(button('编辑 术语'))
    fireEvent.change(within(dialog('编辑类型')).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', dialog('编辑类型')))
    fireEvent.click(button('跟着改名', dialog('编辑类型')))
    await clickSave(form)
    expect(await screen.findByText('配置已保存，有记忆没迁过去。')).toBeInTheDocument()
    fails = false
    fireEvent.click(radio('办公'))
    fireEvent.click(button('保存'))
    expect(confirmLines()).toContain('「术语」改名为 glossary，1 条记忆跟着改')
    await act(async () => { fireEvent.click(button('保存', dialog('保存这些改动？'))) })
    await waitFor(() => { expect(gateway.executed).toHaveLength(2) })
    await waitFor(() => { expect(screen.queryByText('配置已保存，有记忆没迁过去。')).toBeNull() })
    expect(gateway.executed[1]!.command).toEqual({ cmd: 'migrate-type', from: 'domain-term', action: 'retype', to: 'glossary' })
  })

  it('没有会话时：迁移选项置灰并说明，条数读不到按存过记忆处理；保留记忆照常能删', () => {
    setup({ value: pool, hasSession: false })
    fireEvent.click(button('编辑 术语'))
    const f = dialog('编辑类型')
    fireEvent.change(within(f).getByLabelText('英文名'), { target: { value: 'glossary' } })
    fireEvent.click(button('确定', f))
    expect(within(f).getByText('「术语」可能存过记忆，改名后：')).toBeInTheDocument()
    expect(within(f).getByText('开一个会话后才能处理已有记忆。')).toBeInTheDocument()
    expect(button('跟着改名', f)).toBeDisabled()
    expect(button('移到最近删除', f)).toBeDisabled()
    fireEvent.click(button('取消', f))
    fireEvent.click(button('取消', dialog('编辑类型')))
    fireEvent.click(button('删除 术语'))
    const row = typeRow('术语')
    expect(within(row).getByText('删除「术语」？编码在用，会一起去掉。可能存过记忆。')).toBeInTheDocument()
    expect(within(row).getByText('开一个会话后才能处理已有记忆。')).toBeInTheDocument()
    expect(button('移到最近删除', row)).toBeDisabled()
    expect(button('保留记忆', row)).toBeEnabled()
  })
})

describe('类型显示名', () => {
  it('PA-20：改过名的预设类型显示配置里的名字（和右侧栏、记忆查看同名）', () => {
    setup({ value: { customTypes: { procedure: { ...TYPE_DEFINITIONS.procedure, label: '发版手册' } } } })
    expect(typeTitles('预设')).toEqual(['发版手册', '决定'])
  })

  it('PA-20：英文界面下内置、预设类型写英文名', () => {
    render(<PanelShell gateway={createFakeGateway({ views: { library: library([]) } })} t={createTranslator(en)}><SettingsPage form={createFakeConfigForm()} onOpenMemoryPage={() => {}} now={NOW} /></PanelShell>)
    const region = screen.getByRole('region', { name: 'Memory types' })
    const titles = [...region.querySelectorAll('.pm-tile-title')].map(el => el.textContent)
    expect(titles).toEqual(['Profile', 'Preference', 'Facts & lessons', 'Project', 'Reference', 'Procedure', 'Decision'])
  })
})

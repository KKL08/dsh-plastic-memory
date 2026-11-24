// 模型选择器：「跟随」在第一项，按提供方分组列模型；选中的模型有推理强度时才出强度下拉；列表为空给说明；当前选的已经不在列表里时照样显示出来。
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import type { ModelChoices, ModelSelection } from '../../src/gui/contract.ts'
import { createTranslator } from '../i18n.tsx'
import { en } from '../locales.ts'
import { renderInShell } from '../test-utils.tsx'
import { ModelPicker } from './ModelPicker.tsx'

const CHOICES: ModelChoices = [
  {
    id: 'deepseek-official', name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek Flash', efforts: [] },
      { id: 'deepseek-pro', name: 'DeepSeek Pro', efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' },
    ],
  },
  { id: 'provider-x', name: 'Provider X', models: [{ id: 'model-x', name: 'Model X', efforts: [] }] },
]

/** choices 给 loading 时按还在读（undefined）传：直接传 undefined 会落到默认参数上。 */
function setup(value: ModelSelection | null, choices: ModelChoices | 'loading' = CHOICES, disabled = false) {
  const onChange = vi.fn<(next: ModelSelection | null) => void>()
  renderInShell(<ModelPicker id="m" label="用的模型" followLabel="跟随默认模型" value={value} choices={choices === 'loading' ? undefined : choices} disabled={disabled} onChange={onChange} />)
  return { onChange, model: () => screen.getByRole('combobox', { name: '用的模型' }) }
}

const groupLabels = (select: HTMLElement) => [...select.querySelectorAll('optgroup')].map(g => g.label)
const optionTexts = (select: HTMLElement) => [...select.querySelectorAll('option')].map(o => o.textContent)
const selectedText = (select: HTMLElement) => (select as HTMLSelectElement).selectedOptions[0]?.textContent

describe('模型选择器', () => {
  it('第一项是「跟随」，其后按提供方分组列出模型', () => {
    const { model } = setup(null)
    expect(optionTexts(model())).toEqual(['跟随默认模型', 'DeepSeek Flash', 'DeepSeek Pro', 'Model X'])
    expect(groupLabels(model())).toEqual(['DeepSeek', 'Provider X'])
    expect(within(model().querySelectorAll('optgroup')[1] as HTMLElement).getAllByRole('option').map(o => o.textContent)).toEqual(['Model X'])
    expect(selectedText(model())).toBe('跟随默认模型')
  })

  it('选一个模型交出提供方和模型，不带推理强度；改回「跟随」交出 null', () => {
    const { model, onChange } = setup(null)
    const options = model().querySelectorAll('option')
    fireEvent.change(model(), { target: { value: (options[3] as HTMLOptionElement).value } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'provider-x', model: 'model-x' })
    fireEvent.change(model(), { target: { value: (options[0] as HTMLOptionElement).value } })
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('选中的模型有推理强度时才出强度下拉：第一项是模型默认（写出默认是哪档），选一档交出带强度的选择', () => {
    const { onChange } = setup({ provider: 'deepseek-official', model: 'deepseek-pro' })
    const effort = screen.getByRole('combobox', { name: '推理强度' })
    expect(optionTexts(effort)).toEqual(['模型默认（高）', '低', '高'])
    expect(selectedText(effort)).toBe('模型默认（高）')
    fireEvent.change(effort, { target: { value: 'low' } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'low' })
  })

  it('已选的推理强度显示为当前值；改回模型默认交出不带强度的选择', () => {
    const { onChange } = setup({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'low' })
    const effort = screen.getByRole('combobox', { name: '推理强度' })
    expect(selectedText(effort)).toBe('低')
    fireEvent.change(effort, { target: { value: (effort.querySelector('option') as HTMLOptionElement).value } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'deepseek-official', model: 'deepseek-pro' })
  })

  it('换模型时推理强度回到模型默认', () => {
    const { model, onChange } = setup({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'low' })
    fireEvent.change(model(), { target: { value: (model().querySelectorAll('option')[1] as HTMLOptionElement).value } })
    expect(onChange).toHaveBeenLastCalledWith({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('跟随或选中的模型没有推理强度时不出强度下拉', () => {
    setup(null)
    expect(screen.queryByRole('combobox', { name: '推理强度' })).toBeNull()
  })

  it('没有推理强度的模型也不出强度下拉', () => {
    setup({ provider: 'provider-x', model: 'model-x' })
    expect(screen.queryByRole('combobox', { name: '推理强度' })).toBeNull()
  })

  it('列表为空：只剩「跟随」，并说明要先在 DeepSeek Harness 里添加提供方或登录', () => {
    const { model } = setup(null, [])
    expect(optionTexts(model())).toEqual(['跟随默认模型'])
    expect(screen.getByText(/DeepSeek Harness 里还没有能选的模型/)).toBeInTheDocument()
  })

  it('列表还在读：不写为空的说明', () => {
    setup(null, 'loading')
    expect(screen.queryByText(/还没有能选的模型/)).toBeNull()
  })

  it('当前选的模型已经不在列表里：照样显示为当前值并标明现在用不了，推理强度不出', () => {
    const { model } = setup({ provider: 'gone', model: 'old-model', reasoningEffort: 'high' })
    expect(selectedText(model())).toBe('old-model（现在用不了）')
    expect(screen.queryByRole('combobox', { name: '推理强度' })).toBeNull()
  })

  it('保存的推理强度模型已经不支持：强度下拉显示这一档并标明现在用不了；重新选一档后标注消失', () => {
    function Live() {
      const [value, setValue] = useState<ModelSelection | null>({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'max' })
      return <ModelPicker id="m" label="用的模型" followLabel="跟随默认模型" value={value} choices={CHOICES} onChange={setValue} />
    }
    renderInShell(<Live />)
    const effort = () => screen.getByRole('combobox', { name: '推理强度' })
    expect(optionTexts(effort())).toEqual(['模型默认（高）', 'max（现在用不了）', '低', '高'])
    expect(selectedText(effort())).toBe('max（现在用不了）')
    fireEvent.change(effort(), { target: { value: 'low' } })
    expect(selectedText(effort())).toBe('低')
    expect(optionTexts(effort())).toEqual(['模型默认（高）', '低', '高'])
  })

  it('保存的推理强度模型已经不支持：改回模型默认后标注消失', () => {
    function Live() {
      const [value, setValue] = useState<ModelSelection | null>({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'max' })
      return <ModelPicker id="m" label="用的模型" followLabel="跟随默认模型" value={value} choices={CHOICES} onChange={setValue} />
    }
    renderInShell(<Live />)
    const effort = () => screen.getByRole('combobox', { name: '推理强度' })
    fireEvent.change(effort(), { target: { value: (effort().querySelector('option') as HTMLOptionElement).value } })
    expect(selectedText(effort())).toBe('模型默认（高）')
    expect(screen.queryByText(/现在用不了/)).toBeNull()
  })

  it('模型已经没有推理强度、保存里还有：照样出强度下拉，显示保存的那档并标明现在用不了；改回模型默认后下拉收起', () => {
    function Live() {
      const [value, setValue] = useState<ModelSelection | null>({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })
      return <ModelPicker id="m" label="用的模型" followLabel="跟随默认模型" value={value} choices={CHOICES} onChange={setValue} />
    }
    renderInShell(<Live />)
    const effort = screen.getByRole('combobox', { name: '推理强度' })
    expect(optionTexts(effort)).toEqual(['模型默认', 'high（现在用不了）'])
    expect(selectedText(effort)).toBe('high（现在用不了）')
    fireEvent.change(effort, { target: { value: (effort.querySelector('option') as HTMLOptionElement).value } })
    expect(screen.queryByRole('combobox', { name: '推理强度' })).toBeNull()
    expect(selectedText(screen.getByRole('combobox', { name: '用的模型' }))).toBe('DeepSeek Flash')
  })

  it('推理强度失效的英文文案', () => {
    expect(createTranslator(en)('settings.model.effortUnavailable', { effort: 'max' })).toBe('max (unavailable now)')
  })

  it('列表还在读或没读到：选过的模型照样显示为当前值，不标成现在用不了', () => {
    const { model } = setup({ provider: 'provider-x', model: 'model-x' }, 'loading')
    expect(selectedText(model())).toBe('model-x')
  })

  it('选过的模型属于这次没读到的提供方：不标成现在用不了，那个提供方不出分组', () => {
    const { model } = setup({ provider: 'provider-x', model: 'model-x' }, [CHOICES[0]!, { id: 'provider-x', name: 'Provider X', models: [], listFailed: true }])
    expect(selectedText(model())).toBe('model-x')
    expect(groupLabels(model())).toEqual(['DeepSeek'])
  })

  it('列表里只有没读到的提供方：不写 DeepSeek Harness 里没有模型的说明', () => {
    setup(null, [{ id: 'provider-x', name: 'Provider X', models: [], listFailed: true }])
    expect(screen.queryByText(/还没有能选的模型/)).toBeNull()
  })

  it('置灰时两个下拉都不能改', () => {
    const { model } = setup({ provider: 'deepseek-official', model: 'deepseek-pro' }, CHOICES, true)
    expect(model()).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '推理强度' })).toBeDisabled()
  })
})

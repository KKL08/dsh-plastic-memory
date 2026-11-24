/**
 * 模型选择器：第一项「跟随」（叫法由调用方给，自动体检跟随默认模型、梦境跟随自动体检），其后按提供方分组列出模型；
 * 选中的模型有推理强度（或存的推理强度已经失效）时，右边再出一个强度下拉，第一项是模型默认。只管显示和交出选择，存到哪、什么时候存由调用方定。
 */
import type { ChangeEvent } from 'react'
import type { ModelChoices, ModelSelection } from '../../src/gui/contract.ts'
import { useT } from '../i18n.tsx'

const FOLLOW = ''
const optionValue = (provider: string, model: string) => JSON.stringify([provider, model])

export function ModelPicker({ id, label, followLabel, value, choices, disabled = false, onChange }: {
  id: string
  /** 模型下拉的无障碍名（页面上的标签由设置项画）。 */
  label: string
  followLabel: string
  /** 当前的选择；null = 跟随。 */
  value: ModelSelection | null
  /** 能选的模型；undefined = 还在读或读不到。带 listFailed 的提供方这次没读到（说明由调用方写）。 */
  choices: ModelChoices | undefined
  disabled?: boolean
  onChange: (next: ModelSelection | null) => void
}) {
  const t = useT()
  const provider = value === null ? undefined : choices?.find(p => p.id === value.provider)
  const current = value === null ? undefined : provider?.models.find(m => m.id === value.model)
  // 列表还在读、没读到，或选的提供方这次没读到：在不在确认不了，照样显示为当前值，不标失效
  const isUnread = value !== null && (choices === undefined || provider?.listFailed === true)
  // 选过的模型已经不在列表里（提供方删了、下架了、没登录）：照样显示出来，标明现在用不了
  const isMissing = value !== null && !isUnread && current === undefined
  const listed = (choices ?? []).filter(p => p.listFailed !== true)
  const onModel = (event: ChangeEvent<HTMLSelectElement>) => {
    if (event.target.value === FOLLOW) { onChange(null); return }
    const [provider, model] = JSON.parse(event.target.value) as [string, string]
    onChange({ provider, model })
  }
  const onEffort = (event: ChangeEvent<HTMLSelectElement>) => {
    if (value === null) return
    const { reasoningEffort: _previous, ...rest } = value
    onChange(event.target.value === FOLLOW ? rest : { ...rest, reasoningEffort: event.target.value })
  }
  const defaultEffort = current?.efforts.find(e => e.id === current.defaultEffort)
  // 存的推理强度模型已经不支持（档位改了，或模型不再有推理强度）：后台每次都会退回默认模型，照样显示出来、标明现在用不了
  const goneEffort = current !== undefined && value?.reasoningEffort !== undefined && !current.efforts.some(e => e.id === value.reasoningEffort)
    ? value.reasoningEffort
    : undefined

  return (
    <>
      <div className="pm-model-picker">
        <select
          id={id}
          aria-label={label}
          className="pm-input pm-select"
          value={value === null ? FOLLOW : optionValue(value.provider, value.model)}
          disabled={disabled}
          onChange={onModel}
        >
          <option value={FOLLOW}>{followLabel}</option>
          {isUnread ? <option value={optionValue(value.provider, value.model)}>{value.model}</option> : null}
          {isMissing ? <option value={optionValue(value.provider, value.model)}>{t('settings.model.unavailable', { model: value.model })}</option> : null}
          {listed.map(provider => (
            <optgroup key={provider.id} label={provider.name}>
              {provider.models.map(model => <option key={model.id} value={optionValue(provider.id, model.id)}>{model.name}</option>)}
            </optgroup>
          ))}
        </select>
        {current !== undefined && (current.efforts.length > 0 || goneEffort !== undefined)
          ? (
            <select
              aria-label={t('settings.model.effort')}
              className="pm-input pm-select"
              value={value?.reasoningEffort ?? FOLLOW}
              disabled={disabled}
              onChange={onEffort}
            >
              <option value={FOLLOW}>{defaultEffort === undefined ? t('settings.model.effortDefault') : t('settings.model.effortDefaultNamed', { name: defaultEffort.name })}</option>
              {goneEffort !== undefined ? <option value={goneEffort}>{t('settings.model.effortUnavailable', { effort: goneEffort })}</option> : null}
              {current.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
            </select>
          )
          : null}
      </div>
      {choices !== undefined && choices.length === 0 ? <p className="pm-setting-hint">{t('settings.model.empty')}</p> : null}
    </>
  )
}

export const modelPickerCss = `
.pm-model-picker { display: flex; flex-wrap: wrap; gap: 8px; width: 100%; }
.pm-select { width: auto; min-width: 0; max-width: 100%; padding-right: 8px; }
`

/**
 * 自建类型的表单视图：场景弹层、类型管理视图里换上的那一屏（不叠第二层弹窗），状态由弹层持有（Scenes.tsx）。
 * 字段按 schema 全给：中文名、英文名、说明、什么时候记必填，怎么召回、治理优先级预选「搜索」「中」，衰退天数可空。
 * 英文名可以改：存过记忆的，改名时由弹层问旧记忆怎么办（跟着改名 / 移到最近删除）。
 */
import { useId } from 'react'
import { useT } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { SegmentedControl } from '../ui/Segmented.tsx'
import { PRIORITIES, RECALL_MODES, type CustomTypeDraft, type CustomTypeError } from './config.ts'
import { TextField } from './controls.tsx'

const ERROR_KEY: Record<CustomTypeError, LocaleKey> = {
  'required': 'settings.type.error.required',
  'name-format': 'settings.type.error.name-format',
  'name-builtin': 'settings.type.error.name-builtin',
  'name-taken': 'settings.type.error.name-taken',
  'name-pending': 'settings.type.error.name-pending',
  'label-taken': 'settings.type.error.label-taken',
  'decay-invalid': 'settings.type.error.decay-invalid',
}

/** @param errors 第一次点「确定」之后才给，之前只显示说明。 */
export function TypeFormFields({ draft, errors, onChange }: {
  draft: CustomTypeDraft
  errors: Partial<Record<keyof CustomTypeDraft, CustomTypeError>> | undefined
  onChange: (patch: Partial<CustomTypeDraft>) => void
}) {
  const t = useT()
  const id = useId()
  const errorOf = (field: keyof CustomTypeDraft): string | undefined => {
    const code = errors?.[field]
    return code === undefined ? undefined : t(ERROR_KEY[code], { label: draft.label.trim() })
  }
  const field = (key: 'label' | 'name' | 'description' | 'whenToSave' | 'decayDays', labelKey: LocaleKey, hintKey: LocaleKey, extra: { multiline?: boolean; inputMode?: 'numeric' } = {}) => (
    <div className="pm-field">
      <label className="pm-setting-label" htmlFor={`${id}-${key}`}>{t(labelKey)}</label>
      <TextField id={`${id}-${key}`} value={draft[key]} onChange={(text) => { onChange({ [key]: text }) }} error={errorOf(key)} hint={t(hintKey)} {...extra} />
    </div>
  )
  const choice = <K extends 'recall' | 'governancePriority'>(key: K, labelKey: LocaleKey, hintKey: LocaleKey, values: readonly NonNullable<CustomTypeDraft[K]>[], optionKey: (v: string) => LocaleKey) => {
    const error = errorOf(key)
    return (
      <div className="pm-field">
        <span className="pm-setting-label" id={`${id}-${key}-label`}>{t(labelKey)}</span>
        <SegmentedControl<CustomTypeDraft[K]>
          id={`${id}-${key}`}
          label={t(labelKey)}
          value={draft[key]}
          options={values.map(v => ({ value: v, label: t(optionKey(v)) }))}
          onChange={(next) => { onChange({ [key]: next } as Partial<CustomTypeDraft>) }}
        />
        {error !== undefined ? <p className="pm-input-invalid" role="status">{error}</p> : <p className="pm-setting-hint">{t(hintKey)}</p>}
      </div>
    )
  }
  return (
    <>
      {field('label', 'settings.type.label', 'settings.type.labelHint')}
      {field('name', 'settings.type.name', 'settings.type.nameHint')}
      {field('description', 'settings.type.description', 'settings.type.descriptionHint', { multiline: true })}
      {field('whenToSave', 'settings.type.whenToSave', 'settings.type.whenToSaveHint', { multiline: true })}
      {choice('recall', 'settings.type.recall', 'settings.type.recallHint', RECALL_MODES, v => `settings.type.recall.${v}` as LocaleKey)}
      {choice('governancePriority', 'settings.type.priority', 'settings.type.priorityHint', PRIORITIES, v => `settings.type.priority.${v}` as LocaleKey)}
      {field('decayDays', 'settings.type.decayDays', 'settings.type.decayDaysHint', { inputMode: 'numeric' })}
    </>
  )
}

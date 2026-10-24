/**
 * 「我加的类型」：列表（中文名 · 英文名 · 召回方式）+ 增删改弹层。改动进设置页的暂存草稿，点页面的保存才写。
 * 弹层字段按 schema 全给：中文名、英文名、说明、什么时候记、怎么召回、治理优先级必填，过期天数可空；
 * 英文名是记忆文件里的类型标识，保存后不能改（编辑时只读）。
 */
import { useId, useState } from 'react'
import { useT } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import { SegmentedControl } from '../ui/Segmented.tsx'
import {
  EMPTY_TYPE_DRAFT, PRIORITIES, RECALL_MODES, draftOf, validateTypeDraft,
  type CustomType, type CustomTypeDraft, type CustomTypeError,
} from './config.ts'
import { Dialog, TextField } from './controls.tsx'

type Editing = { kind: 'add' } | { kind: 'edit'; name: string }

export function CustomTypeList({ types, disabled, onChange }: {
  types: Record<string, CustomType>
  disabled: boolean
  onChange: (next: Record<string, CustomType>) => void
}) {
  const t = useT()
  const [editing, setEditing] = useState<Editing | undefined>(undefined)
  const names = Object.keys(types)
  const remove = (name: string) => {
    const { [name]: _removed, ...rest } = types
    onChange(rest)
  }
  return (
    <>
      {names.length === 0
        ? <p className="pm-setting-hint">{t('settings.types.empty')}</p>
        : (
          <ul className="pm-types">
            {names.map((name) => {
              const type = types[name]!
              return (
                <li key={name} className="pm-type-row">
                  <span className="pm-type-label">{type.label}</span>
                  <code className="pm-type-name">{name}</code>
                  <span className="pm-type-meta">{t(`settings.type.recall.${type.recall}`)}</span>
                  <span className="pm-type-actions">
                    <Button variant="quiet" disabled={disabled} aria-label={t('settings.types.editAria', { name: type.label })}
                      onClick={() => { setEditing({ kind: 'edit', name }) }}>{t('settings.types.edit')}</Button>
                    <Button variant="quiet" disabled={disabled} aria-label={t('settings.types.removeAria', { name: type.label })}
                      onClick={() => { remove(name) }}>{t('settings.types.remove')}</Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      <Button disabled={disabled} onClick={() => { setEditing({ kind: 'add' }) }}>{t('settings.types.add')}</Button>
      {editing !== undefined
        ? (
          <CustomTypeDialog
            initial={editing.kind === 'edit' ? draftOf(editing.name, types[editing.name]!) : EMPTY_TYPE_DRAFT}
            editing={editing.kind === 'edit'}
            taken={names.filter(n => editing.kind === 'add' || n !== editing.name)}
            onCancel={() => { setEditing(undefined) }}
            onConfirm={(name, type) => { setEditing(undefined); onChange({ ...types, [name]: type }) }}
          />
        )
        : null}
    </>
  )
}

const ERROR_KEY: Record<CustomTypeError, LocaleKey> = {
  'required': 'settings.type.error.required',
  'name-format': 'settings.type.error.name-format',
  'name-builtin': 'settings.type.error.name-builtin',
  'name-taken': 'settings.type.error.name-taken',
  'decay-invalid': 'settings.type.error.decay-invalid',
}

function CustomTypeDialog({ initial, editing, taken, onCancel, onConfirm }: {
  initial: CustomTypeDraft
  editing: boolean
  taken: readonly string[]
  onCancel: () => void
  onConfirm: (name: string, type: CustomType) => void
}) {
  const t = useT()
  const id = useId()
  const [draft, setDraft] = useState(initial)
  // 第一次点「确定」之后才标错，之前只显示说明
  const [attempted, setAttempted] = useState(false)
  const result = validateTypeDraft(draft, taken)
  const errorOf = (field: keyof CustomTypeDraft): string | undefined => {
    if (!attempted || result.ok) return undefined
    const code = result.errors[field]
    return code === undefined ? undefined : t(ERROR_KEY[code])
  }
  const set = (patch: Partial<CustomTypeDraft>) => { setDraft(prev => ({ ...prev, ...patch })) }
  const confirm = () => {
    setAttempted(true)
    if (result.ok) onConfirm(result.name, result.type)
  }
  const field = (key: 'label' | 'name' | 'description' | 'whenToSave' | 'decayDays', labelKey: LocaleKey, hintKey: LocaleKey, extra: { multiline?: boolean; readOnly?: boolean; inputMode?: 'numeric' } = {}) => (
    <div className="pm-field">
      <label className="pm-setting-label" htmlFor={`${id}-${key}`}>{t(labelKey)}</label>
      <TextField id={`${id}-${key}`} value={draft[key]} onChange={(text) => { set({ [key]: text }) }} error={errorOf(key)} hint={t(hintKey)} {...extra} />
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
          onChange={(next) => { set({ [key]: next } as Partial<CustomTypeDraft>) }}
        />
        {error !== undefined ? <p className="pm-input-invalid" role="status">{error}</p> : <p className="pm-setting-hint">{t(hintKey)}</p>}
      </div>
    )
  }
  return (
    <Dialog
      title={t(editing ? 'settings.type.editTitle' : 'settings.type.addTitle')}
      closeLabel={t('settings.type.close')}
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel}>{t('settings.type.cancel')}</Button>
          <Button variant="primary" onClick={confirm}>{t('settings.type.confirm')}</Button>
        </>
      )}
    >
      {field('label', 'settings.type.label', 'settings.type.labelHint')}
      {field('name', 'settings.type.name', 'settings.type.nameHint', { readOnly: editing })}
      {field('description', 'settings.type.description', 'settings.type.descriptionHint', { multiline: true })}
      {field('whenToSave', 'settings.type.whenToSave', 'settings.type.whenToSaveHint', { multiline: true })}
      {choice('recall', 'settings.type.recall', 'settings.type.recallHint', RECALL_MODES, v => `settings.type.recall.${v}` as LocaleKey)}
      {choice('governancePriority', 'settings.type.priority', 'settings.type.priorityHint', PRIORITIES, v => `settings.type.priority.${v}` as LocaleKey)}
      {field('decayDays', 'settings.type.decayDays', 'settings.type.decayDaysHint', { inputMode: 'numeric' })}
    </Dialog>
  )
}

export const customTypesCss = `
.pm-types { display: flex; flex-direction: column; align-self: stretch; margin: 0; padding: 0; list-style: none; }
.pm-type-row { display: flex; align-items: center; gap: 8px; min-height: 36px; }
.pm-type-row + .pm-type-row { border-top: .5px solid var(--pm-line); }
.pm-type-label { font-size: 13px; color: var(--pm-text); }
.pm-type-name { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; color: var(--pm-text-2); }
.pm-type-meta { font-size: 12px; color: var(--pm-text-3); }
.pm-type-actions { margin-left: auto; display: inline-flex; gap: 4px; }
`

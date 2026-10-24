/**
 * 设置页的暂存草稿（照宿主 ui-primitives SettingsFormModel 的做法）：改动先暂存，点保存才写；
 * 第一次改动时冻结表单 revision，保存用 `mutate(ops, 冻结的 revision)` 一次提交。
 * 宿主拒绝时它已重读最新配置：revision 变了 = 别处（另一个标签页、agent、手改 yaml）先改过 → 冲突，
 * 草稿保留、保存锁住，等用户「载入最新配置」后再改；revision 没变 = 宿主校验不过 → 保存失败。
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import { buildOps, fieldsOf, type ConfigForm, type ConfigFormSnapshot, type SettingsFields } from './config.ts'

export type SaveOutcome = 'idle' | 'failed' | 'conflict'

export interface SettingsDraft {
  snapshot: ConfigFormSnapshot
  /** 已存的值（宿主当前配置）。 */
  saved: SettingsFields
  /** 已存值叠上暂存改动。 */
  fields: SettingsFields
  /** 改过、且和已存值不同的字段。 */
  changed: ReadonlySet<keyof SettingsFields>
  dirty: boolean
  /** 有字段不合法，保存锁住。 */
  invalid: boolean
  saving: boolean
  outcome: SaveOutcome
  edit(patch: Partial<SettingsFields>): void
  save(): Promise<void>
  /** 丢掉暂存改动，下一次改动按最新 revision 重新冻结。 */
  discard(): void
}

interface DraftState {
  edits: Partial<SettingsFields>
  /** 开始编辑时冻结的 revision；没有改动时为 undefined。 */
  revision: number | undefined
  saving: boolean
  outcome: SaveOutcome
}

const IDLE: DraftState = { edits: {}, revision: undefined, saving: false, outcome: 'idle' }

export function useSettingsDraft(form: ConfigForm): SettingsDraft {
  const subscribe = useCallback((fn: () => void) => form.subscribe(fn), [form])
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => form.getSnapshot(), [form]))
  const [state, setState] = useState<DraftState>(IDLE)
  const saved = fieldsOf(snapshot.value)
  const fields: SettingsFields = { ...saved, ...state.edits }
  const ops = buildOps(saved, fields)
  const changed = new Set((Object.keys(state.edits) as (keyof SettingsFields)[])
    .filter(key => buildOps(saved, { ...saved, [key]: fields[key] })?.length !== 0))

  const edit = useCallback((patch: Partial<SettingsFields>) => {
    setState(prev => ({
      ...prev,
      edits: { ...prev.edits, ...patch },
      revision: prev.revision ?? form.getSnapshot().revision,
      outcome: prev.outcome === 'conflict' ? 'conflict' : 'idle',
    }))
  }, [form])

  const discard = useCallback(() => { setState(IDLE) }, [])

  const save = async () => {
    if (ops === undefined || ops.length === 0 || state.saving || state.outcome === 'conflict' || !snapshot.writable) return
    const frozen = state.revision
    setState(prev => ({ ...prev, saving: true, outcome: 'idle' }))
    let accepted = false
    try {
      accepted = await form.mutate(ops, frozen)
    } catch {
      accepted = false
    }
    if (accepted) {
      setState(IDLE)
      return
    }
    const conflicted = frozen !== undefined && form.getSnapshot().revision !== frozen
    setState(prev => ({ ...prev, saving: false, outcome: conflicted ? 'conflict' : 'failed' }))
  }

  return {
    snapshot,
    saved,
    fields,
    changed,
    dirty: ops === undefined || ops.length > 0,
    invalid: ops === undefined || state.outcome === 'conflict',
    saving: state.saving,
    outcome: state.outcome,
    edit,
    save,
    discard,
  }
}

/**
 * 设置页的暂存草稿（照宿主 ui-primitives SettingsFormModel 的做法）：改动先暂存，点保存才写；
 * 第一次改动时冻结表单 revision，保存用 `mutate(ops, 冻结的 revision)` 一次提交。
 * 宿主拒绝时它已重读最新配置：revision 变了 = 别处（另一个标签页、agent、手改 yaml）先改过 → 冲突，
 * 草稿保留、保存锁住，等用户「载入最新配置」后再改；revision 没变 = 宿主校验不过 → 保存失败。
 * 草稿里的类型迁移（改名、删除自建类型时对已有记忆的处理）在配置写进去之后逐条执行；失败的留着，可以重试，
 * 重试只处理还是旧类型的记忆，重复执行无害。
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import { buildOps, fieldsOf, type ConfigForm, type ConfigFormSnapshot, type MigrationAction, type Migrations, type SettingsFields } from './config.ts'

export type SaveOutcome = 'idle' | 'failed' | 'conflict'

/** 执行一条类型迁移；ok 为 false 时整条留着重试。 */
export type MigrateType = (from: string, migration: MigrationAction) => Promise<{ ok: boolean; skippedSecrets?: number }>

/** 保存后的迁移：执行中、有失败（remaining 留着重试）、做完（含密钥没移走的条数）。 */
export type MigrationState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'failed'; remaining: Migrations }
  | { status: 'done'; skippedSecrets: number }

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
  /** 暂存的类型迁移。 */
  migrations: Migrations
  migration: MigrationState
  /** 改字段；给了 migrations 时整份替换暂存的迁移。 */
  edit(patch: Partial<SettingsFields>, migrations?: Migrations): void
  save(): Promise<void>
  retryMigrations(): Promise<void>
  /** 丢掉暂存改动，下一次改动按最新 revision 重新冻结。 */
  discard(): void
}

interface DraftState {
  edits: Partial<SettingsFields>
  migrations: Migrations
  /** 开始编辑时冻结的 revision；没有改动时为 undefined。 */
  revision: number | undefined
  saving: boolean
  outcome: SaveOutcome
}

const IDLE: DraftState = { edits: {}, migrations: {}, revision: undefined, saving: false, outcome: 'idle' }

/** @param migrate 执行类型迁移；没有会话时不给，暂存的迁移保存后全部算失败、留着重试。 */
export function useSettingsDraft(form: ConfigForm, migrate?: MigrateType): SettingsDraft {
  const subscribe = useCallback((fn: () => void) => form.subscribe(fn), [form])
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => form.getSnapshot(), [form]))
  const [state, setState] = useState<DraftState>(IDLE)
  const [migration, setMigration] = useState<MigrationState>({ status: 'idle' })
  const saved = fieldsOf(snapshot.value)
  const fields: SettingsFields = { ...saved, ...state.edits }
  const ops = buildOps(saved, fields)
  const changed = new Set((Object.keys(state.edits) as (keyof SettingsFields)[])
    .filter(key => buildOps(saved, { ...saved, [key]: fields[key] })?.length !== 0))

  const edit = useCallback((patch: Partial<SettingsFields>, migrations?: Migrations) => {
    setState(prev => ({
      ...prev,
      edits: { ...prev.edits, ...patch },
      migrations: migrations ?? prev.migrations,
      revision: prev.revision ?? form.getSnapshot().revision,
      outcome: prev.outcome === 'conflict' ? 'conflict' : 'idle',
    }))
  }, [form])

  const discard = useCallback(() => { setState(IDLE) }, [])

  const runMigrations = async (pending: Migrations) => {
    if (Object.keys(pending).length === 0) return
    setMigration({ status: 'running' })
    const remaining: Record<string, MigrationAction> = {}
    let skippedSecrets = 0
    for (const [from, m] of Object.entries(pending)) {
      let result: Awaited<ReturnType<MigrateType>> = { ok: false }
      try {
        if (migrate !== undefined) result = await migrate(from, m)
      } catch {
        result = { ok: false }
      }
      if (result.ok) skippedSecrets += result.skippedSecrets ?? 0
      else remaining[from] = m
    }
    setMigration(Object.keys(remaining).length > 0 ? { status: 'failed', remaining } : { status: 'done', skippedSecrets })
  }

  const retryMigrations = async () => {
    if (migration.status === 'failed') await runMigrations(migration.remaining)
  }

  const isDirty = ops === undefined || ops.length > 0 || Object.keys(state.migrations).length > 0
  // 上次没迁完的并进草稿的迁移：弹层在它们之上合并，下次保存一起执行（同一个原名以草稿为准）
  const migrations: Migrations = migration.status === 'failed' ? { ...migration.remaining, ...state.migrations } : state.migrations

  const save = async () => {
    if (ops === undefined || !isDirty || state.saving || state.outcome === 'conflict' || !snapshot.writable) return
    const frozen = state.revision
    setState(prev => ({ ...prev, saving: true, outcome: 'idle' }))
    // 只有迁移、配置没变（少见）时不写配置
    let accepted = ops.length === 0
    try {
      if (!accepted) accepted = await form.mutate(ops, frozen)
    } catch {
      accepted = false
    }
    if (accepted) {
      const pending = migrations
      setState(IDLE)
      setMigration({ status: 'idle' })
      await runMigrations(pending)
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
    dirty: isDirty,
    invalid: ops === undefined || state.outcome === 'conflict',
    saving: state.saving,
    outcome: state.outcome,
    migrations,
    migration,
    edit,
    save,
    retryMigrations,
    discard,
  }
}

/**
 * 「记什么」的两组小卡和场景弹层（卡片网格同宿主设置页的 Agent 预设：卡身是选择区，操作放在细线下的卡脚，新建是网格下的虚线条）：
 * - 场景：单选卡，点卡身切换；通用场景不能编辑，没有卡脚。
 * - 记忆类型：类型池里每一类一张卡，写哪些场景在用、存了几条，分三组：通用五类只能查看（只读弹层）；预设能编辑（英文名不变）、
 *   恢复默认、删除，删掉的在组末一行、能恢复；我加的能编辑、删除。删除都是原位确认，确认后直接改草稿。
 * 场景弹层是一个 Dialog，换两种内容：勾选（场景名 + 类型清单）、类型表单。弹层是一次事务：里面的改动
 * （勾选、新建 / 改 / 删类型、类型迁移）先留在弹层里，「确定」时一起并进页面草稿，「取消」、Esc、关闭全部撤销。
 * 从记忆类型列表打开的只有类型表单，确定后直接并进页面草稿。换场景、删类型后不再新增哪几类，由保存确认框写（SettingsPage）。
 */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import {
  BUILTIN_TYPE_NAMES, EMPTY_TYPE_DRAFT, GENERAL_SCENE, MAX_SCENES, PRESET_TYPE_NAMES, SCENE_MAX_TYPES, TYPE_DEFINITIONS,
  draftOf, forgetMigrations, isPresetEdited, isPresetScene, isPresetType, isPresetTypeEdited, keepMigrations, memoryCountOf, nextSceneId,
  pendingNames, presetSceneTypes, removeType, renameMigrations, renameType, restorePresetType, sceneTypes, scenesUsing, validateSceneDraft,
  validateTypeDraft, type CustomType, type CustomTypeDraft, type MigrationAction, type Migrations, type Pool, type Scene, type SettingsFields,
} from './config.ts'
import { Icon } from '../ui/Icon.tsx'
import { Dialog, TextField } from './controls.tsx'
import { TypeFormFields } from './CustomTypes.tsx'
import { typeLabel } from '../type-label.ts'

type DefinedType = keyof typeof TYPE_DEFINITIONS

const BUILTIN: readonly string[] = BUILTIN_TYPE_NAMES

/** 场景在界面上的名字：通用、编码、办公取 locale（不能改名），自定义场景取配置里的名字。 */
export function sceneLabel(t: Translate, id: string, scenes: Readonly<Record<string, Scene>>): string {
  if (id === GENERAL_SCENE) return t('settings.scene.custom')
  if (isPresetScene(id)) return t(`settings.scene.${id}`)
  return Object.hasOwn(scenes, id) ? scenes[id]!.label : id
}

/** 一串类型名，加引号、按语言习惯连起来（中文「A」「B」，英文 “A”, “B”）。 */
export function typeNames(t: Translate, labels: readonly string[]): string {
  return t('settings.typeOpen') + labels.join(t('settings.typeSep')) + t('settings.typeClose')
}

/** 场景行的组成：通用五类齐全时写「通用五类」，否则列出来；其余类型逐个用「 + 」接上。 */
function typesSummary(t: Translate, names: readonly string[], customTypes: Readonly<Record<string, CustomType>>): string {
  const label = (name: string) => typeLabel(t, name, { customTypes })
  const builtin = names.filter(n => BUILTIN.includes(n))
  const parts = builtin.length === BUILTIN.length ? [t('settings.scene.generalTypes')] : builtin.length > 0 ? [builtin.map(label).join(t('settings.scene.listSep'))] : []
  return [...parts, ...names.filter(n => !BUILTIN.includes(n)).map(label)].join(t('settings.scene.groupSep'))
}

/** 类型在不在类型池里（通用五类、没删的预设、我加的）；场景组成里可能留着已经删掉的名字。 */
function isPooled(pool: Pool, name: string): boolean {
  if (isPresetType(name)) return !pool.removedPresets.includes(name)
  return BUILTIN.includes(name) || Object.hasOwn(pool.customTypes, name)
}

/** 只取类型池那几项，交给 onChange 当补丁。 */
function poolOf(fields: Pool): Pool {
  return { scenes: fields.scenes, customTypes: fields.customTypes, removedPresets: fields.removedPresets }
}

/** 预设和我加的类型现在的定义（改过的预设取改过的）。 */
function definitionOf(customTypes: Pool['customTypes'], name: string): CustomType {
  return Object.hasOwn(customTypes, name) ? customTypes[name]! : TYPE_DEFINITIONS[name as DefinedType]
}

/** 这一类名下的记忆条数（含改名迁过来的）；读不到时 undefined。 */
function countOf(name: string, migrations: Migrations, counts: ReadonlyMap<string, number> | undefined): number | undefined {
  return counts === undefined ? undefined : memoryCountOf(name, migrations, counts)
}

/** 条数读不到时：预设、配置里已有的类型、或有记忆改名迁到它的，按存过记忆处理；这次新建的没有。 */
function hasMemories(name: string, saved: SettingsFields, migrations: Migrations, counts: ReadonlyMap<string, number> | undefined): boolean {
  const n = countOf(name, migrations, counts)
  if (n !== undefined) return n > 0
  return isPresetType(name) || Object.hasOwn(saved.customTypes, name) || Object.values(migrations).some(m => m.action === 'retype' && m.to === name)
}

/** 页面上一次只开一个原位确认：删场景或删类型。 */
type Removing = { kind: 'scene' | 'type'; id: string }

type DialogMode = { kind: 'scene'; id?: string } | { kind: 'type'; name?: string } | { kind: 'view'; name: DefinedType }

export function SceneSection({ fields, saved, migrations, counts, canMigrate, disabled, now, onChange }: {
  fields: SettingsFields
  saved: SettingsFields
  migrations: Migrations
  /** 各类型名下的记忆条数（全库，在用的加最近删除里的）；读不到（没有会话）时 undefined，按「存过记忆」处理。 */
  counts: ReadonlyMap<string, number> | undefined
  /** 能执行类型迁移（有会话）。 */
  canMigrate: boolean
  disabled: boolean
  now: () => number
  onChange: (patch: Partial<SettingsFields>, migrations?: Migrations) => void
}) {
  const t = useT()
  const id = useId()
  const [dialog, setDialog] = useState<DialogMode | undefined>(undefined)
  const [removing, setRemoving] = useState<Removing | undefined>(undefined)
  const [focusNext, focusKey] = useFocusNext()
  const ids = Object.keys(fields.scenes)
  const sceneIds = [GENERAL_SCENE, ...ids]
  const remaining = Math.max(0, MAX_SCENES - ids.length)
  const isRemoving = (kind: Removing['kind'], key: string) => removing?.kind === kind && removing.id === key
  const openDialog = (mode: DialogMode) => { setRemoving(undefined); setDialog(mode) }

  const removeScene = (sceneId: string) => {
    const { [sceneId]: _removed, ...scenes } = fields.scenes
    setRemoving(undefined)
    onChange({ scenes, ...(fields.template === sceneId ? { template: GENERAL_SCENE } : {}) })
    focusNext('group:scenes')
  }
  const sceneTile = (sceneId: string) => {
    const name = sceneLabel(t, sceneId, fields.scenes)
    const isSelected = fields.template === sceneId
    const scene = sceneId === GENERAL_SCENE ? undefined : fields.scenes[sceneId]
    const isEdited = scene !== undefined && isPresetEdited(sceneId, scene, fields.removedPresets)
    const types = sceneTypes(fields, sceneId)
    const detailId = `${id}-${sceneId}-types`
    return (
      <li key={sceneId} className={isSelected ? 'pm-tile pm-tile--selected' : 'pm-tile'}>
        <label className="pm-tile-main">
          <input
            type="radio" name={`${id}-scene`} className="pm-tile-radio" checked={isSelected} disabled={disabled}
            aria-label={name} aria-describedby={detailId}
            onChange={() => { onChange({ template: sceneId }) }}
          />
          <span className="pm-tile-head">
            <span className="pm-tile-title">{name}</span>
            {isEdited ? <span className="pm-scene-tag">{t('settings.scene.edited')}</span> : null}
          </span>
          <span className="pm-tile-detail" id={detailId}>
            {sceneId === GENERAL_SCENE ? types.map(n => typeLabel(t, n, { customTypes: fields.customTypes })).join(t('settings.scene.listSep')) : typesSummary(t, types, fields.customTypes)}
          </span>
        </label>
        {scene === undefined
          ? null
          : (
            <div className="pm-tile-foot">
              {isRemoving('scene', sceneId)
                ? (
                  <LinkConfirm
                    question={t(isSelected ? 'settings.scene.removeCurrent' : 'settings.scene.removeQuestion', { name })}
                    actions={[{ label: t('settings.scene.removeConfirm'), onClick: () => { removeScene(sceneId) } }]}
                    cancelLabel={t('settings.scene.cancel')}
                    onCancel={() => { setRemoving(undefined); focusNext(`remove:scene:${sceneId}`) }}
                  />
                )
                : (
                  <>
                    {isEdited && isPresetScene(sceneId)
                      ? (
                        <Button variant="quiet" disabled={disabled} aria-label={t('settings.scene.resetAria', { name })}
                          onClick={() => { onChange({ scenes: { ...fields.scenes, [sceneId]: { ...scene, types: presetSceneTypes(sceneId, fields.removedPresets) } } }) }}>
                          {t('settings.scene.reset')}
                        </Button>
                      )
                      : null}
                    <Button variant="quiet" disabled={disabled} aria-label={t('settings.scene.editAria', { name })}
                      onClick={() => { openDialog({ kind: 'scene', id: sceneId }) }}>{t('settings.scene.edit')}</Button>
                    <Button variant="quiet" disabled={disabled} aria-label={t('settings.scene.removeAria', { name })} {...focusKey(`remove:scene:${sceneId}`)}
                      onClick={() => { setRemoving({ kind: 'scene', id: sceneId }) }}>{t('settings.scene.remove')}</Button>
                  </>
                )}
            </div>
          )}
      </li>
    )
  }

  const typeTile = (name: string) => {
    const label = typeLabel(t, name, { customTypes: fields.customTypes })
    const isBuiltin = BUILTIN.includes(name)
    const isPreset = isPresetType(name)
    const isEdited = isPresetTypeEdited(name, fields.customTypes)
    const users = sceneIds.filter(sid => sceneTypes(fields, sid).includes(name)).map(sid => sceneLabel(t, sid, fields.scenes))
    const usage = users.length > 0 ? t('settings.types.usedBy', { names: users.join(t('settings.scene.listSep')) }) : t('settings.types.unused')
    const n = countOf(name, migrations, counts)
    const resetPreset = () => {
      const { [name]: _edited, ...customTypes } = fields.customTypes
      onChange({ customTypes })
    }
    let foot: ReactNode
    if (isBuiltin) {
      foot = (
        <Button variant="quiet" disabled={disabled} aria-label={t('settings.types.viewAria', { name: label })}
          onClick={() => { openDialog({ kind: 'view', name: name as DefinedType }) }}>{t('settings.types.view')}</Button>
      )
    } else if (isRemoving('type', name)) {
      foot = (
        <TypeRemoveConfirm
          name={name} pool={fields} saved={saved} migrations={migrations} counts={counts} canMigrate={canMigrate}
          onRemove={(action) => {
            setRemoving(undefined)
            onChange(removeType(poolOf(fields), name), action === 'forget' ? forgetMigrations(migrations, name, counts) : keepMigrations(migrations, name))
            focusNext(`group:${isPreset ? 'preset' : 'custom'}`)
          }}
          onCancel={() => { setRemoving(undefined); focusNext(`remove:type:${name}`) }}
        />
      )
    } else {
      foot = (
        <>
          {isEdited
            ? (
              <Button variant="quiet" disabled={disabled} aria-label={t('settings.scene.resetAria', { name: label })} onClick={resetPreset}>
                {t('settings.scene.reset')}
              </Button>
            )
            : null}
          <Button variant="quiet" disabled={disabled} aria-label={t('settings.types.editAria', { name: label })} {...focusKey(`edit:type:${name}`)}
            onClick={() => { openDialog({ kind: 'type', name }) }}>{t('settings.types.edit')}</Button>
          <Button variant="quiet" disabled={disabled} aria-label={t('settings.types.removeAria', { name: label })} {...focusKey(`remove:type:${name}`)}
            onClick={() => { setRemoving({ kind: 'type', id: name }) }}>{t('settings.types.remove')}</Button>
        </>
      )
    }
    return (
      <li key={name} className="pm-tile">
        <div className="pm-tile-main">
          <span className="pm-tile-head">
            <span className="pm-tile-title">{label}</span>
            {isEdited ? <span className="pm-scene-tag">{t('settings.scene.edited')}</span> : null}
            {!isBuiltin && !isPreset ? <code className="pm-scene-code pm-tile-code" title={name}>{name}</code> : null}
          </span>
          <span className="pm-tile-detail">{n !== undefined ? `${usage} · ${t('settings.types.count', { n })}` : usage}</span>
        </div>
        <div className="pm-tile-foot">{foot}</div>
      </li>
    )
  }
  /** 一组类型卡：小标题 + 网格（一张都没有时不出网格），后面接这一组的附加行。 */
  const typeGroup = (group: 'general' | 'preset' | 'custom', names: readonly string[], extra: ReactNode = null) => (
    <div className="pm-tile-group">
      <h4 className="pm-tile-group-title" id={`${id}-types-${group}`} tabIndex={-1} {...focusKey(`group:${group}`)}>{t(`settings.types.group.${group}`)}</h4>
      {names.length > 0 ? <ul className="pm-tiles" aria-labelledby={`${id}-types-${group}`}>{names.map(typeTile)}</ul> : null}
      {extra}
    </div>
  )
  const restorePreset = (name: string) => {
    const restored = restorePresetType(poolOf(fields), migrations, name)
    onChange(restored.pool, restored.migrations)
    focusNext(`edit:type:${name}`)
  }

  return (
    <>
      <section className="pm-subgroup">
        <h3 className="pm-subgroup-title" id={`${id}-scenes`} tabIndex={-1} {...focusKey('group:scenes')}>{t('settings.scene.label')}</h3>
        <ul className="pm-tiles" role="radiogroup" aria-labelledby={`${id}-scenes`}>
          {sceneIds.map(sceneTile)}
        </ul>
        <button
          type="button" className="pm-tile-add" disabled={disabled || remaining === 0}
          aria-label={t('settings.scene.add')} aria-describedby={`${id}-remaining`}
          onClick={() => { openDialog({ kind: 'scene' }) }}
        >
          <Icon name="plus" size={14} />
          {t('settings.scene.add')}
          <span className="pm-tile-add-note" id={`${id}-remaining`}>{t('settings.scene.remaining', { n: remaining })}</span>
        </button>
      </section>
      <section className="pm-subgroup" aria-labelledby={`${id}-types`}>
        <h3 className="pm-subgroup-title" id={`${id}-types`}>{t('settings.types.title')}</h3>
        <p className="pm-subgroup-hint">{t('settings.types.intro')}</p>
        {typeGroup('general', BUILTIN)}
        {typeGroup('preset', PRESET_TYPE_NAMES.filter(name => !fields.removedPresets.includes(name)), fields.removedPresets.map((name) => {
          const label = typeLabel(t, name, {})
          return (
            <p key={name} className="pm-tile-removed">
              <span>{t('settings.types.removedLine', { label })}</span>
              <i className="pm-sep" aria-hidden="true">·</i>
              <button type="button" className="pm-link" disabled={disabled} aria-label={t('settings.types.restoreAria', { name: label })}
                onClick={() => { restorePreset(name) }}>{t('settings.types.restore')}</button>
            </p>
          )
        }))}
        {typeGroup('custom', Object.keys(fields.customTypes).filter(name => !isPresetType(name)), (
          <button type="button" className="pm-tile-add" disabled={disabled} onClick={() => { openDialog({ kind: 'type' }) }}>
            <Icon name="plus" size={14} />
            {t('settings.types.create')}
          </button>
        ))}
      </section>
      {dialog?.kind === 'view' ? <TypeView name={dialog.name} onClose={() => { setDialog(undefined) }} /> : null}
      {dialog !== undefined && dialog.kind !== 'view'
        ? (
          <SceneDialog
            mode={dialog}
            fields={fields}
            saved={saved}
            migrations={migrations}
            counts={counts}
            canMigrate={canMigrate}
            now={now}
            onCancel={() => { setDialog(undefined) }}
            onCommit={(patch, next) => { setDialog(undefined); onChange(patch, next) }}
          />
        )
        : null}
    </>
  )
}

type View =
  | { kind: 'pick' }
  /** original：编辑的类型原来的英文名，新建时 undefined；isAsking：改名时正在问旧记忆怎么办。 */
  | { kind: 'form'; original: string | undefined; draft: CustomTypeDraft; attempted: boolean; isAsking: boolean }

type FormView = Extract<View, { kind: 'form' }>

function SceneDialog({ mode, fields, saved, migrations: initialMigrations, counts, canMigrate, now, onCancel, onCommit }: {
  mode: Exclude<DialogMode, { kind: 'view' }>
  fields: SettingsFields
  saved: SettingsFields
  migrations: Migrations
  counts: ReadonlyMap<string, number> | undefined
  canMigrate: boolean
  now: () => number
  onCancel: () => void
  onCommit: (patch: Partial<SettingsFields>, migrations: Migrations) => void
}) {
  const t = useT()
  const id = useId()
  const editingId = mode.kind === 'scene' ? mode.id : undefined
  const isPreset = editingId !== undefined && isPresetScene(editingId)
  const formFor = (customTypes: Pool['customTypes'], name?: string): FormView => ({
    kind: 'form', original: name, draft: name === undefined ? EMPTY_TYPE_DRAFT : draftOf(name, definitionOf(customTypes, name)), attempted: false, isAsking: false,
  })
  const home: View = { kind: 'pick' }
  const [pool, setPool] = useState<Pool>(() => poolOf(fields))
  const [migrations, setMigrations] = useState(initialMigrations)
  const [scene, setScene] = useState<Scene>(() => editingId !== undefined
    ? { label: fields.scenes[editingId]!.label, types: [...fields.scenes[editingId]!.types] }
    : { label: '', types: [...BUILTIN_TYPE_NAMES] })
  const [isSceneAttempted, setSceneAttempted] = useState(false)
  const [view, setView] = useState<View>(() => mode.kind === 'type' ? formFor(fields.customTypes, mode.name) : home)
  const [removing, setRemoving] = useState<string | undefined>(undefined)
  const [focusNext, focusKey] = useFocusNext()
  const [notice, setNotice] = useState<string | undefined>(undefined)

  // 换内容后聚焦新内容的第一个输入框（打开时由 Dialog 聚焦）
  const body = useRef<HTMLDivElement>(null)
  const viewKey = view.kind === 'form' ? `form:${view.original ?? ''}` : view.kind
  const isMounted = useRef(false)
  useEffect(() => {
    if (!isMounted.current) { isMounted.current = true; return }
    const items = [...body.current?.querySelectorAll<HTMLElement>('input, textarea, button:not(:disabled)') ?? []]
    ;(items.find(el => el.matches('input:not([type=checkbox]), textarea')) ?? items[0])?.focus()
  }, [viewKey])

  const selected = scene.types.filter(name => isPooled(pool, name))
  const isFull = selected.length >= SCENE_MAX_TYPES
  const label = (name: string) => typeLabel(t, name, { customTypes: pool.customTypes })
  const sceneName = (sid: string) => sceneLabel(t, sid, pool.scenes)

  const finishForm = (nextPool: Pool, nextScene: Scene, nextMigrations: Migrations) => {
    if (mode.kind === 'type') { onCommit(nextPool, nextMigrations); return }
    setPool(nextPool)
    setScene(nextScene)
    setMigrations(nextMigrations)
    setView(home)
  }
  const rename = (from: string, to: string, type: CustomType, action?: MigrationAction['action']) => {
    finishForm(
      renameType(pool, from, to, type),
      { ...scene, types: scene.types.map(n => n === from ? to : n) },
      action === undefined ? migrations : renameMigrations(migrations, from, to, action, counts),
    )
  }
  const takenFor = (original: string | undefined) => ({
    names: [...PRESET_TYPE_NAMES.filter(n => n !== original), ...Object.keys(pool.customTypes).filter(n => n !== original && !isPresetType(n))],
    // 预设改了中文名，出厂中文名仍算占用：「恢复默认」后才不会和别的类型重名
    labels: [
      ...[...BUILTIN, ...PRESET_TYPE_NAMES].filter(n => n !== original).map(n => typeLabel(t, n, {})),
      ...Object.entries(pool.customTypes).filter(([n]) => n !== original).map(([, type]) => type.label),
    ],
    pending: pendingNames(migrations, original),
    removedPresets: pool.removedPresets,
  })
  const confirmForm = (form: FormView) => {
    const result = validateTypeDraft(form.draft, takenFor(form.original))
    if (!result.ok) { setView({ ...form, attempted: true }); return }
    const { name, type } = result
    if (form.original === undefined) {
      const isPicked = mode.kind === 'scene' && !isFull
      if (mode.kind === 'scene' && isFull) setNotice(t('settings.sceneDialog.full', { max: SCENE_MAX_TYPES, name: type.label }))
      finishForm({ ...pool, customTypes: { ...pool.customTypes, [name]: type } }, isPicked ? { ...scene, types: [...scene.types, name] } : scene, migrations)
    } else if (name === form.original) {
      // 预设改回和出厂定义一样的，等于恢复默认：去掉同名一项
      const { [name]: _old, ...others } = pool.customTypes
      const isDefault = isPresetType(name) && !isPresetTypeEdited(name, { [name]: type })
      finishForm({ ...pool, customTypes: isDefault ? others : { ...pool.customTypes, [name]: type } }, scene, migrations)
    } else if (!hasMemories(form.original, saved, migrations, counts)) {
      rename(form.original, name, type)
    } else {
      setView({ ...form, isAsking: true })
    }
  }

  const remove = (name: string, action: 'keep' | 'forget') => {
    setPool(removeType(pool, name))
    setScene({ ...scene, types: scene.types.filter(n => n !== name) })
    setMigrations(action === 'forget' ? forgetMigrations(migrations, name, counts) : keepMigrations(migrations, name))
    setRemoving(undefined)
    focusNext('add-type')
  }
  const removeConfirm = (name: string) => (
    <TypeRemoveConfirm
      name={name} pool={pool} saved={saved} migrations={migrations} counts={counts} canMigrate={canMigrate} editingScene={{ id: editingId }} block
      onRemove={(action) => { remove(name, action) }} onCancel={() => { setRemoving(undefined); focusNext(`remove:${name}`) }}
    />
  )
  const typeActions = (name: string) => (
    <span className="pm-scene-actions">
      <Button variant="quiet" aria-label={t('settings.types.editAria', { name: label(name) })}
        onClick={() => { setRemoving(undefined); setView(formFor(pool.customTypes, name)) }}>{t('settings.types.edit')}</Button>
      <Button variant="quiet" aria-label={t('settings.types.removeAria', { name: label(name) })} {...focusKey(`remove:${name}`)}
        onClick={() => { setRemoving(name) }}>{t('settings.types.remove')}</Button>
    </span>
  )
  const addType = <button type="button" className="pm-link pm-scene-add-type" {...focusKey('add-type')} onClick={() => { setRemoving(undefined); setNotice(undefined); setView(formFor(pool.customTypes)) }}>{t('settings.types.add')}</button>

  const confirmScene = () => {
    const others = [t('settings.scene.custom'), ...Object.keys(pool.scenes).filter(sid => sid !== editingId).map(sceneName)]
    const result = validateSceneDraft({ label: scene.label, types: selected }, isPreset ? [] : others)
    if (!result.ok) { setSceneAttempted(true); return }
    const sceneId = editingId ?? nextSceneId(Object.keys(pool.scenes), now())
    onCommit({ scenes: { ...pool.scenes, [sceneId]: result.scene }, customTypes: pool.customTypes }, migrations)
  }

  let title: string
  let content: ReactNode
  let footer: ReactNode
  let onBack: (() => void) | undefined
  if (view.kind === 'form') {
    const form = view
    const set = (patch: Partial<CustomTypeDraft>) => { setView({ ...form, draft: { ...form.draft, ...patch }, isAsking: false }) }
    const errors = form.attempted ? (() => { const r = validateTypeDraft(form.draft, takenFor(form.original)); return r.ok ? undefined : r.errors })() : undefined
    const back = mode.kind === 'type' ? onCancel : () => { setView(home) }
    title = t(form.original === undefined ? 'settings.type.addTitle' : 'settings.type.editTitle')
    onBack = mode.kind === 'type' ? undefined : back
    content = <TypeFormFields draft={form.draft} errors={errors} isNameLocked={form.original !== undefined && isPresetType(form.original)} onChange={set} />
    if (form.isAsking && form.original !== undefined) {
      const original = form.original
      const n = countOf(original, migrations, counts)
      const result = validateTypeDraft(form.draft, takenFor(original))
      const choose = (action: MigrationAction['action']) => { if (result.ok) rename(original, result.name, result.type, action) }
      footer = (
        // 焦点落在「取消」（原来的「确定」被换掉了）；Esc 只收起这一问，不关弹层
        <div
          className="pm-scene-ask"
          role="group"
          aria-label={t('settings.type.retype')}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setView({ ...form, isAsking: false })
          }}
        >
          <p className="pm-scene-ask-text">
            {n !== undefined ? t('settings.type.renameAsk', { label: label(original), n }) : t('settings.type.renameAskUnknown', { label: label(original) })}
          </p>
          {!canMigrate ? <p className="pm-setting-hint">{t('settings.type.noSession')}</p> : null}
          <div className="pm-scene-ask-actions">
            <Button autoFocus onClick={() => { setView({ ...form, isAsking: false }) }}>{t('settings.sceneDialog.cancel')}</Button>
            <Button disabled={!canMigrate} onClick={() => { choose('forget') }}>{t('settings.type.forget')}</Button>
            <Button variant="primary" disabled={!canMigrate} onClick={() => { choose('retype') }}>{t('settings.type.retype')}</Button>
          </div>
        </div>
      )
    } else {
      const autoPick = mode.kind === 'scene' && form.original === undefined && !isFull && scene.label.trim() !== ''
        ? t('settings.sceneDialog.autoPick', { name: isPreset ? sceneName(editingId!) : scene.label.trim() })
        : undefined
      footer = (
        <>
          {autoPick !== undefined ? <span className="pm-scene-foot-note">{autoPick}</span> : null}
          <Button onClick={back}>{t('settings.sceneDialog.cancel')}</Button>
          <Button variant="primary" onClick={() => { confirmForm(form) }}>{t('settings.sceneDialog.confirm')}</Button>
        </>
      )
    }
  } else {
    title = t(editingId === undefined ? 'settings.sceneDialog.addTitle' : 'settings.sceneDialog.editTitle')
    const sceneErrors = isSceneAttempted ? (() => {
      const others = [t('settings.scene.custom'), ...Object.keys(pool.scenes).filter(sid => sid !== editingId).map(sceneName)]
      const r = validateSceneDraft({ label: scene.label, types: selected }, isPreset ? [] : others)
      return r.ok ? undefined : r.errors
    })() : undefined
    const toggle = (name: string) => {
      setNotice(undefined)
      setScene(prev => ({ ...prev, types: prev.types.includes(name) ? prev.types.filter(n => n !== name) : [...prev.types, name] }))
    }
    const check = (name: string, isCustom: boolean) => {
      const isChecked = scene.types.includes(name)
      const checkId = `${id}-type-${name}`
      return (
        <Fragment key={name}>
          <div className="pm-scene-check">
            <input type="checkbox" id={checkId} checked={isChecked} disabled={!isChecked && isFull} onChange={() => { toggle(name) }} />
            <label className="pm-scene-check-label" htmlFor={checkId}>{label(name)}</label>
            {isCustom ? <code className="pm-scene-code">{name}</code> : null}
            {isCustom ? typeActions(name) : null}
          </div>
          {removing === name ? removeConfirm(name) : null}
        </Fragment>
      )
    }
    const presets = PRESET_TYPE_NAMES.filter(n => !pool.removedPresets.includes(n))
    content = (
      <>
        {isPreset
          ? null
          : (
            <div className="pm-field">
              <label className="pm-setting-label" htmlFor={`${id}-name`}>{t('settings.sceneDialog.name')}</label>
              <TextField id={`${id}-name`} value={scene.label} onChange={(text) => { setScene(prev => ({ ...prev, label: text })) }}
                error={sceneErrors?.label !== undefined ? t(`settings.sceneDialog.error.${sceneErrors.label}`) : undefined} />
            </div>
          )}
        <div className="pm-scene-group" role="group" aria-label={t('settings.sceneDialog.general')}>
          <div className="pm-scene-group-head">
            <span>{t('settings.sceneDialog.general')}</span>
            <span className="pm-scene-meta" role="status">{t('settings.sceneDialog.count', { n: selected.length, max: SCENE_MAX_TYPES })}</span>
          </div>
          {BUILTIN.map(name => check(name, false))}
        </div>
        {presets.length > 0
          ? (
            <div className="pm-scene-group" role="group" aria-label={t('settings.sceneDialog.preset')}>
              <div className="pm-scene-group-head"><span>{t('settings.sceneDialog.preset')}</span></div>
              {presets.map(name => check(name, false))}
            </div>
          )
          : null}
        <div className="pm-scene-group" role="group" aria-label={t('settings.sceneDialog.custom')}>
          <div className="pm-scene-group-head"><span>{t('settings.sceneDialog.custom')}</span></div>
          {Object.keys(pool.customTypes).filter(name => !isPresetType(name)).map(name => check(name, true))}
          {addType}
        </div>
        {notice !== undefined ? <p className="pm-setting-hint" role="status">{notice}</p> : null}
        {sceneErrors?.types !== undefined ? <p className="pm-input-invalid" role="status">{t(`settings.sceneDialog.error.${sceneErrors.types}`)}</p> : null}
      </>
    )
    footer = (
      <>
        <span className="pm-scene-foot-note">{t('settings.sceneDialog.limit', { max: SCENE_MAX_TYPES })}</span>
        <Button onClick={onCancel}>{t('settings.sceneDialog.cancel')}</Button>
        <Button variant="primary" onClick={confirmScene}>{t('settings.sceneDialog.confirm')}</Button>
      </>
    )
  }

  return (
    <Dialog title={title} closeLabel={t('settings.sceneDialog.close')} onClose={onCancel} footer={footer} onBack={onBack} backLabel={t('settings.sceneDialog.back')}>
      <div ref={body} className="pm-scene-view">{content}</div>
    </Dialog>
  )
}

/** 通用类型的只读弹层：逐项写出定义原文（模型看到的就是这些），只有关闭。 */
function TypeView({ name, onClose }: { name: DefinedType; onClose: () => void }) {
  const t = useT()
  const def = TYPE_DEFINITIONS[name]
  const rows: ReadonlyArray<[LocaleKey, ReactNode]> = [
    ['settings.type.label', def.label],
    ['settings.type.name', <code className="pm-scene-code">{name}</code>],
    ['settings.type.description', def.description],
    ['settings.type.whenToSave', def.whenToSave],
    ['settings.type.howToUse', def.howToUse],
    ['settings.type.recall', t(`settings.type.recall.${def.recall}`)],
    ['settings.type.priority', t(`settings.type.priority.${def.governancePriority}`)],
    ['settings.type.decayDays', def.decayDays === null ? t('settings.type.noDecay') : String(def.decayDays)],
  ]
  return (
    <Dialog
      title={typeLabel(t, name, {})} closeLabel={t('settings.sceneDialog.close')} onClose={onClose}
      footer={<Button onClick={onClose}>{t('settings.sceneDialog.close')}</Button>}
    >
      <dl className="pm-type-view">
        {rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}
      </dl>
    </Dialog>
  )
}

/**
 * 删一个预设或我加的类型的原位确认：写明还有哪些场景在用、存过几条记忆；存过记忆的二选一（保留记忆 / 移到最近删除），
 * 删掉会让某个场景一类不剩时不给删。
 * @param editingScene 在场景弹层里删时给：id 是正在编辑的场景（新建时 undefined），它不算进「在用」，至少一类由弹层确定时的校验管。
 * @param block 整块显示在行下面（弹层的类型清单里）；页面上放在卡脚里，不用。
 */
function TypeRemoveConfirm({ name, pool, saved, migrations, counts, canMigrate, editingScene, block = false, onRemove, onCancel }: {
  name: string
  pool: Pool
  saved: SettingsFields
  migrations: Migrations
  counts: ReadonlyMap<string, number> | undefined
  canMigrate: boolean
  editingScene?: { id: string | undefined }
  block?: boolean
  onRemove: (action: 'keep' | 'forget') => void
  onCancel: () => void
}) {
  const t = useT()
  const sceneName = (sid: string) => sceneLabel(t, sid, pool.scenes)
  const others = Object.entries(pool.scenes).filter(([sid]) => sid !== editingScene?.id)
  const blocking = others.find(([, s]) => s.types.includes(name) && s.types.filter(n => n !== name && isPooled(pool, n)).length === 0)?.[0]
  if (blocking !== undefined) {
    return (
      <LinkConfirm question={t('settings.type.removeBlocked', { scene: sceneName(blocking) })} actions={[]}
        cancelLabel={t('settings.scene.cancel')} onCancel={onCancel} block={block} />
    )
  }
  const users = scenesUsing(Object.fromEntries(others), name).map(sceneName)
  const n = countOf(name, migrations, counts)
  const isUsed = hasMemories(name, saved, migrations, counts)
  const text = [
    t('settings.type.removeQuestion', { label: typeLabel(t, name, { customTypes: pool.customTypes }) }),
    users.length > 0 ? t(editingScene !== undefined ? 'settings.type.removeAlsoUsed' : 'settings.type.removeUsed', { scenes: users.join(t('settings.scene.listSep')) }) : '',
    isUsed ? n !== undefined ? t('settings.type.removeMemories', { n }) : t('settings.type.removeMemoriesUnknown') : '',
  ].join('')
  return (
    <LinkConfirm
      question={text}
      note={isUsed && !canMigrate ? t('settings.type.noSession') : undefined}
      actions={isUsed
        ? [
          { label: t('settings.type.keep'), onClick: () => { onRemove('keep') } },
          { label: t('settings.type.forget'), onClick: () => { onRemove('forget') }, disabled: !canMigrate },
        ]
        : [{ label: t('settings.type.removeConfirm'), onClick: () => { onRemove('keep') } }]}
      cancelLabel={t('settings.scene.cancel')}
      onCancel={onCancel}
      block={block}
    />
  )
}

/**
 * 原位确认收起、所在的行消失后，焦点会掉回页面顶部：点的时候记下接着聚焦谁（focusKey 标在那个元素上），渲染完再聚焦。
 */
function useFocusNext(): [(key: string) => void, (key: string) => { 'data-focus': string }] {
  const prefix = useId()
  const pending = useRef<string | undefined>(undefined)
  useEffect(() => {
    const key = pending.current
    if (key === undefined) return
    pending.current = undefined
    ;[...document.querySelectorAll<HTMLElement>('[data-focus]')].find(el => el.dataset.focus === key)?.focus()
  })
  return [key => { pending.current = `${prefix}${key}` }, key => ({ 'data-focus': `${prefix}${key}` })]
}

/**
 * 原位确认，链接样式（同记忆删除的「删除 · 取消」）：问句、动作、取消；Esc 取消且不关掉外层弹层。
 * block：整块显示在行下面（弹层里删类型时文字长）；不给时占满所在的一行（卡脚）。
 */
function LinkConfirm({ question, note, actions, cancelLabel, onCancel, block = false }: {
  question: string
  note?: string | undefined
  actions: ReadonlyArray<{ label: string; onClick: () => void; disabled?: boolean }>
  cancelLabel: string
  onCancel: () => void
  block?: boolean
}) {
  const questionId = useId()
  return (
    <span
      className={block ? 'pm-scene-confirm pm-scene-confirm--block' : 'pm-scene-confirm'}
      role="group"
      aria-labelledby={questionId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <span id={questionId}>{question}</span>
      {note !== undefined ? <span className="pm-scene-confirm-note">{note}</span> : null}
      <span className="pm-scene-confirm-actions">
        {actions.map(action => (
          <Fragment key={action.label}>
            <button type="button" className="pm-link" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>
            <i className="pm-sep" aria-hidden="true">·</i>
          </Fragment>
        ))}
        <button type="button" className="pm-link pm-scene-confirm-cancel" autoFocus onClick={onCancel}>{cancelLabel}</button>
      </span>
    </span>
  )
}

export const scenesCss = `
.pm-scene-tag { flex: none; padding: 0 7px; border-radius: 999px; background: var(--pm-hover); font-size: 11px; font-weight: 400; line-height: 18px; color: var(--pm-text-2); }
.pm-scene-actions { margin-left: auto; display: inline-flex; flex: none; gap: 4px; }
.pm-scene-meta { margin-left: 6px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-scene-view { display: flex; flex-direction: column; gap: 14px; }
.pm-scene-group { display: flex; flex-direction: column; }
.pm-scene-group-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-scene-group-head .pm-scene-meta { font-weight: 400; }
.pm-scene-check { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.pm-scene-check input { flex: none; margin: 0; accent-color: var(--pm-text); }
.pm-scene-check input:disabled + label { color: var(--pm-text-3); }
.pm-scene-check-label { font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-scene-code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; color: var(--pm-text-3); }
.pm-tile-code { margin-left: auto; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pm-subgroup-hint + .pm-tile-group { margin-top: 12px; }
.pm-tile-group + .pm-tile-group { margin-top: 16px; }
.pm-tile-group-title { margin: 0 0 8px; padding-left: 16px; font-size: 12px; font-weight: 500; line-height: 1.5; color: var(--pm-text-2); }
/* 删掉一张卡后焦点落在组标题上（只供读屏和键盘接着走），不画焦点框 */
.pm-tile-group-title:focus, .pm-subgroup .pm-subgroup-title:focus { outline: none; }
.pm-tile-removed { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; padding-left: 16px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-tile-group-title + .pm-tile-removed { margin-top: 0; }
.pm-tile-removed + .pm-tile-removed { margin-top: 4px; }
.pm-tile-removed .pm-sep { margin: 0; }
.pm-type-view { display: flex; flex-direction: column; gap: 12px; margin: 0; }
.pm-type-view div { display: flex; flex-direction: column; gap: 2px; }
.pm-type-view dt { font-size: 12px; font-weight: 500; line-height: 1.5; color: var(--pm-text-2); }
.pm-type-view dd { margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-scene-add-type { align-self: flex-start; margin-top: 4px; font-size: 13px; }
.pm-scene-foot-note { margin-right: auto; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-scene-confirm { display: flex; flex: 1; min-width: 0; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-scene-confirm--block { flex-basis: 100%; padding: 8px 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-scene-group .pm-scene-confirm--block { margin: 2px 0 6px 23px; }
.pm-scene-confirm-note { flex-basis: 100%; color: var(--pm-text-3); }
.pm-scene-confirm-actions { display: inline-flex; align-items: center; gap: 8px; }
.pm-scene-confirm .pm-link:disabled { color: var(--pm-text-3); cursor: default; text-decoration: none; }
.pm-scene-confirm .pm-sep { margin: 0 -2px; font-style: normal; }
.pm-scene-confirm .pm-scene-confirm-cancel { font-weight: 400; color: var(--pm-text-2); }
.pm-scene-ask { display: flex; flex: 1; flex-direction: column; gap: 8px; }
.pm-scene-ask-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-scene-ask-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
`

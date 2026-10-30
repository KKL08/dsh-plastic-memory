/**
 * 「场景」一项：场景单选列表、新建场景、当前场景的说明、「我加的类型」一览行，和场景弹层。
 * 弹层是一个 Dialog，换三种内容：勾选（场景名 + 类型清单）、类型表单、类型管理。弹层是一次事务：里面的改动
 * （勾选、新建 / 改 / 删类型、类型迁移）先留在弹层里，「确定」「完成」时一起并进页面草稿，「取消」、Esc、关闭全部撤销。
 * 通用场景不能编辑；「管理 ›」和「新建场景」里始终能管理类型。
 */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { Button } from '../ui/Button.tsx'
import {
  BUILTIN_TYPE_NAMES, EMPTY_TYPE_DRAFT, GENERAL_SCENE, MAX_SCENES, PRESET_SCENES, PRESET_TYPE_NAMES, RETIRED_TYPE_NAMES, SCENE_MAX_TYPES,
  draftOf, droppedTypes, forgetMigrations, isPresetEdited, keepMigrations, isPresetScene, memoryCountOf, nextSceneId, pendingNames, removeType,
  renameMigrations, renameType, sceneTypes, scenesUsing, validateSceneDraft, validateTypeDraft,
  type CustomType, type CustomTypeDraft, type MigrationAction, type Migrations, type Scene, type SettingsFields,
} from './config.ts'
import { Dialog, TextField } from './controls.tsx'
import { TypeFormFields } from './CustomTypes.tsx'

type Pool = Pick<SettingsFields, 'scenes' | 'customTypes'>

const KNOWN_TYPES: ReadonlySet<string> = new Set([...BUILTIN_TYPE_NAMES, ...PRESET_TYPE_NAMES, ...RETIRED_TYPE_NAMES])
const BUILTIN: readonly string[] = BUILTIN_TYPE_NAMES

/** 类型在界面上的名字：自建的取它的中文名，内置、预设、退役的取 locale，都不是就是英文名。 */
export function typeLabel(t: Translate, name: string, customTypes: Readonly<Record<string, CustomType>>): string {
  if (Object.hasOwn(customTypes, name)) return customTypes[name]!.label
  return KNOWN_TYPES.has(name) ? t(`sidebar.type.${name}` as LocaleKey) : name
}

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
  const label = (name: string) => typeLabel(t, name, customTypes)
  const builtin = names.filter(n => BUILTIN.includes(n))
  const parts = builtin.length === BUILTIN.length ? [t('settings.scene.generalTypes')] : builtin.length > 0 ? [builtin.map(label).join(t('settings.scene.listSep'))] : []
  return [...parts, ...names.filter(n => !BUILTIN.includes(n)).map(label)].join(t('settings.scene.groupSep'))
}

type DialogMode = { kind: 'scene'; id?: string } | { kind: 'manage' } | { kind: 'type'; name: string }

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
  const [removing, setRemoving] = useState<string | undefined>(undefined)
  const ids = Object.keys(fields.scenes)
  const remaining = Math.max(0, MAX_SCENES - ids.length)
  const hint = t('settings.scene.hint', { name: sceneLabel(t, fields.template, fields.scenes), n: sceneTypes(fields, fields.template).length })
  const dropped = droppedTypes(saved, fields, migrations)
  const customNames = Object.keys(fields.customTypes)

  const removeScene = (sceneId: string) => {
    const { [sceneId]: _removed, ...scenes } = fields.scenes
    setRemoving(undefined)
    onChange({ scenes, ...(fields.template === sceneId ? { template: GENERAL_SCENE } : {}) })
  }
  const row = (sceneId: string) => {
    const name = sceneLabel(t, sceneId, fields.scenes)
    const isSelected = fields.template === sceneId
    const scene = sceneId === GENERAL_SCENE ? undefined : fields.scenes[sceneId]
    const isEdited = scene !== undefined && isPresetEdited(sceneId, scene)
    const types = sceneTypes(fields, sceneId)
    const radioId = `${id}-${sceneId}`
    return (
      <li key={sceneId} className={isSelected ? 'pm-scene pm-scene--selected' : 'pm-scene'}>
        <input
          type="radio" id={radioId} name={`${id}-scene`} className="pm-scene-radio" checked={isSelected} disabled={disabled}
          aria-label={name} aria-describedby={`${radioId}-types`}
          onChange={() => { onChange({ template: sceneId }) }}
        />
        <label className="pm-scene-text" htmlFor={radioId}>
          <span className="pm-scene-name">{name}{isEdited ? <span className="pm-scene-tag">{t('settings.scene.edited')}</span> : null}</span>
          <span className="pm-scene-types" id={`${radioId}-types`}>
            {sceneId === GENERAL_SCENE ? types.map(n => typeLabel(t, n, fields.customTypes)).join(t('settings.scene.listSep')) : typesSummary(t, types, fields.customTypes)}
          </span>
        </label>
        {scene === undefined
          ? null
          : removing === sceneId
            ? (
              <LinkConfirm
                question={t(isSelected ? 'settings.scene.removeCurrent' : 'settings.scene.removeQuestion', { name })}
                actions={[{ label: t('settings.scene.removeConfirm'), onClick: () => { removeScene(sceneId) } }]}
                cancelLabel={t('settings.scene.cancel')}
                onCancel={() => { setRemoving(undefined) }}
              />
            )
            : (
              <span className="pm-scene-actions">
                {isEdited && isPresetScene(sceneId)
                  ? (
                    <Button variant="quiet" disabled={disabled} aria-label={t('settings.scene.resetAria', { name })}
                      onClick={() => { onChange({ scenes: { ...fields.scenes, [sceneId]: { ...scene, types: [...PRESET_SCENES[sceneId].types] } } }) }}>
                      {t('settings.scene.reset')}
                    </Button>
                  )
                  : null}
                <Button variant="quiet" disabled={disabled} aria-label={t('settings.scene.editAria', { name })}
                  onClick={() => { setDialog({ kind: 'scene', id: sceneId }) }}>{t('settings.scene.edit')}</Button>
                <Button variant="quiet" disabled={disabled} aria-label={t('settings.scene.removeAria', { name })}
                  onClick={() => { setRemoving(sceneId) }}>{t('settings.scene.remove')}</Button>
              </span>
            )}
      </li>
    )
  }

  return (
    <div className="pm-scenes">
      <ul className="pm-scene-list" role="radiogroup" aria-label={t('settings.scene.label')}>
        {[GENERAL_SCENE, ...ids].map(row)}
      </ul>
      <div className="pm-scene-add">
        <Button disabled={disabled || remaining === 0} onClick={() => { setDialog({ kind: 'scene' }) }}>{t('settings.scene.add')}</Button>
        <span className="pm-setting-hint">{t('settings.scene.remaining', { n: remaining })}</span>
      </div>
      <p className="pm-setting-hint">
        {dropped.length > 0
          ? t('settings.scene.hintChanged', { hint, drop: t('settings.scene.dropHint', { types: typeNames(t, dropped.map(n => typeLabel(t, n, saved.customTypes))) }) })
          : hint}
      </p>
      <p className="pm-scene-overview">
        {customNames.length > 0
          ? (
            <>
              {t('settings.types.overview')}
              {customNames.map((name, i) => (
                <Fragment key={name}>
                  {i > 0 ? t('settings.scene.listSep') : null}
                  <button type="button" className="pm-scene-type-link" disabled={disabled} onClick={() => { setDialog({ kind: 'type', name }) }}>
                    {fields.customTypes[name]!.label}
                  </button>
                </Fragment>
              ))}
              <span className="pm-scene-meta">{t('settings.types.shared')}</span>
            </>
          )
          : <span className="pm-scene-meta">{t('settings.types.none')}</span>}
        <button type="button" className="pm-link pm-scene-manage" disabled={disabled} onClick={() => { setDialog({ kind: 'manage' }) }}>{t('settings.types.manage')}</button>
      </p>
      {dialog !== undefined
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
    </div>
  )
}

type View =
  | { kind: 'pick' }
  | { kind: 'manage' }
  /** original：编辑的类型原来的英文名，新建时 undefined；isAsking：改名时正在问旧记忆怎么办。 */
  | { kind: 'form'; original: string | undefined; draft: CustomTypeDraft; attempted: boolean; isAsking: boolean }

type FormView = Extract<View, { kind: 'form' }>

function SceneDialog({ mode, fields, saved, migrations: initialMigrations, counts, canMigrate, now, onCancel, onCommit }: {
  mode: DialogMode
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
    kind: 'form', original: name, draft: name === undefined ? EMPTY_TYPE_DRAFT : draftOf(name, customTypes[name]!), attempted: false, isAsking: false,
  })
  const home: View = mode.kind === 'manage' ? { kind: 'manage' } : { kind: 'pick' }
  const [pool, setPool] = useState<Pool>({ scenes: fields.scenes, customTypes: fields.customTypes })
  const [migrations, setMigrations] = useState(initialMigrations)
  const [scene, setScene] = useState<Scene>(() => editingId !== undefined
    ? { label: fields.scenes[editingId]!.label, types: [...fields.scenes[editingId]!.types] }
    : { label: '', types: [...BUILTIN_TYPE_NAMES] })
  const [isSceneAttempted, setSceneAttempted] = useState(false)
  const [view, setView] = useState<View>(() => mode.kind === 'type' ? formFor(fields.customTypes, mode.name) : home)
  const [removing, setRemoving] = useState<string | undefined>(undefined)
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

  const isPooled = (name: string) => BUILTIN.includes(name) || (PRESET_TYPE_NAMES as readonly string[]).includes(name) || Object.hasOwn(pool.customTypes, name)
  const selected = scene.types.filter(isPooled)
  const isFull = selected.length >= SCENE_MAX_TYPES
  const label = (name: string) => typeLabel(t, name, pool.customTypes)
  const sceneName = (sid: string) => sceneLabel(t, sid, pool.scenes)
  const countOf = (name: string): number | undefined => counts === undefined ? undefined : memoryCountOf(name, migrations, counts)
  /** 条数读不到时：配置里已有的类型、或有记忆改名迁到它的，按存过记忆处理；这次弹层里新建的没有。 */
  const hasMemories = (name: string): boolean => {
    const n = countOf(name)
    if (n !== undefined) return n > 0
    return Object.hasOwn(saved.customTypes, name) || Object.values(migrations).some(m => m.action === 'retype' && m.to === name)
  }

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
    names: [...PRESET_TYPE_NAMES.filter(n => n !== original), ...Object.keys(pool.customTypes).filter(n => n !== original)],
    labels: [
      ...[...BUILTIN, ...PRESET_TYPE_NAMES].filter(n => !Object.hasOwn(pool.customTypes, n)).map(label),
      ...Object.entries(pool.customTypes).filter(([n]) => n !== original).map(([, type]) => type.label),
    ],
    pending: pendingNames(migrations, original),
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
      finishForm({ ...pool, customTypes: { ...pool.customTypes, [name]: type } }, scene, migrations)
    } else if (!hasMemories(form.original)) {
      rename(form.original, name, type)
    } else {
      setView({ ...form, isAsking: true })
    }
  }

  /** 删掉它会让哪个别的场景一类不剩（正在编辑的场景不算，至少一类由确定时的校验管）。 */
  const emptiedBy = (name: string) => Object.entries(pool.scenes)
    .find(([sid, s]) => sid !== editingId && s.types.includes(name) && s.types.filter(n => n !== name && isPooled(n)).length === 0)?.[0]
  const remove = (name: string, action: 'keep' | 'forget') => {
    setPool(removeType(pool, name))
    setScene({ ...scene, types: scene.types.filter(n => n !== name) })
    setMigrations(action === 'forget' ? forgetMigrations(migrations, name, counts) : keepMigrations(migrations, name))
    setRemoving(undefined)
  }
  const removeConfirm = (name: string) => {
    const blocking = emptiedBy(name)
    if (blocking !== undefined) {
      return (
        <LinkConfirm question={t('settings.type.removeBlocked', { scene: sceneName(blocking) })} actions={[]}
          cancelLabel={t('settings.scene.cancel')} onCancel={() => { setRemoving(undefined) }} block />
      )
    }
    const users = scenesUsing(pool.scenes, name).filter(sid => sid !== editingId).map(sceneName)
    const n = countOf(name)
    const isUsed = hasMemories(name)
    const text = [
      t('settings.type.removeQuestion', { label: label(name) }),
      users.length > 0 ? t(mode.kind === 'scene' ? 'settings.type.removeAlsoUsed' : 'settings.type.removeUsed', { scenes: users.join(t('settings.scene.listSep')) }) : '',
      isUsed ? n !== undefined ? t('settings.type.removeMemories', { n }) : t('settings.type.removeMemoriesUnknown') : '',
    ].join('')
    return (
      <LinkConfirm
        question={text}
        note={isUsed && !canMigrate ? t('settings.type.noSession') : undefined}
        actions={isUsed
          ? [
            { label: t('settings.type.keep'), onClick: () => { remove(name, 'keep') } },
            { label: t('settings.type.forget'), onClick: () => { remove(name, 'forget') }, disabled: !canMigrate },
          ]
          : [{ label: t('settings.type.removeConfirm'), onClick: () => { remove(name, 'keep') } }]}
        cancelLabel={t('settings.scene.cancel')}
        onCancel={() => { setRemoving(undefined) }}
        block
      />
    )
  }
  const typeActions = (name: string) => (
    <span className="pm-scene-actions">
      <Button variant="quiet" aria-label={t('settings.types.editAria', { name: label(name) })}
        onClick={() => { setRemoving(undefined); setView(formFor(pool.customTypes, name)) }}>{t('settings.types.edit')}</Button>
      <Button variant="quiet" aria-label={t('settings.types.removeAria', { name: label(name) })}
        onClick={() => { setRemoving(name) }}>{t('settings.types.remove')}</Button>
    </span>
  )
  const addType = <button type="button" className="pm-link pm-scene-add-type" onClick={() => { setRemoving(undefined); setNotice(undefined); setView(formFor(pool.customTypes)) }}>{t('settings.types.add')}</button>

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
    content = <TypeFormFields draft={form.draft} errors={errors} onChange={set} />
    if (form.isAsking && form.original !== undefined) {
      const original = form.original
      const n = countOf(original)
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
  } else if (view.kind === 'manage') {
    title = t('settings.types.manageTitle')
    const names = Object.keys(pool.customTypes)
    content = (
      <>
        <p className="pm-setting-hint">{t('settings.types.manageIntro')}</p>
        <div className="pm-scene-group">
          {names.map((name) => {
            const users = scenesUsing(pool.scenes, name).map(sceneName)
            const n = countOf(name)
            return (
              <Fragment key={name}>
                <div className="pm-scene-check">
                  <span className="pm-scene-check-label">{label(name)}</span>
                  <code className="pm-scene-code">{name}</code>
                  <span className="pm-scene-meta">
                    {users.length > 0 ? t('settings.types.usedBy', { names: users.join(t('settings.scene.listSep')) }) : t('settings.types.unused')}
                    {n !== undefined ? ` · ${t('settings.types.count', { n })}` : ''}
                  </span>
                  {typeActions(name)}
                </div>
                {removing === name ? removeConfirm(name) : null}
              </Fragment>
            )
          })}
          {addType}
        </div>
      </>
    )
    footer = (
      <>
        <Button onClick={onCancel}>{t('settings.sceneDialog.cancel')}</Button>
        <Button variant="primary" onClick={() => { onCommit(pool, migrations) }}>{t('settings.types.done')}</Button>
      </>
    )
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
    const presets = PRESET_TYPE_NAMES.filter(n => !Object.hasOwn(pool.customTypes, n))
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
          {Object.keys(pool.customTypes).map(name => check(name, true))}
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

/**
 * 原位确认，链接样式（同记忆删除的「删除 · 取消」）：问句、动作、取消；Esc 取消且不关掉外层弹层。
 * block：整块显示在行下面（删类型时文字长）。
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
      <span id={questionId} className="pm-scene-confirm-text">{question}</span>
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
.pm-scenes { display: flex; flex-direction: column; align-self: stretch; gap: 10px; }
.pm-scene-list { margin: 0; padding: 0; list-style: none; border: .5px solid var(--pm-line-card); border-radius: var(--dsw-radius-md, 12px); overflow: hidden; }
.pm-scene { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; }
.pm-scene + .pm-scene { border-top: .5px solid var(--pm-line); }
.pm-scene--selected { background: var(--pm-bg-block); }
.pm-scene-radio { flex: none; margin: 3px 0 0; accent-color: var(--pm-text); }
.pm-scene-text { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; cursor: pointer; }
.pm-scene-name { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; line-height: 1.5; color: var(--pm-text); }
.pm-scene-tag { padding: 0 7px; border-radius: 999px; background: var(--pm-bg-block); font-size: 11px; font-weight: 400; line-height: 18px; color: var(--pm-text-2); }
.pm-scene--selected .pm-scene-tag { background: var(--pm-bg); }
.pm-scene-types { font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-scene-actions { margin-left: auto; display: inline-flex; flex: none; gap: 4px; }
.pm-scene-add { display: flex; align-items: center; gap: 8px; }
.pm-scene-overview { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 2px; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-scene-type-link {
  padding: 0; border: 0; background: none; font: inherit; color: var(--pm-text); cursor: pointer;
  text-decoration: underline; text-decoration-color: var(--pm-line-input); text-underline-offset: 3px;
}
.pm-scene-type-link:disabled { cursor: default; color: var(--pm-text-3); }
.pm-scene-meta { margin-left: 6px; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-scene-overview > .pm-scene-meta:first-child { margin-left: 0; }
.pm-scenes .pm-scene-manage { margin-left: 12px; font-size: 12px; }
.pm-scene-view { display: flex; flex-direction: column; gap: 14px; }
.pm-scene-group { display: flex; flex-direction: column; }
.pm-scene-group-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 12px; font-weight: 600; line-height: 1.5; color: var(--pm-text-2); }
.pm-scene-group-head .pm-scene-meta { font-weight: 400; }
.pm-scene-check { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.pm-scene-check input { flex: none; margin: 0; accent-color: var(--pm-text); }
.pm-scene-check input:disabled + label { color: var(--pm-text-3); }
.pm-scene-check-label { font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-scene-check .pm-scene-meta { margin-left: 0; }
.pm-scene-code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; color: var(--pm-text-3); }
.pm-scene-add-type { align-self: flex-start; margin-top: 4px; font-size: 13px; }
.pm-scene-foot-note { margin-right: auto; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-scene-confirm { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-left: auto; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-scene-confirm--block { display: flex; margin: 2px 0 6px 23px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-scene-confirm-note { flex-basis: 100%; color: var(--pm-text-3); }
.pm-scene-confirm-actions { display: inline-flex; align-items: center; gap: 8px; }
.pm-scene-confirm .pm-link { font-size: 12px; }
.pm-scene-confirm .pm-link:disabled { color: var(--pm-text-3); cursor: default; text-decoration: none; }
.pm-scene-confirm .pm-sep { margin: 0 -2px; font-style: normal; }
.pm-scene-confirm .pm-scene-confirm-cancel { font-weight: 400; color: var(--pm-text-2); }
.pm-scene-ask { display: flex; flex: 1; flex-direction: column; gap: 8px; }
.pm-scene-ask-text { margin: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); }
.pm-scene-ask-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
`

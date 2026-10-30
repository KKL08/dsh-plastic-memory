/**
 * 设置页的配置模型（纯函数）：宿主 ConfigForm 的结构子集、插件配置段的形状、草稿 → 写入操作、校验。
 * 配置段形状对照 src/index.ts 的 Config schema（客户端只许 import src/gui/contract，这里手写一份）；
 * 只有 `.volatile()` 字段进表单，memoryRoot 只读显示，writeMode 不进。
 */

/** profile 里本插件那一行的 id（cordis.patch.yml insert 的 id），即 configForms 的 entryId。 */
export const ENTRY_ID = 'plastic-memory'

/** plugins.bundle.config 按包名 key。 */
export const PACKAGE_NAME = 'dsh-plastic-memory'

// —— 宿主 ConfigForm 的结构子集：定义在 host.ts，这里转出给设置页用 ——

import type { ConfigPathOp } from '../host.ts'

export type { ConfigForm, ConfigFormSnapshot, ConfigPathOp } from '../host.ts'

// —— 配置段 ——

import { GENERAL_SCENE, MAX_SCENES, SCENE_MAX_TYPES } from '../../src/gui/contract.ts'

export { GENERAL_SCENE, MAX_SCENES, SCENE_MAX_TYPES }

/** 内置五类的英文名，也是通用场景的组成（src/type-registry.ts BUILTIN_TYPES，tests/client-settings-mirror.spec.ts 守一致）。自定义类型不能重名。 */
export const BUILTIN_TYPE_NAMES = ['profile', 'preference', 'knowledge', 'project', 'reference'] as const
/** 预设两类（src/type-registry.ts PRESET_TYPES，镜像测试守一致）。 */
export const PRESET_TYPE_NAMES = ['procedure', 'decision'] as const
/** 退役类型：旧记忆照常读，不能再新增，类型清单里不出现（src/type-registry.ts RETIRED_TYPES，镜像测试守一致）。 */
export const RETIRED_TYPE_NAMES = ['commitment', 'person'] as const

/** 场景：名字 + 组成（含通用类型，顺序无意义，按类型池顺序排）。 */
export interface Scene {
  label: string
  types: string[]
}

export type PresetSceneId = 'coding' | 'office'
/** 编码、办公的出厂组成（src/type-registry.ts PRESET_SCENES，镜像测试守一致）。界面上的名字取 locale，不读这里的 label。 */
export const PRESET_SCENES: Record<PresetSceneId, Scene> = {
  coding: { label: '编码', types: [...BUILTIN_TYPE_NAMES, 'procedure'] },
  office: { label: '办公', types: [...BUILTIN_TYPE_NAMES, 'decision'] },
}

export function isPresetScene(id: string): id is PresetSceneId {
  return Object.hasOwn(PRESET_SCENES, id)
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every(x => set.has(x))
}

/** 编码、办公改过没有：组成和出厂组成的集合不同（「已改」标记、「恢复默认」据此显示）。 */
export function isPresetEdited(id: string, scene: Scene): boolean {
  return isPresetScene(id) && !sameSet(scene.types, PRESET_SCENES[id].types)
}

/** 类型池，按池顺序：内置五类 → 预设两类 → 自建类型（和预设同名的自建类型占预设的位置）。 */
export function typePool(customTypes: Readonly<Record<string, unknown>>): string[] {
  const fixed: readonly string[] = [...BUILTIN_TYPE_NAMES, ...PRESET_TYPE_NAMES]
  return [...fixed, ...Object.keys(customTypes).filter(name => !fixed.includes(name))]
}

/**
 * 场景实际生效的类型，同服务端解析（src/type-registry.ts buildTypeRegistry）：取组成与类型池的交集、按池顺序、超过上限截断；
 * 通用、不存在的场景、交集为空都按通用五类。
 */
export function sceneTypes(fields: Pick<SettingsFields, 'scenes' | 'customTypes'>, id: string): string[] {
  const scene = id === GENERAL_SCENE || !Object.hasOwn(fields.scenes, id) ? undefined : fields.scenes[id]
  const picked = scene === undefined ? [] : typePool(fields.customTypes).filter(name => scene.types.includes(name)).slice(0, SCENE_MAX_TYPES)
  return picked.length > 0 ? picked : [...BUILTIN_TYPE_NAMES]
}

/**
 * 保存后不再新增的类型：已存的当前场景有、草稿的当前场景没有的那几类。改名跟着迁过去的按新名字算，不算少掉。
 * @param migrations 草稿里的类型迁移（见 Migrations）。
 */
export function droppedTypes(saved: SettingsFields, draft: SettingsFields, migrations: Migrations = {}): string[] {
  const next = new Set(sceneTypes(draft, draft.template))
  return sceneTypes(saved, saved.template).filter((name) => {
    const m = migrations[name]
    // 要移到最近删除的不算：说明里写的「已有的仍会带入」对它不成立，去向由确认框的迁移行写
    if (m?.action === 'forget') return false
    return !next.has(m?.action === 'retype' ? m.to : name)
  })
}

/** 用了哪些场景（id，按配置顺序）的组成里有这一类。 */
export function scenesUsing(scenes: Readonly<Record<string, Scene>>, name: string): string[] {
  return Object.entries(scenes).filter(([, scene]) => scene.types.includes(name)).map(([id]) => id)
}

/**
 * 新建场景的 id：`scene-` 加创建时刻毫秒数的 36 进制，撞上已有 id 时顺延一毫秒。时间派生，删掉的 id 不会再生成
 * （项目级模板会引用场景 id）。
 */
export function nextSceneId(taken: readonly string[], now: number): string {
  let at = now
  while (taken.includes(`scene-${at.toString(36)}`)) at += 1
  return `scene-${at.toString(36)}`
}

export type SceneError = 'required' | 'label-taken' | 'types-empty'

/**
 * 校验场景弹层的草稿：名字必填、去掉首尾空白后不和其他场景重名；至少勾一类（勾满上限后界面置灰，到不了上限之外）。
 * @param otherLabels 其他场景在界面上的名字（含通用、编码、办公）。
 */
export function validateSceneDraft(draft: Scene, otherLabels: readonly string[]):
  { ok: true; scene: Scene } | { ok: false; errors: { label?: SceneError; types?: SceneError } } {
  const errors: { label?: SceneError; types?: SceneError } = {}
  const label = draft.label.trim()
  if (label === '') errors.label = 'required'
  else if (otherLabels.some(other => other.trim() === label)) errors.label = 'label-taken'
  if (draft.types.length === 0) errors.types = 'types-empty'
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, scene: { label, types: draft.types } }
}

/** 场景的改动（id）：新增、修改、删除（保存确认弹窗用）。 */
export function sceneChanges(saved: Readonly<Record<string, Scene>>, draft: Readonly<Record<string, Scene>>):
  { added: string[]; edited: string[]; removed: string[] } {
  const added: string[] = []
  const edited: string[] = []
  for (const [id, scene] of Object.entries(draft)) {
    const before = Object.hasOwn(saved, id) ? saved[id] : undefined
    if (before === undefined) added.push(id)
    else if (!sameScene(before, scene)) edited.push(id)
  }
  return { added, edited, removed: Object.keys(saved).filter(id => !Object.hasOwn(draft, id)) }
}

function sameScene(a: Scene, b: Scene): boolean {
  return a.label === b.label && sameSet(a.types, b.types)
}

// —— 类型迁移 ——

/** 改名、删除自建类型时对已有记忆的处理：跟着改名，或移到最近删除。保存时在写配置之后经 `migrate-type` 执行。 */
export type MigrationAction = { action: 'retype'; to: string } | { action: 'forget' }
/**
 * 草稿里的类型迁移，按已有记忆当前的类型名（原名）记。改名后又改回原名、改名后又删掉的，合并成最终动作；
 * 一个原名在迁移中时，别的类型不能占用它（validateTypeDraft 的 pending），所以迁移之间没有先后依赖。
 */
export type Migrations = Readonly<Record<string, MigrationAction>>

/** 保存后会落在 name 下的原名：自己（没迁走时）和改名迁到它的。给了条数时只算有记忆的；条数读不到时都算。 */
function sourcesOf(name: string, migrations: Migrations, counts?: ReadonlyMap<string, number>): string[] {
  const moved = Object.entries(migrations).filter(([, m]) => m.action === 'retype' && m.to === name).map(([from]) => from)
  const sources = Object.hasOwn(migrations, name) ? moved : [name, ...moved]
  return counts === undefined ? sources : sources.filter(from => (counts.get(from) ?? 0) > 0)
}

/** 保存后这一类名下的记忆条数（在用的加最近删除里的）：按迁移把原名的条数归过来。 */
export function memoryCountOf(name: string, migrations: Migrations, counts: ReadonlyMap<string, number>): number {
  return sourcesOf(name, migrations).reduce((sum, from) => sum + (counts.get(from) ?? 0), 0)
}

/**
 * 这一类改名为 to：落在它名下的记忆跟着改名（retype），或移到最近删除（forget）。改回原名的那条迁移去掉。
 * @param counts 各原名的记忆条数（在用的加最近删除里的），没有记忆的原名不记迁移；读不到时传 undefined，按都有记忆处理。
 */
export function renameMigrations(migrations: Migrations, from: string, to: string, action: MigrationAction['action'], counts: ReadonlyMap<string, number> | undefined): Migrations {
  const next: Record<string, MigrationAction> = { ...migrations }
  for (const source of sourcesOf(from, migrations, counts)) {
    if (action === 'forget') next[source] = { action: 'forget' }
    else if (source === to) delete next[source]
    else next[source] = { action: 'retype', to }
  }
  return next
}

/** 删除这一类、记忆移到最近删除。 */
export function forgetMigrations(migrations: Migrations, name: string, counts: ReadonlyMap<string, number> | undefined): Migrations {
  return renameMigrations(migrations, name, name, 'forget', counts)
}

/** 删除这一类、保留记忆：改名迁到它的那些不再迁，记忆留在原名下。 */
export function keepMigrations(migrations: Migrations, name: string): Migrations {
  return Object.fromEntries(Object.entries(migrations).filter(([, m]) => m.action !== 'retype' || m.to !== name))
}

/** 迁移中的原名（保存前旧记忆还挂在这些名字下），除了 name 自己名下的。新建、改名时不能占用。 */
export function pendingNames(migrations: Migrations, name?: string): string[] {
  const own = name === undefined ? [] : sourcesOf(name, migrations)
  return Object.keys(migrations).filter(from => !own.includes(from))
}

/** 自建类型改名：保持在列表里的位置，场景组成里一并换成新名字。 */
export function renameType(pool: Pick<SettingsFields, 'scenes' | 'customTypes'>, from: string, to: string, type: CustomType):
  Pick<SettingsFields, 'scenes' | 'customTypes'> {
  const customTypes = Object.fromEntries(Object.entries(pool.customTypes).map(([name, t]) => name === from ? [to, type] : [name, t]))
  const scenes = Object.fromEntries(Object.entries(pool.scenes).map(([id, scene]) =>
    [id, scene.types.includes(from) ? { ...scene, types: scene.types.map(name => name === from ? to : name) } : scene]))
  return { scenes, customTypes }
}

/** 删掉自建类型，场景组成里一并去掉。 */
export function removeType(pool: Pick<SettingsFields, 'scenes' | 'customTypes'>, name: string): Pick<SettingsFields, 'scenes' | 'customTypes'> {
  const { [name]: _removed, ...customTypes } = pool.customTypes
  const scenes = Object.fromEntries(Object.entries(pool.scenes).map(([id, scene]) =>
    [id, scene.types.includes(name) ? { ...scene, types: scene.types.filter(n => n !== name) } : scene]))
  return { scenes, customTypes }
}

export const OVERFLOW_MODES = ['relax', 'strict'] as const
export const EVIDENCE_LEVELS = ['off', 'strict', 'active'] as const
export const SENSITIVITIES = ['conservative', 'normal', 'proactive'] as const
export const PROMOTE_TARGETS = ['plugin-global', 'agents-md'] as const
export const RECALL_MODES = ['core', 'search', 'passive'] as const
export const PRIORITIES = ['high', 'medium', 'low'] as const

export interface CustomType {
  label: string
  description: string
  whenToSave: string
  recall: (typeof RECALL_MODES)[number]
  decayDays: number | null
  governancePriority: (typeof PRIORITIES)[number]
}

/** 提醒灵敏度三档的数值（src/governance/health-presets.ts 的健康分阈值与冲突逾期天数，tests/client-settings-mirror.spec.ts 守一致）。 */
export const SENSITIVITY_NUMBERS: Record<(typeof SENSITIVITIES)[number], { score: number; days: number }> = {
  conservative: { score: 60, days: 14 },
  normal: { score: 70, days: 7 },
  proactive: { score: 80, days: 3 },
}

/** 表单编辑的字段（拍平）。上限存草稿原文，保存时才转数字。 */
export interface SettingsFields {
  /** 当前场景 id。 */
  template: string
  scenes: Record<string, Scene>
  customTypes: Record<string, CustomType>
  budget: string
  overflow: (typeof OVERFLOW_MODES)[number]
  evidence: (typeof EVIDENCE_LEVELS)[number]
  sensitivity: (typeof SENSITIVITIES)[number]
  promoteTarget: (typeof PROMOTE_TARGETS)[number]
}

/** 各字段在配置段里的路径（scenes、customTypes 按键逐条写，见 buildOps）。用户词典路径不进表单：只在配置文件或对话里改。 */
const PATHS: Record<Exclude<keyof SettingsFields, 'scenes' | 'customTypes'>, string[]> = {
  template: ['template'],
  budget: ['snapshotTokenBudget'],
  overflow: ['snapshotOverflow'],
  evidence: ['evidenceLookup'],
  sensitivity: ['governance', 'health', 'sensitivity'],
  promoteTarget: ['governance', 'globalPromoteTarget'],
}

const DEFAULTS: SettingsFields = {
  template: 'coding', scenes: PRESET_SCENES, customTypes: {}, budget: '4000', overflow: 'relax', evidence: 'strict',
  sensitivity: 'normal', promoteTarget: 'plugin-global',
}

function at(value: unknown, path: readonly string[]): unknown {
  let cur = value
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function oneOf<T extends string>(choices: readonly T[], value: unknown, fallback: T): T {
  return choices.includes(value as T) ? value as T : fallback
}

/** 配置段里的 scenes：结构不对的项跳过；整段取不到时用出厂的编码、办公。 */
function scenesOf(value: unknown): Record<string, Scene> {
  if (typeof value !== 'object' || value === null) return structuredClone(PRESET_SCENES)
  const scenes: Record<string, Scene> = {}
  for (const [id, scene] of Object.entries(value as Record<string, unknown>)) {
    const label = at(scene, ['label'])
    const types = at(scene, ['types'])
    if (id === GENERAL_SCENE || typeof label !== 'string' || !Array.isArray(types)) continue
    scenes[id] = { label, types: types.filter((name): name is string => typeof name === 'string') }
  }
  return scenes
}

/**
 * 配置段 → 表单字段。宿主给的是解析过的值，取不到时回落到 schema 默认值。
 * 当前场景指向不存在的场景时服务端按通用运行，这里也显示通用。
 */
export function fieldsOf(section: unknown): SettingsFields {
  const budget = at(section, PATHS.budget)
  const types = at(section, ['customTypes'])
  const template = at(section, PATHS.template)
  const scenes = scenesOf(at(section, ['scenes']))
  return {
    template: typeof template !== 'string' || template === '' ? DEFAULTS.template
      : template === GENERAL_SCENE || Object.hasOwn(scenes, template) ? template : GENERAL_SCENE,
    scenes,
    customTypes: typeof types === 'object' && types !== null ? types as Record<string, CustomType> : {},
    budget: typeof budget === 'number' ? String(budget) : DEFAULTS.budget,
    overflow: oneOf(OVERFLOW_MODES, at(section, PATHS.overflow), DEFAULTS.overflow),
    evidence: oneOf(EVIDENCE_LEVELS, at(section, PATHS.evidence), DEFAULTS.evidence),
    sensitivity: oneOf(SENSITIVITIES, at(section, PATHS.sensitivity), DEFAULTS.sensitivity),
    promoteTarget: oneOf(PROMOTE_TARGETS, at(section, PATHS.promoteTarget), DEFAULTS.promoteTarget),
  }
}

/** 体检开关 `governance.enabled`：只在配置文件里改，设置页只读它来置灰依赖体检的项。取不到时按 schema 默认开着。 */
export function governanceEnabled(section: unknown): boolean {
  return at(section, ['governance', 'enabled']) !== false
}

/** 配置里写的 memoryRoot（空 = 默认位置）。 */
export function configuredRoot(section: unknown): string {
  const root = at(section, ['memoryRoot'])
  return typeof root === 'string' ? root : ''
}

/** 正整数文本 → 数字；不是正整数为 undefined。 */
export function parsePositiveInt(text: string): number | undefined {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function sameType(a: CustomType | undefined, b: CustomType | undefined): boolean {
  return a !== undefined && b !== undefined && (Object.keys(b) as (keyof CustomType)[]).every(k => a[k] === b[k])
    && Object.keys(a).length === Object.keys(b).length
}

/**
 * 草稿 → 一次提交的操作。只写和已存值不同的字段；scenes、customTypes 按键 set / unset，不整段覆盖
 * （宿主 unset 字典里的键时从 schema 默认值起算再删，删掉的出厂场景不会被补回）。
 * 上限草稿不合法时返回 undefined（调用方不提交）。
 */
export function buildOps(saved: SettingsFields, draft: SettingsFields): ConfigPathOp[] | undefined {
  const ops: ConfigPathOp[] = []
  for (const key of Object.keys(PATHS) as (keyof typeof PATHS)[]) {
    if (draft[key] === saved[key]) continue
    if (key === 'budget') {
      const n = parsePositiveInt(draft.budget)
      if (n === undefined) return undefined
      if (String(n) !== saved.budget) ops.push({ op: 'set', path: PATHS.budget, value: n })
      continue
    }
    ops.push({ op: 'set', path: PATHS[key], value: draft[key] })
  }
  for (const [name, type] of Object.entries(draft.customTypes)) {
    if (!sameType(saved.customTypes[name], type)) ops.push({ op: 'set', path: ['customTypes', name], value: type })
  }
  for (const name of Object.keys(saved.customTypes)) {
    if (!(name in draft.customTypes)) ops.push({ op: 'unset', path: ['customTypes', name] })
  }
  const scenes = sceneChanges(saved.scenes, draft.scenes)
  for (const id of [...scenes.added, ...scenes.edited]) {
    ops.push({ op: 'set', path: ['scenes', id], value: { label: draft.scenes[id]!.label, types: [...draft.scenes[id]!.types] } })
  }
  for (const id of scenes.removed) ops.push({ op: 'unset', path: ['scenes', id] })
  return ops
}

/** 自定义类型的改动，按中文名汇总（保存确认弹窗用）：修改、新增取草稿里的名字，删除取已存的。 */
export function customTypeChanges(saved: SettingsFields['customTypes'], draft: SettingsFields['customTypes']):
  { added: string[]; edited: string[]; removed: string[] } {
  const added: string[] = []
  const edited: string[] = []
  for (const [name, type] of Object.entries(draft)) {
    if (!(name in saved)) added.push(type.label)
    else if (!sameType(saved[name], type)) edited.push(type.label)
  }
  const removed = Object.entries(saved).filter(([name]) => !(name in draft)).map(([, type]) => type.label)
  return { added, edited, removed }
}

// —— 自定义类型 ——

/** 弹层草稿：选择项未选时为空串，衰退天数是原文。 */
export interface CustomTypeDraft {
  name: string
  label: string
  description: string
  whenToSave: string
  recall: CustomType['recall'] | ''
  governancePriority: CustomType['governancePriority'] | ''
  decayDays: string
}

export type CustomTypeError = 'required' | 'name-format' | 'name-builtin' | 'name-taken' | 'name-pending' | 'label-taken' | 'decay-invalid'

/** 新增类型的初始草稿：召回方式、治理优先级预选「搜索」「中」，分段控件打开就有选中项（2026-10-25 用户定）。 */
export const EMPTY_TYPE_DRAFT: CustomTypeDraft = {
  name: '', label: '', description: '', whenToSave: '', recall: 'search', governancePriority: 'medium', decayDays: '',
}

export function draftOf(name: string, type: CustomType): CustomTypeDraft {
  return { name, ...type, decayDays: type.decayDays === null ? '' : String(type.decayDays) }
}

/**
 * 校验类型表单草稿。英文名：小写字母和连字符（types.ts 的类型标识符约定），不与内置类型、taken.names 重名，
 * 不占用迁移中的原名（旧记忆保存后才迁走）；中文名去掉首尾空白后不与 taken.labels 重复。退役类型不算重名：同名自建就是新类型。
 * @param taken names：预设和其他自建类型的英文名（编辑已有的、和预设同名的老类型时不含预设）；labels：类型池里其他类型的中文名；
 *   pending：迁移中的原名（见 pendingNames）。
 */
export function validateTypeDraft(draft: CustomTypeDraft, taken: { names: readonly string[]; labels: readonly string[]; pending?: readonly string[] }):
  { ok: true; name: string; type: CustomType } | { ok: false; errors: Partial<Record<keyof CustomTypeDraft, CustomTypeError>> } {
  const errors: Partial<Record<keyof CustomTypeDraft, CustomTypeError>> = {}
  const name = draft.name.trim()
  if (name === '') errors.name = 'required'
  else if (!/^[a-z]+(?:-[a-z]+)*$/.test(name)) errors.name = 'name-format'
  else if ((BUILTIN_TYPE_NAMES as readonly string[]).includes(name)) errors.name = 'name-builtin'
  else if (taken.names.includes(name)) errors.name = 'name-taken'
  else if (taken.pending?.includes(name) === true) errors.name = 'name-pending'
  if (draft.label.trim() !== '' && taken.labels.some(label => label.trim() === draft.label.trim())) errors.label = 'label-taken'
  for (const key of ['label', 'description', 'whenToSave', 'recall', 'governancePriority'] as const) {
    if (draft[key].trim() === '') errors[key] = 'required'
  }
  const decay = draft.decayDays.trim()
  const decayDays = decay === '' ? null : parsePositiveInt(decay)
  if (decayDays === undefined) errors.decayDays = 'decay-invalid'
  if (Object.keys(errors).length > 0 || draft.recall === '' || draft.governancePriority === '' || decayDays === undefined) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    name,
    type: {
      label: draft.label.trim(), description: draft.description.trim(), whenToSave: draft.whenToSave.trim(),
      recall: draft.recall, decayDays, governancePriority: draft.governancePriority,
    },
  }
}

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

/** 场景模板，也是设置页分段控件的顺序：通用排第一（2026-10-25 用户定）。custom 在界面上叫「通用」。 */
export const TEMPLATES = ['custom', 'coding', 'office'] as const
/** 各模板在通用五类之外多出的类型（src/type-registry.ts TEMPLATES，tests/client-settings-mirror.spec.ts 守一致）。 */
export const TEMPLATE_TYPES: Record<(typeof TEMPLATES)[number], readonly string[]> = {
  custom: [],
  coding: ['procedure'],
  office: ['decision', 'commitment', 'person'],
}

/** 从 from 切到 to 后不再新增的类型：from 独有、to 没有的那几类。通用五类始终都在。 */
export function droppedTypes(from: (typeof TEMPLATES)[number], to: (typeof TEMPLATES)[number]): string[] {
  return TEMPLATE_TYPES[from].filter(name => !TEMPLATE_TYPES[to].includes(name))
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
  template: (typeof TEMPLATES)[number]
  customTypes: Record<string, CustomType>
  budget: string
  overflow: (typeof OVERFLOW_MODES)[number]
  evidence: (typeof EVIDENCE_LEVELS)[number]
  governance: boolean
  sensitivity: (typeof SENSITIVITIES)[number]
  promoteTarget: (typeof PROMOTE_TARGETS)[number]
}

/** 各字段在配置段里的路径（customTypes 按键逐条写，见 buildOps）。 */
const PATHS: Record<Exclude<keyof SettingsFields, 'customTypes'>, string[]> = {
  template: ['template'],
  budget: ['snapshotTokenBudget'],
  overflow: ['snapshotOverflow'],
  evidence: ['evidenceLookup'],
  governance: ['governance', 'enabled'],
  sensitivity: ['governance', 'health', 'sensitivity'],
  promoteTarget: ['governance', 'globalPromoteTarget'],
}

const DEFAULTS: SettingsFields = {
  template: 'coding', customTypes: {}, budget: '4000', overflow: 'relax', evidence: 'strict',
  governance: true, sensitivity: 'normal', promoteTarget: 'plugin-global',
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

/** 配置段 → 表单字段。宿主给的是解析过的值，取不到时回落到 schema 默认值。 */
export function fieldsOf(section: unknown): SettingsFields {
  const budget = at(section, PATHS.budget)
  const enabled = at(section, PATHS.governance)
  const types = at(section, ['customTypes'])
  return {
    template: oneOf(TEMPLATES, at(section, PATHS.template), DEFAULTS.template),
    customTypes: typeof types === 'object' && types !== null ? types as Record<string, CustomType> : {},
    budget: typeof budget === 'number' ? String(budget) : DEFAULTS.budget,
    overflow: oneOf(OVERFLOW_MODES, at(section, PATHS.overflow), DEFAULTS.overflow),
    evidence: oneOf(EVIDENCE_LEVELS, at(section, PATHS.evidence), DEFAULTS.evidence),
    governance: typeof enabled === 'boolean' ? enabled : DEFAULTS.governance,
    sensitivity: oneOf(SENSITIVITIES, at(section, PATHS.sensitivity), DEFAULTS.sensitivity),
    promoteTarget: oneOf(PROMOTE_TARGETS, at(section, PATHS.promoteTarget), DEFAULTS.promoteTarget),
  }
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
 * 草稿 → 一次提交的操作。只写和已存值不同的字段；customTypes 按键 set / unset，不整段覆盖。
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

/** 内置五类的英文名（src/type-registry.ts BUILTIN_TYPES，tests/client-settings-mirror.spec.ts 守一致）。自定义类型不能重名。 */
export const BUILTIN_TYPE_NAMES = ['profile', 'preference', 'knowledge', 'project', 'reference'] as const

/** 弹层草稿：选择项未选时为空串，过期天数是原文。 */
export interface CustomTypeDraft {
  name: string
  label: string
  description: string
  whenToSave: string
  recall: CustomType['recall'] | ''
  governancePriority: CustomType['governancePriority'] | ''
  decayDays: string
}

export type CustomTypeError = 'required' | 'name-format' | 'name-builtin' | 'name-taken' | 'decay-invalid'

/** 新增类型的初始草稿：召回方式、治理优先级预选「搜索」「中」，分段控件打开就有选中项（2026-10-25 用户定）。 */
export const EMPTY_TYPE_DRAFT: CustomTypeDraft = {
  name: '', label: '', description: '', whenToSave: '', recall: 'search', governancePriority: 'medium', decayDays: '',
}

export function draftOf(name: string, type: CustomType): CustomTypeDraft {
  return { name, ...type, decayDays: type.decayDays === null ? '' : String(type.decayDays) }
}

/**
 * 校验弹层草稿。英文名：小写字母和连字符（types.ts 的类型标识符约定），不与内置类型、已有自定义类型重名。
 * @param taken 已有的自定义类型英文名（编辑时不含自己）。
 */
export function validateTypeDraft(draft: CustomTypeDraft, taken: readonly string[]):
  { ok: true; name: string; type: CustomType } | { ok: false; errors: Partial<Record<keyof CustomTypeDraft, CustomTypeError>> } {
  const errors: Partial<Record<keyof CustomTypeDraft, CustomTypeError>> = {}
  const name = draft.name.trim()
  if (name === '') errors.name = 'required'
  else if (!/^[a-z]+(?:-[a-z]+)*$/.test(name)) errors.name = 'name-format'
  else if ((BUILTIN_TYPE_NAMES as readonly string[]).includes(name)) errors.name = 'name-builtin'
  else if (taken.includes(name)) errors.name = 'name-taken'
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

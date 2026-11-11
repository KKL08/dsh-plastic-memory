/**
 * 配置模型（纯函数）：宿主 ConfigForm 的结构子集、插件配置段的形状、草稿 → 写入操作、校验，以及记忆页等界面读的那几项（toPluginConfig）。
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

import { ACCENTS, GENERAL_SCENE, MAX_SCENES, SCENE_MAX_TYPES } from '../../src/gui/contract.ts'

export { ACCENTS, GENERAL_SCENE, MAX_SCENES, SCENE_MAX_TYPES }

/** 内置五类的英文名，也是通用场景的组成（src/type-registry.ts BUILTIN_TYPES，tests/client-settings-mirror.spec.ts 守一致）。自定义类型不能重名。 */
export const BUILTIN_TYPE_NAMES = ['profile', 'preference', 'knowledge', 'project', 'reference'] as const
/** 预设两类（src/type-registry.ts PRESET_TYPES，镜像测试守一致）。 */
export const PRESET_TYPE_NAMES = ['procedure', 'decision'] as const
/** 退役类型：旧记忆照常读，不能再新增，类型清单里不出现（src/type-registry.ts RETIRED_TYPES，镜像测试守一致）。 */
export const RETIRED_TYPE_NAMES = ['commitment', 'person'] as const

export type PresetTypeName = (typeof PRESET_TYPE_NAMES)[number]

export function isPresetType(name: string): name is PresetTypeName {
  return (PRESET_TYPE_NAMES as readonly string[]).includes(name)
}

/**
 * 通用五类、预设两类的出厂定义（src/type-registry.ts BUILTIN_TYPES、PRESET_TYPES，镜像测试守一致）：
 * 通用类型「查看」、编辑预设时预填、判断预设改没改过。文字是模型看到的原文，不随界面语言变。
 */
export const TYPE_DEFINITIONS: Readonly<Record<(typeof BUILTIN_TYPE_NAMES)[number] | PresetTypeName, CustomType>> = {
  profile: {
    label: '用户画像',
    description: '用户本人相对稳定的情况：身份和角色、工作或学习背景、所在地区、语言习惯、日常生活里的习惯（作息、饮食、出行等）和家庭情况、个人兴趣、长期目标，以及对各类知识、技能和工具的熟悉程度。正文：写成「用户是…」「用户熟悉…」，同一方面的情况合成一条（工作背景一条、某项技能一条、所在地区一条），情况变了就更新原来那条。例：用户说「我在上海做平面设计，下班后在自学日语，目标是考过 N1」→ 记两条：「用户在上海从事平面设计」「用户在业余自学日语，目标是通过日语 N1 考试」',
    whenToSave: '用户说到自己的身份、工作或学习经历、所在地区、语言习惯、日常生活里的习惯（作息、饮食、出行等）、家庭情况、个人兴趣、长期目标；用户的话或实际表现体现出对某项知识或技能的熟悉程度（「这块我很熟」「第一次接触这个」）',
    howToUse: '按用户的情况调整回答：熟悉的领域直接给结论和关键细节，生疏的领域补上背景、术语先解释再用；举例、时间安排和用语贴合用户的背景、所在地和作息。',
    recall: 'core', decayDays: null, governancePriority: 'low',
  },
  preference: {
    label: '行为偏好',
    description: '用户对你做事方式的持续要求：在项目或任务里习惯用的做法、工具、交付格式、沟通方式等，来自用户直接提出、纠正或明确认可，以后同类事情都照这个做。正文：先写要求，写成「用户要求…」「用户希望…」；再写一句理由，用户没说理由就写当时在做什么；一条只写一项要求。例：用户说「以后帮我订酒店都挑带厨房的，出门在外我想自己做饭」→ 记「用户要求订酒店时选带厨房的；理由：出行时想自己做饭」',
    whenToSave: '用户提出一项以后都适用的要求（「以后都…」「每次…」）；用户纠正你的做法，并希望以后照新的来（「换成…」「下次别…」）；用户明确认可你的某个做法并希望保持（「对，以后就这样」）；用户反复改写、撤销或拒绝同一类做法',
    howToUse: '同类事情直接照做，不用再问；用户这次的话和这条不一致时，这次按用户的话做，用户表明以后都这样再更新这条。',
    recall: 'core', decayDays: null, governancePriority: 'medium',
  },
  knowledge: {
    label: '事实与经验',
    description: '经过确认、以后还会用到的事实和经验：规章制度、工具和设备的行为、查明的问题原因、验证过有效或行不通的做法。正文：写事实本身和它成立的条件（版本、环境、适用范围），能说出来源的写上来源（文档、报错、谁说的）；没找到、行不通这类结论写明在什么范围试过，推测的写明是推测。例：用户说「财务刚通知，25 号以后交的报销都算下个月」→ 记「公司报销每月 25 日截止，之后提交的计入下月（来源：财务通知）」',
    whenToSave: '确认了一条以后还会用到的规则或事实；查明了一个问题的原因；验证了某个做法有效或行不通；用户贴来的或你查到的资料（报错、接口结构、数据格式、文件内容）里有以后用得上的事实（记事实本身）',
    howToUse: '遇到同类问题先按这条判断，省掉重复排查；条件（版本、环境）和眼前对不上时，先核对再用。',
    recall: 'search', decayDays: 90, governancePriority: 'high',
  },
  project: {
    label: '项目信息',
    description: '进行中的项目或个人事项的当前情况：目标、范围、里程碑、截止日期、分工、当前采用的方案、进展和阻塞，会随事情推进变化。正文：写清状态和对应的具体日期；状态有变化时写明从什么变成什么、原因是什么。例：用户说「学院把答辩从 12 月 20 日提前到 12 月 10 日了，我得 11 月底前把初稿交给导师」→ 记「用户的毕业论文答辩从 12 月 20 日提前到 12 月 10 日（学院调整）；初稿须在 11 月 30 日前交给导师」',
    whenToSave: '项目或个人事项定下目标、范围或截止日期；里程碑完成；计划、分工或范围有变化；出现影响后续安排的进展或阻塞（用户告知，或你从资料、执行结果里确认）',
    howToUse: '用它理解当前请求所处的事项和约束（截止日期、范围、负责人）；这类信息变得快，标了「可能过时」的先核对再用。',
    recall: 'search', decayDays: 7, governancePriority: 'high',
  },
  reference: {
    label: '参考引用',
    description: '某类资料、文件、物品该去哪里找，某类问题该去问谁：所在的系统、文档、目录、频道、存放位置或对接人，以及那里有什么。正文：写位置（链接、路径、在系统里怎么找到，或东西放在哪）、里面有什么、什么时候该去看；标题写清是什么资料（如「支付接口文档」），注入时只显示标题和标签。例：用户说「接口文档在仓库的 docs/api 目录，第三方支付的接口说明看 https://pay.example.com/docs」→ 记两条：「项目接口文档在仓库 docs/api 目录，改接口前先看这里」「第三方支付接口说明在 https://pay.example.com/docs，对接支付时查这里」',
    whenToSave: '用户指明某类资料、文件、物品该去哪里找，或某类问题该去问谁；你找到了一个以后会反复用到的入口（文档、看板、目录）',
    howToUse: '用户提到相关的资料、物品或问题时，先用 memory_search 按 id 取出这条记下的位置，再去那里查；你去不了的位置（实物、别人的系统）告诉用户去哪里找。',
    recall: 'passive', decayDays: null, governancePriority: 'medium',
  },
  procedure: {
    label: '可复用流程',
    description: '实际用过、确认有效的多步骤做法：完成某类任务的顺序、关键命令或操作，以及容易出错的地方和解法。正文：先写适用的任务和前提，再按顺序写步骤，最后写容易出错的地方；步骤里写稳定的命令和位置。例：用户说「发版就按这个顺序，用了三次都顺：改版本号和 CHANGELOG，打包核对文件清单，再发布；刚发布装不上报 404 是正常的，等十分钟再试」→ 记「发布 npm 包的流程（已用三次）：改版本号和 CHANGELOG → 打包并核对文件清单 → 发布 → 等十分钟再验证安装；刚发布时安装报 404 属正常现象，稍等即可」',
    whenToSave: '同一套做法已经多次用下来都有效；用户要求以后照一套多步骤做法来做；做完一件复杂的事，其中的步骤、踩过的坑和解法实际验证有效',
    howToUse: '做同类任务前先照这条的步骤走；某一步和现状对不上（命令、路径变了）时，做完后更新这条。',
    recall: 'search', decayDays: 90, governancePriority: 'medium',
  },
  decision: {
    label: '决定',
    description: '有明确当事人的决定和承诺：谁定了什么、依据是什么；谁答应谁做什么、什么时候完成。正文：一条写一项决定或一项承诺，写清当事人、内容，以及依据或截止日期；决定改了就新记一条，用 supersedes 指向旧的那条。例：用户说「和财务经理定了，Q3 超支，Q4 外包预算先砍掉；他答应 11 月 7 日前把新预算表发我」→ 记两条：「用户与财务经理决定 Q4 取消外包预算（依据：Q3 超支）」「财务经理承诺 11 月 7 日前把新预算表发给用户」',
    whenToSave: '对话里或你查阅的资料（会议纪要、邮件、聊天记录）里出现一项定下来的决定（谁、定了什么、为什么），或一项承诺（谁答应谁、做什么、什么时候完成）',
    howToUse: '处理相关事项时按已定的决定和承诺来；用户问到时说明依据，并提到临近的截止日期。',
    recall: 'search', decayDays: 30, governancePriority: 'high',
  },
}

/** 预设改过没有：customTypes 里有同名一项、且和出厂定义不同（「已改」标记、「恢复默认」据此显示）。 */
export function isPresetTypeEdited(name: string, customTypes: Readonly<Record<string, CustomType>>): boolean {
  return isPresetType(name) && Object.hasOwn(customTypes, name) && !sameType(customTypes[name], TYPE_DEFINITIONS[name])
}

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

/** 编码、办公的出厂组成，去掉已删的预设类型（恢复默认写回的就是它）。 */
export function presetSceneTypes(id: PresetSceneId, removedPresets: readonly string[]): string[] {
  return PRESET_SCENES[id].types.filter(name => !removedPresets.includes(name))
}

/**
 * 编码、办公改过没有：两边都去掉已删的预设后，组成和出厂组成的集合不同（「已改」标记、「恢复默认」据此显示）。
 * 配置文件里手写删掉预设时，场景可能还列着它（服务端跳过不用），不算改过。
 */
export function isPresetEdited(id: string, scene: Scene, removedPresets: readonly string[] = []): boolean {
  return isPresetScene(id) && !sameSet(scene.types.filter(name => !removedPresets.includes(name)), presetSceneTypes(id, removedPresets))
}

/**
 * 类型池，按池顺序：内置五类 → 预设两类 → 自建类型。和预设同名的一项是改过的预设，占预设的位置；
 * 删掉的预设不在池里（同名一项也不算，同服务端）。
 */
export function typePool(customTypes: Readonly<Record<string, unknown>>, removedPresets: readonly string[] = []): string[] {
  const fixed: readonly string[] = [...BUILTIN_TYPE_NAMES, ...PRESET_TYPE_NAMES]
  return [
    ...fixed.filter(name => !removedPresets.includes(name)),
    ...Object.keys(customTypes).filter(name => !fixed.includes(name)),
  ]
}

/**
 * 场景实际生效的类型，同服务端解析（src/type-registry.ts buildTypeRegistry）：取组成与类型池的交集、按池顺序、超过上限截断；
 * 通用、不存在的场景、交集为空都按通用五类。
 */
export function sceneTypes(fields: Pick<SettingsFields, 'scenes' | 'customTypes'> & Partial<Pick<SettingsFields, 'removedPresets'>>, id: string): string[] {
  const scene = id === GENERAL_SCENE || !Object.hasOwn(fields.scenes, id) ? undefined : fields.scenes[id]
  const pool = typePool(fields.customTypes, fields.removedPresets)
  const picked = scene === undefined ? [] : pool.filter(name => scene.types.includes(name)).slice(0, SCENE_MAX_TYPES)
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
export function renameType<P extends Pick<SettingsFields, 'scenes' | 'customTypes'>>(pool: P, from: string, to: string, type: CustomType): P {
  const customTypes = Object.fromEntries(Object.entries(pool.customTypes).map(([name, t]) => name === from ? [to, type] : [name, t]))
  const scenes = Object.fromEntries(Object.entries(pool.scenes).map(([id, scene]) =>
    [id, scene.types.includes(from) ? { ...scene, types: scene.types.map(name => name === from ? to : name) } : scene]))
  return { ...pool, scenes, customTypes }
}

/** 删掉一类，场景组成里一并去掉。预设类型还要记进 removedPresets，改过的定义一并丢掉。 */
export function removeType<P extends Pool>(pool: P, name: string): P {
  const { [name]: _removed, ...customTypes } = pool.customTypes
  const scenes = Object.fromEntries(Object.entries(pool.scenes).map(([id, scene]) =>
    [id, scene.types.includes(name) ? { ...scene, types: scene.types.filter(n => n !== name) } : scene]))
  const removedPresets = isPresetType(name) && !pool.removedPresets.includes(name) ? [...pool.removedPresets, name] : pool.removedPresets
  return { ...pool, scenes, customTypes, removedPresets }
}

/**
 * 恢复删掉的预设：用出厂定义，场景不自动勾回；这次删除时选的「移到最近删除」一并撤销。
 * 配置文件里手写删除时可能残留同名定义、场景里还列着它，一并去掉，免得恢复后旧定义生效、场景自动勾回。
 */
export function restorePresetType<P extends Pool>(pool: P, migrations: Migrations, name: string): { pool: P; migrations: Migrations } {
  const { [name]: _forget, ...rest } = migrations
  const { [name]: _stale, ...customTypes } = pool.customTypes
  const scenes = Object.fromEntries(Object.entries(pool.scenes).map(([id, scene]) =>
    [id, scene.types.includes(name) ? { ...scene, types: scene.types.filter(n => n !== name) } : scene]))
  return { pool: { ...pool, scenes, customTypes, removedPresets: pool.removedPresets.filter(n => n !== name) }, migrations: rest }
}

/** 类型池那几项字段：场景组成、自建类型（含改过的预设）、删掉的预设。 */
export type Pool = Pick<SettingsFields, 'scenes' | 'customTypes' | 'removedPresets'>

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
  /** 带入后怎么用（选填，进注入快照）。 */
  howToUse?: string
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
  /** 自建类型，和预设同名的一项是改过的预设。 */
  customTypes: Record<string, CustomType>
  /** 删掉的预设类型（配置里的 removedPresetTypes），按预设顺序。 */
  removedPresets: string[]
  budget: string
  overflow: (typeof OVERFLOW_MODES)[number]
  evidence: (typeof EVIDENCE_LEVELS)[number]
  sensitivity: (typeof SENSITIVITIES)[number]
  promoteTarget: (typeof PROMOTE_TARGETS)[number]
  accent: (typeof ACCENTS)[number]
}

/** 各字段在配置段里的路径（scenes、customTypes 按键逐条写，removedPresets 整段写，见 buildOps）。用户词典路径不进表单：只在配置文件或对话里改。 */
const PATHS: Record<Exclude<keyof SettingsFields, 'scenes' | 'customTypes' | 'removedPresets'>, string[]> = {
  template: ['template'],
  budget: ['snapshotTokenBudget'],
  overflow: ['snapshotOverflow'],
  evidence: ['evidenceLookup'],
  sensitivity: ['governance', 'health', 'sensitivity'],
  promoteTarget: ['governance', 'globalPromoteTarget'],
  accent: ['accent'],
}

const DEFAULTS: SettingsFields = {
  template: 'coding', scenes: PRESET_SCENES, customTypes: {}, removedPresets: [], budget: '4000', overflow: 'relax', evidence: 'strict',
  sensitivity: 'normal', promoteTarget: 'plugin-global', accent: 'ella',
}

function at(value: unknown, path: readonly string[]): unknown {
  let cur = value
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T => choices.includes(value as T)

function oneOf<T extends string>(choices: readonly T[], value: unknown, fallback: T): T {
  return isOneOf(choices, value) ? value : fallback
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

/** 配置段里的 removedPresetTypes：只认预设名（别的服务端也忽略），去重、按预设顺序。 */
function removedPresetsOf(value: unknown): string[] {
  return Array.isArray(value) ? PRESET_TYPE_NAMES.filter(name => value.includes(name)) : []
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
    removedPresets: removedPresetsOf(at(section, ['removedPresetTypes'])),
    budget: typeof budget === 'number' ? String(budget) : DEFAULTS.budget,
    overflow: oneOf(OVERFLOW_MODES, at(section, PATHS.overflow), DEFAULTS.overflow),
    evidence: oneOf(EVIDENCE_LEVELS, at(section, PATHS.evidence), DEFAULTS.evidence),
    sensitivity: oneOf(SENSITIVITIES, at(section, PATHS.sensitivity), DEFAULTS.sensitivity),
    promoteTarget: oneOf(PROMOTE_TARGETS, at(section, PATHS.promoteTarget), DEFAULTS.promoteTarget),
    accent: oneOf(ACCENTS, at(section, PATHS.accent), DEFAULTS.accent),
  }
}

/** 体检开关 `governance.enabled`：只在配置文件里改，不进表单。 */
const GOVERNANCE_ENABLED = ['governance', 'enabled']

/** 设置页只读体检开关来置灰依赖体检的项。取不到时按 schema 默认开着。 */
export function governanceEnabled(section: unknown): boolean {
  return at(section, GOVERNANCE_ENABLED) !== false
}

/** 配置里写的 memoryRoot（空 = 默认位置）。 */
export function configuredRoot(section: unknown): string {
  const root = at(section, ['memoryRoot'])
  return typeof root === 'string' ? root : ''
}

/** 记忆页、右侧栏等界面用到的配置项（配置段的子集，值已按 schema 带上默认值）。 */
export interface PluginConfig {
  snapshotTokenBudget: number
  snapshotOverflow: (typeof OVERFLOW_MODES)[number]
  governanceEnabled: boolean
  globalPromoteTarget: (typeof PROMOTE_TARGETS)[number]
  accent: (typeof ACCENTS)[number]
  /** 我加的类型和改过的预设（配置 customTypes），界面只用到显示名。 */
  customTypes: Readonly<Record<string, { label: string }>>
}

/** 配置段 → 界面用到的几项；结构不对为 undefined。和表单字段读同一套路径、认同一套取值。 */
export function toPluginConfig(section: unknown): PluginConfig | undefined {
  const budget = at(section, PATHS.budget)
  const overflow = at(section, PATHS.overflow)
  const enabled = at(section, GOVERNANCE_ENABLED)
  const target = at(section, PATHS.promoteTarget)
  if (typeof budget !== 'number' || !isOneOf(OVERFLOW_MODES, overflow) || typeof enabled !== 'boolean' || !isOneOf(PROMOTE_TARGETS, target)) return undefined
  // 主题色只管外观：取不到或不认识时按默认主题色，不让整份配置作废
  const accent = oneOf(ACCENTS, at(section, PATHS.accent), DEFAULTS.accent)
  // 类型名同理：只收带字符串名字的条目，坏条目按没改名显示
  const types = at(section, ['customTypes'])
  const customTypes = typeof types === 'object' && types !== null
    ? Object.fromEntries(Object.entries(types).flatMap(([name, type]) => {
      const label = at(type, ['label'])
      return typeof label === 'string' && label !== '' ? [[name, { label }]] : []
    }))
    : {}
  return { snapshotTokenBudget: budget, snapshotOverflow: overflow, governanceEnabled: enabled, globalPromoteTarget: target, accent, customTypes }
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
  if (!sameSet(saved.removedPresets, draft.removedPresets)) {
    ops.push({ op: 'set', path: ['removedPresetTypes'], value: PRESET_TYPE_NAMES.filter(name => draft.removedPresets.includes(name)) })
  }
  const scenes = sceneChanges(saved.scenes, draft.scenes)
  for (const id of [...scenes.added, ...scenes.edited]) {
    ops.push({ op: 'set', path: ['scenes', id], value: { label: draft.scenes[id]!.label, types: [...draft.scenes[id]!.types] } })
  }
  for (const id of scenes.removed) ops.push({ op: 'unset', path: ['scenes', id] })
  return ops
}

/** 自建类型的改动，按中文名汇总（保存确认弹窗用）：修改、新增取草稿里的名字，删除取已存的。改过的预设不算，见 presetTypeChanges。 */
export function customTypeChanges(saved: SettingsFields['customTypes'], draft: SettingsFields['customTypes']):
  { added: string[]; edited: string[]; removed: string[] } {
  const added: string[] = []
  const edited: string[] = []
  for (const [name, type] of Object.entries(draft)) {
    if (isPresetType(name)) continue
    if (!(name in saved)) added.push(type.label)
    else if (!sameType(saved[name], type)) edited.push(type.label)
  }
  const removed = Object.entries(saved).filter(([name]) => !isPresetType(name) && !(name in draft)).map(([, type]) => type.label)
  return { added, edited, removed }
}

/** 预设类型的改动（英文名，保存确认弹窗用）：改了定义、恢复默认、删除、恢复。删掉和恢复的不再算改没改定义。 */
export function presetTypeChanges(saved: Pool, draft: Pool): { edited: string[]; reset: string[]; removed: string[]; restored: string[] } {
  const parts = { edited: [] as string[], reset: [] as string[], removed: [] as string[], restored: [] as string[] }
  for (const name of PRESET_TYPE_NAMES) {
    const wasRemoved = saved.removedPresets.includes(name)
    const isRemoved = draft.removedPresets.includes(name)
    if (isRemoved !== wasRemoved) {
      (isRemoved ? parts.removed : parts.restored).push(name)
      continue
    }
    if (isRemoved) continue
    const before = isPresetTypeEdited(name, saved.customTypes)
    const after = isPresetTypeEdited(name, draft.customTypes)
    if (after && (!before || !sameType(saved.customTypes[name], draft.customTypes[name]))) parts.edited.push(name)
    else if (before && !after) parts.reset.push(name)
  }
  return parts
}

// —— 自定义类型 ——

/** 弹层草稿：选择项未选时为空串，衰退天数是原文。 */
export interface CustomTypeDraft {
  name: string
  label: string
  description: string
  whenToSave: string
  howToUse: string
  recall: CustomType['recall'] | ''
  governancePriority: CustomType['governancePriority'] | ''
  decayDays: string
}

export type CustomTypeError = 'required' | 'name-format' | 'name-builtin' | 'name-removed-preset' | 'name-taken' | 'name-pending' | 'label-taken' | 'decay-invalid'

/** 新增类型的初始草稿：召回方式、治理优先级预选「搜索」「中」，分段控件打开就有选中项（2026-10-25 用户定）。 */
export const EMPTY_TYPE_DRAFT: CustomTypeDraft = {
  name: '', label: '', description: '', whenToSave: '', howToUse: '', recall: 'search', governancePriority: 'medium', decayDays: '',
}

export function draftOf(name: string, type: CustomType): CustomTypeDraft {
  return { name, ...type, howToUse: type.howToUse ?? '', decayDays: type.decayDays === null ? '' : String(type.decayDays) }
}

/**
 * 校验类型表单草稿。英文名：小写字母和连字符（types.ts 的类型标识符约定），不与内置类型、taken.names 重名，
 * 不占用迁移中的原名（旧记忆保存后才迁走）；中文名去掉首尾空白后不与 taken.labels 重复。退役类型不算重名：同名自建就是新类型。
 * @param taken names：预设和其他自建类型的英文名（编辑预设时不含它自己）；labels：类型池里其他类型的中文名（含删掉的预设）；
 *   pending：迁移中的原名（见 pendingNames）；removedPresets：删掉的预设（名字仍占着，单独提示能恢复）。
 */
export function validateTypeDraft(draft: CustomTypeDraft, taken: {
  names: readonly string[]; labels: readonly string[]; pending?: readonly string[]; removedPresets?: readonly string[]
}):
  { ok: true; name: string; type: CustomType } | { ok: false; errors: Partial<Record<keyof CustomTypeDraft, CustomTypeError>> } {
  const errors: Partial<Record<keyof CustomTypeDraft, CustomTypeError>> = {}
  const name = draft.name.trim()
  if (name === '') errors.name = 'required'
  else if (!/^[a-z]+(?:-[a-z]+)*$/.test(name)) errors.name = 'name-format'
  else if ((BUILTIN_TYPE_NAMES as readonly string[]).includes(name)) errors.name = 'name-builtin'
  else if (taken.removedPresets?.includes(name) === true) errors.name = 'name-removed-preset'
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
  const howToUse = draft.howToUse.trim()
  return {
    ok: true,
    name,
    type: {
      label: draft.label.trim(), description: draft.description.trim(), whenToSave: draft.whenToSave.trim(),
      ...(howToUse === '' ? {} : { howToUse }),
      recall: draft.recall, decayDays, governancePriority: draft.governancePriority,
    },
  }
}

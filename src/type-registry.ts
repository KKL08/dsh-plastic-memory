import type { MemoryTypeDefinition } from './types.ts'
import { TypeRegistryError } from './errors.ts'
import { GENERAL_SCENE, SCENE_MAX_TYPES } from './contract-codes.ts'

/** 场景：从类型池里挑的一组类型（含通用类型），顺序无意义，类型表按类型池顺序排。 */
export interface SceneConfig {
  label: string
  types: readonly string[]
}

export interface TypeRegistryConfig {
  /** 当前场景 id：GENERAL_SCENE（通用）或 scenes 的键。 */
  template: string
  customTypes: Record<string, Omit<MemoryTypeDefinition, 'name'>>
  /** 不传时为出厂的编码、办公两项（同配置 schema 默认值）。 */
  scenes?: Readonly<Record<string, SceneConfig>>
}

export const BUILTIN_TYPES: readonly MemoryTypeDefinition[] = [
  { name: 'profile', label: '用户画像', description: '用户的身份、角色、能力和知识水平。例：「用户是数据工程师，Go 熟练，React 刚上手」', whenToSave: '用户透露身份、角色、常用技术栈或熟练度', recall: 'core', decayDays: null, governancePriority: 'low' },
  { name: 'preference', label: '行为偏好', description: '用户纠正过的做法、确认过的习惯。例：「测试里不要 mock 数据库」', whenToSave: '用户纠正你的做法、确认某个习惯，或明说「记住」「下次别这样」', recall: 'core', decayDays: null, governancePriority: 'medium' },
  { name: 'knowledge', label: '事实与经验', description: '不随项目结束而失效的客观事实、规则、工具行为。例：「报销截止每月 25 日」「keychain 报错是本地问题不是授权失效」', whenToSave: '确认了不随项目失效的事实、规则、工具行为；用户贴来的报错栈/接口结构/schema，记里面的事实本身而非「用户贴了个东西」', recall: 'search', decayDays: 90, governancePriority: 'high' },
  { name: 'project', label: '项目信息', description: '绑定项目生命周期的状态、决策、进展。例：「merge freeze 到 3 月 5 日」', whenToSave: '确立目标、里程碑达成、决策变更（连旧状态一起记）、关键进展推进', recall: 'search', decayDays: 7, governancePriority: 'high' },
  { name: 'reference', label: '参考引用', description: '外部资源的位置指针，回答「去哪找」。例：「pipeline bugs 在 Linear 的 INGEST 项目」', whenToSave: '用户指明某个资源固定在哪找', recall: 'passive', decayDays: null, governancePriority: 'medium' },
]

/** 预设类型：编码、办公出厂场景各带一类，自定义场景也能勾选。 */
export const PRESET_TYPES: readonly MemoryTypeDefinition[] = [
  { name: 'procedure', label: '可复用流程', description: '经多次验证的工作流程或操作步骤。一次成功不算，反复验证过才存', whenToSave: '一套流程反复验证有效、值得复用（一次成功不算）；做完一件复杂事后把踩过的坑和验证过的做法沉淀', recall: 'search', decayDays: 90, governancePriority: 'medium' },
  { name: 'decision', label: '决定', description: '谁在什么时候决定了什么、依据是什么；谁答应了谁什么、截止什么时候', whenToSave: '谁在什么时候定了什么、依据是什么；谁答应了谁什么、截止什么时候', recall: 'search', decayDays: 30, governancePriority: 'high' },
]

/** 退役类型：0.1.x 办公模板的承诺（并进决定）、人物。已有记忆按原定义读，任何场景都不能再新增；自建同名类型就是新类型，旧记忆按新定义读。 */
export const RETIRED_TYPES: readonly MemoryTypeDefinition[] = [
  { name: 'commitment', label: '承诺', description: '谁答应了什么、面向谁、截止时间', whenToSave: '谁答应了什么、面向谁、截止什么时候', recall: 'core', decayDays: 14, governancePriority: 'high' },
  { name: 'person', label: '人物', description: '协作者的角色、沟通偏好、负责范围', whenToSave: '协作者的角色、沟通偏好、负责范围', recall: 'search', decayDays: null, governancePriority: 'medium' },
]

const BUILTIN_NAMES = BUILTIN_TYPES.map(t => t.name)

/** 编码、办公的出厂组成，也是配置 scenes 的默认值。 */
export const PRESET_SCENES: Record<'coding' | 'office', { label: string; types: string[] }> = {
  coding: { label: '编码', types: [...BUILTIN_NAMES, 'procedure'] },
  office: { label: '办公', types: [...BUILTIN_NAMES, 'decision'] },
}

export const FALLBACK_POLICY: Omit<MemoryTypeDefinition, 'name' | 'label' | 'description'> = {
  whenToSave: '跨会话可能还有用、未来的你会因此做得更好', recall: 'search', decayDays: 90, governancePriority: 'high',
}

// 通用层：跨类型的原则、写法、负向规则。「何时记哪类」由各类型 whenToSave 自动拼在其后（renderSaveDescription）。
const SAVE_GUIDE = `记录跨会话有价值的信息，主动做、不必等用户开口。守门一问：未来的我会不会因为这条记忆做得更好？会，才记。
记录记忆是你在做事过程中顺手记的。回复只回应用户说的内容，不要特意说「记下了」，也不要提记忆 id、类型这些内部信息，界面会把这轮写入的记忆展示给用户。只有用户明确要你记住某件事时，才简短应一句，比如「好，我记下来了」。
判断偏好以用户的话为准（用户的要求、纠正、打断是主要依据），别把你自己的提议当成用户偏好。你自己推断出的结论也可以记，但要用低置信度（confidence 填 0.5 左右）、标 sourceMode=agent-inferred。
长任务别拖到最后——关键决策、进展、目标边做边记，别等上下文被压缩才想起来。
相对时间（「上周」「最近」）落库时换成具体日期，否则日后失效；变更类信息（从 A 换成 B）连旧状态和原因一起记。
不记：任务临时进度、本会话临时状态、未落地的探索或你自己未被采纳的提议、已写在 AGENTS.md/CLAUDE.md 里的内容、无法追溯到对话的猜测；别从姓名或上下文推断用户没明说的属性（性别、年龄等）。
更新已有记忆传 action=update 和目标 id，别重复新增。改写或替代用户手改过的记忆，要先在对话里问用户，同意后带 force: true 重发。
scope：默认填 workspace（只对当前项目）。你没有直接写 global 的权限——即使填 global，也会先落当前项目、并标记成"建议提升全局"的候选，等治理时由用户确认后才提升。真要全局适用的（用户明说所有项目都要）照填 global 即可，用户会在治理时一键提升，不必你来定夺。`

export interface TypeRegistry {
  get(name: string): MemoryTypeDefinition
  has(name: string): boolean
  all(): MemoryTypeDefinition[]
  renderSaveDescription(): string
}

/** buildTypeRegistry 的结果：类型表本身，外加场景配置有问题时的警告（由调用方打日志）。 */
export interface BuiltTypeRegistry extends TypeRegistry {
  readonly warnings: readonly string[]
}

export function assertNoBuiltinCollision(types: readonly MemoryTypeDefinition[], origin: string): void {
  for (const t of types) {
    if (BUILTIN_TYPES.some(b => b.name === t.name)) {
      throw new TypeRegistryError('builtin-collision', `${origin}类型 "${t.name}" 与内置类型重名，内置五类不可覆盖`)
    }
  }
}

export function buildTypeRegistry(config: TypeRegistryConfig): BuiltTypeRegistry {
  const customTypes = Object.entries(config.customTypes).map(([name, def]) => ({ name, ...def }))
  assertNoBuiltinCollision(customTypes, '自定义')

  // 类型池：内置 → 预设 → 自建（自建与预设、退役同名时覆盖，兼容老配置）
  const pool = new Map<string, MemoryTypeDefinition>()
  for (const t of [...BUILTIN_TYPES, ...PRESET_TYPES]) pool.set(t.name, t)
  const retired = new Map(RETIRED_TYPES.map(t => [t.name, t]))
  for (const t of customTypes) {
    pool.set(t.name, t)
    retired.delete(t.name)
  }

  const warnings: string[] = []
  const general = () => BUILTIN_TYPES.map(t => t.name)
  const pickScene = (): string[] => {
    if (config.template === GENERAL_SCENE) return general()
    const scenes: Readonly<Record<string, SceneConfig>> = config.scenes ?? PRESET_SCENES
    const scene = Object.hasOwn(scenes, config.template) ? scenes[config.template] : undefined
    if (scene === undefined) {
      warnings.push(`场景 "${config.template}" 不存在，按通用场景运行`)
      return general()
    }
    const skipped = scene.types.filter(name => !pool.has(name))
    if (skipped.length > 0) warnings.push(`场景 "${config.template}" 里的类型 ${skipped.join('、')} 不存在或已退役，已跳过`)
    const picked = [...pool.keys()].filter(name => scene.types.includes(name))
    if (picked.length === 0) {
      warnings.push(`场景 "${config.template}" 没有可用的类型，按通用场景运行`)
      return general()
    }
    if (picked.length > SCENE_MAX_TYPES) {
      warnings.push(`场景 "${config.template}" 超过 ${SCENE_MAX_TYPES} 类，只用前 ${SCENE_MAX_TYPES} 类`)
      return picked.slice(0, SCENE_MAX_TYPES)
    }
    return picked
  }
  const map = new Map(pickScene().map(name => [name, pool.get(name)!]))

  return {
    warnings,
    // 读时认得类型池和退役类型（切场景、退役后已有记忆照常带入、能搜到），写时 has 只认当前场景
    get: name => map.get(name) ?? pool.get(name) ?? retired.get(name) ?? { name, label: name, description: '', ...FALLBACK_POLICY },
    has: name => map.has(name),
    all: () => [...map.values()],
    renderSaveDescription() {
      const lines = [...map.values()].map(t => `- ${t.name}（${t.label}）：${t.whenToSave}`)
      return `${SAVE_GUIDE}\n\n各类型何时记：\n${lines.join('\n')}`
    },
  }
}

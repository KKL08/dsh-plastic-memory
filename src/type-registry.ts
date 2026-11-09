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
  /** 删掉的预设类型：不进类型池，和退役类型一样只供读取。 */
  removedPresetTypes?: readonly string[]
}

export const BUILTIN_TYPES: readonly MemoryTypeDefinition[] = [
  {
    name: 'profile', label: '用户画像',
    description: '用户本人相对稳定的情况：身份和角色、工作或学习背景、所在地区和时区、常用语言、生活习惯和家庭情况、兴趣和长期目标，以及对各类知识、技能和工具的熟悉程度。正文：写成「用户是…」「用户熟悉…」，同一方面的情况合成一条（工作背景一条、某项技能一条、所在时区一条），情况变了就更新原来那条。例：用户说「我在上海做平面设计，下班后在自学日语，目标是考过 N1」→ 记两条：「用户在上海从事平面设计」「用户在业余自学日语，目标是通过日语 N1 考试」',
    whenToSave: '用户说到自己的身份、工作或学习经历、所在地和时区、生活习惯、家庭情况、兴趣、长期目标；用户的话或实际表现体现出对某项知识或技能的熟悉程度（「这块我很熟」「第一次接触这个」）',
    howToUse: '按用户的情况调整回答：熟悉的领域直接给结论和关键细节，生疏的领域补上背景、术语先解释再用；举例、时间安排和用语贴合用户的背景、所在地和作息。',
    recall: 'core', decayDays: null, governancePriority: 'low',
  },
  {
    name: 'preference', label: '行为偏好',
    description: '用户对你做事方式的持续要求：做法、工具、交付格式、沟通方式等，来自用户直接提出、纠正或明确认可，以后同类事情都照此办理。正文：先写要求，写成「用户要求…」「用户习惯…」；再写一句理由，用户没说理由就写当时在做什么；一条只写一项要求。例：用户说「以后帮我订酒店都挑带厨房的，出门在外我想自己做饭」→ 记「用户要求订酒店时选带厨房的；理由：出行时想自己做饭」',
    whenToSave: '用户提出一项以后都适用的要求（「以后都…」「每次…」）；用户纠正你的做法，并希望以后照新的来（「换成…」「下次别…」）；用户明确认可你的某个做法并希望保持（「对，以后就这样」）；用户反复改写、撤销或拒绝同一类做法',
    howToUse: '同类事情直接照做，不用再问；用户这次的话和这条不一致时，这次按用户的话做，用户表明以后都这样再更新这条。',
    recall: 'core', decayDays: null, governancePriority: 'medium',
  },
  {
    name: 'knowledge', label: '事实与经验',
    description: '经过确认、以后还会用到的事实和经验：规章制度、工具和设备的行为、查明的问题原因、验证过有效或行不通的做法。正文：写事实本身和它成立的条件（版本、环境、适用范围），能说出来源的写上来源（文档、报错、谁说的）；没找到、行不通这类结论写明在什么范围试过，推测的写明是推测。例：用户说「财务刚通知，25 号以后交的报销都算下个月」→ 记「公司报销每月 25 日截止，之后提交的计入下月（来源：财务通知）」',
    whenToSave: '确认了一条以后还会用到的规则或事实；查明了一个问题的原因；验证了某个做法有效或行不通；用户贴来的或你查到的资料（报错、接口结构、数据格式、文件内容）里有以后用得上的事实（记事实本身）',
    howToUse: '遇到同类问题先按这条判断，省掉重复排查；条件（版本、环境）和眼前对不上时，先核对再用。',
    recall: 'search', decayDays: 90, governancePriority: 'high',
  },
  {
    name: 'project', label: '项目信息',
    description: '进行中的项目或个人事项的当前情况：目标、范围、里程碑、截止日期、分工、当前采用的方案、进展和阻塞，会随事情推进变化。正文：写清状态和对应的具体日期；状态有变化时写明从什么变成什么、原因是什么。例：用户说「学院把答辩从 12 月 20 日提前到 12 月 10 日了，我得 11 月底前把初稿交给导师」→ 记「用户的毕业论文答辩从 12 月 20 日提前到 12 月 10 日（学院调整）；初稿须在 11 月 30 日前交给导师」',
    whenToSave: '项目或个人事项定下目标、范围或截止日期；里程碑完成；计划、分工或范围有变化；出现影响后续安排的进展或阻塞（用户告知，或你从资料、执行结果里确认）',
    howToUse: '用它理解当前请求所处的事项和约束（截止日期、范围、负责人）；这类信息变得快，标了「可能过时」的先核对再用。',
    recall: 'search', decayDays: 7, governancePriority: 'high',
  },
  {
    name: 'reference', label: '参考引用',
    description: '某类资料、文件、物品或问题该去哪里找：所在的系统、文档、目录、频道、存放位置或对接人，以及那里有什么。正文：写位置（链接、路径、在系统里怎么找到，或东西放在哪）、里面有什么、什么时候该去看。例：用户说「接口文档在仓库的 docs/api 目录，第三方支付的接口说明看 https://pay.example.com/docs」→ 记两条：「项目接口文档在仓库 docs/api 目录，改接口前先看这里」「第三方支付接口说明在 https://pay.example.com/docs，对接支付时查这里」',
    whenToSave: '用户指明某类资料、文件、物品或问题该去哪里找；你找到了一个以后会反复用到的入口（文档、看板、目录）',
    howToUse: '用户提到相关的资料、物品或问题时，先按这个位置去查；你查不到的位置（实物、别人的系统）就告诉用户去哪里找。',
    recall: 'passive', decayDays: null, governancePriority: 'medium',
  },
]

/** 预设类型：编码、办公出厂场景各带一类，自定义场景也能勾选。 */
export const PRESET_TYPES: readonly MemoryTypeDefinition[] = [
  {
    name: 'procedure', label: '可复用流程',
    description: '实际用过、确认有效的多步骤做法：完成某类任务的顺序、关键命令或操作，以及容易出错的地方和解法。正文：先写适用的任务和前提，再按顺序写步骤，最后写容易出错的地方；步骤里写稳定的命令和位置。例：用户说「发版就按这个顺序，用了三次都顺：改版本号和 CHANGELOG，打包核对文件清单，再发布；刚发布装不上报 404 是正常的，等十分钟再试」→ 记「发布 npm 包的流程（已用三次）：改版本号和 CHANGELOG → 打包并核对文件清单 → 发布 → 等十分钟再验证安装；刚发布时安装报 404 属正常现象，稍等即可」',
    whenToSave: '同一套做法已经多次用下来都有效；用户要求以后照一套多步骤做法来做；做完一件复杂的事后，把实际验证有效的步骤、踩过的坑和解法沉淀下来',
    howToUse: '做同类任务前先照这条的步骤走；某一步和现状对不上（命令、路径变了）时，做完后更新这条。',
    recall: 'search', decayDays: 90, governancePriority: 'medium',
  },
  {
    name: 'decision', label: '决定',
    description: '有明确当事人的决定和承诺：谁定了什么、依据是什么；谁答应谁做什么、什么时候完成。正文：一条写一项决定或一项承诺，写清当事人、内容，以及依据或截止日期；决定改了就新记一条，用 supersedes 指向旧的那条。例：用户说「和财务经理定了，Q3 超支，Q4 外包预算先砍掉；他答应 11 月 7 日前把新预算表发我」→ 记两条：「用户与财务经理决定 Q4 取消外包预算（依据：Q3 超支）」「财务经理承诺 11 月 7 日前把新预算表发给用户」',
    whenToSave: '对话里或你查阅的资料（会议纪要、邮件、聊天记录）里出现一项定下来的决定（谁、定了什么、为什么），或一项承诺（谁答应谁、做什么、什么时候完成）',
    howToUse: '处理相关事项时按已定的决定和承诺来；用户问到时说明依据，并提到临近的截止日期。',
    recall: 'search', decayDays: 30, governancePriority: 'high',
  },
]

/** 退役类型：0.1.x 办公模板的承诺（并进决定）、人物。已有记忆按原定义读，任何场景都不能再新增；自建同名类型就是新类型，旧记忆按新定义读。 */
export const RETIRED_TYPES: readonly MemoryTypeDefinition[] = [
  { name: 'commitment', label: '承诺', description: '谁答应了什么、面向谁、截止时间', whenToSave: '谁答应了什么、面向谁、截止什么时候', howToUse: '用户问到相关事项时，说明这项承诺和它的截止日期。', recall: 'core', decayDays: 14, governancePriority: 'high' },
  { name: 'person', label: '人物', description: '协作者的角色、沟通偏好、负责范围', whenToSave: '协作者的角色、沟通偏好、负责范围', howToUse: '和这位协作者打交道或给对方写东西时，按对方的角色和沟通偏好来。', recall: 'search', decayDays: null, governancePriority: 'medium' },
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

// 通用层：跨类型的原则、写法、负向规则。各类型记什么（description）、什么时候记（whenToSave）由 renderSaveDescription 拼在其后；
// 带入后怎么用（howToUse）不在这里，在注入快照里贴着记忆写（snapshot.ts）。
const SAVE_GUIDE = `记录跨会话有价值的信息，主动做、不必等用户开口。守门一问：未来的我会不会因为这条记忆做得更好？会，才记。
记录记忆是你在做事过程中顺手记的。回复只回应用户说的内容，不要特意说「记下了」，也不要提记忆 id、类型这些内部信息，界面会把这轮写入的记忆展示给用户。用户明确要你记住某件事时，按最贴合的类型马上记下内容本身，只在这时简短应一句，比如「好，我记下来了」。
判断偏好以用户的话为准（用户的要求、纠正、打断是主要依据），别把你自己的提议当成用户偏好。你自己推断出的结论也可以记，但要用低置信度（confidence 填 0.5 左右）、标 sourceMode=agent-inferred。
长任务别拖到最后——关键决策、进展、目标边做边记，别等上下文被压缩才想起来。
相对时间（「上周」「最近」）落库时换成具体日期，否则日后失效；确定不了具体日期的保留原来的精度（如「2026 年夏天」），不编日期；变更类信息（从 A 换成 B）连旧状态和原因一起记。
不记：任务临时进度、本会话临时状态、未落地的探索或你自己未被采纳的提议、已写在 AGENTS.md/CLAUDE.md 里的内容、无法追溯到对话的猜测；别从姓名或上下文推断用户没明说的属性（性别、年龄等）。
更新已有记忆传 action=update 和目标 id，别重复新增；旧说法要留档时（比如决定改了），新建一条、supersedes 填旧记忆的 id。更新会替换整条正文，更新前先确认已读过目标记忆的全文。改写或替代用户手改过的记忆，要先在对话里问用户，同意后带 force: true 重发。
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

  const warnings: string[] = []
  const removedNames = config.removedPresetTypes ?? []
  const unknown = removedNames.filter(name => !PRESET_TYPES.some(t => t.name === name))
  if (unknown.length > 0) warnings.push(`removedPresetTypes 里的 ${unknown.join('、')} 不是预设类型，已忽略`)
  const removed = PRESET_TYPES.filter(t => removedNames.includes(t.name))

  // 类型池：内置 → 预设 → 自建（自建与预设同名 = 改过的预设，与退役同名 = 新类型）。删掉的预设只供读取，同名自建不生效
  const pool = new Map<string, MemoryTypeDefinition>()
  for (const t of [...BUILTIN_TYPES, ...PRESET_TYPES]) {
    if (!removed.includes(t)) pool.set(t.name, t)
  }
  const retired = new Map([...RETIRED_TYPES, ...removed].map(t => [t.name, t]))
  for (const t of customTypes) {
    if (removed.some(r => r.name === t.name)) {
      warnings.push(`预设类型 "${t.name}" 已删除，customTypes 里的同名定义不生效`)
      continue
    }
    pool.set(t.name, t)
    retired.delete(t.name)
  }

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
    if (skipped.length > 0) warnings.push(`场景 "${config.template}" 里的类型 ${skipped.join('、')} 不存在、已退役或已删除，已跳过`)
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
      const lines = [...map.values()].map(t => `- ${t.name}（${t.label}）：${t.description}\n  什么时候记：${t.whenToSave}`)
      return `${SAVE_GUIDE}\n\n各类型记什么、什么时候记：\n${lines.join('\n')}`
    },
  }
}

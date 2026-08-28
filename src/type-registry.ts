import type { Config } from './index.ts'
import type { MemoryTypeDefinition } from './types.ts'

export const BUILTIN_TYPES: readonly MemoryTypeDefinition[] = [
  { name: 'profile', label: '用户画像', description: '用户的身份、角色、能力和知识水平。例：「用户是数据工程师，Go 熟练，React 刚上手」', whenToSave: '用户透露身份、角色、常用技术栈或熟练度', recall: 'core', decayDays: null, governancePriority: 'low' },
  { name: 'preference', label: '行为偏好', description: '用户纠正过的做法、确认过的习惯。例：「测试里不要 mock 数据库」', whenToSave: '用户纠正你的做法、确认某个习惯，或明说「记住」「下次别这样」', recall: 'core', decayDays: null, governancePriority: 'medium' },
  { name: 'knowledge', label: '事实与经验', description: '不随项目结束而失效的客观事实、规则、工具行为。例：「报销截止每月 25 日」「keychain 报错是本地问题不是授权失效」', whenToSave: '确认了不随项目失效的事实、规则、工具行为；用户贴来的报错栈/接口结构/schema，记里面的事实本身而非「用户贴了个东西」', recall: 'search', decayDays: 90, governancePriority: 'high' },
  { name: 'project', label: '项目信息', description: '绑定项目生命周期的状态、决策、进展。例：「merge freeze 到 3 月 5 日」', whenToSave: '确立目标、里程碑达成、决策变更（连旧状态一起记）、关键进展推进', recall: 'search', decayDays: 7, governancePriority: 'high' },
  { name: 'reference', label: '参考引用', description: '外部资源的位置指针，回答「去哪找」。例：「pipeline bugs 在 Linear 的 INGEST 项目」', whenToSave: '用户指明某个资源固定在哪找', recall: 'passive', decayDays: null, governancePriority: 'medium' },
]

export const TEMPLATES: Record<string, readonly MemoryTypeDefinition[]> = {
  coding: [
    { name: 'procedure', label: '可复用流程', description: '经多次验证的工作流程或操作步骤。一次成功不算，反复验证过才存', whenToSave: '一套流程反复验证有效、值得复用（一次成功不算）；做完一件复杂事后把踩过的坑和验证过的做法沉淀', recall: 'search', decayDays: 90, governancePriority: 'medium' },
  ],
  office: [
    { name: 'decision', label: '决定', description: '谁在什么时候决定了什么，依据是什么', whenToSave: '谁在什么时候定了什么、依据是什么', recall: 'search', decayDays: 30, governancePriority: 'high' },
    { name: 'commitment', label: '承诺', description: '谁答应了什么、面向谁、截止时间', whenToSave: '谁答应了什么、面向谁、截止什么时候', recall: 'core', decayDays: 14, governancePriority: 'high' },
    { name: 'person', label: '人物', description: '协作者的角色、沟通偏好、负责范围', whenToSave: '协作者的角色、沟通偏好、负责范围', recall: 'search', decayDays: null, governancePriority: 'medium' },
  ],
  // companion 模板 P2
}

export const FALLBACK_POLICY: Omit<MemoryTypeDefinition, 'name' | 'label' | 'description'> = {
  whenToSave: '跨会话可能还有用、未来的你会因此做得更好', recall: 'search', decayDays: 90, governancePriority: 'high',
}

// 通用层：跨类型的原则、写法、负向规则。「何时记哪类」由各类型 whenToSave 自动拼在其后（renderSaveDescription）。
const SAVE_GUIDE = `记录跨会话有价值的信息，主动做、不必等用户开口。守门一问：未来的我会不会因为这条记忆做得更好？会，才记。
判断偏好以用户的话为准（用户的要求、纠正、打断是主要依据），别把你自己的提议当成用户偏好。你自己推断出的结论也可以记，但要用低置信度（confidence 填 0.5 左右）、标 sourceMode=agent-inferred。
长任务别拖到最后——关键决策、进展、目标边做边记，别等上下文被压缩才想起来。
相对时间（「上周」「最近」）落库时换成具体日期，否则日后失效；变更类信息（从 A 换成 B）连旧状态和原因一起记。
不记：任务临时进度、本会话临时状态、未落地的探索或你自己未被采纳的提议、已写在 AGENTS.md/CLAUDE.md 里的内容、无法追溯到对话的猜测；别从姓名或上下文推断用户没明说的属性（性别、年龄等）。
更新已有记忆传 action=update 和目标 id，别重复新增。
scope：默认填 workspace（只对当前项目）。你没有直接写 global 的权限——即使填 global，也会先落当前项目、并标记成"建议提升全局"的候选，等治理时由用户确认后才提升。真要全局适用的（用户明说所有项目都要）照填 global 即可，用户会在治理时一键提升，不必你来定夺。`

export interface TypeRegistry {
  get(name: string): MemoryTypeDefinition
  has(name: string): boolean
  all(): MemoryTypeDefinition[]
  renderSaveDescription(): string
}

export function assertNoBuiltinCollision(types: readonly MemoryTypeDefinition[], origin: string): void {
  for (const t of types) {
    if (BUILTIN_TYPES.some(b => b.name === t.name)) {
      throw new Error(`${origin}类型 "${t.name}" 与内置类型重名，内置五类不可覆盖`)
    }
  }
}

export function buildTypeRegistry(
  config: Pick<Config, 'template' | 'customTypes'>,
): TypeRegistry {
  const map = new Map<string, MemoryTypeDefinition>()
  for (const t of BUILTIN_TYPES) map.set(t.name, t)

  const templateTypes = TEMPLATES[config.template] ?? []
  assertNoBuiltinCollision(templateTypes, '模板')
  for (const t of templateTypes) map.set(t.name, t)

  const customTypes = Object.entries(config.customTypes).map(([name, def]) => ({ name, ...def }))
  assertNoBuiltinCollision(customTypes, '自定义')
  for (const t of customTypes) map.set(t.name, t)

  return {
    get: name => map.get(name) ?? { name, label: name, description: '', ...FALLBACK_POLICY },
    has: name => map.has(name),
    all: () => [...map.values()],
    renderSaveDescription() {
      const types = [...map.values()]
      const trim = types.length > 15
      const lines = types.map(t =>
        trim && t.governancePriority === 'low'
          ? `- ${t.name}（${t.label}）`
          : `- ${t.name}（${t.label}）：${t.whenToSave}`)
      return `${SAVE_GUIDE}\n\n各类型何时记：\n${lines.join('\n')}`
    },
  }
}

import type { Config } from './index.ts'
import type { MemoryTypeDefinition } from './types.ts'

export const BUILTIN_TYPES: readonly MemoryTypeDefinition[] = [
  { name: 'profile', label: '用户画像', description: '用户的身份、角色、能力和知识水平。例：「用户是数据工程师，Go 熟练，React 刚上手」', recall: 'core', decayDays: null, governancePriority: 'low' },
  { name: 'preference', label: '行为偏好', description: '用户纠正过的做法、确认过的习惯。例：「测试里不要 mock 数据库」', recall: 'core', decayDays: null, governancePriority: 'medium' },
  { name: 'knowledge', label: '事实与经验', description: '不随项目结束而失效的客观事实、规则、工具行为。例：「报销截止每月 25 日」「keychain 报错是本地问题不是授权失效」', recall: 'search', decayDays: 90, governancePriority: 'high' },
  { name: 'project', label: '项目信息', description: '绑定项目生命周期的状态、决策、进展。例：「merge freeze 到 3 月 5 日」', recall: 'search', decayDays: 7, governancePriority: 'high' },
  { name: 'reference', label: '参考引用', description: '外部资源的位置指针，回答「去哪找」。例：「pipeline bugs 在 Linear 的 INGEST 项目」', recall: 'passive', decayDays: null, governancePriority: 'medium' },
]

export const TEMPLATES: Record<string, readonly MemoryTypeDefinition[]> = {
  coding: [
    { name: 'procedure', label: '可复用流程', description: '经多次验证的工作流程或操作步骤。一次成功不算，反复验证过才存', recall: 'search', decayDays: 90, governancePriority: 'medium' },
  ],
  office: [
    { name: 'decision', label: '决定', description: '谁在什么时候决定了什么，依据是什么', recall: 'search', decayDays: 30, governancePriority: 'high' },
    { name: 'commitment', label: '承诺', description: '谁答应了什么、面向谁、截止时间', recall: 'core', decayDays: 14, governancePriority: 'high' },
    { name: 'person', label: '人物', description: '协作者的角色、沟通偏好、负责范围', recall: 'search', decayDays: null, governancePriority: 'medium' },
  ],
  // companion 模板 P2
}

export const FALLBACK_POLICY: Omit<MemoryTypeDefinition, 'name' | 'label' | 'description'> = {
  recall: 'search', decayDays: 90, governancePriority: 'high',
}

const SAVE_GUIDE = `记录跨会话有价值的信息。何时保存（主动做，不要等用户要求）：
- 用户纠正你的做法，或说「记住这个」「下次别这样」
- 用户表达稳定的偏好、习惯或个人背景
- 达成会影响未来工作的决定
- 发现环境或工具的稳定事实
- 用户提到某个资源固定在哪里找
不要保存：任务进度、本次会话的临时状态、未经验证的猜测。
更新已有记忆时传 action=update 和目标 id，不要重复新增。
scope：适用于所有项目填 global，只适用于当前项目填 workspace。`

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
          : `- ${t.name}（${t.label}）：${t.description}`)
      return `${SAVE_GUIDE}\n\ntype 取值：\n${lines.join('\n')}`
    },
  }
}

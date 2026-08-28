export interface MemoryTypeDefinition {
  readonly name: string          // 类型标识符，小写字母和连字符
  readonly label: string         // 显示名（中文）
  readonly description: string   // 写进 memory_save 工具 description，引导模型分类
  readonly whenToSave: string    // 「何时该记这类」触发引导，进 memory_save；每类一条，触发引导的单一来源
  readonly recall: 'core' | 'search' | 'passive'
  readonly decayDays: number | null   // null 表示不衰减
  readonly governancePriority: 'high' | 'medium' | 'low'
}

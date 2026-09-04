/**
 * 工具结果里稳定标识符的唯一权威清单（命名契约：进 wire 的标识符只在这一处定义）。
 * 文案可以改，code 不改；测试与程序化消费者按 code 分支，不按中文句子。
 */

/** memory_save 拒存原因（pipeline.ts）。 */
export type RejectCode =
  | 'unknown-type'      // 类型不在注册表
  | 'target-missing'    // update 目标不存在或已删除
  | 'cross-workspace'   // update 指向其他 workspace 的记忆
  | 'no-workspace'      // 无工作目录的会话 create（无处归属）
  | 'schema-invalid'    // 字段校验失败
  | 'secret-critical'   // 明确厂商特征的密钥，拒存不落盘

/** memory_save 成功但附带的警告（pipeline.ts）。 */
export type WarningCode =
  | 'update-global-candidate' // update 填 global：scope 不变，标记为提升候选
  | 'update-scope-kept'       // update 填了与目标不同的 scope：保持原 scope
  | 'cross-bucket-supersede'  // supersedes 目标不在本次写入的记忆桶内，跳过
  | 'auto-snapshot'           // 更新 global 记忆前已自动快照
  | 'secret-suspected'        // 疑似密钥（无厂商特征），已落盘但建议改写

/** memory_scan 的说明性 note（scan.ts）。 */
export type ScanNoteCode =
  | 'semantic-unavailable'    // layers=full 但拿不到 LLM，只返回规则层
  | 'no-layer-executed'       // layers=semantic 且拿不到 LLM，什么都没跑
  | 'semantic-truncated'      // 记忆过多，语义层只分析了前 N 条
  | 'semantic-failed'         // LLM 抛异常或两次输出无法解析，未更新语义缓存
  | 'baseline-missing'        // 未检测到 AGENTS.md 基线，垂直冲突检测未执行
  | 'baseline-session-scoped' // 基线随当前会话，其他 workspace 的垂直冲突检测已跳过
  | 'cross-ws-failed'         // 跨项目重复分析失败，退用实体聚类保底

/** memory_health 建议的分层并列结构（health.ts）：独占层单元素，行动项层多元素，无事为空数组。 */
export type HealthRecommendationKind =
  | 'secret'                  // 本层红线门：检出密钥（独占）
  | 'global-secret'           // workspace 视图下 global 层检出密钥（独占）
  | 'pending-overdue'         // 冲突挂起超期
  | 'semantic-never-scanned'  // 从未做过语义扫描
  | 'semantic-stale'          // 语义扫描过旧
  | 'freshness-stale'         // 有记忆超过衰退期未确认
  | 'score-below-threshold'   // 分数低于档位提示阈值
  | 'issues-below-threshold'  // 有问题但未达提示阈值
  | 'promote-candidates'      // 闲时事务：有全局提升候选待确认

/** memory_search 的说明性 note（search.ts）。 */
export type SearchNoteCode = 'no-workspace' // scope=workspace 但当前会话没有工作目录

/** frontmatter 解析失败的原因（storage/frontmatter.ts）。 */
export type FrontmatterErrorCode =
  | 'missing-fence'     // 文件不以 --- 开头
  | 'unclosed-fence'    // 找不到闭合的 ---
  | 'yaml-parse'        // 围栏内不是合法 YAML
  | 'not-object'        // YAML 顶层不是对象
  | 'timestamp-format'  // 时间戳不是 UTC 毫秒 ISO 格式
  | 'timestamp-parse'   // 时间戳无法解析
  | 'schema-invalid'    // 记录 schema 校验失败

/** 带 code 的说明条目（scan notes / save warnings 共用形状）。 */
export interface CodedNote<C extends string> {
  code: C
  text: string
}

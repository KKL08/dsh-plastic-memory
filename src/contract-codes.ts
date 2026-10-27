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
  | 'secret-suspected'  // 疑似密钥（无厂商特征），未带 force 时拒存；用户确认后带 force: true 重发
  | 'hand-edited'       // update 目标或同桶 supersedes 目标用户手改过，未带 force 时拒存；问过用户、同意后带 force: true 重发

/**
 * 模型用 memory_save 改写已有记忆（rewrite）、把同桶旧记忆标成已取代（supersede）时留的撤销记录种类：
 * 待决账本的条目种类（governance/schema.ts）与 GUI 视图（gui/contract.ts）同用。
 */
export const MODEL_CHANGE_KINDS = ['rewrite', 'supersede'] as const
export type ModelChangeKind = (typeof MODEL_CHANGE_KINDS)[number]

/** 治理工具（forget / confirm / promote / snapshot）按记录的拒绝原因（tools/workspace-gate.ts）。 */
export type GovernanceRejectCode =
  | 'cross-workspace'   // 目标不在可见集合（global + 当前 workspace），且未带 allowCrossWorkspace

/** memory_confirm 裁决待决项时什么都没动的原因（tools/confirm.ts）。 */
export type DecisionRejectCode =
  | 'claimed'           // 条目正被另一次裁决或体检认领
  | 'not-found'         // 条目不存在：已被裁决，或涉及的记忆已删除

/** memory_save 成功但附带的警告（pipeline.ts）。 */
export type WarningCode =
  | 'update-global-candidate' // update 填 global：scope 不变，标记为提升候选
  | 'update-scope-kept'       // update 填了与目标不同的 scope：保持原 scope
  | 'cross-bucket-supersede'  // supersedes 目标不在本次写入的记忆桶内，跳过
  | 'auto-snapshot'           // 更新 global 记忆前已自动快照
  | 'secret-suspected'        // 疑似密钥（无厂商特征），带 force: true 放行落盘，仍建议改写

/** memory_scan 的说明性 note（scan.ts）。 */
export type ScanNoteCode =
  | 'semantic-unavailable'    // layers=full 但拿不到 LLM，只返回规则层
  | 'no-layer-executed'       // layers=semantic 且拿不到 LLM，什么都没跑
  | 'semantic-batched'        // 记忆超出一次调用的 token 预算，语义层分批检查，跨批的成对问题可能漏
  | 'semantic-failed'         // LLM 抛异常或两次输出无法解析，未更新语义缓存
  | 'model-unavailable'       // 模型用不了：宿主报未登录或缺凭据（governance/host-llm.ts MODEL_UNAVAILABLE_HOST_CODES），未更新语义缓存；不算失败
  | 'baseline-missing'        // 未检测到 AGENTS.md 基线，垂直冲突检测未执行
  | 'baseline-session-scoped' // 基线随当前会话，其他 workspace 的垂直冲突检测已跳过
  | 'cross-ws-failed'         // 跨项目重复分析失败，退用实体聚类保底
  | 'conflicts-settled'       // 有冲突此前裁决为两边都留、双方未改，本次不再列出

/**
 * 体检完成记录的发起方（体检记录表，storage/schema.ts）：manual = 界面手动（记忆页的 `/memory scan`），auto = 自动体检，
 * agent = agent 调 memory_scan。
 */
export const CHECKUP_INITIATORS = ['manual', 'auto', 'agent'] as const
export type CheckupInitiator = (typeof CHECKUP_INITIATORS)[number]

/**
 * 自动体检这次没做完、或模型用不了的原因（体检记录表与体检视图）：no-default-model = 宿主没有可用的默认模型选择，
 * model-error = 模型调用出错（宿主给了错误码时带上），unparseable = 模型输出两次都解析不了，error = 体检本身出错。
 */
export const CHECKUP_CAUSE_KINDS = ['no-default-model', 'model-error', 'unparseable', 'error'] as const
export type CheckupCauseKind = (typeof CHECKUP_CAUSE_KINDS)[number]

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
  | 'budget-overflow'         // 本层会话带入的记忆超出上限（自动放宽进了档位 / 严格模式用到 95%），不扣分

/** 注册处统一拦截的工具门拒绝码（tools/subagent-gate.ts）。 */
export type ToolGateCode = 'subagent-readonly' // 子 agent 会话（delegationDepth ≥ 1）不可写

/** memory_search 的说明性 note（search.ts）。 */
export type SearchNoteCode =
  | 'no-workspace'        // scope=workspace 但当前会话没有工作目录
  | 'or-fallback'         // 返回列表里没有同时命中全部查询 token（分词命中或字段子串命中）的记忆，但排第一的部分命中记录覆盖够（见 low-coverage），结果按相关性排序
  | 'low-coverage'        // 同上没有全命中，且排第一的部分命中记录缺了整组关键词、或覆盖的查询内容字低于阈值（search/coverage.ts）：命中弱，建议换词再搜，附逐词命中条数
  | 'substring-fallback'  // 返回列表里没有任何 token 命中的记忆，只有旧子串匹配命中的（如 id 前缀）：命中弱，附逐词命中条数（没有可列的词时不附）；三者互斥、substring 优先；查询恰是某条记忆的 id 时三者都不出

/** 表示命中弱的检索说明码：说明里带换词再搜的建议与逐词命中条数。 */
export const WEAK_SEARCH_NOTE_CODES = ['low-coverage', 'substring-fallback'] as const satisfies readonly SearchNoteCode[]

/** frontmatter 解析失败的原因（storage/frontmatter.ts）。 */
export type FrontmatterErrorCode =
  | 'missing-fence'     // 文件不以 --- 开头
  | 'unclosed-fence'    // 找不到闭合的 ---
  | 'yaml-parse'        // 围栏内不是合法 YAML
  | 'not-object'        // YAML 顶层不是对象
  | 'timestamp-format'  // 时间戳不是可接受的形态（日期、ISO 8601 日期时间、数字毫秒）
  | 'timestamp-parse'   // 时间戳无法解析
  | 'schema-invalid'    // 记录 schema 校验失败

/** 读取记忆目录时的目录级说明（info 级，按文件或目录列出；storage/frontmatter.ts、storage/file-table.ts、tools/layer-preread.ts）。 */
export type DirectoryNoteCode =
  | 'reserved-keys'     // frontmatter 写了保留键（scope、workspacePath、召回统计、content），已忽略
  | 'marker-missing'    // workspace 目录缺 .workspace 标记（或标记为空），目录不进清单、文件不读
  | 'dir-unreadable'    // 目录不可读（权限等），计空
  | 'dir-empty'         // workspace 目录顶层没有记忆文件（只剩归档或全空），不进体检清单
  | 'duplicate-id'      // 同一 id 有多个文件：读取时按取舍规则用一份，其余副本不自动删（health / scan 报出）

/** 带 code 的说明条目（scan notes / save warnings 共用形状）。 */
export interface CodedNote<C extends string> {
  code: C
  text: string
}

/** 配置 snapshotOverflow 的取值：带入量超过 snapshotTokenBudget 时 relax 自动放宽、strict 严格按上限。 */
export const OVERFLOW_MODES = ['relax', 'strict'] as const
export type OverflowMode = (typeof OVERFLOW_MODES)[number]

/** 档位：relax 的 tier ≥ 1，上限 × (1 + 0.25 × tier) 是放宽后的天花板；strict 只有一档（用到 95%），tier 恒为 0。
 *  快照组装算出档位、待决账本按档位记超限提醒，两边共用这个形状。 */
export type OverflowLevel = { mode: OverflowMode; tier: number }

/**
 * 用户能「忽略」的体检发现类型（GUI 建议整理里除「很久没确认」外的各类，与体检发现同名）。忽略记录存这个值，
 * 治理侧评分前据它剔除、GUI 命令按它校验；以后加类型往这里追加，旧版本读到不认识的值只是不匹配。
 */
export const IGNORABLE_ADVICE_TYPES = ['expired', 'bloat', 'redundancy', 'orphan', 'misplaced', 'unclear'] as const
export type IgnorableAdviceType = (typeof IGNORABLE_ADVICE_TYPES)[number]

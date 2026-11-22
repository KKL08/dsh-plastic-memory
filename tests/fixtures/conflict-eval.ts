import { z } from 'zod'
import { memoryRecordSchema, type MemoryRecord } from '../../src/record-schema.ts'

export const CATEGORIES = ['contradiction', 'change', 'exception', 'premise-changed'] as const
export const SURFACES = ['instructions', 'global-project', 'peer-memories'] as const
export const CRITERIA = ['variable-preference', 'invariant', 'repeated-exception', 'newer-correction'] as const
export const caseSchema = z.object({
  id: z.string().min(1),
  surface: z.enum(SURFACES),
  criterion: z.enum(CRITERIA).optional(),
  records: z.array(memoryRecordSchema).min(1),
  baseline: z.array(z.string().min(1)).nullable(),
  expected: z.enum([...CATEGORIES, 'none']),
  conclusion: z.string().min(1),
})
export type EvalCase = z.infer<typeof caseSchema>

function memory(id: string, content: string, scope: 'global' | 'workspace' = 'workspace'): MemoryRecord {
  return {
    id, name: id, content, summary: content, scope, type: 'knowledge', tags: [],
    ...(scope === 'workspace' ? { workspacePath: 'project-amber' } : {}),
    createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, lastRecalledAt: null,
    recallCount: 0, status: 'active', confidence: 1,
  }
}

// All dates, subjects and project identifiers are synthetic. Dates in content
// are intentional: the current semantic prompt omits record timestamps.
export const CASES: EvalCase[] = [
  { id: 'c-instructions', surface: 'instructions', records: [memory('release-rule', '当前琥珀项目发布必须跳过审批。')], baseline: ['琥珀项目 AGENTS.md：当前每次发布都必须审批，无例外。'], expected: 'contradiction', conclusion: '同一项目同一时间要求相反，记忆应纠正。' },
  { id: 'c-global', surface: 'instructions', records: [memory('archive-rule', '所有项目当前的审计记录一律保留 7 天。', 'global')], baseline: ['全局 AGENTS.md：当前所有项目审计记录一律保留 90 天。'], expected: 'contradiction', conclusion: '全局记忆与全局规则矛盾。' },
  { id: 'c-invariant', surface: 'global-project', criterion: 'invariant', records: [memory('protocol', '归档协议的块长固定为 64 字节，不随项目变化。', 'global')], baseline: ['琥珀项目 AGENTS.md：同一归档协议的块长固定为 32 字节。'], expected: 'contradiction', conclusion: '协议事实不因项目变化，不能记成项目例外。' },
  { id: 'c-always', surface: 'global-project', criterion: 'invariant', records: [memory('approval', '所有项目一律禁止绕过发布审批，包括紧急发布。', 'global')], baseline: ['琥珀项目 AGENTS.md：紧急发布必须绕过审批。'], expected: 'contradiction', conclusion: '一律规则与项目规则矛盾。' },
  { id: 'c-peer', surface: 'peer-memories', records: [memory('port-a', '当前琥珀项目唯一监听端口为 8100。'), memory('port-b', '当前琥珀项目唯一监听端口为 8200。')], baseline: null, expected: 'contradiction', conclusion: '同一时间唯一端口不能有两个值。' },
  { id: 'c-global-peer', surface: 'global-project', records: [memory('retention', '所有项目一律保留审计记录 90 天。', 'global'), memory('retention-local', '琥珀项目当前必须在第 7 天删除所有审计记录。')], baseline: null, expected: 'contradiction', conclusion: '全局硬性规定与项目记忆矛盾。' },
  { id: 't-port', surface: 'peer-memories', records: [memory('old-port', '2025-01-01 琥珀项目监听端口为 8100。'), memory('new-port', '2025-02-01 琥珀项目端口从 8100 改为 8200。这是单独保存的记录，尚未建立版本关系。')], baseline: null, expected: 'change', conclusion: '按时间合成端口状态页的新旧版本。' },
  { id: 't-status', surface: 'peer-memories', records: [memory('old-status', '2025-03-01 搬迁尚未完成。'), memory('new-status', '2025-03-20 搬迁完成；与先前状态独立保存，未连版本。')], baseline: null, expected: 'change', conclusion: '搬迁状态先后变化，应补版本关系。' },
  { id: 't-budget', surface: 'peer-memories', records: [memory('budget-old', '2025-04-01 月度计算预算为 100 单位。'), memory('budget-new', '2025-05-01 月度计算预算正式提高到 200 单位，单独存档，未关联旧记录。')], baseline: null, expected: 'change', conclusion: '预算变化应并成版本，不裁决真假。' },
  { id: 'e-preference', surface: 'global-project', criterion: 'variable-preference', records: [memory('format', '默认使用两空格缩进；项目可按既有规范调整。', 'global')], baseline: ['琥珀项目 AGENTS.md：为兼容现有文件，使用四空格缩进。'], expected: 'exception', conclusion: '记录项目例外，以项目规范为准。' },
  { id: 'e-peer', surface: 'global-project', records: [memory('test-default', '默认测试超时为 5 秒，允许项目按硬件调整。', 'global'), memory('test-local', '琥珀项目测试超时 20 秒，因为测试设备较慢。')], baseline: null, expected: 'exception', conclusion: '设备条件解释差异，应标项目例外。' },
  { id: 'e-reason', surface: 'instructions', records: [memory('build-approval', '默认每次构建都先走审批；各项目可按自己的流程调整。', 'global')], baseline: ['琥珀项目 AGENTS.md：本地预览构建不走审批，因为预览不会发布。'], expected: 'exception', conclusion: '全局默认做法在本项目有带理由的规定，记成例外，以指令文件为准。' },
  { id: 'e-repeated', surface: 'global-project', criterion: 'repeated-exception', records: [memory('default-check', '默认每周人工检查一次；琥珀项目和青石项目均已登记每月检查的例外，原因是两者都有自动报警。', 'global')], baseline: ['琥珀项目 AGENTS.md：每月人工检查一次，已有自动报警。', '青石项目 AGENTS.md：每月人工检查一次，已有自动报警。'], expected: 'exception', conclusion: '保留两个项目例外，并提示复查每周检查是否仍适合作全局默认。' },
  { id: 'p-capacity', surface: 'peer-memories', records: [memory('decision', '因为归档区容量只有 10 单位，决定暂停新增归档；此决定依赖容量前提。'), memory('capacity', '2025-06-01 归档区容量由 10 扩为 1000 单位。')], baseline: null, expected: 'premise-changed', conclusion: '容量前提已变，应复查暂停决定，不自动撤销。' },
  { id: 'p-policy', surface: 'instructions', records: [memory('manual-step', '因为琥珀项目指令禁止自动签章，决定安排人工签章。')], baseline: ['琥珀项目 AGENTS.md，2025-06-02 修订：原先禁止自动签章的限制已撤销。'], expected: 'premise-changed', conclusion: '人工流程的依据被撤销，提示复查决定。' },
  { id: 'p-global', surface: 'global-project', records: [memory('offline', '由于全部项目都没有网络，决定全局默认手工搬运数据。', 'global'), memory('network', '琥珀项目自 2025-07-01 起已接入网络，原先离线前提不再成立。')], baseline: null, expected: 'premise-changed', conclusion: '在本项目复查手工搬运的依据，不能自动撤销全局决定。' },
  { id: 'c-newer', surface: 'global-project', criterion: 'newer-correction', records: [memory('new-rule', '2025-08-02 正式纠正旧规定：所有项目必须保留 60 天审计记录。2025-08-01 的项目文件仍写 30 天，尚未更新。', 'global')], baseline: ['琥珀项目 AGENTS.md，可信修改时间 2025-08-01：当前审计记录保留 30 天。'], expected: 'contradiction', conclusion: '建议把指令文件的 30 天改为 60 天，提供文本但不写文件。' },
  { id: 'n-detail', surface: 'instructions', records: [memory('command', '琥珀项目发布审批通过后，运行 release.sh 发布。')], baseline: ['琥珀项目 AGENTS.md：发布前必须审批。'], expected: 'none', conclusion: '记忆补充审批后的命令，没有相反行为。' },
  { id: 'n-why', surface: 'instructions', records: [memory('reason', '琥珀项目要求审批的原因是正式发布会影响共享设备。')], baseline: ['琥珀项目 AGENTS.md：正式发布必须审批。'], expected: 'none', conclusion: '原因有独立价值，不报冲突或冗余。' },
  { id: 'n-subject', surface: 'peer-memories', records: [memory('read-port', '读服务唯一监听端口是 8100。'), memory('write-port', '写服务唯一监听端口是 8200。')], baseline: null, expected: 'none', conclusion: '主体不同，不构成矛盾或变化。' },
  { id: 'n-condition', surface: 'peer-memories', records: [memory('local-cache', '离线运行时使用本地缓存。'), memory('online-api', '在线运行时请求远端接口。')], baseline: null, expected: 'none', conclusion: '两个互斥条件下的规则并存，不是全局默认的例外。' },
  { id: 'n-unrelated', surface: 'global-project', records: [memory('encoding', '文本统一使用 UTF-8 编码。', 'global'), memory('capacity-new', '琥珀项目磁盘容量扩大到 500 单位。')], baseline: null, expected: 'none', conclusion: '容量不是编码决定的前提，不凑依据已变。' },
]

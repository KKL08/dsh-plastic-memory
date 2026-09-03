import { describe, expect, it } from 'vitest'
import { memoryRecordSchema, type MemoryRecord } from '../src/record-schema.ts'
import { encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'

// 边缘案例清单（每条一个 it）：
// 1. 派生断言：写入 frontmatter 的键集 ≡ schema 键集 − 别处映射的键集
//    （scope/workspacePath = 目录，content = 正文，lastRecalledAt/recallCount = KV sidecar）。
// 2. 覆盖断言：每个 schema 键必须二选一（写文件 或 在映射集）；漏掉的键按键名响亮报错——
//    重演 globalCandidate 曾漏进 FILE_KEY_ORDER 而静默不落盘的回归。
//
// 说明：frontmatter.ts 未导出 FILE_KEY_ORDER，按约束不自行导出。写入键集改为行为派生——
// 编码一条“全字段填满”的记录再解析回 frontmatter 顶层键。直接导出 FILE_KEY_ORDER 会更清晰
// （见报告的“需 src 支持”一节）。

/** 别处映射、有意不进 frontmatter 的键（与 frontmatter.ts 的 NON_FILE_KEYS 同义，此处作为契约重述）。 */
const MAPPED_ELSEWHERE = new Set<string>([
  'scope', 'workspacePath', // 位置由目录表达
  'content', // markdown 正文
  'lastRecalledAt', 'recallCount', // 易变统计住 KV sidecar
])

/** 所有可选字段都填满，确保它们真的出现在 frontmatter（encode 跳过 undefined）。 */
const fullRecord: MemoryRecord = {
  id: 'mem_full', name: '全字段样例', type: 'preference', scope: 'workspace',
  workspacePath: '/repo', tags: ['a', 'b'], content: '正文', summary: '摘要',
  source: { sessionId: 's1', eventRange: [0, 42], sourceMode: 'user-explicit' },
  createdAt: 1, updatedAt: 2, lastConfirmedAt: 3, lastRecalledAt: 4, recallCount: 5,
  validFrom: 6, validTo: 7, status: 'active', confidence: 0.9,
  supersedes: ['mem_old'], globalCandidate: true,
}

const schemaKeys = Object.keys(memoryRecordSchema.shape)
const writtenKeys = new Set(Object.keys(splitFrontmatter(encodeRecord(fullRecord, {})).data))

describe('frontmatter 写入键集与 schema 一致', () => {
  it('写入键集恰为 schema 键集减去别处映射的键（双向相等）', () => {
    const expectedWritten = schemaKeys.filter(k => !MAPPED_ELSEWHERE.has(k))
    expect([...writtenKeys].sort()).toEqual(expectedWritten.sort())
  })

  it('每个 schema 键都做过决策：漏掉的按键名报错', () => {
    // 既不写文件、又不在映射集的 schema 键 = 悄悄不落盘（globalCandidate 那类 bug）。
    const unaccounted = schemaKeys.filter(k => !writtenKeys.has(k) && !MAPPED_ELSEWHERE.has(k))
    expect(unaccounted, `schema 键未做 frontmatter 决策（既未写文件也不在映射集）：${unaccounted.join(', ')}`).toEqual([])
  })
})

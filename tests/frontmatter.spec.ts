import { describe, expect, it } from 'vitest'
import { splitFrontmatter, decodeRecord, encodeRecord } from '../src/storage/frontmatter.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { FrontmatterError } from '../src/errors.ts'
import { captureError } from './helpers/errors.ts'

// 本文件默认造那条"包管理用 pnpm"的 global preference（编解码/去重断言的固定样本）。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_abc', name: '包管理用 pnpm', type: 'preference',
  tags: ['pnpm', 'npm'], content: '这个项目的包管理一律用 pnpm', summary: '包管理选型',
  source: { sessionId: 's1', eventRange: [0, 42], sourceMode: 'user-explicit' },
  createdAt: 1787166413362, updatedAt: 1787166413362, lastConfirmedAt: 1787166413362, ...partial,
})

describe('往返', () => {
  it('encode → split → decode 逐字段相等（毫秒时间戳无损）', () => {
    const r = record({ scope: 'workspace', workspacePath: '/home/dev/example-project', validTo: 1754784000123 })
    const text = encodeRecord(r, {})
    const back = decodeRecord(splitFrontmatter(text), { scope: 'workspace', workspacePath: '/home/dev/example-project' })
    // 易变字段不进文件：decode 注入默认值
    expect(back.record).toEqual({ ...r, recallCount: 0, lastRecalledAt: null })
    expect(back.record.updatedAt).toBe(1787166413362) // 毫秒精度是 isConflicting 的硬前提
  })

  it('content 以换行结尾时往返无损（encode 恒补一、decode 恒剥一，对称）', () => {
    const r = record({ content: '末尾带换行\n' })
    const back = decodeRecord(splitFrontmatter(encodeRecord(r, {})), { scope: 'global' })
    expect(back.record.content).toBe('末尾带换行\n')
  })

  it('content 原样保留（含内部空行与"---"行）', () => {
    const r = record({ content: '第一段\n\n---\n第二段\n' .trim() })
    const back = decodeRecord(splitFrontmatter(encodeRecord(r, {})), { scope: 'global' })
    expect(back.record.content).toBe(r.content)
  })

  it('globalCandidate 往返保留（true 进 frontmatter、缺省时键不存在）', () => {
    const withFlag = record({ scope: 'workspace', workspacePath: '/repo', globalCandidate: true })
    const text = encodeRecord(withFlag, {})
    expect(text).toContain('globalCandidate: true')
    const back = decodeRecord(splitFrontmatter(text), { scope: 'workspace', workspacePath: '/repo' })
    expect(back.record.globalCandidate).toBe(true)
    expect(encodeRecord(record({}), {})).not.toContain('globalCandidate') // 缺省时键不存在
  })
})

describe('可选键与易变字段纪律', () => {
  it('validFrom/validTo/supersedes 缺省时 frontmatter 里键整个不存在', () => {
    const text = encodeRecord(record({}), {})
    expect(text).not.toContain('validTo')
    expect(text).not.toContain('validFrom')
    expect(text).not.toContain('supersedes')
  })

  it('recallCount/lastRecalledAt/scope/workspacePath 永不出现在文件里', () => {
    const text = encodeRecord(record({ recallCount: 7, lastRecalledAt: 123, scope: 'workspace', workspacePath: '/a' }), {})
    for (const k of ['recallCount', 'lastRecalledAt', 'scope', 'workspacePath']) {
      expect(text).not.toContain(k)
    }
  })
})

describe('未知键往返保留', () => {
  it('decode 收集未知键到 extras，encode 合并回去；schema 键胜出', () => {
    const text = encodeRecord(record({}), { customField: '用户手加的', priority: 5 })
    expect(text).toContain('customField')
    const back = decodeRecord(splitFrontmatter(text), { scope: 'global' })
    expect(back.extras).toEqual({ customField: '用户手加的', priority: 5 })
    // schema 键胜出：extras 里若混入 name，encode 时被忽略
    const t2 = encodeRecord(record({ name: '真名' }), { name: '假名' })
    const b2 = decodeRecord(splitFrontmatter(t2), { scope: 'global' })
    expect(b2.record.name).toBe('真名')
  })
})

describe('malformed 判定', () => {
  it.each([
    ['无围栏', '没有 frontmatter 的普通文本'],
    ['坏 YAML', '---\nname: [未闭合\n---\n正文'],
    ['eventRange 三元组', null], // 由下方单独构造
  ])('%s → throw', (label, raw) => {
    if (raw !== null) { expect(() => splitFrontmatter(raw)).toThrow(); return }
    const bad = encodeRecord(record({}), {}).replace('- 0\n    - 42', '- 0\n    - 42\n    - 1')
    expect(() => decodeRecord(splitFrontmatter(bad), { scope: 'global' })).toThrow()
  })

  it('时间戳不可解析 → throw', () => {
    const bad = encodeRecord(record({}), {}).replace(/createdAt: \S+/, 'createdAt: 不是时间')
    expect(() => decodeRecord(splitFrontmatter(bad), { scope: 'global' })).toThrow()
  })

  it('日期-only 时间戳（丢失毫秒精度）必须响亮拒绝，不得静默折算', () => {
    const bad = encodeRecord(record({}), {}).replace(/createdAt: \S+/, 'createdAt: 2026-08-19')
    const err = captureError(() => decodeRecord(splitFrontmatter(bad), { scope: 'global' }))
    expect(err).toBeInstanceOf(FrontmatterError)
    expect(err).toMatchObject({ code: 'timestamp-format' })
  })

  it('frontmatter 里手写 content/scope 等保留字段：不进 extras、不污染记录', () => {
    const encoded = encodeRecord(record({ content: '真正文' }), {})
    // 在 frontmatter 闭围栏前手动插入保留字段
    const tampered = encoded.replace('---\n\n', 'content: 假正文\nscope: workspace\nrecallCount: 99\n---\n\n')
    const back = decodeRecord(splitFrontmatter(tampered), { scope: 'global' })
    expect(back.record.content).toBe('真正文')
    expect(back.record.scope).toBe('global')
    expect(back.record.recallCount).toBe(0)
    expect(Object.keys(back.extras)).toEqual([])
  })
})

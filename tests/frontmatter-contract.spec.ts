import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { splitFrontmatter, decodeRecord, encodeRecord, decodeFile, computeDigest } from '../src/storage/frontmatter.ts'
import { deriveFileId } from '../src/storage/paths.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'
import { FrontmatterError } from '../src/errors.ts'
import { formatValidity } from '../src/validity.ts'
import { captureError } from './helpers/errors.ts'

// 0.2.0 文件契约：手建文件放宽、派生 id、时间戳放宽、
// digest / handEdited / deletedAt、固定键序、保留键说明、不抛的隔离包装。

const MTIME = Date.UTC(2026, 9, 1, 8, 30, 0, 123)
const GLOBAL = { scope: 'global' } as const
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

const decodeRaw = (raw: string, opts: { relPath?: string; mtimeMs?: number } = { relPath: 'global/x.md', mtimeMs: MTIME }) =>
  decodeRecord(splitFrontmatter(raw), GLOBAL, opts)

const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({
  id: 'mem_abc', name: '包管理用 pnpm', type: 'preference',
  tags: ['pnpm'], content: '这个项目的包管理一律用 pnpm', summary: '包管理选型',
  source: { sessionId: 's1', eventRange: [0, 42], sourceMode: 'user-explicit' },
  createdAt: 1787166413362, updatedAt: 1787166413362, lastConfirmedAt: 1787166413362, ...partial,
})

describe('手建文件缺省值表', () => {
  it('只有 name、type、正文：其余字段按缺省补齐，可选键不设', () => {
    const { record: r, extras, notes } = decodeRaw('---\nname: 手建\ntype: knowledge\n---\n\n手写的正文', { relPath: 'global/手建.md', mtimeMs: MTIME })
    expect(r).toMatchObject({
      id: deriveFileId('global/手建.md'), name: '手建', type: 'knowledge', content: '手写的正文',
      tags: [], summary: '', status: 'active', confidence: 0.9,
      createdAt: MTIME, updatedAt: MTIME, lastConfirmedAt: MTIME,
      scope: 'global', recallCount: 0, lastRecalledAt: null,
    })
    for (const k of ['source', 'supersedes', 'globalCandidate', 'validFrom', 'validTo', 'handEdited', 'deletedAt']) {
      expect(r).not.toHaveProperty(k)
    }
    expect(extras).toEqual({})
    expect(notes).toEqual([])
  })

  it('三个时间戳各自缺省才取 mtime，写了的照用', () => {
    const { record: r } = decodeRaw('---\nname: n\ntype: knowledge\ncreatedAt: 2026-08-19T00:00:00.000Z\n---\n\nc')
    expect(r.createdAt).toBe(Date.UTC(2026, 7, 19))
    expect(r.updatedAt).toBe(MTIME)
    expect(r.lastConfirmedAt).toBe(MTIME)
  })

  it('无 source：confidence 缺省 0.9，写了的照用', () => {
    expect(decodeRaw('---\nname: n\ntype: knowledge\n---\n\nc').record.confidence).toBe(0.9)
    expect(decodeRaw('---\nname: n\ntype: knowledge\nconfidence: 0.6\n---\n\nc').record.confidence).toBe(0.6)
  })

  it('有 source：confidence 缺省取 sourceMode 上限，超出上限的收口', () => {
    const src = 'source:\n  sessionId: s1\n  eventRange: [0, 3]\n  sourceMode: agent-inferred\n'
    expect(decodeRaw(`---\nname: n\ntype: knowledge\n${src}---\n\nc`).record.confidence).toBe(0.5)
    expect(decodeRaw(`---\nname: n\ntype: knowledge\nconfidence: 0.95\n${src}---\n\nc`).record.confidence).toBe(0.5)
    expect(decodeRaw(`---\nname: n\ntype: knowledge\nconfidence: 0.3\n${src}---\n\nc`).record.confidence).toBe(0.3)
  })

  it.each([
    ['缺 name', '---\ntype: knowledge\n---\n\nc'],
    ['缺 type', '---\nname: n\n---\n\nc'],
  ])('%s → FrontmatterError(schema-invalid)', (_label, raw) => {
    const err = captureError(() => decodeRaw(raw))
    expect(err).toBeInstanceOf(FrontmatterError)
    expect(err).toMatchObject({ code: 'schema-invalid' })
  })

  it('缺 id 又没给相对路径、缺时间戳又没给 mtime → schema-invalid（不编造）', () => {
    expect(captureError(() => decodeRaw('---\nname: n\ntype: knowledge\n---\n\nc', { mtimeMs: MTIME }))).toMatchObject({ code: 'schema-invalid' })
    expect(captureError(() => decodeRaw('---\nname: n\ntype: knowledge\n---\n\nc', { relPath: 'global/x.md' }))).toMatchObject({ code: 'schema-invalid' })
  })
})

describe('派生 id', () => {
  it('mem_f + sha1(相对 memoryRoot 的 POSIX 路径)[:10]', () => {
    expect(deriveFileId('global/a.md')).toBe(`mem_f${sha1('global/a.md').slice(0, 10)}`)
    expect(deriveFileId('global/a.md')).toMatch(/^mem_f[0-9a-f]{10}$/)
  })

  it('同一路径每次相同；大小写保留（A.md 与 a.md 不同）', () => {
    expect(deriveFileId('proj-1a2b3c4d/笔记.md')).toBe(deriveFileId('proj-1a2b3c4d/笔记.md'))
    expect(deriveFileId('global/A.md')).not.toBe(deriveFileId('global/a.md'))
  })

  it('平台分隔符归一为 POSIX', () => {
    expect(deriveFileId(join('proj-1a2b3c4d', 'x.md'))).toBe(deriveFileId('proj-1a2b3c4d/x.md'))
  })

  it('文件写了 id 就用文件的，不派生', () => {
    expect(decodeRaw('---\nid: mem_own\nname: n\ntype: knowledge\n---\n\nc').record.id).toBe('mem_own')
    expect(decodeRaw('---\nname: n\ntype: knowledge\n---\n\nc', { relPath: 'global/x.md', mtimeMs: MTIME }).record.id).toBe(deriveFileId('global/x.md'))
  })
})

describe('时间戳读取放宽、写出归一', () => {
  it.each([
    ['日期', '2026-08-19', Date.UTC(2026, 7, 19)],
    ['无毫秒 Z', '2026-08-19T10:00:00Z', Date.UTC(2026, 7, 19, 10)],
    ['带偏移', '2026-08-19T10:00:00+08:00', Date.UTC(2026, 7, 19, 2)],
    ['带偏移带毫秒', '2026-08-19T10:00:00.250-05:00', Date.UTC(2026, 7, 19, 15, 0, 0, 250)],
    ['毫秒 Z', '2026-08-19T10:00:00.123Z', Date.UTC(2026, 7, 19, 10, 0, 0, 123)],
    ['数字毫秒', '1787166413362', 1787166413362],
    ['无时区日期时间（按本地时间）', '2026-08-19T10:00:00', new Date(2026, 7, 19, 10).getTime()],
    ['空格分隔、无秒、无时区（按本地时间）', '2026-08-19 10:00', new Date(2026, 7, 19, 10).getTime()],
  ])('%s：%s', (_label, text, ms) => {
    const raw = `---\nname: n\ntype: knowledge\ncreatedAt: ${text}\ndeletedAt: ${text}\n---\n\nc`
    const { record: r } = decodeRaw(raw)
    expect(r.createdAt).toBe(ms)
    expect(r.deletedAt).toBe(ms)
  })

  it.each([
    ['不存在的日期', '2026-02-30', 'timestamp-parse'],
    ['不存在的月份', '2026-13-45T00:00:00.000Z', 'timestamp-parse'],
    ['斜杠日期', '2026/13/45', 'timestamp-format'],
    ['非时间文本', '昨天', 'timestamp-format'],
  ])('%s → FrontmatterError(%s)', (_label, text, code) => {
    const err = captureError(() => decodeRaw(`---\nname: n\ntype: knowledge\ncreatedAt: ${text}\n---\n\nc`))
    expect(err).toBeInstanceOf(FrontmatterError)
    expect(err).toMatchObject({ code })
  })

  it('写出统一 UTC 毫秒 ISO（含 deletedAt）', () => {
    const { record: r } = decodeRaw('---\nname: n\ntype: knowledge\ncreatedAt: 2026-08-19T10:00:00+08:00\ndeletedAt: 2026-08-20\n---\n\nc')
    const text = encodeRecord(r, {})
    expect(text).toContain('createdAt: 2026-08-19T02:00:00.000Z')
    expect(text).toContain('deletedAt: 2026-08-20T00:00:00.000Z')
    expect(text).toContain(`updatedAt: ${new Date(MTIME).toISOString()}`)
  })
})

// 有效期（validFrom / validTo）与工具同一写法：本机时间 YYYY-MM-DD HH:mm；纯日期取文件 mtime 的本机时分（用户写下它的时刻）。
// 期望值用 new Date(年, 月, 日, 时, 分) 在同一时区里算，与机器时区无关。
describe('有效期键的读取', () => {
  const mtimeAt = new Date(MTIME)
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()
  const decodeValidity = (text: string, opts?: { relPath?: string; mtimeMs?: number }) =>
    decodeRaw(`---\nname: n\ntype: knowledge\nvalidFrom: ${text}\nvalidTo: ${text}\n---\n\nc`, opts).record

  it.each([
    ['日期 + 时分（本机时间）', '2026-08-19 15:00', local(2026, 8, 19, 15, 0), local(2026, 8, 19, 15, 0)],
    ['纯日期：取文件 mtime 的本机时分', '2026-08-19', local(2026, 8, 19, mtimeAt.getHours(), mtimeAt.getMinutes()), local(2026, 8, 19, mtimeAt.getHours(), mtimeAt.getMinutes())],
    ['带偏移', '2026-08-19T10:00:00+08:00', Date.UTC(2026, 7, 19, 2), Date.UTC(2026, 7, 19, 2)],
    // 旧版本写的毫秒不在整分钟上：读出来就按分钟向外取整（validFrom 退、validTo 进），与写回文件的值一致，有效期只会变长
    ['旧文件的 UTC 毫秒 ISO', '2026-08-19T10:00:00.123Z', Date.UTC(2026, 7, 19, 10, 0), Date.UTC(2026, 7, 19, 10, 1)],
    ['数字毫秒', '1787166413362', Math.floor(1787166413362 / 60_000) * 60_000, Math.ceil(1787166413362 / 60_000) * 60_000],
  ])('%s：%s', (_label, text, fromMs, toMs) => {
    const r = decodeValidity(text)
    expect(r.validFrom).toBe(fromMs)
    expect(r.validTo).toBe(toMs)
  })

  it('同一个文件反复读，纯日期换算的结果不变', () => {
    expect(decodeValidity('2026-08-19').validTo).toBe(decodeValidity('2026-08-19').validTo)
  })

  it('纯日期只给有效期键补时分：createdAt 等其他时间键照旧按 UTC 零点', () => {
    const { record: r } = decodeRaw('---\nname: n\ntype: knowledge\ncreatedAt: 2026-08-19\nvalidTo: 2026-08-19\n---\n\nc')
    expect(r.createdAt).toBe(Date.UTC(2026, 7, 19))
    expect(r.validTo).toBe(local(2026, 8, 19, mtimeAt.getHours(), mtimeAt.getMinutes()))
  })

  it('不存在的纯日期照旧隔离（timestamp-parse）', () => {
    expect(captureError(() => decodeValidity('2026-02-30'))).toMatchObject({ code: 'timestamp-parse' })
  })

})

describe('有效期键的写出', () => {
  const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime()

  it('写成本机时间 YYYY-MM-DD HH:mm，用户打开文件能直接看懂、照着改；其他时间键仍是 UTC 毫秒 ISO', () => {
    const text = encodeRecord(record({ validFrom: local(2026, 8, 19, 9, 30), validTo: local(2026, 8, 20, 18, 0), deletedAt: 1787166413362 }), {})
    expect(text).toContain('\nvalidFrom: 2026-08-19 09:30\n')
    expect(text).toContain('\nvalidTo: 2026-08-20 18:00\n')
    expect(text).toContain('\ncreatedAt: 2026-08-19T')
    expect(text).toContain(`\ndeletedAt: ${new Date(1787166413362).toISOString()}\n`)
  })

  it('不在整分钟上的毫秒向外取整：validTo 进到下一分钟、validFrom 退到本分钟', () => {
    const text = encodeRecord(record({ validFrom: local(2026, 8, 19, 9, 30) + 59_999, validTo: local(2026, 8, 20, 18, 0) + 1 }), {})
    expect(text).toContain('\nvalidFrom: 2026-08-19 09:30\n')
    expect(text).toContain('\nvalidTo: 2026-08-20 18:01\n')
  })

  it('写出再读回值不变，再写一次逐字节相同', () => {
    const r = record({ validFrom: local(2026, 8, 19, 9, 30), validTo: local(2026, 8, 20, 18, 0) })
    const text = encodeRecord(r, {})
    const back = decodeRaw(text).record
    expect(back.validFrom).toBe(r.validFrom)
    expect(back.validTo).toBe(r.validTo)
    expect(encodeRecord(back, {})).toBe(text)
  })
})

describe('digest', () => {
  it('d1: + sha1(name、summary、正文以 LF 拼接)[:16]', () => {
    expect(computeDigest('名', '摘', '正文')).toBe(`d1:${sha1('名\n摘\n正文').slice(0, 16)}`)
  })

  it('CRLF 归一为 LF', () => {
    expect(computeDigest('n', 's\r\nt', 'a\r\nb')).toBe(computeDigest('n', 's\nt', 'a\nb'))
  })

  it('encode 每次重算写出，extras 里的旧 digest 不胜出', () => {
    const r = record({})
    const text = encodeRecord(r, { digest: 'd1:0000000000000000' })
    expect(splitFrontmatter(text).data.digest).toBe(computeDigest(r.name, r.summary, r.content))
  })

  it('decode：digest 匹配 → 不标手编；digest 不进 extras', () => {
    const back = decodeRaw(encodeRecord(record({}), {}))
    expect(back.record).not.toHaveProperty('handEdited')
    expect(back.extras).toEqual({})
  })

  it('decode：digest 存在且不匹配（正文被手改）→ 内存 handEdited: true', () => {
    const tampered = encodeRecord(record({}), {}).replace('一律用 pnpm', '一律用 npm')
    expect(decodeRaw(tampered).record.handEdited).toBe(true)
  })

  it('decode：name / summary 被手改同样判手编', () => {
    const text = encodeRecord(record({}), {})
    expect(decodeRaw(text.replace('name: 包管理用 pnpm', 'name: 包管理用 yarn')).record.handEdited).toBe(true)
    expect(decodeRaw(text.replace('summary: 包管理选型', 'summary: 选型')).record.handEdited).toBe(true)
  })

  it.each([
    ['缺省', (t: string) => t.replace(/digest: \S+\n/, '')],
    ['不认识的前缀', (t: string) => t.replace(/digest: \S+/, 'digest: d9:0123456789abcdef')],
    ['非字符串', (t: string) => t.replace(/digest: \S+/, 'digest: 42')],
  ])('decode：digest %s → 视为未知，不标手编（即使正文变了）', (_label, mutate) => {
    const text = mutate(encodeRecord(record({}), {})).replace('一律用 pnpm', '一律用 npm')
    const back = decodeRaw(text)
    expect(back.record).not.toHaveProperty('handEdited')
    expect(back.extras).toEqual({})
  })

  it('手建文件没写 summary 时按空串算 digest', () => {
    const r = decodeRaw('---\nname: n\ntype: knowledge\n---\n\nc').record
    expect(splitFrontmatter(encodeRecord(r, {})).data.digest).toBe(computeDigest('n', '', 'c'))
  })
})

describe('handEdited 与 deletedAt 编解码', () => {
  it('往返保留；缺省时键不存在', () => {
    const r = record({ handEdited: true, deletedAt: 1787166499999, status: 'deleted' })
    const text = encodeRecord(r, {})
    expect(text).toContain('handEdited: true')
    expect(text).toContain('deletedAt: ')
    expect(decodeRaw(text).record).toEqual({ ...r, recallCount: 0, lastRecalledAt: null })
    const plain = encodeRecord(record({}), {})
    expect(plain).not.toContain('handEdited')
    expect(plain).not.toContain('deletedAt')
  })

  it('落盘 handEdited: true 而 digest 匹配：标记保留（只由 update 清除）', () => {
    expect(decodeRaw(encodeRecord(record({ handEdited: true }), {})).record.handEdited).toBe(true)
  })
})

describe('写出键顺序固定', () => {
  it('全字段 + 未知键：已知键按契约序，未知键原样接在后面', () => {
    const r = record({
      validFrom: 1, validTo: 2, deletedAt: 3, supersedes: ['mem_old'], globalCandidate: true,
      handEdited: true, status: 'deleted',
    })
    const keys = Object.keys(splitFrontmatter(encodeRecord(r, { zeta: 1, alpha: 2 })).data)
    expect(keys).toEqual([
      'id', 'name', 'type', 'tags', 'status', 'confidence', 'source',
      'createdAt', 'updatedAt', 'lastConfirmedAt', 'deletedAt', 'validFrom', 'validTo',
      'supersedes', 'summary', 'globalCandidate', 'handEdited', 'digest',
      'zeta', 'alpha',
    ])
  })

  it('无 source 时不写 source 键', () => {
    const r = decodeRaw('---\nname: n\ntype: knowledge\n---\n\nc').record
    expect(Object.keys(splitFrontmatter(encodeRecord(r, {})).data)).not.toContain('source')
  })
})

describe('保留键', () => {
  it('出现即忽略，按出现顺序进 info 级目录说明；不进 extras、不污染记录', () => {
    const raw = '---\nname: n\ntype: knowledge\nrecallCount: 9\nscope: workspace\nworkspacePath: /x\nlastRecalledAt: 5\ncontent: 假正文\nfoo: bar\n---\n\n真正文'
    const { record: r, extras, notes } = decodeRaw(raw)
    expect(r).toMatchObject({ scope: 'global', content: '真正文', recallCount: 0, lastRecalledAt: null })
    expect(r).not.toHaveProperty('workspacePath')
    expect(extras).toEqual({ foo: 'bar' })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      level: 'info', code: 'reserved-keys',
      keys: ['recallCount', 'scope', 'workspacePath', 'lastRecalledAt', 'content'],
    })
    expect(notes[0].text).toContain('recallCount')
  })
})

describe('decodeFile：解析失败返回隔离条目而不是抛', () => {
  const path = '/root/global/坏.md'
  it.each([
    ['无围栏', '没有 frontmatter'],
    ['坏 YAML', '---\nname: [未闭合\n---\n正文'],
    ['schema 不过', '---\ntype: knowledge\n---\n\nc'],
    ['时间戳坏', '---\nname: n\ntype: knowledge\ncreatedAt: 昨天\n---\n\nc'],
  ])('%s → { ok: false, path, error }', (_label, raw) => {
    const out = decodeFile(raw, { path, loc: GLOBAL, relPath: 'global/坏.md', mtimeMs: MTIME })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.path).toBe(path)
    expect(typeof out.error).toBe('string')
    expect(out.error.length).toBeGreaterThan(0)
  })

  it('成功 → { ok: true, record, extras, notes }', () => {
    const out = decodeFile('---\nname: n\ntype: knowledge\nscope: global\n---\n\nc', { path, loc: GLOBAL, relPath: 'global/n.md', mtimeMs: MTIME })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.record.id).toBe(deriveFileId('global/n.md'))
    expect(out.notes.map(n => n.code)).toEqual(['reserved-keys'])
  })
})

describe('0.1.x 旧文件往返', () => {
  // 0.1.x 写出的形态：有 id、source、confidence，无 digest；时间戳是 ISO 毫秒（也兼容数字毫秒）。
  const legacy = (ts: (ms: number) => string) => [
    '---',
    'id: mem_legacy01',
    'name: 测试不 mock 数据库',
    'type: preference',
    'tags:',
    '  - testing',
    '  - db',
    'status: active',
    'confidence: 0.5',
    'source:',
    '  sessionId: sess-old',
    '  eventRange:',
    '    - 3',
    '    - 9',
    '  sourceMode: agent-inferred',
    `createdAt: ${ts(1754784000123)}`,
    `updatedAt: ${ts(1754784000456)}`,
    `lastConfirmedAt: ${ts(1754784000789)}`,
    `validTo: ${ts(1760000000000)}`,
    'supersedes:',
    '  - mem_older',
    'summary: 集成测试连真库',
    'globalCandidate: true',
    'owner: yk',
    '---',
    '',
    '集成测试必须连真实数据库，不 mock。',
    '',
  ].join('\n')

  it.each([
    ['数字时间戳', (ms: number) => String(ms)],
    ['ISO 毫秒时间戳', (ms: number) => new Date(ms).toISOString()],
  ])('%s：decode → encode → decode 语义不变，补写 digest、不标手编', (_label, ts) => {
    const first = decodeRecord(splitFrontmatter(legacy(ts)), { scope: 'workspace', workspacePath: '/repo' }, { relPath: 'repo-1/x.md', mtimeMs: MTIME })
    expect(first.record).toMatchObject({
      id: 'mem_legacy01', confidence: 0.5, createdAt: 1754784000123, updatedAt: 1754784000456,
      lastConfirmedAt: 1754784000789, validTo: 1760000040000, supersedes: ['mem_older'], globalCandidate: true,
      source: { sessionId: 'sess-old', eventRange: [3, 9], sourceMode: 'agent-inferred' },
      content: '集成测试必须连真实数据库，不 mock。',
    })
    expect(first.record).not.toHaveProperty('handEdited')
    expect(first.extras).toEqual({ owner: 'yk' })

    const rewritten = encodeRecord(first.record, first.extras)
    expect(rewritten).toContain(`digest: ${computeDigest(first.record.name, first.record.summary, first.record.content)}`)
    expect(rewritten).toContain('createdAt: 2025-08-10T00:00:00.123Z')
    expect(rewritten).toContain(`validTo: ${formatValidity(1760000040000)}\n`)   // 1760000000000 不在整分钟上，进到下一分钟
    const second = decodeRecord(splitFrontmatter(rewritten), { scope: 'workspace', workspacePath: '/repo' }, { relPath: 'repo-1/x.md', mtimeMs: MTIME + 1 })
    expect(second.record).toEqual(first.record)
    expect(second.extras).toEqual(first.extras)
    expect(second.notes).toEqual([])
  })
})

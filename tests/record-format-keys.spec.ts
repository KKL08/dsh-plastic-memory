import { describe, expect, it } from 'vitest'
import { anchorSourceMode, anchorsOf, isFactTime, isLocked, memoryRecordSchema, readChangeKind, recallOverride, type MemoryRecord } from '../src/record-schema.ts'
import { decodeFile, decodeRecord, encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'

const loc = { scope: 'global' } as const
const base: MemoryRecord = {
  id: 'mem_a', name: '发版步骤', type: 'project', scope: 'global', tags: [], content: '正文', summary: '摘要',
  createdAt: Date.UTC(2026, 10, 1), updatedAt: Date.UTC(2026, 10, 2), lastConfirmedAt: Date.UTC(2026, 10, 2),
  lastRecalledAt: null, recallCount: 0, status: 'active', confidence: 0.9,
}
const roundTrip = (r: MemoryRecord) => decodeRecord(splitFrontmatter(encodeRecord(r, {})), loc)
/** 只带必需键的文件，额外的 frontmatter 行插在 type 之后。 */
const fileWith = (...lines: string[]) => [
  '---', 'id: mem_a', 'name: n', 'type: project', ...lines,
  'createdAt: 2026-11-01T00:00:00.000Z', 'updatedAt: 2026-11-01T00:00:00.000Z', 'lastConfirmedAt: 2026-11-01T00:00:00.000Z',
  '---', '', '正文', '',
].join('\n')
/** 读文件、写回、再读：返回两次读到的记录和写回的 frontmatter。 */
function readWriteRead(raw: string) {
  const first = decodeFile(raw, { path: 'x.md', loc })
  if (!first.ok) throw new Error(`进了隔离：${JSON.stringify(first)}`)
  const text = encodeRecord(first.record, first.extras)
  const second = decodeFile(text, { path: 'x.md', loc })
  if (!second.ok) throw new Error('写回后读不进来')
  return { first: first.record, second: second.record, fm: splitFrontmatter(text).data as Record<string, any> }
}

describe('格式：记忆文件新键', () => {
  it('新键往返读写不丢不变，嵌套的时间写成 ISO、读回毫秒', () => {
    const r: MemoryRecord = {
      ...base,
      source: { sessionId: 's2', eventRange: [5, 9], sourceMode: 'user-explicit' },
      sourceTrail: [
        { sessionId: 's2', eventRange: [5, 9], sourceMode: 'user-explicit', at: Date.UTC(2026, 10, 2, 8), initiator: 'user', evidence: { user: true, tool: false }, change: 'refine', by: 'main' },
        { sessionId: 's1', eventRange: [1, 3], sourceMode: 'agent-inferred', at: Date.UTC(2026, 10, 1, 8) },
      ],
      stateSince: Date.UTC(2026, 10, 1, 9, 30, 0, 123), factTime: '2026-11-20',
      lastChange: { kind: 'refine', at: Date.UTC(2026, 10, 2, 8, 0, 0, 5), op: 'op_x', by: 'main' }, lastWriteOp: 'op_x',
      related: ['mem_b'], premises: [{ id: 'mem_c', digest: 'd1:0123456789abcdef' }], recall: 'core', locked: false, lockedUntil: Date.UTC(2027, 0, 1),
    }
    const text = encodeRecord(r, {})
    const fm = splitFrontmatter(text).data
    expect(fm.lastChange).toMatchObject({ at: '2026-11-02T08:00:00.005Z' })
    expect((fm.sourceTrail as Array<{ at: string }>)[1]!.at).toBe('2026-11-01T08:00:00.000Z')
    expect(fm.stateSince).toBe('2026-11-01T09:30:00.123Z')
    expect(roundTrip(r).record).toEqual(r)
  })

  it('旧文件没有新键：照读，写回也不多出新键', () => {
    const { record } = roundTrip(base)
    expect(record).toEqual(base)
    const keys = Object.keys(splitFrontmatter(encodeRecord(record, {})).data)
    for (const k of ['sourceTrail', 'stateSince', 'factTime', 'lastChange', 'lastWriteOp', 'related', 'premises', 'recall', 'locked', 'lockedUntil']) {
      expect(keys).not.toContain(k)
    }
  })

  it.each([
    ['2026', '2026'], ['2026-11', '2026-11'], ['2026-11-20', '2026-11-20'],
    ['2026-11-20T14:30', '2026-11-20T14:30'], ['2026-11-20 14:30:05+08:00', '2026-11-20 14:30:05+08:00'],
    ['2026-11-20T23:59:59.250Z', '2026-11-20T23:59:59.250Z'], ['2026-11-20T00:00-0930', '2026-11-20T00:00-0930'],
  ])('事实时间按用户写的精度存：%s', (written, expected) => {
    const raw = `---\nid: mem_a\nname: n\ntype: project\nfactTime: ${written}\ncreatedAt: 2026-11-01T00:00:00.000Z\nupdatedAt: 2026-11-01T00:00:00.000Z\nlastConfirmedAt: 2026-11-01T00:00:00.000Z\n---\n\n正文\n`
    const out = decodeFile(raw, { path: 'x.md', loc })
    expect(out.ok && out.record.factTime).toBe(expected)
    if (out.ok) expect(roundTrip(out.record).record.factTime).toBe(expected)
  })

  it.each([
    '2026-13', '2026-02-30', 'last year', '26-11',
    '2026-11-20T24:00', '2026-11-20T12:60:00Z', '2026-11-20T12:00:60', '2026-11-20T12:00+24:00', '2026-11-20T12:00+08:60',
  ])('事实时间写法不认识时，这条进隔离：%s', written => {
    const raw = `---\nid: mem_a\nname: n\ntype: project\nfactTime: ${written}\ncreatedAt: 2026-11-01T00:00:00.000Z\nupdatedAt: 2026-11-01T00:00:00.000Z\nlastConfirmedAt: 2026-11-01T00:00:00.000Z\n---\n\n正文\n`
    expect(decodeFile(raw, { path: 'x.md', loc }).ok).toBe(false)
  })

  it('新增的嵌套对象保留不认识的子字段（以后的版本加字段，这一版读写不丢）', () => {
    const raw = [
      '---', 'id: mem_a', 'name: n', 'type: project',
      'createdAt: 2026-11-01T00:00:00.000Z', 'updatedAt: 2026-11-01T00:00:00.000Z', 'lastConfirmedAt: 2026-11-01T00:00:00.000Z',
      'sourceTrail:', '  - sessionId: s1', '    eventRange: [1, 2]', '    sourceMode: user-explicit', '    at: 2026-11-01T00:00:00.000Z',
      '    later: kept', '    evidence: {user: true, tool: false, later: kept}',
      'lastChange: {kind: refine, at: 2026-11-01T00:00:00.000Z, op: op_1, by: main, later: kept}',
      'premises:', '  - {id: mem_b, digest: d1, later: kept}',
      '---', '', '正文', '',
    ].join('\n')
    const out = decodeFile(raw, { path: 'x.md', loc })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const fm = splitFrontmatter(encodeRecord(out.record, out.extras)).data as Record<string, any>
    expect(fm.sourceTrail[0]).toMatchObject({ later: 'kept', evidence: { later: 'kept' } })
    expect(fm.lastChange).toMatchObject({ later: 'kept', at: '2026-11-01T00:00:00.000Z' })
    expect(fm.premises[0]).toMatchObject({ later: 'kept' })
  })

  it.each([
    ['stateSince: -8640000000000001'],
    ['lastChange: {kind: refine, at: 9e15, op: op_1, by: main}'],
    ['sourceTrail: [{sessionId: s1, eventRange: [1, 2], sourceMode: user-explicit, at: 9e15}]'],
  ])('新键的时间写成超出日期范围的数字：读不进来、这条进隔离，不等到写回时报错（%s）', line => {
    const raw = `---\nid: mem_a\nname: n\ntype: project\n${line}\ncreatedAt: 2026-11-01T00:00:00.000Z\nupdatedAt: 2026-11-01T00:00:00.000Z\nlastConfirmedAt: 2026-11-01T00:00:00.000Z\n---\n\n正文\n`
    expect(decodeFile(raw, { path: 'x.md', loc }).ok).toBe(false)
  })

  it.each([
    ['locked: .nan'], ['locked: .inf'], ['locked: -0'], ['locked: &a [*a]'], ['recall: .nan'], ['lockedUntil: .inf'],
    ['lastChange: {kind: refine, at: 2026-11-01T00:00:00.000Z, op: op_1, later: .nan}'],
    ['premises: [{id: mem_b, digest: d1, later: &a [*a]}]'],
  ])('开放的部分写出 YAML 才有、JSON 没有的值：这条进隔离，不让它打穿快照和写回（%s）', line => {
    expect(decodeFile(fileWith(line), { path: 'x.md', loc }).ok).toBe(false)
  })

  it('改动性质、锚的改动和来源方式、注入档位、锁读到不认识的取值：照读，按读取口径归一，写回原样', () => {
    const { first, second, fm } = readWriteRead(fileWith(
      'lastChange: {kind: merged-later-kind, at: 2026-11-01T00:00:00.000Z, op: op_1}',
      'sourceTrail: [{sessionId: s1, eventRange: [1, 2], sourceMode: recovered-later, at: 2026-11-01T00:00:00.000Z, change: split-later, evidence: {user: true}}]',
      'recall: pinned-v2',
      'locked: {level: strict}',
    ))
    expect(readChangeKind(first.lastChange?.kind)).toBe('refine')
    expect(anchorSourceMode(first.sourceTrail![0]!)).toBe('agent-inferred')
    expect(recallOverride(first)).toBeUndefined()
    expect(isLocked(first, Date.now())).toBe(true)
    expect(second).toEqual(first)
    expect(fm).toMatchObject({
      lastChange: { kind: 'merged-later-kind' }, recall: 'pinned-v2', locked: { level: 'strict' },
      sourceTrail: [{ sourceMode: 'recovered-later', change: 'split-later', evidence: { user: true } }],
    })
    expect(fm.lastChange).not.toHaveProperty('by')
  })

  it.each([['locked: by-user'], ['locked: null'], ['locked:'], ['locked: 0']])('锁写成非布尔值：照读、算锁定，写回原样（%s）', line => {
    const { first, fm } = readWriteRead(fileWith(line))
    expect(isLocked(first, Date.now())).toBe(true)
    expect(fm.locked).toEqual(first.locked)
  })

  it('锁到期时刻写成日期：读成毫秒、写回 UTC ISO；写坏的照读、按不过期算锁定，原样写回', () => {
    const dated = readWriteRead(fileWith('locked: true', 'lockedUntil: 2027-01-01'))
    expect(dated.first.lockedUntil).toBe(Date.parse('2027-01-01T00:00:00Z'))
    expect(dated.fm.lockedUntil).toBe('2027-01-01T00:00:00.000Z')
    expect(isLocked(dated.first, Date.parse('2027-01-02T00:00:00Z'))).toBe(false)
    for (const bad of ['下周五', '8640000000000001', '-8640000000000001', '[2020-01-01]', '{at: 2020-01-01}']) {
      const kept = readWriteRead(fileWith('locked: true', `lockedUntil: ${bad}`))
      expect(isLocked(kept.first, Date.now())).toBe(true)
      expect(kept.fm.lockedUntil).toEqual(kept.first.lockedUntil)
      expect(typeof kept.first.lockedUntil === 'number' && Math.abs(kept.first.lockedUntil) <= 8.64e15).toBe(false)
    }
  })

  it('写入方给的开放取值里有 undefined（容器里、稀疏数组）：校验不过，不让写回时悄悄改值', () => {
    const valid = (patch: Partial<MemoryRecord>) => memoryRecordSchema.safeParse({ ...base, ...patch }).success
    expect(valid({ locked: { level: 'strict' } })).toBe(true)
    expect(valid({ locked: { x: undefined } })).toBe(false)
    expect(valid({ recall: [undefined] })).toBe(false)
    expect(valid({ locked: new Array(1) })).toBe(false)
  })

  it('0–99 年的日期按公历核对，不被当成 1900 年代', () => {
    expect(isFactTime('0000-02-29')).toBe(true)
    expect(isFactTime('0001-02-29')).toBe(false)
  })

  it('真正不认识的顶层键照旧原样保留', () => {
    const raw = `---\nid: mem_a\nname: n\ntype: project\nfutureKey: {a: 1}\ncreatedAt: 2026-11-01T00:00:00.000Z\nupdatedAt: 2026-11-01T00:00:00.000Z\nlastConfirmedAt: 2026-11-01T00:00:00.000Z\n---\n\n正文\n`
    const out = decodeFile(raw, { path: 'x.md', loc })
    expect(out.ok && out.extras).toEqual({ futureKey: { a: 1 } })
    if (out.ok) expect(splitFrontmatter(encodeRecord(out.record, out.extras)).data.futureKey).toEqual({ a: 1 })
  })
})

describe('格式：开放取值的读取口径', () => {
  it('改动性质：缺省是没改过，不认识的按细化', () => {
    expect(readChangeKind(undefined)).toBeUndefined()
    expect(readChangeKind('state-change')).toBe('state-change')
    expect(readChangeKind('corroborate')).toBe('corroborate')
    expect(readChangeKind('merged-later-kind')).toBe('refine')
  })

  it('单条注入档位：认得的生效，不认识的跟随类型', () => {
    expect(recallOverride({ recall: 'unlisted' })).toBe('unlisted')
    expect(recallOverride({ recall: 'core' })).toBe('core')
    expect(recallOverride({ recall: 'pinned-v2' })).toBeUndefined()
    expect(recallOverride({})).toBeUndefined()
  })

  it.each<[unknown, number | undefined, boolean]>([
    [undefined, undefined, false], [false, undefined, false],
    [true, undefined, true], ['by-user', undefined, true], [{ level: 'strict' }, undefined, true], [null, undefined, true], [0, undefined, true],
    [true, 999, false], [true, 1000, false], [true, 1001, true],
  ])('锁：locked=%j、lockedUntil=%j 时锁定=%j（现在 1000）', (locked, lockedUntil, expected) => {
    expect(isLocked({ locked, lockedUntil }, 1000)).toBe(expected)
  })
})

describe('格式：source 和出处清单对齐', () => {
  const src = { sessionId: 's9', eventRange: [10, 12] as [number, number], sourceMode: 'user-explicit' as const }
  const anchor = { ...src, at: 1, by: 'main' }

  it('没有清单时，source 就是唯一的锚', () => {
    expect(anchorsOf({ ...base, source: src })).toEqual([{ ...src, at: base.updatedAt }])
  })
  it('清单头一个就是 source：原样返回', () => {
    expect(anchorsOf({ ...base, source: src, sourceTrail: [anchor] })).toEqual([anchor])
  })
  it('旧版本之后写过（source 和清单头一个对不上）：把 source 当成没有发起方信息的新锚补在最前', () => {
    const older = { sessionId: 's1', eventRange: [1, 2] as [number, number], sourceMode: 'agent-inferred' as const, at: 0, initiator: 'user' }
    const anchors = anchorsOf({ ...base, source: src, sourceTrail: [older] })
    expect(anchors).toEqual([{ ...src, at: base.updatedAt }, older])
    expect(anchors[0]).not.toHaveProperty('initiator')
  })
  it('没有 source：返回清单本身', () => {
    expect(anchorsOf({ ...base, sourceTrail: [anchor] })).toEqual([anchor])
    expect(anchorsOf(base)).toEqual([])
  })
})

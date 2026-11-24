import { describe, expect, it } from 'vitest'
import { applyChange } from '../src/change.ts'
import {
  advance, basisOf, changeOpSchema, checkOp, hasForeignSecret, newProgress, receiptOf, revertBlock, reverted, scanFingerprint,
  type ChangeOp, type CheckInput,
} from '../src/governance/changeset.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

// 变更集的规则：纯函数，不碰存储

const T0 = 1_700_000_000_000

function base(extra: Partial<MemoryRecord> = {}): MemoryRecord {
  return record({ id: 'mem_a', name: '发版流程', content: '旧正文', summary: '旧摘要', tags: ['x'], createdAt: T0, updatedAt: T0, lastConfirmedAt: T0, ...extra })
}

function op(extra: Partial<ChangeOp> & Pick<ChangeOp, 'kind'>, target = base()): ChangeOp {
  return { id: 'o1', memoryId: target.id, basis: [basisOf(target)], ...extra }
}

function input(target: MemoryRecord | undefined, extra: Partial<CheckInput> = {}): CheckInput {
  return { target, basis: new Map(), progress: newProgress(), isSecretChecked: false, ...extra }
}

const edit = (target: MemoryRecord, patch: ChangeOp['patch'], expect: ChangeOp['expect']) => op({ kind: 'edit', patch, expect }, target)

describe('扫描指纹', () => {
  it('名称、摘要、正文、事实时间、有效期、来源方式、最近一次改动的性质、取代关系任一项变了就变', () => {
    const r = base()
    const fp = scanFingerprint(r)
    const variants: Array<Partial<MemoryRecord>> = [
      { name: '别的' }, { summary: '别的' }, { content: '别的' }, { factTime: '2026-01' }, { validFrom: T0 }, { validTo: T0 + 60_000 },
      { source: { ...r.source!, sourceMode: 'agent-inferred' } }, { lastChange: { kind: 'correct', at: T0, op: 'op_x' } }, { supersedes: ['mem_b'] },
    ]
    for (const v of variants) expect(scanFingerprint({ ...r, ...v }), JSON.stringify(v)).not.toBe(fp)
  })

  it('标签、注入档位、关联、锁、确认时间、提交标记不在里面；换行风格不算改', () => {
    const r = base({ content: '一\n二' })
    const fp = scanFingerprint(r)
    const same: Array<Partial<MemoryRecord>> = [
      { tags: ['y'] }, { recall: 'never' }, { related: ['mem_b'] }, { locked: true }, { lastConfirmedAt: T0 + 9 }, { lastWriteOp: 'op_9' }, { content: '一\r\n二' },
    ]
    for (const v of same) expect(scanFingerprint({ ...r, ...v }), JSON.stringify(v)).toBe(fp)
  })
})

describe('锁内核对', () => {
  it('依据没变、字段还是读到时的值：只写确实要变的字段', () => {
    const r = base()
    const check = checkOp(edit(r, { content: '新正文', summary: '旧摘要' }, { content: '旧正文', summary: '旧摘要' }), input(r))
    expect(check).toEqual({ kind: 'write', fields: { content: '新正文' } })
  })

  it('按旧正文做的决定，期间正文被纠正了：字段值对得上也跳过', () => {
    const read = base()
    const now = { ...read, content: '纠正后的正文' }
    const demote = op({ kind: 'set-recall', patch: { recall: 'never' }, expect: { recall: null } }, read)
    expect(checkOp(demote, input(now))).toEqual({ kind: 'skip', reason: 'basis-changed', memoryId: 'mem_a' })
  })

  it('补丁里的字段已不是读到时的值：跳过', () => {
    const read = base()
    const now = { ...read, tags: ['别处改的'] }
    expect(checkOp(edit(read, { tags: ['y'] }, { tags: ['x'] }), input(now))).toMatchObject({ kind: 'skip', reason: 'field-changed' })
  })

  it('目标不在了、被软删了：跳过；换了作用域：跳过', () => {
    const read = base()
    const o = edit(read, { content: '新' }, { content: '旧正文' })
    expect(checkOp(o, input(undefined))).toMatchObject({ kind: 'skip', reason: 'gone' })
    expect(checkOp(o, input({ ...read, status: 'deleted' }))).toMatchObject({ kind: 'skip', reason: 'gone' })
    expect(checkOp(o, input({ ...read, scope: 'workspace', workspacePath: '/p' }))).toMatchObject({ kind: 'skip', reason: 'moved' })
  })

  it('判断时读过的另一条记忆变了、不在用了、搬走了：跳过，说是哪一条', () => {
    const read = base()
    const other = base({ id: 'mem_b', content: '另一条' })
    const o: ChangeOp = { ...op({ kind: 'forget' }, read), basis: [basisOf(read), basisOf(other)] }
    const withOther = (b: MemoryRecord | undefined) => input(read, { basis: new Map(b === undefined ? [] : [[b.id, b]]) })
    expect(checkOp(o, withOther(other))).toEqual({ kind: 'forget' })
    expect(checkOp(o, withOther({ ...other, content: '改过' }))).toEqual({ kind: 'skip', reason: 'basis-changed', memoryId: 'mem_b' })
    expect(checkOp(o, withOther({ ...other, status: 'deleted' }))).toEqual({ kind: 'skip', reason: 'basis-changed', memoryId: 'mem_b' })
    expect(checkOp(o, withOther(undefined))).toEqual({ kind: 'skip', reason: 'basis-changed', memoryId: 'mem_b' })
    expect(checkOp(o, withOther({ ...other, scope: 'workspace', workspacePath: '/p' }))).toEqual({ kind: 'skip', reason: 'moved', memoryId: 'mem_b' })
  })

  it('期间别处只改了不在依据里的东西（注入档位、关联、确认时间）：照做', () => {
    const read = base()
    const now = { ...read, recall: 'never', related: ['mem_z'], lastConfirmedAt: T0 + 5 }
    expect(checkOp(edit(read, { content: '新' }, { content: '旧正文' }), input(now))).toMatchObject({ kind: 'write' })
  })

  it('补丁和现状一样：没有可写的；keep 只核对不写；这一版不落地的操作、带了不该带的字段：跳过', () => {
    const r = base()
    expect(checkOp(edit(r, { content: '旧正文' }, { content: '旧正文' }), input(r))).toMatchObject({ kind: 'skip', reason: 'no-change' })
    expect(checkOp(op({ kind: 'keep' }, r), input(r))).toEqual({ kind: 'none' })
    expect(checkOp(op({ kind: 'merge' }, r), input(r))).toMatchObject({ kind: 'skip', reason: 'unsupported' })
    expect(checkOp(op({ kind: 'set-recall', patch: { content: '夹带' }, expect: { content: '旧正文' } }, r), input(r))).toMatchObject({ kind: 'skip', reason: 'unsupported' })
    expect(checkOp(op({ kind: 'link' }, r), input(r))).toMatchObject({ kind: 'skip', reason: 'unsupported' })
  })

  it('清掉一个字段用 null；读到时没有的预期也写 null', () => {
    const r = base({ factTime: '2026-01' })
    expect(checkOp(edit(r, { factTime: null }, { factTime: '2026-01' }), input(r))).toEqual({ kind: 'write', fields: { factTime: undefined } })
    const bare = base()
    expect(checkOp(op({ kind: 'set-validity', patch: { validTo: T0 + 60_000 }, expect: { validTo: null } }, bare), input(bare))).toMatchObject({ kind: 'write' })
  })

  it('操作的形状：多余的补丁字段过不了 schema', () => {
    expect(changeOpSchema.safeParse({ id: 'o', kind: 'edit', memoryId: 'm', basis: [], patch: { status: 'deleted' } }).success).toBe(false)
    expect(changeOpSchema.safeParse({ id: 'o', kind: 'set-topic', memoryId: 'm', basis: [] }).success).toBe(true)
  })
})

describe('同一批的进度', () => {
  it('前一个操作改过的字段，后一个拿刚写下的值当预期，依据指纹拿写完后的比', () => {
    const read = base()
    const progress = newProgress()
    const first = edit(read, { content: '第二版' }, { content: '旧正文' })
    const written = applyChange(read, { kind: 'refine', fields: { content: '第二版' }, by: 'gui', op: 'op_1', at: T0 + 1 })
    advance(progress, first, written)
    // 第二个操作是按读到时的那一版起草的：预期值和依据都还是旧的
    const second = { ...edit(read, { content: '第三版' }, { content: '旧正文' }), id: 'o2' }
    expect(checkOp(second, input(written, { progress }))).toEqual({ kind: 'write', fields: { content: '第三版' } })
  })

  it('这一批没写过的字段仍按读到时的值比：期间别处改了它，照样跳过', () => {
    const read = base()
    const progress = newProgress()
    const written = applyChange(read, { kind: 'refine', fields: { content: '第二版' }, by: 'gui', op: 'op_1', at: T0 + 1 })
    advance(progress, edit(read, { content: '第二版' }, { content: '旧正文' }), written)
    const tagged = { ...written, tags: ['别处改的'] }
    expect(checkOp({ ...edit(read, { tags: ['y'] }, { tags: ['x'] }), id: 'o2' }, input(tagged, { progress }))).toMatchObject({ kind: 'skip', reason: 'field-changed' })
  })

  it('这一批写完之后别处又改了正文：后一个操作跳过', () => {
    const read = base()
    const progress = newProgress()
    const written = applyChange(read, { kind: 'refine', fields: { content: '第二版' }, by: 'gui', op: 'op_1', at: T0 + 1 })
    advance(progress, edit(read, { content: '第二版' }, { content: '旧正文' }), written)
    const later = { ...written, content: '别处的版本' }
    const recall = { ...op({ kind: 'set-recall', patch: { recall: 'never' }, expect: { recall: null } }, read), id: 'o2' }
    expect(checkOp(recall, input(later, { progress }))).toMatchObject({ kind: 'skip', reason: 'basis-changed' })
  })
})

describe('改写稿里的密钥', () => {
  const SECRET = 'password=Abc12345xyz'
  it('原记忆里已有的疑似值原样带着：放行；新带进来的：拦', () => {
    const r = base({ content: `连接串 ${SECRET}` })
    expect(hasForeignSecret({ content: `测试库连接串 ${SECRET}` }, [r])).toBe(false)
    expect(hasForeignSecret({ content: '连接串 password=Zzz98765qwe' }, [r])).toBe(true)
    expect(hasForeignSecret({ summary: '没有密钥' }, [r])).toBe(false)
  })

  it('后台写入才查；界面里用户亲手定的稿不查这一条', () => {
    const r = base()
    const o = edit(r, { content: `新带的 ${SECRET}` }, { content: '旧正文' })
    expect(checkOp(o, input(r, { isSecretChecked: true }))).toMatchObject({ kind: 'skip', reason: 'foreign-secret' })
    expect(checkOp(o, input(r))).toMatchObject({ kind: 'write' })
  })
})

describe('回执与撤销', () => {
  const before = base()
  const written = applyChange(before, { kind: 'refine', fields: { content: '新正文' }, by: 'gui', op: 'op_1', at: T0 + 1 })
  const receipt = receiptOf({ id: 'o1', op: 'op_1', kind: 'edit', fields: ['content'], snapshotId: 'snap_1' }, written)

  it('回执不存字段值', () => {
    expect(JSON.stringify(receipt)).not.toContain('新正文')
    expect(receipt).toMatchObject({ fields: ['content'], isContent: true, status: 'active', scopeKey: 'global' })
  })

  it('还是这次写下的样子：能撤，只把改的字段改回去，最近一次内容改动和修改时间一起还原', () => {
    expect(revertBlock(receipt, written, before)).toBeUndefined()
    expect(reverted(receipt, written, before)).toEqual(before)
  })

  it('期间别处改的注入档位、锁、关联留着', () => {
    const now = { ...written, recall: 'never', locked: true, related: ['mem_z'] }
    expect(revertBlock(receipt, now, before)).toBeUndefined()
    expect(reverted(receipt, now, before)).toEqual({ ...before, recall: 'never', locked: true, related: ['mem_z'] })
  })

  it('期间只刷新了确认时间：照常能撤，刷新后的确认时间留着', () => {
    const now = { ...written, lastConfirmedAt: T0 + 99 }
    expect(revertBlock(receipt, now, before)).toBeUndefined()
    expect(reverted(receipt, now, before).lastConfirmedAt).toBe(T0 + 99)
  })

  it('期间被软删、被补证过、内容又被别的操作改过、换了作用域、快照没了：都不撤', () => {
    expect(revertBlock(receipt, { ...written, status: 'deleted' }, before)).toBe('status')
    const corroborated = applyChange(written, { kind: 'corroborate', fields: {}, anchor: { sessionId: 's9', eventRange: [1, 2], sourceMode: 'user-explicit' }, by: 'main', op: 'op_2', at: T0 + 2 })
    expect(revertBlock(receipt, corroborated, before)).toBe('corroborated')
    expect(revertBlock(receipt, { ...written, content: '别处的' }, before)).toBe('field-changed')
    expect(revertBlock(receipt, { ...written, lastChange: { ...written.lastChange!, op: 'op_other' } }, before)).toBe('overwritten')
    expect(revertBlock(receipt, { ...written, scope: 'workspace', workspacePath: '/p' }, before)).toBe('moved')
    expect(revertBlock(receipt, written, undefined)).toBe('expired')
    expect(revertBlock(receipt, undefined, before)).toBe('gone')
  })

  it('后来改的有效期不挡内容的撤销', () => {
    const now = { ...written, validTo: T0 + 60_000 }
    expect(revertBlock(receipt, now, before)).toBeUndefined()
    expect(reverted(receipt, now, before).validTo).toBe(T0 + 60_000)
  })

  it('关联按增量撤：它加的还在就去掉，期间别人加的不挡它、也不受影响', () => {
    const linked = { ...before, related: ['mem_b'], premises: [{ id: 'mem_c', digest: 'd' }] }
    const r = receiptOf({ id: 'o2', op: 'op_2', kind: 'link', fields: [], links: { added: { related: ['mem_b'], premises: ['mem_c'] }, removed: { related: [], premises: [] } } }, linked)
    const now = { ...linked, related: ['mem_b', 'mem_other'] }
    expect(revertBlock(r, now, undefined)).toBeUndefined()
    const back = reverted(r, now, undefined)
    expect(back.related).toEqual(['mem_other'])
    expect(back.premises).toBeUndefined()
  })

  it('删除的撤销：还在最近删除里就放回在用', () => {
    const deleted = { ...before, status: 'deleted' as const, deletedAt: T0 + 3 }
    const r = receiptOf({ id: 'o3', op: 'op_3', kind: 'forget', fields: [] }, deleted)
    expect(revertBlock(r, deleted, undefined)).toBeUndefined()
    expect(reverted(r, deleted, undefined)).toMatchObject({ status: 'active' })
    expect(reverted(r, deleted, undefined).deletedAt).toBeUndefined()
    expect(revertBlock(r, { ...before, status: 'active' }, undefined)).toBe('status')
  })
})

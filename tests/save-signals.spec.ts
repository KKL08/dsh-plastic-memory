import { basename } from 'node:path'
import { UNKNOWN_SESSION_ID } from '../src/session-id.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import type { PipelineResult } from '../src/pipeline.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { candidate, record } from './helpers/record.ts'
import { describe, expect, it } from 'vitest'
import { charSimilarity, extractFacts, normalizeForDuplicate } from '../src/text.ts'
import { clipText, createSaveHints, factsDroppedText, lostFacts, refineRemoval, refineShrankText } from '../src/save-signals.ts'
import { maskSecretSurface } from '../src/secrets.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

describe('保存信号', () => {
  it('规范化去掉空白标点并保留大小写和符号', () => {
    expect(normalizeForDuplicate(' Ａ，b。\nＣ: =+$！')).toBe('AbC=+$')
  })
  it('字符相似度按码点计算且阈值剪枝保留达标结果', () => {
    expect(charSimilarity('', '')).toBe(1)
    expect(charSimilarity('', '字')).toBe(0)
    expect(charSimilarity('😀a', '😀b')).toBe(0.5)
    for (const [a, b] of [['abcdefghij', 'abcdefghik'], ['中文正文', '另一段话'], ['abc', 'abc'], ['x', 'abcdefghij']]) {
      const score = charSimilarity(a, b)
      expect(score).toBe(charSimilarity(b, a))
      expect(charSimilarity(a, b, 0.9)).toBe(score >= 0.9 ? score : 0)
    }
  })
  it('带状剪枝与完整编辑距离在不同长度和阈值下保持一致', () => {
    const samples = ['', 'a', '😀', 'ab', 'ba', 'a😀b', 'ab😀', 'abcd', 'abcdefghij', 'abcdefg😀ij']
    for (const a of samples) for (const b of samples) {
      const left = [...a]
      const right = [...b]
      const matrix = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0))
      for (let i = 0; i <= left.length; i++) matrix[i][0] = i
      for (let j = 0; j <= right.length; j++) matrix[0][j] = j
      for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) {
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + Number(left[i - 1] !== right[j - 1]))
      }
      const max = Math.max(left.length, right.length)
      const expected = max === 0 ? 1 : 1 - matrix[left.length][right.length] / max
      expect(charSimilarity(a, b)).toBe(expected)
      for (const threshold of [0, 0.5, 0.6, 0.9, 1]) expect(charSimilarity(a, b, threshold)).toBe(expected >= threshold ? expected : 0)
    }
  })
  it('事实按优先级归类并按首次出现排序', () => {
    const facts = extractFacts('https://example.com/a., ~/bin/run.sh .archive/ src/auth.ts 2026-11-05 18:00:30 2026/11/5 2026.11.05 2026年 2026年11月 2026年11月5号 11月5日；18:00 `部署脚本` 「生产环境」 『状态切换』 “工作目录” PostgreSQL node24 abc4x 0.2.1-rc.2 3,000 50% API')
    expect(facts).toEqual([
      ...['https://example.com/a', '~/bin/run.sh', '.archive/', 'src/auth.ts'].map(text => ({ kind: 'path', text })),
      ...['2026-11-05 18:00:30', '2026/11/5', '2026.11.05', '2026年', '2026年11月', '2026年11月5号', '11月5日', '18:00'].map(text => ({ kind: 'date', text })),
      ...['部署脚本', '生产环境', '状态切换', '工作目录', 'PostgreSQL', 'node24', 'abc4x'].map(text => ({ kind: 'name', text })),
      ...['0.2.1-rc.2', '3,000', '50%'].map(text => ({ kind: 'number', text })),
    ])
    expect(extractFacts('1. 内容\n 2、 内容\n3) 内容\n端口 8080 8080 `src/auth.ts`')).toEqual([{ kind: 'number', text: '8080' }, { kind: 'path', text: 'src/auth.ts' }])
  })
  it('消失的数字按完整事实比对而专名路径允许正文包含', () => {
    expect(lostFacts('端口 3000；Redis；src/auth.ts；2026-11-05', '端口 30001；Redis 新状态；路径 src/auth.ts；2026-11-06')).toEqual([{ kind: 'number', text: '3000' }, { kind: 'date', text: '2026-11-05' }])
    expect(lostFacts('Redis 使用 8080', '8080 用于 Redis')).toEqual([])
  })
  it('丢失清单按类别排列并限制项数和文字长度', () => {
    const result = factsDroppedText([{ kind: 'path', text: 'src/auth.ts' }, { kind: 'name', text: 'Redis' }, { kind: 'number', text: '3000' }, { kind: 'date', text: '2026-11-05' }])
    expect(result).toContain('日期 2026-11-05；数字 3000；专名 Redis；路径 src/auth.ts')
    const many = factsDroppedText(Array.from({ length: 23 }, (_, i) => ({ kind: 'name', text: `${i}${'x'.repeat(90)}` })))
    expect(many).toContain('等另 3 项')
    expect(many.match(/…/g)).toHaveLength(20)
    expect(clipText('abcd', 3)).toBe('abc…')
    expect(clipText('abc', 3)).toBe('abc')
  })
  it('截取按码点计数不把 emoji 截成半个', () => {
    expect(clipText('ab😀c', 3)).toBe('ab😀…')
    expect(clipText('😀😀😀', 3)).toBe('😀😀😀')
  })
  it('句首只有首字母大写的英文单词不算专名', () => {
    const names = (text: string) => extractFacts(text).filter(fact => fact.kind === 'name').map(fact => fact.text)
    expect(names('When the cache expires, reload from Redis. Use the backup! Note: done?\nCheck it')).toEqual(['Redis'])
    expect(names('PostgreSQL stores data. S3 holds files.')).toEqual(['PostgreSQL', 'S3'])
    expect(names('Redis 备份每天凌晨执行。Kafka的分区数不变。')).toEqual(['Redis', 'Kafka'])
    expect(lostFacts('When deploying, restart Redis.', 'Restart the service after deploying.')).toEqual([{ kind: 'name', text: 'Redis' }])
  })
  it('正文整段遮盖后抽取不泄露高危或疑似密钥片段', () => {
    const suspected = 'TESTONLYsecret123456789'
    const before = maskSecretSurface({ name: '', summary: '', tags: [], content: `删除 ${FAKE_SECRET.sk} 和 password=${suspected}，保留数字 8080。` }, { severity: 'suspected' }).content
    const result = factsDroppedText(lostFacts(before, ''))
    for (const secret of [FAKE_SECRET.sk, suspected]) for (let i = 0; i <= secret.length - 8; i++) expect(result).not.toContain(secret.slice(i, i + 8))
    expect(extractFacts('`含[已隐藏]的名称`')).toEqual([])
  })
  it('细化删句超过绝对和比例门槛才提示并附快照', () => {
    const before = `${'原文'.repeat(60)}。保留这一句话。`
    const removal = refineRemoval(before, '保留这一句话。')!
    expect(removal.removed).toBe(120)
    expect(refineShrankText(removal, 'snapshot-1')).toContain('快照 snapshot-1')
    expect(refineShrankText(removal, undefined)).not.toContain('memory_snapshot')
    expect(refineRemoval('短短一句话。保留这一句。', '保留这一句。')).toBeUndefined()
    expect(refineRemoval(before, before)).toBeUndefined()
  })
  it('提示记账按轮计新建次数并按记忆去重长度提示', () => {
    const hints = createSaveHints()
    expect([hints.noteCreate(1), hints.noteCreate(1), hints.noteCreate(1), hints.noteCreate(1)]).toEqual([1, 2, 3, 4])
    expect(hints.noteCreate(2)).toBe(1)
    expect(hints.claimLengthHint('a')).toBe(true)
    expect(hints.claimLengthHint('a')).toBe(false)
    expect(hints.claimLengthHint('b')).toBe(true)
  })
})

const SIGNAL_NOW = 1_700_000_000_000
const signalRegistry = buildTypeRegistry({ template: 'coding', customTypes: {} })

function signalDeps(table = new InMemoryTable('/signal-memory', () => SIGNAL_NOW)) {
  return {
    store: new MemoryStore(table, undefined, new InMemoryBatchKvTable()),
    registry: signalRegistry,
    workspacePath: '/proj',
    session: { id: 'signal-session', lastSeq: 40, turnStartSeq: 10 as number | undefined },
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    now: () => SIGNAL_NOW,
    hints: createSaveHints(),
  }
}

function warning(result: PipelineResult, code: string): string | undefined {
  if (result.kind !== 'saved' && result.kind !== 'updated') throw new Error(JSON.stringify(result))
  return result.warnings?.find(w => w.code === code)?.text
}

/** 在存储边界第一次定位完成后替换文件，模拟预读和写入之间另一会话落盘。 */
class ChangedAfterReadTable extends InMemoryTable {
  nextContent: string | undefined
  override async locate(...args: Parameters<InMemoryTable['locate']>) {
    const located = await super.locate(...args)
    if (located && this.nextContent !== undefined) {
      const content = this.nextContent
      this.nextContent = undefined
      this.seedFile({ dir: located.dir, fileName: basename(located.filePath), record: { ...located.record, content }, extras: located.extras })
    }
    return located
  }
}

describe('管线保存信号', () => {
  it('整条替换列出消失的日期数字专名路径并照常落盘', async () => {
    const deps = signalDeps()
    const initial = await runSavePipeline(candidate({ scope: 'workspace', content: '2026-11-05 部署，端口 3000，脚本 `deploy.sh`，路径 src/auth.ts。' }), deps)
    if (initial.kind !== 'saved') throw new Error(initial.kind)
    expect(warning(initial, 'facts-dropped')).toBeUndefined()
    const result = await runSavePipeline(candidate({ action: 'update', change: 'state-change', id: initial.record.id, content: '当前部署方案已撤销。' }), deps)
    expect(warning(result, 'facts-dropped')).toContain('日期 2026-11-05；数字 3000；专名 deploy.sh；路径 src/auth.ts')
    expect((await deps.store.get(initial.record.id))?.content).toBe('当前部署方案已撤销。')
  })

  it('精确修改仅列出旧端口而重排事实和补证不出丢失信号', async () => {
    const deps = signalDeps()
    const initial = await runSavePipeline(candidate({ content: 'Redis 使用端口 3000。' }), deps)
    if (initial.kind !== 'saved') throw new Error(initial.kind)
    const edited = await runSavePipeline({ action: 'update', change: 'correct', id: initial.record.id, sourceMode: 'user-explicit', edits: [{ oldString: '3000', newString: '8080' }] }, deps)
    expect(warning(edited, 'facts-dropped')).toContain('3000')
    expect(warning(edited, 'facts-dropped')).not.toContain('8080')
    const reordered = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: initial.record.id, content: '端口 8080 由 Redis 使用。' }), deps)
    expect(warning(reordered, 'facts-dropped')).toBeUndefined()
    const corroborated = await runSavePipeline({ action: 'update', change: 'corroborate', id: initial.record.id, sourceMode: 'user-explicit' }, deps)
    expect(warning(corroborated, 'facts-dropped')).toBeUndefined()
  })

  it('丢失信号以写入段读到的正文为准而不使用预读版本', async () => {
    const table = new ChangedAfterReadTable('/signal-memory', () => SIGNAL_NOW)
    const deps = signalDeps(table)
    const initial = await runSavePipeline(candidate({ content: '旧端口 3000。' }), deps)
    if (initial.kind !== 'saved') throw new Error(initial.kind)
    table.nextContent = '并发写入端口 8080。'
    const result = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: initial.record.id, content: '端口配置已取消。' }), deps)
    expect(warning(result, 'facts-dropped')).toContain('8080')
    expect(warning(result, 'facts-dropped')).not.toContain('3000')
    const snapshots = await deps.snapshots.list()
    expect(JSON.stringify(snapshots)).toContain('8080')
  })

  it('细化删除大段原句提示并给实际快照而纠错与少量删减不提示', async () => {
    for (const [change, removedLength, expected] of [['refine', 120, true], ['correct', 120, false], ['refine', 20, false]] as const) {
      const deps = signalDeps()
      const initial = await runSavePipeline(candidate({ content: `${'原'.repeat(removedLength)}。这句话保留。` }), deps)
      if (initial.kind !== 'saved') throw new Error(initial.kind)
      const result = await runSavePipeline(candidate({ action: 'update', change, id: initial.record.id, content: '这句话保留。' }), deps)
      const text = warning(result, 'refine-shrank')
      if (expected) {
        const [snapshot] = await deps.snapshots.list()
        expect(text).toContain(`快照 ${snapshot.id}`)
        expect(text).toContain('约 120 个字符')
      } else expect(text).toBeUndefined()
    }
  })

  it('整段遮盖后才生成管线丢失清单且长清单限制二十项', async () => {
    const deps = signalDeps()
    const suspected = 'TESTONLYsecret123456789'
    const stored = record({ scope: 'workspace', workspacePath: '/proj', content: `删除 ${FAKE_SECRET.sk} 和 password=${suspected}；${Array.from({ length: 23 }, (_, i) => `端口 ${3000 + i}`).join('；')}` })
    await deps.store.put(stored)
    const result = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: stored.id, content: '配置已清理。' }), deps)
    const text = warning(result, 'facts-dropped')!
    expect(text).toContain('等另 3 项')
    for (const secret of [FAKE_SECRET.sk, suspected]) for (let i = 0; i <= secret.length - 8; i++) expect(text).not.toContain(secret.slice(i, i + 8))
  })

  it('每轮仅第三次成功新建提示且拦下不计数', async () => {
    const deps = signalDeps()
    const save = (force = true) => runSavePipeline(candidate({ force }), deps)
    expect(warning(await save(), 'turn-third-save')).toBeUndefined()
    expect((await save(false)).kind).toBe('duplicate-suspected')
    expect(warning(await save(), 'turn-third-save')).toBeUndefined()
    expect(warning(await save(), 'turn-third-save')).toContain('已新建 3 条')
    expect(warning(await save(), 'turn-third-save')).toBeUndefined()
    deps.session.turnStartSeq = 20
    expect(warning(await save(), 'turn-third-save')).toBeUndefined()
    expect(warning(await save(), 'turn-third-save')).toBeUndefined()
    expect(warning(await save(), 'turn-third-save')).toBeDefined()
    deps.session.id = UNKNOWN_SESSION_ID
    deps.session.turnStartSeq = 30
    for (let i = 0; i < 4; i++) expect(warning(await save(), 'turn-third-save')).toBeUndefined()
    deps.session.id = 'signal-session'
    deps.session.turnStartSeq = undefined
    for (let i = 0; i < 4; i++) expect(warning(await save(), 'turn-third-save')).toBeUndefined()
  })

  it('长度提示超过两千字符才出现且同会话同记录仅一次', async () => {
    const deps = signalDeps()
    const short = await runSavePipeline(candidate({ content: '字'.repeat(2000) }), deps)
    if (short.kind !== 'saved') throw new Error(short.kind)
    expect(warning(short, 'content-long')).toBeUndefined()
    const first = await runSavePipeline(candidate({ action: 'update', change: 'refine', id: short.record.id, content: '字'.repeat(2001) }), deps)
    expect(warning(first, 'content-long')).toContain('2001 个字符')
    const second = await runSavePipeline(candidate({ action: 'update', change: 'refine', id: short.record.id, content: '字'.repeat(2002) }), deps)
    expect(warning(second, 'content-long')).toBeUndefined()
    const another = await runSavePipeline(candidate({ force: true, content: '字'.repeat(2001) }), deps)
    expect(warning(another, 'content-long')).toBeDefined()
    const withoutHints = await runSavePipeline(candidate({ force: true, content: '字'.repeat(2001) }), { ...deps, hints: undefined })
    expect(warning(withoutHints, 'content-long')).toBeUndefined()
    expect(warning(withoutHints, 'turn-third-save')).toBeUndefined()
  })
})

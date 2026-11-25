import { createCordisHostSession } from '../src/cordis-host-session.ts'
import { describe, expect, it, vi } from 'vitest'
import { executeSource, locateSource, renderSourceResult, renderSessionHead } from '../src/tools/source.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { UNKNOWN_SESSION_ID } from '../src/session-id.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import { createSourceTool } from '../src/tools/source-tool.ts'
import { MemoryStore } from '../src/store.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import { layerOf } from '../src/storage/history.ts'
import { record as baseRecord } from './helpers/record.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { sourceHost, sessionLog, event, user, assistant, SOURCE_TIME } from './helpers/source-host.ts'

const ctx = { workspacePath: '/proj' }
const anchor = (sessionId = 's', start = 0, end = 4): SourceAnchor => ({ sessionId, eventRange: [start, end], sourceMode: 'user-explicit', change: 'created', at: SOURCE_TIME + start })
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ id: 'mem_a', scope: 'workspace', workspacePath: '/proj', source: { sessionId: 's', eventRange: [0, 4], sourceMode: 'user-explicit' }, sourceTrail: [anchor()], createdAt: SOURCE_TIME, updatedAt: SOURCE_TIME, ...partial })
async function storeWith(r = record()) {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  await store.put(r)
  return store
}
const args = { memoryId: 'mem_a' }
function ok(result: Awaited<ReturnType<typeof executeSource>>) {
  if (result.kind !== 'ok' || result.via !== 'anchor') throw new Error(JSON.stringify(result))
  return result
}

describe('出处下钻', () => {
  it('窗口能读到宿主助手消息里的正文', async () => {
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '问题'), assistant(2, '助手正文')]) })
    const result = ok(await executeSource(args, ctx, { store: await storeWith(), host }))
    expect(result.lines).toContain('- [2] assistant: 助手正文')
    expect(host.readSessionLog).toHaveBeenCalledTimes(1)
  })
})

describe('出处清单与定位', () => {
  it('补证的三个锚排在历史版本之前且重复出处只列一次', async () => {
    const anchors = [anchor('s'), anchor('second'), anchor('third')]
    const store = await storeWith(record({ sourceTrail: anchors }))
    const found = await store.locate('mem_a', ctx)
    for (const [versionId, endedAt, sessionId] of [['old', 10, 'old'], ['recent', 20, 'recent']] as const) {
      await store.history.write(layerOf(found!), { versionId, endedAt, startedAt: 0, kind: 'state-change', extras: {}, writes: [], record: record({ source: undefined, sourceTrail: [anchor(sessionId), anchors[0]!] }) })
    }
    const host = sourceHost({ second: sessionLog([user(1, '第二处')]) })
    const result = ok(await executeSource({ ...args, anchor: 2 }, ctx, { store, host }))
    expect(result.anchors.map(a => a.sessionId)).toEqual(['s', 'second', 'third', 'recent', 'old'])
    expect(result.anchors.map(a => a.isFromHistory)).toEqual([false, false, false, true, true])
    expect(result.anchors[1]?.isSelected).toBe(true)
    expect(result.lines).toContain('- [1] user: 第二处')
    expect(renderSourceResult(result)).toContain('（历史版本）')
    expect(renderSourceResult(result)).toContain('← 这次读的')
  })

  const invalid: Array<[Parameters<typeof executeSource>[0], string]> = [
    [{ ...args, mode: 'find' }, '按关键词找要给 query（1–200 个字符）'],
    [{ ...args, mode: 'find', query: '  ' }, '按关键词找要给 query（1–200 个字符）'],
    [{ ...args, mode: 'find', query: 'x'.repeat(201) }, '按关键词找要给 query（1–200 个字符）'],
    [{ ...args, query: 'x' }, 'query 只在 mode=find 时用'],
    [{ ...args, mode: 'page' }, '接着翻要给上一次返回末尾的 cursor'],
    [{ ...args, mode: 'page', cursor: 'after:-1' }, 'cursor 取上一次返回末尾给出的值'],
    [{ ...args, cursor: 'after:1' }, 'cursor 只在 mode=page 或 find 时用'],
    [{ ...args, mode: 'page', cursor: 'after:1', window: 2 }, 'window 只在围绕出处开窗时用'],
    [{ ...args, hop: 'parent', mode: 'page', cursor: 'after:1' }, 'hop 单独用，不和开窗、翻页、关键词一起'],
    [{ ...args, hop: 'child', window: 2 }, 'hop 单独用，不和开窗、翻页、关键词一起'],
    [{ ...args, mode: 'find', query: 'x', cursor: 'before:1' }, '按关键词找只能往后接着找（after:）'],
    [{ ...args, anchor: 0 }, '这条记忆只有 1 个出处，anchor 取 1–1'],
    [{ ...args, anchor: 1.5 }, '这条记忆只有 1 个出处，anchor 取 1–1'],
    [{ ...args, anchor: 2 }, '这条记忆只有 1 个出处，anchor 取 1–1'],
  ]
  it.each(invalid)('非法参数 %j 返回对应原因且不读取会话', async (request, reason) => {
    const host = sourceHost()
    expect(await executeSource(request, ctx, { store: await storeWith(), host })).toMatchObject({ kind: 'rejected', code: 'invalid-args', reason })
    expect(host.readSessionLog).not.toHaveBeenCalled()
  })

  it('不存在和跨项目记录先于锚范围检查返回', async () => {
    const host = sourceHost()
    const store = await storeWith(record({ workspacePath: '/other' }))
    expect(await executeSource({ ...args, memoryId: 'absent', anchor: 99 }, ctx, { store, host })).toMatchObject({ kind: 'not-found' })
    expect(await executeSource({ ...args, anchor: 99 }, ctx, { store, host })).toMatchObject({ kind: 'forbidden' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
  })

  it('无当前或历史出处的记录返回无出处而不读取会话', async () => {
    const host = sourceHost()
    expect(await executeSource(args, ctx, { store: await storeWith(record({ source: undefined, sourceTrail: undefined })), host })).toMatchObject({ kind: 'no-source' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
  })
})

describe('开窗与会话边界', () => {
  const events = Array.from({ length: 100 }, (_, seq) => seq === 10 ? event(seq, 'turn/start') : user(seq, `内容${seq}`))
  it('主会话从本轮起点往后开窗并把宽度限制在二十四', async () => {
    const store = await storeWith(record({ source: undefined, sourceTrail: [anchor('s', 10, 90)] }))
    const host = sourceHost({ s: sessionLog(events) })
    const result = ok(await executeSource(args, ctx, { store, host }))
    expect(result.range).toEqual([8, 34])
    expect(result.lines).toContain('- [11] user: 内容11')
    expect(result.lines).not.toContain('- [90] user: 内容90')
  })
  it('子会话从保存点往前开窗且不越过本轮起点', async () => {
    const store = await storeWith(record({ source: undefined, sourceTrail: [anchor('s', 10, 90)], delegation: { sessionId: 's', parentSessionId: 'p', depth: 1 } }))
    const host = sourceHost({ s: sessionLog(events) })
    expect(ok(await executeSource(args, ctx, { store, host })).range).toEqual([66, 91])
    const short = await storeWith(record({ source: undefined, sourceTrail: [anchor('s', 10, 12)], delegation: { sessionId: 's', parentSessionId: 'p', depth: 1 } }))
    expect(ok(await executeSource({ ...args, window: 99 }, ctx, { store: short, host })).range).toEqual([11, 13])
  })
  it('注入的上下文不显示且窗口向后补足一条', async () => {
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '注入', 'runtime-context'), user(2, '用户'), assistant(3, '补上')]) })
    const result = ok(await executeSource({ ...args, window: 2 }, ctx, { store: await storeWith(), host }))
    expect(result.lines).toEqual(['- [2] user: 用户', '- [3] assistant: 补上'])
    expect(result.counts).toEqual({ total: 4, given: 2, skipped: 2 })
  })
  it('工具调用和结果缺省略过且只有全部模式显示', async () => {
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '用户'), event(2, 'tool/call', { name: 'read', arguments: '{"path":"a"}', callId: 'c' }), event(3, 'tool/result', { message: { content: [{ type: 'text', text: '结果' }], toolCallId: 'c' } }), assistant(4, '结论')]) })
    const store = await storeWith()
    const plain = ok(await executeSource(args, ctx, { store, host }))
    expect(plain.counts).toEqual({ total: 5, given: 2, skipped: 3 })
    const all = ok(await executeSource({ ...args, include: 'all' }, ctx, { store, host }))
    expect(all.lines).toContain('- [2] tool-call: read {"path":"a"}')
    expect(all.lines).toContain('- [3] tool: 结果')
    expect(all.counts).toEqual({ total: 5, given: 4, skipped: 1 })
  })
  it.each([{ }, { mode: 'page' as const, cursor: 'after:0' }, { mode: 'find' as const, query: '内容' }])('继承前缀在请求 %j 中始终不显示也不计数', async request => {
    const host = sourceHost({ s: sessionLog(events, 10) })
    const result = ok(await executeSource({ ...args, ...request }, ctx, { store: await storeWith(record({ source: undefined, sourceTrail: [anchor('s', 10, 14)] })), host }))
    expect(result.lines.every(line => Number(line.match(/\[(\d+)\]/)?.[1]) >= 10)).toBe(true)
  })
  it('边界不明的会话仍能按锚开窗但拒绝翻页查找和追溯', async () => {
    const log = sessionLog(events)
    log.inheritedEventCount = undefined
    const host = sourceHost({ s: log, c: log })
    const store = await storeWith(record({ delegation: { sessionId: 'c', parentSessionId: 's', depth: 1 } }))
    expect((await executeSource(args, ctx, { store, host })).kind).toBe('ok')
    for (const request of [{ mode: 'page' as const, cursor: 'after:0' }, { mode: 'find' as const, query: '内容' }, { hop: 'child' as const }]) {
      expect(await executeSource({ ...args, ...request }, ctx, { store, host })).toMatchObject({ kind: 'unavailable', reason: '这个会话分不清哪些内容是它自己的，只能围绕出处读' })
    }
  })
  it('锚序号时间不符时移到时间对应的轮且对齐时不加说明', async () => {
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '旧轮'), event(10, 'turn/start'), user(11, '新轮')]) })
    const store = await storeWith(record({ source: undefined, sourceTrail: [{ ...anchor('s', 0, 2), at: SOURCE_TIME + 11 }] }))
    const result = ok(await executeSource(args, ctx, { store, host }))
    expect(result.lines).toContain('- [11] user: 新轮')
    expect(result.lines).not.toContain('- [1] user: 旧轮')
    expect(result.notes.join('')).toContain('已按时间重新定位')
    const aligned = ok(await executeSource(args, ctx, { store: await storeWith(), host }))
    expect(aligned.notes).toEqual([])
  })
  it('原始会话读不到时返回不可用', async () => {
    expect(await executeSource(args, ctx, { store: await storeWith(), host: sourceHost() })).toMatchObject({ kind: 'unavailable', reason: '原始会话读不到（可能已删除）' })
  })
})

describe('连续翻页与关键词', () => {
  const events = Array.from({ length: 60 }, (_, seq) => user(seq, `Needle ${seq}`))
  it('向后连续翻页不重不漏且到头不再给游标', async () => {
    const deps = { store: await storeWith(), host: sourceHost({ s: sessionLog(events) }) }
    const first = ok(await executeSource({ ...args, mode: 'page', cursor: 'after:0' }, ctx, deps))
    const second = ok(await executeSource({ ...args, mode: 'page', cursor: first.cursors.after }, ctx, deps))
    const last = ok(await executeSource({ ...args, mode: 'page', cursor: second.cursors.after }, ctx, deps))
    expect([...first.lines, ...second.lines, ...last.lines]).toEqual(events.slice(1).map(e => `- [${e.seq}] user: Needle ${e.seq}`))
    expect(last.cursors.after).toBeUndefined()
    expect(renderSourceResult(first)).toContain('mode=page')
  })
  it('向前翻页保持升序并在会话开头停止', async () => {
    const deps = { store: await storeWith(), host: sourceHost({ s: sessionLog(events) }) }
    const first = ok(await executeSource({ ...args, mode: 'page', cursor: 'before:30' }, ctx, deps))
    expect(first.range).toEqual([6, 29])
    const last = ok(await executeSource({ ...args, mode: 'page', cursor: first.cursors.before }, ctx, deps))
    expect(last.lines).toEqual(events.slice(0, 6).map(e => `- [${e.seq}] user: Needle ${e.seq}`))
    expect(last.cursors.before).toBeUndefined()
  })
  it('关键词忽略大小写且每次八处命中可以接着找完', async () => {
    const deps = { store: await storeWith(), host: sourceHost({ s: sessionLog(events.slice(0, 19)) }) }
    const first = ok(await executeSource({ ...args, mode: 'find', query: ' nEEdle ' }, ctx, deps))
    expect(first.lines).toHaveLength(8)
    expect(first.find).toMatchObject({ query: 'nEEdle', remaining: 11 })
    const second = ok(await executeSource({ ...args, mode: 'find', query: 'needle', cursor: first.cursors.after }, ctx, deps))
    const last = ok(await executeSource({ ...args, mode: 'find', query: 'needle', cursor: second.cursors.after }, ctx, deps))
    expect([...first.lines, ...second.lines, ...last.lines]).toHaveLength(19)
    expect(new Set([...first.lines, ...second.lines, ...last.lines]).size).toBe(19)
    expect(last.cursors.after).toBeUndefined()
    expect(renderSourceResult(first)).toContain('还有 11 处')
    expect(renderSourceResult(first)).toContain('看某一处的前后文')
  })
  it('关键词无命中时渲染明确文字且长命中节选保留中间关键词', async () => {
    const deps = { store: await storeWith(), host: sourceHost({ s: sessionLog([user(1, '甲'.repeat(500) + 'needle' + '乙'.repeat(500))]) }) }
    const miss = ok(await executeSource({ ...args, mode: 'find', query: 'missing' }, ctx, deps))
    expect(renderSourceResult(miss)).toContain('（这个会话里没有找到「missing」）')
    const hit = ok(await executeSource({ ...args, mode: 'find', query: 'needle' }, ctx, deps))
    expect(hit.lines[0]).toContain('needle')
    expect(hit.lines[0]).toContain('…')
    expect(hit.lines[0]!.length).toBeLessThanOrEqual(420)
  })
})

describe('父子会话追溯与放行', () => {
  const delegation = { sessionId: 'c', parentSessionId: 'p', depth: 1 }
  it('子会话只能读选中的本会话锚且不能追溯父子会话', async () => {
    const store = await storeWith(record({ sourceTrail: [anchor('s'), anchor('c')], delegation }))
    const child = { ...ctx, session: { id: 'c' }, delegation: {} }
    const host = sourceHost({ c: sessionLog([user(1, '自己')]) })
    expect(await executeSource(args, child, { store, host })).toMatchObject({ kind: 'rejected', code: 'subagent-restricted', reason: '这条记忆的出处在别的会话，带回主会话查' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
    expect(await executeSource({ ...args, anchor: 2, hop: 'parent' }, child, { store, host })).toMatchObject({ kind: 'rejected', code: 'subagent-restricted', reason: '父子会话之间的追溯带回主会话做' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
    expect((await executeSource({ ...args, anchor: 2 }, child, { store, host })).kind).toBe('ok')
  })
  it('无委派或出处已在子会话时给出对应参数错误', async () => {
    const host = sourceHost()
    expect(await executeSource({ ...args, hop: 'child' }, ctx, { store: await storeWith(), host })).toMatchObject({ code: 'invalid-args', reason: '这条记忆不是子 agent 写的，没有父子会话可追溯' })
    expect(await executeSource({ ...args, hop: 'child' }, ctx, { store: await storeWith(record({ source: undefined, sourceTrail: [anchor('c')], delegation })), host })).toMatchObject({ code: 'invalid-args', reason: '这个出处就在子会话里，直接读即可' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
  })
  it('向子会话追溯读取它自己的最后二十四条', async () => {
    const host = sourceHost({ c: sessionLog(Array.from({ length: 40 }, (_, seq) => user(seq, `子${seq}`)), 5) })
    const result = ok(await executeSource({ ...args, hop: 'child' }, ctx, { store: await storeWith(record({ delegation })), host }))
    expect(result.sessionId).toBe('c')
    expect(result.range).toEqual([16, 39])
    expect(result.lines).toHaveLength(24)
    expect(host.readSessionLog.mock.calls).toEqual([['c']])
  })
  it.each([true, false])('向父会话追溯在子日志存在为 %s 时按对应时间定位', async hasChild => {
    const p = sessionLog([event(0, 'turn/start'), user(1, '早期'), event(10, 'turn/start'), user(11, '委派前后')])
    const host = sourceHost({ p, ...(hasChild ? { c: sessionLog([{ ...event(30, 'turn/start'), time: SOURCE_TIME + 10 }]) } : {}) })
    const result = ok(await executeSource({ ...args, hop: 'parent' }, ctx, { store: await storeWith(record({ delegation, createdAt: SOURCE_TIME + 10 })), host }))
    expect(result.sessionId).toBe('p')
    expect(result.lines).toEqual(['- [11] user: 委派前后'])
    expect(host.readSessionLog.mock.calls).toEqual([['c'], ['p']])
  })
})

describe('返回开头和模型入参', () => {
  it('会话行有标题时显示标题时间和三项计数', () => {
    const text = renderSessionHead({ sessionId: 's', title: '主题', startedAt: SOURCE_TIME }, { total: 12, given: 7, skipped: 5 })
    expect(text).toContain('会话「主题」（s，')
    expect(text).toContain('这一段共 12 个事件，给了 7 条，略过 5 个。')
  })
  it('会话没有标题或时间时省掉缺失部分', () => {
    const counts = { total: 0, given: 0, skipped: 0 }
    expect(renderSessionHead({ sessionId: 's' }, counts)).toBe('会话 s：这一段共 0 个事件，给了 0 条，略过 0 个。')
    expect(renderSessionHead({ sessionId: 's', startedAt: SOURCE_TIME }, counts)).toContain('会话 s（')
  })
  it('完整输出先给记忆与会话标题再给事件正文', async () => {
    const result = ok(await executeSource(args, ctx, { store: await storeWith(), host: sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '正文')]) }, { s: '标题' }) }))
    expect(result.session).toEqual({ title: '标题', startedAt: SOURCE_TIME })
    const text = renderSourceResult(result)
    expect(text.indexOf('记忆 mem_a')).toBeLessThan(text.indexOf('会话「标题」'))
    expect(text.indexOf('会话「标题」')).toBeLessThan(text.indexOf('- [1]'))
  })
  it('入参都是普通类型字段，没有必填项（记忆标识和消息引用二选一由执行器查）', async () => {
    const tool = createSourceTool({ store: await storeWith(), host: { ...sourceHost(), contextOf: async () => ctx } })
    const schema = tool.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(schema.required ?? []).toEqual([])
    for (const parameter of Object.values(schema.properties)) {
      expect(parameter).toHaveProperty('type')
      expect(parameter).not.toHaveProperty('union')
      expect(parameter).not.toHaveProperty('anyOf')
      expect(parameter).not.toHaveProperty('oneOf')
    }
  })
})


describe('既有出处行为回归', () => {
  it('记忆名称遮盖密钥而会话原文保持原样', async () => {
    const host = sourceHost({ s: sessionLog([user(1, FAKE_SECRET.sk)]) })
    const result = ok(await executeSource(args, ctx, { store: await storeWith(record({ name: `部署 ${FAKE_SECRET.sk}` })), host }))
    expect(result.name).toBe(`部署 ${SECRET_MASK}`)
    expect(result.lines[0]).toContain(FAKE_SECRET.sk)
  })
  it('子会话读取无出处记忆仍先返回子会话限制', async () => {
    const host = sourceHost()
    const result = await executeSource(args, { ...ctx, session: { id: 'c' }, delegation: {} }, { store: await storeWith(record({ source: undefined, sourceTrail: undefined })), host })
    expect(result).toMatchObject({ kind: 'rejected', code: 'subagent-restricted' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
  })
  it('主会话改写子会话记忆后按选中锚从轮起点往后读', async () => {
    const store = await storeWith(record({ source: undefined, sourceTrail: [anchor('s', 10, 90)], delegation: { sessionId: 'c', parentSessionId: 's', depth: 1 } }))
    const host = sourceHost({ s: sessionLog(Array.from({ length: 100 }, (_, seq) => user(seq, `正文${seq}`))) })
    const result = ok(await executeSource(args, ctx, { store, host }))
    expect(result.range).toEqual([8, 34])
  })
  it('全局记忆在不同项目中仍可读取且已删除记忆不可读取', async () => {
    const host = sourceHost({ s: sessionLog([user(1, '全局')]) })
    expect((await executeSource(args, ctx, { store: await storeWith(record({ scope: 'global', workspacePath: undefined })), host })).kind).toBe('ok')
    expect((await executeSource(args, ctx, { store: await storeWith(record({ status: 'deleted' })), host })).kind).toBe('not-found')
  })
})


describe('宿主会话标题适配', () => {
  it('标题读取使用会话标识并返回宿主标题', async () => {
    const readTitle = vi.fn(async () => ({ title: '会话主题' }))
    const host = createCordisHostSession({ lookup: name => name === 'sessionQuery' ? { readTitle } : undefined, resolveCwd: async cwd => cwd, logger: { warn: vi.fn() } })
    expect(await host.sessionTitleOf('s')).toBe('会话主题')
    expect(readTitle).toHaveBeenCalledWith('s')
  })
  it.each([undefined, {}, { readTitle: async () => undefined }, { readTitle: async () => { throw new Error('读不到') } }])('标题服务 %j 不可读时静默返回空值', async service => {
    const warn = vi.fn()
    const host = createCordisHostSession({ lookup: () => service, resolveCwd: async cwd => cwd, logger: { warn } })
    expect(await host.sessionTitleOf('s')).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})


describe('定位与读取边界', () => {
  it('定位函数返回选中的锚范围且不读取日志', async () => {
    const host = sourceHost()
    const target = await locateSource({ ...args, anchor: 2 }, ctx, { store: await storeWith(record({ sourceTrail: [anchor(), anchor('other', 10, 20)] })), host })
    expect(target).toMatchObject({ via: 'anchor', anchorIndex: 1, sessionId: 'other', range: [10, 20], anchorTime: SOURCE_TIME + 10 })
    expect(host.readSessionLog).not.toHaveBeenCalled()
  })
  it('当前版本无出处时仍能使用历史版本的出处', async () => {
    const store = await storeWith(record({ source: undefined, sourceTrail: undefined }))
    const found = await store.locate('mem_a', ctx)
    await store.history.write(layerOf(found!), { versionId: 'old', endedAt: 20, startedAt: 10, kind: 'state-change', extras: {}, writes: [], record: record() })
    const host = sourceHost({ s: sessionLog([user(1, '历史原文')]) })
    const result = ok(await executeSource(args, ctx, { store, host }))
    expect(result.anchors).toHaveLength(1)
    expect(result.anchors[0]?.isFromHistory).toBe(true)
    expect(result.lines).toEqual(['- [1] user: 历史原文'])
  })
  it('没有父会话标识时返回不可用', async () => {
    const store = await storeWith(record({ delegation: { sessionId: 'c', depth: 1, parentSessionId: '' } }))
    expect(await executeSource({ ...args, hop: 'parent' }, ctx, { store, host: sourceHost() })).toMatchObject({ kind: 'unavailable', reason: '记录里没有父会话' })
  })
  it('关键词查找只在全部模式中匹配工具调用和结果', async () => {
    const host = sourceHost({ s: sessionLog([event(0, 'tool/call', { name: 'read', arguments: '{"path":"needle"}', callId: 'c' }), event(1, 'tool/result', { message: { content: [{ type: 'text', text: 'needle result' }], toolCallId: 'c' } })]) })
    const store = await storeWith()
    expect(ok(await executeSource({ ...args, mode: 'find', query: 'needle' }, ctx, { store, host })).lines).toEqual([])
    expect(ok(await executeSource({ ...args, mode: 'find', query: 'needle', include: 'all' }, ctx, { store, host })).lines).toHaveLength(2)
  })
  it('子会话连续注入上下文时向前补足但不超过本轮起点', async () => {
    const store = await storeWith(record({ source: undefined, sourceTrail: [anchor('c', 0, 5)], delegation: { sessionId: 'c', parentSessionId: 'p', depth: 1 } }))
    const host = sourceHost({ c: sessionLog([event(0, 'turn/start'), user(1, '补进来'), user(2, '注入一', 'runtime-context'), user(3, '注入二', 'runtime-context'), assistant(4, '过程'), assistant(5, '保存'), assistant(6, '完成')]) })
    const result = ok(await executeSource({ ...args, window: 2 }, ctx, { store, host }))
    expect(result.range).toEqual([1, 6])
    expect(result.lines).toContain('- [1] user: 补进来')
    expect(result.counts).toEqual({ total: 6, given: 4, skipped: 2 })
  })
  it('窗口上限二十四且每条正文截断到四百字符后加省略号', async () => {
    const host = sourceHost({ s: sessionLog(Array.from({ length: 100 }, (_, seq) => user(seq, '长'.repeat(500)))) })
    const store = await storeWith()
    const result = ok(await executeSource({ ...args, window: 99 }, ctx, { store, host }))
    expect(result.range).toEqual([0, 24])
    expect(result.lines[0]).toBe(`- [0] user: ${'长'.repeat(400)}…`)
  })
})

it('翻到会话首尾以外时空页计数为零且没有越界方向游标', async () => {
  const deps = { store: await storeWith(), host: sourceHost({ s: sessionLog([user(1, '正文')]) }) }
  const before = ok(await executeSource({ ...args, mode: 'page', cursor: 'before:0' }, ctx, deps))
  const after = ok(await executeSource({ ...args, mode: 'page', cursor: 'after:100' }, ctx, deps))
  for (const result of [before, after]) {
    expect(result.lines).toEqual([])
    expect(result.counts).toEqual({ total: 0, given: 0, skipped: 0 })
  }
  expect(before.cursors.before).toBeUndefined()
  expect(after.cursors.after).toBeUndefined()
})

it.each(['parent', 'child'] as const)('追溯到%s会话后不给会跳回原锚会话的游标或翻页提示', async hop => {
  const store = await storeWith(record({ delegation: { sessionId: 'c', parentSessionId: 'p', depth: 1 } }))
  const events = Array.from({ length: 60 }, (_, seq) => user(seq, `原文${seq}`))
  const host = sourceHost({ p: sessionLog(events), c: sessionLog(events) })
  const result = ok(await executeSource({ ...args, hop }, ctx, { store, host }))
  expect(result.lines).toHaveLength(24)
  expect(result.cursors).toEqual({})
  expect(renderSourceResult(result)).not.toContain('cursor=')
  expect(renderSourceResult(result)).not.toContain('mode=page')
})

describe('异常日志与出处时间', () => {
  it('旧锚的更新时间远晚于出处时仍读原轮且不加重定位说明', async () => {
    const store = await storeWith(record({ sourceTrail: undefined, updatedAt: SOURCE_TIME + 100 }))
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '原轮'), event(10, 'turn/start'), user(11, '后轮')]) })
    const result = ok(await executeSource(args, ctx, { store, host }))
    expect(result.lines).toEqual(['- [1] user: 原轮'])
    expect(result.notes).toEqual([])
  })

  it.each([5, 10])('锚时间落在终点与下一事件之间或边界上时保留原轮且不加说明', async offset => {
    const store = await storeWith(record({ sourceTrail: [{ ...anchor(), at: SOURCE_TIME + offset }] }))
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '原轮'), event(2, 'turn/start'), user(3, '保存前'), event(10, 'turn/start'), user(11, '后轮')]) })
    const result = ok(await executeSource(args, ctx, { store, host }))
    expect(result.lines).toEqual(['- [1] user: 原轮', '- [3] user: 保存前'])
    expect(result.notes).toEqual([])
  })

  it.each([true, false])('锚起点缺失或时间晚于锚时读时间对应的轮并加说明', async missing => {
    const store = await storeWith(record({ source: undefined, sourceTrail: [{ ...anchor('s', 10, 12), at: SOURCE_TIME }] }))
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), user(1, '原轮'), ...(missing ? [] : [event(10, 'turn/start')]), user(11, '后轮')]) })
    const result = ok(await executeSource(args, ctx, { store, host }))
    expect(result.lines).toEqual(['- [1] user: 原轮'])
    expect(result.notes.join('')).toContain('已按时间重新定位')
  })

  it('分叉会话略过继承前缀和无时间事件后给自己的开始时间', async () => {
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), { ...event(10, 'turn/start'), time: undefined }, user(11, '自己')], 10) })
    const result = ok(await executeSource(args, ctx, { store: await storeWith(), host }))
    expect(result.session.startedAt).toBe(SOURCE_TIME + 11)
  })

  it('会话没有自己的带时间事件时不提供开始时间', async () => {
    const host = sourceHost({ s: sessionLog([event(0, 'turn/start'), { ...user(10, '自己'), time: undefined }], 10) })
    expect(ok(await executeSource(args, ctx, { store: await storeWith(), host })).session.startedAt).toBeUndefined()
  })

  it.each(['page', 'find'] as const)('日志混有缺序号事件时跳过它且仍能翻页查找', async mode => {
    const host = sourceHost({ s: sessionLog([{ ...user(0, '无序号'), seq: undefined }, user(1, '正文')]) })
    const result = ok(await executeSource({ ...args, mode, ...(mode === 'page' ? { cursor: 'after:0' } : { query: '正文' }) }, ctx, { store: await storeWith(), host }))
    expect(result.lines).toEqual(['- [1] user: 正文'])
    expect(result.counts).toEqual({ total: 1, given: 1, skipped: 0 })
  })

  it('归属不明的会话开窗后不给游标和翻页提示', async () => {
    const log = sessionLog(Array.from({ length: 10 }, (_, seq) => user(seq, '正文')))
    log.inheritedEventCount = undefined
    const result = ok(await executeSource(args, ctx, { store: await storeWith(), host: sourceHost({ s: log }) }))
    expect(result.cursors).toEqual({})
    expect(renderSourceResult(result)).not.toContain('mode=page')
    expect(result.session.startedAt).toBeUndefined()
  })

  it.each(['parent', 'child'] as const)('原锚会话归属不明时追溯仍只读取实际需要的会话', async hop => {
    const log = sessionLog([user(0, '原锚')])
    log.inheritedEventCount = undefined
    const host = sourceHost({ s: log, c: sessionLog([user(1, '子正文')]), p: sessionLog([user(1, '父正文')]) })
    const store = await storeWith(record({ delegation: { sessionId: 'c', parentSessionId: 'p', depth: 1 } }))
    const result = ok(await executeSource({ ...args, hop }, ctx, { store, host }))
    expect(result.lines).toEqual([hop === 'child' ? '- [1] user: 子正文' : '- [1] user: 父正文'])
    expect(host.readSessionLog.mock.calls).toEqual(hop === 'child' ? [['c']] : [['c'], ['p']])
  })

  it('父会话是占位标识时返回没有父会话且不读日志', async () => {
    const host = sourceHost()
    const store = await storeWith(record({ delegation: { sessionId: 'c', parentSessionId: UNKNOWN_SESSION_ID, depth: 1 } }))
    expect(await executeSource({ ...args, hop: 'parent' }, ctx, { store, host })).toMatchObject({ kind: 'unavailable', reason: '记录里没有父会话' })
    expect(host.readSessionLog).not.toHaveBeenCalled()
  })

  it.each([true, false])('追溯父会话时用子会话首个有效时间且缺失时用记忆创建时间', async hasTime => {
    const host = sourceHost({
      c: sessionLog([event(0, 'turn/start'), { ...event(10, 'turn/start'), time: undefined }, { ...user(11, '子正文'), time: hasTime ? SOURCE_TIME + 10 : undefined }], 10),
      p: sessionLog([event(0, 'turn/start'), user(1, '早期'), event(10, 'turn/start'), user(11, '委派轮')]),
    })
    const store = await storeWith(record({ createdAt: SOURCE_TIME + 10, delegation: { sessionId: 'c', parentSessionId: 'p', depth: 1 } }))
    const result = ok(await executeSource({ ...args, hop: 'parent' }, ctx, { store, host }))
    expect(result.lines).toEqual(['- [11] user: 委派轮'])
    expect(host.readSessionLog.mock.calls).toEqual([['c'], ['p']])
  })

  it.each([true, false])('子会话无可读正文时范围来自实际扫描且空日志返回零范围', async hasEvents => {
    const host = sourceHost({ c: sessionLog(hasEvents ? [event(30, 'turn/start'), event(40, 'turn/end')] : []) })
    const store = await storeWith(record({ delegation: { sessionId: 'c', parentSessionId: 'p', depth: 1 } }))
    const result = ok(await executeSource({ ...args, hop: 'child' }, ctx, { store, host }))
    expect(result.lines).toEqual([])
    expect(result.range).toEqual(hasEvents ? [30, 40] : [0, 0])
  })

  it.each([300, 400])('关键词命中的全文不超过上限时保留整条消息', async length => {
    const text = '甲'.repeat(length - 6) + 'needle'
    const host = sourceHost({ s: sessionLog([user(0, text)]) })
    const result = ok(await executeSource({ ...args, mode: 'find', query: 'needle' }, ctx, { store: await storeWith(), host }))
    expect(result.lines).toEqual(['- [0] user: ' + text])
  })

  it('关键词命中零号事件时前后文提示只给有效的向前游标', async () => {
    const host = sourceHost({ s: sessionLog([user(0, 'needle')]) })
    const result = ok(await executeSource({ ...args, mode: 'find', query: 'needle' }, ctx, { store: await storeWith(), host }))
    const tail = renderSourceResult(result).split('\n').at(-1)
    expect(tail).toBe('看某一处的前后文：mode=page，cursor=before:1')
  })

  it('读取当前记忆和历史锚只定位一次存储位置', async () => {
    const table = new InMemoryTable()
    const store = new MemoryStore(table, undefined, new InMemoryBatchKvTable())
    await store.put(record())
    const locate = vi.spyOn(table, 'locate')
    const target = await locateSource(args, ctx, { store, host: sourceHost() })
    expect(target).toMatchObject({ via: 'anchor', sessionId: 's' })
    expect(locate).toHaveBeenCalledTimes(1)
  })
})

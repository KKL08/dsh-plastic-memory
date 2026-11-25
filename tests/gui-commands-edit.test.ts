import { describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { computeDigest, encodeRecord, splitFrontmatter } from '../src/storage/frontmatter.ts'
import { editFingerprint } from '../src/governance/snapshots.ts'
import { GLOBAL_DIR } from '../src/storage/paths.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { ViewWriter } from '../src/gui/view-writer.ts'
import { GUI_CHECKUP_VIEW_FILE, GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, deletedViewSchema, healthViewSchema, libraryViewSchema, pendingViewSchema, type MemoryCommand } from '../src/gui/contract.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { scopeAt } from '../src/scope.ts'
import { candidate, record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { NOW, SESSION_WS, OTHER_WS, registry, root, env, ok, err, seedPair, allEntries, ledgerItems } from './helpers/gui-command-env.ts'
import { memoryText } from './helpers/memory-text.ts'
import { indexText, indexedIds } from './helpers/topic-index.ts'


describe('refresh-views', () => {
  it('写出四个全局视图，并清掉超出保留窗口的删一方裁决', async () => {
    const e = env({ now: 1000 })
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect(await e.decisions.listSettled()).toHaveLength(1)

    e.clock.now = 1000 + RETENTION_MS + 1
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(await e.decisions.listSettled()).toEqual([])
    for (const name of Object.keys(GUI_VIEW_FILES) as Array<keyof typeof GUI_VIEW_FILES>) {
      expect((await e.readView(name)) as { version: number }).toMatchObject({ version: GUI_VIEW_VERSION })
    }
  })

  it('视图版本 16：开着旧页面的升级后，磁盘上旧版本（15）的全局视图和体检视图经 refresh-views 按新版本重新生成', async () => {
    expect(GUI_VIEW_VERSION).toBe(16)
    const e = env()
    await seedPair(e)
    await mkdir(join(root, GUI_VIEW_DIR), { recursive: true })
    for (const file of [...Object.values(GUI_VIEW_FILES), GUI_CHECKUP_VIEW_FILE]) await writeFile(join(root, GUI_VIEW_DIR, file), JSON.stringify({ version: 15 }))
    ok(await e.run({ cmd: 'refresh-views' }))
    expect(pendingViewSchema.parse(await e.readView('pending')).version).toBe(16)
    expect(healthViewSchema.parse(await e.readView('health')).version).toBe(16)
    expect(libraryViewSchema.parse(await e.readView('library')).version).toBe(16)
    expect(deletedViewSchema.parse(await e.readView('deleted')).version).toBe(16)
    expect((await e.readCheckupView()).version).toBe(16)
  })

  it('磁盘上是旧版（版本 4，没有建议整理）的待处理视图：按新版本重写，各级条数带上建议整理', async () => {
    const e = env()
    const entry = await seedPair(e)
    await mkdir(join(root, GUI_VIEW_DIR), { recursive: true })
    await writeFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.pending), JSON.stringify({
      version: 4, dot: 'amber', typeLabels: {}, levelCounts: { 'must-fix': 0, 'your-call': 1 },
      items: [{ kind: 'conflict-horizontal', level: 'your-call', decisionId: entry.id, firstSeenAt: 1, summary: '包管理器矛盾', left: null, right: null }],
    }))
    expect(pendingViewSchema.safeParse(JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.pending), 'utf8'))).success).toBe(false)
    ok(await e.run({ cmd: 'refresh-views' }))
    const pending = pendingViewSchema.parse(await e.readView('pending'))
    expect(pending.version).toBe(GUI_VIEW_VERSION)
    expect(pending.items.filter(i => i.kind !== 'advice').map(i => [i.level, i.kind])).toEqual([['your-call', 'conflict-horizontal']])
    expect(pending.levelCounts).toMatchObject({ 'must-fix': 0, 'your-call': 1 })
    expect(pending.levelCounts.advice).toBe(pending.items.filter(i => i.level === 'advice').length)
  })
})

describe('读不出的文件', () => {
  it('解析报错只给错误名与行列，不引出原文行：密钥（两级都算，长行截掉前缀的也算）不出现在待处理与健康视图里', async () => {
    const e = env()
    const suspected = 'api_key: TESTONLY0000000000000000'
    const longKey = 'sk-proj-' + 'TESTONLY'.padEnd(150, '7')
    await mkdir(join(root, GLOBAL_DIR), { recursive: true })
    // YAML 报错会引出错的那一行：三个文件各让一种密钥落在那一行上；长行的摘录会截掉 sk- 前缀
    await writeFile(join(root, GLOBAL_DIR, 'bad-critical.md'), `---\nname: 坏文件\nsummary: [${FAKE_SECRET.sk}\n---\n正文\n`)
    await writeFile(join(root, GLOBAL_DIR, 'bad-suspected.md'), `---\nname: 坏文件\nnote: ${suspected}\n---\n正文\n`)
    await writeFile(join(root, GLOBAL_DIR, 'bad-long.md'), `---\nname: 坏文件\napi: "${longKey}" trailing\n---\n正文\n`)
    ok(await e.run({ cmd: 'refresh-views' }))
    const errors = pendingViewSchema.parse(await e.readView('pending')).items.flatMap(i => i.kind === 'unreadable-file' ? [i.error] : [])
    expect(errors).toHaveLength(3)
    for (const error of errors) expect(error).toMatch(/第 \d+ 行第 \d+ 列/)
    for (const text of [...errors, JSON.stringify(await e.readView('health'))]) {
      expect(text).not.toContain(FAKE_SECRET.sk)
      expect(text).not.toContain(suspected)
      expect(text).not.toContain('7777777777')
    }
  })
})

describe('edit-memory（建议整理的直接改）', () => {
  const LATER = NOW + 1000
  const wsScope = (workspacePath: string) => ({ kind: 'workspace', workspacePath }) as const
  const scopeOf = (workspacePath: string | undefined) => (workspacePath === undefined ? { kind: 'global' } as const : wsScope(workspacePath))
  /** 卡片上的版本：从视图里读，和界面发的一样。 */
  async function baseOf(e: ReturnType<typeof env>, id: string) {
    ok(await e.run({ cmd: 'refresh-views' }))
    const card = libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items).find(m => m.id === id)!
    return { updatedAt: card.updatedAt, digest: card.digest! }
  }
  const fileOf = async (e: ReturnType<typeof env>, id: string, workspacePath?: string) =>
    (await e.store.locate(id, scopeAt(workspacePath)))!.filePath
  const edit = (memoryId: string, workspacePath: string | undefined, base: { updatedAt: number; digest: string }, fields: Partial<Extract<MemoryCommand, { cmd: 'edit-memory' }>> = {}): MemoryCommand => ({
    cmd: 'edit-memory', memoryId, layer: scopeOf(workspacePath), base, content: '新正文', name: '新名称', summary: '新摘要', tags: ['新标签'], ...fields,
  })

  it('文件里 content / name / summary / tags 是新值；updatedAt、lastConfirmedAt 刷新，digest 重算，不标手改，维护后索引里是新摘要；其余字段一概不动', async () => {
    const e = env()
    const original = record({
      id: 'mem_e', name: '发版流程', type: 'project', scope: 'workspace', workspacePath: SESSION_WS,
      content: '旧正文', summary: '旧摘要', tags: ['发版'],
      source: { sessionId: 'sess-old', eventRange: [3, 9], sourceMode: 'user-behavior' },
      createdAt: 100, updatedAt: 200, lastConfirmedAt: 300, validFrom: 60_000, validTo: Date.UTC(2100, 0, 1),
      confidence: 0.7, supersedes: ['mem_older'], recallCount: 4, lastRecalledAt: 500,
    })
    await e.store.create(original)
    const base = await baseOf(e, 'mem_e')
    e.clock.now = LATER
    const body = ok(await e.run(edit('mem_e', SESSION_WS, base, { content: '新正文', name: '发版步骤', summary: '新摘要', tags: ['发版', 'npm'] })))

    const after = (await e.store.get('mem_e', { workspacePath: SESSION_WS }))!
    expect([after.content, after.name, after.summary, after.tags]).toEqual(['新正文', '发版步骤', '新摘要', ['发版', 'npm']])
    expect([after.updatedAt, after.lastConfirmedAt]).toEqual([LATER, LATER])
    const changed = ['content', 'name', 'summary', 'tags', 'updatedAt', 'lastConfirmedAt'] as const
    const rest = (r: typeof original) => Object.fromEntries(Object.entries(r).filter(([k]) => !(changed as readonly string[]).includes(k)))
    expect(rest(after)).toEqual(rest(original))

    const path = await fileOf(e, 'mem_e', SESSION_WS)
    expect(body.filePath).toBe(path)
    const fm = splitFrontmatter(await readFile(path, 'utf8')).data
    expect(fm.digest).toBe(computeDigest('发版步骤', '新摘要', '新正文'))
    expect(fm).not.toHaveProperty('handEdited')
    await e.store.maintain({ kind: 'visible', workspacePath: SESSION_WS })
    expect(await indexedIds(dirname(path))).toEqual(['mem_e'])
    const index = await indexText(dirname(path))
    expect(index).toContain('新摘要')
    expect(index).not.toContain('旧摘要')

    // 写前拍快照（项目记忆也拍），账本留一条已结清的条目交给 undo；它不进待处理
    const [snap] = await e.snapshots.list()
    expect(snap).toMatchObject({ operation: 'pre-update', memoryIds: ['mem_e'] })
    expect(snap!.data[0]!.content).toBe('旧正文')
    expect(body).toMatchObject({ cmd: 'edit-memory', memoryIds: ['mem_e'], snapshotId: snap!.id })
    const settled = await e.decisions.listSettled()
    expect(settled.map(d => [d.id, d.kind, d.memoryIds, d.settled])).toEqual([[body.decisionId, 'edit', ['mem_e'], { verdict: 'edited', at: LATER, snapshotId: snap!.id }]])
    expect(ledgerItems(pendingViewSchema.parse(await e.readView('pending')))).toEqual([])
  })

  it('写盘前文件被别处改过、文件表重来时卡片已过期：回 stale，不记撤销条目，别处的版本保留', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_x', name: '甲', content: '旧正文', scope: 'workspace', workspacePath: SESSION_WS }))
    const path = await fileOf(e, 'mem_x', SESSION_WS)
    const base = await baseOf(e, 'mem_x')
    e.clock.now = LATER
    // 第一次算完要写的内容后、写盘复核前，另一个进程改了这个文件：文件表重读重来，这时卡片版本已对不上
    const update = e.store.update.bind(e.store)
    let isArmed = true
    e.store.update = (rec, fn, from) => update(rec, (cur) => {
      const next = fn(cur)
      if (isArmed) {
        isArmed = false
        writeFileSync(path, encodeRecord({ ...cur, content: '别处改的', updatedAt: LATER + 1 }, {}))
      }
      return next
    }, from)
    expect(err(await e.run(edit('mem_x', SESSION_WS, base))).code).toBe('stale')
    expect(isArmed).toBe(false)
    expect((await e.store.get('mem_x', scopeAt(SESSION_WS)))!.content).toBe('别处改的')
    expect(await e.decisions.listSettled()).toEqual([])
  })

  describe('界面落后于磁盘而失败时重写视图（外部改动没有文件监听，靠这次失败把界面换成磁盘上的现状）', () => {
    const libraryCard = async (e: ReturnType<typeof env>, id: string) =>
      libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items).find(m => m.id === id)
    /** 数视图写入器被请求重写的次数。 */
    const counted = () => {
      const requests = { count: 0 }
      const wrapViews = (writer: ViewWriter) => ({
        request: (...args: Parameters<ViewWriter['request']>) => { requests.count++; return writer.request(...args) },
        rewriteAll: writer.rewriteAll.bind(writer), collectViews: writer.collectViews.bind(writer), requestCheckups: writer.requestCheckups.bind(writer),
      })
      return { requests, wrapViews }
    }

    it('文件在外面手改过、卡片版本对不上回 stale：视图照样重写，卡片换成手改后的正文', async () => {
      const e = env()
      await e.store.create(record({ id: 'mem_h', name: '甲', content: '旧正文', scope: 'workspace', workspacePath: SESSION_WS }))
      const base = await baseOf(e, 'mem_h')
      const path = await fileOf(e, 'mem_h', SESSION_WS)
      await writeFile(path, (await readFile(path, 'utf8')).replace('旧正文', '手改的正文'))
      expect(err(await e.run(edit('mem_h', SESSION_WS, base))).code).toBe('stale')
      expect((await libraryCard(e, 'mem_h'))!.content).toBe('手改的正文')
    })

    it('文件在外面删掉了、删除回 not-found：视图照样重写，这条从记忆查看里消失', async () => {
      const e = env()
      await e.store.create(record({ id: 'mem_d', name: '甲', content: '正文', scope: 'workspace', workspacePath: SESSION_WS }))
      ok(await e.run({ cmd: 'refresh-views' }))
      expect(await libraryCard(e, 'mem_d')).toBeDefined()
      await rm(await fileOf(e, 'mem_d', SESSION_WS))
      expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_d', layer: wsScope(SESSION_WS) })).code).toBe('not-found')
      expect(await libraryCard(e, 'mem_d')).toBeUndefined()
    })

    it('其他失败（参数不对）不重写', async () => {
      const { requests, wrapViews } = counted()
      const e = env({ wrapViews })
      await e.store.create(record({ id: 'mem_p', name: '甲', content: '正文', scope: 'workspace', workspacePath: SESSION_WS }))
      const base = await baseOf(e, 'mem_p')
      const before = requests.count
      const same = { memoryId: 'mem_p', layer: wsScope(SESSION_WS), base }
      expect(err(await e.run({ cmd: 'merge-memories', memories: [same, same], content: '合', name: '合', summary: '合', tags: [] })).code).toBe('invalid-args')
      expect(requests.count).toBe(before)
    })
  })

  it.each([['项目记忆', SESSION_WS], ['全局记忆', undefined]] as const)('%s改后可撤销：撤销后文件与改前一字不差，账本条目清掉', async (_label, workspacePath) => {
    const e = env()
    await e.store.create(record({ id: 'mem_u', name: '甲', content: '旧正文', tags: ['旧'], ...(workspacePath !== undefined ? { scope: 'workspace', workspacePath } : {}) }))
    const path = await fileOf(e, 'mem_u', workspacePath)
    const before = await memoryText(path)
    e.clock.now = LATER
    const body = ok(await e.run(edit('mem_u', workspacePath, await baseOf(e, 'mem_u'), { name: '乙' })))
    expect((await e.store.get('mem_u', { workspacePath }))!.content).toBe('新正文')

    const undone = ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(undone.memoryIds).toEqual(['mem_u'])
    expect(await fileOf(e, 'mem_u', workspacePath)).toBe(path)
    expect(await memoryText(path)).toBe(before)
    expect(await allEntries(e)).toEqual([])
  })

  it('界面直接改过之后，模型不带 force 照常改写这条', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g', name: '甲', content: '旧正文', scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run(edit('mem_g', SESSION_WS, await baseOf(e, 'mem_g'))))
    const r = await runSavePipeline(candidate({ action: 'update', change: 'correct', id: 'mem_g', scope: 'workspace', content: '模型想写的' }), {
      store: e.store, registry, workspacePath: SESSION_WS, session: { id: 'sess-1', lastSeq: 1 }, snapshots: e.snapshots, decisions: e.decisions,
    })
    expect(r.kind).toBe('updated')
    expect((await e.store.get('mem_g', { workspacePath: SESSION_WS }))!.content).toBe('模型想写的')
  })

  describe('子 agent 写入的记忆', () => {
    const creator = { sessionId: 'sess-sub', depth: 2, parentSessionId: 'sess-parent', rootSessionId: 'sess-root' }

    it('直接改待确认的记录算用户升档：写 reviewed user 与改的时刻，创建者字段不动', async () => {
      const e = env()
      await e.store.create(record({ id: 'mem_p', content: '旧正文', scope: 'workspace', workspacePath: SESSION_WS, delegation: creator }))
      const base = await baseOf(e, 'mem_p')
      e.clock.now = LATER
      ok(await e.run(edit('mem_p', SESSION_WS, base)))
      const after = (await e.store.get('mem_p', { workspacePath: SESSION_WS }))!
      expect(after.content).toBe('新正文')
      expect(after.delegation).toEqual({ ...creator, reviewed: { by: 'user', at: LATER } })
    })

    it.each([
      ['主会话已接受', { ...creator, reviewed: { by: 'main' as const, at: 50 } }],
      ['用户已改过', { ...creator, reviewed: { by: 'user' as const, at: 50 } }],
      ['普通记录', undefined],
    ])('%s：直接改不碰 delegation', async (_label, delegation) => {
      const e = env()
      await e.store.create(record({ id: 'mem_r', content: '旧正文', scope: 'workspace', workspacePath: SESSION_WS, ...(delegation !== undefined ? { delegation } : {}) }))
      const base = await baseOf(e, 'mem_r')
      e.clock.now = LATER
      ok(await e.run(edit('mem_r', SESSION_WS, base)))
      const after = (await e.store.get('mem_r', { workspacePath: SESSION_WS }))!
      expect(after.content).toBe('新正文')
      expect(after.delegation).toEqual(delegation)
    })

    it('借的会话是子 agent：直接改仍是 subagent-readonly，待确认不变', async () => {
      const e = env({ delegationDepth: 1 })
      const r = record({ id: 'mem_s', content: '旧正文', scope: 'workspace', workspacePath: SESSION_WS, delegation: creator })
      await e.store.create(r)
      // 子会话里 refresh-views 也只读，卡片版本按文件里的算
      const base = { updatedAt: r.updatedAt, digest: editFingerprint(r) }
      expect(err(await e.run(edit('mem_s', SESSION_WS, base))).code).toBe('subagent-readonly')
      const after = (await e.store.get('mem_s', { workspacePath: SESSION_WS }))!
      expect([after.content, after.delegation]).toEqual(['旧正文', creator])
    })
  })

  it('体检关闭时照样能改、能撤销', async () => {
    const e = env({ governanceEnabled: false })
    await e.store.create(record({ id: 'mem_off', content: '旧正文' }))
    const body = ok(await e.run(edit('mem_off', undefined, await baseOf(e, 'mem_off'))))
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect((await e.store.get('mem_off'))!.content).toBe('旧正文')
  })

  it('卡片加载之后记忆被改过（手改文件、别处更新）：stale，不写盘、不拍快照、不记账', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_s', name: '甲', content: '旧正文', scope: 'workspace', workspacePath: SESSION_WS }))
    const base = await baseOf(e, 'mem_s')
    const path = await fileOf(e, 'mem_s', SESSION_WS)
    // 手改正文：updatedAt 没变，digest 对不上
    const handEdited = (await readFile(path, 'utf8')).replace('旧正文', '手改的正文')
    await writeFile(path, handEdited)
    const body = err(await e.run(edit('mem_s', SESSION_WS, base)))
    expect(body.code).toBe('stale')
    expect(await readFile(path, 'utf8')).toBe(handEdited)
    // 别处更新：卡片指纹按此刻的内容算、对得上，只有 updatedAt 对不上
    await e.store.update({ id: 'mem_s', workspacePath: SESSION_WS }, r => ({ ...r, tags: ['别处加的'], updatedAt: 99 }))
    const current = (await e.store.get('mem_s', { workspacePath: SESSION_WS }))!
    expect(err(await e.run(edit('mem_s', SESSION_WS, { ...base, digest: editFingerprint(current) }))).code).toBe('stale')
    expect((await e.store.get('mem_s', { workspacePath: SESSION_WS }))!.tags).toEqual(['别处加的'])
    expect(await e.snapshots.list()).toEqual([])
    expect(await allEntries(e)).toEqual([])
  })

  it('高危密钥直接拦（藏在哪个字段都算），什么都不写', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_k', content: '旧正文' }))
    const base = await baseOf(e, 'mem_k')
    for (const fields of [{ content: `部署用 ${FAKE_SECRET.sk}` }, { tags: [FAKE_SECRET.github] }, { summary: FAKE_SECRET.aws }]) {
      expect(err(await e.run(edit('mem_k', undefined, base, fields))).code).toBe('secret-critical')
    }
    expect((await e.store.get('mem_k'))!.content).toBe('旧正文')
    expect(await e.snapshots.list()).toEqual([])
  })

  it('疑似密钥先拦下等确认；带 allowSecret 重发才写', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_q', content: '旧正文' }))
    const base = await baseOf(e, 'mem_q')
    const content = '测试库 api_key: TESTONLY0000000000000000'
    const refusal = err(await e.run(edit('mem_q', undefined, base, { content })))
    expect(refusal.code).toBe('secret-suspected')
    expect(refusal.detail).toContain('allowSecret')
    expect((await e.store.get('mem_q'))!.content).toBe('旧正文')
    ok(await e.run(edit('mem_q', undefined, base, { content, allowSecret: true })))
    expect((await e.store.get('mem_q'))!.content).toBe(content)
  })

  it('原记忆含密钥（界面上是遮盖后的正文）：has-secret，什么都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_h', content: `token ${FAKE_SECRET.sk}` }))
    const body = err(await e.run(edit('mem_h', undefined, await baseOf(e, 'mem_h'), { content: 'token [已隐藏]' })))
    expect(body.code).toBe('has-secret')
    expect((await e.store.get('mem_h'))!.content).toBe(`token ${FAKE_SECRET.sk}`)
    expect(await e.snapshots.list()).toEqual([])
  })

  it('原记忆只含确认存下的疑似密钥（界面上是原文）：照常改，新内容仍带疑似密钥时同样要 allowSecret', async () => {
    const e = env()
    const content = '测试库 api_key: TESTONLY0000000000000000'
    await e.store.create(record({ id: 'mem_sq', content }))
    const next = `${content}，只在本地用`
    ok(await e.run(edit('mem_sq', undefined, await baseOf(e, 'mem_sq'), { content: next, allowSecret: true })))
    expect((await e.store.get('mem_sq'))!.content).toBe(next)
  })

  it('别的项目的记忆：先要 allowCrossWorkspace，带上才改', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_o', content: '旧正文', scope: 'workspace', workspacePath: OTHER_WS }))
    const base = await baseOf(e, 'mem_o')
    expect(err(await e.run(edit('mem_o', OTHER_WS, base)))).toMatchObject({ code: 'cross-workspace', rejected: [{ id: 'mem_o', workspacePath: OTHER_WS }] })
    expect((await e.store.get('mem_o', { workspacePath: OTHER_WS }))!.content).toBe('旧正文')
    ok(await e.run({ ...edit('mem_o', OTHER_WS, base), allowCrossWorkspace: true } as MemoryCommand))
    expect((await e.store.get('mem_o', { workspacePath: OTHER_WS }))!.content).toBe('新正文')
  })

  it('已删除或不存在 → not-found；名称或正文为空 → invalid-args', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_gone' }))
    await e.store.create(record({ id: 'mem_ok' }))
    const base = await baseOf(e, 'mem_gone')
    ok(await e.run({ cmd: 'forget', memoryId: 'mem_gone' }))
    expect(err(await e.run(edit('mem_gone', undefined, base))).code).toBe('not-found')
    expect(err(await e.run(edit('mem_none', undefined, base))).code).toBe('not-found')
    const okBase = await baseOf(e, 'mem_ok')
    expect(err(await e.run(edit('mem_ok', undefined, okBase, { name: '' }))).code).toBe('invalid-args')
    expect(err(await e.run(edit('mem_ok', undefined, okBase, { content: '' }))).code).toBe('invalid-args')
  })

  async function scannedWithAdvice() {
    const llm: SemanticLlm = { complete: async () => JSON.stringify({ findings: [{ type: 'unclear', memoryIds: ['mem_c'], summary: '缺对象' }] }) }
    const e = env({ llm })
    await e.store.create(record({ id: 'mem_c', content: '照旧', scope: 'workspace', workspacePath: SESSION_WS }))
    await e.store.create(record({ id: 'mem_l', content: 'x'.repeat(2100), scope: 'workspace', workspacePath: SESSION_WS }))
    ok(await e.run({ cmd: 'scan' }))
    const adviceIds = async (type: string) => pendingViewSchema.parse(await e.readView('pending')).items
      .flatMap(i => i.kind === 'advice' && i.type === type ? i.memories.map(m => m.id) : [])
    expect(await adviceIds('unclear')).toEqual(['mem_c'])
    expect(await adviceIds('bloat')).toEqual(['mem_l'])
    e.clock.now = LATER
    return { e, adviceIds }
  }

  it('改完后语义类建议（表述不清）不再显示', async () => {
    const { e, adviceIds } = await scannedWithAdvice()
    ok(await e.run(edit('mem_c', SESSION_WS, await baseOf(e, 'mem_c'), { content: '发版前在 feature 分支跑 typecheck' })))
    expect(await adviceIds('unclear')).toEqual([])
  })

  it('撤销这次修改后，语义类建议回来', async () => {
    const { e, adviceIds } = await scannedWithAdvice()
    const body = ok(await e.run(edit('mem_c', SESSION_WS, await baseOf(e, 'mem_c'), { content: '发版前在 feature 分支跑 typecheck' })))
    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(await adviceIds('unclear')).toEqual(['mem_c'])
  })

  it('规则类建议（内容过长）按新内容重算', async () => {
    const { e, adviceIds } = await scannedWithAdvice()
    ok(await e.run(edit('mem_l', SESSION_WS, await baseOf(e, 'mem_l'), { content: 'y'.repeat(2050) })))
    expect(await adviceIds('bloat')).toEqual(['mem_l'])
    ok(await e.run(edit('mem_l', SESSION_WS, await baseOf(e, 'mem_l'), { content: '短了' })))
    expect(await adviceIds('bloat')).toEqual([])
  })
})

describe('merge-memories（内容重复的直接合并）', () => {
  const LATER = NOW + 1000
  const scopeOf = (r: { scope: string; workspacePath?: string }) => (r.scope === 'global' ? { kind: 'global' } as const : { kind: 'workspace', workspacePath: r.workspacePath! } as const)
  async function cardsOf(e: ReturnType<typeof env>) {
    ok(await e.run({ cmd: 'refresh-views' }))
    return libraryViewSchema.parse(await e.readView('library')).layers.flatMap(l => l.items)
  }
  async function merge(e: ReturnType<typeof env>, ids: [string, string], fields: object = {}) {
    const cards = await cardsOf(e)
    const ref = (id: string) => {
      const c = cards.find(m => m.id === id)!
      return { memoryId: id, layer: scopeOf(c), base: { updatedAt: c.updatedAt, digest: c.digest! } }
    }
    return e.run({ cmd: 'merge-memories', memories: [ref(ids[0]), ref(ids[1])], content: '合并后的正文', name: '合并后', summary: '合并摘要', tags: ['甲', '乙'], ...fields } as MemoryCommand)
  }

  it.each([
    ['两条同层：保留创建较早的', { scope: 'workspace', workspacePath: SESSION_WS, createdAt: 200 }, { scope: 'workspace', workspacePath: SESSION_WS, createdAt: 100 }, 'mem_b', 'mem_a'],
    ['一条全局一条项目：保留全局那条（哪怕创建得晚）', { scope: 'workspace', workspacePath: SESSION_WS, createdAt: 100 }, { scope: 'global', createdAt: 200 }, 'mem_b', 'mem_a'],
  ] as const)('%s；另一条进最近删除，同一份快照；撤销后两条都恢复原样', async (_label, a, b, keptId, removedId) => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '甲的正文', tags: ['甲'], ...a }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '乙的正文', tags: ['乙'], ...b }))
    const ws = (id: string) => (id === 'mem_a' ? a : b).scope === 'global' ? undefined : SESSION_WS
    const paths = { kept: await (async () => (await e.store.locate(keptId, scopeAt(ws(keptId))))!.filePath)(), removed: (await e.store.locate(removedId, scopeAt(ws(removedId))))!.filePath }
    const before = { kept: await memoryText(paths.kept), removed: await memoryText(paths.removed) }

    e.clock.now = LATER
    const body = ok(await merge(e, ['mem_a', 'mem_b']))
    expect(body.memoryIds).toEqual([keptId, removedId])
    const kept = (await e.store.get(keptId, scopeAt(ws(keptId))))!
    expect([kept.status, kept.content, kept.name, kept.summary, kept.tags, kept.updatedAt]).toEqual(['active', '合并后的正文', '合并后', '合并摘要', ['甲', '乙'], LATER])
    expect(kept).not.toHaveProperty('handEdited')
    const removed = (await e.store.get(removedId, scopeAt(ws(removedId))))!
    // 删除时刻用注入的时钟，最近删除的保留期才算得准
    expect([removed.status, removed.updatedAt, removed.deletedAt]).toEqual(['deleted', LATER, LATER])
    // 记下它并进了保留的那条：历史版本以后归到那条名下
    expect(removed.mergedInto).toEqual({ id: keptId, scopeKey: ws(keptId) ?? 'global', as: 'merge' })
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => i.memory.id)).toEqual([removedId])
    const snaps = await e.snapshots.list()
    expect(snaps).toHaveLength(1)
    expect([...snaps[0]!.memoryIds].sort()).toEqual(['mem_a', 'mem_b'])
    expect((await e.decisions.listSettled()).map(d => [d.kind, d.memoryIds, d.settled?.verdict, d.settled?.snapshotId])).toEqual([['edit', [keptId, removedId], 'merged', snaps[0]!.id]])

    ok(await e.run({ cmd: 'undo', decisionId: body.decisionId! }))
    expect(await memoryText(paths.kept)).toBe(before.kept)
    expect(await memoryText(paths.removed)).toBe(before.removed)
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
    expect(await allEntries(e)).toEqual([])
  })

  it('任一条在卡片加载后被改过：stale，两条都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', content: '甲的正文' }))
    await e.store.create(record({ id: 'mem_b', content: '乙的正文' }))
    const cards = await cardsOf(e)
    await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: '乙被改了', updatedAt: 5 }))
    const ref = (id: string) => { const c = cards.find(m => m.id === id)!; return { memoryId: id, layer: { kind: 'global' } as const, base: { updatedAt: c.updatedAt, digest: c.digest! } } }
    const body = err(await e.run({ cmd: 'merge-memories', memories: [ref('mem_a'), ref('mem_b')], content: '合并', name: '合并', summary: '', tags: [] }))
    expect(body.code).toBe('stale')
    expect([(await e.store.get('mem_a'))!.content, (await e.store.get('mem_b'))!.status]).toEqual(['甲的正文', 'active'])
    expect(await e.snapshots.list()).toEqual([])
  })

  it('核对之后、软删之前另一条被别处改过：整体回 stale，保留的那条退回原样，另一条照旧在用、留着新内容', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', content: '甲的正文', createdAt: 1 }))
    await e.store.create(record({ id: 'mem_b', content: '乙的正文', createdAt: 2 }))
    const pathA = (await e.store.locate('mem_a'))!.filePath
    const beforeA = await memoryText(pathA)
    // 快照拍在核对之后：借它插入另一个会话对乙的修改
    const capture = e.snapshots.capture.bind(e.snapshots)
    e.snapshots.capture = async (...args) => {
      const snap = await capture(...args)
      await e.store.update({ id: 'mem_b' }, r => ({ ...r, content: '乙的第二版', updatedAt: LATER + 5 }))
      return snap
    }
    e.clock.now = LATER
    expect(err(await merge(e, ['mem_a', 'mem_b'])).code).toBe('stale')
    expect(await memoryText(pathA)).toBe(beforeA)
    expect(await e.store.get('mem_b')).toMatchObject({ status: 'active', content: '乙的第二版' })
    expect(await e.decisions.listSettled()).toEqual([])
  })

  it('要删掉的那条含疑似密钥（软删不了）：入口就拒绝 has-secret，两条都原样、不拍快照、不记账', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a', content: '甲的正文', createdAt: 1 }))
    await e.store.create(record({ id: 'mem_b', content: '内部约定 api_key: TESTONLY0000000000000', createdAt: 2 }))
    const both = async () => Promise.all(['mem_a', 'mem_b'].map(async id => (await e.store.locate(id))!))
    const before = await both()
    e.clock.now = LATER
    const body = err(await merge(e, ['mem_a', 'mem_b']))
    expect(body.code).toBe('has-secret')
    expect(body.detail).toContain('mem_b')
    expect(await both()).toEqual(before)
    expect(await e.snapshots.list()).toEqual([])
    expect(await allEntries(e)).toEqual([])
  })

  it('同一条记忆合并两次 → invalid-args', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_a' }))
    const cards = await cardsOf(e)
    const ref = { memoryId: 'mem_a', layer: { kind: 'global' } as const, base: { updatedAt: cards[0]!.updatedAt, digest: cards[0]!.digest! } }
    expect(err(await e.run({ cmd: 'merge-memories', memories: [ref, ref], content: '合并', name: '合并', summary: '', tags: [] })).code).toBe('invalid-args')
  })

  it('保留的那条是待确认的子 agent 记忆：合并算用户升档，写 reviewed user，另一条照常进最近删除', async () => {
    const e = env()
    const creator = { sessionId: 'sess-sub', depth: 1, parentSessionId: 'sess-1' }
    await e.store.create(record({ id: 'mem_a', content: '甲的正文', createdAt: 1, delegation: creator }))
    await e.store.create(record({ id: 'mem_b', content: '乙的正文', createdAt: 2 }))
    e.clock.now = LATER
    const body = ok(await merge(e, ['mem_a', 'mem_b']))
    expect(body.memoryIds).toEqual(['mem_a', 'mem_b'])
    const kept = (await e.store.get('mem_a'))!
    expect([kept.content, kept.delegation]).toEqual(['合并后的正文', { ...creator, reviewed: { by: 'user', at: LATER } }])
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
  })
})
import { describe, expect, it } from 'vitest'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { commitChange } from '../src/commit-change.ts'
import { GUI_VIEW_DIR, type LinkEdge } from '../src/gui/contract.ts'
import { premiseDigest } from '../src/links.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { scopeAt, type Scope } from '../src/scope.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { SECRET_MASK } from '../src/secrets.ts'
import { HISTORY_DIR, workspaceDirName, GLOBAL_DIR } from '../src/storage/paths.ts'
import { allEntries, env, err, memoryTree, ok, root, SESSION_WS } from './helpers/gui-command-env.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// 记忆详情的两条只读命令：memory-detail 读这条记忆的历史版本和一层链接，read-version 读一版。
// 真实临时目录上的文件表和侧表，宿主那一侧（借来的会话）换成测试桩。

const WS = SESSION_WS
const MINUTE = 60_000
const GLOBAL: Scope = { kind: 'global' }
type Env = ReturnType<typeof env>

const ws = (partial: Partial<MemoryRecord> = {}) => record({ scope: 'workspace', workspacePath: WS, ...partial })

/** 过一分钟做一次状态变化，留一版历史。 */
async function changeState(e: Env, m: Pick<MemoryRecord, 'id' | 'workspacePath'>, content: string, reason: string) {
  e.clock.now += MINUTE
  const scope = scopeAt(m.workspacePath)
  const target = (await e.store.get(m.id, scope))!
  const r = await commitChange({ target, scope, kind: 'state-change', fields: { content }, by: 'main', reason, at: e.clock.now }, e)
  if (r.kind !== 'written') throw new Error(JSON.stringify(r))
}

const detailOf = async (e: Env, memoryId: string, layer: Scope) => ok(await e.run({ cmd: 'memory-detail', memoryId, layer })).detail!
const edgeKey = (edge: LinkEdge) => `${edge.direction}:${edge.kind}:${edge.node.id}`

describe('memory-detail：历史版本', () => {
  it('列出各版，新的在前：时段、变化原因（遮盖密钥、折成一行）、事实时间、出处会话', async () => {
    const e = env()
    const m = ws({ id: 'mem_deploy', name: '部署方式', content: '第一版', factTime: '2026-03', createdAt: e.clock.now, source: { sessionId: 'sess-first', eventRange: [0, 1], sourceMode: 'user-explicit' } })
    await e.store.create(m)
    await changeState(e, m, '第二版', `换成乙\n密钥是 ${FAKE_SECRET.sk}`)
    await changeState(e, m, '第三版', '换成丙')
    const { history, memory, status } = await detailOf(e, m.id, scopeAt(WS))
    expect(status).toBe('active')
    expect(memory.content).toBe('第三版')
    expect(history.isComplete).toBe(true)
    expect(history.versions.map(v => v.reason)).toEqual(['换成丙', `换成乙 密钥是 ${SECRET_MASK}`])
    const [second, first] = history.versions
    expect(first).toMatchObject({ startedAt: m.createdAt, endedAt: second!.startedAt, factTime: '2026-03', sourceSessionId: 'sess-first' })
    expect(first!.mergedFrom).toBeUndefined()
  })

  it('合并过别的记忆：被合并方软删期间和物理删除之后列出的版本一样，并进来的带原记忆的 id 和名称', async () => {
    const e = env()
    const keeper = ws({ id: 'mem_keeper', name: '留下的', content: '甲一' })
    const gone = ws({ id: 'mem_gone', name: `并进去的 ${FAKE_SECRET.github}`, content: '乙一' })
    await e.store.create(keeper)
    await e.store.create(gone)
    await changeState(e, keeper, '甲二', '甲换了')
    await changeState(e, gone, '乙二', '乙换了')
    const mergedInto = { id: keeper.id, scopeKey: WS, as: 'merge' as const }
    expect(await e.store.softDeleteUnlessSecret(gone, { at: scopeAt(WS), now: e.clock.now, mergedInto, isSecret: () => false })).toBe('deleted')
    const during = (await detailOf(e, keeper.id, scopeAt(WS))).history
    expect(during.versions.map(v => [v.reason, v.mergedFrom?.id ?? null])).toEqual([['乙换了', gone.id], ['甲换了', null]])
    expect(during.versions[0]!.mergedFrom!.name).toBe(`并进去的 ${SECRET_MASK}`)
    // 过了保留期，清扫时物理删除被合并方，它的历史搬到留下的那条名下
    e.clock.now += RETENTION_MS + MINUTE
    await e.store.maintain(scopeAt(WS))
    expect(await e.store.get(gone.id, scopeAt(WS))).toBeUndefined()
    expect((await detailOf(e, keeper.id, scopeAt(WS))).history).toEqual(during)
  })

  it('保留方有过状态变化后把另一条并成版本：两版的号不同，各读回各自的正文；物理删除前后列出的和读回的都一样', async () => {
    const e = env()
    const keeper = ws({ id: 'mem_keeper', name: '留下的', content: '甲一' })
    const gone = ws({ id: 'mem_gone', name: '并进去的', content: '乙一' })
    await e.store.create(keeper)
    await e.store.create(gone)
    await changeState(e, keeper, '甲二', '甲换了')
    // 并成版本的结束时刻取保留方的状态起点：和保留方最新那版的结束时刻相同
    const stateSince = (await e.store.get(keeper.id, scopeAt(WS)))!.stateSince!
    const mergedInto = { id: keeper.id, scopeKey: WS, as: 'version' as const, endedAt: stateSince }
    expect(await e.store.softDeleteUnlessSecret(gone, { at: scopeAt(WS), now: e.clock.now, mergedInto, isSecret: () => false })).toBe('deleted')
    const contents = async () => {
      const { versions } = (await detailOf(e, keeper.id, scopeAt(WS))).history
      const read = await Promise.all(versions.map(async v => ok(await e.run({ cmd: 'read-version', memoryId: keeper.id, layer: scopeAt(WS), versionId: v.versionId })).version))
      return versions.map((v, i) => [v.versionId, v.mergedFrom?.id ?? null, read[i]!.status === 'found' ? read[i]!.content : read[i]!.status])
    }
    const during = await contents()
    expect(new Set(during.map(([id]) => id)).size).toBe(2)
    expect(during.map(([, from, content]) => [from, content]).sort()).toEqual([[gone.id, '乙一'], [null, '甲一']].sort())
    e.clock.now += RETENTION_MS + MINUTE
    await e.store.maintain(scopeAt(WS))
    expect(await e.store.get(gone.id, scopeAt(WS))).toBeUndefined()
    expect(await contents()).toEqual(during)
  })

  it('出处会话 id 是手改进去的密钥：遮盖后再给', async () => {
    const e = env()
    const m = ws({ id: 'mem_src_secret', content: '第一版', source: { sessionId: `sess ${FAKE_SECRET.github}\n下一行`, eventRange: [0, 1], sourceMode: 'user-explicit' } })
    await e.store.create(m)
    await changeState(e, m, '第二版', '换了')
    const [version] = (await detailOf(e, m.id, scopeAt(WS))).history.versions
    expect(version!.sourceSessionId).toBe(`sess ${SECRET_MASK} 下一行`)
  })

  it('有版本文件读不出：标成不全，读到的照列', async () => {
    const e = env()
    const m = ws({ id: 'mem_partial' })
    await e.store.create(m)
    await changeState(e, m, '第二版', '换了')
    const dir = join(root, workspaceDirName(WS), HISTORY_DIR, encodeURIComponent(m.id))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '19990101T000000000Z.md'), '这不是一个版本文件\n')
    const { history } = await detailOf(e, m.id, scopeAt(WS))
    expect(history.isComplete).toBe(false)
    expect(history.versions.map(v => v.reason)).toEqual(['换了'])
  })

  it('还没有历史：列表为空、读全了', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_fresh' }))
    expect((await detailOf(e, 'mem_fresh', scopeAt(WS))).history).toEqual({ versions: [], isComplete: true })
  })

  it('按精确作用域认：同 id 在全局另有一份时只读项目那份；被取代、最近删除里的也能读', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_dup', name: '全局那份', content: '全局' }))
    await e.store.create(ws({ id: 'mem_dup', name: '项目那份', content: '项目', status: 'superseded' }))
    expect(await detailOf(e, 'mem_dup', scopeAt(WS))).toMatchObject({ status: 'superseded', memory: { name: '项目那份', scope: 'workspace' } })
    expect(await detailOf(e, 'mem_dup', GLOBAL)).toMatchObject({ status: 'active', memory: { name: '全局那份', scope: 'global' } })
  })

  it('这一条不在：not-found', async () => {
    expect(err(await env().run({ cmd: 'memory-detail', memoryId: 'mem_nowhere', layer: scopeAt(WS) })).code).toBe('not-found')
  })

  it('这个作用域没读全时找不到这一条：回读不出（failed），不说已经不在；文件头坏掉、目录读不了两种都是', async () => {
    const broken = env()
    await broken.store.create(ws({ id: 'mem_other' }))
    await writeFile(join(root, workspaceDirName(WS), '坏掉的.md'), '---\nid: [没有闭合\n---\n正文\n')
    for (const command of [{ cmd: 'memory-detail', memoryId: 'mem_lost', layer: scopeAt(WS) }, { cmd: 'read-version', memoryId: 'mem_lost', layer: scopeAt(WS), versionId: '20260101T000000000Z' }] as const) {
      expect(err(await broken.run(command)).code).toBe('failed')
    }
    const dir = join(root, workspaceDirName(WS))
    await chmod(dir, 0o000)
    try {
      expect(err(await broken.run({ cmd: 'memory-detail', memoryId: 'mem_other', layer: scopeAt(WS) })).code).toBe('failed')
    } finally {
      await chmod(dir, 0o755)
    }
  })

  it('只读：不写视图文件，记忆文件、历史、待决账本和快照都不变；体检关着、借来的是子 agent 会话也能读', async () => {
    for (const [i, opts] of [{}, { governanceEnabled: false }, { delegationDepth: 1 }].entries()) {
      const e = env(opts)
      const m = ws({ id: `mem_ro${i}` })
      await e.store.create(m)
      await changeState(e, m, '第二版', '换了')
      const before = { tree: await memoryTree(), entries: await allEntries(e), snapshots: await e.snapshots.list() }
      const [version] = (await detailOf(e, m.id, scopeAt(WS))).history.versions
      expect(ok(await e.run({ cmd: 'read-version', memoryId: m.id, layer: scopeAt(WS), versionId: version!.versionId })).version).toMatchObject({ status: 'found', content: m.content })
      await expect(access(join(root, GUI_VIEW_DIR))).rejects.toThrow()
      expect({ tree: await memoryTree(), entries: await allEntries(e), snapshots: await e.snapshots.list() }).toEqual(before)
    }
  })
})

describe('read-version', () => {
  async function seeded() {
    const e = env()
    const m = ws({ id: 'mem_v', name: '部署方式', content: `第一版 ${FAKE_SECRET.sk}` })
    await e.store.create(m)
    await changeState(e, m, '第二版', '换了')
    const [version] = (await detailOf(e, m.id, scopeAt(WS))).history.versions
    return { e, m, versionId: version!.versionId }
  }

  it('读到一版：四个面遮盖过密钥', async () => {
    const { e, m, versionId } = await seeded()
    expect(ok(await e.run({ cmd: 'read-version', memoryId: m.id, layer: scopeAt(WS), versionId })).version)
      .toEqual({ status: 'found', versionId, name: '部署方式', summary: m.summary, content: `第一版 ${SECRET_MASK}`, tags: [] })
    // 名称、摘要、标签各自带一个密钥：读回的一版里都遮盖过
    const each = env()
    const n = ws({ id: 'mem_faces', name: `名称 ${FAKE_SECRET.github}`, summary: `摘要 ${FAKE_SECRET.aws}`, tags: [`标签 ${FAKE_SECRET.slack}`], content: '正文' })
    await each.store.create(n)
    await changeState(each, n, '第二版', '换了')
    const [old] = (await detailOf(each, n.id, scopeAt(WS))).history.versions
    expect(ok(await each.run({ cmd: 'read-version', memoryId: n.id, layer: scopeAt(WS), versionId: old!.versionId })).version)
      .toEqual({ status: 'found', versionId: old!.versionId, name: `名称 ${SECRET_MASK}`, summary: `摘要 ${SECRET_MASK}`, content: '正文', tags: [`标签 ${SECRET_MASK}`] })
  })

  it('读不出：unreadable；没有这一版、历史读全了：missing', async () => {
    const { e, m } = await seeded()
    const dir = join(root, workspaceDirName(WS), HISTORY_DIR, encodeURIComponent(m.id))
    await writeFile(join(dir, '19990101T000000000Z.md'), '这不是一个版本文件\n')
    expect(ok(await e.run({ cmd: 'read-version', memoryId: m.id, layer: scopeAt(WS), versionId: '19990101T000000000Z' })).version).toEqual({ status: 'unreadable' })
    const fresh = env()
    await fresh.store.create(ws({ id: 'mem_none' }))
    expect(ok(await fresh.run({ cmd: 'read-version', memoryId: 'mem_none', layer: scopeAt(WS), versionId: '20260101T000000000Z' })).version).toEqual({ status: 'missing', isComplete: true })
  })

  it('读并进来的一版：被合并方软删期间读得到', async () => {
    const e = env()
    const keeper = ws({ id: 'mem_keeper' })
    const gone = ws({ id: 'mem_gone', content: '乙一' })
    await e.store.create(keeper)
    await e.store.create(gone)
    await changeState(e, gone, '乙二', '乙换了')
    await e.store.softDeleteUnlessSecret(gone, { at: scopeAt(WS), now: e.clock.now, mergedInto: { id: keeper.id, scopeKey: WS, as: 'merge' } })
    const [merged] = (await detailOf(e, keeper.id, scopeAt(WS))).history.versions
    expect(ok(await e.run({ cmd: 'read-version', memoryId: keeper.id, layer: scopeAt(WS), versionId: merged!.versionId })).version).toMatchObject({ status: 'found', content: '乙一' })
  })

  it('版本标识不合写法：invalid-args；这一条不在：not-found', async () => {
    const { e, m } = await seeded()
    expect(err(await e.run({ cmd: 'read-version', memoryId: m.id, layer: scopeAt(WS), versionId: '../x' })).code).toBe('invalid-args')
    expect(err(await e.run({ cmd: 'read-version', memoryId: 'mem_nowhere', layer: scopeAt(WS), versionId: '20260101T000000000Z' })).code).toBe('not-found')
  })
})

describe('memory-detail：一层链接', () => {
  /**
   * 状态页 page（本项目）：依据全局的 g、相关 peer、取代 old（已被取代）、还挂着一个找不到的 id；
   * fact 相关到它、decision（已删除）依据它、子 agent 待确认的 sub 相关到它。
   */
  async function seeded() {
    const e = env()
    const g = record({ id: 'mem_g', name: '全局约定' })
    await e.store.create(g)
    await e.store.create(ws({ id: 'mem_peer', name: '相关的事' }))
    await e.store.create(ws({ id: 'mem_old', name: '旧状态', status: 'superseded' }))
    const page = ws({ id: 'mem_page', name: '状态页', related: ['mem_peer', 'mem_gone_forever'], premises: [{ id: g.id, digest: premiseDigest(g) }], supersedes: ['mem_old'] })
    await e.store.create(page)
    await e.store.create(ws({ id: 'mem_fact', name: `事实 ${FAKE_SECRET.github}`, related: ['mem_page'] }))
    await e.store.create(ws({ id: 'mem_decision', name: '决定', status: 'deleted', deletedAt: e.clock.now, premises: [{ id: 'mem_page', digest: premiseDigest(page) }] }))
    await e.store.create(ws({ id: 'mem_sub', name: '子任务观察', related: ['mem_page'], delegation: { sessionId: 'sub-1', depth: 1, parentSessionId: 'sess-1' } }))
    return e
  }

  it('出去的依据、相关、取代和进来的相关、依据都列出，邻居带作用域、状态和遮盖过的名称；待确认记录挂的不列', async () => {
    const e = await seeded()
    const { links } = await detailOf(e, 'mem_page', scopeAt(WS))
    expect(links.isComplete).toBe(true)
    expect(links.edges).toEqual([
      { kind: 'premise', direction: 'out', node: { id: 'mem_g', scope: GLOBAL, state: 'active', name: '全局约定' } },
      { kind: 'related', direction: 'out', node: { id: 'mem_peer', scope: scopeAt(WS), state: 'active', name: '相关的事' } },
      { kind: 'related', direction: 'out', node: { id: 'mem_gone_forever', state: 'missing' } },
      { kind: 'supersedes', direction: 'out', node: { id: 'mem_old', scope: scopeAt(WS), state: 'superseded', name: '旧状态' } },
      { kind: 'premise', direction: 'in', node: { id: 'mem_decision', scope: scopeAt(WS), state: 'deleted', name: '决定' } },
      { kind: 'related', direction: 'in', node: { id: 'mem_fact', scope: scopeAt(WS), state: 'active', name: `事实 ${SECRET_MASK}` } },
    ])
  })

  it('进来的取代：被取代的那条看得到取代它的；全局记忆看得到项目里指向它的', async () => {
    const e = await seeded()
    expect((await detailOf(e, 'mem_old', scopeAt(WS))).links.edges.map(edgeKey)).toEqual(['in:supersedes:mem_page'])
    expect((await detailOf(e, 'mem_g', GLOBAL)).links.edges).toEqual([
      { kind: 'premise', direction: 'in', node: { id: 'mem_page', scope: scopeAt(WS), state: 'active', name: '状态页' } },
    ])
  })

  it('中心是子 agent 的待确认记录：它挂出去的不列，指向它的照列', async () => {
    const e = await seeded()
    await e.store.create(ws({ id: 'mem_ask', name: '问它', related: ['mem_sub'] }))
    expect((await detailOf(e, 'mem_sub', scopeAt(WS))).links.edges.map(edgeKey)).toEqual(['in:related:mem_ask'])
  })

  it('同 id 在全局和项目各有一份时，出去的按够得着的作用域里先认在用的那份', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_twin', name: '项目那份', status: 'superseded' }))
    await e.store.create(record({ id: 'mem_twin', name: '全局那份' }))
    await e.store.create(ws({ id: 'mem_center', related: ['mem_twin'] }))
    expect((await detailOf(e, 'mem_center', scopeAt(WS))).links.edges).toEqual([
      { kind: 'related', direction: 'out', node: { id: 'mem_twin', scope: GLOBAL, state: 'active', name: '全局那份' } },
    ])
  })

  it('同 id 在全局和项目各有一份、项目里的来源指向项目那份：只有项目那份画这条进来的线，全局那份不画', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_shared', name: '全局那份' }))
    await e.store.create(ws({ id: 'mem_shared', name: '项目那份' }))
    await e.store.create(ws({ id: 'mem_src', name: '来源', related: ['mem_shared'] }))
    expect((await detailOf(e, 'mem_src', scopeAt(WS))).links.edges).toEqual([
      { kind: 'related', direction: 'out', node: { id: 'mem_shared', scope: scopeAt(WS), state: 'active', name: '项目那份' } },
    ])
    expect((await detailOf(e, 'mem_shared', GLOBAL)).links.edges).toEqual([])
    expect((await detailOf(e, 'mem_shared', scopeAt(WS))).links.edges.map(edgeKey)).toEqual(['in:related:mem_src'])
  })

  it('目录里有文件读不出：链接标成可能不全；指过去找不到的算读不到，不算已不在', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_center', related: ['mem_lost'] }))
    await writeFile(join(root, workspaceDirName(WS), '坏掉的.md'), '---\nid: [没有闭合\n---\n正文\n')
    const { links } = await detailOf(e, 'mem_center', scopeAt(WS))
    expect(links.isComplete).toBe(false)
    expect(links.edges).toEqual([{ kind: 'related', direction: 'out', node: { id: 'mem_lost', state: 'unreadable' } }])
  })

  it('指过去的 id 是手改进去的密钥、找不到：节点给遮盖后的 id', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_center', related: [`mem ${FAKE_SECRET.github}`] }))
    expect((await detailOf(e, 'mem_center', scopeAt(WS))).links.edges).toEqual([
      { kind: 'related', direction: 'out', node: { id: `mem ${SECRET_MASK}`, state: 'missing' } },
    ])
  })

  it('全局记忆的反向查询：有个项目目录缺标记（里面的记忆没读）时标成可能不全', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_g' }))
    await mkdir(join(root, 'stray-dir'), { recursive: true })
    await writeFile(join(root, 'stray-dir', 'x.md'), '---\nid: mem_x\n---\n正文\n')
    expect((await detailOf(e, 'mem_g', GLOBAL)).links.isComplete).toBe(false)
  })

  it('全局目录里有文件读不出：项目记忆指向的 id 找不到时也算读不到', async () => {
    const e = env()
    await e.store.create(ws({ id: 'mem_center', related: ['mem_lost'] }))
    await mkdir(join(root, GLOBAL_DIR), { recursive: true })
    await writeFile(join(root, GLOBAL_DIR, '坏掉的.md'), '---\nid: [没有闭合\n---\n正文\n')
    expect((await detailOf(e, 'mem_center', scopeAt(WS))).links.edges).toEqual([{ kind: 'related', direction: 'out', node: { id: 'mem_lost', state: 'unreadable' } }])
  })
})

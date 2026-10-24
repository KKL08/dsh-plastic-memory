import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileTable } from '../src/storage/file-table.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { createAgentsMdWriter } from '../src/storage/agents-md.ts'
import { STATE_DIR } from '../src/storage/paths.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import { REDACTED_PLACEHOLDER, memorySnapshotSchema, pendingDecisionSchema, scanCacheSchema } from '../src/governance/schema.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { RETENTION_MS } from '../src/retention.ts'
import { ViewWriter, collectGlobalViews } from '../src/gui/view-writer.ts'
import { createMemoryCommand } from '../src/gui/commands.ts'
import {
  GUI_VIEW_DIR, GUI_VIEW_FILES, GUI_VIEW_VERSION, MEMORY_COMMAND_NAME, encodeMemoryCommand, sessionViewFile,
  deletedViewSchema, memoryCommandResultSchema, pendingViewSchema,
  type MemoryCommand, type MemoryCommandResult,
} from '../src/gui/contract.ts'
import { runSavePipeline } from '../src/pipeline.ts'
import { candidate, record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

// /memory 命令处理器：真实临时目录（FileTable + .state 侧表 + 视图文件），只把宿主那一侧
// （借来的会话：workspace、子 agent 深度、模型、基线）换成测试桩。断言账本、记忆文件、快照与视图的终态。

const NOW = 10 * RETENTION_MS
const SESSION_WS = '/tmp/pm-cmd-session'
const OTHER_WS = '/tmp/pm-cmd-other'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-gui-commands-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

interface EnvOpts {
  workspacePath?: string
  delegationDepth?: number
  llm?: SemanticLlm | null
  baseline?: readonly string[] | null
  now?: number
}

function env(opts: EnvOpts = {}) {
  const sidecar = new SidecarStore({ root, schemas: { snapshots: memorySnapshotSchema, pending: pendingDecisionSchema, scanCache: scanCacheSchema } })
  const store = new MemoryStore(new FileTable({ root, stats: sidecar.recallStats }), undefined, sidecar.recallStats)
  const decisions = new PendingDecisionsStore(sidecar.pending)
  const snapshots = new SnapshotStore(sidecar.snapshots)
  const cache = sidecar.scanCache
  const clock = { now: opts.now ?? NOW }
  const views = new ViewWriter({ memoryRoot: root, collect: () => collectGlobalViews({ store, decisions, cache, registry, memoryRoot: root, now: () => clock.now }) })
  const command = createMemoryCommand({
    memoryRoot: root, store, decisions, snapshots, cache, registry, views,
    agentsMd: createAgentsMdWriter(join(root, 'AGENTS.md')),
    resolveContext: async () => ({ workspacePath: 'workspacePath' in opts ? opts.workspacePath : SESSION_WS, delegationDepth: opts.delegationDepth ?? 0, session: { id: 'sess-1' } }),
    getLlm: () => (opts.llm === undefined ? null : opts.llm),
    getBaseline: () => opts.baseline ?? null,
    now: () => clock.now,
  })
  /** 按宿主 parseCommand 的切法：命令名之后的原文（含分隔空白）交给处理器。 */
  const runRaw = async (rawInput: string) => {
    const r = await command.handler({ rawInput, agent: {} })
    expect(typeof r.text).toBe('string')
    const body = memoryCommandResultSchema.parse(JSON.parse(r.text!))
    expect(r.kind).toBe(body.ok ? 'success' : 'error')
    return body
  }
  const run = (c: MemoryCommand) => runRaw(encodeMemoryCommand(c).slice(`/${MEMORY_COMMAND_NAME}`.length))
  const readView = async (name: keyof typeof GUI_VIEW_FILES) => JSON.parse(await readFile(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES[name]), 'utf8')) as unknown
  return { store, decisions, snapshots, cache, command, run, runRaw, readView, clock }
}

type Ok = Extract<MemoryCommandResult, { ok: true }>
type Err = Extract<MemoryCommandResult, { ok: false }>
const ok = (r: MemoryCommandResult): Ok => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Ok }
const err = (r: MemoryCommandResult): Err => { expect(r.ok, JSON.stringify(r)).toBe(false); return r as Err }

async function seedPair(e: ReturnType<typeof env>, ws?: string) {
  const scoped = ws === undefined ? {} : { scope: 'workspace' as const, workspacePath: ws }
  await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm', ...scoped }))
  await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm', ...scoped }))
  return (await e.decisions.upsert({ memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', fingerprint: 'fp-ab' }, 1)).entry
}

async function seedVertical(e: ReturnType<typeof env>) {
  await e.store.create(record({ id: 'mem_v', name: '丙', content: '用 yarn' }))
  return (await e.decisions.upsert({ memoryIds: ['mem_v'], baselineRef: 'AGENTS.md：包管理', summary: '与基线矛盾', fingerprint: 'fp-v' }, 1)).entry
}

const allEntries = async (e: ReturnType<typeof env>) => [...await e.decisions.list(), ...await e.decisions.listSettled()]

describe('info', () => {
  it('返回 memoryRoot、视图文件绝对路径与契约版本；只建视图目录，不写视图文件（宿主的文件观察不跟踪父目录尚不存在的文件，客户端订阅前目录要先在）', async () => {
    const e = env()
    const body = ok(await e.run({ cmd: 'info' }))
    const dir = join(root, GUI_VIEW_DIR)
    expect(body.info).toEqual({
      memoryRoot: root,
      viewDir: dir,
      views: {
        pending: join(dir, GUI_VIEW_FILES.pending), health: join(dir, GUI_VIEW_FILES.health),
        library: join(dir, GUI_VIEW_FILES.library), deleted: join(dir, GUI_VIEW_FILES.deleted),
        session: join(dir, sessionViewFile('sess-1')),
      },
      version: GUI_VIEW_VERSION,
    })
    expect((await stat(dir)).isDirectory()).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('参数解析', () => {
  it.each([
    ['未知子命令', ' nope'],
    ['空输入', ''],
    ['参数不是 JSON', ' resolve {decisionId'],
    ['参数不是对象', ' resolve [1]'],
    ['缺必填字段', ' resolve {"decisionId":"pd_x"}'],
    ['verdict 取值非法', ' resolve {"decisionId":"pd_x","verdict":"dismiss"}'],
  ])('%s → invalid-args，账本与视图不动', async (_label, raw) => {
    const e = env()
    const entry = await seedPair(e)
    const body = err(await e.runRaw(raw))
    expect(body.code).toBe('invalid-args')
    expect(await e.decisions.list()).toEqual([entry])
    await expect(stat(join(root, GUI_VIEW_DIR))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('不存在的条目 → not-found', async () => {
    const e = env()
    expect(err(await e.run({ cmd: 'resolve', decisionId: 'pd_ghost', verdict: 'keep-left' })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'undo', decisionId: 'pd_ghost' })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_ghost' })).code).toBe('not-found')
    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_ghost' })).code).toBe('not-found')
  })

  it('借的会话是子 agent：写命令一律 subagent-readonly，账本不动', async () => {
    const e = env({ delegationDepth: 1 })
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' })).code).toBe('subagent-readonly')
    expect(await e.decisions.list()).toEqual([entry])
    expect((await e.store.get('mem_b'))!.status).toBe('active')
  })
})

describe('resolve 与 undo', () => {
  it('横向 keep-left：删 B、快照先行、条目 settled；视图重写；undo 后 B 回来、冲突回到待处理且只有一条', async () => {
    const e = env()
    const entry = await seedPair(e)

    const resolved = ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect(resolved.decisionId).toBe(entry.id)
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    const [snap] = await e.snapshots.list()
    expect(snap!.memoryIds).toEqual(['mem_b'])
    expect(resolved.snapshotId).toBe(snap!.id)
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict, d.settled?.snapshotId])).toEqual([[entry.id, 'keep-left', snap!.id]])
    expect(pendingViewSchema.parse(await e.readView('pending')).items).toEqual([])
    const deleted = deletedViewSchema.parse(await e.readView('deleted'))
    expect(deleted.items.map(i => [i.memory.id, i.cause?.decisionId])).toEqual([['mem_b', entry.id]])

    const undone = ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect(undone.memoryIds).toEqual(['mem_b'])
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    const pending = pendingViewSchema.parse(await e.readView('pending'))
    expect(pending.items.map(i => [i.kind, 'decisionId' in i ? i.decisionId : undefined])).toEqual([['conflict-horizontal', entry.id]])
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

  it('垂直 keep-right（以基线为准）：删记忆；undo 后记忆回来、冲突回到待处理', async () => {
    const e = env()
    const entry = await seedVertical(e)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' }))
    expect((await e.store.get('mem_v'))!.status).toBe('deleted')

    ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect((await e.store.get('mem_v'))!.status).toBe('active')
    expect((await allEntries(e)).map(d => [d.id, d.settled])).toEqual([[entry.id, undefined]])
  })

  it('keep-both：两条都留、条目 settled；undo 只去掉 settled，记忆不动、不碰快照', async () => {
    const e = env()
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-both' }))
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['keep-both'])

    const undone = ok(await e.run({ cmd: 'undo', decisionId: entry.id }))
    expect(undone.memoryIds ?? []).toEqual([])
    expect((await e.decisions.list()).map(d => d.id)).toEqual([entry.id])
    expect((await e.store.get('mem_a'))!.status).toBe('active')
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect(await e.snapshots.list()).toEqual([])
  })

  it('undo 一条未裁决的条目 → not-found', async () => {
    const e = env()
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('not-found')
  })
})

describe('restore', () => {
  it('从最近删除恢复被裁决删掉的那条：记忆回来、冲突回到待处理，再被扫到也不多出第二条', async () => {
    const e = env()
    const entry = await seedPair(e)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-right' }))
    expect((await e.store.get('mem_a'))!.status).toBe('deleted')

    const restored = ok(await e.run({ cmd: 'restore', memoryId: 'mem_a' }))
    expect(restored.memoryIds).toEqual(['mem_a'])
    expect(restored.decisionId).toBe(entry.id)
    expect((await e.store.get('mem_a'))!.status).toBe('active')
    expect((await allEntries(e)).map(d => [d.id, d.settled])).toEqual([[entry.id, undefined]])

    // 下次体检同一对再报：沿用原条目，不新建
    const again = await e.decisions.upsert({ memoryIds: ['mem_b', 'mem_a'], summary: '再报', fingerprint: 'fp-ab' }, 2)
    expect(again.created).toBe(false)
    expect((await allEntries(e)).map(d => d.id)).toEqual([entry.id])
  })

  it('forget 删掉的记忆：restore 按快照恢复，与冲突无关', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_f', name: '丁' }))
    const forgot = ok(await e.run({ cmd: 'forget', memoryId: 'mem_f' }))
    expect(forgot.memoryIds).toEqual(['mem_f'])
    expect((await e.store.get('mem_f'))!.status).toBe('deleted')
    const [snap] = await e.snapshots.list()
    expect(forgot.snapshotId).toBe(snap!.id)
    expect(deletedViewSchema.parse(await e.readView('deleted')).items.map(i => i.memory.id)).toEqual(['mem_f'])

    ok(await e.run({ cmd: 'restore', memoryId: 'mem_f' }))
    expect((await e.store.get('mem_f'))!.status).toBe('active')
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

  it('还活着的记忆 restore → not-found', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_live' }))
    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_live' })).code).toBe('not-found')
  })
})

describe('跨项目', () => {
  it('resolve 涉及其他项目且缺 allowCrossWorkspace：cross-workspace，账本与文件不动；带上参数才执行', async () => {
    const e = env()
    const entry = await seedPair(e, OTHER_WS)
    const body = err(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left' }))
    expect(body.code).toBe('cross-workspace')
    expect(body.rejected).toEqual([{ id: 'mem_a', workspacePath: OTHER_WS }, { id: 'mem_b', workspacePath: OTHER_WS }])
    expect(await e.decisions.list()).toEqual([entry])
    expect(await e.decisions.listSettled()).toEqual([])
    expect((await e.store.get('mem_b'))!.status).toBe('active')
    expect(await e.snapshots.list()).toEqual([])

    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }))
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
  })

  it('undo / forget 同样把关', async () => {
    const e = env()
    const entry = await seedPair(e, OTHER_WS)
    ok(await e.run({ cmd: 'resolve', decisionId: entry.id, verdict: 'keep-left', allowCrossWorkspace: true }))
    expect(err(await e.run({ cmd: 'undo', decisionId: entry.id })).code).toBe('cross-workspace')
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([entry.id])
    expect((await e.store.get('mem_b'))!.status).toBe('deleted')
    expect(err(await e.run({ cmd: 'forget', memoryId: 'mem_a' })).code).toBe('cross-workspace')
    expect((await e.store.get('mem_a'))!.status).toBe('active')
  })
})

describe('hard-delete', () => {
  it('含密钥的记忆物理删除：文件没了、不进最近删除', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_s', content: `token ${FAKE_SECRET.sk}` }))
    const body = ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_s' }))
    expect(body.memoryIds).toEqual(['mem_s'])
    expect(await e.store.get('mem_s')).toBeUndefined()
    expect(deletedViewSchema.parse(await e.readView('deleted')).items).toEqual([])
  })

  it('既有快照里这条记忆的副本一律换成脱敏占位（不可恢复），同快照的其他记录不动；盘上不留明文', async () => {
    const e = env()
    const secret = record({ id: 'mem_s', name: '部署凭证', content: `token ${FAKE_SECRET.sk}` })
    const other = record({ id: 'mem_o', name: '旁人', content: '用 pnpm' })
    await e.store.create(secret)
    await e.store.create(other)
    const both = await e.snapshots.capture({ operation: 'manual', description: '两条', records: [secret, other] }, NOW - 3)
    const alone = await e.snapshots.capture({ operation: 'pre-update', description: '只有它', records: [secret] }, NOW - 2)
    const unrelated = await e.snapshots.capture({ operation: 'manual', description: '无关', records: [other] }, NOW - 1)

    ok(await e.run({ cmd: 'hard-delete', memoryId: 'mem_s' }))
    const byId = new Map((await e.snapshots.list()).map(s => [s.id, s]))
    for (const id of [both.id, alone.id]) {
      const copy = byId.get(id)!.data.find(r => r.id === 'mem_s')!
      expect(copy).toMatchObject({ redacted: true, content: REDACTED_PLACEHOLDER })
    }
    expect(byId.get(both.id)!.data.find(r => r.id === 'mem_o')).toEqual(other)
    expect(byId.get(unrelated.id)!.data).toEqual([other])
    // 删除前那份 pre-forget 快照也只存脱敏副本
    const preForget = [...byId.values()].find(s => s.operation === 'pre-forget')!
    expect(preForget.data).toEqual([expect.objectContaining({ id: 'mem_s', redacted: true, content: REDACTED_PLACEHOLDER })])
    const snapDir = join(root, STATE_DIR, 'snapshots')
    for (const file of await readdir(snapDir)) expect(await readFile(join(snapDir, file), 'utf8')).not.toContain(FAKE_SECRET.sk)
    // 不能从快照恢复回来
    expect(err(await e.run({ cmd: 'restore', memoryId: 'mem_s' })).code).toBe('not-found')
  })

  it('不含密钥的记忆不走硬删：failed，什么都不动', async () => {
    const e = env()
    await e.store.create(record({ id: 'mem_plain' }))
    expect(err(await e.run({ cmd: 'hard-delete', memoryId: 'mem_plain' })).code).toBe('failed')
    expect((await e.store.get('mem_plain'))!.status).toBe('active')
  })
})

describe('提升候选与超限', () => {
  const quietLlm: SemanticLlm = { complete: async () => '{"findings":[]}' }

  /** 真实路径：模型以 scope: global 保存 → 管线降级为本项目 + globalCandidate → 体检把它挂进账本 → 待处理视图里出现。 */
  async function seedCandidate(e: ReturnType<typeof env>) {
    const saved = await runSavePipeline(candidate({ name: '戊', content: '所有项目都用 vitest', summary: '都用 vitest' }), {
      store: e.store, registry, workspacePath: SESSION_WS, session: { id: 'sess-1', lastSeq: 1 },
    })
    if (saved.kind !== 'saved') throw new Error(saved.kind)
    expect([saved.record.scope, saved.record.workspacePath, saved.record.globalCandidate]).toEqual(['workspace', SESSION_WS, true])
    ok(await e.run({ cmd: 'scan' }))
    const items = pendingViewSchema.parse(await e.readView('pending')).items.filter(i => i.kind === 'promote-candidate')
    expect(items.map(i => i.kind === 'promote-candidate' && i.memory?.id)).toEqual([saved.record.id])
    return { decisionId: (items[0] as { decisionId: string }).decisionId, memoryId: saved.record.id }
  }
  const pendingCandidates = async (e: ReturnType<typeof env>) =>
    pendingViewSchema.parse(await e.readView('pending')).items.filter(i => i.kind === 'promote-candidate')

  it('promote 到全局：记忆变 global、条目 settled 为 promoted 并带快照、待处理里消失；undo 后回到本项目、候选回到待处理', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId, memoryId } = await seedCandidate(e)
    const body = ok(await e.run({ cmd: 'promote', decisionId, target: 'global' }))
    expect(body.memoryIds).toEqual([memoryId])
    expect((await e.store.get(memoryId))!.scope).toBe('global')
    const [snap] = await e.snapshots.list()
    expect((await e.decisions.listSettled()).map(d => d.settled)).toEqual([{ verdict: 'promoted', at: NOW, snapshotId: snap!.id }])
    expect(await pendingCandidates(e)).toEqual([])

    // 提升后再体检：已提升的不再挂候选
    ok(await e.run({ cmd: 'scan' }))
    expect(await pendingCandidates(e)).toEqual([])

    ok(await e.run({ cmd: 'undo', decisionId }))
    const back = (await e.store.get(memoryId))!
    expect([back.scope, back.workspacePath, back.globalCandidate]).toEqual(['workspace', SESSION_WS, true])
    expect((await e.decisions.list()).map(d => d.id)).toEqual([decisionId])
    expect((await pendingCandidates(e)).map(i => 'decisionId' in i && i.decisionId)).toEqual([decisionId])
  })

  it('promote 写进 AGENTS.md：条目移出账本（插件不再管理，不可撤销）', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId } = await seedCandidate(e)
    ok(await e.run({ cmd: 'promote', decisionId, target: 'agents-md' }))
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toContain('戊')
    expect(await allEntries(e)).toEqual([])
    expect(await pendingCandidates(e)).toEqual([])
  })

  it('keep-local：清候选标记、条目 settled 为 keep-local；再体检不重开，内容改了（模型又标为全局）才重新提示', async () => {
    const e = env({ llm: quietLlm })
    const { decisionId, memoryId } = await seedCandidate(e)
    ok(await e.run({ cmd: 'keep-local', decisionId }))
    expect((await e.store.get(memoryId))!.globalCandidate).toBeUndefined()
    expect((await e.decisions.listSettled()).map(d => d.settled?.verdict)).toEqual(['keep-local'])
    expect(await pendingCandidates(e)).toEqual([])

    ok(await e.run({ cmd: 'scan' }))
    expect(await pendingCandidates(e)).toEqual([])
    expect((await e.decisions.listSettled()).map(d => d.id)).toEqual([decisionId])

    const updated = await runSavePipeline(candidate({ action: 'update', id: memoryId, name: '戊', content: '所有项目都用 vitest，覆盖率不设门槛', summary: '都用 vitest' }), {
      store: e.store, registry, workspacePath: SESSION_WS, session: { id: 'sess-1', lastSeq: 2 },
    })
    expect(updated.kind).toBe('updated')
    expect((await e.store.get(memoryId))!.globalCandidate).toBe(true)
    ok(await e.run({ cmd: 'scan' }))
    expect((await pendingCandidates(e)).map(i => i.kind === 'promote-candidate' && i.memory?.id)).toEqual([memoryId])
  })

  it('promote / keep-local 指向冲突条目 → failed，条目不动', async () => {
    const e = env()
    const entry = await seedPair(e)
    expect(err(await e.run({ cmd: 'promote', decisionId: entry.id, target: 'global' })).code).toBe('failed')
    expect(err(await e.run({ cmd: 'keep-local', decisionId: entry.id })).code).toBe('failed')
    expect(await e.decisions.list()).toEqual([entry])
  })

  it('dismiss-overflow：超限提醒标 settled（dismiss）', async () => {
    const e = env()
    const { entry } = await e.decisions.upsert({ kind: 'overflow', memoryIds: [], summary: '超出上限', fingerprint: '1' }, 1)
    ok(await e.run({ cmd: 'dismiss-overflow', decisionId: entry.id }))
    expect((await e.decisions.listSettled()).map(d => [d.id, d.settled?.verdict])).toEqual([[entry.id, 'dismiss']])
  })
})

describe('scan', () => {
  const conflictLlm: SemanticLlm = {
    complete: async () => JSON.stringify({ findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '包管理器矛盾', suggestedAction: '裁决' }] }),
  }

  it('拿不到模型：llm-unavailable，不扫描、不写缓存', async () => {
    const e = env({ llm: null })
    await seedPair(e)
    expect(err(await e.run({ cmd: 'scan' })).code).toBe('llm-unavailable')
    expect(await e.cache.list()).toEqual([])
  })

  it('全库体检：冲突进账本、视图重写', async () => {
    const e = env({ llm: conflictLlm })
    await e.store.create(record({ id: 'mem_a', name: '甲', content: '用 pnpm' }))
    await e.store.create(record({ id: 'mem_b', name: '乙', content: '用 npm' }))
    ok(await e.run({ cmd: 'scan' }))
    const [entry] = await e.decisions.list()
    expect(entry!.memoryIds).toEqual(['mem_a', 'mem_b'])
    const pending = pendingViewSchema.parse(await e.readView('pending'))
    expect(pending.items.map(i => i.kind)).toEqual(['conflict-horizontal'])
    await expect(stat(join(root, GUI_VIEW_DIR, GUI_VIEW_FILES.health))).resolves.toBeTruthy()
  })

  it('借的会话不属于页面项目：结果带回 baseline-session-scoped', async () => {
    const e = env({ llm: { complete: async () => '{"findings":[]}' }, baseline: ['用 pnpm'] })
    await e.store.create(record({ id: 'mem_w', scope: 'workspace', workspacePath: OTHER_WS }))
    const body = ok(await e.run({ cmd: 'scan', workspacePath: OTHER_WS }))
    expect(body.notes).toContain('baseline-session-scoped')
  })
})

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
})

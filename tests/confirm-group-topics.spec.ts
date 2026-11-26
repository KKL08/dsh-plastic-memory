import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeConfirm, GROUP_ACCEPT_TEXT, type ConfirmResult, type ConfirmToolDeps, type GroupAcceptItem, type GroupAcceptResult } from '../src/tools/confirm.ts'
import { runCreateGate } from '../src/create-gate.ts'
import { MemoryStore } from '../src/store.ts'
import { FileTable } from '../src/storage/file-table.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { readIndexFiles } from '../src/storage/index-store.ts'
import { GLOBAL_DIR, WORKSPACE_MARKER, workspaceDirName } from '../src/storage/paths.ts'
import type { RecallStats } from '../src/storage/schema.ts'
import { readIndex, UNSORTED_TITLE } from '../src/topic-index.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot, PendingDecision } from '../src/governance/schema.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { noInstructions } from './helpers/instructions.ts'
import { breakTopicIndex, writeTopicIndex } from './helpers/topic-fixture.ts'

// 成组接受的分组和重叠：真实临时目录上的文件表，主题索引像用户手改那样直接写文件。
// 一条记录的组 = 它最相近的在用记忆（去掉这一批和其余待确认记录后检索排第一的）所在的主题；没有候选或那条在「未整理」归「未整理」。
// 组内两两比近重复；和在用记忆的重叠按新建闸同一套判法。分组只读，不写索引；接受后的记录照常进「未整理」。

const T0 = 1_700_000_000_000
const WS = '/tmp/pm-group-topics-project'
const DELEGATION = { sessionId: 'sess-child', depth: 1, parentSessionId: 'sess-main', rootSessionId: 'sess-main' }

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-group-topics-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const globalDir = () => join(root, GLOBAL_DIR)
const wsDir = () => join(root, workspaceDirName(WS))

function makeDeps(): ConfirmToolDeps {
  const stats = new InMemoryBatchKvTable<RecallStats>()
  return {
    instructions: noInstructions,
    store: new MemoryStore(new FileTable({ root, stats, now: () => T0 }), undefined, stats),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
    now: () => T0,
  }
}

const base = { type: 'knowledge', createdAt: T0 - 10, updatedAt: T0 - 10, lastConfirmedAt: T0 - 10 } as const
const settled = (id: string, scope: 'workspace' | 'global', name: string, summary: string, content: string) =>
  record({ ...base, id, scope, ...(scope === 'workspace' ? { workspacePath: WS } : {}), name, summary, content })
const pending = (id: string, name: string, summary: string, content: string) =>
  record({
    ...base, id, scope: 'workspace', workspacePath: WS, name, summary, content, delegation: DELEGATION,
    source: { sessionId: 'sess-child', eventRange: [4, 9], sourceMode: 'environment-observed' },
  })

// 四组词互不相交：部署（项目主题）、测试（项目主题）、看板（项目「未整理」）、代码检查（全局主题）；另有一组谁都不像
const W_DEPLOY = settled('w_deploy', 'workspace', 'Ansible rollout', 'ansible playbook rollout', 'ansible playbook rollout canary hosts first then fleet')
const W_TEST = settled('w_test', 'workspace', 'Vitest fixtures', 'vitest fixture snapshot policy', 'vitest fixture snapshot files live beside specs and never mock modules')
const W_MISC = settled('w_misc', 'workspace', 'Grafana panels', 'grafana dashboard panels', 'grafana dashboard panels track latency percentiles')
const G_LINT = settled('g_lint', 'global', 'Oxlint rules', 'oxlint rule set', 'oxlint correctness rules block unused vars')

const P_DEPLOY1 = pending('p_deploy1', 'Canary observation', 'canary hosts rollout observed', 'observed ansible canary hosts rollout succeeded before fleet wave')
const P_DEPLOY2 = pending('p_deploy2', 'Canary observation again', 'canary hosts rollout observed', 'observed ansible canary hosts rollout succeeded before fleet waves')
const P_TEST = pending('p_test', 'Vitest fixture note', 'vitest fixture snapshot policy', 'vitest fixture snapshot files live beside specs and never mock module')
const P_MISC = pending('p_misc', 'Dashboard latency', 'latency panel observed', 'observed grafana latency percentiles spike nightly')
const P_LINT = pending('p_lint', 'Oxlint warning', 'oxlint unused vars observed', 'observed oxlint flags unused vars in scripts')
const P_LONELY = pending('p_lonely', 'Quokka sighting', 'quokka island', 'quokka marsupial island sighting recorded')
/** 不在这一批里的待确认记录，和 p_lonely 几乎一样：不能拿它定主题，也不能列成重叠。 */
const P_OTHER = pending('p_other', 'Quokka sighting', 'quokka island', 'quokka marsupial island sighting recorded twice')

const BATCH = ['p_test', 'p_deploy1', 'p_lonely', 'p_lint', 'p_deploy2', 'p_misc'] as const

async function seed(records: readonly MemoryRecord[]) {
  await mkdir(globalDir(), { recursive: true })
  await mkdir(wsDir(), { recursive: true })
  await writeFile(join(wsDir(), WORKSPACE_MARKER), WS, 'utf8')
  for (const r of records) await writeFile(join(r.scope === 'global' ? globalDir() : wsDir(), `${r.id}.md`), encodeRecord(r, {}), 'utf8')
}

async function standard() {
  await seed([W_DEPLOY, W_TEST, W_MISC, G_LINT, P_DEPLOY1, P_DEPLOY2, P_TEST, P_MISC, P_LINT, P_LONELY, P_OTHER])
  await writeTopicIndex(wsDir(), [{ name: '部署流程', members: ['w_deploy'] }, { name: '测试约定', members: ['w_test'] }], ['w_misc'])
  await writeTopicIndex(globalDir(), [{ name: '代码风格', members: ['g_lint'] }])
}

const accept = (deps: ConfirmToolDeps, memoryIds: readonly string[]) =>
  executeConfirm({ action: 'accept-subagent', memoryIds }, { workspacePath: WS }, deps)
function asGroup(r: ConfirmResult): GroupAcceptResult {
  if (r.kind !== 'group-accepted') throw new Error(`不是成组接受的结果：${JSON.stringify(r)}`)
  return r
}
const itemOf = (r: GroupAcceptResult, id: string): GroupAcceptItem => {
  const found = r.groups.flatMap(g => g.items).find(i => i.memoryId === id)
  if (found === undefined) throw new Error(`结果里没有 ${id}`)
  return found
}

/** 一个目录的主题索引：各主题的成员 id 和「未整理」。 */
async function indexOf(dir: string) {
  const files = await readIndexFiles(dir)
  if (files === undefined) return undefined
  const { topics, unsorted } = readIndex(files)
  return { topics: topics.map(t => ({ name: t.name, members: t.memberIds })), unsorted }
}

describe('按主题分组', () => {
  it('组取最相近的在用记忆所在的主题：全局主题单独成组、带作用域；没有候选或那条在「未整理」的归「未整理」；组按第一条在批内的先后，「未整理」最后', async () => {
    await standard()
    const r = asGroup(await accept(makeDeps(), BATCH))
    expect(r.acceptedIds).toEqual([...BATCH])
    expect(r.grouping).toBe('topics')
    expect(r.groups.map(g => ({ kind: g.kind, scope: g.scope, ids: g.items.map(i => i.memoryId) }))).toEqual([
      { kind: 'topic', scope: 'workspace', ids: ['p_test'] },
      { kind: 'topic', scope: 'workspace', ids: ['p_deploy1', 'p_deploy2'] },
      { kind: 'topic', scope: 'global', ids: ['p_lint'] },
      { kind: 'unsorted', scope: undefined, ids: ['p_lonely', 'p_misc'] },
    ])
    expect(r.groups.map(g => g.title)).toEqual(['测试约定', '部署流程', `代码风格${GROUP_ACCEPT_TEXT.globalMark}`, UNSORTED_TITLE])
    expect(new Set(r.groups.map(g => g.key)).size).toBe(r.groups.length)
    expect(r.groups.find(g => g.kind === 'unsorted')!.key).toBe('unsorted')
    // 每组一个标题行，按组的先后出现在结果文字里（分组说明那句里也提到「未整理」，先去掉）
    const body = r.message.replace(GROUP_ACCEPT_TEXT.groupingNote, '')
    const positions = r.groups.map(g => body.indexOf(g.title))
    expect(positions.every(p => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(r.message).toContain(GROUP_ACCEPT_TEXT.groupingNote)
    expect(r.message.trimEnd().endsWith(GROUP_ACCEPT_TEXT.mergeGuide)).toBe(true)
  })

  it('组内两两比较近重复，成对标出；不同组之间、和组外的待确认记录之间不比', async () => {
    await standard()
    const r = asGroup(await accept(makeDeps(), BATCH))
    const pairsOf = (id: string) => r.groups.find(g => g.items.some(i => i.memoryId === id))!.nearDuplicatePairs
    expect(pairsOf('p_deploy1')).toEqual([['p_deploy1', 'p_deploy2']])
    expect(pairsOf('p_lonely')).toEqual([])
    expect(r.groups.flatMap(g => g.nearDuplicatePairs)).toEqual([['p_deploy1', 'p_deploy2']])
    const pairLine = r.message.split('\n').find(l => l.includes(GROUP_ACCEPT_TEXT.pairs))
    expect(pairLine).toContain('p_deploy1')
    expect(pairLine).toContain('p_deploy2')
  })

  it('和在用记忆的重叠：近乎重复的单独标出、不再列进相近；只和在用的主档比，不和这一批、也不和组外的待确认记录比', async () => {
    await standard()
    const r = asGroup(await accept(makeDeps(), BATCH))
    expect(itemOf(r, 'p_test').overlap?.duplicateOf?.id).toBe('w_test')
    expect(itemOf(r, 'p_test').overlap?.similar.map(s => s.id)).not.toContain('w_test')
    expect(itemOf(r, 'p_deploy1').overlap).toEqual({ similar: [expect.objectContaining({ id: 'w_deploy', name: 'Ansible rollout' })] })
    expect(itemOf(r, 'p_misc').overlap).toEqual({ similar: [expect.objectContaining({ id: 'w_misc' })] })
    expect(itemOf(r, 'p_lint').overlap).toEqual({ similar: [expect.objectContaining({ id: 'g_lint', scope: 'global' })] })
    expect(itemOf(r, 'p_lonely').overlap).toEqual({ similar: [] })
    const testLines = r.message.split('\n').filter(l => l.includes(GROUP_ACCEPT_TEXT.duplicateOf))
    expect(testLines.some(l => l.includes('w_test'))).toBe(true)
  })

  it('和在用记忆的重叠与新建闸同一个判法：对每一条，等于新建闸拿它的名称、摘要、正文，排除这一批和其余待确认记录时的判重和相近列表', async () => {
    await standard()
    const deps = makeDeps()
    const r = asGroup(await accept(deps, BATCH))
    const excludeIds = new Set<string>([...BATCH, 'p_other'])
    for (const p of [P_TEST, P_DEPLOY1, P_DEPLOY2, P_MISC, P_LINT, P_LONELY]) {
      const input = { name: p.name, summary: p.summary, content: p.content, workspacePath: WS, excludeIds }
      const gated = await runCreateGate({ ...input, skipDuplicate: false }, { store: deps.store, now: () => T0 })
      const listed = await runCreateGate({ ...input, skipDuplicate: true }, { store: deps.store, now: () => T0 })
      if (listed.kind !== 'pass') throw new Error('列相近时不判重，应当总是通过')
      const duplicateOf = gated.kind === 'duplicate' ? gated.existing : undefined
      expect(itemOf(r, p.id).overlap, p.id).toEqual({
        ...(duplicateOf !== undefined ? { duplicateOf } : {}),
        similar: listed.similar.filter(s => s.id !== duplicateOf?.id),
      })
    }
  })

  it('分组只读：主题索引里的主题和成员不变；接受前这批不在索引里，接受后进「未整理」', async () => {
    await standard()
    const before = await indexOf(wsDir())
    expect(before).toEqual({ topics: [{ name: '部署流程', members: ['w_deploy'] }, { name: '测试约定', members: ['w_test'] }], unsorted: ['w_misc'] })
    const globalBefore = await indexOf(globalDir())
    const r = asGroup(await accept(makeDeps(), BATCH))
    expect(r.acceptedIds).toEqual([...BATCH])
    const after = await indexOf(wsDir())
    expect(after!.topics).toEqual(before!.topics)
    expect([...after!.unsorted].sort()).toEqual(['w_misc', ...BATCH].sort())
    expect(after!.unsorted).not.toContain('p_other')
    expect(await indexOf(globalDir())).toEqual(globalBefore)
  })
})

describe('分组数据读不到', () => {
  it('最相近的那条所在作用域的主题索引读不出：退回逐条列出、写「分组数据读不到」，重叠照样标出，接受照常', async () => {
    await standard()
    await breakTopicIndex(wsDir())
    const r = asGroup(await accept(makeDeps(), ['p_deploy1', 'p_test', 'p_deploy2']))
    expect(r.acceptedIds).toEqual(['p_deploy1', 'p_test', 'p_deploy2'])
    expect(r.grouping).toBe('unreadable')
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]).toMatchObject({ key: 'flat', kind: 'flat', title: GROUP_ACCEPT_TEXT.unreadable, nearDuplicatePairs: [['p_deploy1', 'p_deploy2']] })
    expect(r.groups[0]!.items.map(i => i.memoryId)).toEqual(['p_deploy1', 'p_test', 'p_deploy2'])
    expect(itemOf(r, 'p_test').overlap?.duplicateOf?.id).toBe('w_test')
    expect(r.message).toContain(GROUP_ACCEPT_TEXT.unreadable)
    expect(r.message).not.toContain(GROUP_ACCEPT_TEXT.groupingNote)
  })

  it('读不出的是用不上的那一层（全局索引坏了，这批最相近的都在项目里）：照常按主题分组', async () => {
    await standard()
    await breakTopicIndex(globalDir())
    const r = asGroup(await accept(makeDeps(), ['p_deploy1', 'p_test']))
    expect(r.grouping).toBe('topics')
    expect(r.groups.map(g => [g.title, g.items.map(i => i.memoryId)])).toEqual([['部署流程', ['p_deploy1']], ['测试约定', ['p_test']]])
  })
})

import { describe, expect, it } from 'vitest'
import { runSavePipeline } from '../src/pipeline.ts'
import { renderSaveResult } from '../src/tools/save.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'
import { candidate, record } from './helpers/record.ts'
import { runCreateGate } from '../src/create-gate.ts'
import { charSimilarity, normalizeForDuplicate } from '../src/text.ts'
import { findMemoryCandidates } from '../src/search/memory-candidates.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'

const NOW = 1_700_000_000_000
function setup() {
  const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
  return { store, registry: buildTypeRegistry({ template: 'coding', customTypes: {} }), workspacePath: '/proj', session: { id: 's1', lastSeq: 42 }, snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()), now: () => NOW }
}

describe('新建闸', () => {
  it('跨类型的逐字重复被拦并给出单条记忆和三条路', async () => {
    const deps = setup()
    await deps.store.create(record({ id: 'mem_existing', type: 'knowledge', content: '开发服务器端口是 3000，启动前检查日志。', summary: '开发端口' }))
    const result = await runSavePipeline(candidate({ content: '开发服务器端口是 3000，启动前检查日志。', summary: '开发端口' }), deps)
    expect(result).toMatchObject({ kind: 'duplicate-suspected', existing: { id: 'mem_existing' } })
    const shown = renderSaveResult(result)
    for (const word of ['mem_existing', 'corroborate', 'update', 'force: true', 'state-change']) expect(shown).toContain(word)
    expect((await deps.store.query({ scope: { kind: 'visible', workspacePath: '/proj' } })).length).toBe(1)
  })
})


const gateInput = { name: '部署记录', content: '部署记录', summary: '部署摘要', workspacePath: '/proj', skipDuplicate: false, excludeIds: new Set<string>() }
const delegated = (sessionId: string) => ({ sessionId, parentSessionId: 'parent', depth: 1 })

describe('新建近邻', () => {
  it('换了说法照常保存并列出相关记忆的名称摘要和标识', async () => {
    const deps = setup()
    const content = 'Redis 的备份由部署脚本执行，每天凌晨运行。'
    const next = '部署时需要检查 Redis 的连接状态，缓存失效后从数据库重新加载。'
    await deps.store.create(record({ id: 'mem_redis', name: 'Redis 备份', content, summary: 'Redis 运维' }))
    expect(charSimilarity(normalizeForDuplicate(content), normalizeForDuplicate(next))).toBeLessThan(0.8)
    const result = await runSavePipeline(candidate({ content: next, summary: 'Redis 部署检查' }), deps)
    expect(result).toMatchObject({ kind: 'saved', similar: expect.arrayContaining([expect.objectContaining({ id: 'mem_redis', name: 'Redis 备份', summary: 'Redis 运维' })]) })
  })

  it('仅有空白和全角半角标点差别的新建仍被拦下', async () => {
    const deps = setup()
    await deps.store.create(record({ id: 'mem_spacing', content: 'Redis 配置：port=3000。', summary: '配置检查' }))
    const result = await runSavePipeline(candidate({ content: 'Redis\n配置: port=3000.', summary: '配置 检查' }), deps)
    expect(result).toMatchObject({ kind: 'duplicate-suspected', existing: { id: 'mem_spacing' } })
  })

  it('只改端口值的新建被拦并说明状态变化的更新方式', async () => {
    const deps = setup()
    await deps.store.create(record({ content: '开发服务器端口是 3000，启动前需要检查日志。', summary: '开发服务器端口' }))
    const result = await runSavePipeline(candidate({ content: '开发服务器端口是 3001，启动前需要检查日志。', summary: '开发服务器端口' }), deps)
    expect(result.kind).toBe('duplicate-suspected')
    expect(renderSaveResult(result)).toContain('state-change')
  })

  it('主体只有一字不同会被拦而确认后原样存下并列出被跳过的记忆', async () => {
    const deps = setup()
    await deps.store.create(record({ id: 'mem_service', content: '服务 A 的日志每天凌晨轮转，故障时保留最近七天日志。', summary: '服务日志轮转' }))
    const input = candidate({ content: '服务 B 的日志每天凌晨轮转，故障时保留最近七天日志。', summary: '服务日志轮转' })
    expect((await runSavePipeline(input, deps)).kind).toBe('duplicate-suspected')
    const result = await runSavePipeline({ ...input, force: true }, deps)
    expect(result).toMatchObject({ kind: 'saved', record: { content: input.content, summary: input.summary }, similar: expect.arrayContaining([expect.objectContaining({ id: 'mem_service' })]) })
  })

  it('相近列表跨类型且按检索名次取前五条', async () => {
    const deps = setup()
    const tokens = ['deploy.sh', 'backup.sh', 'restore.sh', 'launch.sh', 'stop.sh', 'check.sh', 'clean.sh']
    for (const [i, token] of tokens.entries()) await deps.store.create(record({ id: `mem_${i}`, type: i % 2 ? 'preference' : 'knowledge', content: token, summary: `脚本步骤 ${i}` }))
    const input = { ...gateInput, content: tokens.join(' '), skipDuplicate: true }
    const ranked = await findMemoryCandidates({ query: `${input.name}\n${input.summary}\n${input.content}`, scope: { kind: 'visible', workspacePath: '/proj' } }, deps)
    const result = await runCreateGate(input, deps)
    if (result.kind !== 'pass') throw new Error(result.kind)
    expect(result.similar).toHaveLength(5)
    expect(result.similar.map(r => r.id)).toEqual(ranked.candidates.slice(0, 5).map(c => c.record.id))
    expect(new Set(ranked.candidates.slice(0, 5).map(c => c.record.type)).size).toBe(2)
  })

  it('全库共有词被否决而独有脚本词留下且小库不否决', async () => {
    const deps = setup()
    for (let i = 0; i < 12; i++) await deps.store.create(record({ id: `mem_common_${i}`, content: '项目配置', summary: '项目配置', name: `配置${i}` }))
    await deps.store.create(record({ id: 'mem_rare', content: 'deploy.sh', summary: '部署脚本', name: '脚本' }))
    const result = await runCreateGate({ ...gateInput, content: '项目配置 deploy.sh', summary: '', skipDuplicate: true }, deps)
    expect(result).toMatchObject({ kind: 'pass', similar: [expect.objectContaining({ id: 'mem_rare' })] })
    const small = setup()
    for (let i = 0; i < 3; i++) await small.store.create(record({ id: `mem_small_${i}`, content: '项目配置', summary: '项目配置' }))
    const resultSmall = await runCreateGate({ ...gateInput, content: '项目配置', skipDuplicate: true }, small)
    if (resultSmall.kind !== 'pass') throw new Error(resultSmall.kind)
    expect(resultSmall.similar).toHaveLength(3)
  })

  it('要替代的旧记忆既不判重也不列相近', async () => {
    const deps = setup()
    await deps.store.create(record({ id: 'mem_old', scope: 'workspace', workspacePath: '/proj', content: 'Redis 需要定期备份', summary: 'Redis 备份' }))
    const result = await runSavePipeline(candidate({ content: 'Redis 需要定期备份', summary: 'Redis 备份', supersedes: ['mem_old'] }), deps)
    expect(result.kind).toBe('saved')
    expect(result).not.toHaveProperty('similar')
  })

  it('子会话判重只看主档且相近只列自己的待确认记录', async () => {
    const deps = setup()
    await deps.store.create(record({ id: 'mem_other', content: 'Redis 部署记录', summary: 'Redis 日志', delegation: delegated('other') }))
    await deps.store.create(record({ id: 'mem_own', content: 'Redis 操作记录', summary: 'Redis 日志', delegation: delegated('s1') }))
    const result = await runCreateGate({ ...gateInput, content: 'Redis 部署记录', summary: 'Redis 日志', subagentSessionId: 's1' }, deps)
    expect(result).toMatchObject({ kind: 'pass', similar: [expect.objectContaining({ id: 'mem_own' })] })
    await deps.store.create(record({ id: 'mem_main', content: 'Redis 部署记录', summary: 'Redis 日志' }))
    const blocked = await runSavePipeline(candidate({ type: 'knowledge', sourceMode: 'agent-inferred', content: 'Redis 部署记录', summary: 'Redis 日志' }), { ...deps, delegation: { ...delegated('s1'), mode: 'one-shot' as const } })
    expect(blocked).toMatchObject({ kind: 'duplicate-suspected', isFromSubagent: true, existing: { id: 'mem_main' } })
    expect(renderSaveResult(blocked)).not.toContain('force')
  })

  it('主档超过十条时待确认记录仍参与判重和列相近', async () => {
    const deps = setup()
    for (let i = 0; i < 12; i++) await deps.store.create(record({ id: `mem_common_${i}`, content: '项目配置', summary: '项目配置', name: `配置${i}` }))
    const pending = { content: '项目配置 Redis 备份每天凌晨执行', summary: 'Redis 备份' }
    await deps.store.create(record({ id: 'mem_pending', ...pending, name: '备份', delegation: delegated('s1') }))
    const main = await runCreateGate({ ...gateInput, ...pending }, deps)
    expect(main).toMatchObject({ kind: 'duplicate', existing: { id: 'mem_pending' } })
    const sub = await runCreateGate({ ...gateInput, content: '项目配置 Redis 备份改到凌晨三点', summary: 'Redis 备份时间', subagentSessionId: 's1' }, deps)
    expect(sub).toMatchObject({ kind: 'pass', similar: [expect.objectContaining({ id: 'mem_pending' })] })
  })

  it.each([FAKE_SECRET.github, 'aB3dE6gH9jK2mN5pQ8sT1vW4'])('摘要截断点落在密钥中间时两种返回都先遮盖整条', async secret => {
    const deps = setup()
    const summary = '部署说明'.repeat(25) + 'api_key = ' + secret + ' 完成'
    await deps.store.create(record({ id: 'mem_secret', content: 'Redis 部署内容', summary }))
    for (const skipDuplicate of [false, true]) {
      const result = await runCreateGate({ ...gateInput, content: 'Redis 部署内容', summary, skipDuplicate }, deps)
      const serialized = JSON.stringify(result)
      for (let i = 0; i <= secret.length - 8; i++) expect(serialized).not.toContain(secret.slice(i, i + 8))
      const rendered = result.kind === 'duplicate'
        ? renderSaveResult({ kind: 'duplicate-suspected', existing: result.existing })
        : renderSaveResult({ kind: 'saved', record: record(), similar: result.similar })
      for (let i = 0; i <= secret.length - 8; i++) expect(rendered).not.toContain(secret.slice(i, i + 8))
    }
  })
})

describe('确认参数各管一道闸', () => {
  it('跳过判重仍拦疑似密钥而确认疑似密钥仍拦重复', async () => {
    const deps = setup()
    const input = candidate({ content: 'api_key = aB3dE6gH9jK2mN5pQ8sT1vW4', summary: '部署配置' })
    const refused = await runSavePipeline({ ...input, force: true }, deps)
    expect(refused).toMatchObject({ kind: 'rejected', code: 'secret-suspected' })
    expect(renderSaveResult(refused)).toContain('allowSecret: true')
    const saved = await runSavePipeline({ ...input, allowSecret: true }, deps)
    expect(saved).toMatchObject({ kind: 'saved', warnings: expect.arrayContaining([expect.objectContaining({ code: 'secret-suspected' })]) })
    expect((await runSavePipeline({ ...input, allowSecret: true }, deps)).kind).toBe('duplicate-suspected')
    expect(await runSavePipeline(candidate({ content: FAKE_SECRET.github, force: true, allowSecret: true }), deps)).toMatchObject({ kind: 'rejected', code: 'secret-critical' })
  })

  it('子会话两种确认都不可用且同时给时先拒绝跳过判重', async () => {
    for (const action of ['create', 'update'] as const) {
      for (const flags of [{ force: true }, { allowSecret: true }, { force: true, allowSecret: true }]) {
        const deps = setup()
        await deps.store.create(record({ id: 'mem_own', scope: 'workspace', workspacePath: '/proj', delegation: delegated('s1') }))
        const result = await runSavePipeline(candidate({ action, id: 'mem_own', type: 'knowledge', sourceMode: 'agent-inferred', scope: 'workspace', change: 'correct', ...flags }), { ...deps, delegation: { ...delegated('s1'), mode: 'one-shot' as const } })
        expect(result).toMatchObject({ kind: 'rejected', code: 'subagent-restricted', subcode: flags.force ? 'subagent-force' : 'subagent-allow-secret' })
      }
    }
    const deps = setup()
    expect(await runSavePipeline(candidate({ type: 'knowledge', sourceMode: 'agent-inferred', force: false, allowSecret: false }), { ...deps, delegation: { ...delegated('s1'), mode: 'one-shot' as const } })).toMatchObject({ kind: 'saved' })
  })

  it('同一会话后存的相关内容列出刚存下的记忆', async () => {
    const deps = setup()
    const first = await runSavePipeline(candidate({ content: 'Redis 每天备份一次，保留最近七天。', summary: 'Redis 备份计划' }), deps)
    if (first.kind !== 'saved') throw new Error(first.kind)
    const second = await runSavePipeline(candidate({ content: 'Redis 连接发生超时，应当检查网络和连接池。', summary: 'Redis 超时排查' }), deps)
    expect(second).toMatchObject({ kind: 'saved', similar: expect.arrayContaining([expect.objectContaining({ id: first.record.id })]) })
  })
})

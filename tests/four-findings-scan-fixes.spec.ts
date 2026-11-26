import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkupEnv, type CheckupEnv } from './helpers/checkup-env.ts'
import { record } from './helpers/record.ts'
import { findingModel } from './helpers/finding-model.ts'
import type { SemanticLlm } from '../src/governance/semantic-scan.ts'
import { encodeRecord } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, workspaceDirName } from '../src/storage/paths.ts'
import type { CheckupScanResult, ScanToolResult } from '../src/tools/scan.ts'

const P1 = '/work/one'
const P2 = '/work/two'
const P3 = '/work/archive'
const envs: CheckupEnv[] = []
afterEach(async () => { for (const e of envs.splice(0)) await e.close() })
const duplicate = { topic: '包管理器', workspaces: [P1, P2], suggestion: '升为全局', memoryIds: ['mem_a', 'mem_b'] }
const all = { kind: 'checkup' as const }
async function env() {
  const e = await checkupEnv()
  envs.push(e)
  await e.store.put(record({ id: 'mem_a', scope: 'workspace', workspacePath: P1 }))
  await e.store.put(record({ id: 'mem_b', scope: 'workspace', workspacePath: P2 }))
  return e
}
function checkup(result: ScanToolResult): CheckupScanResult {
  if (result.kind !== 'checkup') throw new Error(`不是全库体检：${result.kind}`)
  return result
}
/** 在模型返回前完成一次真实文件写入，固定扫描与并发修改的先后次序。 */
function modelWithWrite(write: () => Promise<void>, crossReply = JSON.stringify({ duplicates: [duplicate] })): SemanticLlm {
  let didWrite = false
  return {
    provider: 'stub', model: 'with-write',
    complete: async ({ system }) => {
      if (system.includes('多个项目（workspace）')) {
        if (!didWrite) { didWrite = true; await write() }
        return crossReply
      }
      return '{"findings":[]}'
    },
  }
}

describe('跨项目发现的当下副本与收尾范围', () => {
  it('模型比较期间成员移到其他项目，挂账前按原项目复核后不挂账', async () => {
    const e = await env()
    const llm = modelWithWrite(async () => {
      const b = (await e.store.get('mem_b', { kind: 'workspace', workspacePath: P2 }))!
      await e.store.put({ ...b, workspacePath: P1 }, { kind: 'workspace', workspacePath: P2 })
    })
    const result = checkup(await e.scan({ llm, target: all }))
    expect(result.duplicates.items).toHaveLength(1)
    expect((await e.store.get('mem_b', { kind: 'workspace', workspacePath: P1 }))?.status).toBe('active')
    expect(result.pendingDecisions).toEqual({ created: 0, existing: 0, items: [] })
    expect(await e.decisions.list()).toEqual([])
  })

  it('预读时成员已删而收尾前恢复，认领后重读保留原待决项', async () => {
    const e = await env()
    const m = findingModel()
    m.crossReply = JSON.stringify({ duplicates: [duplicate] })
    await e.scan({ llm: m, target: all })
    const [entry] = await e.decisions.list()
    expect(entry?.kind).toBe('cross-duplicate')
    const b = (await e.store.get('mem_b', { kind: 'workspace', workspacePath: P2 }))!
    await e.store.put({ ...b, status: 'deleted' })
    // 保留第二个在用项目，让跨项目模型调用成为恢复的确定性时点。
    await e.store.put(record({ id: 'mem_c', scope: 'workspace', workspacePath: P3 }))
    const result = checkup(await e.scan({ llm: modelWithWrite(async () => { await e.store.put(b) }, '{"duplicates":[]}'), target: all }))
    expect(result.duplicates.via).toBe('semantic')
    expect((await e.store.get('mem_b', { kind: 'workspace', workspacePath: P2 }))?.status).toBe('active')
    expect((await e.decisions.list()).map(r => r.id)).toEqual([entry!.id])
  })

  it('其他作用域有更新的同 id 副本，收尾仍按原项目副本保留待决项', async () => {
    const e = await env()
    const m = findingModel()
    m.crossReply = JSON.stringify({ duplicates: [duplicate] })
    await e.scan({ llm: m, target: all })
    const [entry] = await e.decisions.list()
    const b = (await e.store.get('mem_b', { kind: 'workspace', workspacePath: P2 }))!
    await mkdir(join(e.memoryRoot, 'global'), { recursive: true })
    await writeFile(join(e.memoryRoot, 'global', 'copy.md'), encodeRecord({ ...b, scope: 'global', workspacePath: undefined, updatedAt: b.updatedAt + 1 }, {}))
    expect((await e.store.get('mem_b', { kind: 'global' }))?.scope).toBe('global')
    const result = checkup(await e.scan({ llm: null, layers: 'rule', target: all }))
    expect(result.kind).toBe('checkup')
    expect((await e.decisions.list()).map(r => r.id)).toEqual([entry!.id])
  })

  it('预读后成员目录变得读不全，收尾保留待决项而不把未知当不存在', async () => {
    const e = await env()
    const m = findingModel()
    m.crossReply = JSON.stringify({ duplicates: [duplicate] })
    await e.scan({ llm: m, target: all })
    const [entry] = await e.decisions.list()
    expect(entry?.kind).toBe('cross-duplicate')
    const llm = modelWithWrite(async () => {
      await e.store.hardDelete((await e.store.get('mem_b', { kind: 'workspace', workspacePath: P2 }))!)
      const archive = join(e.memoryRoot, workspaceDirName(P2), ARCHIVE_DIR)
      await rm(archive, { recursive: true, force: true })
      await writeFile(archive, '')
    }, '{"duplicates":[]}')
    const result = checkup(await e.scan({ llm, target: all }))
    expect(result.duplicates.via).toBe('semantic')
    expect((await e.store.readRaw({ kind: 'workspace', workspacePath: P2 }, { includeArchive: true })).directoryNotes.some(n => n.code === 'dir-unreadable')).toBe(true)
    expect((await e.decisions.list()).map(r => r.id)).toEqual([entry!.id])
  })

  it('同一组重复报告两次，待决清单只列一次且计数只加一次', async () => {
    const e = await env()
    const m = findingModel()
    m.crossReply = JSON.stringify({ duplicates: [duplicate, { ...duplicate, topic: '包管理偏好' }] })
    const result = checkup(await e.scan({ llm: m, target: all }))
    expect(result.duplicates.items).toHaveLength(2)
    expect(await e.decisions.list()).toHaveLength(1)
    expect(result.pendingDecisions.items).toHaveLength(1)
    expect(result.pendingDecisions.created).toBe(1)
    expect(result.pendingDecisions.existing).toBe(0)
  })

  it('只剩归档的项目可参加全库收尾，单项目扫描仍拒绝该路径', async () => {
    const e = await env()
    const b = (await e.store.get('mem_b', { kind: 'workspace', workspacePath: P2 }))!
    await e.store.put({ ...b, status: 'deleted' })
    expect((await e.scan({ llm: null, layers: 'rule', target: { kind: 'checkup', workspaces: [P2] } })).kind).toBe('checkup')
    expect(await e.scan({ llm: null, layers: 'rule', target: { kind: 'scope', scope: { kind: 'workspace', workspacePath: P2 } } })).toMatchObject({ kind: 'error' })
  })

  it('仅供收尾读取的归档项目后来写入同名副本，不混入本轮全局计分', async () => {
    const e = await env()
    const global = record({ id: 'mem_global', name: '全局事实' })
    await e.store.put(global)
    await e.store.put(record({ id: 'mem_archived', scope: 'workspace', workspacePath: P3, status: 'deleted' }))
    const llm = modelWithWrite(async () => {
      await writeFile(join(e.memoryRoot, workspaceDirName(P3), 'duplicate.md'), encodeRecord({ ...global, scope: 'workspace', workspacePath: P3, updatedAt: global.updatedAt + 1 }, {}))
    }, '{"duplicates":[]}')
    const result = checkup(await e.scan({ llm, target: all }))
    expect(result.duplicates.via).toBe('semantic')
    expect(result.rows.map(r => r.workspacePath ?? 'global')).toEqual(['global', P1, P2])
    expect(result.rows.find(r => r.layer === 'global')?.totalMemories).toBe(1)
  })
})

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { runSavePipeline, type PipelineResult } from '../src/pipeline.ts'
import { MemoryStore } from '../src/store.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { SnapshotStore } from '../src/governance/snapshots.ts'
import type { MemorySnapshot } from '../src/governance/schema.ts'
import { candidate } from './helpers/record.ts'
import { confirmCodeOf } from './helpers/global-confirm.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })
const N = 3

type Op =
  | { kind: 'start'; i: number }
  | { kind: 'resend'; i: number }
  | { kind: 'project' }
  | { kind: 'failing' }
  | { kind: 'handEdit'; i: number }
  | { kind: 'nextTurn' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('start' as const), i: fc.nat(N - 1) }),
  fc.record({ kind: fc.constant('resend' as const), i: fc.nat(N - 1) }),
  fc.constant({ kind: 'project' as const }),
  fc.constant({ kind: 'failing' as const }),
  fc.record({ kind: fc.constant('handEdit' as const), i: fc.nat(N - 1) }),
  fc.constant({ kind: 'nextTurn' as const }),
)

/** 一个在途的改写意图：要写的正文、已用的调用次数、其间这条被手改的次数、最近一次收到的引导。 */
interface Intent { content: string; calls: number; edits: number; guided: PipelineResult }

// 活性：项目会话里改全局记忆，模型照最新一次引导里的确认码重发。改写意图、项目记忆、失败的保存、界面手改、换到用户的下一轮
// 任意交错，每个意图都写得进；调用次数不超过 2 次加上其间这条被手改的次数（手改让码变了，多回一次引导）。
describe('改写全局记忆的确认码：活性', () => {
  it('随机交错下，照引导重发的改写都写得进，调用次数有上限', async () => {
    await fc.assert(fc.asyncProperty(fc.array(opArb, { maxLength: 30 }), async (ops) => {
      const store = new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable())
      let turn = 0
      const deps = () => ({
        store, registry, workspacePath: '/proj' as string | undefined,
        session: { id: 's1', lastSeq: 100 + turn, turnStartSeq: turn },
        snapshots: new SnapshotStore(new InMemoryKvTable<MemorySnapshot>()),
      })
      const ids: string[] = []
      for (let i = 0; i < N; i++) {
        const created = await runSavePipeline(candidate({ scope: 'workspace', name: `全局规范${i}`, content: `全局规范 ${i} 的初始正文` }), deps())
        if (created.kind !== 'saved') throw new Error(created.kind)
        await store.put({ ...created.record, scope: 'global', workspacePath: undefined })
        ids.push(created.record.id)
      }
      const intents = new Map<number, Intent>()
      let serial = 0
      const update = (i: number, content: string, code?: string) =>
        runSavePipeline(candidate({ action: 'update', change: 'correct', id: ids[i], scope: 'global', name: `全局规范${i}`, content, ...(code === undefined ? {} : { confirmGlobal: code }) }), deps())
      // 带码重发一次：写成了就核对正文、调用次数并结束这个意图；没写成只能是新引导（其间被手改，码变了）
      const resend = async (i: number) => {
        const intent = intents.get(i)!
        const r = await update(i, intent.content, confirmCodeOf(intent.guided))
        intent.calls += 1
        if (r.kind === 'updated') {
          expect((await store.get(ids[i]!))?.content).toBe(intent.content)
          expect(intent.calls).toBeLessThanOrEqual(2 + intent.edits)
          intents.delete(i)
        } else {
          expect(r).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
          intent.guided = r
        }
      }

      for (const op of ops) {
        if (op.kind === 'start' && !intents.has(op.i)) {
          const content = `全局规范 ${op.i} 的第 ${++serial} 版`
          const guided = await update(op.i, content)
          expect(guided).toMatchObject({ kind: 'rejected', code: 'global-update-unconfirmed' })
          intents.set(op.i, { content, calls: 1, edits: 0, guided })
        } else if (op.kind === 'resend' && intents.has(op.i)) {
          await resend(op.i)
        } else if (op.kind === 'project') {
          const r = await runSavePipeline(candidate({ scope: 'workspace', name: `项目规范${++serial}`, content: `只在本项目成立的第 ${serial} 条约定`, force: true }), deps())
          expect(r.kind).toBe('saved')
        } else if (op.kind === 'failing') {
          expect(await runSavePipeline(candidate({ scope: 'workspace', type: 'ghost' }), deps())).toMatchObject({ kind: 'rejected', code: 'unknown-type' })
        } else if (op.kind === 'handEdit') {
          const current = (await store.get(ids[op.i]!))!
          await store.put({ ...current, content: `${current.content}（手改 ${++serial}）`, updatedAt: current.updatedAt + 1 })
          const intent = intents.get(op.i)
          if (intent !== undefined) intent.edits += 1
        } else if (op.kind === 'nextTurn') {
          turn += 1
        }
      }
      // 收尾：不再有手改，每个还在途的意图至多再发两次就写完
      for (const i of [...intents.keys()]) {
        await resend(i)
        if (intents.has(i)) await resend(i)
        expect(intents.has(i)).toBe(false)
      }
    }), { numRuns: 200 })
  })
})

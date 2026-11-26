import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/index.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { SidecarStore } from '../src/storage/sidecar.ts'
import { RELATED_RECHECK_VIA } from '../src/tools/related-recheck.ts'
import { fakeExec } from './helpers/exec.ts'
import { readUserTurn, USER_TURN_BOUNDARY } from './helpers/session-log.ts'
import { sidecarSchemas } from './helpers/sidecar-schemas.ts'

// 接线：经 apply() 注册的 memory_save、memory_scan 按配置 governance.relatedRecheck 发信号、清信号。
// 宿主对象只按最小结构伪造（进程边界），不调模型。

type ToolDef = { name: string; execute(args: unknown, exec: ToolRunContext): Promise<unknown> }
type Saved = { kind: string; record: { id: string } }

const tmpDirs: string[] = []
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-related-recheck-plugin-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

/** 起插件：办公场景（有决定类型），治理开关和实验开关按参数给；两个实例可以共用一个记忆根和项目目录。 */
async function boot(governance: { enabled: boolean; relatedRecheck: boolean }, shared?: { memoryRoot: string; cwd: string }) {
  const defs = new Map<string, ToolDef>()
  const sessionQuery = { readEvent: async () => ({ events: [], startSeq: 0, endSeq: 0 }), readSession: readUserTurn }
  const turnProjection = { stateOf: (_s: object, key: string) => (key === 'turnBoundary' ? USER_TURN_BOUNDARY : undefined) }
  const ctx = {
    tools: {
      register: (def: ToolDef) => {
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      },
    },
    on: () => () => {},
    get: (name: string) => (name === 'sessionQuery' ? sessionQuery : name === 'sessionProjections' ? turnProjection : undefined),
    inject: () => () => {},
    effect: () => () => {},
    logger: { info() {}, warn() {}, error() {} },
  }
  const memoryRoot = shared?.memoryRoot ?? await makeTmp()
  const cwd = shared?.cwd ?? await makeTmp()
  await apply(ctx as never, new Config({ memoryRoot, template: 'office', governance } as never))
  const exec = fakeExec({
    agent: { session: { header: { id: 'sess-main', cwd }, seq: 3, requestHeader: () => undefined }, options: { provider: 'p', model: 'm' } } as unknown as ToolRunContext['agent'],
  })
  const call = (tool: string, args: unknown) => defs.get(tool)!.execute(args, exec)
  const ledger = new PendingDecisionsStore(new SidecarStore({ root: memoryRoot, schemas: sidecarSchemas, log: { info() {}, warn() {}, error() {} } }).pending)
  return { memoryRoot, cwd, call, defs, signals: async () => (await ledger.list()).filter(d => d.kind === 'premise-changed' && d.via === RELATED_RECHECK_VIA) }
}

const base = { scope: 'workspace', sourceMode: 'user-explicit', tags: [], force: true }

/** 一张状态页和挂在它上面的决定；之后对状态页做一次状态变化。 */
async function pageWithDecisionChanged(h: Awaited<ReturnType<typeof boot>>): Promise<{ pageId: string; decisionId: string }> {
  const page = await h.call('memory_save', { ...base, action: 'create', type: 'project', name: '归档容量', summary: '归档区多大', content: '归档区容量 10 单位' }) as Saved
  expect(page.kind).toBe('saved')
  const decision = await h.call('memory_save', {
    ...base, action: 'create', type: 'decision', name: '暂停归档', summary: '先不归档', content: '容量不够，暂停新增归档', related: [page.record.id],
  }) as Saved
  expect(decision.kind).toBe('saved')
  const changed = await h.call('memory_save', {
    ...base, action: 'update', id: page.record.id, type: 'project', name: '归档容量', summary: '归档区多大', content: '归档区容量扩到 1000 单位', change: 'state-change',
  }) as { kind: string }
  expect(changed.kind).toBe('updated')
  return { pageId: page.record.id, decisionId: decision.record.id }
}

describe('经注册处的接线', () => {
  it('开关开着：memory_save 的状态变化发信号；同一记忆根上开关关着的实例跑 memory_scan 时清掉', async () => {
    const on = await boot({ enabled: true, relatedRecheck: true })
    const { pageId, decisionId } = await pageWithDecisionChanged(on)
    expect((await on.signals()).map(d => d.memoryIds)).toEqual([[decisionId, pageId]])

    const off = await boot({ enabled: true, relatedRecheck: false }, { memoryRoot: on.memoryRoot, cwd: on.cwd })
    const scanned = await off.call('memory_scan', { layers: 'rule' }) as { kind: string }
    expect(scanned.kind).not.toBe('error')
    expect(await off.signals()).toEqual([])
  })

  it('开关关着（缺省）：状态变化照常保存，不发信号', async () => {
    const h = await boot({ enabled: true, relatedRecheck: false })
    await pageWithDecisionChanged(h)
    expect(await h.signals()).toEqual([])
  })

  it('治理总开关关着时，实验开关开着也不发', async () => {
    const h = await boot({ enabled: false, relatedRecheck: true })
    await pageWithDecisionChanged(h)
    expect(await h.signals()).toEqual([])
  })
})

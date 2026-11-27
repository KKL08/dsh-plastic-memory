import { describe, expect, it } from 'vitest'
import { executeHealth, renderHealthResult, type HealthToolDeps } from '../src/tools/health.ts'
import { MemoryStore } from '../src/store.ts'
import { PendingDecisionsStore } from '../src/governance/decisions.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import type { PendingDecision, ScanCacheEntry } from '../src/governance/schema.ts'
import { fakeExec } from './helpers/exec.ts'
import { InMemoryTable } from './helpers/in-memory-table.ts'
import { InMemoryKvTable, InMemoryBatchKvTable } from './helpers/in-memory-kv.ts'

// memory_health 里检索输出上限偏低的那一条：DeepSeek Harness 的工具结果裁剪阈值已知、算出的检索输出上限低于 6000 时列出，不计分。

const LOW_LINE = '检索输出上限偏低（不扣分）：DeepSeek Harness 的工具结果裁剪阈值是 4000 字，memory_search 每次最多输出 3800 字，命中多时只给节选或头行。'
  + '建议把 @deepseek-ai/dsh-compaction-tool-result-pruner 的 thresholdChars 调到 6316 或以上，同时让 headChars + tailChars + 39 不超过 thresholdChars。'

type Pruner = number | 'none' | 'throw'
function deps(pruner: Pruner): HealthToolDeps {
  return {
    store: new MemoryStore(new InMemoryTable(), undefined, new InMemoryBatchKvTable()),
    registry: buildTypeRegistry({ template: 'coding', customTypes: {} }),
    decisions: new PendingDecisionsStore(new InMemoryKvTable<PendingDecision>()),
    cache: new InMemoryKvTable<ScanCacheEntry>(),
    thresholds: { actionScoreThreshold: 70, pendingOverdueDays: 7, scanStaleDays: 7 },
    host: {
      contextOf: async () => ({ workspacePath: undefined }),
      toolResultPrunerOf: () => {
        if (pruner === 'throw') throw new Error('服务重启中')
        return pruner === 'none' ? undefined : { config: { thresholdChars: pruner } }
      },
    },
    now: () => 1_700_000_000_000,
  }
}

describe('检索输出上限偏低', () => {
  it('阈值 4000（上限 3800）：单个范围和全库体检都列这一条，分数不变', async () => {
    for (const scope of [undefined, 'all'] as const) {
      const low = await executeHealth(scope === undefined ? {} : { scope }, deps(4000), fakeExec())
      const normal = await executeHealth(scope === undefined ? {} : { scope }, deps(8192), fakeExec())
      const text = renderHealthResult(low)
      expect(text.split('\n')).toContain(LOW_LINE)
      expect(low.kind === 'single' && normal.kind === 'single' ? low.score : undefined).toBe(normal.kind === 'single' ? normal.score : undefined)
      if (low.kind === 'checkup' && normal.kind === 'checkup') expect(low.rows.map(r => r.score)).toEqual(normal.rows.map(r => r.score))
    }
  })

  it('阈值 2000：上限取下限 3000，照样列', async () => {
    const text = renderHealthResult(await executeHealth({}, deps(2000), fakeExec()))
    expect(text).toContain('裁剪阈值是 2000 字，memory_search 每次最多输出 3000 字')
  })

  it.each([
    ['阈值 6316（上限正好 6000）', 6316 as Pruner],
    ['默认阈值 8192', 8192 as Pruner],
    ['没有裁剪服务', 'none' as Pruner],
    ['取服务抛错（读不出）', 'throw' as Pruner],
  ])('%s：不列', async (_label, pruner) => {
    const text = renderHealthResult(await executeHealth({}, deps(pruner), fakeExec()))
    expect(text).not.toContain('检索输出上限偏低')
  })

  it('阈值 6315（上限 5999）：列', async () => {
    const text = renderHealthResult(await executeHealth({}, deps(6315), fakeExec()))
    expect(text).toContain('裁剪阈值是 6315 字，memory_search 每次最多输出 5999 字')
  })
})

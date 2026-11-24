import { describe, expect, it } from 'vitest'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { assembleSnapshot } from '../src/snapshot.ts'
import type { MemoryRecord, SourceAnchor } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'

// 注入里标出无人值守时写下的记忆：看最近一次写下内容的锚是谁开的轮。

const T0 = 1_700_000_000_000
const WS = '/tmp/pm-unattended-note'
const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

describe('注入里标出无人值守时写下的记忆', () => {
  const NOTE = '（无人值守时写入）'
  const anchor = (initiator: string | undefined, change: string): SourceAnchor => ({
    sessionId: 's', eventRange: [0, 1], sourceMode: 'environment-observed', at: 1, change, by: 'main', ...(initiator === undefined ? {} : { initiator }),
  })
  /** 顶层 source 和最新的锚一致，同保存管线写下的一样。 */
  const withTrail = (partial: Partial<MemoryRecord>, sourceTrail: SourceAnchor[]) =>
    record({ ...partial, source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'environment-observed' }, sourceTrail })
  const snapshotOf = (records: MemoryRecord[]) =>
    assembleSnapshot({ records, registry, workspacePath: WS, budget: 100_000, now: T0 }).text

  it('最近一次写内容的锚出自定时任务：核心区和索引区那一行都带标注', () => {
    const core = withTrail({ id: 'mem_core', type: 'preference', content: '每天早上汇总构建结果' }, [anchor('schedule', 'create')])
    const indexed = withTrail({ id: 'mem_idx', type: 'knowledge', name: '夜间构建' }, [anchor('schedule', 'create')])
    const text = snapshotOf([core, indexed])
    expect(text.split('\n').find(l => l.includes('[mem_core]'))).toContain(NOTE)
    expect(text.split('\n').find(l => l.includes('[mem_idx]'))).toContain(NOTE)
  })

  it('用户本人开的轮写下的、没记发起方的旧记录、只被定时任务补过证的，都不带标注', () => {
    const byUserRecord = withTrail({ id: 'mem_user', type: 'knowledge' }, [anchor('user', 'create')])
    const retried = withTrail({ id: 'mem_retry', type: 'knowledge' }, [anchor('retry', 'create')])
    const legacy = withTrail({ id: 'mem_old', type: 'knowledge' }, [anchor(undefined, 'create')])
    const corroborated = withTrail({ id: 'mem_corr', type: 'knowledge' }, [anchor('schedule', 'corroborate'), anchor('user', 'create')])
    expect(snapshotOf([byUserRecord, retried, legacy, corroborated])).not.toContain(NOTE)
  })

  it('用户本人后来改写了定时任务写下的内容，标注随之去掉', () => {
    const rewritten = withTrail({ id: 'mem_fix', type: 'knowledge' }, [anchor('user', 'refine'), anchor('schedule', 'create')])
    expect(snapshotOf([rewritten])).not.toContain(NOTE)
  })
})

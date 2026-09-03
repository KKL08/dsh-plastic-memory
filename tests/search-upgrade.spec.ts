import { describe, expect, it } from 'vitest'
import { MemoryStore, InMemoryTable } from '../src/store.ts'
import { sourceNote, formatIndexLine, INFERENCE_NOTE } from '../src/index-line.ts'
import { STALENESS_NOTE } from '../src/record-freshness.ts'
import { renderSearchResult, executeSearch, type SearchToolDeps, type SearchHit } from '../src/tools/search.ts'
import { assembleSnapshot } from '../src/snapshot.ts'
import { buildTypeRegistry } from '../src/type-registry.ts'
import { record } from './helpers/record.ts'

const registry = buildTypeRegistry({ template: 'coding', customTypes: {} })

describe('store.query 关键词 OR 匹配（含 CJK bigram）+ id/name 入 haystack', () => {
  it('命中任一词即入选（OR 放宽）；多一个不相关词不再空手', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_pnpm', content: '这个项目的包管理一律用 pnpm，不要用 npm' }))

    expect(store.query({ keyword: 'pnpm 包管理' }).map(r => r.id)).toEqual(['mem_pnpm'])
    expect(store.query({ keyword: 'pnpm 不要用' }).map(r => r.id)).toEqual(['mem_pnpm'])
    // OR 放宽：夹一个不匹配词不再零结果（硬 AND 的病灶）
    expect(store.query({ keyword: 'pnpm 不存在的怪词' }).map(r => r.id)).toEqual(['mem_pnpm'])
    // 全不匹配才空
    expect(store.query({ keyword: 'golang rust' }).map(r => r.id)).toEqual([])
  })

  it('按 id 可检索、按 name 可检索（索引→全文断路修复）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_abc', name: '专有名词名字', content: '与关键词无关的正文', summary: '也无关' }))

    expect(store.query({ keyword: 'mem_abc' }).map(r => r.id)).toEqual(['mem_abc'])
    expect(store.query({ keyword: '专有名词名字' }).map(r => r.id)).toEqual(['mem_abc'])
  })

  it('连写中文仍命中（bigram 覆盖连续子串）', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_cjk', content: '这个项目的包管理一律用 pnpm，不要用 npm' }))

    expect(store.query({ keyword: '包管理一律' }).map(r => r.id)).toEqual(['mem_cjk'])
  })

  it('中文短语经 bigram 切分，正文里非连续也能命中', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_deploy', content: '部署的流程和配置都记在 wiki' }))

    // "部署流程配置"整段在正文里不连续；bigram(部署/署流/流程/程配/配置)命中 部署+流程+配置
    expect(store.query({ keyword: '部署流程配置' }).map(r => r.id)).toEqual(['mem_deploy'])
  })
})

describe('executeSearch 排序：命中词数 → confidence → recallCount', () => {
  it('命中更多查询词的排前，即使 confidence 较低', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_two', content: 'deploy hook 都齐了', confidence: 0.5 }))
    await store.put(record({ id: 'mem_one', content: '只提到 deploy', confidence: 0.9 }))
    const deps: SearchToolDeps = {
      store, registry,
      resolveContext: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }),
    }
    const result = await executeSearch({ query: 'deploy hook' }, {} as never, deps)
    // mem_two 命中 2 词、confidence 0.5；mem_one 命中 1 词、confidence 0.9——命中数优先
    expect(result.hits.map(h => h.id)).toEqual(['mem_two', 'mem_one'])
  })
})

describe('低置信标注', () => {
  it('agent-inferred 标注、user-explicit 低分不标注（判据是 sourceMode）', () => {
    const inferred = record({ source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'agent-inferred' }, confidence: 0.5 })
    const explicitLow = record({ source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'user-explicit' }, confidence: 0.5 })

    expect(sourceNote(inferred)).toBe(INFERENCE_NOTE)
    expect(sourceNote(explicitLow)).toBe('')
  })

  it('executeSearch 过滤 validTo 已过期的记忆，命中项带陈旧度标注', async () => {
    const store = new MemoryStore(new InMemoryTable())
    const now = Date.now()
    await store.put(record({ id: 'mem_dead', content: '过期约定 magicword', validTo: now - 1000 }))
    await store.put(record({ id: 'mem_stale', content: '很久没确认 magicword', lastConfirmedAt: now - 100 * 86_400_000 })) // knowledge 衰减 90 天
    await store.put(record({ id: 'mem_ok', content: '新鲜内容 magicword', lastConfirmedAt: now }))
    const deps: SearchToolDeps = {
      store, registry,
      resolveContext: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }),
    }
    const { hits } = await executeSearch({ query: 'magicword' }, {} as never, deps)
    const ids = hits.map(h => h.id)
    expect(ids).not.toContain('mem_dead')
    expect(hits.find(h => h.id === 'mem_stale')!.stalenessNote).toBe(STALENESS_NOTE(100))
    expect(hits.find(h => h.id === 'mem_ok')!.stalenessNote).toBe('')
  })

  it('search 渲染带标注（agent-inferred）', () => {
    const hits: SearchHit[] = [
      { id: 'mem_x', type: 'knowledge', summary: '摘要', content: '正文', sourceNote: INFERENCE_NOTE, stalenessNote: '' },
      { id: 'mem_y', type: 'knowledge', summary: '摘要2', content: '正文2', sourceNote: '', stalenessNote: '' },
    ]
    const rendered = renderSearchResult({ hits })
    expect(rendered).toContain(`[mem_x] knowledge｜摘要${INFERENCE_NOTE}\n正文`)
    expect(rendered).toContain('[mem_y] knowledge｜摘要2\n正文2')
  })

  it('executeSearch 按 sourceMode 填充 SearchHit.sourceNote', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({
      id: 'mem_inferred', content: '推断出来的知识', summary: '推断摘要',
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'agent-inferred' },
    }))
    const deps: SearchToolDeps = {
      store, registry,
      resolveContext: async () => ({ workspacePath: undefined, session: { id: 's1', lastSeq: 1 } }),
    }
    const result = await executeSearch({ query: '推断' }, {} as never, deps)
    expect(result.hits[0].sourceNote).toBe(INFERENCE_NOTE)
  })

  it('snapshot core 区/索引区都带标注', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({
      id: 'mem_core_inferred', type: 'preference', content: '模型推断出的偏好', summary: '偏好摘要',
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'agent-inferred' },
    }))
    await store.put(record({
      id: 'mem_idx_inferred', type: 'knowledge', name: '索引区条目', content: '知识正文', summary: '知识摘要',
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'agent-inferred' },
    }))
    const { text } = assembleSnapshot({ store, registry, workspacePath: undefined, budget: 4000, now: 10 })
    expect(text).toContain(`模型推断出的偏好${INFERENCE_NOTE}`)
    expect(text).toContain(`[mem_idx_inferred] 索引区条目（知识摘要）${INFERENCE_NOTE}`)
  })
})

describe('索引行格式', () => {
  it('passive：无 summary，但带 tags 与 sourceNote', () => {
    const r = record({
      id: 'mem_ref', name: '看板', type: 'reference', tags: ['linear'],
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'agent-inferred' },
    })
    const line = formatIndexLine(r, { passive: true })
    expect(line).toBe(`- [mem_ref] 看板 — linear${INFERENCE_NOTE}`)
  })

  it('非 passive：summary + tags + sourceNote', () => {
    const r = record({
      id: 'mem_p', name: '项目状态', type: 'project', tags: ['freeze'], summary: '冻结到三月',
      source: { sessionId: 's', eventRange: [0, 1], sourceMode: 'agent-inferred' },
    })
    const line = formatIndexLine(r, { passive: false })
    expect(line).toBe(`- [mem_p] 项目状态（冻结到三月） — freeze${INFERENCE_NOTE}`)
  })

  it('tags 为空时省略 — tags 段', () => {
    const r = record({ id: 'mem_notag', name: '无标签条目', tags: [], summary: '摘要文本' })
    const line = formatIndexLine(r, { passive: false })
    expect(line).toBe('- [mem_notag] 无标签条目（摘要文本）')
  })
})

describe('scope=workspace 无工作目录时显式说明', () => {
  it('返回空 hits + note，渲染输出 note 而非"没有匹配"', async () => {
    const store = new MemoryStore(new InMemoryTable())
    await store.put(record({ id: 'mem_g', content: '全局内容 magicword' }))
    const deps: SearchToolDeps = {
      store, registry,
      resolveContext: async () => ({ workspacePath: undefined, session: { id: 's', lastSeq: 1 } }),
    }
    const result = await executeSearch({ query: 'magicword', scope: 'workspace' }, {} as never, deps)
    expect(result.hits).toEqual([])
    expect(result.noteCode).toBe('no-workspace')
    expect(renderSearchResult(result)).toContain('scope: "global"')
    // 不带 scope 或 scope=global 不受影响
    const fallback = await executeSearch({ query: 'magicword' }, {} as never, deps)
    expect(fallback.hits.map(h => h.id)).toEqual(['mem_g'])
    expect(fallback.note).toBeUndefined()
  })
})

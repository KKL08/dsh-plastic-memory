import { describe, expect, it } from 'vitest'
import { findEntityDuplicates, buildCrossWsPrompt, parseCrossWsResult, runCrossWsScan, CROSS_WS_LIMIT } from '../src/governance/cross-ws.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record as baseRecord } from './helpers/record.ts'

// 本文件默认造 workspace 层记忆。
const record = (partial: Partial<MemoryRecord> = {}) => baseRecord({ scope: 'workspace', ...partial })

describe('findEntityDuplicates（实体聚类保底）', () => {
  it('实体出现在 ≥2 个 workspace 且 global 缺位 → 疑似重复；global 已有的不报', async () => {
    const byWs = new Map([
      ['/a', [record({ content: '包管理用 `pnpm`' }), record({ content: '部署走 `deploy.sh`' })]],
      ['/b', [record({ content: '这里也用 `pnpm`' })]],
      ['/c', [record({ content: '发布跑 `deploy.sh`' })]],
    ])
    // global 已有 deploy.sh 相关记忆 → 不再报它
    const dup = findEntityDuplicates(byWs, [record({ scope: 'global', content: '统一部署脚本 `deploy.sh`' })])
    expect(dup).toHaveLength(1)
    expect(dup[0].topic).toBe('pnpm')
    expect(dup[0].workspaces).toEqual(['/a', '/b'])
    expect(dup[0].suggestion).toContain('疑似')
  })

  it('单一 workspace 的实体不报；结果限流', () => {
    const many = new Map([
      ['/a', Array.from({ length: 6 }, (_, i) => record({ content: `用 \`tool${i}\`` }))],
      ['/b', Array.from({ length: 6 }, (_, i) => record({ content: `也用 \`tool${i}\`` }))],
      ['/c', [record({ content: '只有这里 `solo`' })]],
    ])
    const dup = findEntityDuplicates(many, [])
    expect(dup.length).toBe(CROSS_WS_LIMIT)
    expect(dup.every(d => d.topic !== 'solo')).toBe(true)
  })
})

describe('buildCrossWsPrompt / parseCrossWsResult', () => {
  it('prompt 含各项目摘要与 global 清单；global 空时标注', () => {
    const byWs = new Map([['/a', [record({ summary: '摘要甲' })]]])
    const p = buildCrossWsPrompt(byWs, [])
    expect(p.user).toContain('## 项目 /a')
    expect(p.user).toContain('摘要甲')
    expect(p.user).toContain('（空）')
  })

  it('解析：未知 workspace 剔除、少于 2 个 ws 的条目丢弃、整体坏 JSON 返回 null', () => {
    const known = new Set(['/a', '/b'])
    const good = parseCrossWsResult(JSON.stringify({
      duplicates: [
        { topic: '主题一', workspaces: ['/a', '/b'], suggestion: 's' },
        { topic: '掺假', workspaces: ['/a', '/evil'], suggestion: 's' },  // /evil 剔除后只剩 1 个 → 丢弃
      ],
    }), known)
    expect(good).toHaveLength(1)
    expect(good![0].topic).toBe('主题一')
    expect(parseCrossWsResult('不是 JSON', known)).toBeNull()
  })

  it('runCrossWsScan：LLM 抛出或输出无法解析 → failed（调用方降级到实体保底）', async () => {
    const byWs = new Map([['/a', [record({})]], ['/b', [record({})]]])
    const boom = await runCrossWsScan(byWs, [], { complete: async () => { throw new Error('x') } })
    expect(boom.failed).toBe(true)
    const bad = await runCrossWsScan(byWs, [], { complete: async () => '乱码' })
    expect(bad.failed).toBe(true)
    const ok = await runCrossWsScan(byWs, [], {
      complete: async () => JSON.stringify({ duplicates: [{ topic: 't', workspaces: ['/a', '/b'], suggestion: 's' }] }),
    })
    expect(ok.failed).toBe(false)
    expect(ok.items).toHaveLength(1)
  })

  it('runCrossWsScan：用户取消（signal）时抛 AbortError，不退实体保底', async () => {
    const byWs = new Map([['/a', [record({})]], ['/b', [record({})]]])
    const controller = new AbortController()
    let calls = 0
    const llm = {
      complete: async (): Promise<string> => {
        calls++
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    }
    await expect(runCrossWsScan(byWs, [], llm, controller.signal)).rejects.toThrow(/abort/i)
    expect(calls).toBe(1)
  })
})

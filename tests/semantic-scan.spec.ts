import { describe, expect, it } from 'vitest'
import { buildSemanticPrompt, parseSemanticFindings, runSemanticScan, SEMANTIC_SCAN_MAX_RECORDS, BASELINE_MAX_CHARS } from '../src/governance/semantic-scan.ts'
import { record } from './helpers/record.ts'

describe('buildSemanticPrompt', () => {
  it('user 部分含每条记忆的 id/content，有基线时包含基线内容', () => {
    const { system, user } = buildSemanticPrompt(
      [record({ id: 'mem_a', content: '用 pnpm' })], 'AGENTS.md 内容：包管理用 npm')
    expect(user).toContain('mem_a')
    expect(user).toContain('用 pnpm')
    expect(user).toContain('包管理用 npm')
    expect(system).toContain('conflict')
    expect(system).toContain('JSON')
  })

  it('无基线时 user 说明基线缺失，system 要求跳过垂直冲突', () => {
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })], null)
    expect(user).toContain('（无权威配置基线，跳过垂直冲突检测）')
  })

  it('基线超长时截断到上限并追加说明行', () => {
    const baseline = 'x'.repeat(BASELINE_MAX_CHARS + 500)
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })], baseline)
    expect(user).toContain('已截断，其余 500 字符未纳入垂直冲突检测')
    expect(user).not.toContain('x'.repeat(BASELINE_MAX_CHARS + 1))
  })

  it('基线不超长时原样纳入，不带截断说明', () => {
    const baseline = '包管理用 npm'.padEnd(BASELINE_MAX_CHARS, '。')
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })], baseline)
    expect(user).toContain(baseline)
    expect(user).not.toContain('已截断')
  })
})

describe('parseSemanticFindings', () => {
  const known = new Set(['mem_a', 'mem_b'])

  it('解析合法 JSON 并补全 layer/severity', () => {
    const raw = JSON.stringify({
      findings: [{ type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '矛盾', suggestedAction: '裁决' }],
    })
    const out = parseSemanticFindings(raw, known)!
    expect(out).toHaveLength(1)
    expect(out[0].layer).toBe('semantic')
    expect(out[0].severity).toBe('critical')
  })

  it('容忍 markdown 代码围栏', () => {
    const raw = '```json\n{"findings":[{"type":"unclear","memoryIds":["mem_a"],"summary":"s","suggestedAction":"a"}]}\n```'
    expect(parseSemanticFindings(raw, known)).toHaveLength(1)
  })

  it('过滤未知 id 与非语义类型；memoryIds 全部未知则丢弃该条', () => {
    const raw = JSON.stringify({
      findings: [
        { type: 'conflict', memoryIds: ['mem_ghost'], summary: 's', suggestedAction: 'a' },
        { type: 'secret', memoryIds: ['mem_a'], summary: 's', suggestedAction: 'a' },
        { type: 'redundancy', memoryIds: ['mem_a', 'mem_ghost'], summary: 's', suggestedAction: 'a' },
      ],
    })
    const out = parseSemanticFindings(raw, known)!
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('redundancy')
    expect(out[0].memoryIds).toEqual(['mem_a'])
  })

  it('整体不是 JSON 或缺 findings 数组时返回 null', () => {
    expect(parseSemanticFindings('我觉得没有问题', known)).toBeNull()
    expect(parseSemanticFindings('{"ok":true}', known)).toBeNull()
  })

  it('保留 baselineRef（垂直冲突）', () => {
    const raw = JSON.stringify({
      findings: [{ type: 'conflict', memoryIds: ['mem_a'], baselineRef: 'AGENTS.md：包管理', summary: 's', suggestedAction: 'a' }],
    })
    expect(parseSemanticFindings(raw, known)![0].baselineRef).toBe('AGENTS.md：包管理')
  })

  it('conflict 的基数在产出侧收口：3 个 id、1 个 id 无 baselineRef 都丢弃；1 个 id 带 baselineRef、2 个 id 无 baselineRef 都保留', () => {
    const known3 = new Set(['mem_a', 'mem_b', 'mem_c'])
    const raw = JSON.stringify({
      findings: [
        { type: 'conflict', memoryIds: ['mem_a', 'mem_b', 'mem_c'], summary: '三条', suggestedAction: 'a' },
        { type: 'conflict', memoryIds: ['mem_a'], summary: '单条无基线', suggestedAction: 'a' },
        { type: 'conflict', memoryIds: ['mem_a'], baselineRef: 'AGENTS.md：规则', summary: '垂直', suggestedAction: 'a' },
        { type: 'conflict', memoryIds: ['mem_a', 'mem_b'], summary: '横向', suggestedAction: 'a' },
      ],
    })
    const out = parseSemanticFindings(raw, known3)!
    expect(out).toHaveLength(2)
    expect(out.map(f => f.summary)).toEqual(['垂直', '横向'])
  })

  it('横向 conflict 的两个 id 必须不同：重复 id 不能被当作两方（否则 keep-left 会删掉保留方）', () => {
    const raw = JSON.stringify({
      findings: [
        { type: 'conflict', memoryIds: ['mem_c', 'mem_c'], summary: '自冲突', suggestedAction: 'a' },
        { type: 'redundancy', memoryIds: ['mem_a', 'mem_a', 'mem_b'], summary: '重复列出', suggestedAction: 'a' },
      ],
    })
    const out = parseSemanticFindings(raw, new Set(['mem_a', 'mem_b', 'mem_c']))!
    expect(out.map(f => [f.type, f.memoryIds])).toEqual([['redundancy', ['mem_a', 'mem_b']]])
  })

  it('findings 数组里的 null / 非对象项只丢该条，不废整批', () => {
    const raw = JSON.stringify({
      findings: [
        null,
        'not an object',
        { type: 'unclear', memoryIds: ['mem_a'], summary: 's', suggestedAction: 'a' },
      ],
    })
    const out = parseSemanticFindings(raw, known)!
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('unclear')
  })

  it('baselineRef 缺省或非字符串时该键完全不存在（防 lossless-JSON bug）', () => {
    const omitted = JSON.stringify({
      findings: [{ type: 'unclear', memoryIds: ['mem_a'], summary: 's', suggestedAction: 'a' }],
    })
    expect(Object.keys(parseSemanticFindings(omitted, known)![0])).not.toContain('baselineRef')

    // 用 redundancy 而非 conflict：baselineRef 的类型强制转换与冲突基数收口（Fix D）是两回事，
    // 这里只测前者，避免被后者的丢弃规则干扰。
    const nonString = JSON.stringify({
      findings: [{ type: 'redundancy', memoryIds: ['mem_a'], baselineRef: 42, summary: 's', suggestedAction: 'a' }],
    })
    expect(Object.keys(parseSemanticFindings(nonString, known)![0])).not.toContain('baselineRef')
  })
})

describe('runSemanticScan', () => {
  it('首次解析失败重试一次，第二次成功', async () => {
    const calls: string[] = []
    const llm = {
      complete: async ({ user }: { system: string; user: string }) => {
        calls.push(user)
        return calls.length === 1
          ? '解析不了的自然语言'
          : '{"findings":[{"type":"unclear","memoryIds":["mem_a"],"summary":"s","suggestedAction":"a"}]}'
      },
    }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed).toBe(false)
    expect(out.findings).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('只输出 JSON')
  })

  it('两次都失败返回 failed:true 空 findings', async () => {
    const llm = { complete: async () => '不是 JSON' }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed).toBe(true)
    expect(out.findings).toEqual([])
  })

  it('LLM 调用抛异常时降级为 failed，不向上抛', async () => {
    const llm = { complete: async () => { throw new Error('rate limited') } }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed).toBe(true)
    expect(out.findings).toEqual([])
  })

  it('超过 SEMANTIC_SCAN_MAX_RECORDS 条时只分析前 200 条，报告 50 条未分析', async () => {
    const records = Array.from({ length: 250 }, (_, i) => record({ id: `mem_${i}` }))
    let analyzedUser = ''
    const llm = {
      complete: async ({ user }: { system: string; user: string }) => {
        analyzedUser = user
        return '{"findings":[]}'
      },
    }
    const out = await runSemanticScan(records, null, llm)
    expect(out.failed).toBe(false)
    expect(out.truncated).toBe(50)
    expect(analyzedUser).toContain(`共 ${SEMANTIC_SCAN_MAX_RECORDS} 条`)
    expect(analyzedUser).not.toContain('mem_249')
  })

  it('首次调用抛异常、重试成功时正常返回', async () => {
    let n = 0
    const llm = {
      complete: async () => {
        n++
        if (n === 1) throw new Error('timeout')
        return '{"findings":[{"type":"unclear","memoryIds":["mem_a"],"summary":"s","suggestedAction":"a"}]}'
      },
    }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed).toBe(false)
    expect(out.findings).toHaveLength(1)
  })

  it('用户取消（signal）时立即抛 AbortError，不重试', async () => {
    const controller = new AbortController()
    let calls = 0
    const llm = {
      complete: async (): Promise<string> => {
        calls++
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      },
    }
    await expect(runSemanticScan([record({ id: 'mem_a' })], null, llm, controller.signal))
      .rejects.toThrow(/abort/i)
    expect(calls).toBe(1) // 取消不触发重试
  })
})

import { describe, expect, it } from 'vitest'
import { buildSemanticPrompt, parseSemanticFindings, runSemanticScan, planSemanticBatches, reportedTokens, semanticMemoryLine, SEMANTIC_BATCH_TOKEN_BUDGET, BASELINE_MAX_CHARS } from '../src/governance/semantic-scan.ts'
import { estimateTokens } from '../src/snapshot.ts'
import type { MemoryRecord } from '../src/record-schema.ts'
import { record } from './helpers/record.ts'
import { FAKE_SECRET } from './helpers/secrets.ts'
import { SECRET_MASK } from '../src/secrets.ts'

describe('buildSemanticPrompt', () => {
  it('user 部分含每条记忆的 id/content，有基线时包含基线内容', () => {
    const { system, user } = buildSemanticPrompt(
      [record({ id: 'mem_a', content: '用 pnpm' })], ['AGENTS.md 内容：包管理用 npm'])
    expect(user).toContain('mem_a')
    expect(user).toContain('用 pnpm')
    expect(user).toContain('包管理用 npm')
    expect(system).toContain('conflict')
    expect(system).toContain('JSON')
  })

  it('表述不清判据：只有一句结论、看不出在什么情况下定的也算，短本身不算', () => {
    const { system } = buildSemanticPrompt([record({ id: 'mem_a' })], null)
    expect(system).toContain('unclear 模糊：新会话没有额外上下文时无法据此行动；或者只有一句结论，看不出是在什么情况下定的，因此判断不了它管到哪里。')
    expect(system).toContain('短本身不算问题；看得出管到哪里、也能照着做的短记忆不报。')
  })

  it('基线里以散文提到私钥 BEGIN 头：遮住这一行的头，后面的规则仍在', () => {
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })],
      [`AGENTS.md 内容：\n- 以 ${FAKE_SECRET.pem} 开头的文件不要提交\n- 包管理用 npm`])
    expect(user).not.toContain(FAKE_SECRET.pem)
    expect(user).toContain('包管理用 npm')
  })

  it('无基线时 user 说明基线缺失，system 要求跳过垂直冲突', () => {
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })], null)
    expect(user).toContain('（无权威配置基线，跳过垂直冲突检测）')
  })

  it('基线超预算时按整条消息从最新往前收，装不下的较早消息整条舍弃并说明', () => {
    const stale = 'Instructions from: AGENTS.md\n\n包管理用 npm'.padEnd(BASELINE_MAX_CHARS, '。')
    const fresh = 'Updated instructions from: AGENTS.md\n\n包管理用 pnpm'
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })], [stale, fresh])
    expect(user).toContain('较早的 1 条指令消息共 8000 字符未纳入垂直冲突检测')
    expect(user).toContain(fresh)
    expect(user).not.toContain('包管理用 npm')
  })

  it('最新一条消息自身超预算时只保留其开头（来源抬头在前），并说明截断', () => {
    const huge = 'Instructions from: AGENTS.md\n\n' + 'x'.repeat(BASELINE_MAX_CHARS + 500)
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })], ['更早的一条', huge])
    expect(user).toContain('最新一条指令消息已截断末尾')
    expect(user).toContain('Instructions from: AGENTS.md')
    expect(user).not.toContain('x'.repeat(BASELINE_MAX_CHARS + 1))
    expect(user).not.toContain('更早的一条')
  })

  it('明确密钥不发给模型：记忆正文、摘要与基线里遮成占位，疑似密钥照原文', () => {
    const { user } = buildSemanticPrompt(
      [record({ id: 'mem_a', content: `网关 key ${FAKE_SECRET.sk}，预发库密码: Abc12345`, summary: `token ${FAKE_SECRET.github}` })],
      [`Instructions from: AGENTS.md\n\nCI 用 ${FAKE_SECRET.aws}`])
    for (const secret of [FAKE_SECRET.sk, FAKE_SECRET.github, FAKE_SECRET.aws]) expect(user).not.toContain(secret)
    expect(user).toContain(`content: 网关 key ${SECRET_MASK}，预发库密码: Abc12345`)
    expect(user).toContain(`summary: token ${SECRET_MASK}`)
    expect(user).toContain(`CI 用 ${SECRET_MASK}`)
  })

  it('两条记忆只差在密钥值：模型看到的两条内容相同，按相同内容判断（不会因密钥值不同报冲突）', () => {
    const other = FAKE_SECRET.sk.replace('TESTONLY', 'TESTONLX')
    const { user } = buildSemanticPrompt([
      record({ id: 'mem_a', content: `网关 key 用 ${FAKE_SECRET.sk}` }),
      record({ id: 'mem_b', content: `网关 key 用 ${other}` }),
    ], null)
    const lines = user.split('\n').filter(l => l.startsWith('  content: '))
    expect(lines).toEqual([`  content: 网关 key 用 ${SECRET_MASK}`, `  content: 网关 key 用 ${SECRET_MASK}`])
  })

  it('基线不超预算时按顺序原样纳入，不带说明', () => {
    const a = 'Instructions from: AGENTS.md\n\n包管理用 pnpm'
    const b = 'Additional instructions from: pkg/AGENTS.md\n\n子包用 vitest'
    const { user } = buildSemanticPrompt([record({ id: 'mem_a' })], [a, b])
    expect(user).toContain(`${a}\n\n${b}`)
    expect(user).not.toContain('基线过长')
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

  it('模型在说明里引用的密钥（两级）换成占位：这些文字会进待决账本、体检缓存和工具输出', () => {
    const raw = JSON.stringify({
      findings: [{
        type: 'conflict', memoryIds: ['mem_a'], baselineRef: `AGENTS.md：${FAKE_SECRET.github}`,
        summary: `两条都写了 ${FAKE_SECRET.sk}`, suggestedAction: '改成 password: Hunter2-2026 之外的写法',
      }],
    })
    const [f] = parseSemanticFindings(raw, known)!
    expect(f).toMatchObject({ summary: `两条都写了 ${SECRET_MASK}`, baselineRef: `AGENTS.md：${SECRET_MASK}` })
    expect(f.suggestedAction).not.toContain('Hunter2-2026')
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

  it('两次都失败返回 failed:true 空 findings，原因是输出解析不了', async () => {
    const llm = { complete: async () => '不是 JSON' }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed).toBe(true)
    expect(out.findings).toEqual([])
    expect(out.failed && out.failure).toEqual({ kind: 'unparseable' })
  })

  it('LLM 调用抛异常时降级为 failed，不向上抛；原因带上错误的原话', async () => {
    const llm = { complete: async () => { throw new Error('rate limited') } }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed).toBe(true)
    expect(out.findings).toEqual([])
    expect(out.failed && out.failure).toEqual({ kind: 'model-error', message: 'rate limited' })
  })

  it('模型调用抛出的错误带宿主错误码：码一路保留到结果里，不在半路吞掉', async () => {
    const llm = { complete: async () => { throw Object.assign(new Error('Sign in to DeepSeek'), { code: 'ACCOUNT_SIGN_IN_REQUIRED' }) } }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed && out.failure).toEqual({ kind: 'model-error', hostCode: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'Sign in to DeepSeek' })
  })

  it('宿主 AUTH 错误不留原话（原话可能回显部分凭据，对齐宿主）：只带错误码', async () => {
    const llm = { complete: async () => { throw Object.assign(new Error('401 invalid key sk-abcdefghijklmnop1234 rejected'), { code: 'AUTH' }) } }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    expect(out.failed && out.failure).toEqual({ kind: 'model-error', hostCode: 'AUTH' })
  })

  it('其他错误的原话先遮掉疑似密钥再保留', async () => {
    const llm = { complete: async () => { throw Object.assign(new Error('bad request: api_key=abcdefghijklmnop1234'), { code: 'SERVER' }) } }
    const out = await runSemanticScan([record({ id: 'mem_a' })], null, llm)
    const failure = out.failed ? out.failure : undefined
    expect(failure).toMatchObject({ kind: 'model-error', hostCode: 'SERVER' })
    expect(failure?.kind === 'model-error' && failure.message).toContain('bad request')
    expect(JSON.stringify(failure)).not.toContain('abcdefghijklmnop1234')
  })

  it('小库不分批：调用一次、批数 1，结果与模型输出一致（不再按 200 条截断）', async () => {
    const records = Array.from({ length: 250 }, (_, i) => record({ id: `mem_${i}` }))
    const users: string[] = []
    const llm = {
      complete: async ({ user }: { system: string; user: string }) => {
        users.push(user)
        return '{"findings":[{"type":"unclear","memoryIds":["mem_249"],"summary":"s","suggestedAction":"a"}]}'
      },
    }
    const out = await runSemanticScan(records, null, llm)
    expect(users).toHaveLength(1)
    expect(users[0]).toContain('共 250 条')
    expect(out).toEqual({ failed: false, batches: 1, findings: [expect.objectContaining({ type: 'unclear', memoryIds: ['mem_249'] })] })
  })

  it('没有记忆：不调用模型，按没有发现的成功扫描返回', async () => {
    const llm = { complete: async (): Promise<string> => { throw new Error('不该被调') } }
    expect(await runSemanticScan([], null, llm)).toEqual({ findings: [], failed: false, batches: 0 })
  })

  // 每条约 6,000 token（一万个汉字），六条装不进 3 万的一批
  const bulky = () => Array.from({ length: 6 }, (_, i) => record({ id: `mem_${i}`, content: '记'.repeat(10_000) }))
  const idsIn = (user: string) => [...user.matchAll(/id=(mem_\d+)/g)].map(m => m[1]!)

  it('超预算时分批：每条都进了某一批，各批结果合并、去重', async () => {
    const records = bulky()
    const users: string[] = []
    const llm = {
      complete: async ({ user }: { system: string; user: string }) => {
        users.push(user)
        // 每批报一条本批的模糊，同一条写两遍
        const f = { type: 'unclear', memoryIds: [idsIn(user)[0]], summary: 's', suggestedAction: 'a' }
        return JSON.stringify({ findings: [f, f] })
      },
    }
    const out = await runSemanticScan(records, null, llm)
    expect(out.failed).toBe(false)
    expect(users.length).toBeGreaterThan(1)
    expect(out.batches).toBe(users.length)
    expect(users.flatMap(idsIn).sort()).toEqual(records.map(r => r.id).sort())
    expect(out.findings.map(f => f.memoryIds[0])).toEqual(users.map(u => idsIn(u)[0]))
  })

  it('一批两次都失败：整层按失败处理，不交出别批的半份结果，也不再发后面的批', async () => {
    let calls = 0
    const llm = {
      complete: async ({ user }: { system: string; user: string }) => {
        calls++
        // 第一批正常，第二批（第 2、3 次调用）都解析不了
        if (calls > 1) return '不是 JSON'
        return JSON.stringify({ findings: [{ type: 'unclear', memoryIds: [idsIn(user)[0]], summary: 's', suggestedAction: 'a' }] })
      },
    }
    const out = await runSemanticScan(bulky(), null, llm)
    expect(out.failed).toBe(true)
    expect(out.findings).toEqual([])
    expect(calls).toBe(3)
  })

  it('成对问题只认同一批里的 id：模型写进别批的 id 时那个 id 被丢掉，冲突不成立', async () => {
    const records = bulky()
    const llm = {
      complete: async ({ user }: { system: string; user: string }) => {
        const ids = idsIn(user)
        const other = records.map(r => r.id).find(id => !ids.includes(id))!
        return JSON.stringify({ findings: [{ type: 'conflict', memoryIds: [ids[0], other], summary: '跨批', suggestedAction: 'a' }] })
      },
    }
    const out = await runSemanticScan(records, null, llm)
    expect(out.failed).toBe(false)
    expect(out.findings).toEqual([])
  })

  it('用量：每次调用（含重试）报的 usage 都交给 onUsage', async () => {
    let n = 0
    const llm = {
      complete: async (_input: { system: string; user: string }, _signal?: AbortSignal, onUsage?: (tokens: number) => void) => {
        n++
        onUsage?.(n * 100)
        return n === 1 ? '不是 JSON' : '{"findings":[]}'
      },
    }
    const used: number[] = []
    await runSemanticScan([record({ id: 'mem_a' })], null, llm, undefined, (t) => { used.push(t) })
    expect(used).toEqual([100, 200])
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

describe('planSemanticBatches', () => {
  const cost = (rs: readonly MemoryRecord[]) => rs.reduce((n, r) => n + estimateTokens(semanticMemoryLine(r)), 0)
  const sized = (id: string, type: string, chars: number) => record({ id, type, content: '记'.repeat(chars) })
  const ids = (batches: MemoryRecord[][]) => batches.map(b => b.map(r => r.id))
  /** 体检发给分批的顺序：治理优先级相同时按更新时间新的在前。 */
  const byRecency = (rs: MemoryRecord[]) => [...rs].sort((a, b) => b.updatedAt - a.updatedAt)
  const where = (batches: MemoryRecord[][]) => new Map(batches.flatMap((b, i) => b.map(r => [r.id, i] as const)))

  it('预算约 3 万 token（snapshot.estimateTokens 估算），装得下就一批、顺序不变', () => {
    expect(SEMANTIC_BATCH_TOKEN_BUDGET).toBe(30_000)
    const records = [sized('a', 'knowledge', 10), sized('b', 'preference', 10), sized('c', 'knowledge', 10)]
    expect(planSemanticBatches(records)).toEqual([records])
  })

  it('没有记忆：不分批，一批都没有', () => {
    expect(planSemanticBatches([])).toEqual([])
  })

  it('分批时按稳定键排：改了一条（更新时间变了、排到最前），别的记忆所在的批不变', () => {
    const types = ['knowledge', 'preference', 'workflow']
    const records = types.flatMap(type => Array.from({ length: 5 }, (_, i) =>
      record({ id: `${type}_${i}`, type, content: '记'.repeat(80), createdAt: 10 + i, updatedAt: 100 + i })))
    const budget = cost(records.slice(0, 7)) // 一类装得下，两类装不下
    const before = where(planSemanticBatches(byRecency(records), budget))
    const edited = records.map(r => r.id === 'preference_2' ? { ...r, updatedAt: 999 } : r)
    expect(where(planSemanticBatches(byRecency(edited), budget))).toEqual(before)
  })

  it('同一类型切成几段时，改了一条，切口不动', () => {
    const records = Array.from({ length: 10 }, (_, i) => record({ id: `k${i}`, type: 'knowledge', content: '记'.repeat(80), createdAt: 10 + i, updatedAt: 100 + i }))
    const budget = cost(records.slice(0, 3)) + 1
    const before = where(planSemanticBatches(byRecency(records), budget))
    const edited = records.map(r => r.id === 'k5' ? { ...r, updatedAt: 999 } : r)
    expect(where(planSemanticBatches(byRecency(edited), budget))).toEqual(before)
  })

  it('装不下：每条恰好进一批，每批不超预算，同类型同批', () => {
    const types = ['knowledge', 'preference', 'workflow']
    const records = types.flatMap(type => Array.from({ length: 5 }, (_, i) => sized(`${type}_${i}`, type, 80)))
    const budget = cost(records.slice(0, 5)) + 50 // 一类装得下，两类装不下
    const batches = planSemanticBatches(records, budget)
    expect(batches).toHaveLength(3)
    expect(batches.flat().map(r => r.id).sort()).toEqual(records.map(r => r.id).sort())
    for (const batch of batches) {
      expect(cost(batch)).toBeLessThanOrEqual(budget)
      expect(new Set(batch.map(r => r.type)).size).toBe(1)
    }
  })

  it('小类型拼进还有空位的批', () => {
    const big = Array.from({ length: 4 }, (_, i) => sized(`k${i}`, 'knowledge', 80))
    const mid = [sized('p0', 'preference', 80)]
    const tiny = [sized('w0', 'workflow', 1)]
    const budget = cost([...big, ...mid]) - 1 // knowledge 与 preference 合起来差一点装不下
    expect(ids(planSemanticBatches([...big, ...mid, ...tiny], budget))).toEqual([['k0', 'k1', 'k2', 'k3', 'w0'], ['p0']])
  })

  it('单个类型超预算再拆：按原顺序连续切，每段不超预算', () => {
    const records = Array.from({ length: 10 }, (_, i) => sized(`k${i}`, 'knowledge', 80))
    const budget = cost(records.slice(0, 3)) + 1
    expect(ids(planSemanticBatches(records, budget))).toEqual([['k0', 'k1', 'k2'], ['k3', 'k4', 'k5'], ['k6', 'k7', 'k8'], ['k9']])
  })

  it('单条自己就超预算：单独一批，照样检查', () => {
    const records = [sized('huge', 'knowledge', 2000), sized('s', 'knowledge', 10)]
    expect(ids(planSemanticBatches(records, 200))).toEqual([['huge'], ['s']])
  })
})

describe('reportedTokens', () => {
  it('有 totalTokens 用它', () => {
    expect(reportedTokens({ inputTokens: 10, outputTokens: 5, totalTokens: 40, cacheReadTokens: 25 })).toBe(40)
  })

  it('没有 totalTokens 时把互不重叠的几项相加（输入、缓存读写、输出）', () => {
    expect(reportedTokens({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 1 })).toBe(36)
    expect(reportedTokens({ inputTokens: 10, outputTokens: 5 })).toBe(15)
  })

  it('数不合法时不算', () => {
    expect(reportedTokens({ inputTokens: Number.NaN, outputTokens: 5 })).toBeUndefined()
    expect(reportedTokens({ inputTokens: -1, outputTokens: 5 })).toBeUndefined()
    expect(reportedTokens({ inputTokens: 1, outputTokens: 5, totalTokens: -3 })).toBeUndefined()
  })
})

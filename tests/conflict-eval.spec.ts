import { describe, expect, it } from 'vitest'
import { CASES, caseSchema, CATEGORIES, SURFACES, CRITERIA } from './fixtures/conflict-eval.ts'
import { classify, score } from '../scripts/conflict-eval/scoring.ts'

describe('冲突复现题集', () => {
  it('题目格式合法，四种发现、三个面、四个判据都有覆盖', () => {
    for (const item of CASES) expect(caseSchema.safeParse(item).success, item.id).toBe(true)
    expect(new Set(CASES.map(c => c.id)).size).toBe(CASES.length)
    for (const category of CATEGORIES) expect(CASES.some(c => c.expected === category)).toBe(true)
    for (const surface of SURFACES) expect(CASES.some(c => c.surface === surface)).toBe(true)
    for (const criterion of CRITERIA) expect(CASES.some(c => c.criterion === criterion)).toBe(true)
    expect(CASES.filter(c => c.expected === 'none').length).toBeGreaterThanOrEqual(4)
    expect(caseSchema.safeParse({ ...CASES[0], expected: 'unknown' }).success).toBe(false)
    expect(caseSchema.safeParse({ ...CASES[0], records: [] }).success).toBe(false)
  })
  it('只按输出的类型归类，不拿说明文字改判', () => {
    expect(classify([{ type: 'conflict', summary: '这是例外，时间变化' }])).toEqual(['contradiction'])
    expect(classify([{ type: 'redundancy' }])).toEqual(['other'])
  })
  it('错分同时计漏报和误报，调用失败单独计数', () => {
    const report = score([
      { expected: 'change', predicted: ['contradiction'], failed: false },
      { expected: 'contradiction', predicted: ['contradiction', 'contradiction'], failed: false },
      { expected: 'none', predicted: [], failed: false },
      { expected: 'exception', predicted: [], failed: true },
    ])
    expect(report.classes.contradiction).toMatchObject({ hits: 1, misses: 0, falsePositives: 1, falsePositiveRate: 1 / 3 })
    expect(report.classes.change).toMatchObject({ hits: 0, misses: 1 })
    expect(report.classes.exception).toMatchObject({ misses: 1 })
    expect(report).toMatchObject({ exact: 2, total: 4, failures: 1 })
  })
})

it('走真实的提示词和解析，不把期望结论交给模型', async () => {
  const { evaluate } = await import('../scripts/eval-conflict.ts')
  const calls: string[] = []
  const report = await evaluate({ model: 'fixture-model', async complete(input) {
    calls.push(input.user)
    return '{"findings":[]}'
  } })
  expect(calls).toHaveLength(CASES.length)
  expect(calls[0]).toContain(CASES[0].records[0].content)
  expect(calls[0]).not.toContain(CASES[0].conclusion)
  expect(report.summary).toMatchObject({ total: CASES.length, failures: 0, exact: 5 })
  expect(report.verticalContradictions.missRate).toBe(1)
})

it('模型调用失败记成失败，不算答对无问题题', async () => {
  const { evaluate } = await import('../scripts/eval-conflict.ts')
  const report = await evaluate({ async complete() { throw new Error('offline') } })
  expect(report.summary).toMatchObject({ failures: CASES.length, exact: 0 })
})

it('带 key 的整套只能手动触发，缺 key 在安装宿主前就退出', async () => {
  const { readFileSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(new URL('../.github/workflows/conflict-eval.yml', import.meta.url), 'utf8'))
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  const result = spawnSync('bash', ['scripts/conflict-eval/run.sh'], {
    env: { ...process.env, DEEPSEEK_API_KEY: '' }, encoding: 'utf8',
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('DEEPSEEK_API_KEY is required')
})

it('缺字段的题不合法；阈值在文件里写死、附理由', async () => {
  const { THRESHOLDS } = await import('../scripts/conflict-eval/thresholds.ts')
  for (const key of ['id', 'surface', 'records', 'baseline', 'expected', 'conclusion']) {
    const incomplete: Record<string, unknown> = { ...CASES[0] }
    delete incomplete[key]
    expect(caseSchema.safeParse(incomplete).success, key).toBe(false)
  }
  for (const category of CATEGORIES) {
    expect(THRESHOLDS[category].minRecall).toBeGreaterThanOrEqual(0.8)
    expect(THRESHOLDS[category].maxFalsePositiveRate).toBeLessThanOrEqual(0.05)
    expect(THRESHOLDS[category].reason.length).toBeGreaterThan(0)
  }
})

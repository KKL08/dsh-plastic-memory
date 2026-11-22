import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { CASES, caseSchema } from '../tests/fixtures/conflict-eval.ts'
import { buildSemanticPrompt, runSemanticScan, type SemanticLlm } from '../src/governance/semantic-scan.ts'
import { classify, score, type Observation } from './conflict-eval/scoring.ts'
import { THRESHOLDS } from './conflict-eval/thresholds.ts'

export async function evaluate(llm: SemanticLlm) {
  const results = []
  for (const fixture of CASES) {
    const item = caseSchema.parse(fixture)
    const responses: string[] = []
    const recording: SemanticLlm = { model: llm.model, async complete(input, signal, onUsage) {
      const raw = await llm.complete(input, signal, onUsage)
      responses.push(raw)
      return raw
    } }
    let result: Awaited<ReturnType<typeof runSemanticScan>>
    try {
      result = await runSemanticScan(item.records, item.baseline, recording, AbortSignal.timeout(180_000))
    } catch {
      result = { failed: true, findings: [], batches: 0, failure: { kind: 'model-error', message: 'Request aborted or timed out' } }
    }
    const observation: Observation = { expected: item.expected, predicted: classify(result.findings), failed: result.failed }
    results.push({ id: item.id, surface: item.surface, criterion: item.criterion, conclusion: item.conclusion,
      ...observation, result, responses })
  }
  const vertical = results.filter(r => r.expected === 'contradiction' && CASES.find(c => c.id === r.id)!.baseline !== null)
  const verticalMisses = vertical.filter(r => r.failed || !r.predicted.includes('contradiction')).length
  return { model: llm.model, thresholds: THRESHOLDS, summary: score(results),
    verticalContradictions: { total: vertical.length, misses: verticalMisses, missRate: verticalMisses / vertical.length },
    results }
}

export async function saveEvaluation(llm: SemanticLlm) {
  const report = await evaluate(llm)
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const metadata = { createdAt: new Date().toISOString(), datasetHash: hash(JSON.stringify(CASES)),
    promptHash: hash(buildSemanticPrompt([], null).system),
    scanHash: hash(await readFile(new URL('../src/governance/semantic-scan.ts', import.meta.url), 'utf8')) }
  const directory = new URL('../output/conflict-eval/', import.meta.url)
  await mkdir(directory, { recursive: true })
  const filename = process.env.CONFLICT_EVAL_REPORT ?? `${metadata.createdAt.replaceAll(':', '-')}.json`
  if (!/^[a-zA-Z0-9.-]+\.json$/.test(filename)) throw new Error('Invalid report filename')
  const path = new URL(filename, directory)
  await writeFile(path, JSON.stringify({ ...metadata, ...report }, null, 2) + '\n', { mode: 0o600 })
  console.table(report.summary.classes)
  console.log(JSON.stringify({ total: report.summary.total, exact: report.summary.exact, failures: report.summary.failures,
    cleanFalsePositives: report.summary.cleanFalsePositives, verticalContradictions: report.verticalContradictions }))
  console.log(`Report: ${path.pathname}`)
  return report.summary.failures > 0 ? 1 : 0
}

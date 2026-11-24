import { describe, it, vi } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import fc from 'fast-check'
import { decodeFile } from '../src/storage/frontmatter.ts'
import { ARCHIVE_DIR, GLOBAL_DIR, isMemoryFileName, workspaceDirName } from '../src/storage/paths.ts'
import { resolveDuplicates } from '../src/storage/table.ts'
import { isPendingDelegated } from '../src/record-schema.ts'
import { memberLine } from '../src/topic-index.ts'
import { indexText, indexedIds } from './helpers/topic-index.ts'
import { interleaveParams, interleaveRuns, interleaveScheduler, observeConcurrent, scheduleTrace } from './helpers/interleave.ts'
import { W, externalOpArb, labelOf, memorySubject, seedArb, writeOpArb, type MemoryWorld } from './helpers/memory-subject.ts'

// 文件系统是进程边界：存储层 import 的 node:fs/promises 换成夹具包过的那份，调用的全序交给调度器（见 helpers/interleave.ts）
vi.mock('node:fs/promises', async () => (await import('./helpers/interleave.ts')).interleavedFs)

// 缺省次数下整个文件在跑全量测试的负载下也在 5 秒内；调大 PM_INTERLEAVE_RUNS 时按次数放宽
const TIMEOUT_MS = Math.max(20_000, interleaveRuns() * 600)

describe('IL-04 外部写者', () => {
  /** 本插件的写入抛出的、调用方按约定处理的错误；其他错误算未处理的异常。 */
  const EXPECTED_ERRORS = /^(RecordNotFoundError|ConcurrentModificationError):/

  /** 一个目录的主题索引与该目录顶层在用文件一致：每条在用、已进主档的记忆一行（过期的也有），行链到它的文件名。 */
  async function indexMismatch(w: MemoryWorld, dir: string): Promise<string | undefined> {
    const { records } = await w.store.readRaw(dir === join(w.root, GLOBAL_DIR) ? { kind: 'global' } : { kind: 'workspace', workspacePath: W })
    const expected = resolveDuplicates(records.filter(l => l.dir === dir && l.record.status === 'active' && !isPendingDelegated(l.record)))
    const listed = [...await indexedIds(dir)].sort()
    const ids = expected.map(l => l.record.id).sort()
    if (!isDeepStrictEqual(listed, ids)) return `${dir} 的主题索引与文件不一致：列出 ${JSON.stringify(listed)}，应为 ${JSON.stringify(ids)}`
    const text = await indexText(dir)
    const stale = expected.filter(({ record: r, filePath }) => !text.includes(memberLine({ id: r.id, name: r.name, summary: r.summary, fileName: basename(filePath) })))
    return stale.length === 0 ? undefined : `${dir} 的主题索引里这几条的名称、摘要或文件名没跟上：${stale.map(l => l.record.id).join(', ')}`
  }

  it('IL-04：IL-01 的操作夹着不拿锁的原始改写：不崩、无残留、文件都能解析、下一次维护后索引与文件一致', async () => {
    await fc.assert(
      fc.asyncProperty(seedArb, fc.array(writeOpArb, { minLength: 1, maxLength: 2 }), externalOpArb, fc.nat(), interleaveScheduler(),
        async (seed, writes, external, at, s) => {
          const ops = [...writes]
          ops.splice(at % (writes.length + 1), 0, external)
          const problems: string[] = []
          const run = await observeConcurrent(memorySubject(seed), s, ops, async w => {
            for (const rel of await listMemoryFiles(w.root)) {
              const decoded = decodeFile(await readFile(join(w.root, rel), 'utf8'), { path: rel, loc: { scope: 'global' } })
              if (!decoded.ok) problems.push(`解析失败：${rel}（${decoded.error}）`)
            }
            await w.store.maintain({ kind: 'visible', workspacePath: W })
            for (const dir of [join(w.root, GLOBAL_DIR), join(w.root, workspaceDirName(W))]) {
              const mismatch = await indexMismatch(w, dir)
              if (mismatch !== undefined) problems.push(mismatch)
            }
          })
          if (run.leftover.length > 0) problems.push(`残留临时文件：${run.leftover.join(', ')}`)
          if (run.unhandled.length > 0) problems.push(`未处理的拒绝：${run.unhandled.join('; ')}`)
          for (const [i, o] of run.outcomes.entries()) {
            if ('error' in o && !EXPECTED_ERRORS.test(o.error)) problems.push(`op${i} 抛出：${o.error}`)
          }
          if (problems.length > 0) {
            throw new Error([...problems, `操作：${ops.map((op, i) => `op${i}:${labelOf(op)}`).join(' | ')}`, `调度报告：\n  ${scheduleTrace(s).join('\n  ')}`].join('\n'))
          }
        }),
      interleaveParams(),
    )
  }, TIMEOUT_MS)
})

/** 记忆根下全部记忆文件（顶层与 .archive/，不含索引），相对路径。 */
async function listMemoryFiles(root: string): Promise<string[]> {
  const out: string[] = []
  for (const top of [GLOBAL_DIR, workspaceDirName(W)]) {
    for (const rel of [top, join(top, ARCHIVE_DIR)]) {
      const names = await readdir(join(root, rel)).catch(() => [] as string[])
      out.push(...names.filter(isMemoryFileName).map(n => join(rel, n)))
    }
  }
  return out.sort()
}

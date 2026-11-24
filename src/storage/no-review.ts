import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { STATE_DIR } from './paths.ts'
import { atomicWrite, errnoCode } from './state-files.ts'

/**
 * 「不回看」清单：用户不让回看的会话。存在 `.state/no-review/<sha1(会话 id)>.json`，每个会话一个文件，
 * 几个进程共用一份，每次现读，不缓存。
 *
 * 它是一道访问限制，读法比别的状态文件严：只有确认文件不存在才算没标。文件在（哪怕内容坏了）就算标了；
 * 目录读不了、文件读不出来一律抛错，由调用方按「这一次用不了」处理，不当成没标放行。
 */

const NO_REVIEW_DIR = 'no-review'

/** 清单的一条：sessionId 是用户不让回看的会话，markedAt 是标记的时刻（毫秒）。不带原因和范围。 */
const noReviewMarkSchema = z.object({ sessionId: z.string(), markedAt: z.number() })

const fileOf = (sessionId: string) => `${createHash('sha1').update(sessionId).digest('hex')}.json`

export class NoReviewList {
  private readonly dir: string
  private readonly onMarked: (sessionId: string) => void

  /** onMarked：标上之后调，用来清掉已经收进本机的这个会话的对话记录。 */
  constructor(memoryRoot: string, onMarked: (sessionId: string) => void = () => {}) {
    this.dir = join(memoryRoot, STATE_DIR, NO_REVIEW_DIR)
    this.onMarked = onMarked
  }

  async isMarkedNoReview(sessionId: string): Promise<boolean> {
    try {
      await readFile(join(this.dir, fileOf(sessionId)))
      return true
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false
      throw err
    }
  }

  /** 清单里的全部会话 id。有一条读不出是谁，整份清单就不可信，抛错。 */
  async sessionIds(): Promise<Set<string>> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return new Set()
      throw err
    }
    const ids = new Set<string>()
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      let text: string
      try {
        text = await readFile(join(this.dir, name), 'utf8')
      } catch (err) {
        // 列目录之后被取消标记的
        if (errnoCode(err) === 'ENOENT') continue
        throw err
      }
      ids.add(noReviewMarkSchema.parse(JSON.parse(text)).sessionId)
    }
    return ids
  }

  /** 标成不回看；已经标过的保留原来的时刻。 */
  async mark(sessionId: string, now: number): Promise<void> {
    if (!(await this.isMarkedNoReview(sessionId))) {
      await mkdir(this.dir, { recursive: true })
      await atomicWrite(join(this.dir, fileOf(sessionId)), JSON.stringify({ sessionId, markedAt: now }))
    }
    this.onMarked(sessionId)
  }

  async unmark(sessionId: string): Promise<void> {
    await rm(join(this.dir, fileOf(sessionId)), { force: true })
  }
}

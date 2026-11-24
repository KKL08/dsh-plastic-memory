import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoReviewList } from '../src/storage/no-review.ts'
import { sessionFacts } from '../src/tools/session-access.ts'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pm-no-review-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const dir = () => join(root, '.state', 'no-review')

describe('「不回看」清单', () => {
  it('标上、查到、列出、取消；重复标保留第一次的时刻；另一个进程读同一份', async () => {
    const list = new NoReviewList(root)
    expect(await list.isMarkedNoReview('s1')).toBe(false)
    expect(await list.sessionIds()).toEqual(new Set())
    await list.mark('s1', 100)
    await list.mark('s1', 200)
    await list.mark('会话/二', 300)
    const files = await readdir(dir())
    expect(files).toHaveLength(2)
    const marks = await Promise.all(files.map(async f => JSON.parse(await readFile(join(dir(), f), 'utf8'))))
    expect(marks).toContainEqual({ sessionId: 's1', markedAt: 100 })
    const other = new NoReviewList(root)
    expect(await other.sessionIds()).toEqual(new Set(['s1', '会话/二']))
    await other.unmark('s1')
    expect(await list.isMarkedNoReview('s1')).toBe(false)
    expect(await list.sessionIds()).toEqual(new Set(['会话/二']))
  })

  it('标上之后通知一次调用方，已经标过的再标也通知（清理可以重做）', async () => {
    const dropped: string[] = []
    const list = new NoReviewList(root, id => { dropped.push(id) })
    await list.mark('s1', 1)
    await list.mark('s1', 2)
    expect(dropped).toEqual(['s1', 's1'])
  })

  it('标记文件坏了：这个会话仍算标了；列全部时抛错，不当成没人标', async () => {
    const list = new NoReviewList(root)
    await list.mark('s1', 1)
    const [file] = await readdir(dir())
    await writeFile(join(dir(), file!), '{ not json')
    expect(await list.isMarkedNoReview('s1')).toBe(true)
    await expect(list.sessionIds()).rejects.toThrow()
  })

  it('清单读不了（目录的位置上是别的东西）：抛错，不当成没标', async () => {
    await mkdir(join(root, '.state'), { recursive: true })
    await writeFile(dir(), 'not a directory')
    const list = new NoReviewList(root)
    await expect(list.isMarkedNoReview('s1')).rejects.toThrow()
    await expect(list.sessionIds()).rejects.toThrow()
  })

  it('会话的读取事实带上是否标了不回看；没给清单时是没标', async () => {
    const list = new NoReviewList(root)
    await list.mark('s1', 1)
    const host = { readSessionLog: async () => ({ header: { id: 's1' }, inheritedEventCount: 0, events: [] }) }
    expect(await sessionFacts('s1', host, list)).toMatchObject({ exists: true, isMarkedNoReview: true })
    expect(await sessionFacts('s2', host, list)).toMatchObject({ isMarkedNoReview: false })
    expect(await sessionFacts('s1', host)).toMatchObject({ isMarkedNoReview: false })
  })
})

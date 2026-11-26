import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckupCache, type CheckupCacheRow } from '../src/storage/checkup-cache.ts'
import { DerivedIndex } from '../src/storage/derived-index.ts'
import { CHECKUP_CACHE_FILE, DERIVED_INDEX_FILE } from '../src/storage/paths.ts'

// 体检结果库：真 node:sqlite、临时目录。「另一个进程」用同一路径上的第二个实例模拟。

let dir: string
const opened: Array<{ close(): void }> = []
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'pm-checkup-cache-')) })
afterEach(async () => {
  for (const db of opened.splice(0)) db.close()
  await rm(dir, { recursive: true, force: true })
})

const cachePath = () => join(dir, CHECKUP_CACHE_FILE)
function open() {
  const warnings: string[] = []
  const log = { info: () => {}, warn: (m: string) => { warnings.push(m) }, error: (m: string) => { warnings.push(m) } }
  const cache = new CheckupCache({ path: cachePath(), log })
  opened.push(cache)
  return { cache, warnings }
}
const row = (key: string, checkedAt = 100, extra: Partial<CheckupCacheRow> = {}): CheckupCacheRow =>
  ({ key, checkedAt, members: [['["global","mem_a"]', 'fp-a']], result: [], ...extra })

describe('体检结果库', () => {
  it('派生索引库的版本号和表没变：体检结果库是另一个文件，派生索引库里没有它的表', async () => {
    const index = new DerivedIndex({ path: join(dir, DERIVED_INDEX_FILE), log: { info() {}, warn() {}, error() {} } })
    opened.push(index)
    index.replaceLevel('/root/global', { mtimeMs: 1, ino: 1, scannedAt: 1, listing: 'x' }, [['a.md', 'mem_a', 'sig']], undefined)
    const { cache } = open()
    expect(cache.write('global', row('k1'))).toBe(true)
    index.close()
    const raw = new DatabaseSync(join(dir, DERIVED_INDEX_FILE))
    try {
      expect((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name)
      expect(tables).toEqual(['id_hints', 'level_scans', 'link_files', 'link_levels', 'links', 'topic_aliases', 'topic_members', 'topic_pages'])
    } finally {
      raw.close()
    }
  })

  it('写进去的行原样读回；同轮同键的后写的覆盖先写的；没用过时不建库', () => {
    const { cache } = open()
    expect(existsSync(cachePath())).toBe(false)
    expect(cache.write('global', row('k1', 100))).toBe(true)
    expect(cache.write('global', row('k1', 200))).toBe(true)
    expect(cache.write('/w', row('k2'))).toBe(true)
    expect(cache.readRound('global')).toEqual({ rows: [row('k1', 200)], recheckBefore: 0 })
    const { cache: other } = open()
    expect(other.readRound('/w')!.rows.map(r => r.key)).toEqual(['k2'])
    expect(other.rounds()!.sort()).toEqual(['/w', 'global'])
  })

  it('全部重查的时刻：早于它查的结论读出来照旧有，命中由调用方按时刻判；清理删掉被作废的行和不晚于它的时刻', () => {
    const { cache } = open()
    cache.write('global', row('old', 100))
    cache.write('global', row('stale', 150))
    expect(cache.markRecheck(['global', 'cross-ws'], 200)).toBe(true)
    cache.write('global', row('new', 300))
    expect(cache.readRound('global')!.recheckBefore).toBe(200)
    cache.prune('global', new Set(['old', 'new']), 200)
    expect(cache.readRound('global')).toEqual({ rows: [row('new', 300)], recheckBefore: 0 })
    // 别处又点了更晚的全部重查：这次的清理不删它
    cache.markRecheck(['global'], 500)
    cache.prune('global', new Set(['new']), 200)
    expect(cache.readRound('global')!.recheckBefore).toBe(500)
    cache.dropRound('global')
    expect(cache.readRound('global')).toEqual({ rows: [], recheckBefore: 0 })
    expect(cache.readRound('cross-ws')!.recheckBefore).toBe(200)
  })

  it('清理以这次扫描的开始时刻为界：晚于它查的行留着（别处更新的扫描写的），不晚于它的照旧按键和全部重查时刻删；检查时刻坏了、为空的照旧删', () => {
    const { cache } = open()
    cache.write('global', row('old-other-key', 300))
    cache.write('global', row('at-start', 500))
    cache.write('global', row('newer', 501))
    cache.write('global', row('newer-stale', 600))
    cache.markRecheck(['global'], 550)
    const raw = new DatabaseSync(cachePath())
    raw.prepare('INSERT INTO checks(round, key, checked_at, members_json, result_json) VALUES (?, ?, ?, ?, ?)').run('global', 'time-null', null, '[]', '[]')
    raw.prepare('INSERT INTO checks(round, key, checked_at, members_json, result_json) VALUES (?, ?, ?, ?, ?)').run('global', 'time-real', 900.5, '[]', '[]')
    raw.prepare('INSERT INTO checks(round, key, checked_at, members_json, result_json) VALUES (?, ?, ?, ?, ?)').run('global', 'time-text', 'x', '[]', '[]')
    cache.prune('global', new Set(['at-start']), 550, 500)
    const left = (raw.prepare('SELECT key FROM checks WHERE round = ? ORDER BY key').all('global') as Array<{ key: string }>).map(r => r.key)
    raw.close()
    expect(left).toEqual(['newer', 'newer-stale'])
  })

  it('全部重查的时刻只往后挪：再记一个更早的不改；库里这一轮有不早于它查的行时，记在最晚那一行之后', () => {
    const { cache } = open()
    cache.markRecheck(['global'], 500)
    cache.markRecheck(['global'], 100)
    expect(cache.readRound('global')!.recheckBefore).toBe(500)
    cache.write('/w', row('same-ms', 700))
    cache.markRecheck(['/w'], 700)
    expect(cache.readRound('/w')!.recheckBefore).toBe(701)
  })

  it('行的结构校验：成员不是字符串对、检查时刻不是非负整数、JSON 坏了的行读不出来，其余照常', () => {
    const { cache } = open()
    cache.write('global', row('good'))
    for (const [key, members, checkedAt, result] of [
      ['bad-json', '[[', 1, '[]'],
      ['members-null', 'null', 1, '[]'],
      ['members-shape', '[["a"]]', 1, '[]'],
      ['time-negative', '[]', -1, '[]'],
      ['time-text', '[]', 'x', '[]'],
      ['result-bad', '[]', 1, '{坏'],
    ] as const) {
      const raw = new DatabaseSync(cachePath())
      raw.prepare('INSERT INTO checks(round, key, checked_at, members_json, result_json) VALUES (?, ?, ?, ?, ?)').run('global', key, checkedAt, members, result)
      raw.close()
    }
    expect(cache.readRound('global')!.rows.map(r => r.key)).toEqual(['good'])
  })

  it('结构版本和本插件的不一样：只删这个库自己的文件，换新库', async () => {
    const other = join(dir, 'unrelated.txt')
    await writeFile(other, '别的文件')
    const raw = new DatabaseSync(cachePath())
    raw.exec('PRAGMA user_version = 99; CREATE TABLE checks(x)')
    raw.close()
    const { cache } = open()
    expect(cache.write('global', row('k1'))).toBe(true)
    expect(cache.readRound('global')!.rows).toEqual([row('k1')])
    expect(await readFile(other, 'utf8')).toBe('别的文件')
  })

  it('库文件损坏：删掉重建，这一次按库里什么都没有处理', async () => {
    await writeFile(cachePath(), 'not a sqlite database at all, just text padding '.repeat(200))
    const { cache, warnings } = open()
    expect(cache.readRound('global')).toEqual({ rows: [], recheckBefore: 0 })
    expect(cache.write('global', row('k1'))).toBe(true)
    expect(warnings).toEqual([])
  })

  it('node:sqlite 不可用：每次都按库里什么都没有处理，写返回 false，记一条日志', () => {
    const warnings: string[] = []
    const cache = new CheckupCache({ path: cachePath(), log: { info() {}, warn: (m: string) => { warnings.push(m) }, error() {} }, loadSqlite: () => undefined })
    expect(cache.readRound('global')).toBeUndefined()
    expect(cache.write('global', row('k1'))).toBe(false)
    expect(cache.rounds()).toBeUndefined()
    expect(warnings).toHaveLength(1)
  })
})

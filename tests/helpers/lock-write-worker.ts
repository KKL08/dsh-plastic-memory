/**
 * 写锁接入后的双进程写路径子进程脚本（tests/root-lock-wiring.spec.ts 起两份）。文件表按接线层的方式注入真写锁，
 * 写锁外面套一层计时：记下每次 run 从进入到拿到锁等了多久，拿锁超时也记下。
 * 用法：node lock-write-worker.ts <memoryRoot> <标签>
 * 协议：就绪后 stdout 打 `ready`；之后 stdin 每行一条命令，做完回一行：
 *   create <n>   连续 n 次 create 同名（name 都是「抢名」）异 id 的记忆，id 为 mem_<标签><序号>；回 `created`
 *   hammer       不停地改写同一条记忆（不存在就先建；拿锁超时就接着写），直到收到 stop；
 *                回一行 JSON { count, timeouts, maxWaitMs }
 *   stop         让 hammer 停下（hammer 在停下后才回）
 *   probe <n>    依次 create n 条（name 互不相同）：拿锁超时就核对盘上没有这一条、没有临时文件，再重试；
 *                回一行 JSON { waitsMs: number[], timeouts: number, partials: string[] }
 *   soak <ms>    同 probe，只是一直写到满 ms 毫秒（测等待分布用，常规测试不跑）
 * stdin 关闭后进程自然退出。
 */
import { createInterface } from 'node:readline'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FileTable } from '../../src/storage/file-table.ts'
import { createRootLock } from '../../src/storage/root-lock.ts'
import { GLOBAL_DIR } from '../../src/storage/paths.ts'
import { RootLockTimeoutError } from '../../src/errors.ts'
import type { RootLock } from '../../src/root-lock.ts'
import type { RecallStats } from '../../src/storage/schema.ts'
import { record } from './record.ts'
import { InMemoryKvTable } from './in-memory-kv.ts'

const [root, tag] = process.argv.slice(2)
if (root === undefined || tag === undefined) throw new Error('usage: lock-write-worker.ts <root> <tag>')

const toStderr = (message: string) => { process.stderr.write(`${message}\n`) }
const log = { info: () => {}, warn: toStderr, error: toStderr }
const waitsMs: number[] = []
const real = createRootLock({ root, log })
const lock: RootLock = {
  run(fn) {
    const enteredAt = performance.now()
    return real.run(() => {
      waitsMs.push(performance.now() - enteredAt)
      return fn()
    })
  },
}
const table = new FileTable({ root, lock, log, stats: new InMemoryKvTable<RecallStats>() })
const say = (line: string) => { process.stdout.write(`${line}\n`) }

let isStopping = false
let seq = 0
const nextId = () => `mem_${tag}${String(seq++).padStart(5, '0')}`

/** 写一条新记忆；拿锁超时就核对没有半截写入再重试。 */
async function createProbing(out: { timeouts: number; partials: string[] }) {
  const own = record({ id: nextId(), name: `探针 ${tag} ${seq}`, content: `进程 ${tag} 的第 ${seq} 条`, updatedAt: Date.now() })
  for (;;) {
    try {
      await table.create(own)
      return
    } catch (err) {
      if (!(err instanceof RootLockTimeoutError)) throw err
      out.timeouts++
      if (await table.locate(own.id, {}) !== undefined) out.partials.push(`${own.id} 已在盘上`)
      const tmps = (await readdir(join(root, GLOBAL_DIR)).catch(() => [] as string[])).filter(n => n.includes('.tmp-'))
      if (tmps.length > 0) out.partials.push(...tmps)
    }
  }
}

async function handle(line: string): Promise<void> {
  const [cmd, arg] = line.split(' ')
  if (cmd === 'create') {
    for (let i = 0; i < Number(arg); i++) {
      await table.create(record({ id: nextId(), name: '抢名', content: `进程 ${tag} 的第 ${i} 条`, updatedAt: Date.now() }))
    }
    say('created')
  } else if (cmd === 'hammer') {
    const id = `mem_${tag}_hot`
    await table.create(record({ id, name: `热点 ${tag}`, content: '0', updatedAt: Date.now() }))
    waitsMs.length = 0
    let count = 0
    let timeouts = 0
    while (!isStopping) {
      try {
        await table.update(id, {}, r => ({ ...r, content: String(count + 1), updatedAt: Date.now() }))
        count++
      } catch (err) {
        if (!(err instanceof RootLockTimeoutError)) throw err
        timeouts++
      }
    }
    say(JSON.stringify({ count, timeouts, maxWaitMs: Math.max(0, ...waitsMs) }))
  } else if (cmd === 'stop') {
    isStopping = true
  } else if (cmd === 'probe' || cmd === 'soak') {
    waitsMs.length = 0
    const out = { timeouts: 0, partials: [] as string[] }
    const until = cmd === 'soak' ? performance.now() + Number(arg) : undefined
    for (let i = 0; until === undefined ? i < Number(arg) : performance.now() < until; i++) await createProbing(out)
    say(JSON.stringify({ waitsMs, ...out }))
  } else {
    throw new Error(`未知命令：${line}`)
  }
}

createInterface({ input: process.stdin }).on('line', line => { void handle(line) })
say('ready')

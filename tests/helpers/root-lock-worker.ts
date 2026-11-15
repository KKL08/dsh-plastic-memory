/**
 * 写锁跨进程用例的子进程脚本：真 RootLock 外面套屏障装饰器（lock-barrier.ts）。
 * 用法：node root-lock-worker.ts <memoryRoot> <信号目录> <标签> <pause|nopause>
 * 协议：就绪后 stdout 打 `ready`；stdin 每行一条命令，命令之间不互相等待：
 *   run   在锁内执行一次空操作，完成后回 `ran <n>`（n 从 1 数）。pause 模式下第 n 次停在屏障，
 *         拿到锁时发 `<标签>.<n>.held`，等 `<标签>.<n>.go` 再继续。
 *   warn  发一条与 SQLite 无关的 ExperimentalWarning，回 `warned`。
 * 写锁的告警写 stderr。stdin 关闭后进程自然退出。
 */
import { createInterface } from 'node:readline'
import { createRootLock } from '../../src/storage/root-lock.ts'
import { barrierLock } from './lock-barrier.ts'

const [root, signalDir, tag, mode] = process.argv.slice(2)
if (root === undefined || signalDir === undefined || tag === undefined || (mode !== 'pause' && mode !== 'nopause')) {
  throw new Error('usage: root-lock-worker.ts <root> <signalDir> <tag> <pause|nopause>')
}

const toStderr = (message: string) => { process.stderr.write(`${message}\n`) }
const lock = barrierLock(
  createRootLock({ root, log: { info: () => {}, warn: toStderr, error: toStderr } }),
  { dir: signalDir, name: tag, pause: () => mode === 'pause' },
)

let runs = 0
createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'run') {
    const n = ++runs
    void lock.run(async () => {}).then(() => { process.stdout.write(`ran ${n}\n`) })
  } else if (line === 'warn') {
    process.emitWarning('别的实验特性', 'ExperimentalWarning')
    process.stdout.write('warned\n')
  } else {
    throw new Error(`未知命令：${line}`)
  }
})
process.stdout.write('ready\n')

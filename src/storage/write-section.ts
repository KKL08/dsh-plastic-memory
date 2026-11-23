import { AsyncLocalStorage } from 'node:async_hooks'
import { RootLockTimeoutError } from '../errors.ts'
import type { RootLock, SectionLock } from '../root-lock.ts'

/** 一个写入段：在跑的这段时间 isActive 为真；段内的再进排在它自己的 tail 上。parent 是它所在的外层段（顶层段没有）。 */
interface Section {
  isActive: boolean
  tail: Promise<unknown>
  parent?: Section
}

/**
 * 写入段：插件对记忆根的写入都在一段里，同一进程里一段一段来，段内再进不等自己。
 *
 * - 顶层的段排进程内的总队，轮到了才拿跨进程锁（crossProcess），段走完就放：一长串排着队的写入不会一直占着锁，
 *   别的进程在段与段之间插得进来。跨进程锁不可用时它直接执行 fn，进程内照样一段一段来。
 * - 段内再进（异步调用链上还在这一段里）不再排总队、不再拿锁，排在所在段自己的队里：同一段里同时发起的几次再进按调用顺序一个个来。
 *   段里发起、没等的再进也做完，这一段才算走完、才放锁。
 * - 「还在这一段里」按异步上下文认（AsyncLocalStorage）。段走完之后，段里留下的回调（定时器、没等的 Promise）再进，
 *   这一段已经不在跑了，算在还在跑的最近一层外层段里；外层也都走完了，就按新来的排总队。
 * - 段里等一个段外发起、又要进写入段的操作会互相等。会被段内等待的初始化屏障走 runUnqueued，不排队。
 */
export class WriteSection implements SectionLock {
  private readonly current = new AsyncLocalStorage<Section>()
  private readonly top: Section = { isActive: true, tail: Promise.resolve() }
  private readonly crossProcess: RootLock
  /** 顶层段拿跨进程锁超时的次数和最近那次的错误：排队期间超时过的段不再自己去拿，一起按这次超时失败。 */
  private timeouts = 0
  private lastTimeout: unknown
  /** 顶层的段开始执行前先跑的钩子（见 RootLock.onEnter）。 */
  private readonly enterHooks: Array<() => Promise<void>> = []

  constructor(crossProcess: RootLock) {
    this.crossProcess = crossProcess
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    let owner = this.current.getStore()
    while (owner !== undefined && !owner.isActive) owner = owner.parent
    owner ??= this.top
    const section: Section = { isActive: false, tail: Promise.resolve(), parent: owner === this.top ? undefined : owner }
    let isEntered = false
    const body = async () => {
      isEntered = true
      section.isActive = true
      try {
        return await this.current.run(section, async () => {
          if (owner === this.top) await this.runEnterHooks()
          return fn()
        })
      } finally {
        // 段里发起、没等的再进排在这一段的队上：它们也做完，这一段才算走完、才放锁
        for (let tail = section.tail; ; tail = section.tail) {
          await tail
          if (tail === section.tail) break
        }
        section.isActive = false
      }
    }
    const enter = owner === this.top ? this.acquiring(body, () => isEntered) : body
    const next = owner.tail.then(enter, enter)
    owner.tail = next.catch(() => {})
    return next
  }

  /** 顶层段的入口：拿跨进程锁再跑。排队期间有段拿锁超时，就不再拿、一起按那次超时失败（跨进程锁一层「同一次获取的等待者一起超时」），
   *  一串排着的写入在锁被别处占住时总共只等一轮上限。段里自己抛出的超时不算。 */
  private acquiring<T>(body: () => Promise<T>, hasEntered: () => boolean): () => Promise<T> {
    const seen = this.timeouts
    return async () => {
      if (this.timeouts !== seen) throw this.lastTimeout
      try {
        return await this.crossProcess.run(body)
      } catch (err) {
        if (err instanceof RootLockTimeoutError && !hasEntered()) {
          this.timeouts++
          this.lastTimeout = err
        }
        throw err
      }
    }
  }

  onEnter(hook: () => Promise<void>): void {
    this.enterHooks.push(hook)
  }

  isExclusive(): boolean {
    return this.crossProcess.isExclusive?.() ?? true
  }

  /** 钩子里的写入是这一段的再进。一个钩子抛错不挡别的钩子，也不挡这一段。 */
  private async runEnterHooks(): Promise<void> {
    for (const hook of this.enterHooks) {
      try {
        await hook()
      } catch {
        // 补做失败留给下一次：行还在
      }
    }
  }

  /** 只拿跨进程锁、不排进程内的队：给会被段内等待的初始化屏障用（侧表的旧 KV 导入）。可以和在跑的段同时执行。 */
  runUnqueued<T>(fn: () => Promise<T>): Promise<T> {
    return this.crossProcess.run(fn)
  }
}

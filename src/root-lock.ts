/**
 * 记忆根写锁：插件对记忆根的写入都在锁内（实现在 storage/root-lock.ts，接线层建一个实例注入各写入点）。
 * 读不加锁。持锁时不等模型、不 sleep。
 */
export interface RootLock {
  /** 在写锁内执行 fn。写入点拿到的是写入段（storage/write-section.ts）：跨进程互斥，同一进程里也一段一段来，段内再进不等待；
   *  只有跨进程那一层（createCrossProcessLock）同一实例内可并发进入。拿锁超时抛 RootLockTimeoutError，fn 不执行。 */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** 跨进程互斥此刻是否有效；锁库用不了、退回进程内保护后为 false。没有这个方法的实现按有效算。 */
  isExclusive?(): boolean
  /**
   * 登记一个钩子：每次顶层的段拿到锁、开始执行之前先跑它（段内再进不跑）。操作日志用它补做被打断的写入。
   * 钩子抛错不挡这一段。没有段的概念的实现可以不提供。
   */
  onEnter?(hook: () => Promise<void>): void
}

/**
 * 写入段的锁（storage/write-section.ts）：在 run 之外多一个只拿跨进程锁、不排进程内队的入口，给会被段内等待的初始化屏障用。
 * 侧表要的是它：导入屏障若走 run，段内等导入、导入排在这一段后面，互相等。给它包一层的锁要把这个入口也转过去。
 */
export interface SectionLock extends RootLock {
  runUnqueued<T>(fn: () => Promise<T>): Promise<T>
}

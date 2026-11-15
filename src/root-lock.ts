/**
 * 记忆根写锁：跨进程互斥，插件对记忆根的写入都在锁内（实现在 storage/root-lock.ts，接线层建一个实例注入各写入点）。
 * 读不加锁。持锁时不等模型、不 sleep。
 */
export interface RootLock {
  /** 在写锁内执行 fn。同一实例内可嵌套、可并发进入（按持有计数），不提供进程内互斥。
   *  拿锁超时抛 RootLockTimeoutError，fn 不执行。 */
  run<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * 宿主 ConfigForm 的内存假实现（宿主 settings 远程调用是进程边界）。行为对照 ui-settings ConfigFormController：
 * mutate 带的 revision 和当前不一致 → 拒绝（宿主重读后 revision 就是别处改过的那个）；
 * `rejectNext` 模拟宿主校验不过（revision 不变）；接受时按路径落盘、revision + 1、通知订阅者。
 */
import type { ConfigForm, ConfigFormSnapshot, ConfigPathOp } from './config.ts'

export interface FakeConfigForm extends ConfigForm {
  readonly calls: Array<{ ops: ConfigPathOp[]; expectedRevision: number | undefined }>
  /** 别处（另一个标签页、agent、手改 yaml）改了配置：revision + 1。 */
  externalChange(ops: ConfigPathOp[]): void
  /** 下一次 mutate 被宿主校验拒绝。 */
  rejectNext(): void
  readonly value: Record<string, unknown>
}

function apply(value: Record<string, unknown>, ops: readonly ConfigPathOp[]): Record<string, unknown> {
  const next = structuredClone(value)
  for (const op of ops) {
    let cur: Record<string, unknown> = next
    for (const key of op.path.slice(0, -1)) {
      if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {}
      cur = cur[key] as Record<string, unknown>
    }
    const last = op.path[op.path.length - 1]!
    if (op.op === 'set') cur[last] = structuredClone(op.value)
    else delete cur[last]
  }
  return next
}

export const DEFAULT_SECTION = {
  writeMode: 'proactive', snapshotTokenBudget: 4000, snapshotOverflow: 'relax', evidenceLookup: 'strict', template: 'coding',
  customTypes: {}, governance: { enabled: true, health: { sensitivity: 'normal' }, globalPromoteTarget: 'plugin-global' }, memoryRoot: '',
}

export function createFakeConfigForm(init: Partial<ConfigFormSnapshot> & { value?: Record<string, unknown> } = {}): FakeConfigForm {
  let snapshot: ConfigFormSnapshot = {
    status: init.status ?? 'ready', value: init.value ?? structuredClone(DEFAULT_SECTION), revision: init.revision ?? 1, writable: init.writable ?? true,
  }
  const listeners = new Set<() => void>()
  const publish = (next: ConfigFormSnapshot) => { snapshot = next; for (const fn of listeners) fn() }
  const calls: FakeConfigForm['calls'] = []
  let reject = false
  return {
    calls,
    get value() { return snapshot.value as Record<string, unknown> },
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
    async mutate(ops, expectedRevision) {
      calls.push({ ops: structuredClone([...ops]), expectedRevision })
      if (reject) { reject = false; return false }
      if (expectedRevision !== undefined && expectedRevision !== snapshot.revision) return false
      publish({ ...snapshot, value: apply(snapshot.value as Record<string, unknown>, ops), revision: (snapshot.revision ?? 0) + 1 })
      return true
    },
    externalChange(ops) {
      publish({ ...snapshot, value: apply(snapshot.value as Record<string, unknown>, ops), revision: (snapshot.revision ?? 0) + 1 })
    },
    rejectNext() { reject = true },
  }
}

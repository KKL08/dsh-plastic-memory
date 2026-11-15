import type { RootLock } from '../../src/root-lock.ts'
import type { SemanticLlm } from '../../src/governance/semantic-scan.ts'

/**
 * 记录持锁深度的写锁替身：depth 是此刻处在 run 内的写者数（同实例嵌套、并发都各算一层），不跨进程、不互斥。
 * maxDepth 证明这条路径真的进过锁，配合 unlockedModel 钉住「持锁时不等模型」。
 */
export interface DepthLock extends RootLock {
  readonly depth: number
  readonly maxDepth: number
}

export function depthLock(): DepthLock {
  let depth = 0
  let maxDepth = 0
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      maxDepth = Math.max(maxDepth, ++depth)
      try {
        return await fn()
      } finally {
        depth--
      }
    },
    get depth() { return depth },
    get maxDepth() { return maxDepth },
  }
}

/**
 * 假模型：每次被调用时记下写锁此刻的深度（depths），回答由 answer 给（缺省没有发现的体检回答）。
 * 用例断言 depths 全是 0：模型调用期间不持写锁。
 */
export function unlockedModel(lock: DepthLock, answer: (input: { system: string; user: string }) => string = () => '{"findings":[]}') {
  const depths: number[] = []
  const llm: SemanticLlm = {
    model: 'deepseek-v4-flash',
    complete: async input => {
      depths.push(lock.depth)
      return answer(input)
    },
  }
  return { llm, depths }
}

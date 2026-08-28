import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 往 ds 原生全局指令文件 ~/.dsh/AGENTS.md 的专属区块追加记忆（promote 的 agents-md 目标）。
 * 只动 dsh-memory 标记区块内的内容，用户手写的部分一字不碰。
 */
const BLOCK_START = '<!-- dsh-memory:start -->'
const BLOCK_END = '<!-- dsh-memory:end -->'

/** memoryRoot 是 $DSH_HOME/memories，其父目录即 $DSH_HOME，全局指令文件在 $DSH_HOME/AGENTS.md。 */
export function agentsMdPath(memoryRoot: string): string {
  return join(dirname(memoryRoot), 'AGENTS.md')
}

export interface AgentsMdWriter {
  /** 往 dsh-memory 区块追加一行（幂等：同内容不重复）。区块外内容不变；无区块则在末尾创建。 */
  append(line: string): Promise<void>
}

export function createAgentsMdWriter(filePath: string): AgentsMdWriter {
  return {
    async append(line: string): Promise<void> {
      const entry = `- ${line}`
      let existing = ''
      try { existing = await readFile(filePath, 'utf8') } catch { /* 文件不存在，按空处理 */ }

      const startIdx = existing.indexOf(BLOCK_START)
      const endIdx = existing.indexOf(BLOCK_END)
      let next: string
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        // 无有效区块：在文件末尾新建
        const prefix = existing ? (existing.endsWith('\n') ? existing + '\n' : existing + '\n\n') : ''
        next = `${prefix}${BLOCK_START}\n${entry}\n${BLOCK_END}\n`
      } else {
        const inner = existing.slice(startIdx + BLOCK_START.length, endIdx)
        if (inner.includes(entry)) return // 幂等：已有同行不重复
        const before = existing.slice(0, endIdx)
        const after = existing.slice(endIdx)
        next = `${before.endsWith('\n') ? before : before + '\n'}${entry}\n${after}`
      }
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, next, 'utf8')
    },
  }
}

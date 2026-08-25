import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { executeScan, renderScanResult, type ScanToolDeps, type ScanToolResult } from './scan.ts'

/**
 * 把 memory_scan 接到 dsh 框架上。测试只测 scan.ts 纯逻辑，
 * 本文件由 typecheck + 真机冒烟保证（docs/p1-verification.md）。
 */
export function createScanTool(deps: ScanToolDeps): ToolDefinition {
  return defineTool({
    name: 'memory_scan',
    description: '对记忆库做治理扫描。规则层（密钥泄漏/过期/超长/孤儿引用）免费实时；语义层（冲突/冗余/错位/模糊）调用 LLM 深扫，结果缓存供 memory_health 使用，发现的冲突自动登记为待决项。扫描只读不清理——清理动作需向用户呈现 findings 并确认后，用 memory_forget / memory_save / memory_confirm 执行。',
    parameters: {
      scope: { type: 'string', description: '限定某个 workspace 路径，不填扫全库' },
      layers: { type: 'string', enum: ['rule', 'semantic', 'full'], description: '默认 full。rule 免费秒回；semantic 需要 LLM 调用' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderScanResult(value as ScanToolResult) }],
    },
    execute: (args, exec) => executeScan(args, deps, exec) as never,
  })
}

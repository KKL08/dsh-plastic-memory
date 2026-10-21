/**
 * host-smoke 的探针插件（R0 安装冒烟，由 scripts/host-smoke.sh 经 --patch 装在本插件之后）：等宿主 loader 完成，
 * 确认 memory_search 已注册进 ctx.tools——这就是"插件的 apply() 在真宿主里跑过"的证据——把结论写进
 * HOST_SMOKE_OUT，然后让宿主退出。0.2.0 起插件加载期零 I/O，记忆目录不再在加载时出现，不能再拿它当标记。
 * 只看一个工具名、不调用任何工具：工具行为是 host:contract 的事。
 */
import { writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (exit === undefined) throw new Error('host-smoke: launcher must provide ctx.appExit')
  void (async () => {
    await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
    const tools = ctx.get('tools') as { get(name: string): unknown } | undefined
    const detail = tools === undefined ? 'tools service unavailable after loader.await()'
      : tools.get('memory_search') === undefined ? 'memory_search not registered' : 'ok'
    const out = process.env.HOST_SMOKE_OUT
    if (out) writeFileSync(out, `${detail}\n`)
    exit(detail === 'ok' ? 0 : 1)
  })().catch((e: unknown) => {
    process.stderr.write(`host-smoke probe fatal: ${e instanceof Error ? e.stack : String(e)}\n`)
    exit(1)
  })
}

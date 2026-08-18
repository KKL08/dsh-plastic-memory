import type { MemoryStore } from '../store.ts'

/** memory_forget 工具的依赖，纯逻辑层与框架绑定层共用。 */
export interface ForgetToolDeps {
  store: MemoryStore
}

export interface ForgetArgs {
  id: string
  reason: string
}

export interface ForgetResult {
  ok: boolean
  message: string
}

/**
 * memory_forget 工具的真正执行逻辑：软删除目标记忆。
 * 不依赖任何 dsh 框架包，测试直接调它。
 */
export async function executeForget(
  rawArgs: unknown,
  deps: ForgetToolDeps,
): Promise<ForgetResult> {
  const { id, reason } = rawArgs as ForgetArgs
  const ok = await deps.store.softDelete(id)
  if (ok) {
    console.log(`[plastic-memory] 遗忘记忆 ${id}，原因：${reason}`)
  }
  return {
    ok,
    message: ok ? `已遗忘 ${id}。` : `没有找到记忆 ${id}，可能 id 有误或已删除。`,
  }
}

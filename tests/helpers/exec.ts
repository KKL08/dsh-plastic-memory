import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * 带类型的假工具执行上下文。绑定层与工具逻辑只透传 exec——resolveContext / getLlm /
 * getBaseline 的测试桩都忽略它的字段——故这里一次断言到 ToolRunContext 即可，具体字段
 * （如 signal）按需覆盖，替代各 spec 里各自的 `{} as never`。
 */
export function fakeExec(overrides: Partial<ToolRunContext> = {}): ToolRunContext {
  return { signal: new AbortController().signal, ...overrides } as ToolRunContext
}

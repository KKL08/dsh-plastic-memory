/**
 * AGENTS.md/CLAUDE.md 权威基线缓存（设计稿 §3）。
 * dsh 把指令文件作为 user-role 消息注入（source.kind === 'agent-instructions'），
 * 本类从 session/event 流里观察并缓存最新内容。
 * ⚠️ 事件的实际形状（type 值、source.kind 嵌套位置）需真机验证——见 docs/p1-verification.md。
 */
export class BaselineCache {
  private content: string | null = null

  observe(event: { type: string; data?: unknown }): void {
    if (event.type !== 'user/message') return
    const data = event.data as { source?: { kind?: string }; content?: unknown } | undefined
    if (data?.source?.kind !== 'agent-instructions') return
    const raw = data.content
    let next: string | null = null
    if (typeof raw === 'string') {
      next = raw
    } else if (Array.isArray(raw)) {
      next = raw
        .filter((b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map(b => b.text)
        .join('\n')
    }
    // 无可用内容（既非字符串/数组，或提取后为空）时保持缓存不动：
    // get() 的 null 契约表示"未观察到基线"，空串会被下游误读成"基线存在"
    if (next !== null && next.length > 0) {
      this.content = next
    }
  }

  get(): string | null {
    return this.content
  }
}

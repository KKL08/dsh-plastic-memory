/**
 * AGENTS.md/CLAUDE.md 权威基线：从 session.events 按需推导，不再靠 session/event 观察灌缓存。
 * 插件热重载（HMR）后旧注册清理、缓存清空，若靠事件推送灌入，存量 session 的基线永久丢失、
 * 垂直冲突检测静默失效；改为拉模型——get 时直接从 session 的事件流现推，缓存仅按事件数 memoize
 * （events 是追加型数组，length 不变即无新消息，直接返回上次结果，避免每次 scan 重扫全量事件）。
 * 按 session 隔离（WeakMap）：指令内容随 workspace 不同而不同，插件级单槽会让并存会话互相串台——
 * A 项目的扫描拿到 B 项目的基线判垂直冲突，登记错误的待决项。
 */

/**
 * 从 session 事件流推导权威基线。dsh 把指令文件作为 user-role 消息注入
 * （source.kind === 'agent-instructions'，content 为字符串或 text block 数组两种形态）。
 * 从尾部向前扫，命中第一条有内容的 agent-instructions 消息即返回（尾部优先=最新指令胜，
 * 与旧观察模型"后观察覆盖先观察"语义一致）；退化形状（空串/无 text 块）跳过继续向前找
 * （最新一条为空时，仍应回退到更早的真基线，而非把库当作无基线）；全程无命中返回 null。
 */
export function deriveBaseline(events: unknown[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as { type?: string; data?: { source?: { kind?: string }; content?: unknown } } | undefined
    if (ev?.type !== 'user/message') continue
    const data = ev.data
    if (data?.source?.kind !== 'agent-instructions') continue
    const raw = data.content
    let text: string | null = null
    if (typeof raw === 'string') {
      text = raw
    } else if (Array.isArray(raw)) {
      text = raw
        .filter((b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map(b => b.text)
        .join('\n')
    }
    if (text !== null && text.length > 0) return text
  }
  return null
}

/** 从事件流带 memoize 的基线缓存。缓存键是 session 对象，值记录上次扫描时的事件数与结果。 */
export class BaselineCache {
  private bySession = new WeakMap<object, { length: number; baseline: string | null }>()

  /** 该 session 当前基线；null = 尚未注入指令（垂直冲突检测跳过）。
   *  events 是追加型数组：长度与上次扫描相同即无新消息，直接返回缓存；否则重新推导。 */
  get(session: (object & { events?: unknown[] }) | undefined): string | null {
    if (!session) return null
    const events = session.events ?? []
    const cached = this.bySession.get(session)
    if (cached && cached.length === events.length) return cached.baseline
    const baseline = deriveBaseline(events)
    this.bySession.set(session, { length: events.length, baseline })
    return baseline
  }
}

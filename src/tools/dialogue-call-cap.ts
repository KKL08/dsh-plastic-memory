/**
 * 原话检索的连续调用上限：同一会话里含原话的检索，两次清零之间最多拿到 DIALOGUE_CALL_LIMIT 个名额，
 * 用完后这一路不查，结果里写 `dialogue-search-limit` 的说明。
 *
 * - 名额在调用开始时同步占（读计数、加一之间没有 await），并行发起的几次按开始的先后拿；失败的调用也占，占了不退。
 * - 清零只看宿主的会话事件：新的一轮开始（`turn/start`），或一次别的工具调用开始（`tool/call`，
 *   程序工具里的调用是 `tool/ptc-dispatch-start`）。CALL_CAP_NEUTRAL_TOOLS 里的工具开始不算；助手输出文字不算。
 * - 计数按宿主的会话对象分开存，只在本进程的内存里，进程重启就清零；子 agent 会话和主会话各算各的。
 * - 一个会话还没见过任何清零事件时，不知道上一次清零在哪：照给名额、不计数，后果只是多给几次检索。
 */

/** 两次清零之间最多拿到几个名额。原话检索的连续调用上限是 3 次。 */
export const DIALOGUE_CALL_LIMIT = 3

/**
 * 开始时不算「别的工具调用」的工具名：记忆检索、看原话的 memory_source，加上宿主的程序工具 run_code
 * （程序里调的每个工具另有一条 `tool/ptc-dispatch-start`，按它里面的工具名判断）。
 */
export const CALL_CAP_NEUTRAL_TOOLS: ReadonlySet<string> = new Set(['memory_search', 'memory_source', 'run_code'])

/** 认得的清零事件：新一轮开始、一次工具调用开始、程序工具里的一次调用开始。 */
export const CALL_CAP_RESET_EVENTS = {
  turnStart: 'turn/start',
  toolCall: 'tool/call',
  programToolCall: 'tool/ptc-dispatch-start',
} as const

/** 宿主 `session/event` 里本模块用到的部分：事件类型和载荷（工具调用的载荷里有 `name`）。 */
export interface CallCapEvent {
  type: string
  data?: unknown
}

/**
 * 按会话记连续调用次数。index.ts 把宿主的每条 `session/event` 交给 observe；memory_search 在含原话的检索开始时调 claim。
 */
export class DialogueCallCap {
  private counts = new WeakMap<object, number>()

  /**
   * 看一条宿主会话事件：`turn/start` 清零；`tool/call`、`tool/ptc-dispatch-start` 的工具名不在 CALL_CAP_NEUTRAL_TOOLS 里时清零，
   * 载荷里认不出工具名的也清零。别的事件不理。
   */
  observe(session: object, event: CallCapEvent): void {
    if (event.type === CALL_CAP_RESET_EVENTS.turnStart) {
      this.counts.set(session, 0)
    } else if (event.type === CALL_CAP_RESET_EVENTS.toolCall || event.type === CALL_CAP_RESET_EVENTS.programToolCall) {
      const data = event.data
      const name = typeof data === 'object' && data !== null && 'name' in data ? data.name : undefined
      if (typeof name === 'string' && CALL_CAP_NEUTRAL_TOOLS.has(name)) return
      this.counts.set(session, 0)
    }
  }

  /**
   * 含原话的检索在调用开始、第一次 await 之前调：拿到名额回 true，这一段已用完回 false（不报错，用完不再往上记）。
   * 拿不到会话（undefined），或这个会话还没见过清零事件：回 true，不计数。
   */
  claim(session: object | undefined): boolean {
    if (session === undefined) return true
    const count = this.counts.get(session)
    if (count === undefined) return true
    if (count >= DIALOGUE_CALL_LIMIT) return false
    this.counts.set(session, count + 1)
    return true
  }
}

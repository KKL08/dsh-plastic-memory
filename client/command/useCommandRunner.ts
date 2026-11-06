/**
 * 面板发 `/memory` 命令的一处入口：借来的会话里发命令，按协议（protocol.ts）解释结果，管在途、状态、焦点和确认后重发。
 * 按 key 记状态：待处理卡、对话卡的一行用一个固定 key，列表按条目 / 记忆 id。同一个 key 在途时再点不重发。
 * 开始新动作时收起别的 key 的消息（失败、别处已处理），在途、等确认的照旧；结果回来只动自己的 key。
 * 面板之间的差异都是 run 的显式选项（RunHandlers），不另写一份协议。
 */
import { createContext, useContext, useRef, useState } from 'react'
import type { MemoryCommand } from '../../src/gui/contract.ts'
import { useGateway, type BorrowedSession } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import { keepFocusInPlace } from '../ui/focus-return.ts'
import { interpret, refuseBeforeSend, type Failure, type Ok, type Outcome } from './protocol.ts'

export type RunState = { kind: 'idle' } | { kind: 'busy' } | Exclude<Outcome, { kind: 'ok' }>

export interface RunHandlers {
  /** 成功。command 是实际发出的那条（确认后重发的是改过的命令，例如 forget 改发的 hard-delete）。 */
  onOk?: (result: Ok, command: MemoryCommand) => void
  /** 别处已处理（什么都没动）：给了就交给调用方（提示放在别处，例如卡片外），不给则原位显示。 */
  onHandledElsewhere?: () => void
  /** 失败：'silent' 不显示；函数返回 true 表示调用方已就地处理，不再显示。 */
  onFailed?: 'silent' | ((failure: Failure) => boolean)
}

export interface CommandRunner {
  run(key: string, command: MemoryCommand, handlers?: RunHandlers): void
  stateOf(key: string): RunState
  /** 按钮不可用的原因：没有会话、这一条正在处理或等确认。 */
  unavailable(key: string): string | undefined
  /** 等确认时点「继续处理」「彻底删除」「仍然保存」：发协议给出的重发命令，沿用原来的选项。 */
  confirm(key: string): void
  /** 收起确认或反馈。 */
  cancel(key: string): void
  /** 命令以外的失败（打开文件、写配置）也显示在同一处。 */
  fail(key: string, detail: string): void
}

/**
 * 列表借它在命令进行中把卡片留在原位：宿主可能先推来没有这一条的视图，卡片一卸载焦点就丢了。
 * 命令发出报 true、结果回来报 false；报 false 和成功回调在同一批渲染里。只有待处理列表提供。
 */
export const ItemSending = createContext<(isSending: boolean) => void>(() => {})

const IDLE: RunState = { kind: 'idle' }
const BUSY: RunState = { kind: 'busy' }

/** 这个 key 开始新动作、换成 state：别的 key 的消息收起，在途和等确认的留着。 */
function starting(prev: ReadonlyMap<string, RunState>, key: string, state: RunState): ReadonlyMap<string, RunState> {
  const next = new Map([...prev].filter(([k, s]) => k !== key && (s.kind === 'busy' || s.kind.startsWith('confirm-'))))
  if (state.kind !== 'idle') next.set(key, state)
  return next
}

export function useCommandRunner(session: BorrowedSession): CommandRunner {
  const t = useT()
  const gateway = useGateway()
  const onSending = useContext(ItemSending)
  const [states, setStates] = useState<ReadonlyMap<string, RunState>>(new Map())
  // ref 同步拦截在途，state 只管渲染
  const inFlight = useRef(new Set<string>())
  const handlersOf = useRef(new Map<string, RunHandlers>())

  const clear = (key: string) => {
    setStates((prev) => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }
  const settle = (key: string, outcome: Outcome, handlers: RunHandlers, command: MemoryCommand) => {
    if (outcome.kind === 'ok') { clear(key); handlers.onOk?.(outcome.result, command); return }
    if (outcome.kind === 'handled-elsewhere' && handlers.onHandledElsewhere !== undefined) { clear(key); handlers.onHandledElsewhere(); return }
    if (outcome.kind === 'failed') {
      const { onFailed } = handlers
      if (onFailed === 'silent' || (onFailed !== undefined && onFailed(outcome))) { clear(key); return }
    }
    setStates(prev => new Map(prev).set(key, outcome))
  }
  const run = (key: string, command: MemoryCommand, handlers: RunHandlers = {}) => {
    if (session.kind !== 'ready' || inFlight.current.has(key)) return
    handlersOf.current.set(key, handlers)
    const refused = refuseBeforeSend(command)
    if (refused !== undefined) { setStates(prev => starting(prev, key, refused)); return }
    keepFocusInPlace()
    inFlight.current.add(key)
    setStates(prev => starting(prev, key, BUSY))
    onSending(true)
    void gateway.execute(session.sessionId, command).then((result) => {
      inFlight.current.delete(key)
      onSending(false)
      settle(key, interpret(command, result), handlers, command)
    })
  }
  const stateOf = (key: string) => states.get(key) ?? IDLE
  return {
    run,
    stateOf,
    unavailable(key) {
      if (session.kind !== 'ready') return t('session.none.hint')
      return stateOf(key).kind === 'busy' || stateOf(key).kind.startsWith('confirm-') ? t('pending.busy') : undefined
    },
    confirm(key) {
      const state = stateOf(key)
      if (state.kind === 'confirm-cross' || state.kind === 'confirm-secret' || state.kind === 'confirm-suspected') run(key, state.resend, handlersOf.current.get(key))
    },
    cancel(key) { if (stateOf(key).kind !== 'busy') clear(key) },
    fail(key, detail) { setStates(prev => starting(prev, key, { kind: 'failed', detail, isLocalized: false })) },
  }
}

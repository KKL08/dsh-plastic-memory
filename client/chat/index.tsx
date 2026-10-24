/**
 * 对话里的两层卡：`tool.call.toolview` 按九个工具名注册折叠行；`conversation.chat.turnTail` 注册交付卡，
 * 本轮新记的记忆由会话事件 Definition 挂到 Turn 上。`uiConversation` 是可选服务，没有就不注册交付卡。
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { BindGateway } from '../gateway.ts'
import type { HostContext, RootStandardProps } from '../host.ts'
import { TranslateProvider, useHostTranslate } from '../i18n.tsx'
import { NS } from '../locales.ts'
import { openMemoryPage, type NavStore } from '../nav.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { MemoryToolRow, type MemoryToolViewProps } from './MemoryToolRow.tsx'
import { SAVED_TURN_KEY, savedTurnDefinition, type SavedTurnData, type SavedTurnDefinition } from './saved-turn.ts'
import { SavedMemoriesCard, savedMemoriesCardCss } from './SavedMemoriesCard.tsx'
import { MEMORY_TOOLS } from './tool-summary.ts'

/** 宿主 TurnTailOwnerProps 的结构子集（turn.data 只读本插件的 key）。 */
export interface TurnTailProps extends RootStandardProps {
  sessionId: string
  seq: number
  turn: {
    end?: { seq: number } | undefined
    data: {
      source(key: typeof SAVED_TURN_KEY): { getSnapshot(): SavedTurnData | undefined; subscribe(fn: () => void): () => void }
    }
  }
}

/** 可选服务 uiConversation 就位后的子上下文。 */
export interface ChatContext extends HostContext {
  uiConversation: { events: { register(definition: SavedTurnDefinition): () => void } }
}

function createToolView(ctx: HostContext) {
  return function MemoryToolView(props: MemoryToolViewProps) {
    const t = useHostTranslate(ctx.locale, NS)
    const hostT = useHostTranslate(ctx.locale, 'conversation') as (key: string) => string
    return (
      <TranslateProvider value={t}>
        <MemoryToolRow {...props} hostT={hostT} />
      </TranslateProvider>
    )
  }
}

function createTurnTail(ctx: HostContext, nav: NavStore, bind: BindGateway) {
  const deleted = new Set<string>()
  const openDetail = (target: Parameters<typeof openMemoryPage>[2]) => openMemoryPage(ctx, nav, target)
  return function MemoryTurnTail(props: TurnTailProps) {
    const source = props.turn.data.source(SAVED_TURN_KEY)
    const data = useSyncExternalStore(source.subscribe, source.getSnapshot)
    const end = props.turn.end?.seq ?? props.seq
    const saved = useMemo(() => (data?.saved ?? []).filter(item => item.seq <= end), [data, end])
    const cwd = props.useSessions(s => s.byId[props.sessionId]?.cwd)
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    const t = useHostTranslate(ctx.locale, NS)
    if (saved.length === 0) return null
    return (
      <PanelShell gateway={gateway} t={t} extraCss={savedMemoriesCardCss}>
        <SavedMemoriesCard sessionId={props.sessionId} cwd={cwd} saved={saved} now={Date.now()} openDetail={openDetail} deleted={deleted} />
      </PanelShell>
    )
  }
}

export function registerChatCards(ctx: HostContext, nav: NavStore, bind: BindGateway): void {
  const ToolView = createToolView(ctx)
  ctx.slots.inject('tool.call.toolview', () => {
    const disposers = MEMORY_TOOLS.map(key => ctx.slots.register({ name: 'tool.call.toolview', key }, ToolView))
    return () => { for (const dispose of disposers) dispose() }
  })
  ctx.inject(['uiConversation'], (child) => {
    const chat = child as ChatContext
    chat.uiConversation.events.register(savedTurnDefinition)
    const TurnTail = createTurnTail(chat, nav, bind)
    chat.slots.inject('conversation.chat.turnTail', () => chat.slots.register(
      { name: 'conversation.chat.turnTail', id: 'plastic-memory-saved', order: 30 },
      TurnTail,
    ))
  })
}

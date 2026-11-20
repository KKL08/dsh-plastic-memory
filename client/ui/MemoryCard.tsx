/**
 * 记忆卡（DESIGN.md「Memory Card」，招牌组件）：两行。
 * 第一行记忆原文，左边 2px 银藤竖线；第二行元信息：类型是浅灰胶囊（类型可自定义，配不了各自的图标），
 * 作用域、来源、时间各带一个宿主图标，不再用点分隔。来源图标只分是谁：你、agent、环境，无出处不画。
 * 元信息行只放属性，状态和结果放在卡片下面的建议区、结果行（Advice.tsx）。不套外框和阴影；已过期的原文改次文字色，元信息加「不再带入对话」。
 * 子 agent 写入的记忆在时间后面写第几层、待确认还是谁升的档，和「不再带入对话」一样是次文字，不另配颜色和图标。
 * 记忆文字进视图前服务端已遮盖密钥片段，这里原样显示。
 * collapsible 时原文最多露 COLLAPSED_LINES 行，真的超出才在原文下面给「展开 / 收起」（对齐宿主的折叠按钮）；超没超出靠排版后量高度，不按字数猜。
 * 原文变了（改写、整理、重新遮住密钥）就回到折叠重新量。折叠着的长记忆，原文末尾的标签落在截掉的部分里，按钮旁边再显示一份。
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { formatDay, useT } from '../i18n.tsx'
import { Chip } from './Chip.tsx'
import { Icon, type IconName } from './Icon.tsx'

/** collapsible 时原文最多露几行。 */
const COLLAPSED_LINES = 6

const SOURCE_ICON: Record<NonNullable<MemoryCardData['sourceMode']>, IconName> = {
  'user-explicit': 'user',
  'user-behavior': 'user',
  'agent-inferred': 'sparkle',
  'agent-action-confirmed': 'sparkle',
  'environment-observed': 'code',
}

export interface MemoryCardProps {
  memory: MemoryCardData
  /** 当前时间（毫秒），算「刚刚」「已过期」。 */
  now: number
  /** 类型的显示名；视图只给类型 id，名字由调用方查（缺省显示 id）。 */
  typeLabel?: string
  /** 页面已经交代过类型时不重复（记忆查看里按类型分的组）。 */
  hideType?: boolean
  /** 页面已经交代过作用域时不重复（例如右侧栏里不写「本项目」）。 */
  hideScope?: boolean
  /** 作用域的位置换成这个（「全部」里的下钻链接）；给了就不看 hideScope。 */
  scopeSlot?: ReactNode
  /** 记忆不在借来的会话所在项目里时，作用域写这个项目名，不写「本项目」。 */
  projectName?: string | undefined
  /** 跟在原文末尾的标签（记忆查看里改写过的「已改写」）。 */
  badge?: ReactNode
  /** 很长的原文折叠，可展开（记忆查看、最近删除、处理视图）；右侧栏、对话卡不传。 */
  collapsible?: boolean
}

export function MemoryCard({ memory, now, typeLabel, hideType = false, hideScope = false, scopeSlot, projectName, badge, collapsible = false }: MemoryCardProps) {
  const t = useT()
  const expired = memory.validTo !== undefined && memory.validTo <= now
  const textId = useId()
  const textRef = useRef<HTMLParagraphElement>(null)
  const [isExpanded, setExpanded] = useState(false)
  const [isLong, setLong] = useState(false)
  const [measuredContent, setMeasuredContent] = useState(memory.content)
  if (measuredContent !== memory.content) {
    setMeasuredContent(memory.content)
    setExpanded(false)
  }
  const isClamped = collapsible && !isExpanded
  const hasBadge = badge !== undefined
  useLayoutEffect(() => {
    const el = textRef.current
    if (!isClamped || el === null) return
    const measure = () => { setLong(el.scrollHeight > el.clientHeight + 1) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [isClamped, memory.content, hasBadge])
  const item = (icon: IconName | undefined, text: string) => (
    <span className="pm-mc-item">{icon === undefined ? null : <Icon name={icon} size={13} />}{text}</span>
  )
  return (
    <div className={expired ? 'pm-mc pm-mc--expired' : 'pm-mc'} data-memory-id={memory.id}>
      <p ref={textRef} id={textId} className={isClamped ? 'pm-mc-text pm-mc-text--clamped' : 'pm-mc-text'}>
        {memory.content}{hasBadge ? <span className="pm-mc-badge">{badge}</span> : null}
      </p>
      {collapsible && isLong
        ? (
          <div className="pm-mc-more">
            <button type="button" className="pm-mc-toggle" aria-expanded={isExpanded} aria-controls={textId} onClick={() => { setExpanded(!isExpanded) }}>
              {t(isExpanded ? 'memory.collapse' : 'memory.expand')}
              <Icon name={isExpanded ? 'chevronUp' : 'chevronDown'} size={14} />
            </button>
            {hasBadge && isClamped ? <span className="pm-mc-badge" aria-hidden="true">{badge}</span> : null}
          </div>
        )
        : null}
      <div className="pm-mc-meta">
        {hideType ? null : <Chip variant="neutral">{typeLabel ?? memory.type}</Chip>}
        {scopeSlot !== undefined ? scopeSlot : hideScope ? null : memory.scope === 'global' ? item('globe', t('scope.global')) : item('folder', projectName ?? t('scope.workspace'))}
        {item(memory.sourceMode === undefined ? undefined : SOURCE_ICON[memory.sourceMode], t(memory.sourceMode === undefined ? 'source.none' : `source.${memory.sourceMode}`))}
        {item('clock', formatDay(memory.updatedAt, now, t))}
        {memory.delegation === undefined ? null : item(undefined, t(`memory.delegated.${memory.delegation.reviewed ?? 'pending'}`, { depth: memory.delegation.depth }))}
        {expired ? <span className="pm-mc-item">{t('memory.expired')}</span> : null}
      </div>
    </div>
  )
}

export const memoryCardCss = `
.pm-mc { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pm-mc-text {
  margin: 0; padding-left: 12px; border-left: 2px solid var(--pm-accent);
  font-size: var(--dsh-content-font-size, 14px); line-height: 1.6; color: var(--pm-text);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.pm-mc--expired .pm-mc-text { color: var(--pm-text-2); }
.pm-mc-text--clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: ${COLLAPSED_LINES}; overflow: hidden; }
.pm-mc-more { display: flex; align-items: center; gap: 6px; margin-top: -2px; }
/* 对齐宿主的折叠按钮：幽灵按钮、次文字色，左边负外边距抵掉自身内边距，字和原文左缘对齐 */
.pm-mc-toggle {
  display: inline-flex; align-items: center; gap: 2px; margin-left: 8px; padding: 1px 6px;
  border: 0; border-radius: 6px; background: transparent; font: inherit; font-size: 12px; line-height: 20px;
  color: var(--pm-text-2); cursor: pointer;
}
@media (hover: hover) { .pm-mc-toggle:hover { background: var(--pm-hover); } }
.pm-mc-badge { margin-left: 6px; white-space: nowrap; }
.pm-mc-more .pm-mc-badge { margin-left: 0; }
.pm-mc-badge .pm-chip { vertical-align: 1px; }
.pm-mc-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; padding-left: 14px;
  font-size: 12px; line-height: 1.5; color: var(--pm-text-2);
}
.pm-mc-item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow-wrap: anywhere; }
.pm-mc-item svg { flex-shrink: 0; }
/* 自定义类型名可能很长：窄侧栏里允许折行，不撑出横向滚动 */
.pm-mc-meta .pm-chip { flex-shrink: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
`

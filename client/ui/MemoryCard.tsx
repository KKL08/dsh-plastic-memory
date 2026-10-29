/**
 * 记忆卡（DESIGN.md「Memory Card」，招牌组件）：两行。
 * 第一行记忆原文，左边 2px 银藤竖线；第二行元信息：类型是浅灰胶囊（类型可自定义，配不了各自的图标），
 * 作用域、来源、时间各带一个宿主图标，不再用点分隔。来源图标只分是谁：你、agent、环境，无出处不画。
 * 状态 chip 放最后、最多一个。不套外框和阴影；已过期的原文改次文字色，元信息加「不再带入对话」。
 * 记忆文字进视图前服务端已遮盖密钥片段，这里原样显示。
 */
import type { ReactNode } from 'react'
import type { MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { formatDay, useT } from '../i18n.tsx'
import { Chip } from './Chip.tsx'
import { Icon, type IconName } from './Icon.tsx'

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
  /** 页面已经交代过作用域时不重复（例如右侧栏里不写「本项目」）。 */
  hideScope?: boolean
  /** 记忆不在借来的会话所在项目里时，作用域写这个项目名，不写「本项目」。 */
  projectName?: string | undefined
  /** 末尾的状态 chip，最多一个。 */
  chip?: ReactNode
}

export function MemoryCard({ memory, now, typeLabel, hideScope = false, projectName, chip }: MemoryCardProps) {
  const t = useT()
  const expired = memory.validTo !== undefined && memory.validTo <= now
  const item = (icon: IconName | undefined, text: string) => (
    <span className="pm-mc-item">{icon === undefined ? null : <Icon name={icon} size={13} />}{text}</span>
  )
  return (
    <div className={expired ? 'pm-mc pm-mc--expired' : 'pm-mc'} data-memory-id={memory.id}>
      <p className="pm-mc-text">{memory.content}</p>
      <div className="pm-mc-meta">
        <Chip variant="neutral">{typeLabel ?? memory.type}</Chip>
        {hideScope ? null : memory.scope === 'global' ? item('globe', t('scope.global')) : item('folder', projectName ?? t('scope.workspace'))}
        {item(memory.sourceMode === undefined ? undefined : SOURCE_ICON[memory.sourceMode], t(memory.sourceMode === undefined ? 'source.none' : `source.${memory.sourceMode}`))}
        {item('clock', formatDay(memory.updatedAt, now, t))}
        {expired ? <span className="pm-mc-item">{t('memory.expired')}</span> : null}
        {chip}
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
.pm-mc-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; padding-left: 14px;
  font-size: 12px; line-height: 1.5; color: var(--pm-text-2);
}
.pm-mc-item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.pm-mc-item svg { flex-shrink: 0; }
/* 自定义类型名可能很长：窄侧栏里允许折行，不撑出横向滚动 */
.pm-mc-meta .pm-chip { flex-shrink: 1; min-width: 0; white-space: normal; overflow-wrap: anywhere; }
`

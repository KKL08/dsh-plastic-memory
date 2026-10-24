/**
 * 记忆卡（DESIGN.md「Memory Card」，招牌组件）：两行。
 * 第一行记忆原文，左边 2px 银藤竖线；第二行元信息「类型 · 作用域 · 来源 · 时间」，caption 色的点分隔，
 * 状态 chip 放最后、最多一个。不套外框和阴影；已过期的原文改次文字色，元信息加「不再带入对话」。
 * 记忆文字进视图前服务端已遮盖密钥片段，这里原样显示。
 */
import { Fragment, type ReactNode } from 'react'
import type { MemoryCard as MemoryCardData } from '../../src/gui/contract.ts'
import { formatDay, useT } from '../i18n.tsx'

export interface MemoryCardProps {
  memory: MemoryCardData
  /** 当前时间（毫秒），算「刚刚」「已过期」。 */
  now: number
  /** 类型的显示名；视图只给类型 id，名字由调用方查（缺省显示 id）。 */
  typeLabel?: string
  /** 页面已经交代过作用域时不重复（例如右侧栏里不写「本项目」）。 */
  hideScope?: boolean
  /** 末尾的状态 chip，最多一个。 */
  chip?: ReactNode
}

export function MemoryCard({ memory, now, typeLabel, hideScope = false, chip }: MemoryCardProps) {
  const t = useT()
  const expired = memory.validTo !== undefined && memory.validTo <= now
  const meta: string[] = [typeLabel ?? memory.type]
  if (!hideScope) meta.push(t(memory.scope === 'global' ? 'scope.global' : 'scope.workspace'))
  meta.push(t(memory.sourceMode === undefined ? 'source.none' : `source.${memory.sourceMode}`))
  meta.push(formatDay(memory.updatedAt, now, t))
  if (expired) meta.push(t('memory.expired'))
  return (
    <div className={expired ? 'pm-mc pm-mc--expired' : 'pm-mc'} data-memory-id={memory.id}>
      <p className="pm-mc-text">{memory.content}</p>
      <div className="pm-mc-meta">
        {meta.map((item, i) => (
          <Fragment key={i}>
            {i > 0 ? <i className="pm-sep" aria-hidden="true">·</i> : null}
            <span>{item}</span>
          </Fragment>
        ))}
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
  display: flex; flex-wrap: wrap; align-items: center; padding-left: 14px;
  font-size: 12px; line-height: 1.5; color: var(--pm-text-2);
}
.pm-mc-meta .pm-chip { margin-left: 8px; }
`

/**
 * 「记忆查看」「最近删除」的分组：单个范围的记忆查看按类型分组，每组先露 3 条，其余收在「展开其余 N 条」里；
 * 「全部」的记忆查看、最近删除按时间分段，不截断。
 * 折叠状态在这次打开记忆页期间保留（FoldMemory 由记忆页持有，切范围、切视图都还在，离开记忆页就没了）。
 * 搜索、直达引起的展开不写进去：搜索时全部展开（期间点标题只收起这一次搜索里的），直达时目标所在的组展开、展开其余。
 * 只有点组标题展开时组体撑开（同 motion.tsx 的 .pm-arrive）；搜索、直达、换范围、首屏都瞬开，收起瞬收。
 */
import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import type { MemoryCard } from '../../src/gui/contract.ts'
import { formatDay, formatNumber, useT } from '../i18n.tsx'
import { Icon } from '../ui/Icon.tsx'

/** 按类型分的组先露几条。 */
export const GROUP_PREVIEW = 3

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** 「全部」记忆查看的四段：按更新时间，滚动 24、72、168 小时为界。 */
export const RECENT_BUCKETS = ['day', 'days3', 'week', 'older'] as const
export type RecentBucket = (typeof RECENT_BUCKETS)[number]
const RECENT_WITHIN_MS: Record<Exclude<RecentBucket, 'older'>, number> = { day: 24 * HOUR_MS, days3: 72 * HOUR_MS, week: 168 * HOUR_MS }

export function recentBucketOf(updatedAt: number, now: number): RecentBucket {
  const age = now - updatedAt
  return age < RECENT_WITHIN_MS.day ? 'day' : age < RECENT_WITHIN_MS.days3 ? 'days3' : age < RECENT_WITHIN_MS.week ? 'week' : 'older'
}

/** 最近删除的三段：按删除那天（本机日历日），今天、往前 6 天内、更早。 */
export const DELETED_BUCKETS = ['today', 'week', 'older'] as const
export type DeletedBucket = (typeof DELETED_BUCKETS)[number]

export function deletedBucketOf(deletedAt: number, now: number): DeletedBucket {
  const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)
  // 四舍五入：跨夏令时的那天不是整 24 小时
  const days = Math.round((startOfDay(now) - startOfDay(deletedAt)) / DAY_MS)
  return days <= 0 ? 'today' : days < 7 ? 'week' : 'older'
}

/** 按段分：段按 keys 的顺序，空段不列，段内保持传入的顺序。 */
export function bucketize<T, K extends string>(items: readonly T[], keys: readonly K[], keyOf: (item: T) => K): Array<{ key: K; items: T[] }> {
  return keys.map(key => ({ key, items: items.filter(item => keyOf(item) === key) })).filter(b => b.items.length > 0)
}

/**
 * 按类型分组：组的顺序跟视图给的 typeOrder，不在里面的类型（旧视图文件没给）按显示名排在后面；
 * 组内按更新时间新的在前，同时刻保持传入的顺序。
 */
export function groupByType(items: readonly MemoryCard[], order: readonly string[] | undefined, label: (type: string) => string): Array<{ type: string; items: MemoryCard[] }> {
  const groups = new Map<string, MemoryCard[]>()
  for (const memory of items) groups.set(memory.type, [...groups.get(memory.type) ?? [], memory])
  const rank = (type: string) => {
    const i = order?.indexOf(type) ?? -1
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...groups.entries()]
    .map(([type, list]) => ({ type, items: list.sort((a, b) => b.updatedAt - a.updatedAt) }))
    .sort((a, b) => rank(a.type) - rank(b.type) || label(a.type).localeCompare(label(b.type)) || (a.type < b.type ? -1 : 1))
}

/** 一个组记下的状态：isOpen 没记过时按组的默认，isFull = 展开了其余。 */
export interface FoldEntry { isOpen?: boolean; isFull?: boolean }
/** 这次打开记忆页期间各组的折叠状态，键「视图|范围|组」。 */
export type FoldMemory = Map<string, FoldEntry>

export interface Fold {
  isOpen(key: string, byDefault: boolean): boolean
  isFull(key: string): boolean
  /** 点组标题：搜索时只记在这次搜索里。 */
  toggle(key: string, isOpenNow: boolean): void
  /** 记下展开其余、收回 3 条，或直达高亮结束后把目标所在的组记成展开。 */
  remember(key: string, entry: FoldEntry): void
}

/**
 * hook：读写一个视图、一个范围里的折叠状态（prefix 是「视图|范围」），写了就重渲染。没给 memory 时用自己的一份。
 * 搜索时组都展开、不截断；点标题收起的记在一份只管这次搜索的表里，清空搜索就丢掉，回到原来的折叠状态。
 */
export function useFold(memory: FoldMemory | undefined, prefix: string, isSearching: boolean): Fold {
  const [own] = useState<FoldMemory>(() => new Map())
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const searchFold = useRef(new Map<string, boolean>())
  if (!isSearching) searchFold.current.clear()
  const store = memory ?? own
  const at = (key: string) => `${prefix}|${key}`
  const remember = (key: string, entry: FoldEntry) => {
    store.set(at(key), { ...store.get(at(key)), ...entry })
    rerender()
  }
  return {
    isOpen: (key, byDefault) => isSearching ? searchFold.current.get(key) ?? true : store.get(at(key))?.isOpen ?? byDefault,
    isFull: key => isSearching || store.get(at(key))?.isFull === true,
    toggle(key, isOpenNow) {
      if (!isSearching) return remember(key, { isOpen: !isOpenNow })
      searchFold.current.set(key, !isOpenNow)
      rerender()
    },
    remember,
  }
}

/**
 * 一个可折叠的组：标题行（h3 > button，箭头展开时转 90°）+ 组体（列表，按类型分的组下面跟「展开其余 N 条」或「收起到 3 条」）。
 * 收起时标题行右侧写组里最近一次更新（latest，按类型分的组给）。
 * 展开其余后焦点落在新露出的第一条；收回 3 条后把标题滚进视野、焦点回到标题（按钮在长列表底部，收起后内容整体上移）。
 */
export function MemoryGroup({ title, count, latest, now, isOpen, onToggle, hidden = 0, onMore, onLess, children }: {
  title: string
  count: number
  latest?: number
  now: number
  isOpen: boolean
  onToggle: () => void
  /** 收在「展开其余」里的条数；0 = 没截断。 */
  hidden?: number
  onMore?: () => void
  /** 展开了其余、可以收回 3 条时给出。 */
  onLess?: () => void
  /** 列表行（li）。 */
  children: ReactNode
}) {
  const t = useT()
  const bodyId = useId()
  const head = useRef<HTMLButtonElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const isClicked = useRef(false)
  const focusAfter = useRef<'more' | 'less' | undefined>(undefined)
  useLayoutEffect(() => {
    const to = focusAfter.current
    focusAfter.current = undefined
    if (to === 'less') {
      head.current?.scrollIntoView?.({ block: 'nearest' })
      head.current?.focus({ preventScroll: true })
    } else if (to === 'more') {
      // 焦点落在新露出的第一行整行上（不落到它的「删除」）；行本来不可聚焦，只在接住焦点期间临时可聚焦
      const row = body.current?.querySelectorAll<HTMLElement>('.pm-list > li').item(GROUP_PREVIEW)
      if (row == null) return
      if (!row.hasAttribute('tabindex')) {
        row.tabIndex = -1
        row.addEventListener('blur', () => { row.removeAttribute('tabindex') }, { once: true })
      }
      row.focus()
    }
  })
  return (
    <section className="pm-memgroup">
      <h3 className="pm-memgroup-heading">
        <button
          ref={head}
          type="button"
          className="pm-memgroup-toggle"
          aria-expanded={isOpen}
          aria-controls={bodyId}
          onClick={() => { isClicked.current = !isOpen; onToggle() }}
        >
          <Icon name="chevronRight" size={14} />
          <span className="pm-memgroup-title">{title}</span>
          <span className="pm-memgroup-count">{formatNumber(count)}</span>
          {!isOpen && latest !== undefined ? <span className="pm-memgroup-latest">{t('library.group.latest', { date: formatDay(latest, now, t) })}</span> : null}
        </button>
      </h3>
      <div ref={body} id={bodyId} className="pm-memgroup-body" hidden={!isOpen}>
        {isOpen
          ? (
            <GroupBody clicked={isClicked}>
              <ul className="pm-list">{children}</ul>
              {hidden > 0 && onMore !== undefined
                ? (
                  <button type="button" className="pm-memgroup-more" onClick={() => { focusAfter.current = 'more'; onMore() }}>
                    <Icon name="chevronDown" size={12} />
                    {t('library.group.more', { n: formatNumber(hidden) })}
                  </button>
                )
                : onLess !== undefined
                  ? (
                    <button type="button" className="pm-memgroup-more" onClick={() => { focusAfter.current = 'less'; onLess() }}>
                      <Icon name="chevronUp" size={12} />
                      {t('library.group.less', { n: formatNumber(GROUP_PREVIEW) })}
                    </button>
                  )
                  : null}
            </GroupBody>
          )
          : null}
      </div>
    </section>
  )
}

/** 组体：挂载时是点标题展开的才撑开，挂上就清掉标记；之后结构不变，展开其余、视图刷新都不再播。 */
function GroupBody({ clicked, children }: { clicked: MutableRefObject<boolean>; children: ReactNode }) {
  const [isArriving] = useState(() => clicked.current)
  useEffect(() => { clicked.current = false }, [])
  if (!isArriving) return children
  return <div className="pm-arrive"><div className="pm-arrive-body">{children}</div></div>
}

export const groupsCss = `
.pm-memgroups { display: flex; flex-direction: column; gap: 4px; }
.pm-memgroup { display: flex; flex-direction: column; }
.pm-memgroup + .pm-memgroup { padding-top: 4px; border-top: .5px solid var(--pm-line); }
.pm-memgroup-heading { margin: 0; font-size: 13px; line-height: 1.5; }
.pm-memgroup-toggle {
  width: 100%; min-height: 36px; display: flex; align-items: center; gap: 6px; padding: 0 12px 0 10px; border: 0; border-radius: 10px;
  background: transparent; font: inherit; color: var(--pm-text); text-align: left; cursor: pointer;
}
.pm-memgroup-toggle:hover { background: var(--pm-hover); }
.pm-memgroup-toggle svg { flex: none; color: var(--pm-text-2); transition: transform 120ms ease; }
.pm-memgroup-toggle[aria-expanded='true'] svg { transform: rotate(90deg); }
.pm-memgroup-title { min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.pm-memgroup-count { font-weight: 400; color: var(--pm-text-2); }
.pm-memgroup-latest { margin-left: auto; padding-left: 12px; font-size: 12px; color: var(--pm-text-2); white-space: nowrap; }
.pm-memgroup-body, .pm-memgroup-body .pm-arrive-body { display: flex; flex-direction: column; }
.pm-memgroup-body[hidden] { display: none; }
.pm-memgroup-more {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; margin: 0 0 4px; padding: 4px 16px 4px 30px;
  border: 0; background: none; font: inherit; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); cursor: pointer;
}
.pm-memgroup-more:hover { color: var(--pm-text); }
@media (prefers-reduced-motion: reduce) {
  .pm-memgroup-toggle svg { transition: none; }
}
`

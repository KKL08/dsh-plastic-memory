/**
 * 记忆详情里的一层关联图：中间是这一条，周围是和它直接相连的记忆，用 SVG 和 CSS 画。
 * 节点按作用域加 id 认：同一条和中间有几种关系（含矛盾）只画一个节点，写出全部关系。
 * 和这条有指出去的关系（依据、取代、相关）的画在左边，其余有指向这条的画在右边；只有矛盾的补在较短的一边。
 * 窄面板（不到两栏的宽度）改成上下排：这一条在上，邻居依次排在下面。
 * 连线一个节点一条，都从中间画到邻居：有指出去的关系，邻居那头带箭头；有指向这条的，中间那头带箭头；
 * 只有矛盾的是不带箭头的虚线。有矛盾的节点上一个等你决定的圆点。
 * 节点：被取代、已删除的画成灰色；读不到的虚线框、标「读不到」，已不在的同样画、标「已不在」，和已删除分开；
 * 别的作用域的标出作用域。能点的节点可以用 Tab 走到、回车或空格触发；点了做什么由 pickOf 决定。
 * 读屏名称、悬停提示按界面语言的分隔符拼（detail.graph.sep）。
 * 名称是服务端遮盖过的，按纯文本画；过长按估算宽度截断，悬停提示里是全名。
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { sameScope, scopeKey, type LinkEdge, type LinkNode, type MemoryCard, type PendingItem, type Scope, scopeOfMemory } from '../../src/gui/contract.ts'
import { useT, type Translate } from '../i18n.tsx'
import { scopeLabel } from '../nav.ts'

/** 邻居和中间的关系：链接种类加方向，或待你决定的矛盾。 */
export type GraphRole = `${LinkEdge['kind']}-${LinkEdge['direction']}` | 'conflict'

/** 一个邻居：和中间的全部关系，按 ROLE_ORDER 排。 */
export interface GraphNeighbour { key: string; roles: GraphRole[]; node: LinkNode }

/** 关系的顺序：指出去的、指向这条的、矛盾。邻居按各自排在最前的关系排。 */
const ROLE_ORDER: readonly GraphRole[] = ['premise-out', 'supersedes-out', 'related-out', 'premise-in', 'supersedes-in', 'related-in', 'conflict']
const isOutbound = (role: GraphRole) => role.endsWith('-out')
const isInbound = (role: GraphRole) => role.endsWith('-in')

/**
 * 链接和矛盾合成邻居：作用域加 id 相同的并成一个（矛盾另一方定位不到的没有 id，各自一个）。
 * 并好之后按排在最前的关系排，同一种关系里按来的先后。
 */
export function graphNeighbours(edges: readonly LinkEdge[], conflicts: ReadonlyArray<{ key: string; node: LinkNode }>): GraphNeighbour[] {
  const byKey = new Map<string, GraphNeighbour>()
  const add = (key: string | undefined, fallback: string, role: GraphRole, node: LinkNode) => {
    const found = key === undefined ? undefined : byKey.get(key)
    if (found !== undefined) { if (!found.roles.includes(role)) found.roles.push(role); return }
    byKey.set(key ?? fallback, { key: key ?? fallback, roles: [role], node })
  }
  const keyOf = (node: LinkNode) => (node.id === '' ? undefined : `${node.scope === undefined ? '' : scopeKey(node.scope)}\u0000${node.id}`)
  edges.forEach((e, i) => { add(keyOf(e.node), `link${i}`, `${e.kind}-${e.direction}`, e.node) })
  for (const c of conflicts) add(keyOf(c.node), c.key, 'conflict', c.node)
  const rank = (n: GraphNeighbour) => Math.min(...n.roles.map(r => ROLE_ORDER.indexOf(r)))
  const all = [...byKey.values()]
  for (const n of all) n.roles.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
  return all.map((n, i) => [n, i] as const).sort(([a, i], [b, j]) => rank(a) - rank(b) || i - j).map(([n]) => n)
}

/** 待处理视图里这一条（按 id 和作用域认）参与的横向矛盾：另一方画成邻居；另一方定位不到时画成读不到。 */
export function conflictNeighbours(items: readonly PendingItem[], center: { id: string; scope: Scope }): Array<{ key: string; node: LinkNode }> {
  const isCenter = (m: MemoryCard | null) => {
    const scope = m === null ? undefined : scopeOfMemory(m)
    return m !== null && m.id === center.id && scope !== undefined && sameScope(scope, center.scope)
  }
  const out: Array<{ key: string; node: LinkNode }> = []
  for (const item of items) {
    if (item.kind !== 'conflict-horizontal') continue
    const other = isCenter(item.left) ? item.right : isCenter(item.right) ? item.left : undefined
    if (other === undefined) continue
    out.push({
      key: `conflict:${item.decisionId}`,
      node: other === null ? { id: '', state: 'unreadable' } : { id: other.id, ...scopeField(scopeOfMemory(other)), state: 'active', name: other.name },
    })
  }
  return out
}

const scopeField = (scope: Scope | undefined) => (scope === undefined ? {} : { scope })

/**
 * 点了一个邻居做什么：去处理视图、切左栏范围、以它为中心重画；已删除、读不到、已不在的点不了。
 * 有待你决定的矛盾的节点（同时还有别的关系也是）点了去处理视图：等你决定的事先处理。
 */
export type GraphPick = 'resolve' | 'switch-scope' | 'recentre'

export function pickOf(neighbour: GraphNeighbour, center: Scope): GraphPick | undefined {
  if (neighbour.roles.includes('conflict')) return 'resolve'
  const { state, scope } = neighbour.node
  if (scope === undefined || (state !== 'active' && state !== 'superseded')) return undefined
  return sameScope(scope, center) ? 'recentre' : 'switch-scope'
}

const NODE_H = 52
const ROW_GAP = 12
const PAD = 8
const COL_GAP = 48
/** 两栏布局要的最小宽度，窄于它上下排。 */
const WIDE_MIN = 560
const DEFAULT_WIDTH = 640
/** 上下排时邻居相对中间缩进多少（连线从这里拐下来）。 */
const INDENT = 24

interface Box { x: number; y: number; w: number }
interface Placed { neighbour: GraphNeighbour; box: Box; side: 'left' | 'right' | 'below' }

function layout(width: number, neighbours: readonly GraphNeighbour[]): { center: Box; placed: Placed[]; height: number } {
  const usable = width - PAD * 2
  if (width < WIDE_MIN) {
    const center = { x: PAD, y: PAD, w: usable }
    const placed = neighbours.map((neighbour, i): Placed => ({
      neighbour, side: 'below', box: { x: PAD + INDENT, y: PAD + (NODE_H + ROW_GAP) * (i + 1), w: usable - INDENT },
    }))
    return { center, placed, height: PAD * 2 + (NODE_H + ROW_GAP) * neighbours.length + NODE_H }
  }
  const left = neighbours.filter(n => n.roles.some(isOutbound))
  const right = neighbours.filter(n => !n.roles.some(isOutbound) && n.roles.some(isInbound))
  for (const n of neighbours) if (n.roles.every(r => r === 'conflict')) (left.length < right.length ? left : right).push(n)
  const colW = (usable - COL_GAP * 2) / 3
  const rows = Math.max(left.length, right.length, 1)
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP
  const column = (items: GraphNeighbour[], x: number, side: Placed['side']) => {
    const top = (height - (items.length * NODE_H + (items.length - 1) * ROW_GAP)) / 2
    return items.map((neighbour, i): Placed => ({ neighbour, side, box: { x, y: top + i * (NODE_H + ROW_GAP), w: colW } }))
  }
  return {
    center: { x: PAD + colW + COL_GAP, y: (height - NODE_H) / 2, w: colW },
    placed: [...column(left, PAD, 'left'), ...column(right, PAD + (colW + COL_GAP) * 2, 'right')],
    height,
  }
}

/** 连线都从中间画到邻居；箭头由调用方按关系的方向加在两头。 */
function edgePath(center: Box, { box, side }: Placed): string {
  if (side === 'below') {
    const elbowX = center.x + INDENT / 2
    return `M ${elbowX} ${center.y + NODE_H} V ${box.y + NODE_H / 2} H ${box.x}`
  }
  const cx = side === 'left' ? center.x : center.x + center.w
  const nx = side === 'left' ? box.x + box.w : box.x
  const cy = center.y + NODE_H / 2
  const ny = box.y + NODE_H / 2
  const mid = (cx + nx) / 2
  return `M ${cx} ${cy} C ${mid} ${cy}, ${mid} ${ny}, ${nx} ${ny}`
}

/** 按估算宽度截断：全角字按一个字号宽，其余按半个多一点；截掉的用省略号。 */
export function fitText(text: string, maxPx: number, fontPx: number): string {
  const widthOf = (ch: string) => (/[ᄀ-￿]/.test(ch) ? fontPx : fontPx * 0.58)
  const chars = [...text]
  let used = 0
  for (let i = 0; i < chars.length; i++) {
    used += widthOf(chars[i]!)
    if (used > maxPx) {
      const room = maxPx - fontPx
      let kept = 0
      let cut = 0
      while (cut < chars.length && kept + widthOf(chars[cut]!) <= room) kept += widthOf(chars[cut++]!)
      return `${chars.slice(0, cut).join('')}…`
    }
  }
  return text
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const measure = () => { if (el.clientWidth > 0) setWidth(el.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])
  return { ref, width }
}

/** 节点第二行和读屏名称里的说明：关系、状态（被取代、已删除、读不到、已不在）、跨作用域时的作用域。 */
function metaOf(neighbour: GraphNeighbour, center: Scope, t: Translate): string[] {
  const { node } = neighbour
  const parts = neighbour.roles.map(role => t(`detail.graph.role.${role}`))
  if (node.state !== 'active') parts.push(t(`detail.graph.state.${node.state}`))
  if (node.scope !== undefined && !sameScope(node.scope, center)) parts.push(scopeLabel(node.scope, t))
  return parts
}

const TEXT_X = 12

export function RelationGraph({ center, centerName, neighbours, onPick }: {
  center: Scope
  centerName: string
  neighbours: readonly GraphNeighbour[]
  onPick: (neighbour: GraphNeighbour, pick: GraphPick) => void
}) {
  const t = useT()
  const { ref, width } = useWidth()
  const { center: box, placed, height } = layout(width, neighbours)
  const arrowId = `pm-graph-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const textRoom = (w: number) => w - TEXT_X * 2
  const sep = t('detail.graph.sep')
  return (
    <div className="pm-graph" ref={ref}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t('detail.graph.label')}>
        <defs>
          <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" className="pm-graph-arrow" />
          </marker>
        </defs>
        {placed.map((p) => {
          const { roles } = p.neighbour
          const arrow = `url(#${arrowId})`
          return (
            <path
              key={`edge:${p.neighbour.key}`}
              d={edgePath(box, p)}
              className={`pm-graph-edge${roles.every(r => r === 'conflict') ? ' pm-graph-edge--conflict' : ''}`}
              {...(roles.some(isOutbound) ? { markerEnd: arrow } : {})}
              {...(roles.some(isInbound) ? { markerStart: arrow } : {})}
            />
          )
        })}
        <g className="pm-graph-node pm-graph-node--center" transform={`translate(${box.x} ${box.y})`} role="img" aria-label={[centerName, t('detail.graph.center')].join(sep)}>
          <title>{centerName}</title>
          <rect width={box.w} height={NODE_H} rx={10} />
          <text className="pm-graph-name" x={TEXT_X} y={22}>{fitText(centerName, textRoom(box.w), 13)}</text>
          <text className="pm-graph-meta" x={TEXT_X} y={40}>{t('detail.graph.center')}</text>
        </g>
        {placed.map(({ neighbour, box: at }) => {
          const { node } = neighbour
          const name = node.name ?? (node.id !== '' ? node.id : t('detail.graph.state.unreadable'))
          const meta = metaOf(neighbour, center, t)
          const pick = pickOf(neighbour, center)
          const isFaded = node.state === 'superseded' || node.state === 'deleted'
          const isUnreadable = node.state === 'unreadable' || node.state === 'missing'
          const label = [name, ...meta].join(sep)
          const activate = pick === undefined ? undefined : () => { onPick(neighbour, pick) }
          const onKeyDown = activate === undefined ? undefined : (e: KeyboardEvent) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            activate()
          }
          const hasConflict = neighbour.roles.includes('conflict')
          const dotRoom = hasConflict ? 14 : 0
          return (
            <g
              key={neighbour.key}
              className={`pm-graph-node${isFaded ? ' pm-graph-node--faded' : ''}${isUnreadable ? ' pm-graph-node--unreadable' : ''}${activate === undefined ? '' : ' pm-graph-node--pickable'}`}
              transform={`translate(${at.x} ${at.y})`}
              role={activate === undefined ? 'img' : 'button'}
              aria-label={label}
              {...(activate === undefined ? {} : { tabIndex: 0, onClick: activate, onKeyDown })}
            >
              <title>{label}</title>
              <rect width={at.w} height={NODE_H} rx={10} />
              {hasConflict ? <circle className="pm-graph-dot" cx={TEXT_X + 3} cy={18} r={3} /> : null}
              <text className="pm-graph-name" x={TEXT_X + dotRoom} y={22}>{fitText(name, textRoom(at.w) - dotRoom, 13)}</text>
              <text className="pm-graph-meta" x={TEXT_X} y={40}>{fitText(meta.join(' · '), textRoom(at.w), 12)}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export const relationGraphCss = `
.pm-graph { width: 100%; min-width: 0; }
.pm-graph svg { display: block; overflow: visible; }
.pm-graph-edge { fill: none; stroke: var(--pm-line-input); stroke-width: 1.25; }
.pm-graph-edge.pm-graph-edge--conflict { stroke: var(--pm-text-3); stroke-dasharray: 4 4; }
.pm-graph-arrow { fill: var(--pm-line-input); }
.pm-graph-node rect { fill: var(--pm-bg-raised); stroke: var(--pm-line-card); stroke-width: 1; }
.pm-graph-node.pm-graph-node--center rect { fill: var(--pm-bg-block); stroke: var(--pm-line-selected); }
.pm-graph-node.pm-graph-node--faded { opacity: .55; }
.pm-graph-node.pm-graph-node--unreadable rect { fill: transparent; stroke: var(--pm-line-input); stroke-dasharray: 4 3; }
.pm-graph-node.pm-graph-node--pickable { cursor: pointer; }
@media (hover: hover) { .pm-graph-node.pm-graph-node--pickable:hover rect { fill: var(--pm-hover); } }
/* 焦点只留一层：全局给带 tabindex 的元素加了 outline，节点上盖掉它，改用同色同宽的描边贴着节点的圆角 */
.pm-root .pm-graph-node:focus-visible { outline: none; }
.pm-graph-node.pm-graph-node--pickable:focus-visible rect { stroke: var(--pm-focus); stroke-width: var(--dsw-focus-ring-width, 2px); }
.pm-graph-name { font-size: 13px; font-weight: 600; fill: var(--pm-text); }
.pm-graph-meta { font-size: 12px; font-weight: 400; fill: var(--pm-text-2); }
.pm-graph-dot { fill: var(--pm-warn); }
`

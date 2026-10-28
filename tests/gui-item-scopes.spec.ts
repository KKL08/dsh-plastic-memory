import { describe, expect, it } from 'vitest'
import { pendingItemKey, pendingItemScopes, sameLayer, type GuiLayerRef, type MemoryCard, type PendingItem } from '../src/gui/contract.ts'

// 契约纯函数：条目属于哪些范围、条目身份。服务端判新增、客户端按范围筛选和算件数共用这一份。

const GLOBAL: GuiLayerRef = { kind: 'global' }
const APP: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/app' }
const BLOG: GuiLayerRef = { kind: 'workspace', workspacePath: '/w/blog' }

function card(id: string, layer: GuiLayerRef): MemoryCard {
  return {
    id, name: id, type: 'preference', scope: layer.kind,
    ...(layer.kind === 'workspace' ? { workspacePath: layer.workspacePath } : {}),
    summary: '', content: 'x', tags: [], createdAt: 1, updatedAt: 1, lastConfirmedAt: 1, filePath: `/m/${id}.md`,
  }
}

const horizontal = (left: MemoryCard | null, right: MemoryCard | null): PendingItem => ({
  kind: 'conflict-horizontal', level: 'your-call', decisionId: 'd1', firstSeenAt: 1, summary: 's', left, right,
})

describe('pendingItemScopes：条目属于哪些范围', () => {
  it('记忆类条目（密钥、提升候选）按记忆所在层', () => {
    expect(pendingItemScopes({ kind: 'secret', level: 'must-fix', memory: card('s', APP) })).toEqual([APP])
    expect(pendingItemScopes({ kind: 'promote-candidate', level: 'your-call', decisionId: 'd', firstSeenAt: 1, memory: card('p', BLOG) })).toEqual([BLOG])
  })

  it('全局和项目之间的冲突属于两个范围；同层的冲突只算一次；定位不到的一方不算', () => {
    expect(pendingItemScopes(horizontal(card('a', GLOBAL), card('b', APP)))).toEqual([GLOBAL, APP])
    expect(pendingItemScopes(horizontal(card('a', APP), card('b', APP)))).toEqual([APP])
    expect(pendingItemScopes(horizontal(null, card('b', APP)))).toEqual([APP])
    expect(pendingItemScopes(horizontal(null, null))).toEqual([])
  })

  it('和 AGENTS.md 基线的冲突按记忆所在层', () => {
    const item: PendingItem = { kind: 'conflict-vertical', level: 'your-call', decisionId: 'd', firstSeenAt: 1, summary: 's', memory: card('v', APP), baselineRef: 'AGENTS.md' }
    expect(pendingItemScopes(item)).toEqual([APP])
  })

  it('超出上限按它的作用域：有项目归项目，没有项目的会话归全局', () => {
    const overflow = (workspacePath?: string): PendingItem => ({
      kind: 'overflow', level: 'your-call', decisionId: 'o', firstSeenAt: 1, mode: 'relax', tier: 1, ...(workspacePath !== undefined ? { workspacePath } : {}),
    })
    expect(pendingItemScopes(overflow('/w/app'))).toEqual([APP])
    expect(pendingItemScopes(overflow())).toEqual([GLOBAL])
  })

  it('读不出的文件按所在目录', () => {
    expect(pendingItemScopes({ kind: 'unreadable-file', level: 'must-fix', layer: BLOG, filePath: '/m/x.md', relativePath: 'x.md', error: 'bad' })).toEqual([BLOG])
  })

  it('建议整理按涉及记忆各自的层，重复的层只算一次', () => {
    const across: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [card('a', GLOBAL), card('b', APP)] }
    const same: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [card('a', APP), card('b', APP)] }
    expect(pendingItemScopes(across)).toEqual([GLOBAL, APP])
    expect(pendingItemScopes(same)).toEqual([APP])
  })

  it('项目记忆缺项目路径时定位不到层，不算进任何范围', () => {
    const { workspacePath: _dropped, ...noPath } = card('s', APP)
    expect(pendingItemScopes({ kind: 'secret', level: 'must-fix', memory: noPath })).toEqual([])
  })
})

describe('pendingItemKey：条目身份', () => {
  it('同一条记忆在两层各有一份密钥：身份不同', () => {
    const a = pendingItemKey({ kind: 'secret', level: 'must-fix', memory: card('s', APP) })
    const b = pendingItemKey({ kind: 'secret', level: 'must-fix', memory: card('s', GLOBAL) })
    expect(a).not.toBe(b)
  })

  it('建议整理按类型加记忆 id，和记忆顺序无关；类型不同身份不同', () => {
    const ab: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [card('a', APP), card('b', APP)] }
    const ba: PendingItem = { kind: 'advice', level: 'advice', type: 'redundancy', memories: [card('b', APP), card('a', APP)] }
    expect(pendingItemKey(ab)).toBe(pendingItemKey(ba))
    expect(pendingItemKey({ ...ab, type: 'unclear' })).not.toBe(pendingItemKey(ab))
  })

  it('账本来的条目按条目 id；读不出的文件按路径', () => {
    expect(pendingItemKey(horizontal(card('a', GLOBAL), card('b', APP)))).toBe(pendingItemKey(horizontal(null, null)))
    const file = (filePath: string): PendingItem => ({ kind: 'unreadable-file', level: 'must-fix', layer: APP, filePath, relativePath: 'x.md', error: 'bad' })
    expect(pendingItemKey(file('/m/x.md'))).not.toBe(pendingItemKey(file('/m/y.md')))
  })
})

describe('sameLayer', () => {
  it('都是全局，或同一个项目路径', () => {
    expect(sameLayer(GLOBAL, { kind: 'global' })).toBe(true)
    expect(sameLayer(APP, { kind: 'workspace', workspacePath: '/w/app' })).toBe(true)
    expect(sameLayer(APP, BLOG)).toBe(false)
    expect(sameLayer(APP, GLOBAL)).toBe(false)
  })
})

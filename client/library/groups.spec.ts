// 分组、分段的纯逻辑：类型组的顺序，时间段的边界；组样式的类名不和别处撞。
import { describe, expect, it } from 'vitest'
import { memoryPageCss } from '../MemoryPage.tsx'
import { memory, NOW } from '../test-utils.tsx'
import { PM_CSS } from '../ui/PanelShell.tsx'
import { deletedBucketOf, groupByType, groupsCss, recentBucketOf } from './groups.tsx'

const HOUR = 60 * 60 * 1000

describe('按类型分组', () => {
  const labels: Record<string, string> = { preference: '行为偏好', knowledge: '事实与经验', zeta: 'Zeta', alpha: 'Alpha' }
  const label = (type: string) => labels[type] ?? type

  it('组按 typeOrder 排，不在里面的按显示名排在后面；组内更新时间新的在前', () => {
    const items = [
      memory({ id: 'z1', type: 'zeta', updatedAt: NOW - 5 * HOUR }),
      memory({ id: 'k1', type: 'knowledge', updatedAt: NOW - 3 * HOUR }),
      memory({ id: 'p1', type: 'preference', updatedAt: NOW - 2 * HOUR }),
      memory({ id: 'k2', type: 'knowledge', updatedAt: NOW - HOUR }),
      memory({ id: 'a1', type: 'alpha', updatedAt: NOW }),
    ]
    expect(groupByType(items, ['preference', 'knowledge'], label).map(g => [g.type, g.items.map(m => m.id)])).toEqual([
      ['preference', ['p1']],
      ['knowledge', ['k2', 'k1']],
      ['alpha', ['a1']],
      ['zeta', ['z1']],
    ])
  })

  it('视图没给 typeOrder（旧视图文件）：都按显示名排', () => {
    const items = [memory({ id: 'a', type: 'zeta' }), memory({ id: 'b', type: 'alpha' }), memory({ id: 'c', type: 'mystery' })]
    expect(groupByType(items, undefined, label).map(g => g.type)).toEqual(['alpha', 'mystery', 'zeta'])
  })
})

describe('时间分段', () => {
  it('「全部」按更新时间滚动分段：不满 24 小时、72 小时、168 小时为界，再往前是更早', () => {
    expect(recentBucketOf(NOW - 24 * HOUR + 1, NOW)).toBe('day')
    expect(recentBucketOf(NOW - 24 * HOUR, NOW)).toBe('days3')
    expect(recentBucketOf(NOW - 72 * HOUR + 1, NOW)).toBe('days3')
    expect(recentBucketOf(NOW - 72 * HOUR, NOW)).toBe('week')
    expect(recentBucketOf(NOW - 168 * HOUR + 1, NOW)).toBe('week')
    expect(recentBucketOf(NOW - 168 * HOUR, NOW)).toBe('older')
  })

  it('最近删除按删除那天分：今天、往前 1 到 6 天、第 7 天起是更早', () => {
    const daysAgo = (n: number, hour: number) => new Date(2026, 9, 17 - n, hour).getTime()
    expect(deletedBucketOf(daysAgo(0, 0), NOW)).toBe('today')
    expect(deletedBucketOf(daysAgo(1, 23), NOW)).toBe('week')
    expect(deletedBucketOf(daysAgo(6, 0), NOW)).toBe('week')
    expect(deletedBucketOf(daysAgo(7, 23), NOW)).toBe('older')
  })
})

describe('组样式', () => {
  it('每条规则打头的类名，插件别处的样式不再定义：所有面板共用一张样式表，撞名会互相套上（曾套上设置页的组标题字号和缩进）', () => {
    const leads = (css: string) => new Set([...css.matchAll(/(?:^|[{},])\s*\.(pm-[\w-]+)/g)].map(m => m[1]!))
    const others = leads(PM_CSS + memoryPageCss.replace(groupsCss, ''))
    expect([...leads(groupsCss)].filter(name => others.has(name))).toEqual([])
  })
})

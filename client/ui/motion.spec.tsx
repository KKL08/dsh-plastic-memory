import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { useRef, useState } from 'react'
import { Arrival, RollingNumber, useArrivals, useHeightTransition, withRollingNumber, type Arrivals } from './motion.tsx'

/** jsdom 没有 Element.animate：换成记录调用的假实现，测完还原。 */
function stubAnimate() {
  const calls: Array<{ el: Element; keyframes: Keyframe[]; animation: { cancel: () => void; onfinish: (() => void) | null } }> = []
  const animate = vi.fn(function (this: Element, keyframes: Keyframe[]) {
    const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null }
    calls.push({ el: this, keyframes, animation })
    return animation
  })
  Object.defineProperty(Element.prototype, 'animate', { value: animate, configurable: true, writable: true })
  return calls
}

afterEach(() => { delete (Element.prototype as { animate?: unknown }).animate })

describe('useArrivals：挂载之后才出现的条目', () => {
  const arrivals = (ids: readonly string[] | undefined, resetKey = '') => renderHook(
    ({ ids, resetKey }) => useArrivals(ids, resetKey),
    { initialProps: { ids, resetKey } },
  )

  it('首屏的不算新；之后出现的算新，播过（settle）之后不再算', () => {
    const { result, rerender } = arrivals(['a', 'b'])
    expect(result.current.isNew('a')).toBe(false)
    rerender({ ids: ['c', 'a', 'b'], resetKey: '' })
    expect(result.current.isNew('c')).toBe(true)
    expect(result.current.isNew('a')).toBe(false)
    result.current.settle('c')
    rerender({ ids: ['c', 'a', 'b'], resetKey: '' })
    expect(result.current.isNew('c')).toBe(false)
  })

  it('还没就绪（undefined）时不记首屏，第一份就绪的列表才是首屏', () => {
    const { result, rerender } = arrivals(undefined)
    rerender({ ids: ['a'], resetKey: '' })
    expect(result.current.isNew('a')).toBe(false)
  })

  it('没来得及显示就离开的新条目，回来时不算新', () => {
    const { result, rerender } = arrivals(['a'])
    rerender({ ids: ['a', 'n'], resetKey: '' })
    rerender({ ids: ['a'], resetKey: '' })
    rerender({ ids: ['a', 'n'], resetKey: '' })
    expect(result.current.isNew('n')).toBe(false)
  })

  it('resetKey 变了重新记首屏', () => {
    const { result, rerender } = arrivals(['a'], 's1')
    rerender({ ids: ['x', 'y'], resetKey: 's2' })
    expect(result.current.isNew('x')).toBe(false)
    rerender({ ids: ['x', 'y', 'z'], resetKey: 's2' })
    expect(result.current.isNew('z')).toBe(true)
  })
})

describe('Arrival', () => {
  const fixed = (isNew: boolean): Arrivals & { settled: string[] } => {
    const settled: string[] = []
    return { settled, isNew: () => isNew && settled.length === 0, settle: (id) => { settled.push(id) } }
  }

  it('新的套上撑开、落入的两层，挂上就记为播过；重挂（撤销后回来）不再套', () => {
    const arrivals = fixed(true)
    const first = render(<Arrival arrivals={arrivals} id="n"><p>新卡</p></Arrival>)
    expect(screen.getByText('新卡').parentElement).toHaveClass('pm-arrive-body')
    expect(screen.getByText('新卡').parentElement!.parentElement).toHaveClass('pm-arrive')
    expect(arrivals.settled).toEqual(['n'])
    first.unmount()
    render(<Arrival arrivals={arrivals} id="n"><p>新卡</p></Arrival>)
    expect(screen.getByText('新卡').closest('.pm-arrive')).toBeNull()
  })

  it('挂着时结构不变：之后不再算新，里面的节点也不重挂（命令进行中视图刷新）', () => {
    const arrivals = fixed(true)
    const { rerender } = render(<Arrival arrivals={arrivals} id="n"><p>新卡</p></Arrival>)
    const node = screen.getByText('新卡')
    rerender(<Arrival arrivals={fixed(false)} id="n"><p>新卡</p></Arrival>)
    expect(screen.getByText('新卡')).toBe(node)
    expect(node.closest('.pm-arrive')).not.toBeNull()
  })

  it('highlight 带银藤浅底的类名', () => {
    render(<Arrival arrivals={fixed(true)} id="n" highlight><p>新记的</p></Arrival>)
    expect(screen.getByText('新记的').closest('.pm-arrive')).toHaveClass('pm-arrive--highlight')
  })
})

describe('RollingNumber', () => {
  it('变小：新值从上方滚进来，旧值往下滚出去、对读屏隐藏，滚完移除', () => {
    const calls = stubAnimate()
    const { rerender, container } = render(<p>{withRollingNumber(slot => `${slot} 分`, 82, '82')}</p>)
    expect(calls).toHaveLength(0)
    rerender(<p>{withRollingNumber(slot => `${slot} 分`, 76, '76')}</p>)
    const leaving = container.querySelector('[aria-hidden="true"]')
    expect(leaving).toHaveTextContent('82')
    const enter = calls.find(c => c.el.textContent === '76')!
    const leave = calls.find(c => c.el === leaving)!
    expect(enter.keyframes[0]!.transform).toBe('translateY(-100%)')
    expect(leave.keyframes[1]!.transform).toBe('translateY(100%)')
    act(() => { leave.animation.onfinish?.() })
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(container.textContent).toBe('76 分')
  })

  it('变大：新值从下方滚进来', () => {
    const calls = stubAnimate()
    const { rerender } = render(<RollingNumber value={1} text="1" />)
    rerender(<RollingNumber value={2} text="2" />)
    expect(calls.find(c => c.el.textContent === '2')!.keyframes[0]!.transform).toBe('translateY(100%)')
  })

  it('占位没能原样留在句子里时，照普通文案显示', () => {
    const { container } = render(<p>{withRollingNumber(slot => `${slot.replace('\u0000', '?')} 分`, 3, '3')}</p>)
    expect(container.textContent).toBe('3 分')
    expect(container.querySelector('.pm-roll')).toBeNull()
  })
})

describe('useHeightTransition', () => {
  function Box({ contentKey, tick }: { contentKey: string; tick: number }) {
    const ref = useRef<HTMLDivElement>(null)
    useHeightTransition(ref, contentKey)
    return <div ref={ref} data-tick={tick}>{contentKey}</div>
  }

  it('内容换了才从旧高度过渡到新高度；内容没换的重渲染（例如折行变了）只记下新高度', () => {
    const calls = stubAnimate()
    let height = 0
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height } as DOMRect))
    const { rerender } = render(<Box contentKey="" tick={0} />)
    height = 40
    rerender(<Box contentKey="" tick={1} />)
    expect(calls).toHaveLength(0)
    height = 18
    rerender(<Box contentKey="running" tick={2} />)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.keyframes.map(k => k.height)).toEqual(['40px', '18px'])
    vi.restoreAllMocks()
  })

  it('没有 animate 时什么都不做（不报错）', () => {
    function Toggle() {
      const [key, setKey] = useState('a')
      const ref = useRef<HTMLDivElement>(null)
      useHeightTransition(ref, key)
      return <div ref={ref} onClick={() => { setKey('b') }}>{key}</div>
    }
    render(<Toggle />)
    act(() => { screen.getByText('a').click() })
    expect(screen.getByText('b')).toBeInTheDocument()
  })
})

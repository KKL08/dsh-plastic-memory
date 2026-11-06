import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Icon } from './Icon.tsx'

describe('Icon', () => {
  it('按宿主图形画：16 栅格、currentColor、装饰性', () => {
    const { container } = render(<Icon name="user" size={13} />)
    const svg = container.querySelector('svg')!
    expect(svg).toHaveAttribute('viewBox', '0 0 16 16')
    expect(svg).toHaveAttribute('width', '13')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg.querySelectorAll('path')).toHaveLength(2)
    expect(svg.querySelector('path')).toHaveAttribute('stroke', 'currentColor')
  })

  it('描边不随缩放：13px 画 16 栅格的图标，线仍是 1px', () => {
    const { container } = render(<Icon name="folder" size={13} />)
    const stroked = container.querySelectorAll('[stroke="currentColor"]')
    expect(stroked.length).toBeGreaterThan(0)
    for (const shape of stroked) expect(shape).toHaveAttribute('vector-effect', 'non-scaling-stroke')
  })

  it('描边写在根上的图标，各个图形也不随缩放', () => {
    const { container } = render(<Icon name="chevronsUpDown" size={14} />)
    const shapes = container.querySelectorAll('svg > *')
    expect(shapes.length).toBeGreaterThan(0)
    for (const shape of shapes) expect(shape).toHaveAttribute('vector-effect', 'non-scaling-stroke')
  })

  it('纯填充的图标不加描边设置', () => {
    const { container } = render(<Icon name="info" size={14} />)
    expect(container.querySelector('[vector-effect]')).toBeNull()
  })

  it('带连字符的属性按 SVG 原名写出', () => {
    const { container } = render(<Icon name="globe" />)
    expect(container.querySelector('[stroke-linecap="square"]')).not.toBeNull()
  })
})

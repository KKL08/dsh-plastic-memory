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

  it('带连字符的属性按 SVG 原名写出', () => {
    const { container } = render(<Icon name="globe" />)
    expect(container.querySelector('[stroke-linecap="square"]')).not.toBeNull()
  })
})

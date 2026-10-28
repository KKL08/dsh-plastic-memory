import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { createFakeGateway } from '../gateway.fake.ts'
import { createTranslator } from '../i18n.tsx'
import { en, zh } from '../locales.ts'
import { memoryPageCss } from '../MemoryPage.tsx'
import { PanelShell, PM_CSS } from './PanelShell.tsx'

describe('PanelShell 样式', () => {
  it('<style> 随组件渲染，卸载即移除', () => {
    const { container, unmount } = render(<PanelShell gateway={createFakeGateway()} t={createTranslator(zh)}><span /></PanelShell>)
    const root = container.querySelector('.pm-root')!
    expect(root.querySelector('style')?.textContent).toContain('--pm-accent')
    expect(document.querySelectorAll('style[data-plastic-memory]')).toHaveLength(1)
    unmount()
    expect(document.querySelectorAll('style[data-plastic-memory]')).toHaveLength(0)
  })

  it('颜色字面量只有银藤三档的亮暗值，其余都是 --dsw-* 令牌', () => {
    const css = PM_CSS + memoryPageCss
    const literals = css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/gi) ?? []
    expect([...new Set(literals.map(s => s.toUpperCase()))].sort()).toEqual(
      ['#27252C', '#645F77', '#887FA8', '#B0A8CB', '#BFB9D4', '#F2F0F9'],
    )
  })

  it('暗色跟 body[data-ds-dark-theme] 换银藤三档；类名都带 pm- 前缀；不写 font-family（等宽字只借宿主 --dsw-font-mono）', () => {
    expect(PM_CSS).toMatch(/body\[data-ds-dark-theme\] \.pm-root \{[^}]*--pm-accent: #B0A8CB;[^}]*--pm-accent-tint: #27252C;[^}]*--pm-accent-soft: #645F77;/)
    const classes = (PM_CSS + memoryPageCss).match(/\.[a-z][\w-]*/gi) ?? []
    expect(classes.filter(c => !c.startsWith('.pm-'))).toEqual([])
    const mono = 'font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
    expect((PM_CSS + memoryPageCss).split(mono).join('')).not.toMatch(/font-family|monospace/)
  })
})

describe('locale 字典', () => {
  it('中英键一致、没有空串', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    expect(Object.values(en).filter(v => v === '')).toEqual([])
    expect(Object.values(zh as Record<string, string>).filter(v => v === '')).toEqual([])
  })
})

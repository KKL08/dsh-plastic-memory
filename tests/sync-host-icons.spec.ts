// 宿主图标抽取脚本的 SVG 拆解：只收 path / circle / rect / line，别的元素和属性直接报错，不悄悄丢图形；
// 图标数据随包发布，许可声明也要进两份发布清单。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOST_ICONS, parseSvg } from '../scripts/sync-host-icons.ts'
import { HOST_ICON_DATA } from '../client/ui/host-icons.ts'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] }

describe('parseSvg', () => {
  it('拆出 viewBox、描边宽度和子元素属性', () => {
    const data = parseSvg('X', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1.3"><path d="M1 1L2 2" stroke="currentColor" stroke-linecap="square"></path><circle cx="4" cy="4" r="1" fill="currentColor"/></svg>')
    expect(data).toEqual({
      viewBox: '0 0 16 16',
      strokeWidth: '1.3',
      root: {},
      shapes: [
        { tag: 'path', attrs: { d: 'M1 1L2 2', stroke: 'currentColor', 'stroke-linecap': 'square' } },
        { tag: 'circle', attrs: { cx: '4', cy: '4', r: '1', fill: 'currentColor' } },
      ],
    })
  })

  it('根上的描边、线头写进数据（有的宿主图标只在根上写 stroke）', () => {
    const data = parseSvg('X', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1L2 2"></path></svg>')
    expect(data.root).toEqual({ stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  })

  it('根上不认识的属性报错', () => {
    expect(() => parseSvg('X', '<svg viewBox="0 0 16 16" transform="scale(2)"><path d="M0 0"></path></svg>')).toThrow(/<svg> 不支持属性 transform/)
  })

  it('遇到 mask、clipPath 这类元素报错', () => {
    expect(() => parseSvg('X', '<svg viewBox="0 0 16 16"><mask id="m"><path d="M0 0"></path></mask></svg>')).toThrow(/不支持的元素/)
  })

  it('遇到不认识的属性报错', () => {
    expect(() => parseSvg('X', '<svg viewBox="0 0 16 16"><path d="M0 0" transform="rotate(9)"></path></svg>')).toThrow(/不支持属性 transform/)
  })
})

describe('生成的图标数据', () => {
  it('和脚本的图标清单一一对应，每个都有图形', () => {
    expect(Object.keys(HOST_ICON_DATA).sort()).toEqual(Object.keys(HOST_ICONS).sort())
    for (const icon of Object.values(HOST_ICON_DATA)) {
      expect(icon.shapes.length).toBeGreaterThan(0)
      // 每个图形自己或根上要有描边或填充，否则画出来是透明的
      for (const shape of icon.shapes) expect({ ...icon.root, ...shape.attrs }).toSatisfy((a: Record<string, string>) => a.stroke !== undefined || (a.fill !== undefined && a.fill !== 'none'))
    }
  })
})

describe('许可声明', () => {
  it('THIRD_PARTY_NOTICES.md 在两份发布清单里', () => {
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES.md')
    const out = join(mkdtempSync(join(tmpdir(), 'pm-shape-')), 'package.json')
    execFileSync(process.execPath, ['scripts/publish-shape.cjs', 'package.json', out])
    expect((JSON.parse(readFileSync(out, 'utf8')) as { files: string[] }).files).toContain('THIRD_PARTY_NOTICES.md')
  })
})

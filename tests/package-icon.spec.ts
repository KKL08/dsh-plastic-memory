// 插件页卡片图标：宿主读 package.json 顶层 icon（相对包根，SVG/PNG/JPEG/WebP，不超过 256 KiB），
// 文件必须随包发布，两份发布清单（package.json files 与 publish-shape 改写）都要带上。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { icon?: string; files: string[] }

describe('插件图标', () => {
  it('package.json 声明 icon，文件是不超过 256 KiB 的 SVG', () => {
    expect(pkg.icon).toBe('./assets/icon.svg')
    const file = pkg.icon!.replace(/^\.\//, '')
    expect(statSync(file).size).toBeLessThanOrEqual(256 * 1024)
    expect(readFileSync(file, 'utf8')).toMatch(/^<svg [^>]*viewBox="0 0 36 36"/)
  })

  it('图标在两份发布清单里', () => {
    expect(pkg.files).toContain('assets/icon.svg')
    const out = join(mkdtempSync(join(tmpdir(), 'pm-shape-')), 'package.json')
    execFileSync(process.execPath, ['scripts/publish-shape.cjs', 'package.json', out])
    const shaped = JSON.parse(readFileSync(out, 'utf8')) as { icon?: string; files: string[] }
    expect(shaped.files).toContain('assets/icon.svg')
    expect(shaped.icon).toBe('./assets/icon.svg')
  })
})

// 宿主的插件管理页把 README 渲染成插件详情，相对路径的图片从已安装的包里读：没随包发布就是一张裂图。
describe('README 里的本地图片', () => {
  const images = ['README.md', 'README.en.md'].flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(m => m[1]!).filter(src => !/^[a-z]+:/i.test(src)))

  it('README 引用了本地图片（防止正则失效后下一条空过）', () => {
    expect(images.length).toBeGreaterThan(0)
  })

  it('每张都在两份发布清单里', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'pm-shape-')), 'package.json')
    execFileSync(process.execPath, ['scripts/publish-shape.cjs', 'package.json', out])
    const shaped = JSON.parse(readFileSync(out, 'utf8')) as { files: string[] }
    for (const src of images) {
      expect(pkg.files, src).toContain(src)
      expect(shaped.files, src).toContain(src)
    }
  })
})

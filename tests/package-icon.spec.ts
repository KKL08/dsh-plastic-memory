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

// 插件页详情读 locale/<语言>.json 的 meta.detail 指向的 Markdown，各语言最后回退到英文，再回退到 README。
// 中英文都指向随包发布的文档，插件页就不会显示 README；文档里的相对路径图片从已安装的包里读，没随包发布就是裂图。
describe('插件页详情文档', () => {
  const docs = ['en', 'zh'].map(lang => {
    const meta = (JSON.parse(readFileSync(`locale/${lang}.json`, 'utf8')) as { meta: { detail?: string } }).meta
    return { lang, detail: meta.detail }
  })

  it('中英文都声明了 meta.detail，指向 locale/ 下存在的 Markdown 文件', () => {
    for (const { lang, detail } of docs) {
      expect(detail, lang).toMatch(/^locale\/[^/]+\.md$/)
      expect(statSync(detail!).isFile(), lang).toBe(true)
    }
    expect(pkg.files).toContain('locale')
  })

  it('文档里的本地图片都在两份发布清单里', () => {
    const images = docs.flatMap(({ detail }) =>
      [...readFileSync(detail!, 'utf8').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map(m => m[1]!).filter(src => !/^[a-z]+:/i.test(src)))
    const out = join(mkdtempSync(join(tmpdir(), 'pm-shape-')), 'package.json')
    execFileSync(process.execPath, ['scripts/publish-shape.cjs', 'package.json', out])
    const shaped = JSON.parse(readFileSync(out, 'utf8')) as { files: string[] }
    for (const src of images) {
      const path = join('locale', src).replace(/\\/g, '/')
      expect(pkg.files.some(f => path === f || path.startsWith(`${f}/`)), path).toBe(true)
      expect(shaped.files.some(f => path === f || path.startsWith(`${f}/`)), path).toBe(true)
    }
  })
})

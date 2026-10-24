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

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryToolRowCss } from './chat/MemoryToolRow.tsx'
import { SLOT_STYLES } from './styles.ts'
import { PM_STYLES } from './ui/PanelShell.tsx'

/**
 * 所有插槽根的 `<style>` 同处一个文档，类名是全局的。一份样式常量算一个模块：直接给某个类上样式的规则，这个类归这个模块；
 * 别的模块再用这个类，必须带上祖先限定（如 `.pm-side .pm-btn`），否则两边的规则会互相套上。
 */
const REGISTERED: Record<string, string> = {
  ...PM_STYLES,
  ...Object.assign({}, ...Object.values(SLOT_STYLES)),
  memoryToolRowCss, // 工具记录不在插槽根里，自带一份 <style>
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

function splitTopLevel(prelude: string, at: (c: string) => boolean): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i]!
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && at(c)) { parts.push(prelude.slice(start, i)); start = i + 1 }
  }
  return [...parts, prelude.slice(start)]
}

/** 每条规则的选择器；@media 这类块里的规则照算，@keyframes 的帧没有类名，自然落空。 */
const selectorsOf = (css: string) => [...stripComments(css).matchAll(/([^{}]+)\{/g)]
  .map(m => m[1]!.trim())
  .filter(prelude => !prelude.startsWith('@'))
  .flatMap(prelude => splitTopLevel(prelude, c => c === ','))
  .map(s => s.trim())

/** 每个插槽根都在的祖先：`.pm-root`、`body`（含暗色的 `body[…]`）、`html`、`:root`。拿它们打头不算限定。 */
const isDocumentWide = (compound: string) => compound === '.pm-root' || /^(body|html|:root)(?![\w-])/.test(compound)

/**
 * 去掉打头的全文档祖先后，选择器只剩一节、这一节只带一个类名（标签名、伪类和属性不算）时，规则直接给这个类上样式，类归这个模块。
 * 带了祖先或兄弟（`.pm-side .pm-btn`、`.pm-a + .pm-b`）、或再叠一个类收窄（`.pm-btn.pm-run`）的规则不归谁。
 */
function ownedClass(selector: string): string | undefined {
  const parts = splitTopLevel(selector, c => /[\s>+~]/.test(c)).filter(part => part !== '')
  const compounds = parts.slice(parts.findIndex(part => !isDocumentWide(part)))
  if (compounds.length !== 1) return undefined
  let compound = compounds[0]!
  for (let prev = ''; prev !== compound;) [prev, compound] = [compound, compound.replace(/\([^()]*\)/g, '')]
  const classes = compound.match(/\.[\w-]+/g) ?? []
  return classes.length === 1 ? classes[0]!.slice(1) : undefined
}

function collisions(styles: Record<string, string>): [string, string[]][] {
  const owners = new Map<string, Set<string>>()
  for (const [module, css] of Object.entries(styles)) {
    for (const selector of selectorsOf(css)) {
      const name = ownedClass(selector)
      if (name !== undefined) owners.set(name, (owners.get(name) ?? new Set()).add(module))
    }
  }
  return [...owners].filter(([, modules]) => modules.size > 1).map(([name, modules]) => [name, [...modules].sort()])
}

const sourceFiles = (dir: string) => readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter(file => /\.tsx?$/.test(file) && !/\.spec\.tsx?$/.test(file))

const styleConstantsIn = (source: string) => [...source.matchAll(/^(?:export )?const (\w+Css)\s*=\s*(?:\w+\s*\+\s*)*`/gm)].map(m => m[1]!)

const definedStyleConstants = (dir: string) => sourceFiles(dir).flatMap(file => styleConstantsIn(readFileSync(join(dir, file), 'utf8')))

const filesInjectingStyle = (dir: string) => sourceFiles(dir).filter(file => /<style[\s>]/.test(readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))

describe('样式撞名', () => {
  it('PA-47：两个模块给同一个类写不带祖先限定的规则，算撞名；带了祖先限定的不算', () => {
    expect(collisions({ aCss: '.pm-x { color: red; }', bCss: '.pm-y .pm-x { gap: 0; }\n.pm-x:hover { gap: 1px; }' }))
      .toEqual([['pm-x', ['aCss', 'bCss']]])
    expect(collisions({ aCss: '.pm-x { color: red; }', bCss: '.pm-y > .pm-x, .pm-x + .pm-w { gap: 0; }' }))
      .toEqual([])
    expect(collisions({ aCss: '.pm-x { color: red; }', bCss: '.pm-x.pm-y { gap: 0; }\n.pm-x:not(.pm-y) .pm-w { gap: 0; }' }))
      .toEqual([])
    expect(collisions({ aCss: '.pm-x { color: red; }', bCss: ".pm-x[aria-disabled='true'] { opacity: .4; }" }))
      .toEqual([['pm-x', ['aCss', 'bCss']]])
    expect(collisions({ aCss: '.pm-x { color: red; }', bCss: 'button.pm-x { gap: 0; }' }))
      .toEqual([['pm-x', ['aCss', 'bCss']]])
  })

  it('每个插槽根都有的 .pm-root、body、:root 当祖先不算限定：规则照样套到全文档', () => {
    for (const selector of ['.pm-root .pm-x', 'body[data-ds-dark-theme] .pm-x', ':root .pm-x', 'body[data-ds-dark-theme] .pm-root > .pm-x']) {
      expect(collisions({ aCss: '.pm-x { color: red; }', bCss: `${selector} { gap: 0; }` })).toEqual([['pm-x', ['aCss', 'bCss']]])
    }
    expect(collisions({ aCss: '.pm-x { color: red; }', bCss: '.pm-root--page .pm-x { gap: 0; }' })).toEqual([])
    expect(collisions({ aCss: '@media (max-width: 1px) { .pm-x { gap: 0; } }', bCss: '/* .pm-x */ .pm-y:not(.pm-x) { gap: 0; }' }))
      .toEqual([])
  })

  it('插件的全部样式没有撞名', () => {
    expect(collisions(REGISTERED)).toEqual([])
  })

  it('PA-47：客户端里定义的样式常量都登记了', () => {
    expect(definedStyleConstants(import.meta.dirname).sort()).toEqual(Object.keys(REGISTERED).sort())
  })

  it('漏登记检查也认不导出、拼接出来的样式常量', () => {
    expect(styleConstantsIn('const aCss = `.pm-a {}`\nexport const bCss =\n  aCss + `.pm-b {}`\nconst PAGE_CSS = slotCss()\nexport const slotCss = (slot: string) => slot')).toEqual(['aCss', 'bCss'])
  })

  it('只有插槽外壳和工具记录自己插 <style>，别的组件的样式都走登记表', () => {
    expect(filesInjectingStyle(import.meta.dirname).sort()).toEqual(['chat/MemoryToolRow.tsx', 'ui/PanelShell.tsx'])
  })

  it('各插槽根不再重复带公共样式', () => {
    for (const styles of Object.values(SLOT_STYLES)) {
      expect(Object.keys(styles).filter(name => name in PM_STYLES)).toEqual([])
    }
  })
})

describe('全部样式的写法', () => {
  const css = stripComments(Object.values(REGISTERED).join(''))

  it('颜色字面量只有银藤三档的亮暗值，其余都是 --dsw-* 令牌', () => {
    const literals = css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b(?!-)/gi) ?? []
    expect([...new Set(literals.map(s => s.toUpperCase()))].sort()).toEqual(
      ['#27252C', '#645F77', '#887FA8', '#B0A8CB', '#BFB9D4', '#F2F0F9'],
    )
  })

  it('类名都带 pm- 前缀', () => {
    expect((css.match(/\.[a-z][\w-]*/gi) ?? []).filter(c => !c.startsWith('.pm-'))).toEqual([])
  })

  it('不写 font-family，等宽字只借宿主 --dsw-font-mono', () => {
    const mono = 'font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'
    expect(css.split(mono).join('')).not.toMatch(/font-family|monospace/)
  })
})

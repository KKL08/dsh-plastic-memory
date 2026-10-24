import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { bigramSegmenter, createTokenizer, type CjkSegmenter } from '../src/search/tokenizer.ts'

const tokenize = createTokenizer()

describe('检索分词器：非 CJK 段整词 + 子词', () => {
  it('驼峰、下划线、连字符拆出子词，整词与子词都保留并小写', () => {
    expect(tokenize('readScope')).toEqual(['readscope', 'read', 'scope'])
    expect(tokenize('memory_source')).toEqual(['memory_source', 'memory', 'source'])
    expect(tokenize('read-scope')).toEqual(['read-scope', 'read', 'scope'])
  })

  it('单个字母与纯数字的子词不输出，整词仍保留；字母数字边界与连续大写都拆开', () => {
    expect(tokenize('mem_7f')).toEqual(['mem_7f', 'mem'])
    expect(tokenize('HTTP2Server')).toEqual(['http2server', 'http', 'server'])
    expect(tokenize('HTTPServer')).toEqual(['httpserver', 'http', 'server'])
    // 拆不开的整词只出一次，不因「子词等于整词」重复计频
    expect(tokenize('memory')).toEqual(['memory'])
    // 子词全被过滤时只剩整词
    expect(tokenize('v2')).toEqual(['v2'])
  })
})

describe('检索分词器：CJK 段', () => {
  it('长度 ≥ 2 切二字滑窗，单字段保留单字，中英混排各段独立切', () => {
    expect(tokenize('宿主插件页')).toEqual(['宿主', '主插', '插件', '件页'])
    expect(tokenize('页')).toEqual(['页'])
    expect(tokenize('宿主readScope插件页')).toEqual(['宿主', 'readscope', 'read', 'scope', '插件', '件页'])
    expect(bigramSegmenter.segment('宿主插件')).toEqual(['宿主', '主插', '插件'])
  })

  it('超长 CJK 段（15 万汉字）切分不抛，token 数等于字数减一', () => {
    const tokens = tokenize('中'.repeat(150_000))
    expect(tokens).toHaveLength(149_999)
    expect(tokens[0]).toBe('中中')
  })
})

describe('检索分词器：大小写与标点', () => {
  it('大小写不影响结果；全标点输入返回空数组；按出现顺序返回且不去重', () => {
    expect(tokenize('MEMORY_SOURCE')).toEqual(tokenize('memory_source'))
    expect(tokenize('Memory_Source')).toEqual(tokenize('memory_source'))
    expect(tokenize('PNPM 包管理')).toEqual(tokenize('pnpm 包管理'))
    expect(tokenize('，。！？…—-_ ()[]「」')).toEqual([])
    expect(tokenize('')).toEqual([])
    expect(tokenize('pnpm, pnpm。包管理')).toEqual(['pnpm', 'pnpm', '包管', '管理'])
  })
})

describe('检索分词器：可注入 CJK 切分器', () => {
  it('CJK 段的 token 来自注入实现，Latin 段仍走默认切法', () => {
    const seen: string[] = []
    const fake: CjkSegmenter = {
      segment(run) {
        seen.push(run)
        return [`<${run}>`]
      },
    }
    const tok = createTokenizer({ cjk: fake })

    expect(tok('宿主readScope插件页')).toEqual(['<宿主>', 'readscope', 'read', 'scope', '<插件页>'])
    expect(seen).toEqual(['宿主', '插件页'])
  })
})

describe('检索分词器：叶子模块', () => {
  it('只 import 类型或 Node 内置：不碰插件入口、不读配置', () => {
    const source = readFileSync(new URL('../src/search/tokenizer.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^\s*import\s+(type\s+)?[^'"]*?['"]([^'"]+)['"]/gm)]
    const offending = imports
      .filter(([, typeOnly, spec]) => typeOnly === undefined && !spec!.startsWith('node:'))
      .map(([line]) => line.trim())
    expect(offending).toEqual([])
    expect(source).not.toMatch(/from\s+['"][^'"]*\/index(\.ts)?['"]/)
  })
})

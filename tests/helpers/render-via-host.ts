import { renderContextSections, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { PROMPT_LBRACE_VARIABLE } from '../../src/snapshot.ts'

/**
 * 用宿主真实的 renderContextSections 渲染本插件那条 context，变量表只有 apply() 注册的
 * 左花括号变量。返回渲染后的文本；宿主把空文本 context 过滤掉时返回 ''。
 * 转义是否对宿主无损只有宿主自己的渲染函数能证明，往返断言都经这里。
 */
export function renderViaHost(text: string): string {
  const assembly: PromptAssembly = {
    sections: [],
    contexts: [{ name: 'plastic-memory', text }],
    tools: [],
    variables: { [PROMPT_LBRACE_VARIABLE]: '{{' },
  }
  const sections = renderContextSections(assembly)
  return sections[0]?.text ?? ''
}

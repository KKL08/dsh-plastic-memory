// client 组件测试的公共设置：jest-dom 断言，每个用例后卸载渲染树。
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  // jsdom 29 移除 `<style>` 的祖先节点时不撤它的样式表（30 已修），卸载后整份插件样式留在 document.styleSheets 里，
  // 一个文件跑下来累积上万条规则，此后每次 getComputedStyle（getByRole 算无障碍名逐节点调）都要全部重套。
  // 表本身移不出列表，只能清空规则。
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.ownerNode?.isConnected !== true) while (sheet.cssRules.length > 0) sheet.deleteRule(0)
  }
})

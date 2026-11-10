/** 路径的最后一段（项目目录名）；纯函数，给不依赖 React 的模块（如对话卡的文本解析）用。 */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** 在 macOS 上：「在访达中显示」和别的系统的「在文件管理器中显示」用这个判断选文案。 */
export const isMac = () => typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

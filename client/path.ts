/** 路径的最后一段（项目目录名）；纯函数，给不依赖 React 的模块（如对话卡的文本解析）用。 */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

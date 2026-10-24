import { homedir } from 'node:os'
import { join, basename, sep } from 'node:path'
import { createHash } from 'node:crypto'

export const WORKSPACE_MARKER = '.workspace'
export const INDEX_FILE = 'MEMORY.md'
export const GLOBAL_DIR = 'global'
/** 侧表目录（storage/sidecar.ts），不是 workspace 目录 */
export const STATE_DIR = '.state'
/** 每个记忆目录下的归档子目录：deleted / superseded 的文件住这里（设计稿 §1）。 */
export const ARCHIVE_DIR = '.archive'

export function resolveMemoryRoot(configured: string): string {
  if (configured) return configured
  const dshHome = process.env.DSH_HOME
  return join(dshHome ?? join(homedir(), '.dsh'), 'memories')
}

/** APFS 等大小写不敏感文件系统上，memory.md 会与索引 MEMORY.md 相互覆盖——文件命名处必须避让。 */
export function isReservedFileName(fileName: string): boolean {
  return fileName.toLowerCase() === INDEX_FILE.toLowerCase()
}

/** 目录顶层哪些文件名算记忆文件：.md 结尾、不是索引、不以 . 开头（原子写的 tmp 以 .tmp-<pid>-<rand> 结尾，天然排除）。 */
export function isMemoryFileName(fileName: string): boolean {
  return fileName.endsWith('.md') && !fileName.startsWith('.') && !isReservedFileName(fileName)
}

/** 根目录下哪些子目录可能是 workspace 目录：排除 global 与所有隐藏目录（.state/、.archive/ 等）。 */
export function isWorkspaceDirName(dirName: string): boolean {
  return dirName !== GLOBAL_DIR && !dirName.startsWith('.')
}

export function slugifyName(name: string): string {
  // 截断后再去一次尾部连字符：slice 可能恰好落在分隔符位而重新露出 '-'，不去掉则 slug
  // 不幂等（slug(slug(x)) !== slug(x)）且文件名以 '-' 结尾。
  const s = name.trim().replace(/[\/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
  return s.length > 0 ? s : 'memory'
}

/**
 * 记忆文件相对记忆根目录的写法：`<目录名>/<文件名>`（如 global/看板.md）。两个参数传末段名或绝对路径都行，只取末段。
 * 注入索引行用它；工具结果给绝对路径，不经它。
 */
export function memoryRelativePath(dir: string, file: string): string {
  return `${basename(dir)}/${basename(file)}`
}

/** 确定性目录名：可读前缀 + 路径 hash。slug 不承担可逆性——真路径存 .workspace 标记。 */
export function workspaceDirName(workspacePath: string): string {
  const hash = createHash('sha1').update(workspacePath).digest('hex').slice(0, 8)
  return `${slugifyName(basename(workspacePath))}-${hash}`
}

/**
 * 手建文件（frontmatter 缺 id）的确定性派生 id：`mem_f` + sha1(相对 memoryRoot 的 POSIX 路径，大小写保留)[:10]。
 * 会进 supersedes、账本和快照——算法是难撤销契约（ARCHITECTURE.md ⑥-4），改了旧引用就断。
 */
export function deriveFileId(relPath: string): string {
  const posix = relPath.split(sep).join('/')
  return `mem_f${createHash('sha1').update(posix).digest('hex').slice(0, 10)}`
}

/** 派生 id 的形态：定位时按文件路径重算哈希比对，不读内容。写入管线生成的 id 是 mem_ + 时间戳 base36 + 随机段，
 *  时间戳段当前以 l/m 开头，不会撞上这个形态。 */
export function isDerivedFileId(id: string): boolean {
  return /^mem_f[0-9a-f]{10}$/.test(id)
}

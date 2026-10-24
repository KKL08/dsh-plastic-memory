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

/**
 * 目录顶层哪些文件名算记忆文件：.md 结尾、不是索引。文件名由记忆名字生成，名字可以以点开头（「.env 约定」），
 * 所以点开头的照常算。原子写的 tmp 以 .tmp-<pid>-<rand> 结尾，天然排除。
 */
export function isMemoryFileName(fileName: string): boolean {
  return fileName.endsWith('.md') && !isReservedFileName(fileName)
}

/**
 * 与 macOS 在非原生卷上生成的 ._ 伴生文件、编辑器的 .# 锁文件同形的文件名。照常读：解析成合法记忆就加载（旧版本按名字
 * 生成过这类文件名），解析不出就静默跳过，不进隔离，也不计入列出文件数。slugifyName 不会生成这个形态。
 */
export function isCompanionLikeFileName(fileName: string): boolean {
  return fileName.startsWith('._') || fileName.startsWith('.#')
}

/**
 * 根目录下哪些子目录可能是 workspace 目录：排除 global 与插件自己的 .state/、.archive/。
 * 目录名取自项目目录名，项目在 ~/.dotfiles 这类路径下时也以点开头；是不是 workspace 目录由 .workspace 标记定。
 */
export function isWorkspaceDirName(dirName: string): boolean {
  return dirName !== GLOBAL_DIR && dirName !== STATE_DIR && dirName !== ARCHIVE_DIR
}

export function slugifyName(name: string): string {
  // 截断后再去一次尾部连字符：slice 可能恰好落在分隔符位而重新露出 '-'，不去掉则 slug
  // 不幂等（slug(slug(x)) !== slug(x)）且文件名以 '-' 结尾。
  const s = name.trim().replace(/[\/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '')
  // 以 ._ / .# 开头的名字去掉开头的点：同伴生文件形态的文件解析不出时读侧静默跳过，用户手编坏了就无从发现。
  // 去点后以 _ / # 开头，不会再命中这条，也不露出新的连字符，幂等不变。
  const t = isCompanionLikeFileName(s) ? s.slice(1) : s
  return t.length > 0 ? t : 'memory'
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

import { homedir } from 'node:os'
import type { loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import type { MemoryRecord } from '../record-schema.ts'
import { scopeKey, type Scope } from '../scope.ts'

/**
 * 指令文件（AGENTS.md / CLAUDE.md）按作用域现读：一个项目的指令文件 = 在它的 workspacePath 开新会话时模型读到的那段，
 * 用宿主自己的发现和渲染规则（宿主指令文件包的 loadBaselineInstructions），和会话无关。项目取全局层加项目层；
 * 全局只取全局层（项目候选文件名、项目根标记都给空）。子目录里的指令文件、会话中途追加的都不算。只读，不写任何东西。
 */

/** 指令文件总量的上限（字节）：宿主各 preset 的默认值。运行时没有公开接口读 preset 的配置，固定用它。 */
export const INSTRUCTION_MAX_BYTES = 65_536

/** 宿主指令文件包里用到的那一个函数。 */
export interface InstructionsModule {
  loadBaselineInstructions: typeof loadBaselineInstructions
}

/**
 * 一个作用域的指令文件：found 是渲染好的文本（语义扫描和指纹用的形状：一段一个元素，现在只有一段），isTruncated 是总量超上限、
 * 宿主只留了一部分；none 是一个指令文件都没有；unavailable 是取不到（宿主包加载不了、读取出错），带原因。
 */
export type InstructionFiles =
  | { kind: 'found'; texts: readonly string[]; isTruncated: boolean }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }

/** 按作用域取指令文件：项目是全局层加这个项目，全局只有全局层。 */
export type ReadInstructions = (scope: Scope) => Promise<InstructionFiles>

/**
 * 读取器。load 加载宿主指令文件包（装配入口动态 import，解析到宿主自己那份）；加载失败或读取抛错都算取不到，不往外抛。
 * 全局层的位置由宿主按进程环境变量（DSH_HOME、DSH_AGENTS_HOME）定。
 */
export function createInstructionReader(load: () => Promise<InstructionsModule>): ReadInstructions {
  return async scope => {
    let rendered
    try {
      const { loadBaselineInstructions: loadFiles } = await load()
      rendered = await loadFiles(scope.kind === 'workspace'
        ? { cwd: scope.workspacePath, maxBytes: INSTRUCTION_MAX_BYTES }
        : { cwd: homedir(), maxBytes: INSTRUCTION_MAX_BYTES, instructionFileCandidates: [], localInstructionFileCandidates: [], projectRootMarkers: [] })
    } catch (err) {
      return { kind: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
    }
    if (rendered === undefined || rendered.text.length === 0) return { kind: 'none' }
    return { kind: 'found', texts: [rendered.text], isTruncated: rendered.omitted.length > 0 || rendered.truncated.length > 0 }
  }
}

/** 同一次体检内每个作用域只读一次：第一次的结果（含进行中的那次）给之后的调用共用。 */
export function cacheInstructions(read: ReadInstructions): ReadInstructions {
  const seen = new Map<string, Promise<InstructionFiles>>()
  return scope => {
    const key = scopeKey(scope)
    let files = seen.get(key)
    if (files === undefined) seen.set(key, files = read(scope))
    return files
  }
}

/** 给语义扫描和指纹用的文本；没有或取不到为 null。 */
export function instructionTexts(files: InstructionFiles): readonly string[] | null {
  return files.kind === 'found' ? files.texts : null
}

/** 这条记忆的垂直冲突对照的指令文件文本：项目记忆对它所在项目的（含全局层），全局记忆只对全局层；没有或取不到为 null。 */
export async function baselineFor(read: ReadInstructions, memory: Pick<MemoryRecord, 'scope' | 'workspacePath'>): Promise<readonly string[] | null> {
  const scope: Scope = memory.scope === 'workspace' && memory.workspacePath !== undefined ? { kind: 'workspace', workspacePath: memory.workspacePath } : { kind: 'global' }
  return instructionTexts(await read(scope))
}

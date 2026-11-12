import type { InstructionFiles, ReadInstructions } from '../../src/governance/instructions.ts'
import { scopeKey } from '../../src/scope.ts'

/**
 * 测试用的取指令文件（读磁盘的那一层换成固定内容）：按作用域键（全局 `global`、项目为路径）给渲染好的文本，
 * 项目键给的就是全局层加本项目的那一段；也可以直接给一份结果（取不到、被截断）。没列出的作用域按没有指令文件。
 */
export function instructionsOf(byScope: Record<string, string | InstructionFiles | (() => string | InstructionFiles)> = {}): ReadInstructions {
  return async scope => {
    const given = byScope[scopeKey(scope)]
    const value = typeof given === 'function' ? given() : given
    if (value === undefined) return { kind: 'none' }
    return typeof value === 'string' ? { kind: 'found', texts: [value], isTruncated: false } : value
  }
}

/** 哪个作用域都没有指令文件。 */
export const noInstructions: ReadInstructions = instructionsOf()

import type { FrontmatterErrorCode } from './contract-codes.ts'

/** 按 id 找不到记录（store / file-table 的 update 路径）。 */
export class RecordNotFoundError extends Error {
  readonly id: string
  constructor(id: string) {
    super(`记录不存在：${id}`)
    this.name = 'RecordNotFoundError'
    this.id = id
  }
}

/** 记忆文件的 frontmatter 解析/校验失败，code 说明是哪一类。 */
export class FrontmatterError extends Error {
  readonly code: FrontmatterErrorCode
  constructor(code: FrontmatterErrorCode, message: string) {
    super(message)
    this.name = 'FrontmatterError'
    this.code = code
  }
}

/** 类型注册表配置冲突（目前只有一种：自定义/模板类型与内置类型重名）。 */
export class TypeRegistryError extends Error {
  readonly code: 'builtin-collision'
  constructor(code: 'builtin-collision', message: string) {
    super(message)
    this.name = 'TypeRegistryError'
    this.code = code
  }
}

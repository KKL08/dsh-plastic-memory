import { readFile } from 'node:fs/promises'

/** 去掉提交标记那一行：它每次写入换一个操作 id，和内容无关。 */
export function withoutWriteStamp(text: string): string {
  return text.replace(/^lastWriteOp: .*\n/m, '')
}

/** 记忆文件的原文，不含提交标记：比较「撤销、退回之后和原来一字不差」用。 */
export async function memoryText(path: string): Promise<string> {
  return withoutWriteStamp(await readFile(path, 'utf8'))
}

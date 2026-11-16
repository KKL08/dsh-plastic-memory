/**
 * 精确修改（memory_save update 的 edits）的匹配与替换。叶子模块，不 import 任何东西：写入管线用它算新正文，
 * 浏览器半侧（经 gui/contract.ts）用它按改前快照重算这次改出来的样子。
 */

/** 精确修改的一处：oldString 原样摘自当前正文，要在正文里唯一命中；replaceAll 时替换全部命中。 */
export interface SaveEdit {
  oldString: string
  newString: string
  replaceAll?: boolean
}

/** 应用结果：成功给新正文；不成立时给第几处（从 0 起）、哪种原因、命中几次。 */
export type EditOutcome =
  | { content: string }
  | { failure: 'not-found' | 'ambiguous'; index: number; count: number }

const lf = (text: string) => text.replace(/\r\n/g, '\n')

/** 按顺序应用每处修改（后一处匹配前一处改完的结果），任一处不成立整批作废。CRLF 一律按 LF 匹配、结果是 LF。 */
export function applyEdits(content: string, edits: readonly SaveEdit[]): EditOutcome {
  let text = lf(content)
  for (const [index, edit] of edits.entries()) {
    const oldString = lf(edit.oldString)
    const newString = lf(edit.newString)
    const count = text.split(oldString).length - 1
    if (count === 0) return { failure: 'not-found', index, count }
    if (count > 1 && edit.replaceAll !== true) return { failure: 'ambiguous', index, count }
    // 函数形式：newString 里的 $&、$1 原样写入，不当替换模式
    text = edit.replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
  }
  return { content: text }
}

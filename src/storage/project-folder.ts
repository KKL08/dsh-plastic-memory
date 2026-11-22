import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { errnoCode } from './state-files.ts'

/**
 * 项目真正删掉了：这次的目录清单里没有它（记忆根下没有它的目录），项目文件夹本身也判为不在。
 * 体检记录、自动体检设置、语义缓存的清理共用这一个口径；还没有自己记忆的项目（项目文件夹还在）不算。
 */
export async function isWorkspaceGone(listed: ReadonlySet<string>, workspacePath: string): Promise<boolean> {
  return !listed.has(workspacePath) && !(await isProjectFolderPresent(workspacePath))
}

/**
 * 项目文件夹还在（拿不准的都按还在算）：是目录就在；路径还在但不是目录、或上级路径是普通文件（ENOTDIR），算不在了；
 * 不存在（ENOENT）时再看上级文件夹：上级在，算不在了；上级也不在，可能是外接盘、网络卷没挂载，分不清，按还在算；
 * 其余读不了的（没权限之类）也按还在算。
 */
async function isProjectFolderPresent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (err) {
    const code = errnoCode(err)
    if (code === 'ENOTDIR') return false
    if (code !== 'ENOENT') return true
  }
  try {
    await stat(dirname(path))
    return false
  } catch {
    return true
  }
}

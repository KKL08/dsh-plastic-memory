import { constants, copyFile, link, lstat, rename } from 'node:fs/promises'

/** 卷不支持硬链接时 link 的报错码（exFAT/FAT、部分网络盘与 FUSE 挂载）。 */
const NO_HARDLINK_CODES = new Set(['ENOTSUP', 'EPERM', 'ENOSYS'])

/**
 * 把写好的 tmp 排他地放到 target：目标已存在抛 EEXIST，不覆盖。
 * 正常走 link，目标原子出现且内容完整，tmp 由调用方删。卷不支持硬链接时看调用方是不是唯一的写者：
 *  - 是（持着跨进程写锁）：确认目标不存在后把 tmp 改名过去，目标同样原子出现、内容完整，tmp 随之不在了。
 *    排他只对守这把锁的写者成立：不走锁的写者（同步客户端、锁不可用的另一个进程）在确认和改名之间放下同名文件，会被盖掉；
 *  - 不是：退回 COPYFILE_EXCL 复制，同样排他，但不原子，中途退出可能留下半截目标。
 * 返回是否退回了复制：复制出的目标是另一个文件，inode 与 tmp 不同。
 */
export async function linkExclusive(tmp: string, target: string, isOnlyWriter = false): Promise<boolean> {
  try {
    await link(tmp, target)
    return false
  } catch (err) {
    if (!NO_HARDLINK_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err
    if (!isOnlyWriter) {
      await copyFile(tmp, target, constants.COPYFILE_EXCL)
      return true
    }
    if (await exists(target)) throw Object.assign(new Error(`EEXIST: file already exists, rename '${tmp}' -> '${target}'`), { code: 'EEXIST' })
    await rename(tmp, target)
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

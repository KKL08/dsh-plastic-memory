import { constants, copyFile, link } from 'node:fs/promises'

/** 卷不支持硬链接时 link 的报错码（exFAT/FAT、部分网络盘与 FUSE 挂载）。 */
const NO_HARDLINK_CODES = new Set(['ENOTSUP', 'EPERM', 'ENOSYS'])

/**
 * 把写好的 tmp 排他地放到 target：目标已存在抛 EEXIST，不覆盖；tmp 由调用方删。
 * 正常走 link，目标原子出现且内容完整。卷不支持硬链接时退回 COPYFILE_EXCL 复制：同样排他，
 * 但不原子，崩溃可能留下半截目标。
 */
export async function linkExclusive(tmp: string, target: string): Promise<void> {
  try {
    await link(tmp, target)
  } catch (err) {
    if (!NO_HARDLINK_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err
    await copyFile(tmp, target, constants.COPYFILE_EXCL)
  }
}

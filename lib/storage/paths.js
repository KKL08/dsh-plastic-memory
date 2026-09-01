import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
export const WORKSPACE_MARKER = '.workspace';
export const INDEX_FILE = 'MEMORY.md';
export const GLOBAL_DIR = 'global';
export function resolveMemoryRoot(configured) {
    if (configured)
        return configured;
    const dshHome = process.env.DSH_HOME;
    return join(dshHome ?? join(homedir(), '.dsh'), 'memories');
}
/** APFS 等大小写不敏感文件系统上，memory.md 会与索引 MEMORY.md 相互覆盖——文件命名处必须避让。 */
export function isReservedFileName(fileName) {
    return fileName.toLowerCase() === INDEX_FILE.toLowerCase();
}
export function slugifyName(name) {
    const s = name.trim().replace(/[\/\\:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return s.length > 0 ? s : 'memory';
}
/** 确定性目录名：可读前缀 + 路径 hash。slug 不承担可逆性——真路径存 .workspace 标记。 */
export function workspaceDirName(workspacePath) {
    const hash = createHash('sha1').update(workspacePath).digest('hex').slice(0, 8);
    return `${slugifyName(basename(workspacePath))}-${hash}`;
}

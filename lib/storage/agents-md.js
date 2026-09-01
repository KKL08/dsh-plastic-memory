import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * 往 ds 原生全局指令文件 ~/.dsh/AGENTS.md 的专属区块追加记忆（promote 的 agents-md 目标）。
 * 只动 dsh-memory 标记区块内的内容，用户手写的部分一字不碰。
 */
const BLOCK_START = '<!-- dsh-memory:start -->';
const BLOCK_END = '<!-- dsh-memory:end -->';
/** 独立解析 $DSH_HOME（与 paths.ts 的 resolveMemoryRoot 同源），不从 memoryRoot 反推：
 *  memoryRoot 可自定义配置到别处，反推会把内容写进 dsh 永不读取的 AGENTS.md。 */
export function agentsMdPath() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'AGENTS.md');
}
export function createAgentsMdWriter(filePath) {
    return {
        async append(line) {
            // 写入净化：进区块的文本不得长得像区块边界。区块定位靠 indexOf 标记字面量（数据与
            // 控制信号同在纯文本通道），内容里混入标记会让后续 append 误认边界、写出受管区；
            // 换行同理——区块格式是一行一条，多行内容会破坏幂等判断的按行语义。
            const sanitized = line
                .replaceAll(BLOCK_START, '').replaceAll(BLOCK_END, '')
                .replace(/\s*\n\s*/g, ' ').trim();
            const entry = `- ${sanitized}`;
            let existing = '';
            try {
                existing = await readFile(filePath, 'utf8');
            }
            catch { /* 文件不存在，按空处理 */ }
            const startIdx = existing.indexOf(BLOCK_START);
            const endIdx = existing.indexOf(BLOCK_END);
            let next;
            if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
                // 无有效区块：在文件末尾新建
                const prefix = existing ? (existing.endsWith('\n') ? existing + '\n' : existing + '\n\n') : '';
                next = `${prefix}${BLOCK_START}\n${entry}\n${BLOCK_END}\n`;
            }
            else {
                const inner = existing.slice(startIdx + BLOCK_START.length, endIdx);
                if (inner.includes(entry))
                    return; // 幂等：已有同行不重复
                const before = existing.slice(0, endIdx);
                const after = existing.slice(endIdx);
                next = `${before.endsWith('\n') ? before : before + '\n'}${entry}\n${after}`;
            }
            await mkdir(dirname(filePath), { recursive: true });
            // AGENTS.md 是用户手维护的文件，中断留下半个文件会毁掉用户内容；tmp+rename 让本次写入
            // 要么整体生效要么完全不动（与全库原子写纪律一致）。
            const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
            await writeFile(tmp, next, 'utf8');
            await rename(tmp, filePath);
        },
    };
}

import { genId } from "./schema.js";
import { RETENTION_MS } from "../retention.js";
/** 保留窗口：与软删清扫共用 retention.ts 的单一来源（两者必须一致）。 */
export const SNAPSHOT_RETENTION_MS = RETENTION_MS;
/**
 * 软删除不是"更新的编辑"，它正是要撤销的对象；把它算作冲突会让 memory_forget 的撤销默认失效。
 * 因此当前记录若已是 status: 'deleted'，即便 updatedAt 晚于快照，也不计入冲突。
 */
function isConflicting(current, snapshot) {
    return current !== undefined && current.status !== 'deleted' && current.updatedAt > snapshot.createdAt;
}
/**
 * 记忆快照（docs/p1-governance-health-design.md §6）：只管记忆数据的可恢复性，操作审计走 dsh session log。
 * 只存受影响记录，非全量。
 */
export class SnapshotStore {
    table;
    constructor(table) {
        this.table = table;
    }
    async capture(input, now) {
        const snapshot = {
            id: genId('snap'),
            createdAt: now,
            operation: input.operation,
            description: input.description,
            memoryIds: input.records.map(r => r.id),
            data: input.records,
        };
        await this.table.put(snapshot.id, snapshot);
        await this.sweep(now); // 顺手清理超窗口的旧快照
        return snapshot;
    }
    /** 清扫超保留窗口的旧快照。capture 内复用，工具入口也调用——否则停用 forget/promote 后
     * 旧快照会永留 KV。 */
    async sweep(now) {
        const cutoff = now - SNAPSHOT_RETENTION_MS;
        for (const [key, snap] of [...this.table.entries()]) {
            if (snap.createdAt < cutoff)
                await this.table.delete(key);
        }
    }
    list() {
        return [...this.table.entries()].map(([, s]) => s).sort((a, b) => b.createdAt - a.createdAt);
    }
    get(id) {
        return this.table.get(id);
    }
    diff(snapshot, lookup) {
        return snapshot.data.map(snapshotted => {
            const current = lookup(snapshotted.id);
            return {
                id: snapshotted.id,
                snapshotted,
                current,
                changedAfterSnapshot: isConflicting(current, snapshot),
            };
        });
    }
    /**
     * 选择性恢复：ids 为 undefined 恢复全部。快照后被修改过的记录默认跳过（冲突保护），
     * overwriteChanged=true 才覆盖。恢复动作本身只 put 旧数据，不做二次快照。
     */
    async restore(snapshot, ids, put, lookup, overwriteChanged) {
        const restored = [];
        const skipped = [];
        const targets = ids ? snapshot.data.filter(r => ids.includes(r.id)) : snapshot.data;
        for (const rec of targets) {
            const current = lookup(rec.id);
            if (isConflicting(current, snapshot) && !overwriteChanged) {
                skipped.push(rec.id);
                continue;
            }
            await put(rec);
            restored.push(rec.id);
        }
        return { restored, skipped };
    }
}

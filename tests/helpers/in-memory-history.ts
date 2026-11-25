import { byVersionEnd, freeVersionId, type HistoryLayer, type HistoryVersion, type VersionHistory, type VersionListing, type VersionRead } from '../../src/storage/history.ts'

/** 没有磁盘的实现（内存表配它）：语义同磁盘上的实现。 */
export class InMemoryVersionHistory implements VersionHistory {
  private readonly versions = new Map<string, HistoryVersion[]>()
  private key(layer: Pick<HistoryLayer, 'dir'>, memoryId: string): string {
    if (memoryId === '') throw new Error('历史版本要有记忆 id，空 id 不收')   // 同磁盘那份
    return `${layer.dir}\n${memoryId}`
  }

  /** 内存里没有读不出的版本：总是读全。 */
  async list(layer: HistoryLayer, memoryId: string): Promise<VersionListing> {
    const versions = structuredClone(this.versions.get(this.key(layer, memoryId)) ?? []).sort(byVersionEnd)
      .map(v => (v.mergedFrom !== undefined || v.record.id === memoryId ? v : { ...v, mergedFrom: v.record.id }))
    return { versions, isComplete: true }
  }

  async read(layer: HistoryLayer, memoryId: string, versionId: string): Promise<VersionRead> {
    const version = (await this.list(layer, memoryId)).versions.find(v => v.versionId === versionId)
    return version === undefined ? { kind: 'missing' } : { kind: 'found', version }
  }

  async countVersions(dir: string, memoryId: string): Promise<number | undefined> {
    return (this.versions.get(this.key({ dir }, memoryId)) ?? []).length
  }

  async write(layer: HistoryLayer, version: HistoryVersion): Promise<void> {
    const key = this.key(layer, version.record.id)
    const rest = (this.versions.get(key) ?? []).filter(v => v.versionId !== version.versionId)
    this.versions.set(key, [...rest, structuredClone(version)])
  }

  async remove(layer: HistoryLayer, memoryId: string, versionId: string): Promise<void> {
    const key = this.key(layer, memoryId)
    this.versions.set(key, (this.versions.get(key) ?? []).filter(v => v.versionId !== versionId))
  }

  async removeAll(dir: string, memoryId: string): Promise<void> {
    this.versions.delete(this.key({ dir }, memoryId))
  }

  async move(fromDir: string, toDir: string, memoryId: string): Promise<void> {
    const from = this.key({ dir: fromDir }, memoryId)
    const to = this.key({ dir: toDir }, memoryId)
    const moving = this.versions.get(from)
    if (from === to || moving === undefined) return
    const kept = this.versions.get(to) ?? []
    for (const version of moving) {
      const same = kept.find(v => v.versionId === version.versionId)
      if (same !== undefined && JSON.stringify(same) === JSON.stringify(version)) continue
      kept.push({ ...version, versionId: freeVersionId(version.versionId, kept.map(v => v.versionId)) })
    }
    this.versions.set(to, kept)
    this.versions.delete(from)
  }

  async place(layer: HistoryLayer, ownerId: string, version: HistoryVersion): Promise<void> {
    const key = this.key(layer, ownerId)
    const kept = this.versions.get(key) ?? []
    const same = (v: HistoryVersion) => JSON.stringify({ ...v, versionId: '' }) === JSON.stringify({ ...version, versionId: '' })
    if (kept.some(same)) return
    this.versions.set(key, [...kept, structuredClone({ ...version, versionId: freeVersionId(version.versionId, kept.map(v => v.versionId)) })])
  }

  async absorb(from: { dir: string; memoryId: string; scopeKey: string }, to: { dir: string; memoryId: string }): Promise<void> {
    const source = this.key(from, from.memoryId)
    const moving = this.versions.get(source)
    if (source === this.key(to, to.memoryId) || moving === undefined) return
    for (const version of moving) {
      await this.place({ dir: to.dir, loc: { scope: 'global' } }, to.memoryId, { ...version, mergedFrom: version.mergedFrom ?? from.memoryId, mergedFromScope: version.mergedFromScope ?? from.scopeKey })
    }
    this.versions.delete(source)
  }

  async memoryIds(dir: string): Promise<string[]> {
    return [...this.versions].filter(([key, list]) => key.startsWith(`${dir}\n`) && list.length > 0).map(([key]) => key.slice(dir.length + 1))
  }
}

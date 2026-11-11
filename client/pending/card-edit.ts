/**
 * 卡片上的记忆能不能直接改、改的时候带什么：待处理卡、记忆查看、整理所选共用。单独成文件，免得整理所选和待处理卡互相引用。
 */
import type { MemoryCard } from '../../src/gui/contract.ts'
import type { EditDraft } from './edit.tsx'

/**
 * 能不能修改：要有内容摘要（服务端靠它和 updatedAt 认出卡片加载后被改过），且不含密钥（界面上的文字可能是遮盖后的，
 * 照着改会把遮盖写回文件）。
 */
export const isEditable = (memory: MemoryCard) => memory.digest !== undefined && memory.hasSecret !== true

/** 命令里带回的卡片版本。 */
export const baseOf = (memory: MemoryCard) => ({ updatedAt: memory.updatedAt, digest: memory.digest ?? '' })

/** 单条修改的预填：这条记忆此刻的四个面。 */
export const draftOf = (memory: MemoryCard): EditDraft => ({ content: memory.content, name: memory.name, summary: memory.summary, tags: memory.tags })

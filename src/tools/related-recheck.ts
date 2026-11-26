import type { MemoryLogger } from '../store.ts'
import type { PendingDecisionsStore } from '../governance/decisions.ts'
import type { RelatedRecheckHook } from '../commit-change.ts'
import { readChangeKind } from '../record-schema.ts'
import { ledgerLabel, scopeOfMemory } from '../scope.ts'
import { maskSecretSurface } from '../secrets.ts'
import { injectionText } from '../index-line.ts'
import { sha1 } from '../governance/changeset.ts'
import { locateCopy } from './workspace-gate.ts'

/**
 * 沿关联发复查信号（实验，配置 governance.relatedRecheck，缺省关）：一张记忆做了状态变化或纠错，
 * 自己的 related 里列着它的决定（类型 decision）进待决账本，种类同按前提判的「依据已变」（premise-changed），
 * 条目带 via: 'related' 和按前提判的那一半分开。只提醒复查，不改决定。
 */

/** 沿关联发的条目在账本里的来源标记（premise-changed 条目的 via）。按前提判的条目没有这个字段。 */
export const RELATED_RECHECK_VIA = 'related'

/** 条目说明里状态页这次改动的说法，按改动性质。 */
export const RELATED_RECHECK_CHANGE_TEXT = {
  'state-change': '状态变了',
  correct: '纠正过',
} as const

/** 钩子依赖：账本由调用方共享，开关在每次内容写入后现读。 */
export interface RelatedRecheckDeps {
  decisions: PendingDecisionsStore
  /** 实验开关，每次调用现读。 */
  isEnabled: () => boolean
  /** 查不全、写账本失败时各记一条 warn；缺省用 console。 */
  log?: MemoryLogger
}

/**
 * 给落盘原语用的钩子：一条记忆的内容改动写成之后（写入段内、提交后步骤做完）调一次。
 * 写下的这一版最近一次内容改动是状态变化或纠错、开关开着时，沿关联给挂在它上面的决定挂账；查不全、写账本失败只记 warn，不抛。
 */
export function relatedRecheckHook(deps: RelatedRecheckDeps): RelatedRecheckHook {
  const log = deps.log ?? console
  return async (page, store) => {
    const kind = readChangeKind(page.lastChange?.kind)
    if (kind !== 'state-change' && kind !== 'correct') return
    if (!deps.isEnabled()) return
    try {
      // 写成的记录有确定的作用域；项目页只找本项目，全局页逐个作用域核对副本。
      const pageScope = scopeOfMemory(page)!
      const links = await store.indexedLinksTo(page.id, pageScope)
      if (!links.isComplete) {
        log.warn('[plastic-memory] 关联链接未查全，本次复查信号未发出')
        return
      }
      const ids = new Set(links.refs.filter(ref => ref.kind === 'related').map(ref => ref.sourceId))
      for (const id of ids) {
        const scopes = pageScope.kind === 'global' ? await store.copiesOf(id) : [pageScope]
        for (const scope of scopes) {
          const decision = await locateCopy(store, id, scope)
          if (decision === undefined || decision.status !== 'active' || decision.type !== 'decision'
            || !decision.related?.includes(page.id) || decision.premises?.some(premise => premise.id === page.id)) continue
          const decisionName = injectionText(maskSecretSurface(decision, { severity: 'suspected' }).name)
          const pageName = injectionText(maskSecretSurface(page, { severity: 'suspected' }).name)
          // 资格已按作用域核对；upsert 的 read 只按 id 读，会漏掉项目里的决定。
          await deps.decisions.upsert({
            kind: 'premise-changed', via: RELATED_RECHECK_VIA,
            memoryIds: [decision.id, page.id], workspaces: [ledgerLabel(scope), ledgerLabel(pageScope)],
            summary: `「${decisionName}」关联的「${pageName}」${RELATED_RECHECK_CHANGE_TEXT[kind]}，请复查决定是否还成立`,
            fingerprint: sha1([RELATED_RECHECK_VIA, decision.id, page.id, page.lastChange!.op]),
          }, page.lastChange!.at)
          break
        }
      }
    } catch (err) {
      log.warn('[plastic-memory] 沿关联发复查信号失败，记忆已保存', err)
    }
  }
}

/**
 * 实验开关关着时体检调它：删掉账本里沿关联发的、还没结清的条目（种类 premise-changed、via 为 related）。
 * 逐条认领、重读，仍是未结清的这种条目才删；正被认领的这次不动。已结清的、按前提判的、via 是别的取值的都不碰。
 */
export async function dropRelatedRechecks(decisions: PendingDecisionsStore): Promise<void> {
  for (const entry of await decisions.list()) {
    if (entry.kind !== 'premise-changed' || entry.via !== RELATED_RECHECK_VIA) continue
    await decisions.withClaim(entry.id, async () => {
      const current = await decisions.get(entry.id)
      if (current?.kind === 'premise-changed' && current.via === RELATED_RECHECK_VIA) await decisions.remove(entry.id)
    })
  }
}

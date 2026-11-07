/**
 * 「让模型改」的快捷意图：点了把模板填进要求框，用户把「___」换成自己的话。只是提示怎么把要求写具体，不校验填没填完；
 * 留着没填的「___」由提示词约定怎么处理。名字和模板都是文案键，中英各一份在 locales/library.ts。
 */
import type { LocaleKey } from '../locales.ts'

export interface Intent { id: string; label: LocaleKey; template: LocaleKey }

/** 模板里等用户填的空。 */
export const INTENT_BLANK = '___'

/** 单条修改的四个快捷意图，按显示顺序。 */
export const SINGLE_INTENTS = [
  { id: 'compress', label: 'library.intent.compress', template: 'library.intent.compress.template' },
  { id: 'clarify', label: 'library.intent.clarify', template: 'library.intent.clarify.template' },
  { id: 'correct', label: 'library.intent.correct', template: 'library.intent.correct.template' },
  { id: 'supplement', label: 'library.intent.supplement', template: 'library.intent.supplement.template' },
] as const satisfies readonly Intent[]

/** 「整理所选」的四个快捷意图（多条），按显示顺序。 */
export const BATCH_INTENTS = [
  { id: 'resolve', label: 'library.intent.resolve', template: 'library.intent.resolve.template' },
  { id: 'dedupe', label: 'library.intent.dedupe', template: 'library.intent.dedupe.template' },
  { id: 'prune', label: 'library.intent.prune', template: 'library.intent.prune.template' },
  { id: 'unify', label: 'library.intent.unify', template: 'library.intent.unify.template' },
] as const satisfies readonly Intent[]

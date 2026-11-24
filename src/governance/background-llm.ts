import type { KvTable } from '../kv-table.ts'
import type { ModelSelectionRow } from '../storage/schema.ts'
import type { ModelChoices, ModelSelection, ModelSelectionKey } from '../gui/contract.ts'
import type { SemanticLlm } from './semantic-scan.ts'

/**
 * 后台调模型时用哪个模型：选择的存取、「还在不在」的校验、按选择链解析。
 * 存取和校验不绑具体的选择键，解析的退回目标由调用方给：自动体检、梦境退到宿主默认模型（createBackgroundLlmResolver），
 * 别的功能可以用自己的键和退回目标（resolveSelection）。
 */

/** 宿主 llm 服务里列提供方、列模型、读模型详情的部分（ctx.get('llm') 的结构子集，下界 0.2.2-rc.1 起都有）。 */
export interface HostModelCatalog {
  listProviders(): ReadonlyArray<{ id: string; name: string }>
  listModels(provider: string): Promise<ReadonlyArray<{ id: string; name: string }>>
  resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts: ReadonlyArray<{ id: string; name: string }>; defaultEffort?: string } }>
}

/**
 * 模型选择表的读写：一个选择键一条，几个宿主进程共用（表由接线层注入，storage/sidecar.ts 的 modelSelections）。
 * 每次现读，不缓存：别的进程改了，下次开跑就读到。
 */
export class ModelSelectionStore {
  private readonly table: KvTable<ModelSelectionRow>

  constructor(table: KvTable<ModelSelectionRow>) {
    this.table = table
  }

  /** 这个键存的选择；没存（跟随）为 undefined。 */
  async get(key: string): Promise<ModelSelection | undefined> {
    const row = await this.table.get(key)
    if (row === undefined) return undefined
    const { id: _id, ...selection } = row
    return selection
  }

  /** 存一份选择；null 删掉这个键、改回跟随（本来就没有也算成功）。 */
  async set(key: string, selection: ModelSelection | null): Promise<void> {
    if (selection === null) await this.table.delete(key)
    else await this.table.put(key, { id: key, ...selection })
  }
}

/** 选择失效的原因：提供方已从宿主里删掉、模型已不在提供方的列表里、模型已不支持选的推理强度。 */
export type SelectionProblem = 'provider-gone' | 'model-gone' | 'effort-gone'

/**
 * 选的提供方、模型、推理强度现在还在不在：都在为 undefined，不在给原因。
 * 提供方看宿主的提供方列表；模型看这个提供方列出来的模型（没登录、没配 key 时提供方列不出模型，按不在算）；
 * 选了推理强度时再看模型详情里有没有它。列模型、读详情出错时确认不了，不算不在（调用时出错照常按体检失败处理）；
 * 只有宿主报提供方没有适配器（NO_ADAPTER）时算提供方不在。
 */
export async function checkSelection(catalog: HostModelCatalog | undefined, selection: ModelSelection): Promise<SelectionProblem | undefined> {
  if (catalog === undefined) return 'provider-gone'
  if (!catalog.listProviders().some(p => p.id === selection.provider)) return 'provider-gone'
  try {
    const models = await catalog.listModels(selection.provider)
    if (!models.some(m => m.id === selection.model)) return 'model-gone'
    if (selection.reasoningEffort === undefined) return undefined
    const info = await catalog.resolveModelInfo(selection.provider, selection.model)
    return info.reasoning?.efforts.some(e => e.id === selection.reasoningEffort) === true ? undefined : 'effort-gone'
  } catch (err) {
    return isNoAdapter(err) ? 'provider-gone' : undefined
  }
}

/**
 * 解析结果：用的模型（拿不到为 null）；isSelected = 用的是链上某个键选的模型（不是退回目标）；
 * fellBack = 链上有选了却失效的一步，reason 是第一处失效的原因。
 */
export interface ResolvedLlm {
  llm: SemanticLlm | null
  isSelected: boolean
  fellBack: boolean
  reason?: SelectionProblem
}

export interface SelectionDeps {
  selections: Pick<ModelSelectionStore, 'get'>
  /** 宿主 llm 服务的列模型部分，每次现取；宿主没有时为 undefined。 */
  catalog: () => HostModelCatalog | undefined
  /** 按一份选择建模型调用（无会话：宿主会话适配器的 llmForRoute）；拿不到为 null。 */
  llmFor: (selection: ModelSelection) => SemanticLlm | null
}

/**
 * 按选择链解析：依次看 chain 里每个键存的选择，没选的跳过，选了且还在就用它，失效就往下一个键退；
 * 都没有可用的就用 fallback()。fellBack 只在有选了却失效的一步时为 true（全都没选不算退回）。
 */
export async function resolveSelection(chain: readonly string[], deps: SelectionDeps, fallback: () => SemanticLlm | null): Promise<ResolvedLlm> {
  let reason: SelectionProblem | undefined
  for (const key of chain) {
    const selection = await deps.selections.get(key)
    if (selection === undefined) continue
    const problem = await checkSelection(deps.catalog(), selection)
    const llm = problem === undefined ? deps.llmFor(selection) : null
    if (llm !== null) return { llm, isSelected: true, fellBack: reason !== undefined, ...(reason === undefined ? {} : { reason }) }
    reason ??= problem ?? 'provider-gone'
  }
  return { llm: fallback(), isSelected: false, fellBack: reason !== undefined, ...(reason === undefined ? {} : { reason }) }
}

/** 后台功能的选择链：自动体检只看自己的键；梦境先看自己的，没选或失效就跟随自动体检。链尽头都是宿主默认模型。 */
const BACKGROUND_CHAINS: Record<ModelSelectionKey, readonly ModelSelectionKey[]> = {
  checkup: ['checkup'],
  dreams: ['dreams', 'checkup'],
}

/** 不经会话的后台功能（自动体检、梦境）用哪个模型：开跑前现读选择、现查还在不在，失效一路退到宿主默认模型。 */
export function createBackgroundLlmResolver(deps: SelectionDeps & { defaultLlm: () => SemanticLlm | null }): (selection: ModelSelectionKey) => Promise<ResolvedLlm> {
  return selection => resolveSelection(BACKGROUND_CHAINS[selection], deps, deps.defaultLlm)
}

/**
 * 能选的模型，给选择器用：按宿主的提供方顺序分组，每个模型带推理强度（读模型详情）。
 * 列出来是空的（没登录、没配 key）、宿主报提供方已删（NO_ADAPTER）的提供方不列。
 * 列模型或读详情出错的提供方标 listFailed、不带模型：界面据此说「没读到」，不把这个提供方下选过的模型当成失效。
 * 读详情出错也算没读到：推理强度确认不了，硬列出来会把存的推理强度错标成失效。
 */
export async function listModelChoices(catalog: HostModelCatalog | undefined): Promise<ModelChoices> {
  if (catalog === undefined) return []
  const groups = await Promise.all(catalog.listProviders().map(async (provider): Promise<ModelChoices[number] | undefined> => {
    try {
      const models = await catalog.listModels(provider.id)
      return {
        id: provider.id,
        name: provider.name,
        models: await Promise.all(models.map(async (model) => {
          const { reasoning } = await catalog.resolveModelInfo(provider.id, model.id)
          return {
            id: model.id,
            name: model.name,
            efforts: reasoning?.efforts.map(e => ({ id: e.id, name: e.name })) ?? [],
            ...(reasoning?.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort }),
          }
        })),
      }
    } catch (err) {
      return isNoAdapter(err) ? undefined : { id: provider.id, name: provider.name, models: [], listFailed: true }
    }
  }))
  return groups.filter((g): g is ModelChoices[number] => g !== undefined && (g.models.length > 0 || g.listFailed === true))
}

/** 宿主报这个提供方没有适配器：提供方已从宿主里删掉。 */
function isNoAdapter(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'NO_ADAPTER'
}

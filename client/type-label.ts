/** 类型在界面上的显示名：右侧栏、记忆查看、最近删除、处理视图、对话卡、设置页都从这里取，同一类型各处同名。 */
import type { Translate } from './i18n.tsx'
import type { LocaleKey } from './locales.ts'
import { BUILTIN_TYPE_NAMES, PRESET_TYPE_NAMES, RETIRED_TYPE_NAMES } from './settings/config.ts'

const KNOWN_TYPES: ReadonlySet<string> = new Set([...BUILTIN_TYPE_NAMES, ...PRESET_TYPE_NAMES, ...RETIRED_TYPE_NAMES])

/**
 * 取名顺序：配置 customTypes 里有这一项（我加的、改过的预设）用它的名字；内置、预设、退役类型按界面语言取 locale；
 * 其余（切模板前的旧类型）用视图里的 typeLabels，再没有就显示 id。
 */
export function typeLabel(t: Translate, type: string, sources: {
  viewLabels?: Readonly<Record<string, string>> | undefined
  customTypes?: Readonly<Record<string, { label: string }>> | undefined
}): string {
  const custom = sources.customTypes
  if (custom !== undefined && Object.hasOwn(custom, type)) return custom[type]!.label
  if (KNOWN_TYPES.has(type)) return t(`type.${type}` as LocaleKey)
  const view = sources.viewLabels
  return view !== undefined && Object.hasOwn(view, type) ? view[type]! : type
}

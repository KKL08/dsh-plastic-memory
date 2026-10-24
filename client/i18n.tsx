/**
 * 文案与格式化：组件经 useT() 取翻译函数，不直接碰宿主 locale 服务。宿主侧由面板壳把
 * `ctx.locale.bind(NS)` 包成 Translate 放进上下文；测试用 createTranslator(zh) 直接给。
 */
import { createContext, useContext } from 'react'
import { zh, type LocaleKey } from './locales.ts'

export type Translate = (key: LocaleKey, params?: Record<string, string | number>) => string

/** 按一份字典翻译，`{name}` 占位与宿主 locale 服务同法替换。 */
export function createTranslator(dict: Record<LocaleKey, string>): Translate {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}

const TranslateContext = createContext<Translate>(createTranslator(zh))

export const TranslateProvider = TranslateContext.Provider

export function useT(): Translate {
  return useContext(TranslateContext)
}

/** 数字写全数、千分位逗号（3,120），中英一致。 */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

const MONTH_NAME = new Intl.DateTimeFormat('en-US', { month: 'short' })

/** 「刚刚」「10 月 17 日」，跨年带年份。按本机时区。 */
export function formatDay(ms: number, now: number, t: Translate): string {
  if (Math.abs(now - ms) < 60_000) return t('time.justNow')
  const d = new Date(ms)
  const params = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), monthName: MONTH_NAME.format(d) }
  return d.getFullYear() === new Date(now).getFullYear() ? t('time.monthDay', params) : t('time.yearMonthDay', params)
}

/** 路径最后一段（项目名）。 */
export { baseName } from './path.ts'

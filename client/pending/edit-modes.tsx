/**
 * 修改面板的外壳：顶部两段切换「让模型改 | 手动改」（合并时「让模型合并 | 手动合并」），下面两侧插槽。待处理卡和记忆查看共用，
 * 外壳只管切换、偏好和关闭，不管改的是哪条、怎么发命令：两侧编辑器由调用方传入，经 report 报告各自的状态。
 * - 两侧都保持挂载，切换不丢各自已写的内容；没选中的一侧 hidden，不进焦点顺序。
 * - 选中一侧在生成、对照、保存或等确认时切换控件置灰，先放弃、应用或取消再切。
 * - 关闭整个面板是另一个动作：各侧的「取消」或 Esc（保存中、等确认时 Esc 不关，同「取消」置灰）。
 * - 方式偏好存在浏览器本地，面板打开时读一次；读写失败按默认（让模型改）。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useT } from '../i18n.tsx'
import { SegmentedControl } from '../ui/Segmented.tsx'

export type EditMode = 'model' | 'manual'

/** 编辑器的阶段：idle 以外切换控件都置灰。 */
export type EditPhase = 'idle' | 'busy' | 'result' | 'saving'

/** 编辑器对外报告的状态。isDirty：有没发出的输入或没应用的稿（换别的面板前要不要先问）。 */
export interface EditState { phase: EditPhase; isDirty: boolean }

export const EDIT_MODE_STORAGE_KEY = 'dsh-plastic-memory.gui.editMode'

const DEFAULT_MODE: EditMode = 'model'
const IDLE: EditState = { phase: 'idle', isDirty: false }

/** 上次选的方式；没存过、存的不认得、存储不可用都按默认。 */
export function readEditMode(): EditMode {
  try {
    const raw = localStorage.getItem(EDIT_MODE_STORAGE_KEY)
    return raw === 'model' || raw === 'manual' ? raw : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

function writeEditMode(mode: EditMode): void {
  try { localStorage.setItem(EDIT_MODE_STORAGE_KEY, mode) } catch { /* 记不下：下次打开按默认 */ }
}

/** 编辑器用：阶段或 isDirty 变了才报。 */
export function useReportEditState(onStateChange: ((state: EditState) => void) | undefined, phase: EditPhase, isDirty: boolean): void {
  const report = useRef(onStateChange)
  report.current = onStateChange
  useEffect(() => { report.current?.({ phase, isDirty }) }, [phase, isDirty])
}

export function EditModes({ isMerge = false, model, manual, onClose, onStateChange }: {
  /** 两条合并：段名写「让模型合并 | 手动合并」。 */
  isMerge?: boolean
  /** 让模型改那一侧；report 交给编辑器报告状态。 */
  model: (report: (state: EditState) => void) => ReactNode
  /** 手动改那一侧。 */
  manual: (report: (state: EditState) => void) => ReactNode
  /** 关闭整个面板（Esc）。各侧的「取消」由调用方接到同一个回调。 */
  onClose: () => void
  /** 整个面板的状态：选中一侧的阶段，两侧合起来有没有未保存的输入。 */
  onStateChange?: (state: EditState) => void
}) {
  const t = useT()
  const id = useId()
  const [mode, setMode] = useState(readEditMode)
  const [states, setStates] = useState<Record<EditMode, EditState>>({ model: IDLE, manual: IDLE })
  const reportModel = useCallback((state: EditState) => { setStates(prev => ({ ...prev, model: state })) }, [])
  const reportManual = useCallback((state: EditState) => { setStates(prev => ({ ...prev, manual: state })) }, [])
  const { phase } = states[mode]
  useReportEditState(onStateChange, phase, states.model.isDirty || states.manual.isDirty)

  // 两侧同时挂载，各自的 autoFocus 后挂的那个得焦点：打开时焦点若落在没选中的一侧，挪回选中一侧的输入框
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const panels = root.current?.querySelectorAll<HTMLElement>(':scope > [role="tabpanel"]') ?? []
    const shown = [...panels].find(panel => !panel.hidden)
    const hidden = [...panels].find(panel => panel.hidden)
    if (hidden?.contains(document.activeElement) === true) shown?.querySelector<HTMLElement>('textarea, input')?.focus()
  }, [])

  const change = (next: EditMode) => { setMode(next); writeEditMode(next) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 输入法选词时的 Esc 只取消选词
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    if (phase === 'saving') return
    event.preventDefault()
    onClose()
  }
  const options = [
    { value: 'model', label: t(isMerge ? 'pending.model.merge' : 'pending.model.edit') },
    { value: 'manual', label: t(isMerge ? 'pending.edit.merge' : 'pending.edit.edit') },
  ] as const
  return (
    // Esc 从面板里任一控件冒上来都关
    <div ref={root} className="pm-edit-modes" onKeyDown={onKeyDown}>
      <SegmentedControl id={id} value={mode} options={options} onChange={change} label={t('pending.modes')} disabled={phase !== 'idle'} />
      {options.map(({ value }) => (
        <div key={value} id={`${id}-${value}-panel`} role="tabpanel" aria-labelledby={`${id}-${value}`} hidden={value !== mode}>
          {value === 'model' ? model(reportModel) : manual(reportManual)}
        </div>
      ))}
    </div>
  )
}

/** 小号分段控件：平台底色，选中段白底加粗；不用主题色（The Four Places Rule）。 */
export const editModesCss = `
.pm-edit-modes { display: flex; flex-direction: column; gap: 8px; }
.pm-edit-modes > .pm-segmented { align-self: flex-start; padding: 3px; background: var(--pm-bg-block); }
.pm-edit-modes .pm-segmented-indicator { top: 3px; left: 3px; width: calc((100% - 6px - 2px * (var(--pm-segment-count) - 1)) / var(--pm-segment-count)); height: calc(100% - 6px); }
.pm-edit-modes .pm-segment { height: 24px; padding: 0 12px; font-size: 12px; }
.pm-edit-modes .pm-segment[aria-selected='true'] { font-weight: 600; }
`

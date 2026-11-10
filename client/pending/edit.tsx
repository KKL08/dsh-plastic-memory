/**
 * 建议整理卡里就地改一条记忆（手动改）或把两条合成一条（手动合并）：正文是编辑框，「更多」里是名称、摘要、标签，类型改不了。
 * 这里只管草稿；命令由卡片经 useCardAction 发出，保存中、等确认时按钮跟着卡片的忙状态置灰，失败原因写在卡片底下。
 * 挂在两段切换的外壳（edit-modes.tsx）里，经 onStateChange 报告是否在保存、有没有改过。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { formatNumber, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { CrossIcon } from '../ui/CrossIcon.tsx'
import { Icon } from '../ui/Icon.tsx'
import { useReturnFocus } from '../ui/focus-return.ts'
import { useReportEditState, type EditState } from './edit-modes.tsx'

export interface EditDraft { content: string; name: string; summary: string; tags: string[] }

export function EditPanel({ initial, original, isMerge, unavailable, onCancel, onSave, onStateChange }: {
  /** 编辑框和「更多」的预填值。 */
  initial: EditDraft
  /** 改前的正文、摘要（判断「正文改了、摘要没动」）和字数（合并时两条相加）。 */
  original: { content: string; summary: string; chars: number }
  isMerge: boolean
  /** 卡片的忙状态（保存中、等确认）：保存和取消都不可用。 */
  unavailable: string | undefined
  onCancel: () => void
  onSave: (draft: EditDraft) => void
  onStateChange?: (state: EditState) => void
}) {
  const t = useT()
  const id = useId()
  const [draft, setDraft] = useState(initial)
  const [isMoreOpen, setMoreOpen] = useState(false)
  const [tagText, setTagText] = useState('')
  /** 点过「保存」：之后卡片忙着（保存中、等确认）就报 saving。 */
  const [hasSaved, setSaved] = useState(false)
  // 卡片不忙了（命令回来了：失败、确认被取消，或发送前就拦下）就复位，之后卡片因别的原因不可用不算保存中
  useEffect(() => { if (hasSaved && unavailable === undefined) setSaved(false) }, [hasSaved, unavailable])
  /** 点了「去改摘要」：「更多」展开后把焦点放进摘要。 */
  const [isSummaryWanted, setSummaryWanted] = useState(false)
  const summaryRef = useRef<HTMLInputElement>(null)
  // 取消时焦点回到「修改」，保存后卡片换成结果行就落在结果行上
  const root = useRef<HTMLDivElement>(null)
  useReturnFocus(root)
  useEffect(() => {
    if (!isSummaryWanted || !isMoreOpen) return
    summaryRef.current?.focus()
    setSummaryWanted(false)
  }, [isSummaryWanted, isMoreOpen])

  const set = (patch: Partial<EditDraft>) => { setDraft(prev => ({ ...prev, ...patch })) }
  const content = draft.content.trim()
  // 只提示不拦：摘要进注入索引，正文改了它却还是旧的，agent 会按旧摘要找
  const isSummaryStale = content !== original.content.trim() && draft.summary === original.summary
  const isEmpty = content === '' || draft.name.trim() === ''
  const isDirty = tagText.trim() !== '' || draft.content !== initial.content || draft.name !== initial.name || draft.summary !== initial.summary
    || draft.tags.join('\n') !== initial.tags.join('\n')
  useReportEditState(onStateChange, hasSaved && unavailable !== undefined ? 'saving' : 'idle', isDirty)
  const addTag = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法选词的回车不算
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    const tag = tagText.trim()
    if (tag !== '' && !draft.tags.includes(tag)) set({ tags: [...draft.tags, tag] })
    setTagText('')
  }

  return (
    <div ref={root} className="pm-edit">
      <label className="pm-edit-label" htmlFor={`${id}-content`}>{t('pending.edit.content')}</label>
      <textarea
        id={`${id}-content`}
        className="pm-edit-input pm-edit-content"
        value={draft.content}
        autoFocus
        onChange={(event) => { set({ content: event.target.value }) }}
      />
      <button
        type="button"
        className="pm-edit-more"
        aria-expanded={isMoreOpen}
        aria-controls={`${id}-more`}
        onClick={() => { setMoreOpen(open => !open) }}
      >
        {t(isMoreOpen ? 'pending.edit.less' : 'pending.edit.more')}
        <Icon name="chevronDownMedium" size={12} />
      </button>
      {isMoreOpen
        ? (
          <div id={`${id}-more`} className="pm-edit-fields">
            <label className="pm-edit-label" htmlFor={`${id}-name`}>{t('pending.edit.name')}</label>
            <input id={`${id}-name`} className="pm-edit-input" value={draft.name} onChange={(event) => { set({ name: event.target.value }) }} />
            <label className="pm-edit-label" htmlFor={`${id}-summary`}>{t('pending.edit.summary')}</label>
            <input id={`${id}-summary`} ref={summaryRef} className="pm-edit-input" value={draft.summary} onChange={(event) => { set({ summary: event.target.value }) }} />
            <label className="pm-edit-label" htmlFor={`${id}-tag`}>{t('pending.edit.tags')}</label>
            <div className="pm-edit-tags">
              {draft.tags.map(tag => (
                <span key={tag} className="pm-edit-tag">
                  {tag}
                  <button type="button" aria-label={t('pending.edit.removeTag', { tag })} onClick={() => { set({ tags: draft.tags.filter(x => x !== tag) }) }}>
                    <CrossIcon size={8} />
                  </button>
                </span>
              ))}
              <input
                id={`${id}-tag`}
                className="pm-edit-tag-input"
                placeholder={t('pending.edit.tagPlaceholder')}
                value={tagText}
                onChange={(event) => { setTagText(event.target.value) }}
                onKeyDown={addTag}
              />
            </div>
          </div>
        )
        : null}
      {isSummaryStale
        ? (
          <p className="pm-pending-hint">
            <span>{t('pending.edit.summaryStale')}</span>
            <button type="button" className="pm-link" onClick={() => { setMoreOpen(true); setSummaryWanted(true) }}>{t('pending.edit.summaryFix')}</button>
          </p>
        )
        : null}
      <div className="pm-edit-foot">
        <span className="pm-edit-hint">
          {isMerge
            ? <><span>{t('pending.edit.mergeNote')}</span>{isMoreOpen ? <span>{t('pending.edit.typeFixed')}</span> : null}</>
            : <span>{t('pending.edit.note')}</span>}
        </span>
        <span className="pm-edit-count">{t('pending.edit.count', { from: formatNumber(original.chars), to: formatNumber(content.length) })}</span>
        <Button variant="ghost" unavailable={unavailable} onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button
          variant="primary"
          unavailable={unavailable ?? (isEmpty ? t('pending.edit.empty') : undefined)}
          onClick={() => { setSaved(true); onSave({ content, name: draft.name.trim(), summary: draft.summary.trim(), tags: draft.tags }) }}
        >
          {t('pending.edit.save')}
        </Button>
      </div>
    </div>
  )
}

export const editCss = `
.pm-edit { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: var(--dsw-radius-md, 12px); background: var(--pm-bg-block); }
.pm-edit-label { font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-edit-input {
  width: 100%; padding: 6px 10px; font: inherit; font-size: 13px; line-height: 1.6; color: var(--pm-text); background: var(--pm-bg);
  border: .5px solid var(--pm-line-input); border-radius: var(--dsw-radius-sm, 8px);
}
.pm-edit-input::placeholder { color: var(--pm-text-2); }
.pm-edit-input:focus-visible, .pm-edit-tags:focus-within { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 0; }
.pm-edit-content { min-height: 120px; resize: vertical; }
.pm-edit-more {
  display: inline-flex; align-items: center; gap: 2px; align-self: flex-start; padding: 2px 0; border: 0; background: none;
  font: inherit; font-size: 12px; color: var(--pm-text-2); cursor: pointer;
}
.pm-edit-more[aria-expanded='true'] svg { transform: rotate(180deg); }
.pm-edit-more:hover { color: var(--pm-text); }
.pm-edit-fields { display: flex; flex-direction: column; gap: 6px; }
.pm-edit-fields .pm-edit-label { margin-top: 4px; }
.pm-edit-tags {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 6px; background: var(--pm-bg);
  border: .5px solid var(--pm-line-input); border-radius: var(--dsw-radius-sm, 8px);
}
.pm-edit-tag { display: inline-flex; align-items: center; height: 22px; padding-left: 8px; border-radius: 6px; background: var(--pm-hover); font-size: 12px; color: var(--pm-text); }
.pm-edit-tag button { display: inline-flex; align-items: center; align-self: stretch; padding: 0 6px; border: 0; background: none; font: inherit; color: var(--pm-text-2); cursor: pointer; }
.pm-edit-tag button:hover { color: var(--pm-text); }
.pm-edit-tag-input { flex: 1; min-width: 120px; height: 22px; border: 0; outline: 0; background: none; font: inherit; font-size: 12px; color: var(--pm-text); }
.pm-edit-tag-input::placeholder { color: var(--pm-text-2); }
.pm-edit-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; }
.pm-edit-hint { display: flex; flex-wrap: wrap; gap: 0 12px; margin-right: auto; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-edit-count { font-size: 12px; line-height: 1.5; color: var(--pm-text-2); font-variant-numeric: tabular-nums; }
.pm-pending-done { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pm-pending-done-text { flex: 1; min-width: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); overflow-wrap: anywhere; }
`

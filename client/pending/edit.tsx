/**
 * 建议整理卡里就地改一条记忆（直接改）或把两条合成一条（直接合并）：正文是编辑框，「更多」里是名称、摘要、标签，类型改不了。
 * 这里只管草稿；命令由卡片经 useItemAction 发出，保存中、等确认时按钮跟着卡片的忙状态置灰，失败原因写在卡片底下。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { formatNumber, useT } from '../i18n.tsx'
import { Button } from '../ui/Button.tsx'
import { useReturnFocus } from '../ui/focus-return.ts'

export interface EditDraft { content: string; name: string; summary: string; tags: string[] }

export function EditPanel({ initial, original, isMerge, unavailable, onCancel, onSave }: {
  /** 编辑框和「更多」的预填值。 */
  initial: EditDraft
  /** 改前的正文、摘要（判断「正文改了、摘要没动」）和字数（合并时两条相加）。 */
  original: { content: string; summary: string; chars: number }
  isMerge: boolean
  /** 卡片的忙状态（保存中、等确认）：保存和取消都不可用。 */
  unavailable: string | undefined
  onCancel: () => void
  onSave: (draft: EditDraft) => void
}) {
  const t = useT()
  const id = useId()
  const [draft, setDraft] = useState(initial)
  const [isMoreOpen, setMoreOpen] = useState(false)
  const [tagText, setTagText] = useState('')
  /** 点了「去改摘要」：「更多」展开后把焦点放进摘要。 */
  const [isSummaryWanted, setSummaryWanted] = useState(false)
  const summaryRef = useRef<HTMLInputElement>(null)
  // 取消时焦点回到「直接改」，保存后卡片换成结果行就落在结果行上
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
        <span aria-hidden="true">{isMoreOpen ? ' ▴' : ' ▾'}</span>
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
                  <button type="button" aria-label={t('pending.edit.removeTag', { tag })} onClick={() => { set({ tags: draft.tags.filter(x => x !== tag) }) }}>×</button>
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
          {isMerge ? <span>{t('pending.edit.mergeNote')}</span> : null}
          {isMoreOpen ? <span>{t('pending.edit.typeFixed')}</span> : null}
        </span>
        <span className="pm-edit-count">{t('pending.edit.count', { from: formatNumber(original.chars), to: formatNumber(content.length) })}</span>
        <Button variant="ghost" unavailable={unavailable} onClick={onCancel}>{t('pending.cancel')}</Button>
        <Button
          variant="primary"
          unavailable={unavailable ?? (isEmpty ? t('pending.edit.empty') : undefined)}
          onClick={() => { onSave({ content, name: draft.name.trim(), summary: draft.summary.trim(), tags: draft.tags }) }}
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
.pm-edit-input:focus-visible, .pm-edit-tags:focus-within { outline: var(--dsw-focus-ring-width, 2px) solid var(--pm-focus); outline-offset: 0; }
.pm-edit-content { min-height: 120px; resize: vertical; }
.pm-edit-more { align-self: flex-start; padding: 2px 0; border: 0; background: none; font: inherit; font-size: 12px; color: var(--pm-text-2); cursor: pointer; }
.pm-edit-more:hover { color: var(--pm-text); }
.pm-edit-fields { display: flex; flex-direction: column; gap: 6px; }
.pm-edit-fields .pm-edit-label { margin-top: 4px; }
.pm-edit-tags {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 6px; background: var(--pm-bg);
  border: .5px solid var(--pm-line-input); border-radius: var(--dsw-radius-sm, 8px);
}
.pm-edit-tag { display: inline-flex; align-items: center; height: 22px; padding-left: 8px; border-radius: 6px; background: var(--pm-hover); font-size: 12px; color: var(--pm-text); }
.pm-edit-tag button { padding: 0 6px; border: 0; background: none; font: inherit; color: var(--pm-text-3); cursor: pointer; }
.pm-edit-tag button:hover { color: var(--pm-text); }
.pm-edit-tag-input { flex: 1; min-width: 120px; height: 22px; border: 0; outline: 0; background: none; font: inherit; font-size: 12px; color: var(--pm-text); }
.pm-edit-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; }
.pm-edit-hint { display: flex; flex-wrap: wrap; gap: 0 12px; margin-right: auto; font-size: 12px; line-height: 1.5; color: var(--pm-text-3); }
.pm-edit-count { font-size: 12px; line-height: 1.5; color: var(--pm-text-3); font-variant-numeric: tabular-nums; }
.pm-pending-done { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.pm-pending-done-text { flex: 1; min-width: 0; font-size: 13px; line-height: 1.5; color: var(--pm-text); overflow-wrap: anywhere; }
`

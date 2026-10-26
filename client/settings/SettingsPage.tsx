/**
 * 插件设置页（plugins.bundle.config）：状态卡 + 三组设置「记什么 · 怎么用 · 怎么管」+ 保存行。
 * 插件名、简介、版本由宿主插件页的页头画（locale/*.json 的 meta 与 package.json 的 version），这里不重复。
 * 改动先暂存，点保存先弹窗列出改了哪几项，确认后一次提交（useSettingsDraft）；体检关闭时依赖它的三项置灰保留，不隐藏。
 */
import { useId, useState } from 'react'
import { useGateway } from '../gateway.ts'
import { useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import type { NavTarget } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { SegmentedControl } from '../ui/Segmented.tsx'
import { SettingsForm, SettingsGroupCard, SettingsItem } from '../ui/Settings.tsx'
import {
  EVIDENCE_LEVELS, OVERFLOW_MODES, PROMOTE_TARGETS, SENSITIVITIES, SENSITIVITY_NUMBERS, TEMPLATES, configuredRoot, customTypeChanges,
  droppedTypes, parsePositiveInt, type ConfigForm, type SettingsFields,
} from './config.ts'
import { Dialog, Switch, TextField } from './controls.tsx'
import { CustomTypeList } from './CustomTypes.tsx'
import { StatusCard } from './StatusCard.tsx'
import { useSettingsDraft } from './useSettingsDraft.ts'

const AUTO_CHECKUP = ['off', 'daily', 'weekly'] as const

const USAGE_FIELDS: ReadonlyArray<keyof SettingsFields> = ['budget', 'overflow', 'evidence']

export function SettingsPage({ form, onOpenMemoryPage, now }: {
  form: ConfigForm
  /** 经导航 store 直达记忆页的某个 tab（待处理可带要定位的组）。 */
  onOpenMemoryPage: (target: Pick<NavTarget, 'tab' | 'level'>) => void
  now?: number
}) {
  const t = useT()
  const id = useId()
  const draft = useSettingsDraft(form)
  const { snapshot, fields: f, saved, edit } = draft
  const [isConfirming, setConfirming] = useState(false)
  if (snapshot.status === 'loading') return <p className="pm-form-note" role="status">{t('settings.loading')}</p>

  const locked = !snapshot.writable || draft.saving
  const governanceOff = !f.governance
  const budgetInvalid = f.budget !== saved.budget && parsePositiveInt(f.budget) === undefined
  const sensitivity = SENSITIVITY_NUMBERS[f.sensitivity]
  const templateHint = t(`settings.template.hint.${f.template}`)
  const dropped = droppedTypes(saved.template, f.template)

  return (
    <div className="pm-settings">
      <StatusCard governanceEnabled={saved.governance} onOpen={onOpenMemoryPage} {...(now !== undefined ? { now } : {})} />
      <SettingsForm
        state={{
          available: snapshot.status === 'ready', writable: snapshot.writable, dirty: draft.dirty,
          invalid: draft.invalid, saving: draft.saving, failed: draft.outcome === 'failed',
        }}
        onSave={() => { setConfirming(true) }}
        onDiscard={draft.discard}
      >
        <SettingsGroupCard title={t('settings.group.what')}>
          <SettingsItem
            label={t('settings.template.label')}
            hint={dropped.length > 0
              ? t('settings.template.hintSwitched', { hint: templateHint, switch: t('settings.template.dropHint', { types: typeNames(t, dropped.map(n => t(`sidebar.type.${n}` as LocaleKey))) }) })
              : templateHint}
          >
            <SegmentedControl
              id={`${id}-template`}
              label={t('settings.template.label')}
              value={f.template}
              options={TEMPLATES.map(v => ({ value: v, label: t(`settings.template.${v}`) }))}
              disabled={locked}
              onChange={(template) => { edit({ template }) }}
            />
          </SettingsItem>
          <SettingsItem label={t('settings.types.label')} hint={t('settings.types.hint')}>
            <CustomTypeList types={f.customTypes} disabled={locked} onChange={(customTypes) => { edit({ customTypes }) }} />
          </SettingsItem>
        </SettingsGroupCard>

        <SettingsGroupCard title={t('settings.group.how')}>
          <SettingsItem label={t('settings.budget.label')} htmlFor={`${id}-budget`}>
            <TextField
              id={`${id}-budget`}
              value={f.budget}
              inputMode="numeric"
              disabled={locked}
              onChange={(budget) => { edit({ budget }) }}
              error={budgetInvalid ? t('settings.budget.invalid') : undefined}
              hint={t('settings.budget.hint')}
            />
          </SettingsItem>
          <SettingsItem
            label={t('settings.overflow.label')}
            hint={<>{t('settings.overflow.relaxHint')}<br />{t('settings.overflow.strictHint')}</>}
          >
            <SegmentedControl
              id={`${id}-overflow`}
              label={t('settings.overflow.label')}
              value={f.overflow}
              options={OVERFLOW_MODES.map(v => ({ value: v, label: t(`settings.overflow.${v}`) }))}
              disabled={locked}
              onChange={(overflow) => { edit({ overflow }) }}
            />
          </SettingsItem>
          <SettingsItem label={t('settings.evidence.label')} hint={t('settings.evidence.hint')}>
            <SegmentedControl
              id={`${id}-evidence`}
              label={t('settings.evidence.label')}
              value={f.evidence}
              options={EVIDENCE_LEVELS.map(v => ({ value: v, label: t(`settings.evidence.${v}`) }))}
              disabled={locked}
              onChange={(evidence) => { edit({ evidence }) }}
            />
          </SettingsItem>
          <SettingsItem label={t('settings.dictionary.label')} htmlFor={`${id}-dictionary`}>
            <TextField
              id={`${id}-dictionary`}
              value={f.userDictionary}
              disabled={locked}
              onChange={(userDictionary) => { edit({ userDictionary }) }}
              hint={<>{t('settings.dictionary.hint')}<br />{t('settings.dictionary.format')}</>}
            />
          </SettingsItem>
        </SettingsGroupCard>

        <SettingsGroupCard title={t('settings.group.manage')}>
          <SettingsItem label={t('settings.governance.label')} hint={t('settings.governance.hint')}>
            <Switch label={t('settings.governance.label')} checked={f.governance} disabled={locked} onChange={(governance) => { edit({ governance }) }} />
          </SettingsItem>
          <SettingsItem
            label={<>{t('settings.auto.label')} <Chip variant="neutral">{t('settings.auto.planned')}</Chip></>}
            hint={t('settings.auto.hint')}
            disabled
          >
            <SegmentedControl
              id={`${id}-auto`}
              label={t('settings.auto.label')}
              value="off"
              options={AUTO_CHECKUP.map(v => ({ value: v, label: t(`settings.auto.${v}`) }))}
              disabled
              onChange={() => {}}
            />
          </SettingsItem>
          <SettingsItem
            label={t('settings.sensitivity.label')}
            hint={t('settings.sensitivity.hint', { score: sensitivity.score, days: sensitivity.days })}
            disabled={governanceOff}
          >
            <SegmentedControl
              id={`${id}-sensitivity`}
              label={t('settings.sensitivity.label')}
              value={f.sensitivity}
              options={SENSITIVITIES.map(v => ({ value: v, label: t(`settings.sensitivity.${v}`) }))}
              disabled={locked || governanceOff}
              onChange={(next) => { edit({ sensitivity: next }) }}
            />
          </SettingsItem>
          <SettingsItem
            label={t('settings.target.label')}
            hint={f.promoteTarget === 'agents-md' ? t('settings.target.agentsHint') : t('settings.target.pluginHint')}
            disabled={governanceOff}
          >
            <SegmentedControl
              id={`${id}-target`}
              label={t('settings.target.label')}
              value={f.promoteTarget}
              options={PROMOTE_TARGETS.map(v => ({ value: v, label: t(`settings.target.${v}`) }))}
              disabled={locked || governanceOff}
              onChange={(promoteTarget) => { edit({ promoteTarget }) }}
            />
          </SettingsItem>
          <SettingsItem label={t('settings.deleted.label')} hint={t('settings.deleted.hint')}>
            <button type="button" className="pm-link" onClick={() => { onOpenMemoryPage({ tab: 'deleted' }) }}>{t('settings.deleted.open')}</button>
          </SettingsItem>
          <SettingsItem label={t('settings.root.label')} hint={t('settings.root.hint')}>
            <MemoryRoot configured={configuredRoot(snapshot.value)} />
          </SettingsItem>
        </SettingsGroupCard>

        {USAGE_FIELDS.some(key => draft.changed.has(key)) ? <p className="pm-form-note pm-settings-note">{t('settings.usage.reloadNote')}</p> : null}
        {draft.outcome === 'conflict'
          ? (
            <div className="pm-settings-conflict" role="alert">
              <p>{t('settings.conflict')}</p>
              <Button onClick={draft.discard}>{t('settings.conflict.reload')}</Button>
            </div>
          )
          : null}
      </SettingsForm>
      {isConfirming
        ? (
          <Dialog
            title={t('settings.confirm.title')}
            closeLabel={t('settings.confirm.close')}
            onClose={() => { setConfirming(false) }}
            footer={(
              <>
                <Button onClick={() => { setConfirming(false) }}>{t('settings.confirm.cancel')}</Button>
                <Button variant="primary" onClick={() => { setConfirming(false); void draft.save() }}>{t('settings.confirm.save')}</Button>
              </>
            )}
          >
            <ul className="pm-settings-changes">
              {changeLines(t, saved, f, draft.changed).map(line => <li key={line}>{line}</li>)}
            </ul>
          </Dialog>
        )
        : null}
    </div>
  )
}

/** 一串类型名，加引号、按语言习惯连起来（中文「A」「B」，英文 “A”, “B”）。 */
function typeNames(t: Translate, labels: readonly string[]): string {
  return t('settings.typeOpen') + labels.join(t('settings.typeSep')) + t('settings.typeClose')
}

/** 确认弹窗的行，按页面上的顺序；值写成界面上的叫法。 */
const FIELD_LABELS: Record<keyof SettingsFields, LocaleKey> = {
  template: 'settings.template.label',
  customTypes: 'settings.types.label',
  budget: 'settings.budget.label',
  overflow: 'settings.overflow.label',
  evidence: 'settings.evidence.label',
  governance: 'settings.governance.label',
  sensitivity: 'settings.sensitivity.label',
  promoteTarget: 'settings.target.label',
  userDictionary: 'settings.dictionary.label',
}

function valueText(t: Translate, key: Exclude<keyof SettingsFields, 'customTypes'>, fields: SettingsFields): string {
  switch (key) {
    case 'template': return t(`settings.template.${fields.template}`)
    case 'budget': return String(parsePositiveInt(fields.budget) ?? fields.budget)
    case 'overflow': return t(`settings.overflow.${fields.overflow}`)
    case 'evidence': return t(`settings.evidence.${fields.evidence}`)
    case 'governance': return t(fields.governance ? 'settings.confirm.on' : 'settings.confirm.off')
    case 'sensitivity': return t(`settings.sensitivity.${fields.sensitivity}`)
    case 'promoteTarget': return t(`settings.target.${fields.promoteTarget}`)
    case 'userDictionary': return fields.userDictionary.trim() || t('settings.dictionary.unset')
  }
}

function changeLines(t: Translate, saved: SettingsFields, fields: SettingsFields, changed: ReadonlySet<keyof SettingsFields>): string[] {
  return (Object.keys(FIELD_LABELS) as (keyof SettingsFields)[]).filter(key => changed.has(key)).map((key) => {
    let change: string
    if (key === 'customTypes') {
      const parts = customTypeChanges(saved.customTypes, fields.customTypes)
      change = (['added', 'edited', 'removed'] as const)
        .filter(kind => parts[kind].length > 0)
        .map(kind => t(`settings.confirm.${kind}`, { names: typeNames(t, parts[kind]) }))
        .join(t('settings.confirm.partSep'))
    } else {
      change = t('settings.confirm.change', { from: valueText(t, key, saved), to: valueText(t, key, fields) })
    }
    return t('settings.confirm.item', { label: t(FIELD_LABELS[key]), change })
  })
}

/**
 * 实际路径来自视图（服务端解析过的绝对路径）；还没读到时显示配置里写的，都没有就提示开会话。
 * 有路径就能「在访达中显示」（openWorkspacePath 不要会话）。
 */
function MemoryRoot({ configured }: { configured: string }) {
  const t = useT()
  const gateway = useGateway()
  const library = gateway.useView(gateway.useSession(undefined), 'library')
  const [isRefused, setRefused] = useState(false)
  const path = library.status === 'ready' ? library.data.memoryRoot : configured
  if (path === '') return <span className="pm-setting-hint">{t('settings.root.unknown')}</span>
  return (
    <span className="pm-settings-root">
      <code className="pm-settings-path">{path}</code>
      <button type="button" className="pm-link" onClick={() => { void gateway.openPath(path, 'reveal').then((ok) => { setRefused(!ok) }) }}>
        {t('library.reveal')}
      </button>
      {isRefused ? <span className="pm-setting-hint" role="status">{t('action.openFailed')}</span> : null}
    </span>
  )
}

export const settingsPageCss = `
.pm-settings { display: flex; flex-direction: column; gap: 32px; }
.pm-settings-note { margin: 16px 0 0; }
.pm-settings-changes { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--pm-text); }
.pm-settings-conflict { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.pm-settings-conflict p { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-settings-root { display: flex; align-self: stretch; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.pm-settings-path {
  flex: 1 1 240px; min-width: 0;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.5;
  color: var(--pm-text-2); overflow-wrap: anywhere; user-select: text;
}
.pm-settings-root > .pm-setting-hint { flex-basis: 100%; }
.pm-settings .pm-link { font-size: 13px; line-height: 1.5; color: var(--pm-text-2); white-space: nowrap; }
.pm-settings .pm-link:hover { color: var(--pm-text); text-decoration: none; }
`

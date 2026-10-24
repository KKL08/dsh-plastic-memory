/**
 * 插件设置页（plugins.bundle.config）：状态卡 + 三组设置「记什么 · 怎么用 · 怎么管」+ 保存行。
 * 插件名、简介、版本由宿主插件页的页头画（locale/*.json 的 meta 与 package.json 的 version），这里不重复。
 * 改动先暂存、点保存一次提交（useSettingsDraft）；体检关闭时依赖它的三项置灰保留，不隐藏。
 */
import { useId, useState } from 'react'
import { useGateway } from '../gateway.ts'
import { useT } from '../i18n.tsx'
import type { MemoryTab } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { SegmentedControl } from '../ui/Segmented.tsx'
import { SettingsForm, SettingsGroupCard, SettingsItem } from '../ui/Settings.tsx'
import {
  EVIDENCE_LEVELS, OVERFLOW_MODES, PROMOTE_TARGETS, SENSITIVITIES, SENSITIVITY_NUMBERS, TEMPLATES, configuredRoot, parsePositiveInt,
  type ConfigForm, type SettingsFields,
} from './config.ts'
import { Switch, TextField } from './controls.tsx'
import { CustomTypeList } from './CustomTypes.tsx'
import { StatusCard } from './StatusCard.tsx'
import { useSettingsDraft } from './useSettingsDraft.ts'

const AUTO_CHECKUP = ['off', 'daily', 'weekly'] as const

const USAGE_FIELDS: ReadonlyArray<keyof SettingsFields> = ['budget', 'overflow', 'evidence']

export function SettingsPage({ form, onOpenMemoryPage, now }: {
  form: ConfigForm
  /** 经导航 store 直达记忆页的某个 tab。 */
  onOpenMemoryPage: (tab: MemoryTab) => void
  now?: number
}) {
  const t = useT()
  const id = useId()
  const draft = useSettingsDraft(form)
  const { snapshot, fields: f, saved, edit } = draft
  if (snapshot.status === 'loading') return <p className="pm-form-note" role="status">{t('settings.loading')}</p>

  const locked = !snapshot.writable || draft.saving
  const governanceOff = !f.governance
  const budgetInvalid = f.budget !== saved.budget && parsePositiveInt(f.budget) === undefined
  const sensitivity = SENSITIVITY_NUMBERS[f.sensitivity]

  return (
    <div className="pm-settings">
      <StatusCard governanceEnabled={saved.governance} onOpen={onOpenMemoryPage} {...(now !== undefined ? { now } : {})} />
      <SettingsForm
        state={{
          available: snapshot.status === 'ready', writable: snapshot.writable, dirty: draft.dirty,
          invalid: draft.invalid, saving: draft.saving, failed: draft.outcome === 'failed',
        }}
        onSave={() => { void draft.save() }}
        onDiscard={draft.discard}
      >
        <SettingsGroupCard title={t('settings.group.what')}>
          <SettingsItem
            label={t('settings.template.label')}
            hint={f.template !== saved.template ? t('settings.template.switchHint') : t('settings.template.hint')}
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
            <button type="button" className="pm-link" onClick={() => { onOpenMemoryPage('deleted') }}>{t('settings.deleted.open')}</button>
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
    </div>
  )
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
.pm-settings-conflict { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.pm-settings-conflict p { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-settings-root { display: inline-flex; flex-wrap: wrap; align-items: baseline; justify-content: flex-end; gap: 4px 12px; }
.pm-settings-path {
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.5;
  color: var(--pm-text-2); word-break: break-all; user-select: text;
}
.pm-link {
  padding: 0; border: 0; background: none; font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--pm-text-2); cursor: pointer; white-space: nowrap;
}
.pm-link:hover { color: var(--pm-text); }
`

/**
 * 插件设置页（plugins.bundle.config）：状态卡 + 三组设置「记什么 · 怎么用 · 怎么管」+ 保存行。
 * 插件名、简介、版本由宿主插件页的页头画（locale/*.json 的 meta 与 package.json 的 version），这里不重复。
 * 改动先暂存，点保存先弹窗列出改了哪几项，确认后一次提交（useSettingsDraft）。
 * 体检开关 `governance.enabled` 只在配置文件里改，界面上不放；配置文件关掉体检时依赖它的两项置灰保留、说明换成原因，不隐藏。
 */
import { useId, useState } from 'react'
import type { MemoryCommand } from '../../src/gui/contract.ts'
import { useGateway } from '../gateway.ts'
import { useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { ALL_SCOPE, type NavTarget } from '../nav.ts'
import { Button } from '../ui/Button.tsx'
import { SegmentedControl } from '../ui/Segmented.tsx'
import { SettingsForm, SettingsGroupCard, SettingsItem } from '../ui/Settings.tsx'
import {
  EVIDENCE_LEVELS, OVERFLOW_MODES, PROMOTE_TARGETS, SENSITIVITIES, SENSITIVITY_NUMBERS, configuredRoot, customTypeChanges,
  governanceEnabled, parsePositiveInt, sceneChanges, type ConfigForm, type Migrations, type SettingsFields,
} from './config.ts'
import { Dialog, TextField } from './controls.tsx'
import { SceneSection, sceneLabel, typeNames } from './Scenes.tsx'
import { StatusCard } from './StatusCard.tsx'
import { useSettingsDraft, type MigrateType } from './useSettingsDraft.ts'

const USAGE_FIELDS: ReadonlyArray<keyof SettingsFields> = ['budget', 'overflow', 'evidence']

export function SettingsPage({ form, onOpenMemoryPage, now }: {
  form: ConfigForm
  /** 经导航 store 直达记忆页：状态卡给范围加视图，最近删除入口给旧目标。 */
  onOpenMemoryPage: (target: NavTarget) => void
  now?: number
}) {
  const t = useT()
  const id = useId()
  const gateway = useGateway()
  const session = gateway.useSession(undefined)
  const counts = useMemoryCounts(session)
  const migrate: MigrateType | undefined = session.kind === 'ready'
    ? async (from, m) => {
      const command: MemoryCommand = m.action === 'retype' ? { cmd: 'migrate-type', from, action: 'retype', to: m.to } : { cmd: 'migrate-type', from, action: 'forget' }
      const result = await gateway.execute(session.sessionId, command)
      return result.ok ? { ok: true, skippedSecrets: result.skippedSecrets ?? 0 } : { ok: false }
    }
    : undefined
  const draft = useSettingsDraft(form, migrate)
  const { snapshot, fields: f, saved, edit } = draft
  const [isConfirming, setConfirming] = useState(false)
  if (snapshot.status === 'loading') return <p className="pm-form-note" role="status">{t('settings.loading')}</p>

  const locked = !snapshot.writable || draft.saving
  const governanceOn = governanceEnabled(snapshot.value)
  const offHint = t('settings.governanceOff')
  const budgetInvalid = f.budget !== saved.budget && parsePositiveInt(f.budget) === undefined
  const sensitivity = SENSITIVITY_NUMBERS[f.sensitivity]

  return (
    <div className="pm-settings">
      <StatusCard governanceEnabled={governanceOn} onOpen={onOpenMemoryPage} {...(now !== undefined ? { now } : {})} />
      <SettingsForm
        state={{
          available: snapshot.status === 'ready', writable: snapshot.writable, dirty: draft.dirty,
          invalid: draft.invalid, saving: draft.saving, failed: draft.outcome === 'failed',
        }}
        onSave={() => { setConfirming(true) }}
        onDiscard={draft.discard}
      >
        <SettingsGroupCard title={t('settings.group.what')}>
          <SettingsItem label={t('settings.scene.label')}>
            <SceneSection
              fields={f}
              saved={saved}
              migrations={draft.migrations}
              counts={counts}
              canMigrate={session.kind === 'ready'}
              disabled={locked}
              now={() => now ?? Date.now()}
              onChange={edit}
            />
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
          <SettingsItem
            label={t('settings.sensitivity.label')}
            hint={governanceOn ? t('settings.sensitivity.hint', { score: sensitivity.score, days: sensitivity.days }) : offHint}
            disabled={!governanceOn}
          >
            <SegmentedControl
              id={`${id}-sensitivity`}
              label={t('settings.sensitivity.label')}
              value={f.sensitivity}
              options={SENSITIVITIES.map(v => ({ value: v, label: t(`settings.sensitivity.${v}`) }))}
              disabled={locked || !governanceOn}
              onChange={(next) => { edit({ sensitivity: next }) }}
            />
          </SettingsItem>
          <SettingsItem
            label={t('settings.target.label')}
            hint={!governanceOn ? offHint : f.promoteTarget === 'agents-md' ? t('settings.target.agentsHint') : t('settings.target.pluginHint')}
            disabled={!governanceOn}
          >
            <SegmentedControl
              id={`${id}-target`}
              label={t('settings.target.label')}
              value={f.promoteTarget}
              options={PROMOTE_TARGETS.map(v => ({ value: v, label: t(`settings.target.${v}`) }))}
              disabled={locked || !governanceOn}
              onChange={(promoteTarget) => { edit({ promoteTarget }) }}
            />
          </SettingsItem>
          <SettingsItem label={t('settings.deleted.label')} hint={t('settings.deleted.hint')}>
            <button type="button" className="pm-link" onClick={() => { onOpenMemoryPage({ view: 'deleted', scope: ALL_SCOPE }) }}>{t('settings.deleted.open')}</button>
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
        <MigrationNote draft={draft} />
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
              {changeLines(t, saved, f, draft.changed, draft.migrations, counts).map(line => <li key={line}>{line}</li>)}
            </ul>
          </Dialog>
        )
        : null}
    </div>
  )
}

/** 确认弹窗的行，按页面上的顺序；值写成界面上的叫法。 */
const FIELD_LABELS: Record<keyof SettingsFields, LocaleKey> = {
  template: 'settings.confirm.current',
  scenes: 'settings.confirm.scenes',
  customTypes: 'settings.types.label',
  budget: 'settings.budget.label',
  overflow: 'settings.overflow.label',
  evidence: 'settings.evidence.label',
  sensitivity: 'settings.sensitivity.label',
  promoteTarget: 'settings.target.label',
}

function valueText(t: Translate, key: Exclude<keyof SettingsFields, 'scenes' | 'customTypes'>, fields: SettingsFields): string {
  switch (key) {
    case 'template': return sceneLabel(t, fields.template, fields.scenes)
    case 'budget': return String(parsePositiveInt(fields.budget) ?? fields.budget)
    case 'overflow': return t(`settings.overflow.${fields.overflow}`)
    case 'evidence': return t(`settings.evidence.${fields.evidence}`)
    case 'sensitivity': return t(`settings.sensitivity.${fields.sensitivity}`)
    case 'promoteTarget': return t(`settings.target.${fields.promoteTarget}`)
  }
}

/** 新增、修改、删除三段汇总（名字已转成界面上的叫法）。 */
function partsText(t: Translate, parts: { added: string[]; edited: string[]; removed: string[] }): string {
  return (['added', 'edited', 'removed'] as const)
    .filter(kind => parts[kind].length > 0)
    .map(kind => t(`settings.confirm.${kind}`, { names: typeNames(t, parts[kind]) }))
    .join(t('settings.confirm.partSep'))
}

function changeLines(t: Translate, saved: SettingsFields, fields: SettingsFields, changed: ReadonlySet<keyof SettingsFields>,
  migrations: Migrations, counts: ReadonlyMap<string, number> | undefined): string[] {
  const lines = (Object.keys(FIELD_LABELS) as (keyof SettingsFields)[]).filter(key => changed.has(key)).map((key) => {
    let change: string
    if (key === 'customTypes') {
      // 跟着改名的那一对由迁移行写，不再写成「新增」「删除」
      const moved = Object.entries(migrations).flatMap(([from, m]) => m.action === 'retype' ? [from, m.to] : [])
      const without = (types: SettingsFields['customTypes']) => Object.fromEntries(Object.entries(types).filter(([name]) => !moved.includes(name)))
      change = partsText(t, customTypeChanges(without(saved.customTypes), without(fields.customTypes)))
    } else if (key === 'scenes') {
      const ids = sceneChanges(saved.scenes, fields.scenes)
      change = partsText(t, {
        added: ids.added.map(sid => sceneLabel(t, sid, fields.scenes)),
        edited: ids.edited.map(sid => sceneLabel(t, sid, fields.scenes)),
        removed: ids.removed.map(sid => sceneLabel(t, sid, saved.scenes)),
      })
    } else {
      change = t('settings.confirm.change', { from: valueText(t, key, saved), to: valueText(t, key, fields) })
    }
    return change === '' ? '' : t('settings.confirm.item', { label: t(FIELD_LABELS[key]), change })
  }).filter(line => line !== '')
  for (const [from, m] of Object.entries(migrations)) {
    // 上次没迁完的：配置里已经是新名字，取新名字的中文名
    const label = saved.customTypes[from]?.label ?? (m.action === 'retype' ? fields.customTypes[m.to]?.label : undefined) ?? from
    const n = counts?.get(from)
    if (m.action === 'forget') lines.push(t('settings.confirm.forget', { label }))
    else lines.push(n === undefined ? t('settings.confirm.retypeUnknown', { label, to: m.to }) : t('settings.confirm.retype', { label, to: m.to, n }))
  }
  return lines
}

/** 各类型名下的记忆条数（全库：全部记忆加最近删除）。全部记忆视图读不到时 undefined；最近删除还没生成按没有。 */
function useMemoryCounts(session: ReturnType<ReturnType<typeof useGateway>['useSession']>): ReadonlyMap<string, number> | undefined {
  const gateway = useGateway()
  const library = gateway.useView(session, 'library')
  const deleted = gateway.useView(session, 'deleted')
  if (library.status !== 'ready' || (deleted.status !== 'ready' && deleted.status !== 'missing')) return undefined
  const counts = new Map<string, number>()
  const add = (type: string) => { counts.set(type, (counts.get(type) ?? 0) + 1) }
  for (const layer of library.data.layers) for (const memory of layer.items) add(memory.type)
  if (deleted.status === 'ready') for (const item of deleted.data.items) add(item.memory.type)
  return counts
}

/** 保存后迁移已有记忆的状态：执行中、失败可重试、含密钥没移走的条数。 */
function MigrationNote({ draft }: { draft: ReturnType<typeof useSettingsDraft> }) {
  const t = useT()
  const { migration } = draft
  if (migration.status === 'running') return <p className="pm-form-note pm-settings-note" role="status">{t('settings.migration.running')}</p>
  if (migration.status === 'failed') {
    return (
      <div className="pm-settings-conflict" role="alert">
        <p>{t('settings.migration.failed')}</p>
        <Button onClick={() => { void draft.retryMigrations() }}>{t('settings.migration.retry')}</Button>
      </div>
    )
  }
  if (migration.status === 'done' && migration.skippedSecrets > 0) {
    return <p className="pm-form-note pm-settings-note" role="status">{t('settings.migration.secrets', { n: migration.skippedSecrets })}</p>
  }
  return null
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

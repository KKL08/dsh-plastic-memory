/**
 * 插件设置页（plugins.bundle.config）：状态卡 + 页内顶部四个标签「记什么 · 怎么用 · 怎么管 · 外观」+ 保存行。
 * 插件名、简介、版本由宿主插件页的页头画（locale/*.json 的 meta 与 package.json 的 version），这里不重复。
 * 每页两层：小节（标题和一句「什么时候发生、花多少」在卡外）和卡里的项；「记什么」「外观」不分小节。四页都挂着、只显示选中的一页，
 * 切标签不丢草稿和各项自己的状态。打开时停在「记什么」。
 * 改动先暂存，四页共用一个保存行，吸在可视区底部、写还有几项没保存、在哪几页；有改动的标签上带一个小圆点。
 * 点保存先弹窗列出改了哪几项和保存后的影响（不再新增哪几类、已开着的对话重新带入记忆），确认后一次提交（useSettingsDraft）。
 * 模型选择、删除对话记录库立即执行，不进保存行。
 * 体检开关 `governance.enabled` 只在配置文件里改，界面上不放；配置文件关掉体检时依赖它的几项置灰保留、说明换成原因，不隐藏。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { MemoryCommand, ModelChoices, ModelSelection, ModelSelectionKey } from '../../src/gui/contract.ts'
import { useGateway } from '../gateway.ts'
import { formatNumber, useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { ALL_SCOPE, type NavTarget } from '../nav.ts'
import { isMac } from '../path.ts'
import { Button } from '../ui/Button.tsx'
import { Chip } from '../ui/Chip.tsx'
import { SegmentedControl, SegmentedTabs, type SegmentedTab } from '../ui/Segmented.tsx'
import { SettingsCard, SettingsForm, SettingsItem, SettingsSection, SettingsSwitchItem } from '../ui/Settings.tsx'
import {
  ACCENTS, BUILTIN_TYPE_NAMES, DIALOGUE_BUDGET_MAX, DIALOGUE_BUDGET_MIN, DIALOGUE_BUDGET_STEP, EVIDENCE_LEVELS, OVERFLOW_MODES, PROMOTE_TARGETS, SEARCH_SOURCES,
  SENSITIVITIES, SENSITIVITY_NUMBERS, configuredRoot, customTypeChanges, presetTypeChanges, decayDaysOf, droppedTypes, governanceEnabled, isDialogueInUse,
  parsePositiveInt, sceneChanges, stepDialogueBudget, type ConfigForm, type Migrations, type SettingsFields,
} from './config.ts'
import { Dialog, Stepper, Switch, TextField } from './controls.tsx'
import { DialogueRecordsItem, useDialogueRecords } from './DialogueRecords.tsx'
import { ModelPicker, type PickerValue } from './ModelPicker.tsx'
import { SceneSection, sceneLabel, typeNames } from './Scenes.tsx'
import { typeLabel } from '../type-label.ts'
import { StatusCard } from './StatusCard.tsx'
import { useSettingsDraft, type MigrateType } from './useSettingsDraft.ts'

/** 改了会让已开着的对话重新带入记忆的项（服务端按这几项重建快照）。 */
const USAGE_FIELDS: ReadonlyArray<keyof SettingsFields> = ['budget', 'overflow', 'evidence', 'searchSource', 'memoryQuotes']

const TABS = ['what', 'how', 'manage', 'look'] as const
type Tab = (typeof TABS)[number]
/** 每页管哪几项：标签上的小圆点、保存行里的「在哪几页」按它算；类型迁移算「记什么」。 */
const TAB_FIELDS: Record<Tab, ReadonlyArray<keyof SettingsFields>> = {
  what: ['template', 'scenes', 'removedPresets', 'customTypes', 'builtinDecayDays'],
  how: ['budget', 'overflow', 'searchSource', 'memoryQuotes', 'dialogueBudget', 'queryExpansion', 'evidence'],
  manage: ['sensitivity', 'promoteTarget', 'relatedRecheck'],
  look: ['accent'],
}

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
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  const counts = useMemoryCounts(session)
  const migrate: MigrateType | undefined = sessionId !== undefined
    ? async (from, m) => {
      const command: MemoryCommand = m.action === 'retype' ? { cmd: 'migrate-type', from, action: 'retype', to: m.to } : { cmd: 'migrate-type', from, action: 'forget' }
      const result = await gateway.execute(sessionId, command)
      return result.ok ? { ok: true, skippedSecrets: result.skippedSecrets ?? 0 } : { ok: false }
    }
    : undefined
  const draft = useSettingsDraft(form, migrate)
  const { snapshot, fields: f, saved, edit } = draft
  const [tab, setTab] = useState<Tab>('what')
  const [isConfirming, setConfirming] = useState(false)
  const isRecordsInUse = isDialogueInUse(saved)
  const records = useDialogueRecords(sessionId, isRecordsInUse)
  const governanceOn = governanceEnabled(snapshot.value)
  // 扩查用得上（按草稿）：检索来源含原话、扩查开着
  const isExpansionUsable = f.searchSource !== 'memory' && f.queryExpansion
  // 配置还在读时不知道用不用得上，先不问
  const choices = useModelChoices(sessionId, snapshot.status !== 'loading' && (governanceOn || isExpansionUsable))
  const root = useRef<HTMLDivElement>(null)
  // 确认框里点了保存：弹层关掉时保存按钮正置灰（保存中、存完没有改动），焦点还不回去，改落到保存行
  const isFocusingFooter = useRef(false)
  useEffect(() => {
    if (!isFocusingFooter.current || isConfirming) return
    isFocusingFooter.current = false
    root.current?.querySelector<HTMLElement>('.pm-form-footer')?.focus()
  })
  // 「前往存储」：切到「怎么管」、面板显示出来之后把焦点放到删除按钮上
  const isFocusingRecords = useRef(false)
  useEffect(() => {
    if (!isFocusingRecords.current || tab !== 'manage') return
    isFocusingRecords.current = false
    document.getElementById(`${id}-records-delete`)?.focus()
  })
  if (snapshot.status === 'loading') return <p className="pm-form-note" role="status">{t('settings.loading')}</p>

  const locked = !snapshot.writable || draft.saving
  const offHint = t('settings.governanceOff')
  const memoryOnlyHint = t('settings.memoryOnly')
  const isMemoryOnly = f.searchSource === 'memory'
  const budgetInvalid = f.budget !== saved.budget && parsePositiveInt(f.budget) === undefined
  const sensitivity = SENSITIVITY_NUMBERS[f.sensitivity]
  const dropped = droppedTypes(saved, f, draft.migrations)
  /** 确认框里改动列表下面的影响：不再新增哪几类、已开着的对话重新带入记忆。 */
  const effects = [
    ...(dropped.length > 0 ? [t('settings.scene.dropHint', { types: typeNames(t, dropped.map(n => typeLabel(t, n, { customTypes: saved.customTypes }))) })] : []),
    ...(USAGE_FIELDS.some(key => draft.changed.has(key)) ? [t('settings.usage.reloadNote')] : []),
  ]
  const changes = draft.dirty ? changeLines(t, saved, f, draft.changed, draft.migrations, counts) : []
  const dirtyTabs = changes.length === 0
    ? []
    : TABS.filter(name => TAB_FIELDS[name].some(key => draft.changed.has(key)) || (name === 'what' && Object.keys(draft.migrations).length > 0))
  const tabLabel = (name: Tab) => t(`settings.group.${name}`)
  const tabItem = (name: Tab): SegmentedTab<Tab> => ({
    value: name,
    id: `${id}-tab-${name}`,
    panelId: `${id}-panel-${name}`,
    label: <>{tabLabel(name)}{dirtyTabs.includes(name) ? <span className="pm-dirty-dot" role="img" aria-label={t('settings.tabs.dirty')} /> : null}</>,
  })
  const onConfirmSave = () => {
    isFocusingFooter.current = true
    setConfirming(false)
    // 这次保存让对话记录库从用得上变成用不上：存好后原位问要不要删（库本来就没建时不问）
    const isDroppingRecords = isDialogueInUse(saved) && !isDialogueInUse(f)
    void draft.save().then((ok) => { if (ok && isDroppingRecords) records.offerDelete() })
  }
  const panels: Record<Tab, ReactNode> = {
    what: (
      <SettingsCard>
        <SceneSection
          fields={f}
          saved={saved}
          migrations={draft.migrations}
          counts={counts}
          canMigrate={sessionId !== undefined}
          disabled={locked}
          now={() => now ?? Date.now()}
          onChange={edit}
        />
      </SettingsCard>
    ),
    how: (
      <>
        <SettingsSection title={t('settings.section.inject')} description={t('settings.section.injectDesc')}>
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
        </SettingsSection>
        <SettingsSection title={t('settings.section.search')} description={t('settings.section.searchDesc')} footnote={t('settings.section.searchFoot')}>
          <SettingsItem label={t('settings.source.label')} hint={t('settings.source.hint')}>
            <SegmentedControl
              id={`${id}-source`}
              label={t('settings.source.label')}
              value={f.searchSource}
              options={SEARCH_SOURCES.map(v => ({ value: v, label: t(`settings.source.${v}`) }))}
              disabled={locked}
              onChange={(searchSource) => { edit({ searchSource }) }}
            />
          </SettingsItem>
          <SettingsSwitchItem label={t('settings.quotes.label')} htmlFor={`${id}-quotes`} hint={t('settings.quotes.hint')}>
            <Switch id={`${id}-quotes`} checked={f.memoryQuotes} disabled={locked} onChange={(memoryQuotes) => { edit({ memoryQuotes }) }} />
          </SettingsSwitchItem>
          <SettingsItem
            label={t('settings.dialogueBudget.label')}
            labelId={`${id}-dialogue-budget`}
            hint={isMemoryOnly ? memoryOnlyHint : t('settings.dialogueBudget.hint')}
            disabled={isMemoryOnly}
          >
            <Stepper
              labelledBy={`${id}-dialogue-budget`}
              value={<>{passagesText(t, f.dialogueBudget)}<small>{t('settings.dialogueBudget.tokens', { tokens: formatNumber(f.dialogueBudget) })}</small></>}
              lessLabel={t('settings.dialogueBudget.less')}
              moreLabel={t('settings.dialogueBudget.more')}
              canLess={f.dialogueBudget > DIALOGUE_BUDGET_MIN}
              canMore={f.dialogueBudget < DIALOGUE_BUDGET_MAX}
              disabled={locked || isMemoryOnly}
              onStep={(direction) => { edit({ dialogueBudget: stepDialogueBudget(f.dialogueBudget, direction) }) }}
            />
          </SettingsItem>
          <SettingsSwitchItem
            label={t('settings.expansion.label')}
            htmlFor={`${id}-expansion`}
            hint={isMemoryOnly ? memoryOnlyHint : t('settings.expansion.hint')}
            disabled={isMemoryOnly}
          >
            <Switch id={`${id}-expansion`} checked={f.queryExpansion} disabled={locked || isMemoryOnly} onChange={(queryExpansion) => { edit({ queryExpansion }) }} />
          </SettingsSwitchItem>
          <ModelSelectionItem
            id={`${id}-expansion-model`}
            selectionKey="expansion"
            choices={choices}
            offHint={isMemoryOnly ? memoryOnlyHint : !f.queryExpansion ? t('settings.expansionModel.off') : undefined}
            sub
          />
        </SettingsSection>
        <SettingsSection title={t('settings.section.check')} description={t('settings.section.checkDesc')}>
          <SettingsItem label={t('settings.evidence.label')} hint={f.memoryQuotes ? t('settings.evidence.quotesHint') : t('settings.evidence.hint')}>
            <SegmentedControl
              id={`${id}-evidence`}
              label={t('settings.evidence.label')}
              value={f.evidence}
              options={EVIDENCE_LEVELS.map(v => ({ value: v, label: t(`settings.evidence.${v}`) }))}
              disabled={locked}
              onChange={(evidence) => { edit({ evidence }) }}
            />
          </SettingsItem>
        </SettingsSection>
      </>
    ),
    manage: (
      <>
        <SettingsSection title={t('settings.section.checkup')} description={t('settings.section.checkupDesc')} footnote={t('settings.section.checkupFoot')}>
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
            hint={!governanceOn ? offHint : t('settings.target.lead') + (f.promoteTarget === 'agents-md' ? t('settings.target.agentsHint') : t('settings.target.pluginHint'))}
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
          <ModelSelectionItem id={`${id}-checkup-model`} selectionKey="checkup" choices={choices} offHint={governanceOn ? undefined : offHint} />
          <SettingsSwitchItem
            label={t('settings.recheck.label')}
            htmlFor={`${id}-recheck`}
            hint={governanceOn ? t('settings.recheck.hint') : offHint}
            disabled={!governanceOn}
            badge={<Chip variant="neutral">{t('settings.experimental')}</Chip>}
          >
            <Switch id={`${id}-recheck`} checked={f.relatedRecheck} disabled={locked || !governanceOn} onChange={(relatedRecheck) => { edit({ relatedRecheck }) }} />
          </SettingsSwitchItem>
        </SettingsSection>
        <SettingsSection
          title={t('settings.section.dreams')}
          description={t('settings.section.dreamsDesc')}
          badge={<Chip variant="neutral">{t('settings.experimental')}</Chip>}
        >
          <div className="pm-setting"><p className="pm-setting-hint">{t('settings.section.dreamsSoon')}</p></div>
        </SettingsSection>
        <SettingsSection title={t('settings.section.storage')} description={t('settings.section.storageDesc')}>
          <DialogueRecordsItem records={records} isInUse={isRecordsInUse} deleteId={`${id}-records-delete`} />
          <SettingsItem label={t('settings.deleted.label')} hint={t('settings.deleted.hint')}>
            <button type="button" className="pm-link pm-settings-link" onClick={() => { onOpenMemoryPage({ view: 'deleted', scope: ALL_SCOPE }) }}>{t('settings.deleted.open')}</button>
          </SettingsItem>
          <SettingsItem label={t('settings.root.label')} hint={t('settings.root.hint')}>
            <MemoryRoot configured={configuredRoot(snapshot.value)} />
          </SettingsItem>
        </SettingsSection>
      </>
    ),
    look: (
      <SettingsCard>
        <SettingsItem label={t('settings.accent.label')}>
          <SegmentedControl
            id={`${id}-accent`}
            label={t('settings.accent.label')}
            value={f.accent}
            options={ACCENTS.map(v => ({ value: v, label: t(`settings.accent.${v}`) }))}
            disabled={locked}
            onChange={(accent) => { edit({ accent }) }}
          />
        </SettingsItem>
      </SettingsCard>
    ),
  }

  return (
    <div ref={root} className="pm-settings">
      <StatusCard governanceEnabled={governanceOn} onOpen={onOpenMemoryPage} {...(now !== undefined ? { now } : {})} />
      <SettingsForm
        state={{
          available: snapshot.status === 'ready', writable: snapshot.writable, dirty: draft.dirty,
          invalid: draft.invalid, saving: draft.saving, failed: draft.outcome === 'failed',
        }}
        pending={changes.length > 0 ? t('settings.unsavedIn', { n: changes.length, tabs: dirtyTabs.map(tabLabel).join(t('settings.scene.listSep')) }) : undefined}
        onSave={() => { setConfirming(true) }}
        onDiscard={draft.discard}
      >
        <div className="pm-settings-tabs">
          <SegmentedTabs
            label={t('settings.tabs')}
            value={tab}
            onChange={setTab}
            items={[tabItem('what'), tabItem('how'), tabItem('manage'), tabItem('look')]}
          />
        </div>
        {TABS.map(name => (
          <div key={name} role="tabpanel" id={`${id}-panel-${name}`} aria-labelledby={`${id}-tab-${name}`} hidden={name !== tab}>
            {panels[name]}
          </div>
        ))}

        {draft.outcome === 'conflict'
          ? (
            <div className="pm-settings-conflict" role="alert">
              <p>{t('settings.conflict')}</p>
              <Button onClick={draft.discard}>{t('settings.conflict.reload')}</Button>
            </div>
          )
          : null}
        <MigrationNote draft={draft} />
        {records.isOffered && tab !== 'manage'
          ? (
            // 保存多半停在「怎么用」，存储在「怎么管」：在四页之外提一句，删除仍到存储里原位确认
            <p className="pm-settings-records-note" role="status">
              <span>{t('settings.records.unused')}</span>
              <button type="button" className="pm-link pm-settings-link" onClick={() => { isFocusingRecords.current = true; setTab('manage') }}>{t('settings.records.goto')}</button>
            </p>
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
                <Button variant="primary" onClick={onConfirmSave}>{t('settings.confirm.save')}</Button>
              </>
            )}
          >
            <ul className="pm-settings-changes">
              {changes.map(line => <li key={line}>{line}</li>)}
            </ul>
            {effects.length > 0 ? <div className="pm-settings-effects">{effects.map(text => <p key={text}>{text}</p>)}</div> : null}
          </Dialog>
        )
        : null}
    </div>
  )
}

const onOff = (t: Translate, isOn: boolean) => t(isOn ? 'settings.on' : 'settings.off')

/** 其他原话的段数：「5 段」/「5 passages」。 */
function passagesText(t: Translate, budget: number): string {
  const n = budget / DIALOGUE_BUDGET_STEP
  return t(n === 1 ? 'settings.dialogueBudget.passages.one' : 'settings.dialogueBudget.passages', { n })
}

/**
 * 能选的模型：打开设置页、第一次有模型选择器用得上时问一次（list-models），体检和扩查两个选择器共用。
 * 换了会话按新会话重问，之前会话的回复晚到不算数；undefined = 还没问、还在读或会话没了。
 */
function useModelChoices(sessionId: string | undefined, isNeeded: boolean): ModelChoices | 'failed' | undefined {
  const gateway = useGateway()
  const [loaded, setLoaded] = useState<{ sessionId: string; choices: ModelChoices | 'failed' } | undefined>()
  const requested = useRef<string | undefined>(undefined)
  // 现在的会话；卸载后为 undefined
  const current = useRef<string | undefined>(sessionId)
  useEffect(() => {
    current.current = sessionId
    return () => { current.current = undefined }
  }, [sessionId])
  useEffect(() => {
    if (sessionId === undefined || !isNeeded || requested.current === sessionId) return
    requested.current = sessionId
    void gateway.execute(sessionId, { cmd: 'list-models' }).then((result) => {
      if (current.current === sessionId) setLoaded({ sessionId, choices: result.ok ? result.providers ?? [] : 'failed' })
    })
  }, [gateway, sessionId, isNeeded])
  return loaded !== undefined && loaded.sessionId === sessionId ? loaded.choices : undefined
}

/** 确认弹窗的行，按页面上的顺序；值写成界面上的叫法。 */
const FIELD_LABELS: Record<keyof SettingsFields, LocaleKey> = {
  template: 'settings.confirm.current',
  scenes: 'settings.confirm.scenes',
  removedPresets: 'settings.confirm.presets',
  customTypes: 'settings.types.label',
  builtinDecayDays: 'settings.confirm.periods',
  budget: 'settings.budget.label',
  overflow: 'settings.overflow.label',
  searchSource: 'settings.source.label',
  memoryQuotes: 'settings.quotes.label',
  dialogueBudget: 'settings.dialogueBudget.label',
  queryExpansion: 'settings.expansion.label',
  evidence: 'settings.evidence.label',
  sensitivity: 'settings.sensitivity.label',
  promoteTarget: 'settings.target.label',
  relatedRecheck: 'settings.recheck.label',
  accent: 'settings.accent.label',
}

function valueText(t: Translate, key: Exclude<keyof SettingsFields, 'scenes' | 'customTypes' | 'removedPresets' | 'builtinDecayDays'>, fields: SettingsFields): string {
  switch (key) {
    case 'template': return sceneLabel(t, fields.template, fields.scenes)
    case 'budget': return String(parsePositiveInt(fields.budget) ?? fields.budget)
    case 'overflow': return t(`settings.overflow.${fields.overflow}`)
    case 'evidence': return t(`settings.evidence.${fields.evidence}`)
    case 'sensitivity': return t(`settings.sensitivity.${fields.sensitivity}`)
    case 'promoteTarget': return t(`settings.target.${fields.promoteTarget}`)
    case 'relatedRecheck': return onOff(t, fields.relatedRecheck)
    case 'searchSource': return t(`settings.source.${fields.searchSource}`)
    case 'memoryQuotes': return onOff(t, fields.memoryQuotes)
    case 'dialogueBudget': return passagesText(t, fields.dialogueBudget) + t('settings.dialogueBudget.tokens', { tokens: formatNumber(fields.dialogueBudget) })
    case 'queryExpansion': return onOff(t, fields.queryExpansion)
    case 'accent': return t(`settings.accent.${fields.accent}`)
  }
}

/** 新增、修改、恢复默认、删除、恢复几段汇总（名字已转成界面上的叫法）。 */
function partsText(t: Translate, parts: Partial<Record<'added' | 'edited' | 'reset' | 'removed' | 'restored', string[]>>): string {
  return (['added', 'edited', 'reset', 'removed', 'restored'] as const)
    .filter(kind => (parts[kind]?.length ?? 0) > 0)
    .map(kind => t(`settings.confirm.${kind}`, { names: typeNames(t, parts[kind]!) }))
    .join(t('settings.confirm.partSep'))
}

function changeLines(t: Translate, saved: SettingsFields, fields: SettingsFields, changed: ReadonlySet<keyof SettingsFields>,
  migrations: Migrations, counts: ReadonlyMap<string, number> | undefined): string[] {
  // 改过的预设存在 customTypes 里，所以 customTypes 变了也要看预设那一行
  const isChanged = (key: keyof SettingsFields) => changed.has(key) || (key === 'removedPresets' && changed.has('customTypes'))
  const lines = (Object.keys(FIELD_LABELS) as (keyof SettingsFields)[]).filter(isChanged).map((key) => {
    let change: string
    if (key === 'removedPresets') {
      const parts = presetTypeChanges(saved, fields)
      change = partsText(t, {
        edited: parts.edited.map(n => typeLabel(t, n, { customTypes: fields.customTypes })),
        reset: parts.reset.map(n => typeLabel(t, n, { customTypes: saved.customTypes })),
        removed: parts.removed.map(n => typeLabel(t, n, { customTypes: saved.customTypes })),
        restored: parts.restored.map(n => typeLabel(t, n, {})),
      })
    } else if (key === 'customTypes') {
      // 跟着改名的那一对由迁移行写，不再写成「新增」「删除」
      const moved = Object.entries(migrations).flatMap(([from, m]) => m.action === 'retype' ? [from, m.to] : [])
      const without = (types: SettingsFields['customTypes']) => Object.fromEntries(Object.entries(types).filter(([name]) => !moved.includes(name)))
      change = partsText(t, customTypeChanges(without(saved.customTypes), without(fields.customTypes)))
    } else if (key === 'builtinDecayDays') {
      const days = (n: number | null) => n === null ? t('settings.types.periodNone') : t('settings.types.periodDays', { n })
      change = BUILTIN_TYPE_NAMES.filter(name => decayDaysOf(saved, name) !== decayDaysOf(fields, name))
        .map(name => t('settings.confirm.period', { name: typeNames(t, [typeLabel(t, name, {})]), from: days(decayDaysOf(saved, name)), to: days(decayDaysOf(fields, name)) }))
        .join(t('settings.confirm.partSep'))
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
    const label = saved.customTypes[from]?.label ?? (m.action === 'retype' ? fields.customTypes[m.to]?.label : undefined) ?? typeLabel(t, from, {})
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
  for (const group of library.data.layers) for (const memory of group.items) add(memory.type)
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

/** 两个模型选择项各自的文案：标签、「跟随」的叫法、能选时的说明、读不出时的说明。 */
const SELECTION_TEXT: Record<'checkup' | 'expansion', { label: LocaleKey; follow: LocaleKey; hint: LocaleKey; unreadable: LocaleKey }> = {
  checkup: { label: 'settings.checkupModel.label', follow: 'settings.checkupModel.follow', hint: 'settings.checkupModel.hint', unreadable: 'settings.checkupModel.unreadable' },
  expansion: { label: 'settings.expansionModel.label', follow: 'settings.expansionModel.follow', hint: 'settings.expansionModel.hint', unreadable: 'settings.expansionModel.unreadable' },
}

/**
 * 模型选择一项：体检用的模型（自动体检和记忆页的立即体检都用它）、扩查用的模型。改了立即存，不进保存行：
 * 存在插件的共享设置里（set-model-selection，按 selectionKey 分开存），几个 DeepSeek Harness 进程读同一份。
 * 当前值取体检视图的 selections；视图还在读、没读到、没有 selections（上一个发布版的进程写的）时不知道存的是什么，显示「正在读取…」「无法确认当前选择」并置灰，不当成跟随。
 * 存的选择读不出时显示「读不出当前选择」加一句说明，重新选一次就恢复。
 * 能选的模型由页面问一次后传进来。没有会话、用不上（offHint 给原因）时置灰，说明换成原因。
 *
 * 连续选时保存一个接一个发：同一时刻只有一个在途，在途时再选的只记最后一次，等在途的回来再发，服务端收到的顺序就是选的顺序。
 * 刚选的值先显示出来，直到以视图为准：最后一次保存没存上时退回视图里的值并提示；存好之后视图再变一次
 * （这里存好后重写、或别的窗口改了）就以视图为准。在途或排着的保存回来之前，视图怎么变都先显示刚选的。
 */
function ModelSelectionItem({ id, selectionKey, choices, offHint, sub = false }: {
  id: string
  selectionKey: Extract<ModelSelectionKey, 'checkup' | 'expansion'>
  choices: ModelChoices | 'failed' | undefined
  /** 用不上的原因（体检关了、扩查关了…）；undefined = 用得上。 */
  offHint: string | undefined
  sub?: boolean
}) {
  const t = useT()
  const gateway = useGateway()
  const session = gateway.useSession(undefined)
  const view = gateway.useView(session, 'checkups')
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  const text = SELECTION_TEXT[selectionKey]
  // 刚选、还没以视图为准时显示的值；isSaved = 最后一次保存已经存好
  const [chosen, setChosen] = useState<{ value: ModelSelection | null; isSaved: boolean } | undefined>()
  const [isFailed, setFailed] = useState(false)
  // 有保存在途时不为 undefined；next 是在途时又选的最后一次，等在途的回来再发
  const saving = useRef<{ next?: { sessionId: string; value: ModelSelection | null } } | undefined>(undefined)
  const data = view.status === 'ready' ? view.data : undefined
  // 「没选」只认视图里的 null；视图还在读、没读到、或是上一个发布版的进程写的（没有 selections）都算不知道，不当成跟随
  const saved: PickerValue = data?.selections !== undefined ? data.selections[selectionKey] : view.status === 'loading' && sessionId !== undefined ? 'loading' : 'unknown'
  // 知道存的是什么才能改；不知道时刚选的值也不显示、不发保存。保存回来时按那一刻算，所以记在 ref 里
  const isKnown = saved !== 'loading' && saved !== 'unknown'
  const isKnownNow = useRef(isKnown)
  isKnownNow.current = isKnown
  // 存好之后视图再变一次，就以视图为准
  useEffect(() => { setChosen(c => (c?.isSaved === true ? undefined : c)) }, [data])

  const save = (target: string, value: ModelSelection | null) => {
    saving.current = {}
    void gateway.execute(target, { cmd: 'set-model-selection', key: selectionKey, selection: value }).then(result => result.ok, () => false).then((isOk) => {
      // 在途时又选了：接着发最后选的那个，这次的结果不再算数（成败都不改显示、不提示）。
      // 这时已经不知道存的是什么：排着的那次不发，按没存上提示
      const next = saving.current?.next
      if (next !== undefined && isKnownNow.current) { save(next.sessionId, next.value); return }
      saving.current = undefined
      if (next !== undefined) { setChosen(undefined); setFailed(true); return }
      if (isOk) setChosen(c => (c === undefined ? c : { ...c, isSaved: true }))
      else { setChosen(undefined); setFailed(true) }
    })
  }
  const onChange = (next: ModelSelection | null) => {
    if (sessionId === undefined || !isKnownNow.current) return
    setFailed(false)
    setChosen({ value: next, isSaved: false })
    if (saving.current !== undefined) saving.current.next = { sessionId, value: next }
    else save(sessionId, next)
  }
  const isOff = offHint !== undefined
  const value = isKnown && chosen !== undefined ? chosen.value : saved
  const hint = offHint ?? (sessionId === undefined ? t('settings.checkupModel.noSession') : t(text.hint))
  // 列表、保存、读不出的提示只在能选的时候写：会话没了、用不上时说明已经换成原因
  const isNoted = !isOff && sessionId !== undefined
  // 有提供方这次没读到：一个模型都没读到时整体说没读到，读到了一部分时点名没读到的提供方
  const unread = choices === undefined || choices === 'failed' ? [] : choices.filter(p => p.listFailed === true)
  const isListFailed = choices === 'failed' || (unread.length > 0 && unread.length === choices?.length)
  return (
    <SettingsItem label={t(text.label)} htmlFor={id} hint={hint} disabled={isOff} sub={sub}>
      <ModelPicker
        id={id}
        label={t(text.label)}
        followLabel={t(text.follow)}
        value={value}
        choices={choices === 'failed' ? undefined : choices}
        // 不知道存的是什么时置灰，本地有刚选的值也一样
        disabled={sessionId === undefined || isOff || !isKnown}
        onChange={onChange}
      />
      {value === 'unreadable' && isNoted ? <p className="pm-setting-note" role="status">{t(text.unreadable)}</p> : null}
      {value === 'unknown' && isNoted ? <p className="pm-setting-note" role="status">{t('settings.model.unknownNote')}</p> : null}
      {isListFailed && isNoted ? <p className="pm-setting-hint" role="status">{t('settings.checkupModel.listFailed')}</p> : null}
      {!isListFailed && unread.length > 0 && isNoted
        ? <p className="pm-setting-hint" role="status">{t('settings.checkupModel.listPartial', { providers: unread.map(p => p.name).join(t('settings.scene.listSep')) })}</p>
        : null}
      {isFailed && isNoted ? <p className="pm-input-invalid" role="status">{t('settings.checkupModel.failed')}</p> : null}
    </SettingsItem>
  )
}

/**
 * 实际路径来自视图（服务端解析过的绝对路径）；还没读到时显示配置里写的，都没有就提示开会话。
 * 有路径就能「在访达中显示」（其它平台写「在文件夹中显示」；openWorkspacePath 不要会话）。
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
      <button type="button" className="pm-link pm-settings-link" onClick={() => { void gateway.openPath(path, 'reveal').then((ok) => { setRefused(!ok) }) }}>
        {t(isMac() ? 'pending.unreadable.revealMac' : 'pending.unreadable.revealOther')}
      </button>
      {isRefused ? <span className="pm-setting-hint" role="status">{t('action.openFailed')}</span> : null}
    </span>
  )
}

export const settingsPageCss = `
.pm-settings { display: flex; flex-direction: column; gap: 32px; }
.pm-settings-tabs { max-width: 560px; margin-bottom: 24px; }
/* 窄宽、英文放不下时折行，不撑出横向滚动：标签栏和卡里的分段控件都保持等宽格，字多的格折成两行，滑块跟着变高 */
.pm-settings-tabs .pm-tab { gap: 6px; height: auto; min-height: 34px; padding: 7px 12px; white-space: normal; text-align: center; }
.pm-settings .pm-segmented { max-width: 100%; grid-auto-columns: minmax(0, 1fr); }
.pm-settings .pm-segment { height: auto; min-height: 28px; padding: 4px 16px; white-space: normal; text-align: center; }
.pm-dirty-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--pm-text-2); }
.pm-setting-note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-settings-note { margin: 16px 0 0; }
.pm-settings-records-note { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 16px 0 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-settings-changes { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--pm-text); }
.pm-settings-effects { display: flex; flex-direction: column; gap: 6px; }
.pm-settings-effects p { margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text-2); }
.pm-settings-conflict { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.pm-settings-conflict p { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--pm-text); }
.pm-settings-root { display: flex; align-self: stretch; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.pm-settings-path {
  flex: 1 1 240px; min-width: 0;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.5;
  color: var(--pm-text-2); overflow-wrap: anywhere; user-select: text;
}
.pm-settings-root > .pm-setting-hint { flex-basis: 100%; }
/* 次文字色的只有三个跳转链接：状态卡「打开记忆页 ›」、「查看最近删除 ›」、「在访达中显示」；别的链接（卡片里的「恢复」、原位确认）照普通链接 */
.pm-settings .pm-settings-link { font-size: 13px; line-height: 1.5; color: var(--pm-text-2); white-space: nowrap; }
.pm-settings .pm-settings-link:hover { color: var(--pm-text); text-decoration: none; }
`

/**
 * 插件设置页（plugins.bundle.config）：状态卡 + 四组设置「记什么 · 怎么用 · 怎么管 · 外观」+ 保存行。
 * 插件名、简介、版本由宿主插件页的页头画（locale/*.json 的 meta 与 package.json 的 version），这里不重复。
 * 改动先暂存，保存行吸在可视区底部、写还有几项没保存；点保存先弹窗列出改了哪几项和保存后的影响（不再新增哪几类、已开着的对话重新带入记忆），确认后一次提交（useSettingsDraft）。
 * 体检开关 `governance.enabled` 只在配置文件里改，界面上不放；配置文件关掉体检时依赖它的两项置灰保留、说明换成原因，不隐藏。
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { MemoryCommand, ModelChoices, ModelSelection } from '../../src/gui/contract.ts'
import { useGateway } from '../gateway.ts'
import { useT, type Translate } from '../i18n.tsx'
import type { LocaleKey } from '../locales.ts'
import { ALL_SCOPE, type NavTarget } from '../nav.ts'
import { isMac } from '../path.ts'
import { Button } from '../ui/Button.tsx'
import { SegmentedControl } from '../ui/Segmented.tsx'
import { SettingsForm, SettingsGroupCard, SettingsItem } from '../ui/Settings.tsx'
import {
  ACCENTS, BUILTIN_TYPE_NAMES, EVIDENCE_LEVELS, OVERFLOW_MODES, PROMOTE_TARGETS, SENSITIVITIES, SENSITIVITY_NUMBERS, configuredRoot, customTypeChanges, presetTypeChanges,
  decayDaysOf, droppedTypes, governanceEnabled, parsePositiveInt, sceneChanges, type ConfigForm, type Migrations, type SettingsFields,
} from './config.ts'
import { Dialog, TextField } from './controls.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { SceneSection, sceneLabel, typeNames } from './Scenes.tsx'
import { typeLabel } from '../type-label.ts'
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
  const root = useRef<HTMLDivElement>(null)
  // 确认框里点了保存：弹层关掉时保存按钮正置灰（保存中、存完没有改动），焦点还不回去，改落到保存行
  const isFocusingFooter = useRef(false)
  useEffect(() => {
    if (!isFocusingFooter.current || isConfirming) return
    isFocusingFooter.current = false
    root.current?.querySelector<HTMLElement>('.pm-form-footer')?.focus()
  })
  if (snapshot.status === 'loading') return <p className="pm-form-note" role="status">{t('settings.loading')}</p>

  const locked = !snapshot.writable || draft.saving
  const governanceOn = governanceEnabled(snapshot.value)
  const offHint = t('settings.governanceOff')
  const budgetInvalid = f.budget !== saved.budget && parsePositiveInt(f.budget) === undefined
  const sensitivity = SENSITIVITY_NUMBERS[f.sensitivity]
  const dropped = droppedTypes(saved, f, draft.migrations)
  /** 确认框里改动列表下面的影响：不再新增哪几类、已开着的对话重新带入记忆。 */
  const effects = [
    ...(dropped.length > 0 ? [t('settings.scene.dropHint', { types: typeNames(t, dropped.map(n => typeLabel(t, n, { customTypes: saved.customTypes }))) })] : []),
    ...(USAGE_FIELDS.some(key => draft.changed.has(key)) ? [t('settings.usage.reloadNote')] : []),
  ]
  const changes = draft.dirty ? changeLines(t, saved, f, draft.changed, draft.migrations, counts) : []

  return (
    <div ref={root} className="pm-settings">
      <StatusCard governanceEnabled={governanceOn} onOpen={onOpenMemoryPage} {...(now !== undefined ? { now } : {})} />
      <SettingsForm
        state={{
          available: snapshot.status === 'ready', writable: snapshot.writable, dirty: draft.dirty,
          invalid: draft.invalid, saving: draft.saving, failed: draft.outcome === 'failed',
        }}
        pending={changes.length > 0 ? t('settings.unsaved', { n: changes.length }) : undefined}
        onSave={() => { setConfirming(true) }}
        onDiscard={draft.discard}
      >
        <SettingsGroupCard title={t('settings.group.what')}>
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
          <CheckupModel id={`${id}-checkup-model`} governanceOn={governanceOn} />
          <SettingsItem label={t('settings.deleted.label')} hint={t('settings.deleted.hint')}>
            <button type="button" className="pm-link pm-settings-link" onClick={() => { onOpenMemoryPage({ view: 'deleted', scope: ALL_SCOPE }) }}>{t('settings.deleted.open')}</button>
          </SettingsItem>
          <SettingsItem label={t('settings.root.label')} hint={t('settings.root.hint')}>
            <MemoryRoot configured={configuredRoot(snapshot.value)} />
          </SettingsItem>
        </SettingsGroupCard>

        <SettingsGroupCard title={t('settings.group.look')}>
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
        </SettingsGroupCard>

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
                <Button variant="primary" onClick={() => { isFocusingFooter.current = true; setConfirming(false); void draft.save() }}>{t('settings.confirm.save')}</Button>
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

/** 确认弹窗的行，按页面上的顺序；值写成界面上的叫法。 */
const FIELD_LABELS: Record<keyof SettingsFields, LocaleKey> = {
  template: 'settings.confirm.current',
  scenes: 'settings.confirm.scenes',
  removedPresets: 'settings.confirm.presets',
  customTypes: 'settings.types.label',
  builtinDecayDays: 'settings.confirm.periods',
  budget: 'settings.budget.label',
  overflow: 'settings.overflow.label',
  evidence: 'settings.evidence.label',
  sensitivity: 'settings.sensitivity.label',
  promoteTarget: 'settings.target.label',
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

/**
 * 体检用的模型（自动体检和记忆页的立即体检都用它）。改了立即存，不进保存行：存在插件的共享设置里（set-model-selection），几个 DeepSeek Harness 进程读同一份。
 * 当前值取体检视图；能选的模型在打开设置页时问一次（list-models）。没有会话、配置文件关掉体检时置灰，说明换成原因；体检视图还没读到时也置灰。
 *
 * 连续选时保存一个接一个发：同一时刻只有一个在途，在途时再选的只记最后一次，等在途的回来再发，服务端收到的顺序就是选的顺序。
 * 刚选的值先显示出来，直到以视图为准：最后一次保存没存上时退回视图里的值并提示；存好之后视图再变一次
 * （这里存好后重写、或别的窗口改了）就以视图为准。在途或排着的保存回来之前，视图怎么变都先显示刚选的。
 */
function CheckupModel({ id, governanceOn }: { id: string; governanceOn: boolean }) {
  const t = useT()
  const gateway = useGateway()
  const session = gateway.useSession(undefined)
  const view = gateway.useView(session, 'checkups')
  const sessionId = session.kind === 'ready' ? session.sessionId : undefined
  const [choices, setChoices] = useState<ModelChoices | 'failed' | undefined>()
  // 刚选、还没以视图为准时显示的值；isSaved = 最后一次保存已经存好
  const [chosen, setChosen] = useState<{ value: ModelSelection | null; isSaved: boolean } | undefined>()
  const [isFailed, setFailed] = useState(false)
  // 有保存在途时不为 undefined；next 是在途时又选的最后一次，等在途的回来再发
  const saving = useRef<{ next?: { sessionId: string; value: ModelSelection | null } } | undefined>(undefined)
  const data = view.status === 'ready' ? view.data : undefined
  // 上一个发布版的进程写的视图没有这一项，按没选处理
  const saved = data?.model ?? null
  // 存好之后视图再变一次，就以视图为准
  useEffect(() => { setChosen(c => (c?.isSaved === true ? undefined : c)) }, [data])
  useEffect(() => {
    // 会话没了：读过的模型不再算数
    if (sessionId === undefined) { setChoices(undefined); return }
    if (!governanceOn) return
    let isLive = true
    void gateway.execute(sessionId, { cmd: 'list-models' }).then((result) => {
      if (isLive) setChoices(result.ok ? result.providers ?? [] : 'failed')
    })
    return () => { isLive = false }
  }, [gateway, sessionId, governanceOn])

  const save = (target: string, value: ModelSelection | null) => {
    saving.current = {}
    void gateway.execute(target, { cmd: 'set-model-selection', key: 'checkup', selection: value }).then(result => result.ok, () => false).then((isOk) => {
      // 在途时又选了：接着发最后选的那个，这次的结果不再算数（成败都不改显示、不提示）
      const next = saving.current?.next
      if (next !== undefined) { save(next.sessionId, next.value); return }
      saving.current = undefined
      if (isOk) setChosen(c => (c === undefined ? c : { ...c, isSaved: true }))
      else { setChosen(undefined); setFailed(true) }
    })
  }
  const onChange = (next: ModelSelection | null) => {
    if (sessionId === undefined) return
    setFailed(false)
    setChosen({ value: next, isSaved: false })
    if (saving.current !== undefined) saving.current.next = { sessionId, value: next }
    else save(sessionId, next)
  }
  const hint = !governanceOn ? t('settings.governanceOff') : sessionId === undefined ? t('settings.checkupModel.noSession') : t('settings.checkupModel.hint')
  // 列表、保存的提示只在能选的时候写：会话没了、体检关了时说明已经换成原因
  const isNoted = governanceOn && sessionId !== undefined
  // 有提供方这次没读到：一个模型都没读到时整体说没读到，读到了一部分时点名没读到的提供方
  const unread = choices === undefined || choices === 'failed' ? [] : choices.filter(p => p.listFailed === true)
  const isListFailed = choices === 'failed' || (unread.length > 0 && unread.length === choices?.length)
  return (
    <SettingsItem label={t('settings.checkupModel.label')} htmlFor={id} hint={hint} disabled={!governanceOn}>
      <ModelPicker
        id={id}
        label={t('settings.checkupModel.label')}
        followLabel={t('settings.checkupModel.follow')}
        value={chosen !== undefined ? chosen.value : saved}
        choices={choices === 'failed' ? undefined : choices}
        // 体检视图没读到时不知道存的是什么，不当成跟随默认模型让人选
        disabled={sessionId === undefined || !governanceOn || data === undefined}
        onChange={onChange}
      />
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
.pm-settings-note { margin: 16px 0 0; }
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

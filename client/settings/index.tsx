/**
 * 设置页的插槽注册：宿主插件页按包名渲染 `plugins.bundle.config`，只传 `{view: 'page'}`、不传 form
 * （PluginManagerPage.tsx），所以组件自己 `ctx.configForms.get(ENTRY_ID)`。
 * configForms 是 ui-settings 提供的服务，用 cordis 的 `ctx.inject(['configForms'], …)` 等它就位再注册：
 * 宿主没有它（或它被卸下）时只是没有设置页，记忆页等其余插槽照常。
 */
import { useMemo } from 'react'
import type { BindGateway } from '../gateway.ts'
import type { HostContext, RootStandardProps } from '../host.ts'
import type { Translate } from '../i18n.tsx'
import { openMemoryPage, type NavStore } from '../nav.ts'
import { PanelShell } from '../ui/PanelShell.tsx'
import { ENTRY_ID, PACKAGE_NAME, type ConfigForm } from './config.ts'
import { controlsCss } from './controls.tsx'
import { customTypesCss } from './CustomTypes.tsx'
import { SettingsPage, settingsPageCss } from './SettingsPage.tsx'

export type ConfigFormsService = NonNullable<HostContext['configForms']>

const SETTINGS_CSS = controlsCss + customTypesCss + settingsPageCss

export function createSettingsCard(ctx: HostContext, configForms: ConfigFormsService, nav: NavStore, bind: BindGateway, useTranslate: () => Translate) {
  return function PlasticMemorySettings(props: RootStandardProps & { view?: 'summary' | 'page' }) {
    const gateway = useMemo(() => bind(props), [props.useSessions, props.useResource])
    const form = useMemo(() => configForms.get(ENTRY_ID), [])
    const t = useTranslate()
    if (props.view !== 'page') return null
    return (
      <PanelShell gateway={gateway} t={t} extraCss={SETTINGS_CSS}>
        <SettingsPage form={form} onOpenMemoryPage={(target) => { openMemoryPage(ctx, nav, target) }} />
      </PanelShell>
    )
  }
}

export function applySettings(ctx: HostContext, nav: NavStore, bind: BindGateway, useTranslate: () => Translate): void {
  ctx.inject(['configForms'], (scope) => {
    const Card = createSettingsCard(ctx, scope.configForms, nav, bind, useTranslate)
    scope.slots.inject('plugins.bundle.config', () => scope.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME }, Card))
  })
}

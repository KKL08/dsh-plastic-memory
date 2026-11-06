/**
 * 各插槽根在公共样式（`PM_STYLES`）之外带的样式。每份样式常量只写自己模块的规则，在这里按插槽各拼一次。
 * 所有插槽根的 `<style>` 同处一个文档，类名是全局的；撞名测试按这张表认模块，新加的样式常量要登记进来。
 */
import { modelChangeCss } from './chat/model-change.tsx'
import { promoteInPlaceCss } from './chat/promote-in-place.tsx'
import { savedMemoriesCardCss } from './chat/SavedMemoriesCard.tsx'
import { statusBarCss } from './checkup/StatusBar.tsx'
import { titleControlsCss } from './checkup/TitleControls.tsx'
import { confirmCss } from './command/confirm.tsx'
import { memoryButtonCss } from './composer/MemoryButton.tsx'
import { deletedTabCss } from './deleted/DeletedTab.tsx'
import { groupsCss } from './library/groups.tsx'
import { libraryTabCss } from './library/LibraryTab.tsx'
import { sharedTabCss } from './library/shared.tsx'
import { memoryPageCss } from './MemoryPage.tsx'
import { editCss } from './pending/edit.tsx'
import { modelEditCss } from './pending/model-edit.tsx'
import { moveCss } from './pending/move.tsx'
import { pendingCss } from './pending/PendingTab.tsx'
import { controlsCss } from './settings/controls.tsx'
import { scenesCss } from './settings/Scenes.tsx'
import { settingsPageCss } from './settings/SettingsPage.tsx'
import { sidebarTabCss } from './sidebar/SidebarTab.tsx'
import { dismissButtonCss } from './ui/DismissButton.tsx'
import { healthBannerCss } from './ui/HealthBanner.tsx'
import { settingsCss } from './ui/Settings.tsx'

export const SLOT_STYLES = {
  page: {
    dismissButtonCss, memoryPageCss, titleControlsCss, statusBarCss, confirmCss, sharedTabCss, groupsCss, libraryTabCss,
    deletedTabCss, editCss, modelEditCss, moveCss, pendingCss,
  },
  sidebar: { confirmCss, promoteInPlaceCss, modelChangeCss, sidebarTabCss },
  chat: { confirmCss, promoteInPlaceCss, modelChangeCss, savedMemoriesCardCss },
  settings: { settingsCss, healthBannerCss, controlsCss, scenesCss, settingsPageCss },
  composer: { memoryButtonCss },
}

export const slotCss = (slot: keyof typeof SLOT_STYLES) => Object.values(SLOT_STYLES[slot]).join('')

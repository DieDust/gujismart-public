import { useEffect, useMemo, useRef, useState } from 'react'
import { lazy, Suspense, useLayoutEffect } from 'react'
import { Alert, Button, Dropdown, Input, Layout, Menu, Modal, Popover, Progress, Spin, Tooltip, message } from 'antd'
import {
  BookOutlined,
  CloseOutlined,
  DashboardOutlined,
  DownOutlined,
  FileOutlined,
  FileTextOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  FormatPainterOutlined,
  HomeOutlined,
  PlusOutlined,
  ReadOutlined,
  LeftOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  TagsOutlined
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import type { SettingsViewHandle } from './views/SettingsView'
import WelcomeView from './views/WelcomeView'
import { useFolderStore } from './stores/useFolderStore'
import { useDocumentStore } from './stores/useDocumentStore'
import { useOnboardingStore } from './stores/useOnboardingStore'
import { clampAiButtonPosition, clampFloatingPanelState, getDefaultFloatingPanelState } from './utils/floatingViewport'
import {
  loadAppWorkspace,
  saveAppWorkspace,
  type WorkspaceAppTab,
  type WorkspaceFoldersState,
  type WorkspaceTabGroup,
  type WorkspaceViewKey,
} from './utils/appWorkspace'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from './utils/shortcuts'
import type { AppUpdateInfo, BackgroundTaskProgressEvent, DatabaseStorageDiagnostics, ImportSelection, LibraryAiOpenPayload, LibraryAiScope, LibraryAiTab, LibraryFilter, LibraryProject, OpenDocumentTarget, SettingsMap } from '@shared/types'
import { DEFAULT_LIBRARY_PROJECT_ID, PRODUCT_NAME } from '@shared/types'
import './styles/app.css'

const { Sider, Content, Header } = Layout

type ViewKey = 'welcome' | 'library' | 'folders' | 'settings' | 'dashboard' | 'search' | 'citation' | 'tags' | 'research' | 'excerpts'
type AppViewKey = WorkspaceViewKey
type MenuItem = Required<MenuProps>['items'][number]
type DatabaseUpgradePhase = 'idle' | 'precompact' | 'cleanup' | 'compact'
type TabDropPosition = 'before' | 'after'
type TabDropIntent = 'reorder' | 'group' | 'join-group'
type AppTabStripTargetType = 'tab' | 'group'
type AppTabDensity = 'normal' | 'compact' | 'tight' | 'icon'
type AppTabPointerDrag = {
  tabId: string
  pointerId: number
  startClientX: number
  startClientY: number
  clientX: number
  grabOffsetX: number
  width: number
  height: number
  top: number
  moved: boolean
  previewElement: HTMLElement | null
  forceGroupModifier: boolean
  /** Strip-level target: ungrouped tab or whole group segment. */
  targetType: AppTabStripTargetType | null
  targetId: string | null
  targetDropPosition: TabDropPosition | null
  targetDropIntent: TabDropIntent | null
  /** Last DOM highlight key to avoid redundant classList work. */
  highlightKey: string | null
}
type AppTabGroupDragTarget = {
  type: 'tab' | 'group'
  id: string
  position: TabDropPosition
}
type AppTabGroupPointerDrag = {
  groupId: string
  pointerId: number
  startClientX: number
  startClientY: number
  clientX: number
  grabOffsetX: number
  width: number
  height: number
  top: number
  moved: boolean
  previewElement: HTMLElement | null
  target: AppTabGroupDragTarget | null
}
type OpenDocumentDisposition = 'current-tab' | 'new-foreground-tab'
type OpenDocumentOptions = {
  disposition?: OpenDocumentDisposition
  title?: string
}
type OpenDocumentHandler = (target: OpenDocumentTarget | string, options?: OpenDocumentOptions) => void
type LibraryDroppedImportRequest = {
  id: number
  selection: ImportSelection
  folderId?: string | null
}
type FoldersViewState = WorkspaceFoldersState
type AppTab = WorkspaceAppTab
type AppTabStripItem =
  | { type: 'group'; group: WorkspaceTabGroup; tabs: AppTab[]; tabCount: number; active: boolean }
  | { type: 'tab'; tab: AppTab }
type AppTabDensityMetrics = {
  gap: number
  groupChipWidth: number
  groupHorizontalPadding: number
  stripHorizontalPadding: number
  tabMaxWidth: number
}
type ClosedAppTabItem =
  | { type: 'tab'; tab: AppTab; group?: WorkspaceTabGroup; closedAt: number }
  | { type: 'group'; group: WorkspaceTabGroup; tabs: AppTab[]; activeTabId?: string; closedAt: number }

const AiPanel = lazy(() => import('./components/AiPanel'))
const OnboardingWizard = lazy(() => import('./components/OnboardingWizard'))
const CitationView = lazy(() => import('./views/CitationView'))
const DashboardView = lazy(() => import('./views/DashboardView'))
const DocumentView = lazy(() => import('./views/DocumentView'))
const ExcerptsView = lazy(() => import('./views/ExcerptsView'))
const FoldersView = lazy(() => import('./views/FoldersView'))
const LibraryView = lazy(() => import('./views/LibraryView'))
const ResearchView = lazy(() => import('./views/ResearchView'))
const SearchView = lazy(() => import('./views/SearchView'))
const SettingsView = lazy(() => import('./views/SettingsView'))
const TagsView = lazy(() => import('./views/TagsView'))

function ViewLoadingFallback() {
  return (
    <div style={{ minHeight: 240, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin />
    </div>
  )
}

function getUpdateNoticeStorageKey(info: AppUpdateInfo): string {
  return `gujismart:update-notice:${info.latestVersion}`
}

const ONBOARDING_STEP_KEYS = ['welcome', 'paddle_ocr', 'ai_model', 'vision_ocr', 'finish']
const ONBOARDING_SETTINGS_LOAD_TIMEOUT_MS = 3000
const ONBOARDING_SETTINGS_TIMEOUT = Symbol('onboarding-settings-timeout')
const DATABASE_UPGRADE_UI_SETTLE_MS = 50
const MIN_NOTICEABLE_FREELIST_BYTES = 8 * 1024 * 1024
const LARGE_FREELIST_BYTES = 64 * 1024 * 1024
const FREELIST_RATIO_RECOMMEND_THRESHOLD = 0.1
const HOME_TAB_ID = 'home'
const TAB_DRAG_ACTIVATION_DISTANCE = 4
/** Default group zone is the middle 50%; left/right 25% stay reorder-only. Shift/Alt expands to 100%. */
const TAB_GROUP_ZONE_SIDE_RATIO = 0.25
const TAB_GROUP_CREATE_EFFECT_MS = 700
const TAB_PREFERRED_WIDTH = 210
const TAB_GROUP_CHIP_WIDTH = 96
const TAB_COMPACT_SLOT_WIDTH = 118
const TAB_TIGHT_SLOT_WIDTH = 74
const TAB_ICON_SLOT_WIDTH = 46
const TAB_STRIP_GAP = 6
const TAB_STRIP_HORIZONTAL_PADDING = 16
const TAB_GROUP_HORIZONTAL_PADDING = 8
const MAX_CLOSED_TAB_HISTORY = 20
const SINGLETON_VIEW_KEYS = new Set<AppViewKey>(['library', 'excerpts', 'citation', 'tags', 'dashboard', 'settings'])
const MULTI_INSTANCE_VIEW_KEYS = new Set<AppViewKey>(['folders', 'search', 'research'])
const VIEW_TITLES: Record<AppViewKey, string> = {
  library: '文献库',
  folders: '文件夹',
  settings: '设置',
  dashboard: '处理队列',
  search: '检索',
  citation: '引用格式',
  tags: '标签',
  research: '研究',
  excerpts: '摘录',
}
const TAB_GROUP_COLORS = [
  '#d4ad84',
  '#7cb7ff',
  '#81c784',
  '#f6c85f',
  '#f28b82',
  '#b39ddb',
  '#4dd0e1',
  '#ffab91',
]

function createHomeTab(): AppTab {
  return { id: HOME_TAB_ID, kind: 'home', title: '首页' }
}

function createTabGroupId(): string {
  return `tab-group:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

function isForceGroupModifierActive(event: { shiftKey?: boolean; altKey?: boolean } | null | undefined): boolean {
  return !!(event?.shiftKey || event?.altKey)
}

/** Middle 50% of the target tab creates a group; Shift/Alt makes the full tab a group zone. */
function isTabGroupDropZone(sampleX: number, bounds: DOMRect, forceFullZone: boolean): boolean {
  if (sampleX < bounds.left || sampleX > bounds.right) return false
  if (forceFullZone) return true
  const width = Math.max(1, bounds.width)
  const ratio = (sampleX - bounds.left) / width
  return ratio >= TAB_GROUP_ZONE_SIDE_RATIO && ratio <= (1 - TAB_GROUP_ZONE_SIDE_RATIO)
}

function getDefaultTabGroupTitle(index: number): string {
  return `分组 ${index + 1}`
}

function isDefaultTabGroupTitle(value: unknown): boolean {
  return /^分组\s*\d+$/.test(String(value || '').trim())
}

function getDefaultTabGroupColor(index: number): string {
  return TAB_GROUP_COLORS[index % TAB_GROUP_COLORS.length]
}

function getNextDefaultTabGroupIndex(tabGroups: WorkspaceTabGroup[]): number {
  const usedNumbers = new Set<number>()
  tabGroups.forEach((group) => {
    const match = String(group.title || '').trim().match(/^分组\s*(\d+)$/)
    const number = match ? Number(match[1]) : 0
    if (Number.isInteger(number) && number > 0) {
      usedNumbers.add(number)
    }
  })
  let nextNumber = 1
  while (usedNumbers.has(nextNumber)) nextNumber += 1
  return nextNumber - 1
}

function getTabGroupCreatedAt(group: WorkspaceTabGroup, fallbackIndex: number): number {
  const match = String(group.id || '').match(/^tab-group:(\d+):/)
  const createdAt = match ? Number(match[1]) : NaN
  return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER + fallbackIndex
}

function repairDefaultTabGroupTitlesByCreationOrder(tabGroups: WorkspaceTabGroup[]): WorkspaceTabGroup[] {
  const indexedGroups = tabGroups.map((group, index) => ({ group, index }))
  const defaultGroups = indexedGroups.filter(({ group }) => isDefaultTabGroupTitle(group.title))
  if (defaultGroups.length < 2) return tabGroups

  const repairedTitles = new Map<string, string>()
  defaultGroups
    .sort((left, right) => (
      getTabGroupCreatedAt(left.group, left.index) - getTabGroupCreatedAt(right.group, right.index)
      || left.index - right.index
    ))
    .forEach(({ group }, index) => {
      repairedTitles.set(group.id, getDefaultTabGroupTitle(index))
    })

  let changed = false
  const repairedGroups = tabGroups.map((group) => {
    const title = repairedTitles.get(group.id)
    if (!title || group.title === title) return group
    changed = true
    return { ...group, title }
  })

  return changed ? repairedGroups : tabGroups
}

function createDefaultTabGroup(currentGroups: WorkspaceTabGroup[], groupId: string, nextTabs?: AppTab[]): WorkspaceTabGroup {
  const activeGroups = nextTabs ? pruneTabGroupsForTabs(currentGroups, nextTabs) : currentGroups
  const nextIndex = getNextDefaultTabGroupIndex(activeGroups)
  return {
    id: groupId,
    title: getDefaultTabGroupTitle(nextIndex),
    color: getDefaultTabGroupColor(nextIndex),
    collapsed: false,
  }
}

function pruneTabGroupsForTabs(tabGroups: WorkspaceTabGroup[], nextTabs: AppTab[]): WorkspaceTabGroup[] {
  const usedGroupIds = new Set(nextTabs.map((tab) => tab.groupId).filter(Boolean))
  return tabGroups.filter((group) => usedGroupIds.has(group.id))
}

function assignTabToGroupInTabs(current: AppTab[], tabId: string, groupId: string, appendToGroup = false): AppTab[] {
  const source = current.find((tab) => tab.id === tabId)
  if (!source) return current
  const nextSource = { ...source, groupId }
  if (!appendToGroup) {
    return current.map((tab) => (tab.id === tabId ? nextSource : tab))
  }

  const withoutSource = current.filter((tab) => tab.id !== tabId)
  const lastGroupIndex = withoutSource.reduce((lastIndex, tab, index) => (
    tab.groupId === groupId ? index : lastIndex
  ), -1)
  const insertIndex = lastGroupIndex >= 0 ? lastGroupIndex + 1 : withoutSource.length
  return [
    ...withoutSource.slice(0, insertIndex),
    nextSource,
    ...withoutSource.slice(insertIndex),
  ]
}

function appendTabWithGroupContext(current: AppTab[], tab: AppTab): AppTab[] {
  if (!tab.groupId) return [...current, tab]
  const lastGroupIndex = current.reduce((lastIndex, item, index) => (
    item.groupId === tab.groupId ? index : lastIndex
  ), -1)
  if (lastGroupIndex < 0) return [...current, tab]
  return [
    ...current.slice(0, lastGroupIndex + 1),
    tab,
    ...current.slice(lastGroupIndex + 1),
  ]
}

function normalizeOpenDocumentTarget(target: OpenDocumentTarget | string): OpenDocumentTarget {
  return typeof target === 'string' ? { docId: target } : target
}

function getDocumentTabTitle(target: OpenDocumentTarget, explicitTitle?: string): string {
  const title = String(explicitTitle || target.sourceLabel || target.keyword || '').trim()
  return title || '文献'
}

function getViewIcon(view: AppViewKey) {
  switch (view) {
    case 'library':
      return <BookOutlined />
    case 'folders':
      return <FolderOpenOutlined />
    case 'research':
      return <ReadOutlined />
    case 'excerpts':
      return <FileTextOutlined />
    case 'search':
      return <FileSearchOutlined />
    case 'citation':
      return <FormatPainterOutlined />
    case 'tags':
      return <TagsOutlined />
    case 'dashboard':
      return <DashboardOutlined />
    case 'settings':
      return <SettingOutlined />
    default:
      return <FileOutlined />
  }
}

function getTabIcon(tab: AppTab) {
  if (tab.kind === 'home') return <HomeOutlined />
  if (tab.kind === 'document') return <FileOutlined />
  return getViewIcon(tab.view)
}

function getTabDensityForSlot(slotWidth: number): AppTabDensity {
  if (slotWidth <= TAB_ICON_SLOT_WIDTH) return 'icon'
  if (slotWidth <= TAB_TIGHT_SLOT_WIDTH) return 'tight'
  if (slotWidth <= TAB_COMPACT_SLOT_WIDTH) return 'compact'
  return 'normal'
}

function getTabDensityMetrics(density: AppTabDensity): AppTabDensityMetrics {
  if (density === 'icon') {
    return {
      gap: 2,
      groupChipWidth: 34,
      groupHorizontalPadding: 6,
      stripHorizontalPadding: 8,
      tabMaxWidth: 42,
    }
  }
  if (density === 'tight') {
    return {
      gap: 3,
      groupChipWidth: 58,
      groupHorizontalPadding: 6,
      stripHorizontalPadding: TAB_STRIP_HORIZONTAL_PADDING,
      tabMaxWidth: TAB_TIGHT_SLOT_WIDTH,
    }
  }
  if (density === 'compact') {
    return {
      gap: 4,
      groupChipWidth: 78,
      groupHorizontalPadding: TAB_GROUP_HORIZONTAL_PADDING,
      stripHorizontalPadding: TAB_STRIP_HORIZONTAL_PADDING,
      tabMaxWidth: TAB_COMPACT_SLOT_WIDTH,
    }
  }
  return {
    gap: TAB_STRIP_GAP,
    groupChipWidth: TAB_GROUP_CHIP_WIDTH,
    groupHorizontalPadding: TAB_GROUP_HORIZONTAL_PADDING,
    stripHorizontalPadding: TAB_STRIP_HORIZONTAL_PADDING,
    tabMaxWidth: TAB_PREFERRED_WIDTH,
  }
}

function calculateTabSlotWidth(
  stripWidth: number,
  density: AppTabDensity,
  visibleTabCount: number,
  tabStripGroupCount: number,
  visibleTabUnitCount: number,
): number {
  const metrics = getTabDensityMetrics(density)
  if (visibleTabCount <= 0) return metrics.tabMaxWidth
  const gapTotal = Math.max(0, visibleTabUnitCount - 1) * metrics.gap
  const groupReserve = tabStripGroupCount * (
    metrics.groupChipWidth + metrics.groupHorizontalPadding
  )
  const usableForTabs = Math.max(
    0,
    stripWidth
      - metrics.stripHorizontalPadding
      - gapTotal
      - groupReserve,
  )
  return Math.max(0, Math.min(metrics.tabMaxWidth, usableForTabs / visibleTabCount))
}

function getExpandedTabGroupWidth(
  tabCount: number,
  tabSlotWidth: number,
  density: AppTabDensity,
): number {
  const metrics = getTabDensityMetrics(density)
  return (
    metrics.groupChipWidth
    + metrics.groupHorizontalPadding
    + tabCount * tabSlotWidth
    + tabCount * metrics.gap
  )
}

function reorderAppTabs(current: AppTab[], sourceId: string, targetId: string, position: TabDropPosition): AppTab[] {
  if (!sourceId || sourceId === targetId) return current
  const sourceIndex = current.findIndex((tab) => tab.id === sourceId)
  if (sourceIndex < 0) return current

  const next = [...current]
  const [source] = next.splice(sourceIndex, 1)
  const targetIndex = next.findIndex((tab) => tab.id === targetId)
  if (!source || targetIndex < 0) return current
  next.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, source)
  return next.every((tab, index) => tab === current[index]) ? current : next
}

/** Reorder a single tab relative to another tab or an entire group block (before first / after last). */
function reorderAppTabToStripTarget(
  current: AppTab[],
  sourceId: string,
  target: { type: AppTabStripTargetType; id: string; position: TabDropPosition },
): AppTab[] {
  if (target.type === 'tab') {
    return reorderAppTabs(current, sourceId, target.id, target.position)
  }
  if (!sourceId || !target.id) return current
  const sourceIndex = current.findIndex((tab) => tab.id === sourceId)
  if (sourceIndex < 0) return current
  const next = [...current]
  const [source] = next.splice(sourceIndex, 1)
  if (!source) return current
  const groupIndexes = next
    .map((tab, index) => (tab.groupId === target.id ? index : -1))
    .filter((index) => index >= 0)
  if (groupIndexes.length === 0) return current
  const insertIndex = target.position === 'before'
    ? Math.min(...groupIndexes)
    : Math.max(...groupIndexes) + 1
  // Placing before/after a group block always leaves the tab outside groups.
  const placed = source.groupId ? { ...source, groupId: undefined } : source
  next.splice(insertIndex, 0, placed)
  return next.every((tab, index) => tab.id === current[index]?.id && tab.groupId === current[index]?.groupId)
    ? current
    : next
}

function reorderAppTabGroup(
  current: AppTab[],
  sourceGroupId: string,
  target: AppTabGroupDragTarget,
): AppTab[] {
  if (!sourceGroupId) return current
  if (target.type === 'group' && target.id === sourceGroupId) return current
  const groupTabs = current.filter((tab) => tab.groupId === sourceGroupId)
  if (groupTabs.length === 0) return current

  const remainingTabs = current.filter((tab) => tab.groupId !== sourceGroupId)
  let targetIndex = -1
  if (target.type === 'group') {
    const targetIndexes = remainingTabs
      .map((tab, index) => tab.groupId === target.id ? index : -1)
      .filter((index) => index >= 0)
    if (targetIndexes.length === 0) return current
    targetIndex = target.position === 'before'
      ? Math.min(...targetIndexes)
      : Math.max(...targetIndexes) + 1
  } else {
    const tabIndex = remainingTabs.findIndex((tab) => tab.id === target.id)
    if (tabIndex < 0) return current
    targetIndex = target.position === 'before' ? tabIndex : tabIndex + 1
  }

  const next = [
    ...remainingTabs.slice(0, targetIndex),
    ...groupTabs,
    ...remainingTabs.slice(targetIndex),
  ]
  return next.every((tab, index) => tab === current[index]) ? current : next
}

function hasConfiguredText(value: unknown): boolean {
  return String(value || '').trim().length > 0
}

function getSettingsForOnboardingCheck(): Promise<SettingsMap | typeof ONBOARDING_SETTINGS_TIMEOUT> {
  return Promise.race([
    window.api.getAllSettings(),
    new Promise<typeof ONBOARDING_SETTINGS_TIMEOUT>((resolve) => {
      window.setTimeout(() => resolve(ONBOARDING_SETTINGS_TIMEOUT), ONBOARDING_SETTINGS_LOAD_TIMEOUT_MS)
    }),
  ])
}

function hasPaddleOcrConfig(settings: SettingsMap): boolean {
  return settings.paddleocr_api_key_configured === 'true'
}

function hasAiConfig(settings: SettingsMap): boolean {
  return settings.llm_api_key_configured === 'true'
    && hasConfiguredText(settings.llm_base_url)
    && hasConfiguredText(settings.llm_model)
}

function formatDatabaseUpgradeCount(value: unknown): string {
  const parsed = Number(value || 0)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)).toLocaleString() : '0'
}

function formatDatabaseUpgradeBytes(value: unknown): string {
  const bytes = Number(value || 0)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let current = bytes
  let index = 0
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024
    index += 1
  }
  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`
}

function formatDatabaseUpgradeSavedBytes(before?: number, after?: number): string {
  const saved = Number(before || 0) - Number(after || 0)
  return saved > 0 ? `，已释放 ${formatDatabaseUpgradeBytes(saved)}` : ''
}

function isDatabaseCompactionWorthwhile(diagnostics: DatabaseStorageDiagnostics | null): boolean {
  const freelistBytes = Number(diagnostics?.freelistBytes || 0)
  const databaseBytes = Number(diagnostics?.databaseBytes || 0)
  if (!Number.isFinite(freelistBytes) || freelistBytes <= 0) return false
  if (freelistBytes >= LARGE_FREELIST_BYTES) return true
  return freelistBytes >= MIN_NOTICEABLE_FREELIST_BYTES
    && freelistBytes >= Math.max(1, databaseBytes) * FREELIST_RATIO_RECOMMEND_THRESHOLD
}

function hasRequiredDatabaseMaintenance(diagnostics: DatabaseStorageDiagnostics | null): boolean {
  const reasons = diagnostics?.requiredMaintenance?.reasons || []
  return reasons.some((reason) => (
    reason === 'legacy-ngram-index'
    || reason === 'legacy-single-char-ngram'
    || reason === 'legacy-ngram-positions'
    || reason === 'enterprise-search-index'
    || reason === 'inline-page-payloads'
  ))
}

function waitForDatabaseUpgradeUi(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, DATABASE_UPGRADE_UI_SETTLE_MS)
  })
}

export default function App() {
  const initialWorkspaceRef = useRef<ReturnType<typeof loadAppWorkspace> | null>(null)
  if (!initialWorkspaceRef.current) {
    initialWorkspaceRef.current = loadAppWorkspace(window.localStorage)
  }
  const initialWorkspace = initialWorkspaceRef.current
  const [tabs, setTabs] = useState<AppTab[]>(() => initialWorkspace.tabs)
  const [tabGroups, setTabGroups] = useState<WorkspaceTabGroup[]>(() => repairDefaultTabGroupTitlesByCreationOrder(initialWorkspace.tabGroups))
  const [activeTabId, setActiveTabId] = useState(() => initialWorkspace.activeTabId)
  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [draggedTabGroupId, setDraggedTabGroupId] = useState<string | null>(null)
  const [justCreatedTabGroupId, setJustCreatedTabGroupId] = useState<string | null>(null)
  const justCreatedTabGroupTimerRef = useRef<number | null>(null)
  const tabDropIndicatorRef = useRef<HTMLDivElement | null>(null)
  const [closedTabHistory, setClosedTabHistory] = useState<ClosedAppTabItem[]>([])
  const [shortcuts, setShortcuts] = useState<ShortcutMap | null>(null)
  const [siderCollapsed, setSiderCollapsed] = useState(() => initialWorkspace.siderCollapsed)
  const [tabSearchKey, setTabSearchKey] = useState('')
  const [renamingTabGroupId, setRenamingTabGroupId] = useState<string | null>(null)
  const [renamingTabGroupTitle, setRenamingTabGroupTitle] = useState('')
  const [tabGroupSettingsOpenId, setTabGroupSettingsOpenId] = useState<string | null>(null)
  const [tabGroupSettingsTitle, setTabGroupSettingsTitle] = useState('')
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>({ type: 'all' })
  const [libraryFocusSection, setLibraryFocusSection] = useState<'tags' | 'folders' | 'smart' | undefined>(undefined)
  const [libraryAiOpen, setLibraryAiOpen] = useState(false)
  const [libraryImportRequest, setLibraryImportRequest] = useState(0)
  const [libraryDroppedImportRequest, setLibraryDroppedImportRequest] = useState<LibraryDroppedImportRequest | null>(null)
  const [libraryAiQuestion, setLibraryAiQuestion] = useState('')
  const [libraryAiScope, setLibraryAiScope] = useState<LibraryAiScope | undefined>(undefined)
  const [libraryAiScopeLabel, setLibraryAiScopeLabel] = useState('')
  const [libraryAiInitialTab, setLibraryAiInitialTab] = useState<LibraryAiTab>('qa')
  const [libraryAiResearchProjectId, setLibraryAiResearchProjectId] = useState<string | null>(null)
  const [activeResearchProjectId, setActiveResearchProjectId] = useState<string | null>(null)
  const [libraryProjects, setLibraryProjects] = useState<LibraryProject[]>([])
  const [activeLibraryProject, setActiveLibraryProject] = useState<LibraryProject | null>(null)
  const [workspaceProjectId, setWorkspaceProjectId] = useState<string | null>(null)
  const [libraryProjectLoading, setLibraryProjectLoading] = useState(true)
  const [libraryProjectError, setLibraryProjectError] = useState('')
  const [libraryProjectSwitching, setLibraryProjectSwitching] = useState(false)
  const [libraryProjectCreateOpen, setLibraryProjectCreateOpen] = useState(false)
  const [libraryProjectCreateName, setLibraryProjectCreateName] = useState('')
  const [libraryProjectCreateBusy, setLibraryProjectCreateBusy] = useState(false)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [databaseUpgradeDiagnostics, setDatabaseUpgradeDiagnostics] = useState<DatabaseStorageDiagnostics | null>(null)
  const [databaseUpgradeVisible, setDatabaseUpgradeVisible] = useState(false)
  const [databaseUpgradeBusy, setDatabaseUpgradeBusy] = useState(false)
  const [databaseUpgradePhase, setDatabaseUpgradePhase] = useState<DatabaseUpgradePhase>('idle')
  const [databaseUpgradeProgress, setDatabaseUpgradeProgress] = useState<BackgroundTaskProgressEvent | null>(null)
  const [tabDensity, setTabDensity] = useState<AppTabDensity>('normal')
  const [tabSlotWidth, setTabSlotWidth] = useState(TAB_PREFERRED_WIDTH)
  const onboardingVisible = useOnboardingStore((state) => state.visible)
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) || tabs[0] || createHomeTab(), [activeTabId, tabs])
  const tabGroupsById = useMemo(() => new Map(tabGroups.map((group) => [group.id, group])), [tabGroups])
  const tabGroupTabCounts = useMemo(() => {
    const counts = new Map<string, number>()
    tabs.forEach((tab) => {
      if (!tab.groupId || !tabGroupsById.has(tab.groupId)) return
      counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1)
    })
    return counts
  }, [tabGroupsById, tabs])
  const tabStripItems = useMemo<AppTabStripItem[]>(() => {
    const items: AppTabStripItem[] = []
    const renderedGroupIds = new Set<string>()

    tabs.forEach((tab) => {
      const group = tab.groupId ? tabGroupsById.get(tab.groupId) : undefined
      if (group && !renderedGroupIds.has(group.id)) {
        const groupedTabs = tabs.filter((item) => item.groupId === group.id)
        items.push({
          type: 'group',
          group,
          tabs: groupedTabs,
          tabCount: tabGroupTabCounts.get(group.id) || 0,
          active: activeTab.groupId === group.id,
        })
        renderedGroupIds.add(group.id)
      }
      if (group) return
      items.push({ type: 'tab', tab })
    })

    return items
  }, [activeTab.groupId, tabGroupTabCounts, tabGroupsById, tabs])
  const visibleTabCount = tabStripItems.reduce((count, item) => (
    count + (item.type === 'tab' ? 1 : (item.group.collapsed ? 0 : item.tabs.length))
  ), 0)
  const tabStripGroupCount = tabStripItems.reduce((count, item) => count + (item.type === 'group' ? 1 : 0), 0)
  const collapsedTabGroupCount = tabStripItems.reduce((count, item) => (
    count + (item.type === 'group' && item.group.collapsed ? 1 : 0)
  ), 0)
  // Visual strip children: visible tabs + every group chip (collapsed chips still occupy a slot).
  const visibleTabUnitCount = visibleTabCount + tabStripGroupCount
  const inheritedTabGroupId = activeTab.groupId && tabGroupsById.has(activeTab.groupId)
    ? activeTab.groupId
    : undefined
  const activeViewKey: ViewKey = activeTab.kind === 'home'
    ? 'welcome'
    : activeTab.kind === 'view'
    ? activeTab.view
    : 'library'
  const activeDocumentTab = activeTab.kind === 'document' ? activeTab : null
  const showFloatingActions = activeTab.kind !== 'document' && !libraryAiOpen
  const selectedMenuKeys = activeTab.kind === 'view' ? [activeTab.view] : []
  // Ideal width must follow the collapsed strip: hidden group tabs do not reserve preferred width.
  const tabStripIdealWidth = (
    visibleTabCount * TAB_PREFERRED_WIDTH
    + tabStripGroupCount * TAB_GROUP_CHIP_WIDTH
    + Math.max(0, visibleTabUnitCount - 1) * TAB_STRIP_GAP
    + TAB_STRIP_HORIZONTAL_PADDING
    + tabStripGroupCount * TAB_GROUP_HORIZONTAL_PADDING
  )
  const filteredTabs = useMemo(() => {
    const keyword = tabSearchKey.trim().toLocaleLowerCase()
    if (!keyword) return tabs
    return tabs.filter((tab) => tab.title.toLocaleLowerCase().includes(keyword))
  }, [tabSearchKey, tabs])

  const loadLibraryProjectChoices = async (): Promise<void> => {
    setLibraryProjectLoading(true)
    setLibraryProjectError('')
    try {
      const [projects, activeProject] = await Promise.all([
        window.api.listLibraryProjects(),
        window.api.getActiveLibraryProject(),
      ])
      setLibraryProjects(projects)
      setActiveLibraryProject(activeProject)
    } catch (error) {
      setLibraryProjectError(error instanceof Error ? error.message : String(error))
    } finally {
      setLibraryProjectLoading(false)
    }
  }

  useEffect(() => {
    void loadLibraryProjectChoices()
  }, [])

  useEffect(() => {
    if (!workspaceProjectId) return
    saveAppWorkspace(window.localStorage, {
      tabs,
      tabGroups,
      activeTabId,
      siderCollapsed,
    }, workspaceProjectId)
  }, [activeTabId, siderCollapsed, tabGroups, tabs, workspaceProjectId])

  useEffect(() => {
    const saveBeforeUnload = () => {
      if (!workspaceProjectId) return
      saveAppWorkspace(window.localStorage, {
        tabs,
        tabGroups,
        activeTabId,
        siderCollapsed,
      }, workspaceProjectId)
    }
    window.addEventListener('beforeunload', saveBeforeUnload)
    return () => window.removeEventListener('beforeunload', saveBeforeUnload)
  }, [activeTabId, siderCollapsed, tabGroups, tabs, workspaceProjectId])

  const activateLibraryProject = async (project: LibraryProject): Promise<void> => {
    if (libraryProjectSwitching) return
    setLibraryProjectSwitching(true)
    try {
      if (workspaceProjectId) {
        saveAppWorkspace(window.localStorage, {
          tabs,
          tabGroups,
          activeTabId,
          siderCollapsed,
        }, workspaceProjectId)
      }
      const activated = await window.api.setActiveLibraryProject(project.id)
      useDocumentStore.getState().setDocuments([])
      useDocumentStore.getState().clearSelection()
      const workspace = loadAppWorkspace(window.localStorage, project.id, {
        migrateGlobalWorkspace: project.id === DEFAULT_LIBRARY_PROJECT_ID,
      })
      setTabs(workspace.tabs)
      setTabGroups(repairDefaultTabGroupTitlesByCreationOrder(workspace.tabGroups))
      setActiveTabId(workspace.activeTabId)
      setSiderCollapsed(workspace.siderCollapsed)
      setClosedTabHistory([])
      setLibraryFilter({ type: 'all' })
      setLibraryFocusSection(undefined)
      setLibraryAiOpen(false)
      setActiveResearchProjectId(null)
      setActiveLibraryProject(activated)
      setWorkspaceProjectId(activated.id)
      const refreshedProjects = await window.api.listLibraryProjects()
      setLibraryProjects(refreshedProjects)
    } catch (error) {
      message.error(`切换文献项目失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLibraryProjectSwitching(false)
    }
  }

  const confirmCreateLibraryProject = async (): Promise<void> => {
    const name = libraryProjectCreateName.trim()
    if (!name || libraryProjectCreateBusy) return
    setLibraryProjectCreateBusy(true)
    try {
      const project = await window.api.createLibraryProject({ name, activate: true })
      setLibraryProjectCreateOpen(false)
      setLibraryProjectCreateName('')
      await activateLibraryProject(project)
    } catch (error) {
      message.error(`新建文献项目失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLibraryProjectCreateBusy(false)
    }
  }

  const handleLibraryDocumentsMoved = (documentIds: string[]): void => {
    const movedIds = new Set(documentIds)
    setTabs((currentTabs) => {
      const nextTabs = currentTabs.filter((tab) => tab.kind !== 'document' || !movedIds.has(tab.document.docId))
      const safeTabs = nextTabs.length > 0 ? nextTabs : [createHomeTab()]
      if (!safeTabs.some((tab) => tab.id === activeTabId)) setActiveTabId(safeTabs[0].id)
      return safeTabs
    })
  }

  const settingsViewRef = useRef<SettingsViewHandle>(null)
  const floatingPanelRef = useRef<HTMLDivElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const suppressTabClickRef = useRef(false)
  const tabsRef = useRef(tabs)
  const tabPointerDragRef = useRef<AppTabPointerDrag | null>(null)
  const tabGroupPointerDragRef = useRef<AppTabGroupPointerDrag | null>(null)
  const tabPointerCleanupRef = useRef<(() => void) | null>(null)
  const tabDragFrameRef = useRef<number | null>(null)
  const pendingTabLayoutRef = useRef<Map<string, number> | null>(null)
  const tabReorderAnimationsRef = useRef<Map<string, Animation>>(new Map())
  const libraryDroppedImportSeqRef = useRef(0)
  const panelState = useRef({ x: 0, y: 0, w: 420, h: 600 })
  const draggingPanel = useRef(false)
  const resizingPanel = useRef<string | null>(null)
  const interactStart = useRef({ mouseX: 0, mouseY: 0, panelX: 0, panelY: 0, panelW: 0, panelH: 0 })
  const panelFrameRef = useRef<number | null>(null)
  const pendingPanelStyleRef = useRef<{ x: number; y: number; w?: number; h?: number } | null>(null)
  const aiButtonRef = useRef<HTMLDivElement>(null)
  const btnPosRef = useRef({ x: 0, y: 0 })
  const btnDragState = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    btnX: 0,
    btnY: 0,
    moved: false,
    timer: null as ReturnType<typeof setTimeout> | null
  })
  tabsRef.current = tabs

  useLayoutEffect(() => {
    const strip = tabStripRef.current
    if (!strip) return

    const measure = () => {
      if (visibleTabCount <= 0) {
        setTabDensity('normal')
        setTabSlotWidth(TAB_PREFERRED_WIDTH)
        return
      }
      // Choose density against the full-size chip budget to avoid oscillating
      // between normal and compact when compact chips release a little space.
      const normalSlotWidth = calculateTabSlotWidth(
        strip.clientWidth,
        'normal',
        visibleTabCount,
        tabStripGroupCount,
        visibleTabUnitCount,
      )
      const nextDensity = getTabDensityForSlot(normalSlotWidth)
      const nextSlotWidth = calculateTabSlotWidth(
        strip.clientWidth,
        nextDensity,
        visibleTabCount,
        tabStripGroupCount,
        visibleTabUnitCount,
      )
      setTabDensity((current) => current === nextDensity ? current : nextDensity)
      setTabSlotWidth((current) => (
        Math.abs(current - nextSlotWidth) < 0.25 ? current : nextSlotWidth
      ))
    }

    measure()
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(strip)
    const rail = strip.parentElement
    if (rail) resizeObserver.observe(rail)
    let resizeFrame: number | null = null
    let settledMeasureTimers: number[] = []
    const scheduleSettledMeasure = () => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null
        measure()
      })
      settledMeasureTimers.forEach((timer) => window.clearTimeout(timer))
      settledMeasureTimers = [60, 180, 360].map((delay) => window.setTimeout(measure, delay))
    }
    const handleWindowResize = () => {
      // A viewport change invalidates FLIP coordinates captured before the resize.
      pendingTabLayoutRef.current = null
      tabReorderAnimationsRef.current.forEach((animation) => animation.cancel())
      tabReorderAnimationsRef.current.clear()
      scheduleSettledMeasure()
    }
    window.addEventListener('resize', handleWindowResize)
    window.visualViewport?.addEventListener('resize', handleWindowResize)

    let resolutionMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const handleResolutionChange = () => {
      handleWindowResize()
      resolutionMedia.removeEventListener('change', handleResolutionChange)
      resolutionMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      resolutionMedia.addEventListener('change', handleResolutionChange)
    }
    resolutionMedia.addEventListener('change', handleResolutionChange)

    // Chromium can update display scale without emitting resize/ResizeObserver.
    // Comparing the scalar is cheap; layout work only runs when the DPI really changes.
    let observedDevicePixelRatio = window.devicePixelRatio
    const displayScaleMonitor = window.setInterval(() => {
      const nextDevicePixelRatio = window.devicePixelRatio
      if (Math.abs(nextDevicePixelRatio - observedDevicePixelRatio) < 0.001) return
      observedDevicePixelRatio = nextDevicePixelRatio
      handleWindowResize()
    }, 250)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', handleWindowResize)
      window.visualViewport?.removeEventListener('resize', handleWindowResize)
      resolutionMedia.removeEventListener('change', handleResolutionChange)
      window.clearInterval(displayScaleMonitor)
      settledMeasureTimers.forEach((timer) => window.clearTimeout(timer))
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame)
    }
  }, [collapsedTabGroupCount, siderCollapsed, tabStripGroupCount, visibleTabCount, visibleTabUnitCount])

  useEffect(() => {
    window.api.listFolders()
      .then((items) => {
        useFolderStore.getState().setFolders(items)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.checkForUpdates()
      .then((info) => {
        if (cancelled || !info.hasUpdate || !info.latestVersion) return
        const storageKey = getUpdateNoticeStorageKey(info)
        if (window.localStorage.getItem(storageKey) === 'true') return
        window.localStorage.setItem(storageKey, 'true')
        Modal.confirm({
          title: `发现新版本 ${info.latestVersion}`,
          content: `当前版本 ${info.currentVersion}，可以前往 GitHub Release 下载新版安装包或便携版。`,
          okText: '查看下载',
          cancelText: '稍后',
          onOk: () => {
            window.open(info.releaseUrl, '_blank', 'noopener,noreferrer')
          },
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const evaluateOnboarding = async () => {
      try {
        const [completed, settings] = await Promise.all([
          window.api.isOnboardingCompleted(),
          getSettingsForOnboardingCheck(),
        ])
        if (cancelled || completed) return
        if (settings === ONBOARDING_SETTINGS_TIMEOUT) return

        const hasCoreConfig = hasPaddleOcrConfig(settings) && hasAiConfig(settings)
        const store = useOnboardingStore.getState()
        if (hasCoreConfig) {
          store.completeSteps(ONBOARDING_STEP_KEYS)
          for (const stepKey of ONBOARDING_STEP_KEYS) {
            await window.api.completeOnboardingStep(stepKey)
          }
          return
        }

        store.open(0)
      } catch (error) {
        console.error('Failed to evaluate onboarding state', error)
      }
    }

    void evaluateOnboarding()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const evaluateDatabaseUpgrade = async () => {
      try {
        const diagnostics = await window.api.getDatabaseStorageDiagnostics()
        if (cancelled) return
        setDatabaseUpgradeDiagnostics(diagnostics)
        setDatabaseUpgradeVisible(hasRequiredDatabaseMaintenance(diagnostics))
      } catch (error) {
        console.warn('Failed to evaluate database upgrade state', error)
      }
    }

    void evaluateDatabaseUpgrade()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onBackgroundTaskStatusChanged((event) => {
      if (event.kind !== 'database-maintenance') return
      setDatabaseUpgradeProgress(event)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const messageKey = 'metadata-reclassification-progress'
    const unsubscribe = window.api.onMetadataReclassificationProgress((payload) => {
      if (payload.status === 'completed') {
        if (payload.failedCount > 0) {
          message.warning({
            key: messageKey,
            content: `元数据重新识别完成：成功 ${payload.successCount} 篇，失败 ${payload.failedCount} 篇`,
            duration: 6,
          })
        } else {
          message.success({
            key: messageKey,
            content: `元数据重新识别完成：已统一 ${payload.successCount} 篇文献`,
            duration: 4,
          })
        }
        return
      }

      const progressText = payload.totalCount > 0
        ? `（${payload.processedCount}/${payload.totalCount}）`
        : ''
      message.loading({
        key: messageKey,
        content: `正在重新识别元数据${progressText}`,
        duration: 0,
      })
    })
    return () => {
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    panelState.current = getDefaultFloatingPanelState()
    if (floatingPanelRef.current) {
      floatingPanelRef.current.style.transform = `translate(${panelState.current.x}px, ${panelState.current.y}px)`
      floatingPanelRef.current.style.width = `${panelState.current.w}px`
      floatingPanelRef.current.style.height = `${panelState.current.h}px`
    }
  }, [])

  useEffect(() => {
    const flushPanelStyle = () => {
      panelFrameRef.current = null
      const next = pendingPanelStyleRef.current
      const panel = floatingPanelRef.current
      if (!next || !panel) return
      panel.style.transform = `translate3d(${next.x}px, ${next.y}px, 0)`
      if (next.w != null) panel.style.width = `${next.w}px`
      if (next.h != null) panel.style.height = `${next.h}px`
      pendingPanelStyleRef.current = null
    }
    const schedulePanelStyle = (next: { x: number; y: number; w?: number; h?: number }) => {
      pendingPanelStyleRef.current = next
      if (panelFrameRef.current == null) panelFrameRef.current = window.requestAnimationFrame(flushPanelStyle)
    }
    const applyPanelState = (next: { x: number; y: number; w: number; h: number }) => {
      const clamped = clampFloatingPanelState(next)
      panelState.current = clamped
      schedulePanelStyle(clamped)
    }
    const applyButtonPosition = (next: { x: number; y: number }, scale = false) => {
      const clamped = clampAiButtonPosition(next)
      btnPosRef.current = clamped
      if (aiButtonRef.current) {
        aiButtonRef.current.style.transform = `translate(${clamped.x}px, ${clamped.y}px)${scale ? ' scale(1.05)' : ''}`
      }
    }
    const handlePanelMouseMove = (event: MouseEvent) => {
      if (!floatingPanelRef.current) return

      if (draggingPanel.current) {
        const dx = event.clientX - interactStart.current.mouseX
        const dy = event.clientY - interactStart.current.mouseY
        const newX = interactStart.current.panelX + dx
        const newY = interactStart.current.panelY + dy
        applyPanelState({ ...panelState.current, x: newX, y: newY })
      } else if (resizingPanel.current) {
        const dx = event.clientX - interactStart.current.mouseX
        const dy = event.clientY - interactStart.current.mouseY
        let { panelX, panelY, panelW, panelH } = interactStart.current
        const dir = resizingPanel.current

        if (dir.includes('e')) panelW = Math.max(320, panelW + dx)
        if (dir.includes('s')) panelH = Math.max(400, panelH + dy)
        if (dir.includes('w')) {
          const newW = Math.max(320, panelW - dx)
          if (newW > 320) {
            panelW = newW
            panelX += dx
          }
        }
        if (dir.includes('n')) {
          const newH = Math.max(400, panelH - dy)
          if (newH > 400) {
            panelH = newH
            panelY += dy
          }
        }

        applyPanelState({ x: panelX, y: panelY, w: panelW, h: panelH })
      }

      if (btnDragState.current.isDragging && aiButtonRef.current) {
        btnDragState.current.moved = true
        const dx = event.clientX - btnDragState.current.startX
        const dy = event.clientY - btnDragState.current.startY
        const newX = btnDragState.current.btnX + dx
        const newY = btnDragState.current.btnY + dy
        applyButtonPosition({ x: newX, y: newY }, true)
      }
    }

    const handlePanelMouseUp = () => {
      if (draggingPanel.current || resizingPanel.current) {
        draggingPanel.current = false
        resizingPanel.current = null
        document.body.style.cursor = ''
      }

      if (btnDragState.current.timer != null) {
        clearTimeout(btnDragState.current.timer)
        btnDragState.current.timer = null
      }

      if (btnDragState.current.isDragging) {
        btnDragState.current.isDragging = false
        if (aiButtonRef.current) aiButtonRef.current.style.transition = ''
        applyButtonPosition(btnPosRef.current)
        document.body.style.cursor = ''
        setTimeout(() => {
          btnDragState.current.moved = false
        }, 50)
      }
    }

    const handleViewportResize = () => {
      applyPanelState(panelState.current)
      applyButtonPosition(btnPosRef.current)
    }

    document.addEventListener('mousemove', handlePanelMouseMove)
    document.addEventListener('mouseup', handlePanelMouseUp)
    window.addEventListener('resize', handleViewportResize)
    return () => {
      if (panelFrameRef.current != null) window.cancelAnimationFrame(panelFrameRef.current)
      pendingPanelStyleRef.current = null
      document.removeEventListener('mousemove', handlePanelMouseMove)
      document.removeEventListener('mouseup', handlePanelMouseUp)
      window.removeEventListener('resize', handleViewportResize)
    }
  }, [])

  const menuItems: MenuItem[] = useMemo(() => ([
    { key: 'library', icon: <BookOutlined />, label: '文献库' },
    { key: 'folders', icon: <FolderOpenOutlined />, label: '文件夹' },
    { key: 'research', icon: <ReadOutlined />, label: '研究' },
    { key: 'excerpts', icon: <FileTextOutlined />, label: '摘录' },
    { key: 'search', icon: <FileSearchOutlined />, label: '检索' },
    { key: 'citation', icon: <FormatPainterOutlined />, label: '引用格式' },
    { key: 'tags', icon: <TagsOutlined />, label: '标签' },
    { type: 'divider' },
    { key: 'dashboard', icon: <DashboardOutlined />, label: '处理队列' },
    { key: 'settings', icon: <SettingOutlined />, label: '设置' }
  ]), [])

  const runWithSettingsLeaveGuard = (next: () => void) => {
    if (activeTab.kind !== 'view' || activeTab.view !== 'settings' || !settingsDirty) {
      next()
      return
    }

    Modal.confirm({
      title: '您的设置已更改，是否保存？',
      content: '保存后会应用当前设置；不保存将放弃本次未保存的更改。',
      okText: '保存并离开',
      cancelText: '不保存',
      centered: true,
      onOk: async () => {
        const saved = await settingsViewRef.current?.save()
        if (!saved) return Promise.reject()
        setSettingsDirty(false)
        next()
      },
      onCancel: () => {
        setSettingsDirty(false)
        next()
      },
    })
  }

  const ensureHomeTab = () => {
    runWithSettingsLeaveGuard(() => {
      const nextGroupId = inheritedTabGroupId
      setTabs((current) => {
        const existingHome = current.find((tab) => tab.id === HOME_TAB_ID)
        if (existingHome) {
          return nextGroupId
            ? assignTabToGroupInTabs(current, HOME_TAB_ID, nextGroupId, true)
            : current
        }
        const nextHomeTab = nextGroupId ? { ...createHomeTab(), groupId: nextGroupId } : createHomeTab()
        return nextGroupId ? appendTabWithGroupContext(current, nextHomeTab) : [nextHomeTab, ...current]
      })
      expandTabGroup(nextGroupId)
      setActiveTabId(HOME_TAB_ID)
    })
  }

  const openViewTab = (
    view: AppViewKey,
    options: { forceNew?: boolean; foldersState?: FoldersViewState | null; initialSearchKeyword?: string } = {},
  ) => {
    runWithSettingsLeaveGuard(() => {
      const nextGroupId = inheritedTabGroupId
      const singleton = SINGLETON_VIEW_KEYS.has(view) && !options.forceNew
      if (singleton) {
        const tabId = `view:${view}`
        setTabs((current) => {
          if (current.some((tab) => tab.id === tabId)) {
            return nextGroupId
              ? assignTabToGroupInTabs(current, tabId, nextGroupId, true)
              : current
          }
          const nextTab: AppTab = {
            id: tabId,
            kind: 'view',
            view,
            title: VIEW_TITLES[view],
            singleton: true,
            groupId: nextGroupId,
          }
          return appendTabWithGroupContext(current, nextTab)
        })
        expandTabGroup(nextGroupId)
        setActiveTabId(tabId)
        return
      }

      const tabId = `view:${view}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
      const title = view === 'search' && options.initialSearchKeyword
        ? `检索：${options.initialSearchKeyword}`
        : VIEW_TITLES[view]
      const nextTab: AppTab = {
        id: tabId,
        kind: 'view',
        view,
        title,
        singleton,
        foldersState: view === 'folders' ? options.foldersState || null : undefined,
        initialSearchKeyword: view === 'search' ? options.initialSearchKeyword || '' : undefined,
        groupId: nextGroupId,
      }
      setTabs((current) => appendTabWithGroupContext(current, nextTab))
      expandTabGroup(nextGroupId)
      setActiveTabId(tabId)
    })
  }

  const focusOrCreateLibraryTab = () => {
    const tabId = 'view:library'
    const nextGroupId = inheritedTabGroupId
    setTabs((current) => {
      if (current.some((tab) => tab.id === tabId)) {
        return nextGroupId
          ? assignTabToGroupInTabs(current, tabId, nextGroupId, true)
          : current
      }
      const nextTab: AppTab = {
        id: tabId,
        kind: 'view',
        view: 'library',
        title: VIEW_TITLES.library,
        singleton: true,
        groupId: nextGroupId,
      }
      return appendTabWithGroupContext(current, nextTab)
    })
    expandTabGroup(nextGroupId)
    setActiveTabId(tabId)
  }

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    const view = key as AppViewKey
    if (activeTab.kind === 'view' && activeTab.view === view && SINGLETON_VIEW_KEYS.has(view)) return
    if (view === 'library') setLibraryFocusSection(undefined)
    openViewTab(view, { forceNew: MULTI_INSTANCE_VIEW_KEYS.has(view) })
  }

  const handleImport = () => {
    runWithSettingsLeaveGuard(() => {
      focusOrCreateLibraryTab()
      setLibraryFilter({ type: 'all' })
      setLibraryFocusSection(undefined)
      setLibraryImportRequest((value) => value + 1)
    })
  }

  const focusLibraryForImport = (nextFilter: LibraryFilter, focusSection?: 'tags' | 'folders' | 'smart') => {
    runWithSettingsLeaveGuard(() => {
      focusOrCreateLibraryTab()
      setLibraryFocusSection(focusSection)
      setLibraryFilter(nextFilter)
    })
  }

  useEffect(() => {
    const handleOnboardingAction = (event: Event) => {
      const detail = (event as CustomEvent<{ action?: string }>).detail
      if (detail?.action === 'open-library-import') {
        void handleImport()
        return
      }
      if (detail?.action === 'open-settings') {
        openViewTab('settings')
      }
    }

    window.addEventListener('gujismart:onboarding-action', handleOnboardingAction)
    return () => window.removeEventListener('gujismart:onboarding-action', handleOnboardingAction)
  }, [handleImport, runWithSettingsLeaveGuard])

  const handleDroppedImport = (selection: ImportSelection, folderId?: string | null) => {
    runWithSettingsLeaveGuard(() => {
      focusOrCreateLibraryTab()
      setLibraryFilter(folderId ? { type: 'folder', value: folderId } : { type: 'all' })
      setLibraryFocusSection(folderId ? 'folders' : undefined)
      setLibraryDroppedImportRequest({
        id: libraryDroppedImportSeqRef.current += 1,
        selection,
        folderId: folderId || null,
      })
    })
  }

  const openLibraryWithFilter = (nextFilter: LibraryFilter, focusSection: 'tags' | 'folders' | 'smart' = 'tags') => {
    focusLibraryForImport(nextFilter, focusSection)
  }

  const openLibraryAi = (payload?: string | LibraryAiOpenPayload) => {
    const normalized = typeof payload === 'string' ? { question: payload } : (payload || {})
    setLibraryAiQuestion(normalized.question || '')
    setLibraryAiScope(normalized.scope)
    setLibraryAiScopeLabel(normalized.scopeLabel || '')
    setLibraryAiInitialTab(normalized.initialTab || 'qa')
    setLibraryAiResearchProjectId(normalized.researchProjectId || null)
    setLibraryAiOpen(true)
  }

  const refreshDocumentTabTitle = (tabId: string, docId: string) => {
    // Light detail only — full getDocument hydrates every page OCR payload.
    void window.api.getDocumentLight(docId)
      .then((document) => {
        const nextTitle = String(document?.title || '').trim()
        if (!nextTitle) return
        setTabs((current) => current.map((tab) => (
          tab.id === tabId && tab.kind === 'document'
            ? { ...tab, title: nextTitle }
            : tab
        )))
      })
      .catch(() => {})
  }

  const openDocumentTarget: OpenDocumentHandler = (target, options = {}) => {
    const normalized = normalizeOpenDocumentTarget(target)
    const title = getDocumentTabTitle(normalized, options.title)
    const explicitPageIndex = normalized.locator?.pageIndex ?? normalized.pageIndex
    const documentTarget: OpenDocumentTarget = {
      ...normalized,
      pageIndex: Math.max(0, explicitPageIndex ?? 0),
    }
    const disposition = options.disposition
      || (activeDocumentTab?.document.docId === normalized.docId ? 'current-tab' : 'new-foreground-tab')
    const nextGroupId = inheritedTabGroupId

    if (disposition === 'current-tab' && activeDocumentTab) {
      setTabs((current) => current.map((tab) => (
        tab.id === activeDocumentTab.id
          ? { ...tab, title, document: { docId: normalized.docId, target: documentTarget } }
          : tab
      )))
      refreshDocumentTabTitle(activeDocumentTab.id, normalized.docId)
      return
    }

    const tabId = `doc:${normalized.docId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const nextTab: AppTab = {
      id: tabId,
      kind: 'document',
      title,
      document: {
        docId: normalized.docId,
        target: documentTarget,
      },
      groupId: nextGroupId,
    }
    setTabs((current) => appendTabWithGroupContext(current, nextTab))
    expandTabGroup(nextGroupId)
    setActiveTabId(tabId)
    refreshDocumentTabTitle(tabId, normalized.docId)
  }

  const openDocumentFromFolders = (target: OpenDocumentTarget | string, state: FoldersViewState) => {
    setTabs((current) => current.map((tab) => (
      tab.id === activeTabId && tab.kind === 'view' && tab.view === 'folders'
        ? { ...tab, title: state.selectedFolderName || VIEW_TITLES.folders, foldersState: state }
        : tab
    )))
    openDocumentTarget(target, { disposition: 'new-foreground-tab' })
  }

  const handleFoldersStateChange = (state: FoldersViewState) => {
    setTabs((current) => current.map((tab) => (
      tab.id === activeTabId && tab.kind === 'view' && tab.view === 'folders'
        ? { ...tab, title: state.selectedFolderName || VIEW_TITLES.folders, foldersState: state }
        : tab
    )))
  }

  const expandTabGroup = (groupId?: string) => {
    if (!groupId) return
    setTabGroups((current) => current.map((group) => (
      group.id === groupId && group.collapsed
        ? { ...group, collapsed: false }
        : group
    )))
  }

  const revealTabGroup = (tab: AppTab) => {
    expandTabGroup(tab.groupId)
  }

  const rememberClosedItems = (items: ClosedAppTabItem[]) => {
    if (items.length === 0) return
    setClosedTabHistory((current) => [
      ...items,
      ...current,
    ].slice(0, MAX_CLOSED_TAB_HISTORY))
  }

  const buildClosedItems = (currentTabs: AppTab[], closedTabs: AppTab[]): ClosedAppTabItem[] => {
    const closedIds = new Set(closedTabs.map((tab) => tab.id))
    const groupedIds = new Set<string>()
    const closedAt = Date.now()
    const items: ClosedAppTabItem[] = []

    tabGroups.forEach((group) => {
      const groupTabs = currentTabs.filter((tab) => tab.groupId === group.id)
      if (groupTabs.length === 0 || !groupTabs.every((tab) => closedIds.has(tab.id))) return
      groupTabs.forEach((tab) => groupedIds.add(tab.id))
      items.push({
        type: 'group',
        group,
        tabs: groupTabs,
        activeTabId: groupTabs.some((tab) => tab.id === activeTabId) ? activeTabId : groupTabs[0]?.id,
        closedAt,
      })
    })

    closedTabs.forEach((tab) => {
      if (groupedIds.has(tab.id)) return
      const group = tab.groupId ? tabGroupsById.get(tab.groupId) : undefined
      items.push({ type: 'tab', tab, group, closedAt })
    })

    return items.reverse()
  }

  const reopenClosedItem = () => {
    const [item] = closedTabHistory
    if (!item) return
    setClosedTabHistory((current) => current.slice(1))

    if (item.type === 'group') {
      setTabGroups((current) => (
        current.some((group) => group.id === item.group.id)
          ? current
          : pruneTabGroupsForTabs([...current, item.group], [...tabsRef.current, ...item.tabs])
      ))
      setTabs((current) => {
        const existingIds = new Set(current.map((tab) => tab.id))
        const nextTabs = item.tabs.filter((tab) => !existingIds.has(tab.id))
        if (nextTabs.length === 0) return current
        return [...current, ...nextTabs]
      })
      expandTabGroup(item.group.id)
      setActiveTabId(item.activeTabId || item.tabs[0]?.id || HOME_TAB_ID)
      return
    }

    if (item.group) {
      setTabGroups((current) => (
        current.some((group) => group.id === item.group?.id)
          ? current
          : [...current, item.group as WorkspaceTabGroup]
      ))
      expandTabGroup(item.group.id)
    }
    setTabs((current) => (
      current.some((tab) => tab.id === item.tab.id)
        ? current
        : appendTabWithGroupContext(current, item.tab)
    ))
    setActiveTabId(item.tab.id)
  }

  const closeAllTabs = () => {
    runWithSettingsLeaveGuard(() => {
      const homeTab = createHomeTab()
      rememberClosedItems(buildClosedItems(tabs, tabs))
      setTabs([homeTab])
      setTabGroups([])
      setActiveTabId(HOME_TAB_ID)
    })
  }

  const closeOtherTabs = (tabId: string) => {
    const close = () => {
      const selectedTab = tabs.find((tab) => tab.id === tabId)
      const closedTabs = tabs.filter((tab) => tab.id !== tabId)
      const nextTabs = selectedTab ? [selectedTab] : [createHomeTab()]
      rememberClosedItems(buildClosedItems(tabs, closedTabs))
      setTabs(nextTabs)
      setTabGroups((current) => pruneTabGroupsForTabs(current, nextTabs))
      setActiveTabId(nextTabs[0].id)
    }

    if (activeTabId !== tabId) {
      runWithSettingsLeaveGuard(close)
      return
    }
    close()
  }

  const markTabGroupJustCreated = (groupId: string) => {
    if (justCreatedTabGroupTimerRef.current !== null) {
      window.clearTimeout(justCreatedTabGroupTimerRef.current)
      justCreatedTabGroupTimerRef.current = null
    }
    setJustCreatedTabGroupId(groupId)
    justCreatedTabGroupTimerRef.current = window.setTimeout(() => {
      setJustCreatedTabGroupId((current) => (current === groupId ? null : current))
      justCreatedTabGroupTimerRef.current = null
    }, TAB_GROUP_CREATE_EFFECT_MS)
  }

  const createGroupForTab = (tabId: string) => {
    const groupId = createTabGroupId()
    setTabs((current) => {
      const nextTabs = assignTabToGroupInTabs(current, tabId, groupId, false)
      setTabGroups((currentGroups) => {
        const nextGroup = createDefaultTabGroup(currentGroups, groupId, nextTabs)
        return pruneTabGroupsForTabs([...currentGroups, nextGroup], nextTabs)
      })
      return nextTabs
    })
    markTabGroupJustCreated(groupId)
  }

  const createGroupForTabs = (tabIds: string[]) => {
    const uniqueTabIds = Array.from(new Set(tabIds.filter(Boolean)))
    if (uniqueTabIds.length < 2) return
    const tabIdSet = new Set(uniqueTabIds)
    const groupableTabs = tabsRef.current.filter((tab) => tabIdSet.has(tab.id) && !tab.groupId)
    if (groupableTabs.length < 2) return
    const groupId = createTabGroupId()
    setTabs((current) => {
      const stillGroupable = current.filter((tab) => tabIdSet.has(tab.id) && !tab.groupId)
      if (stillGroupable.length < 2) return current
      const nextTabs = current.map((tab) => (
        tabIdSet.has(tab.id) ? { ...tab, groupId } : tab
      ))
      setTabGroups((currentGroups) => {
        const nextGroup = createDefaultTabGroup(currentGroups, groupId, nextTabs)
        return pruneTabGroupsForTabs([...currentGroups, nextGroup], nextTabs)
      })
      return nextTabs
    })
    markTabGroupJustCreated(groupId)
  }

  const moveTabToGroup = (tabId: string, groupId: string) => {
    if (!tabGroupsById.has(groupId)) return
    setTabs((current) => {
      const nextTabs = assignTabToGroupInTabs(current, tabId, groupId, true)
      setTabGroups((currentGroups) => pruneTabGroupsForTabs(currentGroups, nextTabs))
      return nextTabs
    })
  }

  const removeTabFromGroup = (tabId: string) => {
    setTabs((current) => {
      const nextTabs = current.map((tab) => (
        tab.id === tabId ? { ...tab, groupId: undefined } : tab
      ))
      setTabGroups((currentGroups) => pruneTabGroupsForTabs(currentGroups, nextTabs))
      return nextTabs
    })
  }

  const toggleTabGroupCollapsed = (groupId: string) => {
    setTabGroups((current) => current.map((group) => (
      group.id === groupId
        ? { ...group, collapsed: !group.collapsed }
        : group
    )))
  }

  const openRenameTabGroup = (groupId: string) => {
    const group = tabGroupsById.get(groupId)
    if (!group) return
    setRenamingTabGroupId(group.id)
    setRenamingTabGroupTitle(group.title)
  }

  const updateTabGroupTitle = (groupId: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) return
    setTabGroups((current) => current.map((group) => (
      group.id === groupId ? { ...group, title: nextTitle } : group
    )))
  }

  const commitTabGroupSettingsTitle = (groupId: string) => {
    updateTabGroupTitle(groupId, tabGroupSettingsTitle)
  }

  const confirmRenameTabGroup = () => {
    const title = renamingTabGroupTitle.trim()
    if (!renamingTabGroupId || !title) return
    updateTabGroupTitle(renamingTabGroupId, title)
    setRenamingTabGroupId(null)
    setRenamingTabGroupTitle('')
  }

  const updateTabGroupColor = (groupId: string, color: string) => {
    setTabGroups((current) => current.map((group) => (
      group.id === groupId ? { ...group, color } : group
    )))
  }

  const openHomeTabInGroup = (groupId: string) => {
    if (!tabGroupsById.has(groupId)) return
    setTabs((current) => {
      if (current.some((tab) => tab.id === HOME_TAB_ID)) {
        return assignTabToGroupInTabs(current, HOME_TAB_ID, groupId, true)
      }
      return appendTabWithGroupContext(current, { ...createHomeTab(), groupId })
    })
    expandTabGroup(groupId)
    setActiveTabId(HOME_TAB_ID)
    setTabGroupSettingsOpenId(null)
  }

  const ungroupTabGroup = (groupId: string) => {
    setTabs((current) => {
      const nextTabs = current.map((tab) => (
        tab.groupId === groupId ? { ...tab, groupId: undefined } : tab
      ))
      setTabGroups((currentGroups) => pruneTabGroupsForTabs(currentGroups, nextTabs))
      return nextTabs
    })
    setTabGroupSettingsOpenId(null)
  }

  const closeTab = (tabId: string) => {
    const close = () => {
      setTabs((current) => {
        const closingIndex = current.findIndex((tab) => tab.id === tabId)
        if (closingIndex < 0) return current
        const closingTab = current[closingIndex]
        const nextTabs = current.filter((tab) => tab.id !== tabId)
        rememberClosedItems(buildClosedItems(current, closingTab ? [closingTab] : []))
        if (nextTabs.length === 0) {
          setTabGroups([])
          setActiveTabId(HOME_TAB_ID)
          return [createHomeTab()]
        }
        setTabGroups((currentGroups) => pruneTabGroupsForTabs(currentGroups, nextTabs))
        if (activeTabId === tabId) {
          const nextActive = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] || nextTabs[0]
          setActiveTabId(nextActive.id)
        }
        return nextTabs
      })
    }
    const tab = tabs.find((item) => item.id === tabId)
    if (tab?.kind === 'view' && tab.view === 'settings' && activeTabId === tabId && settingsDirty) {
      runWithSettingsLeaveGuard(close)
      return
    }
    close()
  }

  const closeTabGroup = (groupId: string) => {
    const close = () => {
      const groupTabs = tabs.filter((tab) => tab.groupId === groupId)
      if (groupTabs.length === 0) return
      const firstClosingIndex = tabs.findIndex((tab) => tab.groupId === groupId)
      const nextTabs = tabs.filter((tab) => tab.groupId !== groupId)
      rememberClosedItems(buildClosedItems(tabs, groupTabs))
      if (nextTabs.length === 0) {
        setTabs([createHomeTab()])
        setTabGroups([])
        setActiveTabId(HOME_TAB_ID)
        return
      }
      setTabs(nextTabs)
      setTabGroups((current) => pruneTabGroupsForTabs(current, nextTabs))
      if (activeTab.groupId === groupId) {
        const nextActive = nextTabs[Math.min(firstClosingIndex, nextTabs.length - 1)] || nextTabs[0]
        setActiveTabId(nextActive.id)
      }
    }

    if (activeTab.kind === 'view' && activeTab.view === 'settings' && activeTab.groupId === groupId && settingsDirty) {
      runWithSettingsLeaveGuard(close)
      return
    }
    close()
  }

  const clearTabDragHighlights = () => {
    const strip = tabStripRef.current
    if (strip) {
      strip.querySelectorAll<HTMLElement>('.is-group-drop-target').forEach((element) => {
        element.classList.remove('is-group-drop-target')
      })
      strip.querySelectorAll<HTMLElement>('.app-tab-group-segment.is-drop-target').forEach((element) => {
        element.classList.remove('is-drop-target')
      })
    }
    const indicator = tabDropIndicatorRef.current
    if (indicator) {
      indicator.style.opacity = '0'
      indicator.dataset.active = 'false'
    }
  }

  const updateTabDragPreviewPosition = (drag: AppTabPointerDrag | AppTabGroupPointerDrag) => {
    const preview = drag.previewElement
    if (!preview) return
    const previewLeft = Math.min(
      Math.max(6, drag.clientX - drag.grabOffsetX),
      Math.max(6, window.innerWidth - drag.width - 6),
    )
    const previewTop = Math.min(
      Math.max(6, drag.top - 2),
      Math.max(6, window.innerHeight - drag.height - 6),
    )
    // Direct style write (no React) keeps the floating tab on the pointer.
    preview.style.transform = `translate3d(${Math.round(previewLeft)}px, ${Math.round(previewTop)}px, 0)`
  }

  const showTabDropIndicator = (clientX: number, top: number, height: number) => {
    const indicator = tabDropIndicatorRef.current
    if (!indicator) return
    indicator.style.opacity = '1'
    indicator.style.transform = `translate3d(${Math.round(clientX)}px, ${Math.round(top)}px, 0)`
    indicator.style.height = `${Math.round(height)}px`
    indicator.dataset.active = 'true'
  }

  /**
   * Resolve tab drop against top-level strip items (ungrouped tabs + group segments).
   * - Group middle → join group; group sides → insert before/after the whole group (incl. rightmost).
   * - Tab middle 50% (or full tab with Shift/Alt while dragging) → create group with ungrouped peer.
   * - Otherwise reorder.
   */
  const resolveTabPointerDrop = (strip: HTMLElement, drag: AppTabPointerDrag) => {
    const desiredCenter = drag.clientX - drag.grabOffsetX + drag.width / 2
    const sourceTab = tabsRef.current.find((tab) => tab.id === drag.tabId)
    const topLevelItems = Array.from(
      strip.querySelectorAll<HTMLElement>(':scope > [data-app-tab-id], :scope > [data-app-tab-group-id]'),
    )
      .map((element) => {
        const tabId = element.dataset.appTabId
        const groupId = element.dataset.appTabGroupId
        if (tabId && tabId === drag.tabId) return null
        if (!tabId && !groupId) return null
        return {
          type: (groupId ? 'group' : 'tab') as AppTabStripTargetType,
          id: groupId || tabId || '',
          bounds: element.getBoundingClientRect(),
          element,
        }
      })
      .filter((item): item is { type: AppTabStripTargetType; id: string; bounds: DOMRect; element: HTMLElement } => (
        !!item && !!item.id
      ))

    if (topLevelItems.length === 0) return null

    let stripTarget: {
      type: AppTabStripTargetType
      id: string
      position: TabDropPosition
      bounds: DOMRect
      element: HTMLElement
    } | null = null
    for (const item of topLevelItems) {
      if (desiredCenter < item.bounds.left + item.bounds.width / 2) {
        stripTarget = { ...item, position: 'before' }
        break
      }
      stripTarget = { ...item, position: 'after' }
    }
    if (!stripTarget) return null

    if (stripTarget.type === 'group') {
      const overGroup = desiredCenter >= stripTarget.bounds.left && desiredCenter <= stripTarget.bounds.right
      if (overGroup) {
        const ratio = (desiredCenter - stripTarget.bounds.left) / Math.max(1, stripTarget.bounds.width)
        // Side quarters: place the tab before/after the whole group (fixes "can't go past rightmost group").
        if (ratio < TAB_GROUP_ZONE_SIDE_RATIO) {
          return {
            intent: 'reorder' as const,
            targetType: 'group' as const,
            targetId: stripTarget.id,
            position: 'before' as const,
            bounds: stripTarget.bounds,
            element: stripTarget.element,
          }
        }
        if (ratio > (1 - TAB_GROUP_ZONE_SIDE_RATIO)) {
          return {
            intent: 'reorder' as const,
            targetType: 'group' as const,
            targetId: stripTarget.id,
            position: 'after' as const,
            bounds: stripTarget.bounds,
            element: stripTarget.element,
          }
        }
        // Middle of a different group → join it.
        if (sourceTab?.groupId !== stripTarget.id) {
          return {
            intent: 'join-group' as const,
            targetType: 'group' as const,
            targetId: stripTarget.id,
            position: stripTarget.position,
            bounds: stripTarget.bounds,
            element: stripTarget.element,
          }
        }
      } else {
        return {
          intent: 'reorder' as const,
          targetType: 'group' as const,
          targetId: stripTarget.id,
          position: stripTarget.position,
          bounds: stripTarget.bounds,
          element: stripTarget.element,
        }
      }
    }

    // Fine-grained tab anchors (includes nested tabs inside expanded groups).
    const otherTabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-app-tab-id]'))
      .filter((element) => element.dataset.appTabId && element.dataset.appTabId !== drag.tabId)
    let tabTarget: { tabId: string; position: TabDropPosition; bounds: DOMRect; element: HTMLElement } | null = null
    for (const element of otherTabs) {
      const tabId = element.dataset.appTabId
      if (!tabId) continue
      const bounds = element.getBoundingClientRect()
      if (desiredCenter < bounds.left + bounds.width / 2) {
        tabTarget = { tabId, position: 'before', bounds, element }
        break
      }
      tabTarget = { tabId, position: 'after', bounds, element }
    }

    // Prefer top-level ungrouped tab when the strip target is that tab.
    if (stripTarget.type === 'tab') {
      const nearTab = tabsRef.current.find((tab) => tab.id === stripTarget.id)
      const canCreateGroup = !!(sourceTab && nearTab && !sourceTab.groupId && !nearTab.groupId)
      if (canCreateGroup) {
        // Shift/Alt while dragging: any position relative to this tab creates a group.
        // Without modifiers: only the middle 50% of the target tab.
        if (
          drag.forceGroupModifier
          || isTabGroupDropZone(desiredCenter, stripTarget.bounds, false)
        ) {
          return {
            intent: 'group' as const,
            targetType: 'tab' as const,
            targetId: stripTarget.id,
            position: stripTarget.position,
            bounds: stripTarget.bounds,
            element: stripTarget.element,
          }
        }
      }
      return {
        intent: 'reorder' as const,
        targetType: 'tab' as const,
        targetId: stripTarget.id,
        position: stripTarget.position,
        bounds: stripTarget.bounds,
        element: stripTarget.element,
      }
    }

    if (tabTarget) {
      const nearTab = tabsRef.current.find((tab) => tab.id === tabTarget.tabId)
      const canCreateGroup = !!(sourceTab && nearTab && !sourceTab.groupId && !nearTab.groupId)
      if (canCreateGroup && (
        drag.forceGroupModifier
        || isTabGroupDropZone(desiredCenter, tabTarget.bounds, false)
      )) {
        return {
          intent: 'group' as const,
          targetType: 'tab' as const,
          targetId: tabTarget.tabId,
          position: tabTarget.position,
          bounds: tabTarget.bounds,
          element: tabTarget.element,
        }
      }
      return {
        intent: 'reorder' as const,
        targetType: 'tab' as const,
        targetId: tabTarget.tabId,
        position: tabTarget.position,
        bounds: tabTarget.bounds,
        element: tabTarget.element,
      }
    }

    return {
      intent: 'reorder' as const,
      targetType: stripTarget.type,
      targetId: stripTarget.id,
      position: stripTarget.position,
      bounds: stripTarget.bounds,
      element: stripTarget.element,
    }
  }

  const captureTabLayout = () => {
    const layout = new Map<string, number>()
    tabStripRef.current?.querySelectorAll<HTMLElement>('[data-app-tab-id]').forEach((element) => {
      const tabId = element.dataset.appTabId
      if (tabId) layout.set(tabId, element.getBoundingClientRect().left)
    })
    return layout
  }

  const captureTabStripItemLayout = () => {
    const layout = new Map<string, number>()
    tabStripRef.current?.querySelectorAll<HTMLElement>(':scope > [data-app-tab-id], :scope > [data-app-tab-group-id]').forEach((element) => {
      const key = element.dataset.appTabId
        ? `tab:${element.dataset.appTabId}`
        : element.dataset.appTabGroupId
          ? `group:${element.dataset.appTabGroupId}`
          : ''
      if (key) layout.set(key, element.getBoundingClientRect().left)
    })
    return layout
  }

  const getTabGroupReorderTarget = (strip: HTMLElement, drag: AppTabGroupPointerDrag): AppTabGroupDragTarget | null => {
    const desiredCenter = drag.clientX - drag.grabOffsetX + drag.width / 2
    const items = Array.from(strip.querySelectorAll<HTMLElement>(':scope > [data-app-tab-id], :scope > [data-app-tab-group-id]'))
      .map((element) => {
        const tabId = element.dataset.appTabId
        const groupId = element.dataset.appTabGroupId
        if (groupId === drag.groupId) return null
        if (!tabId && !groupId) return null
        const bounds = element.getBoundingClientRect()
        return {
          type: groupId ? 'group' as const : 'tab' as const,
          id: groupId || tabId || '',
          bounds,
        }
      })
      .filter((item): item is { type: 'tab' | 'group'; id: string; bounds: DOMRect } => !!item)

    let target: AppTabGroupDragTarget | null = null
    for (const item of items) {
      if (desiredCenter < item.bounds.left + item.bounds.width / 2) {
        target = { type: item.type, id: item.id, position: 'before' }
        break
      }
      target = { type: item.type, id: item.id, position: 'after' }
    }
    return target
  }

  const scheduleTabDragFrame = () => {
    if (tabDragFrameRef.current !== null) return
    tabDragFrameRef.current = window.requestAnimationFrame(() => {
      tabDragFrameRef.current = null
      const drag = tabPointerDragRef.current
      const groupDrag = tabGroupPointerDragRef.current
      const strip = tabStripRef.current
      if (!strip) return

      if (groupDrag?.moved) {
        // Preview is already updated on pointermove; only resolve hit-test here.
        groupDrag.target = getTabGroupReorderTarget(strip, groupDrag)
        if (groupDrag.target) {
          const desiredCenter = groupDrag.clientX - groupDrag.grabOffsetX + groupDrag.width / 2
          const items = Array.from(
            strip.querySelectorAll<HTMLElement>(':scope > [data-app-tab-id], :scope > [data-app-tab-group-id]'),
          )
          let indicatorX = desiredCenter
          for (const element of items) {
            if (element.dataset.appTabGroupId === groupDrag.groupId) continue
            const bounds = element.getBoundingClientRect()
            const mid = bounds.left + bounds.width / 2
            if (desiredCenter < mid) {
              indicatorX = bounds.left - 1
              break
            }
            indicatorX = bounds.right + 1
          }
          showTabDropIndicator(indicatorX, groupDrag.top, groupDrag.height)
        }
        return
      }

      if (!drag?.moved) return

      const resolved = resolveTabPointerDrop(strip, drag)
      drag.targetType = resolved?.targetType || null
      drag.targetId = resolved?.targetId || null
      drag.targetDropPosition = resolved?.position || null
      drag.targetDropIntent = resolved?.intent || null

      const canCreateGroup = resolved?.intent === 'group'
      const canJoinGroup = resolved?.intent === 'join-group'
      const highlightKey = canCreateGroup
        ? `group-tab:${resolved.targetId}`
        : canJoinGroup
          ? `join:${resolved.targetId}`
          : resolved
            ? `reorder:${resolved.targetType}:${resolved.targetId}:${resolved.position}`
            : null

      if (drag.highlightKey !== highlightKey) {
        drag.highlightKey = highlightKey
        clearTabDragHighlights()
        if (canCreateGroup && resolved) {
          resolved.element.classList.add('is-group-drop-target')
        } else if (canJoinGroup && resolved) {
          resolved.element.classList.add('is-drop-target')
        } else if (resolved) {
          const edgeX = resolved.position === 'before'
            ? resolved.bounds.left - 1
            : resolved.bounds.right + 1
          showTabDropIndicator(edgeX, drag.top, drag.height)
        }
      } else if (resolved && resolved.intent === 'reorder') {
        const edgeX = resolved.position === 'before'
          ? resolved.bounds.left - 1
          : resolved.bounds.right + 1
        showTabDropIndicator(edgeX, drag.top, drag.height)
      }

      drag.previewElement?.classList.toggle('is-group-intent', canCreateGroup)
      drag.previewElement?.classList.toggle('is-force-group', canCreateGroup && drag.forceGroupModifier)
      drag.previewElement?.classList.toggle('is-join-group', canJoinGroup)
    })
  }

  const finishTabPointerDrag = (cancelled = false) => {
    tabPointerCleanupRef.current?.()
    tabPointerCleanupRef.current = null
    if (tabDragFrameRef.current !== null) {
      window.cancelAnimationFrame(tabDragFrameRef.current)
      tabDragFrameRef.current = null
    }

    const drag = tabPointerDragRef.current
    const targetElement = drag
      ? tabStripRef.current?.querySelector<HTMLElement>(`[data-app-tab-id="${CSS.escape(drag.tabId)}"]`)
      : null
    const droppedTabId = drag?.tabId || ''
    const droppedTargetType = drag?.targetType || null
    const droppedTargetId = drag?.targetId || ''
    const droppedDropIntent = drag?.targetDropIntent || null
    const droppedTargetDropPosition = drag?.targetDropPosition || null
    tabPointerDragRef.current = null
    document.body.classList.remove('is-app-tab-dragging')
    clearTabDragHighlights()

    if (!drag?.moved || cancelled) {
      drag?.previewElement?.remove()
      setDraggedTabId(null)
      suppressTabClickRef.current = false
      return
    }

    const finishDrop = () => {
      clearTabDragHighlights()
      const droppedTab = tabsRef.current.find((tab) => tab.id === droppedTabId)
      if (!droppedTab) return

      if (droppedDropIntent === 'join-group' && droppedTargetId && droppedTab.groupId !== droppedTargetId) {
        pendingTabLayoutRef.current = captureTabLayout()
        moveTabToGroup(droppedTabId, droppedTargetId)
        return
      }

      // Only create a group after a real drag, in the group zone (middle 50%, or full tab with Shift/Alt).
      if (droppedDropIntent === 'group' && droppedTargetType === 'tab' && droppedTargetId) {
        const droppedNearTab = tabsRef.current.find((tab) => tab.id === droppedTargetId)
        if (
          droppedNearTab
          && !droppedTab.groupId
          && !droppedNearTab.groupId
        ) {
          pendingTabLayoutRef.current = captureTabLayout()
          createGroupForTabs([droppedTab.id, droppedNearTab.id])
          return
        }
      }

      if (droppedTargetId && droppedTargetDropPosition && droppedTargetType) {
        let currentTabs = tabsRef.current
        // Leave the current group when reordering next to a tab outside it.
        if (droppedTab.groupId && droppedTargetType === 'tab') {
          const targetTab = currentTabs.find((tab) => tab.id === droppedTargetId)
          if (!targetTab || targetTab.groupId !== droppedTab.groupId) {
            currentTabs = currentTabs.map((tab) => (
              tab.id === droppedTabId ? { ...tab, groupId: undefined } : tab
            ))
          }
        }
        const nextTabs = reorderAppTabToStripTarget(
          currentTabs,
          drag.tabId,
          { type: droppedTargetType, id: droppedTargetId, position: droppedTargetDropPosition },
        )
        if (nextTabs !== tabsRef.current) {
          pendingTabLayoutRef.current = droppedTargetType === 'group'
            ? captureTabStripItemLayout()
            : captureTabLayout()
          const groupMembershipChanged = nextTabs.some((tab) => {
            const previous = tabsRef.current.find((item) => item.id === tab.id)
            return previous?.groupId !== tab.groupId
          })
          if (groupMembershipChanged) {
            setTabGroups((groups) => pruneTabGroupsForTabs(groups, nextTabs))
          }
          tabsRef.current = nextTabs
          setTabs(nextTabs)
        }
      }
    }

    const previewElement = drag.previewElement
    const targetBounds = targetElement?.getBoundingClientRect()
    const previewBounds = previewElement?.getBoundingClientRect()
    const droppedTab = tabsRef.current.find((tab) => tab.id === droppedTabId)
    const willCreateGroup = droppedDropIntent === 'group'
    const willJoinGroup = droppedDropIntent === 'join-group'
    const willLeaveGroup = !!(
      droppedTab?.groupId
      && droppedDropIntent === 'reorder'
      && droppedTargetId
      && (
        droppedTargetType === 'group'
          ? droppedTargetId !== droppedTab.groupId
          : tabsRef.current.find((tab) => tab.id === droppedTargetId)?.groupId !== droppedTab.groupId
      )
    )
    const changesGroupMembership = willCreateGroup || willJoinGroup || willLeaveGroup
    if (changesGroupMembership) {
      setDraggedTabId(null)
      finishDrop()
      if (previewElement) {
        const baseTransform = previewElement.style.transform || 'translate3d(0, 0, 0)'
        const fadeAnimation = previewElement.animate(
          willCreateGroup
            ? [
                {
                  opacity: 1,
                  transform: baseTransform,
                  boxShadow: '0 10px 24px rgba(0, 0, 0, 0.34), 0 0 0 2px rgba(212, 173, 132, 0.55), 0 0 22px rgba(212, 173, 132, 0.45)',
                },
                {
                  opacity: 0,
                  transform: `${baseTransform} scale(1.08)`,
                  boxShadow: '0 0 0 rgba(0, 0, 0, 0), 0 0 28px rgba(212, 173, 132, 0.75)',
                },
              ]
            : [
                { opacity: 1, transform: baseTransform },
                { opacity: 0, transform: `${baseTransform} scale(0.98)` },
              ],
          { duration: willCreateGroup ? 220 : 120, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        )
        void fadeAnimation.finished
          .catch(() => {})
          .finally(() => {
            previewElement.remove()
          })
      }
      window.setTimeout(() => {
        suppressTabClickRef.current = false
      }, 0)
      return
    }

    if (previewElement && targetBounds && previewBounds) {
      const settleAnimation = previewElement.animate(
        [
          { transform: `translate3d(${previewBounds.left}px, ${previewBounds.top}px, 0)` },
          { transform: `translate3d(${targetBounds.left}px, ${targetBounds.top}px, 0)` },
        ],
        { duration: 140, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
      void settleAnimation.finished
        .catch(() => {})
        .finally(() => {
          previewElement.remove()
          setDraggedTabId(null)
          finishDrop()
        })
    } else {
      previewElement?.remove()
      setDraggedTabId(null)
      finishDrop()
    }
    window.setTimeout(() => {
      suppressTabClickRef.current = false
    }, 0)
  }

  const finishTabGroupPointerDrag = (cancelled = false) => {
    tabPointerCleanupRef.current?.()
    tabPointerCleanupRef.current = null
    if (tabDragFrameRef.current !== null) {
      window.cancelAnimationFrame(tabDragFrameRef.current)
      tabDragFrameRef.current = null
    }

    const drag = tabGroupPointerDragRef.current
    const targetElement = drag
      ? tabStripRef.current?.querySelector<HTMLElement>(`[data-app-tab-group-id="${CSS.escape(drag.groupId)}"]`)
      : null
    tabGroupPointerDragRef.current = null
    document.body.classList.remove('is-app-tab-dragging')
    clearTabDragHighlights()

    if (!drag?.moved || cancelled) {
      drag?.previewElement?.remove()
      setDraggedTabGroupId(null)
      suppressTabClickRef.current = false
      return
    }

    if (drag.target) {
      const currentTabs = tabsRef.current
      const nextTabs = reorderAppTabGroup(currentTabs, drag.groupId, drag.target)
      if (nextTabs !== currentTabs) {
        pendingTabLayoutRef.current = captureTabStripItemLayout()
        tabsRef.current = nextTabs
        setTabs(nextTabs)
      }
    }

    const previewElement = drag.previewElement
    const targetBounds = targetElement?.getBoundingClientRect()
    const previewBounds = previewElement?.getBoundingClientRect()
    if (previewElement && targetBounds && previewBounds) {
      const settleAnimation = previewElement.animate(
        [
          { transform: `translate3d(${previewBounds.left}px, ${previewBounds.top}px, 0)` },
          { transform: `translate3d(${targetBounds.left}px, ${targetBounds.top}px, 0)` },
        ],
        { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
      void settleAnimation.finished
        .catch(() => {})
        .finally(() => {
          previewElement.remove()
          setDraggedTabGroupId(null)
        })
    } else {
      previewElement?.remove()
      setDraggedTabGroupId(null)
    }
    window.setTimeout(() => {
      suppressTabClickRef.current = false
    }, 0)
  }

  const handleTabPointerDown = (event: React.PointerEvent<HTMLButtonElement>, tabId: string) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.app-tab-close')) return
    tabPointerCleanupRef.current?.()
    const tabElement = event.currentTarget
    const bounds = tabElement.getBoundingClientRect()
    tabPointerDragRef.current = {
      tabId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      grabOffsetX: event.clientX - bounds.left,
      width: bounds.width,
      height: bounds.height,
      top: bounds.top,
      moved: false,
      previewElement: null,
      forceGroupModifier: isForceGroupModifierActive(event),
      targetType: null,
      targetId: null,
      targetDropPosition: null,
      targetDropIntent: null,
      highlightKey: null,
    }

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = tabPointerDragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      drag.clientX = pointerEvent.clientX
      // Only the drag gesture + held Shift/Alt can force-group — never a plain Shift click.
      drag.forceGroupModifier = drag.moved && isForceGroupModifierActive(pointerEvent)
      if (!drag.moved) {
        const distance = Math.hypot(
          pointerEvent.clientX - drag.startClientX,
          pointerEvent.clientY - drag.startClientY,
        )
        if (distance < TAB_DRAG_ACTIVATION_DISTANCE) return
        drag.moved = true
        drag.forceGroupModifier = isForceGroupModifierActive(pointerEvent)
        suppressTabClickRef.current = true
        const previewElement = tabElement.cloneNode(true) as HTMLElement
        previewElement.removeAttribute('data-app-tab-id')
        previewElement.removeAttribute('data-app-tab-active')
        previewElement.removeAttribute('title')
        previewElement.classList.remove('is-dragging-source')
        previewElement.classList.add('app-tab-drag-preview')
        previewElement.style.width = `${bounds.width}px`
        previewElement.style.height = `${bounds.height}px`
        previewElement.style.transform = `translate3d(${bounds.left}px, ${bounds.top - 2}px, 0)`
        previewElement.querySelector('.app-tab-close')?.setAttribute('aria-hidden', 'true')
        document.body.appendChild(previewElement)
        drag.previewElement = previewElement
        setDraggedTabId(tabId)
        document.body.classList.add('is-app-tab-dragging')
        window.getSelection()?.removeAllRanges()
      }
      // Preview follows the pointer immediately; hit-testing stays on rAF for smoothness.
      updateTabDragPreviewPosition(drag)
      pointerEvent.preventDefault()
      scheduleTabDragFrame()
    }
    const handleModifierKeyChange = (keyboardEvent: KeyboardEvent) => {
      const drag = tabPointerDragRef.current
      if (!drag?.moved) return
      drag.forceGroupModifier = isForceGroupModifierActive(keyboardEvent)
      scheduleTabDragFrame()
    }
    const handlePointerUp = (pointerEvent: PointerEvent) => {
      const drag = tabPointerDragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      // Force-group only if this pointer session actually dragged.
      drag.forceGroupModifier = drag.moved && isForceGroupModifierActive(pointerEvent)
      // Resolve against the final pointer state so Shift/Alt on release is respected.
      const strip = tabStripRef.current
      if (drag.moved && strip) {
        const resolved = resolveTabPointerDrop(strip, drag)
        drag.targetType = resolved?.targetType || null
        drag.targetId = resolved?.targetId || null
        drag.targetDropPosition = resolved?.position || null
        drag.targetDropIntent = resolved?.intent || null
      }
      finishTabPointerDrag()
    }
    const handlePointerCancel = (pointerEvent: PointerEvent) => {
      const drag = tabPointerDragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      finishTabPointerDrag(true)
    }
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('keydown', handleModifierKeyChange)
    window.addEventListener('keyup', handleModifierKeyChange)
    tabPointerCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('keydown', handleModifierKeyChange)
      window.removeEventListener('keyup', handleModifierKeyChange)
    }
  }

  const handleTabGroupPointerDown = (event: React.PointerEvent<HTMLButtonElement>, groupId: string) => {
    if (event.button !== 0) return
    tabPointerCleanupRef.current?.()
    const groupElement = event.currentTarget.closest<HTMLElement>('[data-app-tab-group-id]')
    if (!groupElement) return
    const bounds = groupElement.getBoundingClientRect()
    tabGroupPointerDragRef.current = {
      groupId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      clientX: event.clientX,
      grabOffsetX: event.clientX - bounds.left,
      width: bounds.width,
      height: bounds.height,
      top: bounds.top,
      moved: false,
      previewElement: null,
      target: null,
    }

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = tabGroupPointerDragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      drag.clientX = pointerEvent.clientX
      if (!drag.moved) {
        const distance = Math.hypot(
          pointerEvent.clientX - drag.startClientX,
          pointerEvent.clientY - drag.startClientY,
        )
        if (distance < TAB_DRAG_ACTIVATION_DISTANCE) return
        drag.moved = true
        suppressTabClickRef.current = true
        const previewElement = groupElement.cloneNode(true) as HTMLElement
        previewElement.removeAttribute('data-app-tab-group-id')
        previewElement.removeAttribute('data-app-tab-group-drop-target')
        previewElement.removeAttribute('data-app-tab-group-collapsed')
        previewElement.classList.remove('is-dragging-source')
        previewElement.classList.add('app-tab-group-drag-preview')
        previewElement.style.width = `${bounds.width}px`
        previewElement.style.height = `${bounds.height}px`
        previewElement.style.transform = `translate3d(${bounds.left}px, ${bounds.top - 2}px, 0)`
        previewElement.querySelectorAll('[data-app-tab-id]').forEach((element) => {
          element.removeAttribute('data-app-tab-id')
        })
        previewElement.querySelectorAll('.app-tab-close').forEach((element) => {
          element.setAttribute('aria-hidden', 'true')
        })
        document.body.appendChild(previewElement)
        drag.previewElement = previewElement
        setDraggedTabGroupId(groupId)
        document.body.classList.add('is-app-tab-dragging')
        window.getSelection()?.removeAllRanges()
      }
      updateTabDragPreviewPosition(drag)
      pointerEvent.preventDefault()
      scheduleTabDragFrame()
    }
    const handlePointerUp = (pointerEvent: PointerEvent) => {
      const drag = tabGroupPointerDragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      finishTabGroupPointerDrag()
    }
    const handlePointerCancel = (pointerEvent: PointerEvent) => {
      const drag = tabGroupPointerDragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      finishTabGroupPointerDrag(true)
    }
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
    tabPointerCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }
  }

  useLayoutEffect(() => {
    const previousLayout = pendingTabLayoutRef.current
    const strip = tabStripRef.current
    if (!previousLayout || !strip) return
    pendingTabLayoutRef.current = null
    const draggingId = tabPointerDragRef.current?.tabId
    const draggingGroupId = tabGroupPointerDragRef.current?.groupId
    const selector = draggingGroupId
      ? ':scope > [data-app-tab-id], :scope > [data-app-tab-group-id]'
      : '[data-app-tab-id]'
    strip.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const tabId = element.dataset.appTabId
      const groupId = element.dataset.appTabGroupId
      if ((tabId && tabId === draggingId) || (groupId && groupId === draggingGroupId)) return
      const layoutKey = draggingGroupId
        ? tabId ? `tab:${tabId}` : groupId ? `group:${groupId}` : ''
        : tabId || ''
      if (!layoutKey) return
      const previousLeft = previousLayout.get(layoutKey)
        ?? (tabId ? previousLayout.get(tabId) ?? previousLayout.get(`tab:${tabId}`) : undefined)
      if (previousLeft === undefined) return
      const deltaX = previousLeft - element.getBoundingClientRect().left
      if (Math.abs(deltaX) < 0.5) return
      tabReorderAnimationsRef.current.get(layoutKey)?.cancel()
      const animation = element.animate(
        [
          { transform: `translate3d(${deltaX}px, 0, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 170, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
      tabReorderAnimationsRef.current.set(layoutKey, animation)
      animation.addEventListener('finish', () => {
        if (tabReorderAnimationsRef.current.get(layoutKey) === animation) {
          tabReorderAnimationsRef.current.delete(layoutKey)
        }
      }, { once: true })
    })
  }, [tabs])

  useEffect(() => () => {
    tabPointerCleanupRef.current?.()
    if (tabDragFrameRef.current !== null) window.cancelAnimationFrame(tabDragFrameRef.current)
    if (justCreatedTabGroupTimerRef.current !== null) window.clearTimeout(justCreatedTabGroupTimerRef.current)
    tabReorderAnimationsRef.current.forEach((animation) => animation.cancel())
    tabPointerDragRef.current?.previewElement?.remove()
    tabGroupPointerDragRef.current?.previewElement?.remove()
    document.body.classList.remove('is-app-tab-dragging')
  }, [])

  useEffect(() => {
    let active = true
    const refreshShortcuts = () => {
      void loadShortcutSettings().then((nextShortcuts) => {
        if (active) setShortcuts(nextShortcuts)
      })
    }
    refreshShortcuts()
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, refreshShortcuts)
    return () => {
      active = false
      window.removeEventListener(SHORTCUTS_CHANGED_EVENT, refreshShortcuts)
    }
  }, [])

  useEffect(() => {
    if (!shortcuts || activeDocumentTab) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasShortcutBlockingOverlay() || isEditableShortcutTarget(event.target)) return
      if (shortcutMatches(event, shortcuts.back)) {
        event.preventDefault()
        if (tabGroupSettingsOpenId) {
          setTabGroupSettingsOpenId(null)
          return
        }
        if (tabMenuOpen) {
          setTabMenuOpen(false)
          return
        }
        if (libraryAiOpen) {
          setLibraryAiOpen(false)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeDocumentTab, libraryAiOpen, shortcuts, tabGroupSettingsOpenId, tabMenuOpen])

  useEffect(() => {
    if (!window.api) return
    window.__smokeOpenDocument = openDocumentTarget
    return () => {
      delete window.__smokeOpenDocument
    }
  }, [openDocumentTarget])

  const handlePanelDragStart = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('.resize-handle') || (event.target as HTMLElement).closest('button')) return
    draggingPanel.current = true
    interactStart.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      panelX: panelState.current.x,
      panelY: panelState.current.y,
      panelW: panelState.current.w,
      panelH: panelState.current.h
    }
    document.body.style.cursor = 'grabbing'
  }

  const handleResizeStart = (event: React.MouseEvent, dir: string) => {
    event.stopPropagation()
    event.preventDefault()
    resizingPanel.current = dir
    interactStart.current = {
      mouseX: event.clientX,
      mouseY: event.clientY,
      panelX: panelState.current.x,
      panelY: panelState.current.y,
      panelW: panelState.current.w,
      panelH: panelState.current.h
    }
    document.body.style.cursor = `${dir}-resize`
  }

  const handleRequiredDatabaseUpgrade = async () => {
    setDatabaseUpgradeBusy(true)
    setDatabaseUpgradeProgress(null)
    try {
      const initialDiagnostics = await window.api.getDatabaseStorageDiagnostics()
      setDatabaseUpgradeDiagnostics(initialDiagnostics)
      if (isDatabaseCompactionWorthwhile(initialDiagnostics)) {
        setDatabaseUpgradePhase('precompact')
        await waitForDatabaseUpgradeUi()
        const precompactResult = await window.api.compactDatabase()
        if (!precompactResult.success) {
          message.error(precompactResult.error || precompactResult.message || '旧数据库压缩失败，请确认磁盘空间充足后重试。')
          return
        }
        setDatabaseUpgradeDiagnostics(await window.api.getDatabaseStorageDiagnostics())
      }

      setDatabaseUpgradePhase('cleanup')
      const rebuildResult = await window.api.rebuildLightweightSearchIndex()
      if (!rebuildResult.success) {
        message.error(rebuildResult.error || rebuildResult.message || '数据库升级失败')
        return
      }

      const cleanupDiagnostics = await window.api.getDatabaseStorageDiagnostics()
      setDatabaseUpgradeDiagnostics(cleanupDiagnostics)
      if (hasRequiredDatabaseMaintenance(cleanupDiagnostics)) {
        message.warning('数据库企业级升级仍未完成，请稍后再次点击升级，或进入设置页查看数据库空间管理进度。')
        return
      }

      setDatabaseUpgradePhase('compact')
      await waitForDatabaseUpgradeUi()
      const compactResult = await window.api.compactDatabase()
      const diagnostics = await window.api.getDatabaseStorageDiagnostics()
      setDatabaseUpgradeDiagnostics(diagnostics)
      if (!compactResult.success) {
        message.error(compactResult.error || compactResult.message || '数据库压缩失败，请确认磁盘空间充足后重试。')
        return
      }

      setDatabaseUpgradeVisible(false)
      message.success(`数据库企业级升级并压缩完成${formatDatabaseUpgradeSavedBytes(compactResult.beforeBytes, compactResult.afterBytes)}。搜索索引会在后台继续更新。`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error || '数据库升级并压缩失败'))
    } finally {
      setDatabaseUpgradeBusy(false)
      setDatabaseUpgradePhase('idle')
    }
  }

  const handleQuitForDatabaseUpgrade = () => {
    void window.api.quitApp()
  }

  const selectTabFromMenu = (tab: AppTab) => {
    setTabMenuOpen(false)
    setTabSearchKey('')
    if (tab.id === activeTabId) {
      revealTabGroup(tab)
      return
    }
    runWithSettingsLeaveGuard(() => {
      revealTabGroup(tab)
      setActiveTabId(tab.id)
    })
  }

  const selectFirstFilteredTab = () => {
    const firstMatch = filteredTabs[0]
    if (firstMatch) selectTabFromMenu(firstMatch)
  }

  const getTabGroupColorItems = (group: WorkspaceTabGroup): MenuProps['items'] => (
    TAB_GROUP_COLORS.map((color, index) => ({
      key: `group:color:${color}`,
      label: (
        <span className="app-tab-context-color-item">
          <span className="app-tab-context-color-dot" style={{ background: color }} />
          颜色 {index + 1}
        </span>
      ),
    }))
  )

  const getClosedItemLabel = (item?: ClosedAppTabItem): string => {
    if (!item) return '重新打开关闭的标签页'
    return item.type === 'group'
      ? `重新打开关闭的分组：${item.group.title}`
      : `重新打开关闭的标签页：${item.tab.title}`
  }

  const getTabRailContextMenuItems = (): MenuProps['items'] => [
    {
      key: 'reopen-closed',
      label: getClosedItemLabel(closedTabHistory[0]),
      disabled: closedTabHistory.length === 0,
    },
  ]

  const handleTabRailContextMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'reopen-closed') reopenClosedItem()
  }

  const getTabContextMenuItems = (tab: AppTab): MenuProps['items'] => {
    const group = tab.groupId ? tabGroupsById.get(tab.groupId) : undefined
    const groupItems = tabGroups.map((item) => ({
      key: `group:assign:${item.id}`,
      label: item.title,
      disabled: item.id === tab.groupId,
    }))

    return [
      { key: 'close-all', label: '关闭所有标签页' },
      { key: 'close-others', label: '关闭其他标签页', disabled: tabs.length <= 1 },
      { type: 'divider' },
      { key: 'group-new', label: '新建分组并加入' },
      groupItems.length > 0
        ? { key: 'group-existing', label: '移动到分组', children: groupItems }
        : null,
      group ? { key: 'group-rename', label: '重命名当前分组' } : null,
      group ? { key: 'group-color', label: '更改分组颜色', children: getTabGroupColorItems(group) } : null,
      group
        ? {
          key: 'group-toggle',
          label: group.collapsed ? '展开当前分组' : '折叠当前分组',
        }
        : null,
      group ? { key: 'group-close', label: '关闭当前分组' } : null,
      group ? { key: 'group-remove', label: '从分组移除' } : null,
    ].filter(Boolean) as MenuProps['items']
  }

  const handleTabContextMenuClick = (tab: AppTab, key: string) => {
    if (key === 'close-all') {
      closeAllTabs()
      return
    }
    if (key === 'close-others') {
      closeOtherTabs(tab.id)
      return
    }
    if (key === 'group-new') {
      createGroupForTab(tab.id)
      return
    }
    if (key.startsWith('group:assign:')) {
      moveTabToGroup(tab.id, key.slice('group:assign:'.length))
      return
    }
    if (key === 'group-rename' && tab.groupId) {
      openRenameTabGroup(tab.groupId)
      return
    }
    if (key.startsWith('group:color:') && tab.groupId) {
      updateTabGroupColor(tab.groupId, key.slice('group:color:'.length))
      return
    }
    if (key === 'group-toggle' && tab.groupId) {
      toggleTabGroupCollapsed(tab.groupId)
      return
    }
    if (key === 'group-close' && tab.groupId) {
      closeTabGroup(tab.groupId)
      return
    }
    if (key === 'group-remove') {
      removeTabFromGroup(tab.id)
    }
  }

  const tabMenuContent = (
    <div className="app-tab-menu-panel" data-app-tab-menu-panel="true">
      <div className="app-tab-menu-search">
        <Input
          placeholder="搜索打开的标签页"
          prefix={<SearchOutlined />}
          allowClear
          value={tabSearchKey}
          onChange={(event) => setTabSearchKey(event.target.value)}
          onPressEnter={selectFirstFilteredTab}
          data-app-tab-menu-search="true"
        />
      </div>
      <div className="app-tab-menu-divider" />
      <div className="app-tab-menu-heading">
        <span>打开的标签页</span>
        <span>{filteredTabs.length === tabs.length ? tabs.length : `${filteredTabs.length}/${tabs.length}`}</span>
      </div>
      <div className="app-tab-menu-list">
        {filteredTabs.map((tab) => {
          const active = tab.id === activeTabId
          const closable = !(tab.kind === 'home' && tabs.length <= 1)
          return (
            <div
              key={`menu:${tab.id}`}
              className={`app-tab-menu-item ${active ? 'is-active' : ''}`}
              data-app-tab-menu-item="true"
            >
              <button
                type="button"
                className="app-tab-menu-item-main"
                onClick={() => selectTabFromMenu(tab)}
              >
                <span className="app-tab-menu-item-icon">{getTabIcon(tab)}</span>
                <span className="app-tab-menu-item-title">{tab.title}</span>
              </button>
              {closable ? (
                <Tooltip title={`关闭 ${tab.title}`}>
                  <button
                    type="button"
                    className="app-tab-menu-item-close"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={() => closeTab(tab.id)}
                  >
                    <CloseOutlined />
                  </button>
                </Tooltip>
              ) : null}
            </div>
          )
        })}
        {filteredTabs.length === 0 ? (
          <div className="app-tab-menu-empty" data-app-tab-menu-empty="true">
            没有匹配的已打开标签页
          </div>
        ) : null}
      </div>
    </div>
  )

  const renderView = () => {
    if (activeTab.kind === 'document') {
      const target = activeTab.document.target
      return (
        <DocumentView
          key={activeTab.id}
          documentId={activeTab.document.docId}
          initialPageIndex={target.pageIndex ?? 0}
          searchKeyword={target.keyword || target.highlightExcerpt || target.locator?.queryTerm || target.excerpt?.slice(0, 40) || ''}
          sourceId={target.sourceId}
          searchSession={target.searchSession}
          locator={target.locator}
          stableLocator={target.stableLocator}
          revealToc={!!target.revealToc}
          highlightExcerpt={target.highlightExcerpt || ''}
          highlightColor={target.highlightColor || ''}
          sourceLabel={target.sourceLabel || ''}
          startReaderBookTranslation={!!target.startReaderBookTranslation}
          openTranslation={!!target.openTranslation}
          onOpenDocument={(nextTarget) => openDocumentTarget(nextTarget)}
          onBack={() => closeTab(activeTab.id)}
          compactHeader
        />
      )
    }

    if (activeTab.kind === 'home') {
      return <WelcomeView onImport={handleImport} onNavigate={(view) => openViewTab(view)} />
    }

    switch (activeTab.view) {
      case 'library':
        return (
          <LibraryView
            onSelectDoc={openDocumentTarget}
            initialFilter={libraryFilter}
            initialFocusSection={libraryFocusSection}
            onOpenLibraryAi={openLibraryAi}
            importRequest={libraryImportRequest}
            droppedImportRequest={libraryDroppedImportRequest}
            onDroppedImportHandled={(requestId) => {
              setLibraryDroppedImportRequest((current) => (current?.id === requestId ? null : current))
            }}
            libraryProjects={libraryProjects}
            activeLibraryProjectId={activeLibraryProject?.id}
            onLibraryProjectsChanged={() => void loadLibraryProjectChoices()}
            onLibraryDocumentsMoved={handleLibraryDocumentsMoved}
          />
        )
      case 'folders':
        return (
          <FoldersView
            onOpenFolder={(folderId) => openLibraryWithFilter({ type: 'folder', value: folderId }, 'folders')}
            onOpenDocument={openDocumentFromFolders}
            initialState={activeTab.foldersState || null}
            onStateChange={handleFoldersStateChange}
          />
        )
      case 'settings':
        return <SettingsView ref={settingsViewRef} onDirtyChange={setSettingsDirty} />
      case 'research':
        return (
          <ResearchView
            onOpenDocument={openDocumentTarget}
            onOpenLibraryAi={openLibraryAi}
            onActiveProjectChange={setActiveResearchProjectId}
          />
        )
      case 'excerpts':
        return (
          <ExcerptsView
            onOpenDocument={openDocumentTarget}
          />
        )
      case 'dashboard':
        return <DashboardView />
      case 'search':
        return (
          <SearchView
            onSelectDoc={openDocumentTarget}
            initialKeyword={activeTab.initialSearchKeyword || ''}
            onOpenLibraryAi={openLibraryAi}
          />
        )
      case 'citation':
        return <CitationView />
      case 'tags':
        return (
          <TagsView
            onOpenTag={(tagId) => openLibraryWithFilter({ type: 'tag', tagIds: [tagId] }, 'tags')}
          />
        )
      default:
        return (
          <LibraryView
            onSelectDoc={openDocumentTarget}
            onOpenLibraryAi={openLibraryAi}
            libraryProjects={libraryProjects}
            activeLibraryProjectId={activeLibraryProject?.id}
            onLibraryProjectsChanged={() => void loadLibraryProjectChoices()}
            onLibraryDocumentsMoved={handleLibraryDocumentsMoved}
          />
        )
    }
  }

  const requiredMaintenance = databaseUpgradeDiagnostics?.requiredMaintenance
  const databaseUpgradeProgressPercent = Math.max(0, Math.min(100, Math.round(Number(databaseUpgradeProgress?.progress || 0) * 100)))
  const databaseUpgradeDescription = requiredMaintenance?.required
    ? requiredMaintenance.message
    : '当前文献库需要完成企业级数据库维护后再继续使用。软件会自动跳过已经完成的步骤，只补做仍需要处理的部分。'
  const databaseUpgradePhaseText = databaseUpgradePhase === 'precompact'
    ? '正在先压缩旧数据库'
    : databaseUpgradePhase === 'cleanup'
      ? '正在升级企业级数据库结构'
      : '正在完成最终压缩'
  const databaseUpgradePhaseDescription = databaseUpgradePhase === 'precompact'
    ? '检测到旧数据库中已有可释放空间，正在先压缩旧库，避免带着旧碎片进入新版结构。'
    : databaseUpgradePhase === 'cleanup'
      ? '正在按需清理旧索引、升级新版全文索引，并迁移页面 OCR 大字段。已经完成的步骤会自动跳过。'
      : '正在把本次升级和迁移产生的空闲页真正释放到磁盘。大数据库可能需要较长时间。'

  const renderTabButton = (tab: AppTab) => {
    const active = tab.id === activeTabId
    const closable = !(tab.kind === 'home' && tabs.length <= 1)
    const dragging = tab.id === draggedTabId
    return (
      <Dropdown
        key={tab.id}
        trigger={['contextMenu']}
        overlayClassName="app-tab-context-menu"
        menu={{
          items: getTabContextMenuItems(tab),
          onClick: ({ key }) => handleTabContextMenuClick(tab, String(key)),
        }}
      >
        <button
          type="button"
          className={`app-tab ${active ? 'is-active' : ''} ${dragging ? 'is-dragging-source' : ''}`}
          data-app-tab-kind={tab.kind}
          data-app-tab-id={tab.id}
          data-app-tab-active={active ? 'true' : undefined}
          data-app-tab-context-menu="true"
          title={tab.title}
          onContextMenu={(event) => event.stopPropagation()}
          onClick={(event) => {
            if (suppressTabClickRef.current) {
              event.preventDefault()
              return
            }
            if (tab.id === activeTabId) return
            runWithSettingsLeaveGuard(() => setActiveTabId(tab.id))
          }}
          onPointerDown={(event) => handleTabPointerDown(event, tab.id)}
          onDragStart={(event) => event.preventDefault()}
          onAuxClick={(event) => {
            if (event.button === 1 && closable) closeTab(tab.id)
          }}
        >
          <span className="app-tab-icon">{getTabIcon(tab)}</span>
          <span className="app-tab-title">{tab.title}</span>
          {closable ? (
            <span
              className="app-tab-close"
              role="button"
              aria-label={`关闭 ${tab.title}`}
              draggable={false}
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.id)
              }}
            >
              <CloseOutlined />
            </span>
          ) : null}
        </button>
      </Dropdown>
    )
  }

  const renderTabGroupSettingsPanel = (group: WorkspaceTabGroup) => (
    <div
      className="app-tab-group-settings-panel"
      data-app-tab-group-settings-panel="true"
      onContextMenu={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Input
        className="app-tab-group-settings-name"
        placeholder="为此组命名"
        maxLength={80}
        value={tabGroupSettingsOpenId === group.id ? tabGroupSettingsTitle : group.title}
        onChange={(event) => setTabGroupSettingsTitle(event.target.value)}
        onBlur={() => commitTabGroupSettingsTitle(group.id)}
        onPressEnter={() => commitTabGroupSettingsTitle(group.id)}
      />
      <div className="app-tab-group-settings-colors">
        {TAB_GROUP_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`app-tab-group-settings-color ${group.color === color ? 'is-active' : ''}`}
            style={{ '--app-tab-group-color': color } as React.CSSProperties}
            aria-label={`选择分组颜色 ${color}`}
            onClick={() => updateTabGroupColor(group.id, color)}
          />
        ))}
      </div>
      <div className="app-tab-group-settings-divider" />
      <button
        type="button"
        className="app-tab-group-settings-action"
        onClick={() => openHomeTabInGroup(group.id)}
      >
        在组内添加首页标签
      </button>
      <button
        type="button"
        className="app-tab-group-settings-action"
        onClick={() => toggleTabGroupCollapsed(group.id)}
      >
        {group.collapsed ? '展开分组' : '折叠分组'}
      </button>
      <button
        type="button"
        className="app-tab-group-settings-action"
        onClick={() => closeTabGroup(group.id)}
      >
        关闭分组
      </button>
      <div className="app-tab-group-settings-divider" />
      <button
        type="button"
        className="app-tab-group-settings-action"
        onClick={() => ungroupTabGroup(group.id)}
      >
        取消分组
      </button>
    </div>
  )

  const libraryProjectCreateModal = (
    <Modal
      open={libraryProjectCreateOpen}
      title="新建文献项目"
      okText="创建并进入"
      cancelText="取消"
      centered
      destroyOnHidden
      confirmLoading={libraryProjectCreateBusy}
      okButtonProps={{ disabled: libraryProjectCreateName.trim().length === 0 }}
      onOk={() => void confirmCreateLibraryProject()}
      onCancel={() => {
        if (libraryProjectCreateBusy) return
        setLibraryProjectCreateOpen(false)
        setLibraryProjectCreateName('')
      }}
    >
      <p className="library-project-create-description">
        文献、检索、向量结果和摘录列表会按当前项目隔离加载；以后可以在文献库中批量转移。
      </p>
      <Input
        autoFocus
        maxLength={80}
        placeholder="例如：明清史料、论文资料、待整理"
        value={libraryProjectCreateName}
        onChange={(event) => setLibraryProjectCreateName(event.target.value)}
        onPressEnter={() => void confirmCreateLibraryProject()}
      />
    </Modal>
  )

  if (!workspaceProjectId) {
    return (
      <div className="library-project-gate">
        <div className="library-project-gate-card">
          <div className="library-project-gate-brand">
            <span className="brand-icon">智</span>
            <div>
              <strong>{PRODUCT_NAME}</strong>
              <span>选择本次要加载的文献项目</span>
            </div>
          </div>
          {libraryProjectLoading ? (
            <div className="library-project-gate-loading">
              <Spin size="large" />
              <span>正在读取项目…</span>
            </div>
          ) : libraryProjectError ? (
            <Alert
              type="error"
              showIcon
              message="项目列表加载失败"
              description={libraryProjectError}
              action={<Button onClick={() => void loadLibraryProjectChoices()}>重试</Button>}
            />
          ) : (
            <>
              <div className="library-project-gate-list">
                {libraryProjects.map((project) => (
                  <button
                    type="button"
                    key={project.id}
                    data-library-project-choice="true"
                    className={`library-project-gate-item ${activeLibraryProject?.id === project.id ? 'is-last-active' : ''}`}
                    onClick={() => void activateLibraryProject(project)}
                    disabled={libraryProjectSwitching}
                  >
                    <span className="library-project-gate-item-color" style={{ background: project.color }} />
                    <span className="library-project-gate-item-content">
                      <strong>{project.name}</strong>
                      <span>{project.document_count.toLocaleString()} 篇文献{project.is_default ? ' · 旧版文献默认归入' : ''}</span>
                    </span>
                    {activeLibraryProject?.id === project.id ? <span className="library-project-last-badge">上次使用</span> : null}
                    <RightOutlined />
                  </button>
                ))}
              </div>
              <Button
                className="library-project-gate-create"
                type="dashed"
                size="large"
                block
                icon={<PlusOutlined />}
                onClick={() => setLibraryProjectCreateOpen(true)}
              >
                新建文献项目
              </Button>
            </>
          )}
        </div>
        {libraryProjectCreateModal}
      </div>
    )
  }

  const libraryProjectMenuItems: MenuProps['items'] = [
    ...libraryProjects.map((project) => ({
      key: project.id,
      label: (
        <span className="sidebar-project-menu-item">
          <span className="sidebar-project-dot" style={{ background: project.color }} />
          <span>{project.name}</span>
          <span className="sidebar-project-count">{project.document_count.toLocaleString()}</span>
        </span>
      ),
      disabled: project.id === activeLibraryProject?.id,
    })),
    { type: 'divider' as const },
    { key: '__create_project__', icon: <PlusOutlined />, label: '新建文献项目' },
  ]

  return (
    <Layout className="app-layout">
      <Sider
        width={240}
        collapsedWidth={64}
        collapsible
        collapsed={siderCollapsed}
        onCollapse={setSiderCollapsed}
        className="app-sider"
        trigger={
          <span className={`sider-collapse-trigger ${siderCollapsed ? 'collapsed' : 'expanded'}`}>
            {siderCollapsed ? <RightOutlined /> : <><LeftOutlined /><span>折叠</span></>}
          </span>
        }
      >
        <div className="sidebar-brand">
          <span className="brand-icon">智</span>
          {!siderCollapsed ? <span>{PRODUCT_NAME}</span> : null}
        </div>
        <Dropdown
          trigger={['click']}
          menu={{
            items: libraryProjectMenuItems,
            onClick: ({ key }) => {
              if (key === '__create_project__') {
                setLibraryProjectCreateOpen(true)
                return
              }
              const project = libraryProjects.find((item) => item.id === key)
              if (project) void activateLibraryProject(project)
            },
          }}
        >
          <button
            type="button"
            className={`sidebar-project-switcher ${siderCollapsed ? 'is-collapsed' : ''}`}
            title={activeLibraryProject?.name || '选择文献项目'}
            disabled={libraryProjectSwitching}
          >
            <span className="sidebar-project-dot" style={{ background: activeLibraryProject?.color || '#1677ff' }} />
            {!siderCollapsed ? (
              <>
                <span className="sidebar-project-current">{activeLibraryProject?.name || '选择项目'}</span>
                <DownOutlined />
              </>
            ) : null}
          </button>
        </Dropdown>

        <div className="sider-import" style={{ display: 'none' }}>
          <Button
            type="primary"
            onClick={handleImport}
            block={!siderCollapsed}
            shape={siderCollapsed ? 'circle' : 'default'}
          >
            {!siderCollapsed ? '导入文献' : null}
          </Button>
        </div>

        <Menu
          mode="inline"
          theme="dark"
          selectedKeys={selectedMenuKeys}
          onClick={handleMenuClick}
          items={menuItems}
          className="app-menu"
        />
      </Sider>

      <Layout>
        <Header className="app-header app-tab-header">
          <Popover
            placement="bottomLeft"
            trigger="click"
            open={tabMenuOpen}
            onOpenChange={(open) => {
              setTabMenuOpen(open)
              if (!open) setTabSearchKey('')
            }}
            content={tabMenuContent}
            arrow={false}
            overlayClassName="app-tab-menu-popover"
          >
            <Tooltip title="搜索标签页">
              <Button
                className="app-tab-menu-trigger"
                type="text"
                icon={<DownOutlined />}
                aria-label="打开标签页菜单"
                data-app-tab-menu-trigger="true"
              />
            </Tooltip>
          </Popover>
          <Dropdown
            trigger={['contextMenu']}
            overlayClassName="app-tab-context-menu"
            menu={{
              items: getTabRailContextMenuItems(),
              onClick: handleTabRailContextMenuClick,
            }}
          >
          <div className="app-tab-rail">
            <div
              ref={tabStripRef}
              className={`app-tab-strip ${draggedTabId || draggedTabGroupId ? 'is-dragging' : ''}`}
              data-app-tab-strip="true"
              data-app-tab-density={tabDensity}
              data-app-tab-count={tabs.length}
              data-app-tab-visible-count={visibleTabCount}
              style={{
                '--app-tab-strip-ideal-width': `${tabStripIdealWidth}px`,
                '--app-tab-slot-width': `${tabSlotWidth}px`,
              } as React.CSSProperties}
            >
              <div
                ref={tabDropIndicatorRef}
                className="app-tab-drop-indicator"
                data-app-tab-drop-indicator="true"
                aria-hidden="true"
              />
              {tabStripItems.map((item) => {
                if (item.type === 'group') {
                  return (
                    <div
                      key={`group:${item.group.id}`}
                      className={`app-tab-group-segment ${item.group.collapsed ? 'is-collapsed' : ''} ${item.active ? 'is-active' : ''} ${justCreatedTabGroupId === item.group.id ? 'is-just-created' : ''}`}
                      data-app-tab-group-dragging={draggedTabGroupId === item.group.id ? 'true' : undefined}
                      data-app-tab-group-drop-target={item.group.id}
                      data-app-tab-group-id={item.group.id}
                      data-app-tab-group-collapsed={item.group.collapsed ? 'true' : undefined}
                      data-app-tab-group-just-created={justCreatedTabGroupId === item.group.id ? 'true' : undefined}
                      style={{
                        '--app-tab-group-color': item.group.color,
                        '--app-tab-group-segment-width': `${getExpandedTabGroupWidth(item.tabs.length, tabSlotWidth, tabDensity)}px`,
                      } as React.CSSProperties}
                    >
                      <Popover
                        trigger="contextMenu"
                        placement="bottomLeft"
                        arrow={false}
                        overlayClassName="app-tab-group-settings-popover"
                        content={renderTabGroupSettingsPanel(item.group)}
                        open={tabGroupSettingsOpenId === item.group.id}
                        onOpenChange={(open) => {
                          setTabGroupSettingsOpenId(open ? item.group.id : null)
                          setTabGroupSettingsTitle(open ? item.group.title : '')
                        }}
                      >
                        <button
                          type="button"
                          className={`app-tab-group-chip ${item.group.collapsed ? 'is-collapsed' : ''} ${item.active ? 'is-active' : ''}`}
                          title={`${item.group.collapsed ? '展开' : '折叠'} ${item.group.title}`}
                          aria-label={`${item.group.collapsed ? '展开' : '折叠'} ${item.group.title}`}
                          onContextMenu={(event) => event.stopPropagation()}
                          onPointerDown={(event) => handleTabGroupPointerDown(event, item.group.id)}
                          onClick={(event) => {
                            if (suppressTabClickRef.current) {
                              event.preventDefault()
                              return
                            }
                            toggleTabGroupCollapsed(item.group.id)
                          }}
                        >
                          <span className="app-tab-group-toggle">
                            {item.group.collapsed ? <RightOutlined /> : <DownOutlined />}
                          </span>
                          <span className="app-tab-group-title">{item.group.title}</span>
                          <span className="app-tab-group-count">{item.tabCount}</span>
                        </button>
                      </Popover>
                      {item.group.collapsed ? null : item.tabs.map((tab) => renderTabButton(tab))}
                    </div>
                  )
                }
                return renderTabButton(item.tab)
              })}
            </div>
            <Tooltip title="首页">
              <Button
                className="app-tab-new"
                type="text"
                size="small"
                icon={<PlusOutlined />}
                onClick={ensureHomeTab}
                aria-label="打开首页标签"
              />
            </Tooltip>
          </div>
          </Dropdown>
        </Header>

        <Content className="app-content">
          <Suspense key={workspaceProjectId} fallback={<ViewLoadingFallback />}>
            {renderView()}
          </Suspense>
        </Content>
      </Layout>

      <Modal
        open={!!renamingTabGroupId}
        title="重命名分组"
        okText="保存"
        cancelText="取消"
        centered
        destroyOnHidden
        onOk={confirmRenameTabGroup}
        okButtonProps={{ disabled: renamingTabGroupTitle.trim().length === 0 }}
        onCancel={() => {
          setRenamingTabGroupId(null)
          setRenamingTabGroupTitle('')
        }}
      >
        <Input
          autoFocus
          maxLength={80}
          value={renamingTabGroupTitle}
          onChange={(event) => setRenamingTabGroupTitle(event.target.value)}
          onPressEnter={confirmRenameTabGroup}
        />
      </Modal>
      {libraryProjectCreateModal}

      <Modal
        open={databaseUpgradeVisible}
        title={requiredMaintenance?.title || '需要升级文献库数据库'}
        closable={false}
        maskClosable={false}
        keyboard={false}
        width={620}
        footer={[
          <Button key="quit" danger onClick={handleQuitForDatabaseUpgrade} disabled={databaseUpgradeBusy}>
            退出软件
          </Button>,
          <Button key="upgrade" type="primary" loading={databaseUpgradeBusy} onClick={() => void handleRequiredDatabaseUpgrade()}>
            {requiredMaintenance?.actionLabel || '升级并压缩数据库'}
          </Button>,
        ]}
      >
        <Alert
          type="warning"
          showIcon
          message="当前文献库需要完成数据库升级后再继续使用"
          description={databaseUpgradeDescription}
          style={{ marginBottom: 12 }}
        />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 12 }}>
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>旧 ngram 行数</div>
            <strong>{formatDatabaseUpgradeCount(databaseUpgradeDiagnostics?.searchIndex.ngramRows)}</strong>
          </div>
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>旧单字索引</div>
            <strong>{formatDatabaseUpgradeCount(databaseUpgradeDiagnostics?.searchIndex.singleCharNgramRows)}</strong>
          </div>
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>旧位置数据</div>
            <strong>{formatDatabaseUpgradeBytes(databaseUpgradeDiagnostics?.searchIndex.ngramPositionsBytes)}</strong>
          </div>
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>新版全文索引</div>
            <strong>{databaseUpgradeDiagnostics?.searchIndex.enterpriseSearchMigrationRecommended ? '待升级' : '已就绪'}</strong>
          </div>
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>待迁移大字段</div>
            <strong>{formatDatabaseUpgradeBytes(databaseUpgradeDiagnostics?.storageLayers?.find((layer) => layer.kind === 'document-text')?.estimatedBytes)}</strong>
          </div>
          <div style={{ padding: 10, borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>可压缩空间</div>
            <strong>{formatDatabaseUpgradeBytes(databaseUpgradeDiagnostics?.freelistBytes)}</strong>
          </div>
        </div>
        {databaseUpgradeProgress && (databaseUpgradeProgress.status === 'processing' || databaseUpgradeProgress.status === 'queued') ? (
          <div style={{ marginTop: 8 }}>
            <Progress percent={databaseUpgradeProgressPercent} status="active" />
            <div style={{ fontSize: 12, color: 'var(--gs-text-secondary)' }}>
              {databaseUpgradeProgress.message || '正在分批清理旧搜索索引'}
            </div>
          </div>
        ) : null}
        {databaseUpgradeBusy && databaseUpgradePhase === 'compact' ? (
          <Alert
            type="info"
            showIcon
            message={databaseUpgradePhaseText}
            description={databaseUpgradePhaseDescription}
            style={{ marginTop: 12 }}
          />
        ) : null}
        {databaseUpgradeBusy && databaseUpgradePhase === 'precompact' ? (
          <Alert
            type="info"
            showIcon
            message={databaseUpgradePhaseText}
            description={databaseUpgradePhaseDescription}
            style={{ marginTop: 12 }}
          />
        ) : null}
        {databaseUpgradeBusy && databaseUpgradePhase === 'cleanup' ? (
          <Alert
            type="info"
            showIcon
            message={databaseUpgradePhaseText}
            description={databaseUpgradePhaseDescription}
            style={{ marginTop: 12 }}
          />
        ) : null}
      </Modal>

      {onboardingVisible ? (
        <Suspense fallback={null}>
          <OnboardingWizard />
        </Suspense>
      ) : null}

      {showFloatingActions ? (
        <div
          className="import-float-button"
          title="导入文献：支持拖拽文件或文件夹"
          onClick={() => void handleImport()}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={async (event) => {
            event.preventDefault()
            const result = await window.api.grantDroppedImportSources(Array.from(event.dataTransfer.files))
            if (result.ok) {
              handleDroppedImport(result.value)
            } else if (result.error.code !== 'CAPABILITY_INVALID_REQUEST') {
              message.error(result.error.message)
            }
          }}
        >
          <PlusOutlined />
        </div>
      ) : null}

      {showFloatingActions ? (
        <div
          ref={aiButtonRef}
          className="ai-float-button-rect"
          title="打开 AI 助手"
          style={{ transform: `translate(${btnPosRef.current.x}px, ${btnPosRef.current.y}px)` }}
          onMouseDown={(event) => {
            event.preventDefault()
            btnDragState.current.moved = false
            btnDragState.current.timer = setTimeout(() => {
              btnDragState.current.isDragging = true
              btnDragState.current.startX = event.clientX
              btnDragState.current.startY = event.clientY
              btnDragState.current.btnX = btnPosRef.current.x
              btnDragState.current.btnY = btnPosRef.current.y
              if (aiButtonRef.current) {
                aiButtonRef.current.style.transition = 'none'
                aiButtonRef.current.style.transform = `translate(${btnPosRef.current.x}px, ${btnPosRef.current.y}px) scale(1.05)`
              }
              document.body.style.cursor = 'grabbing'
            }, 200)
          }}
          onClick={() => {
            if (!btnDragState.current.moved) {
              openLibraryAi({
                question: '',
                researchProjectId: activeViewKey === 'research' ? activeResearchProjectId : null,
              })
            }
          }}
        >
          AI
        </div>
      ) : null}

      <div
        ref={floatingPanelRef}
        className={`ai-floating-panel ${!libraryAiOpen ? 'hidden' : ''}`}
        style={{
          transform: `translate(${panelState.current.x}px, ${panelState.current.y}px)`,
          width: panelState.current.w,
          height: panelState.current.h
        }}
      >
        {['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((dir) => (
          <div key={dir} className={`resize-handle ${dir}`} onMouseDown={(event) => handleResizeStart(event, dir)} />
        ))}

        <div className="ai-floating-panel-header" onMouseDown={handlePanelDragStart}>
          <div className="ai-floating-panel-title">
            <RobotOutlined style={{ color: 'var(--gs-gold)' }} />
            <span>文库 AI 助手</span>
          </div>
          <Button
            type="text"
            icon={<CloseOutlined />}
            size="small"
            style={{ color: 'var(--gs-text-secondary)' }}
            onClick={() => setLibraryAiOpen(false)}
          />
        </div>

        <div style={{ padding: '8px 16px', height: 'calc(100% - 48px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {libraryAiOpen ? (
            <Suspense fallback={<ViewLoadingFallback />}>
              <AiPanel
                mode="library"
                initialQuestion={libraryAiQuestion}
                initialScope={libraryAiScope}
                initialScopeLabel={libraryAiScopeLabel}
                initialTab={libraryAiInitialTab}
                initialResearchProjectId={libraryAiResearchProjectId}
                onOpenDocument={openDocumentTarget}
              />
            </Suspense>
          ) : null}
        </div>
      </div>
    </Layout>
  )
}

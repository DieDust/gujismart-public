import { useEffect, useMemo, useRef, useState } from 'react'
import { lazy, Suspense, useLayoutEffect } from 'react'
import { Alert, Button, Input, Layout, Menu, Modal, Popover, Progress, Spin, Tooltip, message } from 'antd'
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
import { useOnboardingStore } from './stores/useOnboardingStore'
import { clampAiButtonPosition, clampFloatingPanelState, getDefaultFloatingPanelState } from './utils/floatingViewport'
import {
  loadAppWorkspace,
  saveAppWorkspace,
  type WorkspaceAppTab,
  type WorkspaceFoldersState,
  type WorkspaceViewKey,
} from './utils/appWorkspace'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from './utils/shortcuts'
import type { AppUpdateInfo, BackgroundTaskProgressEvent, DatabaseStorageDiagnostics, LibraryAiOpenPayload, LibraryAiScope, LibraryAiTab, LibraryFilter, OpenDocumentTarget, SettingsMap } from '@shared/types'
import { PRODUCT_NAME } from '@shared/types'
import './styles/app.css'

const { Sider, Content, Header } = Layout

type ViewKey = 'welcome' | 'library' | 'folders' | 'settings' | 'dashboard' | 'search' | 'citation' | 'tags' | 'research' | 'excerpts'
type AppViewKey = WorkspaceViewKey
type MenuItem = Required<MenuProps>['items'][number]
type DatabaseUpgradePhase = 'idle' | 'precompact' | 'cleanup' | 'compact'
type TabDropPosition = 'before' | 'after'
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
}
type OpenDocumentDisposition = 'current-tab' | 'new-foreground-tab'
type OpenDocumentOptions = {
  disposition?: OpenDocumentDisposition
  title?: string
}
type OpenDocumentHandler = (target: OpenDocumentTarget | string, options?: OpenDocumentOptions) => void
type LibraryDroppedImportRequest = {
  id: number
  paths: string[]
  folderId?: string | null
}
type FoldersViewState = WorkspaceFoldersState
type AppTab = WorkspaceAppTab

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
const TAB_DRAG_AUTO_SCROLL_EDGE = 52
const TAB_PREFERRED_WIDTH = 210
const TAB_STRIP_GAP = 6
const TAB_STRIP_HORIZONTAL_PADDING = 16
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

function createHomeTab(): AppTab {
  return { id: HOME_TAB_ID, kind: 'home', title: '首页' }
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
  return hasConfiguredText(settings.paddleocr_api_key)
}

function hasAiConfig(settings: SettingsMap): boolean {
  return hasConfiguredText(settings.llm_api_key)
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
  const [activeTabId, setActiveTabId] = useState(() => initialWorkspace.activeTabId)
  const [tabMenuOpen, setTabMenuOpen] = useState(false)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [shortcuts, setShortcuts] = useState<ShortcutMap | null>(null)
  const [siderCollapsed, setSiderCollapsed] = useState(() => initialWorkspace.siderCollapsed)
  const [tabSearchKey, setTabSearchKey] = useState('')
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
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [databaseUpgradeDiagnostics, setDatabaseUpgradeDiagnostics] = useState<DatabaseStorageDiagnostics | null>(null)
  const [databaseUpgradeVisible, setDatabaseUpgradeVisible] = useState(false)
  const [databaseUpgradeBusy, setDatabaseUpgradeBusy] = useState(false)
  const [databaseUpgradePhase, setDatabaseUpgradePhase] = useState<DatabaseUpgradePhase>('idle')
  const [databaseUpgradeProgress, setDatabaseUpgradeProgress] = useState<BackgroundTaskProgressEvent | null>(null)
  const onboardingVisible = useOnboardingStore((state) => state.visible)
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId) || tabs[0] || createHomeTab(), [activeTabId, tabs])
  const activeViewKey: ViewKey = activeTab.kind === 'home'
    ? 'welcome'
    : activeTab.kind === 'view'
    ? activeTab.view
    : 'library'
  const activeDocumentTab = activeTab.kind === 'document' ? activeTab : null
  const showFloatingActions = activeTab.kind !== 'document' && !libraryAiOpen
  const selectedMenuKeys = activeTab.kind === 'view' ? [activeTab.view] : []
  const tabStripIdealWidth = (
    tabs.length * TAB_PREFERRED_WIDTH
    + Math.max(0, tabs.length - 1) * TAB_STRIP_GAP
    + TAB_STRIP_HORIZONTAL_PADDING
  )
  const filteredTabs = useMemo(() => {
    const keyword = tabSearchKey.trim().toLocaleLowerCase()
    if (!keyword) return tabs
    return tabs.filter((tab) => tab.title.toLocaleLowerCase().includes(keyword))
  }, [tabSearchKey, tabs])

  useEffect(() => {
    saveAppWorkspace(window.localStorage, {
      tabs,
      activeTabId,
      siderCollapsed,
    })
  }, [activeTabId, siderCollapsed, tabs])

  useEffect(() => {
    const saveBeforeUnload = () => {
      saveAppWorkspace(window.localStorage, {
        tabs,
        activeTabId,
        siderCollapsed,
      })
    }
    window.addEventListener('beforeunload', saveBeforeUnload)
    return () => window.removeEventListener('beforeunload', saveBeforeUnload)
  }, [activeTabId, siderCollapsed, tabs])

  const settingsViewRef = useRef<SettingsViewHandle>(null)
  const floatingPanelRef = useRef<HTMLDivElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const suppressTabClickRef = useRef(false)
  const tabsRef = useRef(tabs)
  const tabPointerDragRef = useRef<AppTabPointerDrag | null>(null)
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
      setTabs((current) => {
        if (current.some((tab) => tab.id === HOME_TAB_ID)) return current
        return [createHomeTab(), ...current]
      })
      setActiveTabId(HOME_TAB_ID)
    })
  }

  const openViewTab = (
    view: AppViewKey,
    options: { forceNew?: boolean; foldersState?: FoldersViewState | null; initialSearchKeyword?: string } = {},
  ) => {
    runWithSettingsLeaveGuard(() => {
      const singleton = SINGLETON_VIEW_KEYS.has(view) && !options.forceNew
      if (singleton) {
        const tabId = `view:${view}`
        setTabs((current) => (
          current.some((tab) => tab.id === tabId)
            ? current
            : [...current, { id: tabId, kind: 'view', view, title: VIEW_TITLES[view], singleton: true }]
        ))
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
      }
      setTabs((current) => [...current, nextTab])
      setActiveTabId(tabId)
    })
  }

  const focusOrCreateLibraryTab = () => {
    const tabId = 'view:library'
    setTabs((current) => (
      current.some((tab) => tab.id === tabId)
        ? current
        : [...current, { id: tabId, kind: 'view', view: 'library', title: VIEW_TITLES.library, singleton: true }]
    ))
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

  const handleDroppedImport = (paths: string[], folderId?: string | null) => {
    runWithSettingsLeaveGuard(() => {
      focusOrCreateLibraryTab()
      setLibraryFilter(folderId ? { type: 'folder', value: folderId } : { type: 'all' })
      setLibraryFocusSection(folderId ? 'folders' : undefined)
      setLibraryDroppedImportRequest({
        id: libraryDroppedImportSeqRef.current += 1,
        paths,
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
    void window.api.getDocument(docId)
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
    }
    setTabs((current) => [...current, nextTab])
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

  const closeTab = (tabId: string) => {
    const close = () => {
      setTabs((current) => {
        const closingIndex = current.findIndex((tab) => tab.id === tabId)
        if (closingIndex < 0) return current
        const nextTabs = current.filter((tab) => tab.id !== tabId)
        if (nextTabs.length === 0) {
          setActiveTabId(HOME_TAB_ID)
          return [createHomeTab()]
        }
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

  const captureTabLayout = () => {
    const layout = new Map<string, number>()
    tabStripRef.current?.querySelectorAll<HTMLElement>('[data-app-tab-id]').forEach((element) => {
      const tabId = element.dataset.appTabId
      if (tabId) layout.set(tabId, element.getBoundingClientRect().left)
    })
    return layout
  }

  const scheduleTabDragFrame = () => {
    if (tabDragFrameRef.current !== null) return
    tabDragFrameRef.current = window.requestAnimationFrame(() => {
      tabDragFrameRef.current = null
      const drag = tabPointerDragRef.current
      const strip = tabStripRef.current
      if (!drag?.moved || !strip) return

      const stripBounds = strip.getBoundingClientRect()
      const leftEdgeDistance = drag.clientX - stripBounds.left
      const rightEdgeDistance = stripBounds.right - drag.clientX
      let scrollVelocity = 0
      if (leftEdgeDistance < TAB_DRAG_AUTO_SCROLL_EDGE) {
        scrollVelocity = -Math.ceil((TAB_DRAG_AUTO_SCROLL_EDGE - Math.max(0, leftEdgeDistance)) / 4)
      } else if (rightEdgeDistance < TAB_DRAG_AUTO_SCROLL_EDGE) {
        scrollVelocity = Math.ceil((TAB_DRAG_AUTO_SCROLL_EDGE - Math.max(0, rightEdgeDistance)) / 4)
      }
      if (scrollVelocity !== 0) strip.scrollLeft += scrollVelocity

      const previewLeft = Math.min(
        Math.max(6, drag.clientX - drag.grabOffsetX),
        Math.max(6, window.innerWidth - drag.width - 6),
      )
      const previewTop = Math.min(
        Math.max(6, drag.top - 2),
        Math.max(6, window.innerHeight - drag.height - 6),
      )
      drag.previewElement?.style.setProperty(
        'transform',
        `translate3d(${previewLeft}px, ${previewTop}px, 0)`,
      )

      const desiredCenter = drag.clientX - drag.grabOffsetX + drag.width / 2
      const otherTabs = Array.from(strip.querySelectorAll<HTMLElement>('[data-app-tab-id]'))
        .filter((element) => element.dataset.appTabId !== drag.tabId)
      let target: { tabId: string; position: TabDropPosition } | null = null
      for (const element of otherTabs) {
        const tabId = element.dataset.appTabId
        if (!tabId) continue
        const bounds = element.getBoundingClientRect()
        if (desiredCenter < bounds.left + bounds.width / 2) {
          target = { tabId, position: 'before' }
          break
        }
        target = { tabId, position: 'after' }
      }

      if (target) {
        const currentTabs = tabsRef.current
        const nextTabs = reorderAppTabs(currentTabs, drag.tabId, target.tabId, target.position)
        if (nextTabs !== currentTabs) {
          pendingTabLayoutRef.current = captureTabLayout()
          tabsRef.current = nextTabs
          setTabs(nextTabs)
          scheduleTabDragFrame()
          return
        }
      }
      if (scrollVelocity !== 0) scheduleTabDragFrame()
    })
  }

  const finishTabPointerDrag = () => {
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
    tabPointerDragRef.current = null
    document.body.classList.remove('is-app-tab-dragging')

    if (!drag?.moved) {
      suppressTabClickRef.current = false
      return
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
          setDraggedTabId(null)
        })
    } else {
      previewElement?.remove()
      setDraggedTabId(null)
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
    }

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = tabPointerDragRef.current
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
      pointerEvent.preventDefault()
      scheduleTabDragFrame()
    }
    const handlePointerEnd = (pointerEvent: PointerEvent) => {
      const drag = tabPointerDragRef.current
      if (!drag || pointerEvent.pointerId !== drag.pointerId) return
      finishTabPointerDrag()
    }
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
    tabPointerCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }
  }

  useLayoutEffect(() => {
    const previousLayout = pendingTabLayoutRef.current
    const strip = tabStripRef.current
    if (!previousLayout || !strip) return
    pendingTabLayoutRef.current = null
    const draggingId = tabPointerDragRef.current?.tabId
    strip.querySelectorAll<HTMLElement>('[data-app-tab-id]').forEach((element) => {
      const tabId = element.dataset.appTabId
      if (!tabId || tabId === draggingId) return
      const previousLeft = previousLayout.get(tabId)
      if (previousLeft === undefined) return
      const deltaX = previousLeft - element.getBoundingClientRect().left
      if (Math.abs(deltaX) < 0.5) return
      tabReorderAnimationsRef.current.get(tabId)?.cancel()
      const animation = element.animate(
        [
          { transform: `translate3d(${deltaX}px, 0, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 170, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      )
      tabReorderAnimationsRef.current.set(tabId, animation)
      animation.addEventListener('finish', () => {
        if (tabReorderAnimationsRef.current.get(tabId) === animation) {
          tabReorderAnimationsRef.current.delete(tabId)
        }
      }, { once: true })
    })
  }, [tabs])

  useEffect(() => () => {
    tabPointerCleanupRef.current?.()
    if (tabDragFrameRef.current !== null) window.cancelAnimationFrame(tabDragFrameRef.current)
    tabReorderAnimationsRef.current.forEach((animation) => animation.cancel())
    tabPointerDragRef.current?.previewElement?.remove()
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
        window.close()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activeDocumentTab, shortcuts])

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
    if (tab.id === activeTabId) return
    runWithSettingsLeaveGuard(() => setActiveTabId(tab.id))
  }

  const selectFirstFilteredTab = () => {
    const firstMatch = filteredTabs[0]
    if (firstMatch) selectTabFromMenu(firstMatch)
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
          revealToc={!!target.revealToc}
          highlightExcerpt={target.highlightExcerpt || ''}
          highlightColor={target.highlightColor || ''}
          sourceLabel={target.sourceLabel || ''}
          startReaderBookTranslation={!!target.startReaderBookTranslation}
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
        return <LibraryView onSelectDoc={openDocumentTarget} onOpenLibraryAi={openLibraryAi} />
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
          <div className="app-tab-rail">
            <div
              ref={tabStripRef}
              className={`app-tab-strip ${draggedTabId ? 'is-dragging' : ''}`}
              data-app-tab-strip="true"
              style={{ '--app-tab-strip-ideal-width': `${tabStripIdealWidth}px` } as React.CSSProperties}
            >
              {tabs.map((tab) => {
                const active = tab.id === activeTabId
                const closable = !(tab.kind === 'home' && tabs.length <= 1)
                const dragging = tab.id === draggedTabId
                return (
                  <button
                    key={tab.id}
                    type="button"
                    className={`app-tab ${active ? 'is-active' : ''} ${dragging ? 'is-dragging-source' : ''}`}
                    data-app-tab-kind={tab.kind}
                    data-app-tab-id={tab.id}
                    data-app-tab-active={active ? 'true' : undefined}
                    title={tab.title}
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
                )
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
        </Header>

        <Content className="app-content">
          <Suspense fallback={<ViewLoadingFallback />}>
            {renderView()}
          </Suspense>
        </Content>
      </Layout>

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
          onDrop={(event) => {
            event.preventDefault()
            const paths = Array.from(event.dataTransfer.files)
              .map((file) => window.api.getPathForFile(file))
              .filter((filePath): filePath is string => !!filePath)
            if (paths.length > 0) {
              handleDroppedImport(Array.from(new Set(paths)))
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

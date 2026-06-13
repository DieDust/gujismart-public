import { useEffect, useMemo, useRef, useState } from 'react'
import { lazy, Suspense } from 'react'
import { Badge, Button, Input, Layout, Menu, Modal, Spin, Tooltip, message } from 'antd'
import {
  BookOutlined,
  CloseOutlined,
  DashboardOutlined,
  FileTextOutlined,
  FileSearchOutlined,
  FormatPainterOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReadOutlined,
  LeftOutlined,
  RightOutlined,
  RobotOutlined,
  SearchOutlined,
  SettingOutlined,
  TagsOutlined
} from '@ant-design/icons'
import type { MenuProps } from 'antd'
import LlmProfileSelector from './components/LlmProfileSelector'
import type { SettingsViewHandle } from './views/SettingsView'
import WelcomeView from './views/WelcomeView'
import { useFolderStore } from './stores/useFolderStore'
import { useOnboardingStore } from './stores/useOnboardingStore'
import { hasShortcutBlockingOverlay, isEditableShortcutTarget, loadShortcutSettings, SHORTCUTS_CHANGED_EVENT, shortcutMatches, type ShortcutMap } from './utils/shortcuts'
import type { AppUpdateInfo, LibraryAiOpenPayload, LibraryAiScope, LibraryAiTab, LibraryFilter, OpenDocumentTarget } from '@shared/types'
import { PRODUCT_NAME } from '@shared/types'
import './styles/app.css'

const { Sider, Content, Header } = Layout

type ViewKey = 'welcome' | 'library' | 'settings' | 'dashboard' | 'search' | 'citation' | 'tags' | 'research' | 'excerpts'
type MenuItem = Required<MenuProps>['items'][number]
type LibraryDroppedImportRequest = {
  id: number
  paths: string[]
}

const AiPanel = lazy(() => import('./components/AiPanel'))
const OnboardingWizard = lazy(() => import('./components/OnboardingWizard'))
const CitationView = lazy(() => import('./views/CitationView'))
const DashboardView = lazy(() => import('./views/DashboardView'))
const DocumentView = lazy(() => import('./views/DocumentView'))
const ExcerptsView = lazy(() => import('./views/ExcerptsView'))
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

export default function App() {
  const [currentView, setCurrentView] = useState<ViewKey>('welcome')
  const [currentDocId, setCurrentDocId] = useState<string | null>(null)
  const [shortcuts, setShortcuts] = useState<ShortcutMap | null>(null)
  const [initialPageIndex, setInitialPageIndex] = useState(0)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [documentSourceId, setDocumentSourceId] = useState<string | undefined>(undefined)
  const [documentSearchSession, setDocumentSearchSession] = useState<OpenDocumentTarget['searchSession'] | undefined>(undefined)
  const [documentLocator, setDocumentLocator] = useState<OpenDocumentTarget['locator'] | undefined>(undefined)
  const [documentRevealToc, setDocumentRevealToc] = useState(false)
  const [documentHighlightExcerpt, setDocumentHighlightExcerpt] = useState('')
  const [documentHighlightColor, setDocumentHighlightColor] = useState('')
  const [documentSourceLabel, setDocumentSourceLabel] = useState('')
  const [documentStartReaderBookTranslation, setDocumentStartReaderBookTranslation] = useState(false)
  const [siderCollapsed, setSiderCollapsed] = useState(false)
  const [headerSearchKey, setHeaderSearchKey] = useState('')
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>({ type: 'all' })
  const [libraryFocusSection, setLibraryFocusSection] = useState<'tags' | 'folders' | 'smart' | undefined>(undefined)
  const [libraryAiOpen, setLibraryAiOpen] = useState(false)
  const [libraryImportRequest, setLibraryImportRequest] = useState(0)
  const [libraryDroppedImportRequest, setLibraryDroppedImportRequest] = useState<LibraryDroppedImportRequest | null>(null)
  const [libraryAiQuestion, setLibraryAiQuestion] = useState('')
  const [libraryAiScope, setLibraryAiScope] = useState<LibraryAiScope | undefined>(undefined)
  const [libraryAiScopeLabel, setLibraryAiScopeLabel] = useState('')
  const [libraryAiInitialTab, setLibraryAiInitialTab] = useState<LibraryAiTab>('qa')
  const [settingsDirty, setSettingsDirty] = useState(false)
  const onboardingVisible = useOnboardingStore((state) => state.visible)
  const showGlobalHeader = !currentDocId && currentView !== 'library'

  const settingsViewRef = useRef<SettingsViewHandle>(null)
  const floatingPanelRef = useRef<HTMLDivElement>(null)
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
    panelState.current.x = window.innerWidth - 420 - 24
    panelState.current.y = 80
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
    const handlePanelMouseMove = (event: MouseEvent) => {
      if (!floatingPanelRef.current) return

      if (draggingPanel.current) {
        const dx = event.clientX - interactStart.current.mouseX
        const dy = event.clientY - interactStart.current.mouseY
        const newX = interactStart.current.panelX + dx
        const newY = interactStart.current.panelY + dy
        panelState.current.x = newX
        panelState.current.y = newY
        schedulePanelStyle({ x: newX, y: newY })
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

        panelState.current = { x: panelX, y: panelY, w: panelW, h: panelH }
        schedulePanelStyle({ x: panelX, y: panelY, w: panelW, h: panelH })
      }

      if (btnDragState.current.isDragging && aiButtonRef.current) {
        btnDragState.current.moved = true
        const dx = event.clientX - btnDragState.current.startX
        const dy = event.clientY - btnDragState.current.startY
        const newX = btnDragState.current.btnX + dx
        const newY = btnDragState.current.btnY + dy
        btnPosRef.current = { x: newX, y: newY }
        aiButtonRef.current.style.transform = `translate(${newX}px, ${newY}px) scale(1.05)`
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
        if (aiButtonRef.current) {
          aiButtonRef.current.style.transition = ''
          aiButtonRef.current.style.transform = `translate(${btnPosRef.current.x}px, ${btnPosRef.current.y}px)`
        }
        document.body.style.cursor = ''
        setTimeout(() => {
          btnDragState.current.moved = false
        }, 50)
      }
    }

    document.addEventListener('mousemove', handlePanelMouseMove)
    document.addEventListener('mouseup', handlePanelMouseUp)
    return () => {
      if (panelFrameRef.current != null) window.cancelAnimationFrame(panelFrameRef.current)
      pendingPanelStyleRef.current = null
      document.removeEventListener('mousemove', handlePanelMouseMove)
      document.removeEventListener('mouseup', handlePanelMouseUp)
    }
  }, [])

  const menuItems: MenuItem[] = useMemo(() => ([
    { key: 'library', icon: <BookOutlined />, label: '文献库' },
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
    if (currentView !== 'settings' || !settingsDirty) {
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

  const handleMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === currentView) return
    runWithSettingsLeaveGuard(() => {
      setCurrentDocId(null)
      setInitialPageIndex(0)
      setSearchKeyword('')
      setCurrentView(key as ViewKey)

      if (key === 'library') {
        setLibraryFocusSection(undefined)
      }
    })
  }

  const handleImport = async () => {
    runWithSettingsLeaveGuard(() => {
      setCurrentDocId(null)
      setCurrentView('library')
      setLibraryFilter({ type: 'all' })
      setLibraryFocusSection(undefined)
      setLibraryImportRequest((value) => value + 1)
    })
  }

  const handleDroppedImport = (paths: string[]) => {
    runWithSettingsLeaveGuard(() => {
      setCurrentDocId(null)
      setCurrentView('library')
      setLibraryFilter({ type: 'all' })
      setLibraryFocusSection(undefined)
      setLibraryDroppedImportRequest({
        id: libraryDroppedImportSeqRef.current += 1,
        paths,
      })
    })
  }

  const openLibraryWithFilter = (nextFilter: LibraryFilter, focusSection: 'tags' | 'folders' | 'smart' = 'tags') => {
    runWithSettingsLeaveGuard(() => {
      setCurrentDocId(null)
      setInitialPageIndex(0)
      setSearchKeyword('')
      setLibraryFilter(nextFilter)
      setLibraryFocusSection(focusSection)
      setCurrentView('library')
    })
  }

  const openLibraryAi = (payload?: string | LibraryAiOpenPayload) => {
    const normalized = typeof payload === 'string' ? { question: payload } : (payload || {})
    setLibraryAiQuestion(normalized.question || '')
    setLibraryAiScope(normalized.scope)
    setLibraryAiScopeLabel(normalized.scopeLabel || '')
    setLibraryAiInitialTab(normalized.initialTab || 'qa')
    setLibraryAiOpen(true)
  }

  const openDocumentTarget = (target: OpenDocumentTarget | string) => {
    const normalized = typeof target === 'string' ? { docId: target } : target
    const explicitPageIndex = normalized.locator?.pageIndex ?? normalized.pageIndex
    setCurrentDocId(normalized.docId)
    setInitialPageIndex(Math.max(0, explicitPageIndex ?? 0))
    setSearchKeyword(normalized.keyword || normalized.highlightExcerpt || normalized.locator?.queryTerm || normalized.excerpt?.slice(0, 40) || '')
    setDocumentSourceId(normalized.sourceId)
    setDocumentSearchSession(normalized.searchSession)
    setDocumentLocator(normalized.locator)
    setDocumentRevealToc(!!normalized.revealToc)
    setDocumentHighlightExcerpt(normalized.highlightExcerpt || '')
    setDocumentHighlightColor(normalized.highlightColor || '')
    setDocumentSourceLabel(normalized.sourceLabel || '')
    setDocumentStartReaderBookTranslation(!!normalized.startReaderBookTranslation)
  }

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
    if (!shortcuts || currentDocId) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasShortcutBlockingOverlay() || isEditableShortcutTarget(event.target)) return
      if (shortcutMatches(event, shortcuts.back)) {
        event.preventDefault()
        window.close()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentDocId, shortcuts])

  useEffect(() => {
    if (!window.api) return
    window.__smokeOpenDocument = openDocumentTarget
    return () => {
      delete window.__smokeOpenDocument
    }
  }, [])

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

  const renderView = () => {
    if (currentDocId) {
      return (
        <DocumentView
          documentId={currentDocId}
          initialPageIndex={initialPageIndex}
          searchKeyword={searchKeyword}
          sourceId={documentSourceId}
          searchSession={documentSearchSession}
          locator={documentLocator}
          revealToc={documentRevealToc}
          highlightExcerpt={documentHighlightExcerpt}
          highlightColor={documentHighlightColor}
          sourceLabel={documentSourceLabel}
          startReaderBookTranslation={documentStartReaderBookTranslation}
          onOpenDocument={openDocumentTarget}
          onBack={() => {
            setCurrentDocId(null)
            setInitialPageIndex(0)
            setSearchKeyword('')
            setDocumentSourceId(undefined)
            setDocumentSearchSession(undefined)
            setDocumentLocator(undefined)
            setDocumentRevealToc(false)
            setDocumentHighlightExcerpt('')
            setDocumentHighlightColor('')
            setDocumentSourceLabel('')
            setDocumentStartReaderBookTranslation(false)
          }}
        />
      )
    }

    switch (currentView) {
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
      case 'settings':
        return <SettingsView ref={settingsViewRef} onDirtyChange={setSettingsDirty} />
      case 'research':
        return (
          <ResearchView
            onOpenDocument={openDocumentTarget}
          />
        )
      case 'excerpts':
        return (
          <ExcerptsView
            onOpenDocument={openDocumentTarget}
          />
        )
      case 'welcome':
        return <WelcomeView onImport={handleImport} onNavigate={setCurrentView} />
      case 'dashboard':
        return <DashboardView />
      case 'search':
        return (
          <SearchView
            onSelectDoc={openDocumentTarget}
            initialKeyword={headerSearchKey}
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
          selectedKeys={[currentView]}
          onClick={handleMenuClick}
          items={menuItems}
          className="app-menu"
        />
      </Sider>

      <Layout>
        {showGlobalHeader ? (
          <Header className="app-header">
            <div className="header-left">
              <Input
                placeholder="搜索文献、作者或关键词..."
                prefix={<SearchOutlined />}
                className="header-search"
                allowClear
                value={headerSearchKey}
                onChange={(event) => setHeaderSearchKey(event.target.value)}
                onPressEnter={(event) => {
                  const value = (event.target as HTMLInputElement).value.trim()
                  if (!value) return
                  runWithSettingsLeaveGuard(() => {
                    setHeaderSearchKey(value)
                    setCurrentView('search')
                  })
                }}
              />
            </div>
            <div className="header-right">
              <LlmProfileSelector />
              <Tooltip title="新手引导">
                <Button
                  type="text"
                  icon={<QuestionCircleOutlined />}
                  onClick={() => useOnboardingStore.getState().setVisible(true)}
                  style={{ color: 'var(--gs-text-secondary)' }}
                />
              </Tooltip>
              <Tooltip title="当前状态">
                <Badge status="success" text={<span className="header-status">就绪</span>} />
              </Tooltip>
            </div>
          </Header>
        ) : null}

        <Content className="app-content">
          <Suspense fallback={<ViewLoadingFallback />}>
            {renderView()}
          </Suspense>
        </Content>
      </Layout>

      {onboardingVisible ? (
        <Suspense fallback={null}>
          <OnboardingWizard />
        </Suspense>
      ) : null}

      {!currentDocId && !libraryAiOpen ? (
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

      {!currentDocId && !libraryAiOpen ? (
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
              openLibraryAi({ question: headerSearchKey })
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
                onOpenDocument={openDocumentTarget}
              />
            </Suspense>
          ) : null}
        </div>
      </div>
    </Layout>
  )
}

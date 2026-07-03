import type { OpenDocumentTarget, SearchHitLocator } from '@shared/types'

export type WorkspaceViewKey =
  | 'library'
  | 'folders'
  | 'settings'
  | 'dashboard'
  | 'search'
  | 'citation'
  | 'tags'
  | 'research'
  | 'excerpts'

export type WorkspaceFoldersState = {
  selectedFolderId: string | null
  selectedFolderName?: string
  scrollTop: number
}

export type WorkspaceTabGroup = {
  id: string
  title: string
  color: string
  collapsed: boolean
}

type WorkspaceTabGroupMembership = {
  groupId?: string
}

export type WorkspaceAppTab =
  | ({ id: string; kind: 'home'; title: string } & WorkspaceTabGroupMembership)
  | ({
    id: string
    kind: 'view'
    view: WorkspaceViewKey
    title: string
    singleton: boolean
    foldersState?: WorkspaceFoldersState | null
    initialSearchKeyword?: string
  } & WorkspaceTabGroupMembership)
  | ({
    id: string
    kind: 'document'
    title: string
    document: {
      docId: string
      target: OpenDocumentTarget
    }
  } & WorkspaceTabGroupMembership)

export interface AppWorkspaceState {
  tabs: WorkspaceAppTab[]
  tabGroups: WorkspaceTabGroup[]
  activeTabId: string
  siderCollapsed: boolean
}

export interface AppWorkspaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface PersistedAppWorkspaceV1 {
  version: 1
  savedAt: string
  activeTabId: string
  siderCollapsed: boolean
  tabs: WorkspaceAppTab[]
  tabGroups?: WorkspaceTabGroup[]
}

export const APP_WORKSPACE_STORAGE_KEY = 'gujismart.app-workspace.v1'

const HOME_TAB_ID = 'home'
const MAX_RESTORED_TABS = 60
const MAX_RESTORED_TAB_GROUPS = 40
const MAX_ID_LENGTH = 320
const MAX_TITLE_LENGTH = 300
const MAX_GROUP_TITLE_LENGTH = 80
const MAX_KEYWORD_LENGTH = 500
const MAX_EXCERPT_LENGTH = 2000
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
const TAB_GROUP_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const VIEW_KEYS = new Set<WorkspaceViewKey>([
  'library',
  'folders',
  'settings',
  'dashboard',
  'search',
  'citation',
  'tags',
  'research',
  'excerpts',
])
const SINGLETON_VIEW_KEYS = new Set<WorkspaceViewKey>([
  'library',
  'excerpts',
  'citation',
  'tags',
  'dashboard',
  'settings',
])
const VIEW_TITLES: Record<WorkspaceViewKey, string> = {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function cleanFiniteNumber(value: unknown, minimum = 0): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : undefined
}

function getDefaultTabGroupColor(index: number): string {
  return TAB_GROUP_COLORS[index % TAB_GROUP_COLORS.length]
}

function cleanTabGroupColor(value: unknown, index: number): string {
  const color = cleanString(value, 24)
  return TAB_GROUP_COLOR_PATTERN.test(color) ? color.toLowerCase() : getDefaultTabGroupColor(index)
}

function createDefaultWorkspace(): AppWorkspaceState {
  const home = { id: HOME_TAB_ID, kind: 'home' as const, title: '首页' }
  return { tabs: [home], tabGroups: [], activeTabId: HOME_TAB_ID, siderCollapsed: false }
}

function sanitizeLocator(value: unknown): SearchHitLocator | undefined {
  if (!isRecord(value)) return undefined
  const docId = cleanString(value.docId, MAX_ID_LENGTH)
  const segmentId = cleanString(value.segmentId, MAX_ID_LENGTH)
  const segmentOrdinal = cleanFiniteNumber(value.segmentOrdinal)
  const charStart = cleanFiniteNumber(value.charStart)
  const charEnd = cleanFiniteNumber(value.charEnd)
  const matchText = cleanString(value.matchText, MAX_EXCERPT_LENGTH)
  const queryTerm = cleanString(value.queryTerm, MAX_KEYWORD_LENGTH)
  const occurrenceIndex = cleanFiniteNumber(value.occurrenceIndex)
  if (
    !docId
    || !segmentId
    || segmentOrdinal === undefined
    || charStart === undefined
    || charEnd === undefined
    || occurrenceIndex === undefined
  ) {
    return undefined
  }

  const locator: SearchHitLocator = {
    docId,
    segmentId,
    segmentOrdinal,
    charStart,
    charEnd,
    matchText,
    queryTerm,
    occurrenceIndex,
  }
  const sourceType = cleanString(value.sourceType, 120)
  const pageId = cleanString(value.pageId, MAX_ID_LENGTH)
  const href = cleanString(value.href, MAX_EXCERPT_LENGTH)
  const locationKey = cleanString(value.locationKey, MAX_EXCERPT_LENGTH)
  const pageNum = cleanFiniteNumber(value.pageNum)
  const pageIndex = cleanFiniteNumber(value.pageIndex)
  const normalizedCharStart = cleanFiniteNumber(value.normalizedCharStart)
  const normalizedCharEnd = cleanFiniteNumber(value.normalizedCharEnd)
  const blockId = cleanString(value.blockId, MAX_ID_LENGTH)
  const translationUnitId = cleanString(value.translationUnitId, MAX_ID_LENGTH)
  if (sourceType) locator.sourceType = sourceType
  if (pageId) locator.pageId = pageId
  if (href) locator.href = href
  if (locationKey) locator.locationKey = locationKey
  if (pageNum !== undefined) locator.pageNum = pageNum
  if (pageIndex !== undefined) locator.pageIndex = pageIndex
  if (normalizedCharStart !== undefined) locator.normalizedCharStart = normalizedCharStart
  if (normalizedCharEnd !== undefined) locator.normalizedCharEnd = normalizedCharEnd
  if (blockId) locator.blockId = blockId
  if (translationUnitId) locator.translationUnitId = translationUnitId
  if (value.translationSource === true) locator.translationSource = true
  return locator
}

function sanitizeDocumentTarget(value: unknown, fallbackDocId = ''): OpenDocumentTarget | null {
  if (!isRecord(value)) return fallbackDocId ? { docId: fallbackDocId } : null
  const docId = cleanString(value.docId, MAX_ID_LENGTH) || fallbackDocId
  if (!docId) return null

  const target: OpenDocumentTarget = { docId }
  const pageIndex = cleanFiniteNumber(value.pageIndex)
  const keyword = cleanString(value.keyword, MAX_KEYWORD_LENGTH)
  const excerpt = cleanString(value.excerpt, MAX_EXCERPT_LENGTH)
  const sourceId = cleanString(value.sourceId, MAX_ID_LENGTH)
  const locator = sanitizeLocator(value.locator)
  const highlightExcerpt = cleanString(value.highlightExcerpt, MAX_EXCERPT_LENGTH)
  const sourceLabel = cleanString(value.sourceLabel, MAX_TITLE_LENGTH)
  const highlightColor = cleanString(value.highlightColor, 80)
  if (pageIndex !== undefined) target.pageIndex = pageIndex
  if (keyword) target.keyword = keyword
  if (excerpt) target.excerpt = excerpt
  if (sourceId) target.sourceId = sourceId
  if (locator) target.locator = locator
  if (value.revealToc === true) target.revealToc = true
  if (highlightExcerpt) target.highlightExcerpt = highlightExcerpt
  if (sourceLabel) target.sourceLabel = sourceLabel
  if (highlightColor) target.highlightColor = highlightColor
  if (value.startReaderBookTranslation === true) target.startReaderBookTranslation = true
  if (value.openTranslation === true) target.openTranslation = true
  return target
}

function sanitizeFoldersState(value: unknown): WorkspaceFoldersState | null {
  if (!isRecord(value)) return null
  const selectedFolderId = value.selectedFolderId === null
    ? null
    : cleanString(value.selectedFolderId, MAX_ID_LENGTH) || null
  const selectedFolderName = cleanString(value.selectedFolderName, MAX_TITLE_LENGTH)
  return {
    selectedFolderId,
    selectedFolderName: selectedFolderName || undefined,
    scrollTop: cleanFiniteNumber(value.scrollTop) || 0,
  }
}

function sanitizeTabGroups(value: unknown): WorkspaceTabGroup[] {
  if (!Array.isArray(value)) return []
  const groups: WorkspaceTabGroup[] = []
  const seenIds = new Set<string>()

  for (const candidate of value) {
    if (groups.length >= MAX_RESTORED_TAB_GROUPS) break
    if (!isRecord(candidate)) continue
    const id = cleanString(candidate.id, MAX_ID_LENGTH)
    if (!id || seenIds.has(id)) continue
    seenIds.add(id)
    groups.push({
      id,
      title: cleanString(candidate.title, MAX_GROUP_TITLE_LENGTH) || `分组 ${groups.length + 1}`,
      color: cleanTabGroupColor(candidate.color, groups.length),
      collapsed: candidate.collapsed === true,
    })
  }

  return groups
}

function getAllowedTabGroupIds(tabGroups: WorkspaceTabGroup[]): Set<string> {
  return new Set(tabGroups.map((group) => group.id))
}

function sanitizeTabGroupId(value: unknown, allowedGroupIds: Set<string>): string | undefined {
  const groupId = cleanString(value, MAX_ID_LENGTH)
  return groupId && allowedGroupIds.has(groupId) ? groupId : undefined
}

function withSanitizedTabGroup<T extends WorkspaceAppTab>(
  tab: T,
  source: Record<string, unknown>,
  allowedGroupIds: Set<string>,
): T {
  const groupId = sanitizeTabGroupId(source.groupId, allowedGroupIds)
  return groupId ? { ...tab, groupId } : tab
}

function pruneTabGroupsForTabs(tabGroups: WorkspaceTabGroup[], tabs: WorkspaceAppTab[]): WorkspaceTabGroup[] {
  const usedGroupIds = new Set(tabs.map((tab) => tab.groupId).filter(Boolean))
  return tabGroups.filter((group) => usedGroupIds.has(group.id))
}

function sanitizeTab(value: unknown, allowedGroupIds: Set<string>): WorkspaceAppTab | null {
  if (!isRecord(value)) return null
  const kind = cleanString(value.kind, 40)
  const id = cleanString(value.id, MAX_ID_LENGTH)
  if (!id) return null

  if (kind === 'home') {
    return withSanitizedTabGroup({ id: HOME_TAB_ID, kind: 'home', title: '首页' }, value, allowedGroupIds)
  }

  if (kind === 'view') {
    const view = cleanString(value.view, 80) as WorkspaceViewKey
    if (!VIEW_KEYS.has(view)) return null
    const title = cleanString(value.title, MAX_TITLE_LENGTH) || VIEW_TITLES[view]
    const initialSearchKeyword = cleanString(value.initialSearchKeyword, MAX_KEYWORD_LENGTH)
    return withSanitizedTabGroup({
      id,
      kind: 'view',
      view,
      title,
      singleton: SINGLETON_VIEW_KEYS.has(view),
      foldersState: view === 'folders' ? sanitizeFoldersState(value.foldersState) : undefined,
      initialSearchKeyword: view === 'search' ? initialSearchKeyword : undefined,
    }, value, allowedGroupIds)
  }

  if (kind === 'document' && isRecord(value.document)) {
    const docId = cleanString(value.document.docId, MAX_ID_LENGTH)
    if (!docId) return null
    const target = sanitizeDocumentTarget(value.document.target, docId)
    if (!target) return null
    return withSanitizedTabGroup({
      id,
      kind: 'document',
      title: cleanString(value.title, MAX_TITLE_LENGTH) || '文献',
      document: { docId, target: { ...target, docId } },
    }, value, allowedGroupIds)
  }

  return null
}

function sanitizeTabs(value: unknown, tabGroups: WorkspaceTabGroup[] = []): WorkspaceAppTab[] {
  if (!Array.isArray(value)) return []
  const tabs: WorkspaceAppTab[] = []
  const seenIds = new Set<string>()
  const seenSingletonViews = new Set<WorkspaceViewKey>()
  const allowedGroupIds = getAllowedTabGroupIds(tabGroups)

  for (const candidate of value) {
    if (tabs.length >= MAX_RESTORED_TABS) break
    const tab = sanitizeTab(candidate, allowedGroupIds)
    if (!tab || seenIds.has(tab.id)) continue
    if (tab.kind === 'view' && tab.singleton) {
      if (seenSingletonViews.has(tab.view)) continue
      seenSingletonViews.add(tab.view)
    }
    seenIds.add(tab.id)
    tabs.push(tab)
  }
  return tabs
}

export function loadAppWorkspace(storage: AppWorkspaceStorage): AppWorkspaceState {
  try {
    const raw = storage.getItem(APP_WORKSPACE_STORAGE_KEY)
    if (!raw) return createDefaultWorkspace()
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1) {
      storage.removeItem(APP_WORKSPACE_STORAGE_KEY)
      return createDefaultWorkspace()
    }
    const tabGroups = sanitizeTabGroups(parsed.tabGroups)
    const tabs = sanitizeTabs(parsed.tabs, tabGroups)
    if (tabs.length === 0) {
      storage.removeItem(APP_WORKSPACE_STORAGE_KEY)
      return createDefaultWorkspace()
    }
    const safeTabGroups = pruneTabGroupsForTabs(tabGroups, tabs)
    const requestedActiveId = cleanString(parsed.activeTabId, MAX_ID_LENGTH)
    const activeTabId = tabs.some((tab) => tab.id === requestedActiveId)
      ? requestedActiveId
      : tabs[0].id
    return {
      tabs,
      tabGroups: safeTabGroups,
      activeTabId,
      siderCollapsed: parsed.siderCollapsed === true,
    }
  } catch {
    try {
      storage.removeItem(APP_WORKSPACE_STORAGE_KEY)
    } catch {
      // Ignore inaccessible storage and start from a clean workspace.
    }
    return createDefaultWorkspace()
  }
}

export function saveAppWorkspace(
  storage: AppWorkspaceStorage,
  state: AppWorkspaceState,
): boolean {
  try {
    const tabGroups = sanitizeTabGroups(state.tabGroups)
    const tabs = sanitizeTabs(state.tabs, tabGroups)
    const safeTabs = tabs.length > 0 ? tabs : createDefaultWorkspace().tabs
    const safeTabGroups = pruneTabGroupsForTabs(tabGroups, safeTabs)
    const activeTabId = safeTabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : safeTabs[0].id
    const payload: PersistedAppWorkspaceV1 = {
      version: 1,
      savedAt: new Date().toISOString(),
      activeTabId,
      siderCollapsed: state.siderCollapsed,
      tabs: safeTabs,
      tabGroups: safeTabGroups,
    }
    storage.setItem(APP_WORKSPACE_STORAGE_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

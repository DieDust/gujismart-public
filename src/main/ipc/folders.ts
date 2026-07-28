import { ipcMain, dialog } from 'electron'
import { queryAll, queryOne, run, saveDatabase, scheduleDatabaseSave, transaction, transactionAsync } from '../database'
import { nanoid } from 'nanoid'
import { join, extname } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import type {
  BulkAssociationResult,
  Document,
  Folder,
  FolderContentOptions,
  FolderContentResult,
  FolderCreatePayload,
  FolderDocumentMovePayload,
  FolderImportFile,
  FolderMovePayload,
  FolderOverviewDocument,
  FolderOverviewResult,
  FolderUpdatePayload,
  LibraryDocumentSortDirection,
  LibraryDocumentSortKey,
} from '../../shared/types'
import { getLibraryStateCache, markLibraryStateCacheDirty } from '../library-state-cache'
import { buildCumulativeFolderDocumentCounts, resolveFolderAndDescendantIds } from '../folder-scope'
import { allowManagedFileAccessPaths } from '../file-access'
import { importSelectionService } from '../import-selections'
import {
  assertDocumentIdsInLibraryProject,
  captureActiveLibraryProjectId,
  getActiveLibraryProjectId,
  withLibraryProjectContext,
} from '../library-projects'
import { scanCanonicalExternalFolder } from '../external-folder-boundary'

const SUPPORTED_FOLDER_IMPORT_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.tiff',
  '.tif',
  '.bmp',
  '.json',
  '.txt',
  '.md',
  '.markdown',
  '.epub',
  '.mobi',
  '.azw',
  '.azw3',
])

const DEFAULT_FOLDER_CONTENT_LIMIT = 80
const MAX_FOLDER_CONTENT_LIMIT = 240

function normalizeFolderName(value: unknown): string {
  return String(value || '').trim()
}

function normalizeParentId(value: unknown): string | null {
  const parentId = String(value || '').trim()
  return parentId || null
}

export function rejectProtectedExternalPathFields(value: unknown): void {
  if (value && typeof value === 'object' && 'external_path' in value) {
    throw new Error('external_path 只能由主进程中的已授权目录写入')
  }
}

function folderParentWhere(parentId: string | null): { sql: string; params: unknown[] } {
  return parentId
    ? { sql: 'parent_id = ?', params: [parentId] }
    : { sql: 'parent_id IS NULL', params: [] }
}

function listFoldersWithCounts(): Folder[] {
  // Never recompute cumulative counts on folders:list. That scan freezes large
  // libraries during the first paint. Counts come from library-state-cache and
  // are refreshed in the background after open.
  const cache = getLibraryStateCache()
  const counts = cache.folderDocumentCounts || {}
  return queryAll<Folder>(
    'SELECT * FROM folders WHERE library_project_id = ? ORDER BY sort_order, created_at',
    [getActiveLibraryProjectId()],
  )
    .map((folder) => ({ ...folder, document_count: counts[folder.id] || 0 }))
}

function findFolderByNameInParent(name: string, parentId: string | null, excludeId?: string): Folder | null {
  const normalizedName = normalizeFolderName(name)
  if (!normalizedName) return null
  const excludeSql = excludeId ? ' AND id <> ?' : ''
  const params = parentId
    ? [normalizedName, parentId, ...(excludeId ? [excludeId] : [])]
    : [normalizedName, ...(excludeId ? [excludeId] : [])]
  return queryOne<Folder>(
    `SELECT * FROM folders
     WHERE library_project_id = ?
       AND name = ?
       AND parent_id ${parentId ? '= ?' : 'IS NULL'}
       ${excludeSql}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [getActiveLibraryProjectId(), ...params],
  )
}

function updateExistingFolderMetadata(folder: Folder, data: FolderCreatePayload | FolderUpdatePayload, now: string): Folder | null {
  const sets: string[] = []
  const params: unknown[] = []
  if (!folder.icon && data.icon) {
    sets.push('icon = ?')
    params.push(data.icon)
  }
  if (!folder.color && data.color) {
    sets.push('color = ?')
    params.push(data.color)
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?')
    params.push(now, folder.id)
    run(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [folder.id])
  }
  return folder
}

function mergeFolderContentsInto(sourceId: string, targetId: string, data: FolderUpdatePayload, now: string, visited = new Set<string>()): void {
  if (!sourceId || !targetId || sourceId === targetId || visited.has(sourceId)) return
  visited.add(sourceId)
  const libraryProjectId = getActiveLibraryProjectId()
  const source = queryOne<Folder>(
    'SELECT * FROM folders WHERE id = ? AND library_project_id = ?',
    [sourceId, libraryProjectId],
  )
  const target = queryOne<Folder>(
    'SELECT * FROM folders WHERE id = ? AND library_project_id = ?',
    [targetId, libraryProjectId],
  )
  if (!source || !target) return

  run(
    `INSERT OR IGNORE INTO document_folders (doc_id, folder_id)
     SELECT doc_id, ? FROM document_folders WHERE folder_id = ?`,
    [targetId, sourceId],
  )
  run('DELETE FROM document_folders WHERE folder_id = ?', [sourceId])

  const children = queryAll<Folder>(
    'SELECT * FROM folders WHERE parent_id = ? AND library_project_id = ? ORDER BY sort_order, created_at',
    [sourceId, libraryProjectId],
  )
  for (const child of children) {
    const existingChild = findFolderByNameInParent(child.name, targetId, child.id)
    if (existingChild) {
      mergeFolderContentsInto(child.id, existingChild.id, {}, now, visited)
    } else {
      run('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?', [targetId, now, child.id])
    }
  }

  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (!target.external_path && source.external_path) {
    sets.push('external_path = ?')
    params.push(source.external_path)
  }
  if (!target.icon && (data.icon || source.icon)) {
    sets.push('icon = ?')
    params.push(data.icon || source.icon)
  }
  if (!target.color && (data.color || source.color)) {
    sets.push('color = ?')
    params.push(data.color || source.color)
  }
  params.push(targetId)
  run(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, params)
  run('DELETE FROM folders WHERE id = ?', [sourceId])
}

function mergeFolderInto(sourceId: string, targetId: string, data: FolderUpdatePayload, now: string): Folder | null {
  if (!sourceId || !targetId || sourceId === targetId) return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [targetId])
  transaction(() => {
    mergeFolderContentsInto(sourceId, targetId, data, now)
  })
  saveDatabase()
  return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [targetId])
}

function getFolderChildrenMap(folders: Array<Pick<Folder, 'id' | 'parent_id'>>): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>()
  folders.forEach((folder) => {
    const parentId = normalizeParentId(folder.parent_id)
    if (!parentId) return
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) || []), folder.id])
  })
  return childrenByParent
}

function assertFolderParentAllowed(folderId: string | null, nextParentId: string | null): void {
  if (!nextParentId) return
  if (folderId && nextParentId === folderId) throw new Error('不能把文件夹移动到自己里面')
  const parent = queryOne<Pick<Folder, 'id'>>(
    'SELECT id FROM folders WHERE id = ? AND library_project_id = ?',
    [nextParentId, getActiveLibraryProjectId()],
  )
  if (!parent) throw new Error('目标文件夹不存在')
  if (folderId) {
    const descendants = new Set(resolveFolderAndDescendantIds([folderId]))
    if (descendants.has(nextParentId)) throw new Error('不能把文件夹移动到自己的子文件夹里面')
  }
}

function assertFolderMoveAllowed(folderId: string, nextParentId: string | null): Folder {
  const current = queryOne<Folder>(
    'SELECT * FROM folders WHERE id = ? AND library_project_id = ?',
    [folderId, getActiveLibraryProjectId()],
  )
  if (!current) throw new Error('文件夹不存在')
  assertFolderParentAllowed(folderId, nextParentId)

  const conflict = findFolderByNameInParent(current.name, nextParentId, folderId)
  if (conflict) throw new Error(`同一层级已有同名文件夹“${current.name}”`)
  return current
}

function reorderFolderSiblings(folderId: string, nextParentId: string | null, beforeId?: string | null, afterId?: string | null): void {
  const parentWhere = folderParentWhere(nextParentId)
  const siblings = queryAll<Folder>(
    `SELECT * FROM folders
     WHERE library_project_id = ? AND ${parentWhere.sql}
     ORDER BY sort_order ASC, created_at ASC`,
    [getActiveLibraryProjectId(), ...parentWhere.params],
  ).filter((folder) => folder.id !== folderId)

  let insertIndex = siblings.length
  const normalizedBeforeId = String(beforeId || '').trim()
  const normalizedAfterId = String(afterId || '').trim()
  if (normalizedBeforeId) {
    const beforeIndex = siblings.findIndex((folder) => folder.id === normalizedBeforeId)
    if (beforeIndex >= 0) insertIndex = beforeIndex
  } else if (normalizedAfterId) {
    const afterIndex = siblings.findIndex((folder) => folder.id === normalizedAfterId)
    if (afterIndex >= 0) insertIndex = afterIndex + 1
  }

  const orderedIds = siblings.map((folder) => folder.id)
  orderedIds.splice(insertIndex, 0, folderId)
  orderedIds.forEach((id, index) => {
    run('UPDATE folders SET sort_order = ? WHERE id = ?', [index + 1, id])
  })
}

function moveFolder(payload: FolderMovePayload): Folder[] {
  const folderId = String(payload?.id || '').trim()
  if (!folderId) throw new Error('文件夹不存在')
  const nextParentId = normalizeParentId(payload.parent_id)
  const current = assertFolderMoveAllowed(folderId, nextParentId)
  const now = new Date().toISOString()

  transaction(() => {
    run('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?', [nextParentId, now, current.id])
    reorderFolderSiblings(current.id, nextParentId, payload.before_id, payload.after_id)
  })
  saveDatabase()
  markLibraryStateCacheDirty()
  return listFoldersWithCounts()
}

interface FolderDirectCountRow {
  folder_id: string
  count: number
}

interface FolderDocumentPreviewRow extends FolderOverviewDocument {
  folder_id: string
}

type FolderContentDocumentRow = FolderOverviewDocument

interface NormalizedFolderContentOptions {
  folderId: string | null
  unfiledOnly: boolean
  limit: number
  offset: number
  sortKey: LibraryDocumentSortKey
  sortDirection: LibraryDocumentSortDirection
}

const FOLDER_CONTENT_SORT_KEYS = new Set<LibraryDocumentSortKey>([
  'default',
  'title',
  'createdAt',
  'updatedAt',
  'publicationYear',
  'lastOpened',
  'pageCount',
])

function normalizeFolderContentSortKey(value: unknown): LibraryDocumentSortKey {
  const sortKey = String(value || 'default') as LibraryDocumentSortKey
  return FOLDER_CONTENT_SORT_KEYS.has(sortKey) ? sortKey : 'default'
}

function normalizeFolderContentSortDirection(value: unknown): LibraryDocumentSortDirection {
  return value === 'asc' ? 'asc' : 'desc'
}

function buildMissingLastOrder(expression: string, direction: 'ASC' | 'DESC'): string {
  return `CASE WHEN ${expression} IS NULL OR TRIM(CAST(${expression} AS TEXT)) = '' THEN 1 ELSE 0 END ASC, ${expression} ${direction}`
}

function buildDocumentMetadataValueExpression(key: string): string {
  return `CASE WHEN json_valid(d.metadata) THEN json_extract(d.metadata, '$.${key}') ELSE NULL END`
}

function buildDocumentMetadataTextExpression(key: string): string {
  return `CAST(${buildDocumentMetadataValueExpression(key)} AS TEXT)`
}

function buildFolderContentOrderBy(options: Pick<NormalizedFolderContentOptions, 'sortKey' | 'sortDirection'>): string {
  const direction = options.sortDirection === 'asc' ? 'ASC' : 'DESC'
  const titleExpression = "LOWER(COALESCE(NULLIF(TRIM(d.title), ''), NULLIF(TRIM(d.file_path), ''), d.id))"
  const publicationYearExpression = `CAST(COALESCE(
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('publication_year')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('year')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('publish_year')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('date')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('issue_date')}), ''),
    NULLIF(TRIM(${buildDocumentMetadataTextExpression('publication_time')}), '')
  ) AS INTEGER)`
  const stableFallback = `${titleExpression} ASC, d.id ASC`

  switch (options.sortKey) {
    case 'title':
      return `${titleExpression} ${direction}, d.id ASC`
    case 'createdAt':
      return `${buildMissingLastOrder('d.created_at', direction)}, ${stableFallback}`
    case 'updatedAt':
      return `${buildMissingLastOrder('d.updated_at', direction)}, ${stableFallback}`
    case 'publicationYear':
      return `${buildMissingLastOrder(publicationYearExpression, direction)}, ${stableFallback}`
    case 'lastOpened':
      return `${buildMissingLastOrder('d.last_opened_at', direction)}, ${stableFallback}`
    case 'pageCount':
      return `${buildMissingLastOrder('d.page_count', direction)}, ${stableFallback}`
    case 'default':
    default:
      return `COALESCE(d.updated_at, d.created_at, '') DESC, ${stableFallback}`
  }
}

function buildFolderOverview(): FolderOverviewResult {
  const activeProjectId = getActiveLibraryProjectId()
  const folders = queryAll<Folder>(
    'SELECT * FROM folders WHERE library_project_id = ? ORDER BY sort_order ASC, created_at ASC',
    [activeProjectId],
  )
  const cumulativeCounts = buildCumulativeFolderDocumentCounts(activeProjectId)
  const childrenByParent = getFolderChildrenMap(folders)
  const directCounts = new Map<string, number>()
  queryAll<FolderDirectCountRow>(
    `SELECT df.folder_id, COUNT(DISTINCT df.doc_id) as count
     FROM document_folders df
     INNER JOIN documents d ON d.id = df.doc_id
     WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)
       AND COALESCE(d.import_status, '') <> 'deleting'
     GROUP BY df.folder_id`,
    [activeProjectId],
  ).forEach((row) => {
    directCounts.set(row.folder_id, Number(row.count || 0))
  })

  const directDocsByFolder = new Map<string, FolderOverviewDocument[]>()
  queryAll<FolderDocumentPreviewRow>(
    `SELECT
       df.folder_id,
       d.id,
       d.title,
       d.author,
      d.doc_type,
      d.page_count,
      d.thumb_path,
      d.created_at,
      d.updated_at,
      d.last_opened_at,
      (
         SELECT p.image_path
         FROM pages p
         WHERE p.doc_id = d.id
           AND p.image_path IS NOT NULL
           AND TRIM(p.image_path) <> ''
         ORDER BY p.page_num ASC
         LIMIT 1
       ) as first_page_image_path
     FROM document_folders df
     INNER JOIN documents d ON d.id = df.doc_id
     WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)
       AND COALESCE(d.import_status, '') <> 'deleting'
     ORDER BY COALESCE(d.updated_at, d.created_at, '') DESC, d.title ASC`,
    [activeProjectId],
  ).forEach((row) => {
    const current = directDocsByFolder.get(row.folder_id) || []
    current.push({
      id: row.id,
      title: row.title || '未命名文献',
      author: row.author || null,
      doc_type: row.doc_type || null,
      page_count: row.page_count || null,
      thumb_path: row.thumb_path || null,
      first_page_image_path: row.first_page_image_path || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      last_opened_at: row.last_opened_at || null,
    })
    directDocsByFolder.set(row.folder_id, current)
  })

  const sortRecentDocuments = (items: FolderOverviewDocument[]): FolderOverviewDocument[] => (
    [...items].sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')) || left.title.localeCompare(right.title, 'zh-Hans-CN'))
  )

  const recentMemo = new Map<string, FolderOverviewDocument[]>()
  const collectRecentDocuments = (folderId: string, stack = new Set<string>()): FolderOverviewDocument[] => {
    if (recentMemo.has(folderId)) return recentMemo.get(folderId) || []
    if (stack.has(folderId)) return []
    stack.add(folderId)
    const byId = new Map<string, FolderOverviewDocument>()
    ;(directDocsByFolder.get(folderId) || []).slice(0, 6).forEach((doc) => byId.set(doc.id, doc))
    ;(childrenByParent.get(folderId) || []).forEach((childId) => {
      collectRecentDocuments(childId, stack).forEach((doc) => byId.set(doc.id, doc))
    })
    stack.delete(folderId)
    const recent = sortRecentDocuments([...byId.values()]).slice(0, 6)
    recentMemo.set(folderId, recent)
    return recent
  }

  const overviewFolders = folders.map((folder) => ({
    ...folder,
    document_count: cumulativeCounts[folder.id] || 0,
    direct_document_count: directCounts.get(folder.id) || 0,
    cumulative_document_count: cumulativeCounts[folder.id] || 0,
    child_folder_count: (childrenByParent.get(folder.id) || []).length,
    recent_documents: collectRecentDocuments(folder.id),
  }))

  const totalDocumentCount = Number(queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM documents
     WHERE EXISTS (
       SELECT 1 FROM library_project_documents project_scope
       WHERE project_scope.document_id = documents.id
         AND project_scope.project_id = ?
     )
       AND COALESCE(import_status, '') <> 'deleting'`,
    [activeProjectId],
  )?.count || 0)
  const unfiledDocumentCount = Number(queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM documents d
     WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)
       AND COALESCE(d.import_status, '') <> 'deleting'
       AND NOT EXISTS (
         SELECT 1
         FROM document_folders df
         INNER JOIN folders f ON f.id = df.folder_id
         WHERE df.doc_id = d.id
           AND f.library_project_id = ?
       )`,
    [activeProjectId, activeProjectId],
  )?.count || 0)

  return {
    folders: overviewFolders,
    root_folder_count: folders.filter((folder) => !folder.parent_id).length,
    total_folder_count: folders.length,
    total_document_count: totalDocumentCount,
    unfiled_document_count: unfiledDocumentCount,
  }
}

function mapFolderContentRows(rows: FolderContentDocumentRow[]): FolderOverviewDocument[] {
  const documents = rows.map((row) => ({
    id: row.id,
    title: row.title || '未命名文献',
    author: row.author || null,
    doc_type: row.doc_type || null,
    page_count: row.page_count || null,
    thumb_path: row.thumb_path || null,
    first_page_image_path: row.first_page_image_path || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    last_opened_at: row.last_opened_at || null,
  }))
  allowManagedFileAccessPaths(documents.flatMap((doc) => [doc.thumb_path || '', doc.first_page_image_path || '']).filter(Boolean))
  return documents
}

function normalizeFolderContentOptions(input?: FolderContentOptions | string | null): NormalizedFolderContentOptions {
  const rawOptions = typeof input === 'object' && input !== null
    ? input
    : { folderId: input }
  const rawLimit = Number(rawOptions.limit || DEFAULT_FOLDER_CONTENT_LIMIT)
  const rawOffset = Number(rawOptions.offset || 0)
  return {
    folderId: normalizeParentId(rawOptions.folderId),
    unfiledOnly: Boolean(rawOptions.unfiledOnly),
    limit: Math.max(1, Math.min(MAX_FOLDER_CONTENT_LIMIT, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : DEFAULT_FOLDER_CONTENT_LIMIT)),
    offset: Math.max(0, Number.isFinite(rawOffset) ? Math.floor(rawOffset) : 0),
    sortKey: normalizeFolderContentSortKey(rawOptions.sortKey),
    sortDirection: normalizeFolderContentSortDirection(rawOptions.sortDirection),
  }
}

function getFolderContent(options?: FolderContentOptions | string | null): FolderContentResult {
  const { folderId: normalizedFolderId, unfiledOnly, limit, offset, sortKey, sortDirection } = normalizeFolderContentOptions(options)
  if (!normalizedFolderId && !unfiledOnly) {
    return {
      folder_id: null,
      unfiled: false,
      documents: [],
      total_document_count: 0,
      limit,
      offset,
      has_more: false,
    }
  }
  if (normalizedFolderId) {
    const folder = queryOne<Pick<Folder, 'id'>>(
      'SELECT id FROM folders WHERE id = ? AND library_project_id = ?',
      [normalizedFolderId, getActiveLibraryProjectId()],
    )
    if (!folder) {
      return {
        folder_id: normalizedFolderId,
        unfiled: false,
        documents: [],
        total_document_count: 0,
        limit,
        offset,
        has_more: false,
      }
    }
  }

  const selectSql = `
    SELECT
      d.id,
      d.title,
      d.author,
      d.doc_type,
      d.page_count,
      d.thumb_path,
      d.created_at,
      d.updated_at,
      d.last_opened_at,
      (
        SELECT p.image_path
        FROM pages p
        WHERE p.doc_id = d.id
          AND p.image_path IS NOT NULL
          AND TRIM(p.image_path) <> ''
        ORDER BY p.page_num ASC
        LIMIT 1
      ) as first_page_image_path
    FROM documents d
    ${normalizedFolderId ? 'INNER JOIN document_folders df ON d.id = df.doc_id' : ''}
  `
  const conditions = ["EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)", "COALESCE(d.import_status, '') <> 'deleting'"]
  const params: unknown[] = [getActiveLibraryProjectId()]
  if (normalizedFolderId) {
    conditions.push('df.folder_id = ?')
    params.push(normalizedFolderId)
  } else if (unfiledOnly) {
    conditions.push(`NOT EXISTS (
      SELECT 1
      FROM document_folders df_unfiled
      INNER JOIN folders f_unfiled ON f_unfiled.id = df_unfiled.folder_id
      WHERE df_unfiled.doc_id = d.id
        AND f_unfiled.library_project_id = ?
    )`)
    params.push(getActiveLibraryProjectId())
  }

  const whereSql = `WHERE ${conditions.join(' AND ')}`
  const rows = queryAll<FolderContentDocumentRow>(
    `${selectSql}
     ${whereSql}
     ORDER BY ${buildFolderContentOrderBy({ sortKey, sortDirection })}
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )
  const total = Number(queryOne<{ count: number }>(
    `SELECT COUNT(DISTINCT d.id) as count
     FROM documents d
     ${normalizedFolderId ? 'INNER JOIN document_folders df ON d.id = df.doc_id' : ''}
     ${whereSql}`,
    params,
  )?.count || 0)

  return {
    folder_id: normalizedFolderId,
    unfiled: unfiledOnly,
    documents: mapFolderContentRows(rows),
    total_document_count: total,
    limit,
    offset,
    has_more: offset + rows.length < total,
  }
}

function moveDocumentsToFolder(payload: FolderDocumentMovePayload): BulkAssociationResult {
  const targetFolderId = String(payload?.target_folder_id || '').trim()
  const sourceFolderId = normalizeParentId(payload?.source_folder_id)
  const uniqueDocIds = [...new Set((payload?.docIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (!targetFolderId || uniqueDocIds.length === 0) return { count: 0 }

  const libraryProjectId = getActiveLibraryProjectId()
  assertDocumentIdsInLibraryProject(uniqueDocIds, libraryProjectId)
  const targetFolder = queryOne<Pick<Folder, 'id'>>(
    'SELECT id FROM folders WHERE id = ? AND library_project_id = ?',
    [targetFolderId, libraryProjectId],
  )
  if (!targetFolder) throw new Error('目标文件夹不存在')
  if (sourceFolderId) {
    const sourceFolder = queryOne<Pick<Folder, 'id'>>(
      'SELECT id FROM folders WHERE id = ? AND library_project_id = ?',
      [sourceFolderId, libraryProjectId],
    )
    if (!sourceFolder) throw new Error('来源文件夹不存在')
    if (sourceFolderId === targetFolderId) return { count: uniqueDocIds.length }
  }

  const now = new Date().toISOString()
  transaction(() => {
    for (const docId of uniqueDocIds) {
      run('INSERT OR IGNORE INTO document_folders (doc_id, folder_id) VALUES (?, ?)', [docId, targetFolderId])
    }
    if (sourceFolderId) {
      const placeholders = uniqueDocIds.map(() => '?').join(', ')
      run(`DELETE FROM document_folders WHERE folder_id = ? AND doc_id IN (${placeholders})`, [sourceFolderId, ...uniqueDocIds])
      run('UPDATE folders SET updated_at = ? WHERE id = ?', [now, sourceFolderId])
    }
    run('UPDATE folders SET updated_at = ? WHERE id = ?', [now, targetFolderId])
  })
  saveDatabase()
  markLibraryStateCacheDirty()
  return { count: uniqueDocIds.length }
}

function collectSupportedFolderFiles(dirPath: string): FolderImportFile[] {
  const results: FolderImportFile[] = []
  for (const fileName of readdirSync(dirPath)) {
    const fullPath = join(dirPath, fileName)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      results.push(...collectSupportedFolderFiles(fullPath))
      continue
    }
    const ext = extname(fileName).toLowerCase()
    if (!stat.isFile() || !SUPPORTED_FOLDER_IMPORT_EXTENSIONS.has(ext)) continue
    results.push({
      name: fileName,
      path: fullPath,
      size: stat.size,
      ext,
    })
  }
  return results
}

export function registerFolderIpc(): void {
  ipcMain.handle('folders:list', async (): Promise<Folder[]> => {
    return listFoldersWithCounts()
  })

  ipcMain.handle('folders:getOverview', async (): Promise<FolderOverviewResult> => {
    return buildFolderOverview()
  })

  ipcMain.handle('folders:getContent', async (_event, options?: FolderContentOptions | string | null): Promise<FolderContentResult> => {
    return getFolderContent(options)
  })

  ipcMain.handle('folders:get', async (_event, id: string): Promise<Folder | null> => {
    return queryOne<Folder>(
      'SELECT * FROM folders WHERE id = ? AND library_project_id = ?',
      [id, getActiveLibraryProjectId()],
    )
  })

  ipcMain.handle('folders:create', async (_event, data: FolderCreatePayload): Promise<Folder | null> => {
    rejectProtectedExternalPathFields(data)
    const name = normalizeFolderName(data.name)
    if (!name) throw new Error('文件夹名称不能为空')
    const parentId = normalizeParentId(data.parent_id)
    assertFolderParentAllowed(null, parentId)
    const now = new Date().toISOString()
    const existing = findFolderByNameInParent(name, parentId)
    if (existing) {
      return updateExistingFolderMetadata(existing, data, now)
    }

    const id = nanoid()
    const libraryProjectId = getActiveLibraryProjectId()
    const maxOrder = queryOne<{ max_order: number | null }>(
      `SELECT MAX(sort_order) as max_order
       FROM folders
       WHERE library_project_id = ? AND parent_id ${parentId ? '= ?' : 'IS NULL'}`,
      parentId ? [libraryProjectId, parentId] : [libraryProjectId],
    )
    const sortOrder = (maxOrder?.max_order as number || 0) + 1

    run(
      'INSERT INTO folders (id, library_project_id, name, parent_id, external_path, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, libraryProjectId, name, parentId, null, data.icon || 'folder', data.color || null, sortOrder, now, now]
    )
    saveDatabase()
    markLibraryStateCacheDirty()

    return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [id])
  })

  ipcMain.handle('folders:update', async (_event, id: string, data: FolderUpdatePayload): Promise<boolean> => {
    rejectProtectedExternalPathFields(data)
    const folderId = String(id || '').trim()
    if (!folderId) return false
    const current = queryOne<Folder>(
      'SELECT * FROM folders WHERE id = ? AND library_project_id = ?',
      [folderId, getActiveLibraryProjectId()],
    )
    if (!current) return false

    const nextName = 'name' in data ? normalizeFolderName(data.name) : current.name
    if (!nextName) throw new Error('文件夹名称不能为空')
    const nextParentId = 'parent_id' in data ? normalizeParentId(data.parent_id) : current.parent_id
    assertFolderParentAllowed(folderId, nextParentId)
    const now = new Date().toISOString()
    const existing = findFolderByNameInParent(nextName, nextParentId, folderId)
    if (existing) {
      throw new Error(`同一层级已有同名文件夹“${nextName}”`)
    }

    const allowedFields: Array<keyof FolderUpdatePayload> = ['name', 'parent_id', 'icon', 'color', 'sort_order']
    const sets: string[] = []
    const params: unknown[] = []

    for (const field of allowedFields) {
      if (field in data) {
        sets.push(`${field} = ?`)
        if (field === 'name') {
          params.push(nextName)
        } else if (field === 'parent_id') {
          params.push(nextParentId)
        } else {
          params.push(data[field])
        }
      }
    }

    if (sets.length === 0) return false

    sets.push('updated_at = ?')
    params.push(now)
    params.push(folderId)

    run(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('folders:move', async (_event, data: FolderMovePayload): Promise<Folder[]> => {
    return moveFolder(data)
  })

  ipcMain.handle('folders:moveDocuments', async (_event, data: FolderDocumentMovePayload): Promise<BulkAssociationResult> => {
    return moveDocumentsToFolder(data)
  })

  ipcMain.handle('folders:delete', async (_event, id: string): Promise<boolean> => {
    const folderId = String(id || '').trim()
    if (!folderId) return false
    const libraryProjectId = captureActiveLibraryProjectId()
    let deleted = false
    await transactionAsync(() => {
      const folder = queryOne<Pick<Folder, 'id'>>(
        'SELECT id FROM folders WHERE id = ? AND library_project_id = ?',
        [folderId, libraryProjectId],
      )
      if (!folder) return
      run('DELETE FROM document_folders WHERE folder_id = ?', [folderId])
      run('UPDATE folders SET parent_id = NULL, updated_at = ? WHERE parent_id = ?', [new Date().toISOString(), folderId])
      run('DELETE FROM folders WHERE id = ? AND library_project_id = ?', [folderId, libraryProjectId])
      deleted = true
    }, { maxWaitMs: 60_000 })
    if (!deleted) return false
    scheduleDatabaseSave()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('folders:addDocument', async (_event, docId: string, folderId: string): Promise<boolean> => {
    const libraryProjectId = getActiveLibraryProjectId()
    assertDocumentIdsInLibraryProject([docId], libraryProjectId)
    const folder = queryOne(
      'SELECT 1 FROM folders WHERE id = ? AND library_project_id = ?',
      [folderId, libraryProjectId],
    )
    if (!folder) throw new Error('文件夹不属于当前项目')
    run('INSERT OR IGNORE INTO document_folders (doc_id, folder_id) VALUES (?, ?)', [docId, folderId])
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('folders:addDocuments', async (
    _event,
    docIds: string[],
    folderId: string,
    requestedProjectId?: string,
  ): Promise<BulkAssociationResult> => withLibraryProjectContext(
    captureActiveLibraryProjectId(requestedProjectId),
    () => {
    const targetFolderId = String(folderId || '').trim()
    const uniqueDocIds = [...new Set((docIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    if (!targetFolderId || uniqueDocIds.length === 0) return { count: 0 }

    const libraryProjectId = getActiveLibraryProjectId()
    assertDocumentIdsInLibraryProject(uniqueDocIds, libraryProjectId)
    const folder = queryOne<Pick<Folder, 'id'>>(
      'SELECT id FROM folders WHERE id = ? AND library_project_id = ?',
      [targetFolderId, libraryProjectId],
    )
    if (!folder) throw new Error('文件夹不存在')

    transaction(() => {
      for (const docId of uniqueDocIds) {
        run('INSERT OR IGNORE INTO document_folders (doc_id, folder_id) VALUES (?, ?)', [docId, targetFolderId])
      }
    })
    saveDatabase()
    markLibraryStateCacheDirty()
    return { count: uniqueDocIds.length }
  }))

  ipcMain.handle('folders:removeDocument', async (_event, docId: string, folderId: string): Promise<boolean> => {
    const libraryProjectId = getActiveLibraryProjectId()
    assertDocumentIdsInLibraryProject([docId], libraryProjectId)
    run('DELETE FROM document_folders WHERE doc_id = ? AND folder_id = ?', [docId, folderId])
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('folders:getDocuments', async (_event, folderId: string): Promise<Document[]> => {
    const libraryProjectId = getActiveLibraryProjectId()
    const folderIds = resolveFolderAndDescendantIds([folderId], libraryProjectId)
    if (folderIds.length === 0) return []
    return queryAll<Document>(
      `SELECT DISTINCT d.*
       FROM documents d
       INNER JOIN document_folders df ON d.id = df.doc_id
       WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)
         AND df.folder_id IN (${folderIds.map(() => '?').join(', ')})
       ORDER BY d.updated_at DESC`,
      [libraryProjectId, ...folderIds]
    )
  })

  ipcMain.handle('folders:createFromImportSource', async (
    event,
    selectionId: string,
    sourceId: string,
    parentId?: string | null,
    requestedProjectId?: string,
  ): Promise<Folder | null> => withLibraryProjectContext(
    captureActiveLibraryProjectId(requestedProjectId),
    async () => {
    const externalPath = await importSelectionService.getDirectorySourcePath(event.sender.id, selectionId, sourceId)
    const name = normalizeFolderName(externalPath.split(/[/\\]/).pop())
    if (!name) return null
    const normalizedParentId = normalizeParentId(parentId)
    assertFolderParentAllowed(null, normalizedParentId)
    const now = new Date().toISOString()
    const existing = findFolderByNameInParent(name, normalizedParentId)
    if (existing) {
      if (!existing.external_path) {
        run('UPDATE folders SET external_path = ?, updated_at = ? WHERE id = ?', [externalPath, now, existing.id])
        saveDatabase()
      }
      return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [existing.id])
    }
    const id = nanoid()
    const libraryProjectId = getActiveLibraryProjectId()
    const maxOrder = queryOne<{ max_order: number | null }>(
      `SELECT MAX(sort_order) as max_order
       FROM folders
       WHERE library_project_id = ? AND parent_id ${normalizedParentId ? '= ?' : 'IS NULL'}`,
      normalizedParentId ? [libraryProjectId, normalizedParentId] : [libraryProjectId],
    )
    run(
      'INSERT INTO folders (id, library_project_id, name, parent_id, external_path, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, libraryProjectId, name, normalizedParentId, externalPath, 'folder', null, (Number(maxOrder?.max_order) || 0) + 1, now, now],
    )
    saveDatabase()
    markLibraryStateCacheDirty()
    return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [id])
  }))

  ipcMain.handle('folders:scanExternal', async (_event, folderId: string): Promise<FolderImportFile[]> => {
    const folder = queryOne<Folder>(
      'SELECT * FROM folders WHERE id = ? AND library_project_id = ?',
      [folderId, getActiveLibraryProjectId()],
    )
    if (!folder || !folder.external_path) return []

    const extPath = folder.external_path
    try {
      return await scanCanonicalExternalFolder(extPath, SUPPORTED_FOLDER_IMPORT_EXTENSIONS)
    } catch (e) {
      console.error('[IPC] Failed to scan external folder:', e)
      return []
    }
  })

}


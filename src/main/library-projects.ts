import { createHash, randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import { existsSync } from 'fs'
import { copyFile, cp, mkdir, rm, stat } from 'fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve } from 'path'
import {
  appendSearchSegmentsFtsForDocument,
  getDataDir,
  getDatabase,
  refreshTagUsageForTags,
  scheduleDatabaseSave,
} from './database'
import { hydratePagePayloadRow } from './page-payload-store'
import { buildTranslationUnitDrafts } from '../shared/translation-units'
import {
  type CopyDocumentsToLibraryProjectResult,
  DEFAULT_LIBRARY_PROJECT_ID,
  type CreateLibraryProjectPayload,
  type DocumentPage,
  type LibraryProject,
  type MoveDocumentsToLibraryProjectResult,
} from '../shared/types'

interface ProjectRow {
  id: string
  name: string
  description: string | null
  color: string | null
  is_default: number
  document_count: number
  created_at: string
  updated_at: string
}

const libraryProjectContext = new AsyncLocalStorage<string>()

function libraryProjectExists(projectId: string): boolean {
  return Boolean(getDatabase().prepare('SELECT 1 FROM library_projects WHERE id = ?').get(projectId))
}

export function requireLibraryProjectId(projectId: string): string {
  const normalizedId = String(projectId || '').trim()
  if (!normalizedId || !libraryProjectExists(normalizedId)) {
    throw new Error('目标文献项目不存在')
  }
  return normalizedId
}

export function withLibraryProjectContext<T>(projectId: string, operation: () => T): T {
  return libraryProjectContext.run(requireLibraryProjectId(projectId), operation)
}

export function captureActiveLibraryProjectId(requestedProjectId?: string | null): string {
  const requested = String(requestedProjectId || '').trim()
  return requested ? requireLibraryProjectId(requested) : getActiveLibraryProjectId()
}

export function filterDocumentIdsForLibraryProject(documentIds: string[], projectId: string): string[] {
  const uniqueIds = [...new Set((documentIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (uniqueIds.length === 0) return []
  const normalizedProjectId = requireLibraryProjectId(projectId)
  const matched: string[] = []
  const sqlite = getDatabase()
  for (let offset = 0; offset < uniqueIds.length; offset += 400) {
    const chunk = uniqueIds.slice(offset, offset + 400)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = sqlite.prepare(
      `SELECT id
       FROM documents
       WHERE library_project_id = ?
         AND id IN (${placeholders})`,
    ).all(normalizedProjectId, ...chunk) as Array<{ id: string }>
    matched.push(...rows.map((row) => row.id))
  }
  const matchedIds = new Set(matched)
  return uniqueIds.filter((id) => matchedIds.has(id))
}

export function assertDocumentIdsInLibraryProject(documentIds: string[], projectId: string): string[] {
  const uniqueIds = [...new Set((documentIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const matched = filterDocumentIdsForLibraryProject(uniqueIds, projectId)
  if (matched.length !== uniqueIds.length) {
    throw new Error('部分文献不属于当前项目，请刷新文献列表后重试')
  }
  return matched
}

export function assertDocumentInLibraryProject(documentId: string, projectId: string): string {
  const normalizedId = String(documentId || '').trim()
  if (!normalizedId || assertDocumentIdsInLibraryProject([normalizedId], projectId).length !== 1) {
    throw new Error('文献不属于当前项目')
  }
  return normalizedId
}

function normalizeProject(row: ProjectRow): LibraryProject {
  return {
    ...row,
    description: row.description || '',
    color: row.color || '#1677ff',
    document_count: Number(row.document_count || 0),
  }
}

export function listLibraryProjects(): LibraryProject[] {
  const rows = getDatabase().prepare(
    `SELECT
       lp.id,
       lp.name,
       lp.description,
       lp.color,
       lp.is_default,
       lp.created_at,
       lp.updated_at,
       COUNT(CASE WHEN d.import_status != 'deleting' THEN 1 END) AS document_count
     FROM library_projects lp
     LEFT JOIN documents d ON d.library_project_id = lp.id
     GROUP BY lp.id
     ORDER BY lp.is_default DESC, lp.updated_at DESC, lp.name COLLATE NOCASE ASC`,
  ).all() as ProjectRow[]
  return rows.map(normalizeProject)
}

export function getActiveLibraryProjectId(): string {
  const sqlite = getDatabase()
  const contextualProjectId = libraryProjectContext.getStore()
  if (contextualProjectId && libraryProjectExists(contextualProjectId)) return contextualProjectId
  const setting = sqlite.prepare(
    "SELECT value FROM settings WHERE key = 'active_library_project_id'",
  ).get() as { value?: string } | undefined
  const requestedId = String(setting?.value || '')
  const requestedExists = requestedId
    ? sqlite.prepare('SELECT 1 FROM library_projects WHERE id = ?').get(requestedId)
    : null
  if (requestedExists) return requestedId

  const fallback = sqlite.prepare(
    'SELECT id FROM library_projects ORDER BY is_default DESC, created_at ASC LIMIT 1',
  ).get() as { id?: string } | undefined
  const fallbackId = String(fallback?.id || DEFAULT_LIBRARY_PROJECT_ID)
  sqlite.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_library_project_id', ?)",
  ).run(fallbackId)
  scheduleDatabaseSave()
  return fallbackId
}

export function getActiveLibraryProject(): LibraryProject {
  const activeId = getActiveLibraryProjectId()
  const project = listLibraryProjects().find((item) => item.id === activeId)
  if (!project) throw new Error('当前文献项目不存在')
  return project
}

export function createLibraryProject(payload: CreateLibraryProjectPayload): LibraryProject {
  const name = String(payload?.name || '').trim()
  if (!name) throw new Error('请输入项目名称')
  if (name.length > 80) throw new Error('项目名称不能超过 80 个字符')

  const sqlite = getDatabase()
  const duplicate = sqlite.prepare(
    'SELECT 1 FROM library_projects WHERE name = ? COLLATE NOCASE',
  ).get(name)
  if (duplicate) throw new Error('已经存在同名文献项目')

  const id = `library_project_${randomUUID()}`
  const now = new Date().toISOString()
  const description = String(payload.description || '').trim().slice(0, 500)
  const color = /^#[0-9a-f]{6}$/i.test(String(payload.color || ''))
    ? String(payload.color)
    : '#1677ff'
  sqlite.transaction(() => {
    sqlite.prepare(
      `INSERT INTO library_projects
       (id, name, description, color, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, name, description, color, now, now)
    if (payload.activate) {
      sqlite.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_library_project_id', ?)",
      ).run(id)
    }
  })()
  scheduleDatabaseSave()
  const project = listLibraryProjects().find((item) => item.id === id)
  if (!project) throw new Error('文献项目创建失败')
  return project
}

export function setActiveLibraryProject(projectId: string): LibraryProject {
  const normalizedId = String(projectId || '').trim()
  const project = listLibraryProjects().find((item) => item.id === normalizedId)
  if (!project) throw new Error('目标文献项目不存在')
  getDatabase().prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_library_project_id', ?)",
  ).run(normalizedId)
  scheduleDatabaseSave()
  return project
}

interface ProjectTagRow {
  id: string
  library_project_id: string
  name: string
  color: string | null
  parent_id: string | null
  source: string | null
  confidence: number | null
  normalized_name: string | null
}

interface ProjectFolderRow {
  id: string
  library_project_id: string
  name: string
  parent_id: string | null
  external_path: string | null
  icon: string | null
  color: string | null
  sort_order: number | null
}

function ensureTagInLibraryProject(
  sourceTagId: string,
  targetProjectId: string,
  mapping: Map<string, string>,
): string {
  const key = `${sourceTagId}\u001f${targetProjectId}`
  const cached = mapping.get(key)
  if (cached) return cached
  const sqlite = getDatabase()
  const source = sqlite.prepare('SELECT * FROM tags WHERE id = ?').get(sourceTagId) as ProjectTagRow | undefined
  if (!source) throw new Error('文献关联的标签不存在')
  if (source.library_project_id === targetProjectId) {
    mapping.set(key, source.id)
    return source.id
  }
  const normalizedName = String(source.normalized_name || source.name).trim().toLowerCase()
  const existing = sqlite.prepare(
    'SELECT id FROM tags WHERE library_project_id = ? AND normalized_name = ? LIMIT 1',
  ).get(targetProjectId, normalizedName) as { id?: string } | undefined
  if (existing?.id) {
    mapping.set(key, existing.id)
    return existing.id
  }
  const targetParentId = source.parent_id
    ? ensureTagInLibraryProject(source.parent_id, targetProjectId, mapping)
    : null
  const id = `tag_${randomUUID()}`
  const now = new Date().toISOString()
  sqlite.prepare(
    `INSERT INTO tags
     (id, library_project_id, name, color, parent_id, source, confidence, usage_count, normalized_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    targetProjectId,
    source.name,
    source.color || '#1890ff',
    targetParentId,
    source.source || 'manual',
    source.confidence ?? null,
    normalizedName,
    now,
    now,
  )
  mapping.set(key, id)
  return id
}

function ensureFolderInLibraryProject(
  sourceFolderId: string,
  targetProjectId: string,
  mapping: Map<string, string>,
): string {
  const key = `${sourceFolderId}\u001f${targetProjectId}`
  const cached = mapping.get(key)
  if (cached) return cached
  const sqlite = getDatabase()
  const source = sqlite.prepare('SELECT * FROM folders WHERE id = ?').get(sourceFolderId) as ProjectFolderRow | undefined
  if (!source) throw new Error('文献关联的文件夹不存在')
  if (source.library_project_id === targetProjectId) {
    mapping.set(key, source.id)
    return source.id
  }
  const targetParentId = source.parent_id
    ? ensureFolderInLibraryProject(source.parent_id, targetProjectId, mapping)
    : null
  const existing = sqlite.prepare(
    `SELECT id
     FROM folders
     WHERE library_project_id = ?
       AND name = ?
       AND parent_id ${targetParentId ? '= ?' : 'IS NULL'}
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(...(targetParentId
    ? [targetProjectId, source.name, targetParentId]
    : [targetProjectId, source.name])) as { id?: string } | undefined
  if (existing?.id) {
    mapping.set(key, existing.id)
    return existing.id
  }
  const id = `folder_${randomUUID()}`
  const now = new Date().toISOString()
  sqlite.prepare(
    `INSERT INTO folders
     (id, library_project_id, name, parent_id, external_path, icon, color, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    targetProjectId,
    source.name,
    targetParentId,
    source.external_path,
    source.icon || 'folder',
    source.color,
    Number(source.sort_order || 0),
    now,
    now,
  )
  mapping.set(key, id)
  return id
}

function remapDocumentOrganizationForProject(
  documentId: string,
  targetProjectId: string,
  tagMapping: Map<string, string>,
  folderMapping: Map<string, string>,
): void {
  const sqlite = getDatabase()
  const tagIds = sqlite.prepare('SELECT tag_id FROM document_tags WHERE doc_id = ?').all(documentId) as Array<{ tag_id: string }>
  tagIds.forEach(({ tag_id: sourceTagId }) => {
    const targetTagId = ensureTagInLibraryProject(sourceTagId, targetProjectId, tagMapping)
    if (targetTagId === sourceTagId) return
    sqlite.prepare(
      `INSERT OR IGNORE INTO document_tags
       (doc_id, tag_id, is_manual, is_metadata, source_field, confidence, created_at, updated_at)
       SELECT doc_id, ?, is_manual, is_metadata, source_field, confidence, created_at, updated_at
       FROM document_tags
       WHERE doc_id = ? AND tag_id = ?`,
    ).run(targetTagId, documentId, sourceTagId)
    sqlite.prepare('DELETE FROM document_tags WHERE doc_id = ? AND tag_id = ?').run(documentId, sourceTagId)
  })

  const folderIds = sqlite.prepare('SELECT folder_id FROM document_folders WHERE doc_id = ?').all(documentId) as Array<{ folder_id: string }>
  folderIds.forEach(({ folder_id: sourceFolderId }) => {
    const targetFolderId = ensureFolderInLibraryProject(sourceFolderId, targetProjectId, folderMapping)
    if (targetFolderId === sourceFolderId) return
    sqlite.prepare('INSERT OR IGNORE INTO document_folders (doc_id, folder_id) VALUES (?, ?)')
      .run(documentId, targetFolderId)
    sqlite.prepare('DELETE FROM document_folders WHERE doc_id = ? AND folder_id = ?')
      .run(documentId, sourceFolderId)
  })
}

type SqliteValue = string | number | bigint | Buffer | null
type SqliteRow = Record<string, SqliteValue>

interface DocumentCopyAssets {
  sourceDocumentId: string
  copiedDocumentId: string
  sourceRoot: string
  copiedRoot: string
  externalPathMap: Map<string, string>
}

interface DocumentCopyPlan {
  sourceDocumentId: string
  copiedDocumentId: string
  document: SqliteRow
  pages: SqliteRow[]
  assets: DocumentCopyAssets
}

interface DocumentCopyReferences {
  pageIds: Map<string, string>
  translationUnitIds: Map<string, string>
  translationBlockIds: Map<string, string>
  segmentIds: Map<string, string>
}

function insertSqliteRow(table: string, row: SqliteRow): void {
  const columns = Object.keys(row)
  if (columns.length === 0) return
  const quotedColumns = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  getDatabase().prepare(`INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders})`)
    .run(...columns.map((column) => row[column]))
}

function cloneDocumentRows(
  table: string,
  whereSql: string,
  params: SqliteValue[],
  transform: (row: SqliteRow) => SqliteRow,
): void {
  const rows = getDatabase().prepare(`SELECT * FROM "${table}" WHERE ${whereSql}`).all(...params) as SqliteRow[]
  rows.forEach((row) => insertSqliteRow(table, transform({ ...row })))
}

function getManagedAssetRelativePath(rawPath: string, sourceDocumentId: string, sourceRoot: string): string | null {
  const absolutePath = resolve(rawPath)
  const relativePath = relative(resolve(sourceRoot), absolutePath)
  if (relativePath === '') return ''
  if (!relativePath.startsWith('..') && !isAbsolute(relativePath)) return relativePath

  const parts = normalize(rawPath).split(/[\\/]+/).filter(Boolean)
  const lowerParts = parts.map((part) => part.toLowerCase())
  const sourceId = sourceDocumentId.toLowerCase()
  for (let index = lowerParts.length - 1; index >= 0; index -= 1) {
    if (lowerParts[index] !== sourceId) continue
    if (lowerParts.slice(0, index).lastIndexOf('storage') < 0) continue
    return parts.slice(index + 1).join('\\')
  }
  return null
}

function remapCopiedAssetPath(rawValue: SqliteValue, assets: DocumentCopyAssets): SqliteValue {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return rawValue
  const externalCopy = assets.externalPathMap.get(rawValue)
  if (externalCopy) return externalCopy
  const managedRelative = getManagedAssetRelativePath(rawValue, assets.sourceDocumentId, assets.sourceRoot)
  if (managedRelative === null) return rawValue
  return managedRelative ? join(assets.copiedRoot, managedRelative) : assets.copiedRoot
}

function getDocumentAssetPaths(document: SqliteRow, pages: SqliteRow[]): string[] {
  const paths = new Set<string>()
  for (const value of [document.file_path, document.thumb_path, ...pages.map((page) => page.image_path)]) {
    if (typeof value === 'string' && value.trim()) paths.add(value)
  }
  return [...paths]
}

async function stageDocumentAssets(
  sourceDocumentId: string,
  copiedDocumentId: string,
  assetPaths: string[],
): Promise<DocumentCopyAssets> {
  const storageRoot = join(getDataDir(), 'storage')
  const sourceRoot = join(storageRoot, sourceDocumentId)
  const copiedRoot = join(storageRoot, copiedDocumentId)
  const externalPathMap = new Map<string, string>()
  await mkdir(storageRoot, { recursive: true })
  try {
    if (existsSync(sourceRoot)) {
      await cp(sourceRoot, copiedRoot, { recursive: true, errorOnExist: true, force: false })
    }

    for (const rawPath of assetPaths) {
      if (getManagedAssetRelativePath(rawPath, sourceDocumentId, sourceRoot) !== null) continue
      const sourcePath = resolve(rawPath)
      if (!existsSync(sourcePath)) continue
      const sourceInfo = await stat(sourcePath).catch(() => null)
      if (!sourceInfo?.isFile()) continue
      const fingerprint = createHash('sha1').update(normalize(sourcePath).toLowerCase()).digest('hex').slice(0, 12)
      const copiedPath = join(copiedRoot, 'external', `${fingerprint}-${basename(sourcePath)}`)
      await mkdir(join(copiedRoot, 'external'), { recursive: true })
      await copyFile(sourcePath, copiedPath)
      externalPathMap.set(rawPath, copiedPath)
    }
  } catch (error) {
    await rm(copiedRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  return {
    sourceDocumentId,
    copiedDocumentId,
    sourceRoot,
    copiedRoot,
    externalPathMap,
  }
}

function createTranslationReferenceMaps(
  plan: DocumentCopyPlan,
  pageIds: Map<string, string>,
): Pick<DocumentCopyReferences, 'translationUnitIds' | 'translationBlockIds'> {
  const sqlite = getDatabase()
  const translationUnitIds = new Map<string, string>()
  const translationBlockIds = new Map<string, string>()
  for (const page of plan.pages) {
    const sourcePageId = String(page.id || '')
    const copiedPageId = pageIds.get(sourcePageId)
    if (!copiedPageId) continue
    const hydrated = hydratePagePayloadRow<Record<string, unknown>>({ ...page })
    const sourcePage = {
      id: sourcePageId,
      page_num: Number(page.page_num || 0),
      ocr_result: hydrated.ocr_result as DocumentPage['ocr_result'],
      proofed_text: hydrated.proofed_text as DocumentPage['proofed_text'],
      ocr_text: hydrated.ocr_text as DocumentPage['ocr_text'],
    }
    const copiedPage = { ...sourcePage, id: copiedPageId }
    const sourceDrafts = buildTranslationUnitDrafts(sourcePage)
    const copiedDrafts = buildTranslationUnitDrafts(copiedPage)
    const copiedDraftBySourceId = new Map(
      sourceDrafts.map((draft, index) => [draft.id, copiedDrafts[index]]),
    )
    const storedUnits = sqlite.prepare(
      'SELECT unit_id, block_id, block_index, unit_order, source_hash FROM page_translation_units WHERE page_id = ?',
    ).all(sourcePageId) as Array<{
      unit_id: string
      block_id: string
      block_index: number
      unit_order: number
      source_hash: string
    }>
    storedUnits.forEach((unit) => {
      const copiedDraft = copiedDraftBySourceId.get(unit.unit_id)
        || copiedDrafts.find((draft) => (
          draft.blockIndex === Number(unit.block_index)
          && draft.sourceHash === String(unit.source_hash || '')
        ))
        || copiedDrafts.find((draft) => draft.order === Number(unit.unit_order))
      const copiedUnitId = copiedDraft?.id || `tu_copy_${randomUUID()}`
      const copiedBlockId = copiedDraft?.blockId || `tb_copy_${randomUUID()}`
      translationUnitIds.set(unit.unit_id, copiedUnitId)
      translationBlockIds.set(unit.block_id, copiedBlockId)
    })
  }
  return { translationUnitIds, translationBlockIds }
}

function createDocumentCopyReferences(plan: DocumentCopyPlan): DocumentCopyReferences {
  const pageIds = new Map(
    plan.pages.map((page) => [String(page.id || ''), `page_${randomUUID()}`]),
  )
  const translationReferences = createTranslationReferenceMaps(plan, pageIds)
  const segmentIds = new Map<string, string>()
  const rows = getDatabase().prepare(
    'SELECT segment_id, page_id, source_kind FROM search_index_segments WHERE doc_id = ?',
  ).all(plan.sourceDocumentId) as Array<{ segment_id: string; page_id: string | null; source_kind: string | null }>
  rows.forEach((row) => {
    const sourceSegmentId = String(row.segment_id || '')
    let copiedSegmentId = ''
    if (String(row.source_kind || '') === 'translation') {
      const [, sourceUnitId = '', sourceBlockId = ''] = sourceSegmentId.split(':')
      const copiedUnitId = translationReferences.translationUnitIds.get(sourceUnitId)
      const copiedBlockId = translationReferences.translationBlockIds.get(sourceBlockId)
      if (copiedUnitId && copiedBlockId) copiedSegmentId = `translation:${copiedUnitId}:${copiedBlockId}`
    } else if (row.page_id) {
      const copiedPageId = pageIds.get(row.page_id)
      const prefix = `${plan.sourceDocumentId}:${row.page_id}:`
      if (copiedPageId && sourceSegmentId.startsWith(prefix)) {
        copiedSegmentId = `${plan.copiedDocumentId}:${copiedPageId}:${sourceSegmentId.slice(prefix.length)}`
      }
    }
    segmentIds.set(sourceSegmentId, copiedSegmentId || `segment_copy_${randomUUID()}`)
  })
  return {
    pageIds,
    translationUnitIds: translationReferences.translationUnitIds,
    translationBlockIds: translationReferences.translationBlockIds,
    segmentIds,
  }
}

function remapEmbeddedCopyReferences(value: SqliteValue, mappings: Map<string, string>[]): SqliteValue {
  if (typeof value !== 'string' || !value) return value
  let next = value
  mappings.forEach((mapping) => {
    mapping.forEach((replacement, source) => {
      next = next.split(source).join(replacement)
    })
  })
  return next
}

function copyDocumentOrganizationToProject(
  sourceDocumentId: string,
  copiedDocumentId: string,
  targetProjectId: string,
  tagMapping: Map<string, string>,
  folderMapping: Map<string, string>,
): void {
  cloneDocumentRows('document_tags', 'doc_id = ?', [sourceDocumentId], (row) => ({
    ...row,
    doc_id: copiedDocumentId,
    tag_id: ensureTagInLibraryProject(String(row.tag_id || ''), targetProjectId, tagMapping),
  }))
  cloneDocumentRows('document_folders', 'doc_id = ?', [sourceDocumentId], (row) => ({
    ...row,
    doc_id: copiedDocumentId,
    folder_id: ensureFolderInLibraryProject(String(row.folder_id || ''), targetProjectId, folderMapping),
  }))
}

function copyDocumentDatabaseRows(
  plan: DocumentCopyPlan,
  targetProjectId: string,
  tagMapping: Map<string, string>,
  folderMapping: Map<string, string>,
): void {
  const now = new Date().toISOString()
  const references = createDocumentCopyReferences(plan)
  const idMappings = [
    new Map([[plan.sourceDocumentId, plan.copiedDocumentId]]),
    references.pageIds,
    references.translationUnitIds,
    references.translationBlockIds,
    references.segmentIds,
  ]
  insertSqliteRow('documents', {
    ...plan.document,
    id: plan.copiedDocumentId,
    library_project_id: targetProjectId,
    file_path: remapCopiedAssetPath(plan.document.file_path, plan.assets),
    thumb_path: remapCopiedAssetPath(plan.document.thumb_path, plan.assets),
    created_at: now,
    updated_at: now,
    last_opened_at: null,
  })

  plan.pages.forEach((sourcePage) => {
    insertSqliteRow('pages', {
      ...sourcePage,
      id: references.pageIds.get(String(sourcePage.id || '')) || `page_${randomUUID()}`,
      doc_id: plan.copiedDocumentId,
      image_path: remapCopiedAssetPath(sourcePage.image_path, plan.assets),
      active_ocr_artifact_id: null,
      proof_base_artifact_id: null,
    })
  })

  cloneDocumentRows('page_ocr_versions', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    id: `page_ocr_version_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
    page_id: references.pageIds.get(String(row.page_id || '')) || null,
  }))
  cloneDocumentRows('metadata_candidates', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    id: `metadata_candidate_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
  }))
  cloneDocumentRows('ai_results', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    id: `ai_result_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
  }))
  cloneDocumentRows('reader_state', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    doc_id: plan.copiedDocumentId,
    location_key: remapEmbeddedCopyReferences(row.location_key, idMappings),
    proof_location_key: remapEmbeddedCopyReferences(row.proof_location_key, idMappings),
  }))
  cloneDocumentRows('page_ai_layout_cache', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    id: `page_ai_layout_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
    page_id: references.pageIds.get(String(row.page_id || '')) || null,
  }))
  cloneDocumentRows('page_translation_cache', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    id: `page_translation_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
    page_id: references.pageIds.get(String(row.page_id || '')) || null,
  }))
  cloneDocumentRows('page_translation_units', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    id: `page_translation_unit_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
    page_id: references.pageIds.get(String(row.page_id || '')) || null,
    unit_id: references.translationUnitIds.get(String(row.unit_id || '')) || `tu_copy_${randomUUID()}`,
    block_id: references.translationBlockIds.get(String(row.block_id || '')) || `tb_copy_${randomUUID()}`,
  }))

  const tocRows = getDatabase().prepare(
    'SELECT * FROM document_toc_items WHERE doc_id = ? ORDER BY order_index, id',
  ).all(plan.sourceDocumentId) as SqliteRow[]
  const tocIds = new Map(tocRows.map((row) => [String(row.id || ''), `toc_${randomUUID()}`]))
  tocRows.forEach((row) => insertSqliteRow('document_toc_items', {
    ...row,
    id: tocIds.get(String(row.id || '')) || `toc_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
    parent_id: row.parent_id ? tocIds.get(String(row.parent_id)) || null : null,
    href: remapEmbeddedCopyReferences(row.href, idMappings),
  }))

  cloneDocumentRows('search_index_segments', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    segment_id: references.segmentIds.get(String(row.segment_id || '')) || `segment_copy_${randomUUID()}`,
    library_project_id: targetProjectId,
    doc_id: plan.copiedDocumentId,
    page_id: row.page_id ? references.pageIds.get(String(row.page_id)) || null : null,
  }))
  cloneDocumentRows('search_ngram_index', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    segment_id: references.segmentIds.get(String(row.segment_id || '')) || `segment_copy_${randomUUID()}`,
    doc_id: plan.copiedDocumentId,
  }))
  cloneDocumentRows('embedding_chunks', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    segment_id: references.segmentIds.get(String(row.segment_id || '')) || `segment_copy_${randomUUID()}`,
    library_project_id: targetProjectId,
    doc_id: plan.copiedDocumentId,
    page_id: row.page_id ? references.pageIds.get(String(row.page_id)) || null : null,
  }))
  cloneDocumentRows('search_index_status', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    doc_id: plan.copiedDocumentId,
  }))
  cloneDocumentRows('embedding_index_status', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    doc_id: plan.copiedDocumentId,
  }))
  cloneDocumentRows('ai_document_summaries', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    doc_id: plan.copiedDocumentId,
  }))
  cloneDocumentRows('research_notes', 'doc_id = ?', [plan.sourceDocumentId], (row) => ({
    ...row,
    id: `research_note_${randomUUID()}`,
    project_id: null,
    doc_id: plan.copiedDocumentId,
    outline_id: null,
    source_id: remapEmbeddedCopyReferences(row.source_id, idMappings),
    locator_json: remapEmbeddedCopyReferences(row.locator_json, idMappings),
    citation_text: remapEmbeddedCopyReferences(row.citation_text, idMappings),
  }))
  copyDocumentOrganizationToProject(
    plan.sourceDocumentId,
    plan.copiedDocumentId,
    targetProjectId,
    tagMapping,
    folderMapping,
  )
}

export async function copyDocumentsToLibraryProject(
  documentIds: string[],
  targetProjectId: string,
): Promise<CopyDocumentsToLibraryProjectResult> {
  const uniqueIds = [...new Set((documentIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const normalizedTargetId = requireLibraryProjectId(String(targetProjectId || '').trim())
  const sourceProjectId = getActiveLibraryProjectId()
  if (normalizedTargetId === sourceProjectId) throw new Error('目标项目不能与当前项目相同')
  if (uniqueIds.length === 0) {
    return {
      requested: 0,
      copied: 0,
      source_project_id: sourceProjectId,
      target_project_id: normalizedTargetId,
      documents: [],
    }
  }
  assertDocumentIdsInLibraryProject(uniqueIds, sourceProjectId)

  const sqlite = getDatabase()
  const plans: DocumentCopyPlan[] = []
  let databaseCommitted = false
  try {
    for (const sourceDocumentId of uniqueIds) {
      const document = sqlite.prepare('SELECT * FROM documents WHERE id = ?').get(sourceDocumentId) as SqliteRow | undefined
      if (!document) throw new Error('要复制的文献不存在')
      const pages = sqlite.prepare('SELECT * FROM pages WHERE doc_id = ? ORDER BY page_num, id')
        .all(sourceDocumentId) as SqliteRow[]
      const copiedDocumentId = `doc_${randomUUID()}`
      const assets = await stageDocumentAssets(
        sourceDocumentId,
        copiedDocumentId,
        getDocumentAssetPaths(document, pages),
      )
      plans.push({ sourceDocumentId, copiedDocumentId, document, pages, assets })
    }

    requireLibraryProjectId(normalizedTargetId)
    assertDocumentIdsInLibraryProject(uniqueIds, sourceProjectId)
    const tagMapping = new Map<string, string>()
    const folderMapping = new Map<string, string>()
    sqlite.transaction(() => {
      plans.forEach((plan) => {
        copyDocumentDatabaseRows(plan, normalizedTargetId, tagMapping, folderMapping)
      })
      sqlite.prepare('UPDATE library_projects SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), normalizedTargetId)
    })()
    databaseCommitted = true
    try {
      refreshTagUsageForTags([...new Set(tagMapping.values())])
    } catch (error) {
      console.warn('[LibraryProjects] Failed to refresh copied tag usage:', error)
    }
    plans.forEach((plan) => {
      try {
        appendSearchSegmentsFtsForDocument(plan.copiedDocumentId)
      } catch (error) {
        console.warn(`[LibraryProjects] Failed to append copied search index for ${plan.copiedDocumentId}:`, error)
      }
    })
    scheduleDatabaseSave()
    return {
      requested: uniqueIds.length,
      copied: plans.length,
      source_project_id: sourceProjectId,
      target_project_id: normalizedTargetId,
      documents: plans.map((plan) => ({
        source_document_id: plan.sourceDocumentId,
        copied_document_id: plan.copiedDocumentId,
      })),
    }
  } catch (error) {
    if (!databaseCommitted) {
      await Promise.all(plans.map((plan) => (
        rm(plan.assets.copiedRoot, { recursive: true, force: true }).catch(() => undefined)
      )))
    }
    throw error
  }
}

export function moveDocumentsToLibraryProject(
  documentIds: string[],
  targetProjectId: string,
): MoveDocumentsToLibraryProjectResult {
  const uniqueIds = [...new Set((documentIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
  const normalizedTargetId = String(targetProjectId || '').trim()
  const sqlite = getDatabase()
  requireLibraryProjectId(normalizedTargetId)
  const targetExists = sqlite.prepare('SELECT 1 FROM library_projects WHERE id = ?').get(normalizedTargetId)
  if (!targetExists) throw new Error('目标文献项目不存在')
  if (uniqueIds.length === 0) {
    return {
      requested: 0,
      moved: 0,
      from_project_ids: [],
      target_project_id: normalizedTargetId,
    }
  }

  const sourceProjectId = getActiveLibraryProjectId()
  assertDocumentIdsInLibraryProject(uniqueIds, sourceProjectId)
  const fromProjectIds = new Set<string>()
  const tagMapping = new Map<string, string>()
  const folderMapping = new Map<string, string>()
  let moved = 0
  sqlite.transaction(() => {
    for (let offset = 0; offset < uniqueIds.length; offset += 400) {
      const chunk = uniqueIds.slice(offset, offset + 400)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = sqlite.prepare(
        `SELECT DISTINCT library_project_id
         FROM documents
         WHERE id IN (${placeholders}) AND library_project_id != ?`,
      ).all(...chunk, normalizedTargetId) as Array<{ library_project_id?: string }>
      rows.forEach((row) => {
        if (row.library_project_id) fromProjectIds.add(row.library_project_id)
      })
      chunk.forEach((documentId) => {
        remapDocumentOrganizationForProject(documentId, normalizedTargetId, tagMapping, folderMapping)
      })
      const result = sqlite.prepare(
        `UPDATE documents
         SET library_project_id = ?, updated_at = ?
         WHERE id IN (${placeholders}) AND library_project_id != ?`,
      ).run(normalizedTargetId, new Date().toISOString(), ...chunk, normalizedTargetId)
      moved += result.changes
    }
    sqlite.prepare('UPDATE library_projects SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), normalizedTargetId)
  })()
  scheduleDatabaseSave()
  return {
    requested: uniqueIds.length,
    moved,
    from_project_ids: [...fromProjectIds],
    target_project_id: normalizedTargetId,
  }
}

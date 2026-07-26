import { randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'
import { getDatabase, scheduleDatabaseSave } from './database'
import {
  DEFAULT_LIBRARY_PROJECT_ID,
  type CreateLibraryProjectPayload,
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

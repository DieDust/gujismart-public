import { queryAll } from './database'
import { getActiveLibraryProjectId } from './library-projects'

interface FolderTreeRow {
  id: string
  parent_id?: string | null
}

interface FolderDocumentRow {
  folder_id: string
  doc_id: string
}

function uniqueIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

function buildChildrenByParent(folders: FolderTreeRow[]): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>()
  folders.forEach((folder) => {
    const parentId = String(folder.parent_id || '').trim()
    if (!parentId) return
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) || []), folder.id])
  })
  return childrenByParent
}

export function resolveFolderAndDescendantIds(folderIds: string[], libraryProjectId?: string): string[] {
  const roots = uniqueIds(folderIds)
  if (roots.length === 0) return []
  const projectId = libraryProjectId || getActiveLibraryProjectId()
  const folders = queryAll<FolderTreeRow>(
    'SELECT id, parent_id FROM folders WHERE library_project_id = ?',
    [projectId],
  )
  const knownIds = new Set(folders.map((folder) => folder.id))
  const childrenByParent = buildChildrenByParent(folders)
  const resolved: string[] = []
  const visited = new Set<string>()

  const visit = (folderId: string) => {
    if (!folderId || visited.has(folderId)) return
    visited.add(folderId)
    if (knownIds.has(folderId)) resolved.push(folderId)
    ;(childrenByParent.get(folderId) || []).forEach(visit)
  }

  roots.forEach(visit)
  return resolved
}

export function buildCumulativeFolderDocumentCounts(libraryProjectId?: string): Record<string, number> {
  const projectId = libraryProjectId || getActiveLibraryProjectId()
  const folders = queryAll<FolderTreeRow>(
    'SELECT id, parent_id FROM folders WHERE library_project_id = ?',
    [projectId],
  )
  if (folders.length === 0) return {}

  const childrenByParent = buildChildrenByParent(folders)
  const directDocIds = new Map<string, Set<string>>()
  queryAll<FolderDocumentRow>(
    `SELECT df.folder_id, df.doc_id
     FROM document_folders df
     INNER JOIN documents d ON d.id = df.doc_id
     WHERE COALESCE(d.import_status, '') <> 'deleting'
       AND EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)`,
    [projectId],
  ).forEach((row) => {
    if (!row.folder_id || !row.doc_id) return
    const docs = directDocIds.get(row.folder_id) || new Set<string>()
    docs.add(row.doc_id)
    directDocIds.set(row.folder_id, docs)
  })

  const memo = new Map<string, Set<string>>()
  const collect = (folderId: string, stack = new Set<string>()): Set<string> => {
    if (memo.has(folderId)) return memo.get(folderId) || new Set<string>()
    if (stack.has(folderId)) return new Set<string>()
    stack.add(folderId)
    const docs = new Set<string>(directDocIds.get(folderId) || [])
    ;(childrenByParent.get(folderId) || []).forEach((childId) => {
      collect(childId, stack).forEach((docId) => docs.add(docId))
    })
    stack.delete(folderId)
    memo.set(folderId, docs)
    return docs
  }

  return Object.fromEntries(folders.map((folder) => [folder.id, collect(folder.id).size]))
}

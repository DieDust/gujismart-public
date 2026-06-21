import { ipcMain, dialog } from 'electron'
import { queryAll, queryOne, run, saveDatabase, transaction } from '../database'
import { nanoid } from 'nanoid'
import { join, extname } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import type { BulkAssociationResult, Document, Folder, FolderCreatePayload, FolderImportFile, FolderUpdatePayload } from '../../shared/types'
import { markLibraryStateCacheDirty } from '../library-state-cache'
import { buildCumulativeFolderDocumentCounts, resolveFolderAndDescendantIds } from '../folder-scope'

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

function normalizeFolderName(value: unknown): string {
  return String(value || '').trim()
}

function normalizeParentId(value: unknown): string | null {
  const parentId = String(value || '').trim()
  return parentId || null
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
     WHERE name = ?
       AND parent_id ${parentId ? '= ?' : 'IS NULL'}
       ${excludeSql}
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    params,
  )
}

function updateExistingFolderMetadata(folder: Folder, data: FolderCreatePayload | FolderUpdatePayload, now: string): Folder | null {
  const sets: string[] = []
  const params: unknown[] = []
  if (!folder.external_path && data.external_path) {
    sets.push('external_path = ?')
    params.push(data.external_path)
  }
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
  const source = queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [sourceId])
  const target = queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [targetId])
  if (!source || !target) return

  run(
    `INSERT OR IGNORE INTO document_folders (doc_id, folder_id)
     SELECT doc_id, ? FROM document_folders WHERE folder_id = ?`,
    [targetId, sourceId],
  )
  run('DELETE FROM document_folders WHERE folder_id = ?', [sourceId])

  const children = queryAll<Folder>('SELECT * FROM folders WHERE parent_id = ? ORDER BY sort_order, created_at', [sourceId])
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
  if (!target.external_path && (data.external_path || source.external_path)) {
    sets.push('external_path = ?')
    params.push(data.external_path || source.external_path)
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
    const counts = buildCumulativeFolderDocumentCounts()
    return queryAll<Folder>('SELECT * FROM folders ORDER BY sort_order, created_at')
      .map((folder) => ({ ...folder, document_count: counts[folder.id] || 0 }))
  })

  ipcMain.handle('folders:get', async (_event, id: string): Promise<Folder | null> => {
    return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [id])
  })

  ipcMain.handle('folders:create', async (_event, data: FolderCreatePayload): Promise<Folder | null> => {
    const name = normalizeFolderName(data.name)
    if (!name) throw new Error('文件夹名称不能为空')
    const parentId = normalizeParentId(data.parent_id)
    const now = new Date().toISOString()
    const existing = findFolderByNameInParent(name, parentId)
    if (existing) {
      return updateExistingFolderMetadata(existing, data, now)
    }

    const id = nanoid()
    const maxOrder = queryOne<{ max_order: number | null }>('SELECT MAX(sort_order) as max_order FROM folders WHERE parent_id ' + (parentId ? '= ?' : 'IS NULL'), parentId ? [parentId] : undefined)
    const sortOrder = (maxOrder?.max_order as number || 0) + 1

    run(
      'INSERT INTO folders (id, name, parent_id, external_path, icon, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, parentId, data.external_path || null, data.icon || 'folder', data.color || null, sortOrder, now, now]
    )
    saveDatabase()
    markLibraryStateCacheDirty()

    return queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [id])
  })

  ipcMain.handle('folders:update', async (_event, id: string, data: FolderUpdatePayload): Promise<boolean> => {
    const folderId = String(id || '').trim()
    if (!folderId) return false
    const current = queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [folderId])
    if (!current) return false

    const nextName = 'name' in data ? normalizeFolderName(data.name) : current.name
    if (!nextName) throw new Error('文件夹名称不能为空')
    const nextParentId = 'parent_id' in data ? normalizeParentId(data.parent_id) : current.parent_id
    const now = new Date().toISOString()
    const existing = findFolderByNameInParent(nextName, nextParentId, folderId)
    if (existing) {
      mergeFolderInto(folderId, existing.id, data, now)
      return true
    }

    const allowedFields: Array<keyof FolderUpdatePayload> = ['name', 'parent_id', 'external_path', 'icon', 'color', 'sort_order']
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

  ipcMain.handle('folders:delete', async (_event, id: string): Promise<boolean> => {
    const folderId = String(id || '').trim()
    if (!folderId) return false
    const folder = queryOne<Pick<Folder, 'id'>>('SELECT id FROM folders WHERE id = ?', [folderId])
    if (!folder) return false

    transaction(() => {
      run('DELETE FROM document_folders WHERE folder_id = ?', [folderId])
      run('UPDATE folders SET parent_id = NULL, updated_at = ? WHERE parent_id = ?', [new Date().toISOString(), folderId])
      run('DELETE FROM folders WHERE id = ?', [folderId])
    })
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('folders:addDocument', async (_event, docId: string, folderId: string): Promise<boolean> => {
    run('INSERT OR IGNORE INTO document_folders (doc_id, folder_id) VALUES (?, ?)', [docId, folderId])
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('folders:addDocuments', async (_event, docIds: string[], folderId: string): Promise<BulkAssociationResult> => {
    const targetFolderId = String(folderId || '').trim()
    const uniqueDocIds = [...new Set((docIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    if (!targetFolderId || uniqueDocIds.length === 0) return { count: 0 }

    const folder = queryOne<Pick<Folder, 'id'>>('SELECT id FROM folders WHERE id = ?', [targetFolderId])
    if (!folder) throw new Error('文件夹不存在')

    transaction(() => {
      for (const docId of uniqueDocIds) {
        run('INSERT OR IGNORE INTO document_folders (doc_id, folder_id) VALUES (?, ?)', [docId, targetFolderId])
      }
    })
    saveDatabase()
    markLibraryStateCacheDirty()
    return { count: uniqueDocIds.length }
  })

  ipcMain.handle('folders:removeDocument', async (_event, docId: string, folderId: string): Promise<boolean> => {
    run('DELETE FROM document_folders WHERE doc_id = ? AND folder_id = ?', [docId, folderId])
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('folders:getDocuments', async (_event, folderId: string): Promise<Document[]> => {
    const folderIds = resolveFolderAndDescendantIds([folderId])
    if (folderIds.length === 0) return []
    return queryAll<Document>(
      `SELECT DISTINCT d.*
       FROM documents d
       INNER JOIN document_folders df ON d.id = df.doc_id
       WHERE df.folder_id IN (${folderIds.map(() => '?').join(', ')})
       ORDER BY d.updated_at DESC`,
      folderIds
    )
  })

  ipcMain.handle('folders:selectExternal', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择外部文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('folders:scanExternal', async (_event, folderId: string): Promise<FolderImportFile[]> => {
    const folder = queryOne<Folder>('SELECT * FROM folders WHERE id = ?', [folderId])
    if (!folder || !folder.external_path) return []

    const extPath = folder.external_path
    if (!existsSync(extPath)) return []

    try {
      return collectSupportedFolderFiles(extPath)
    } catch (e) {
      console.error('[IPC] Failed to scan external folder:', e)
      return []
    }
  })

  ipcMain.handle('folders:scanPath', async (_event, dirPath: string): Promise<FolderImportFile[]> => {
    if (!existsSync(dirPath)) return []

    try {
      return collectSupportedFolderFiles(dirPath)
    } catch (e) {
      console.error('[IPC] Failed to scan path:', e)
      return []
    }
  })

}


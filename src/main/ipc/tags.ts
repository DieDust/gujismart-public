import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { queryAll, queryOne, refreshTagUsage, run, saveDatabase, transaction } from '../database'
import { clearMetadataTagBindings } from '../metadata-tags'
import type { BulkAssociationResult, MetadataTagBindingCleanupResult, Tag, TagCreatePayload, TagUpdatePayload } from '../../shared/types'
import { markLibraryStateCacheDirty } from '../library-state-cache'

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase()
}

function normalizeTagParentId(value: unknown): string | null {
  const parentId = String(value || '').trim()
  return parentId || null
}

function assertTagParentAllowed(tagId: string | null, nextParentId: string | null): void {
  if (!nextParentId) return
  const visited = new Set<string>()
  let currentId: string | null = nextParentId
  while (currentId) {
    if (tagId && currentId === tagId) throw new Error('不能把标签移动到自己或自己的子标签下面')
    if (visited.has(currentId)) throw new Error('标签层级已存在循环，请先修复后再编辑')
    visited.add(currentId)
    const current = queryOne<Pick<Tag, 'id' | 'parent_id'>>('SELECT id, parent_id FROM tags WHERE id = ?', [currentId])
    if (!current) throw new Error('父标签不存在')
    currentId = normalizeTagParentId(current.parent_id)
  }
}

export function registerTagIpc(): void {
  ipcMain.handle('tags:list', async (_event, search?: string): Promise<Tag[]> => {
    const keyword = search?.trim()
    if (keyword) {
      return queryAll<Tag>(
        'SELECT * FROM tags WHERE name LIKE ? OR normalized_name LIKE ? ORDER BY usage_count DESC, name ASC',
        [`%${keyword}%`, `%${normalizeTagName(keyword)}%`]
      )
    }
    return queryAll<Tag>('SELECT * FROM tags ORDER BY usage_count DESC, name ASC')
  })

  ipcMain.handle('tags:create', async (_event, data: TagCreatePayload): Promise<Tag | null> => {
    const name = String(data.name || '').trim()
    if (!name) throw new Error('标签名称不能为空')
    const normalizedName = normalizeTagName(name)
    const parentId = normalizeTagParentId(data.parent_id)
    assertTagParentAllowed(null, parentId)
    const existing = queryOne<Tag>('SELECT * FROM tags WHERE normalized_name = ?', [normalizedName])
    if (existing) return existing

    const id = nanoid()
    const now = new Date().toISOString()
    run(
      'INSERT INTO tags (id, name, color, parent_id, source, confidence, usage_count, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, data.color || '#1890ff', parentId, data.source || 'manual', data.confidence ?? null, 0, normalizedName, now, now]
    )
    saveDatabase()
    markLibraryStateCacheDirty()
    return queryOne<Tag>('SELECT * FROM tags WHERE id = ?', [id])
  })

  ipcMain.handle('tags:update', async (_event, id: string, data: TagUpdatePayload): Promise<Tag | null> => {
    const tagId = String(id || '').trim()
    if (!tagId) return null
    const current = queryOne<Tag>('SELECT * FROM tags WHERE id = ?', [tagId])
    if (!current) return null
    const nextName = data.name === undefined ? current.name : String(data.name || '').trim()
    if (!nextName) throw new Error('标签名称不能为空')
    const nextNormalizedName = normalizeTagName(nextName)
    const nextParentId = data.parent_id === undefined ? normalizeTagParentId(current.parent_id) : normalizeTagParentId(data.parent_id)
    assertTagParentAllowed(tagId, nextParentId)
    const conflict = queryOne<Tag>('SELECT * FROM tags WHERE normalized_name = ? AND id <> ?', [nextNormalizedName, tagId])
    if (conflict) throw new Error(`已存在同名标签“${nextName}”`)

    const sets: string[] = []
    const params: unknown[] = []

    if (data.name !== undefined) {
      sets.push('name = ?')
      params.push(nextName)
      sets.push('normalized_name = ?')
      params.push(nextNormalizedName)
    }
    if (data.color !== undefined) {
      sets.push('color = ?')
      params.push(data.color)
    }
    if (data.parent_id !== undefined) {
      sets.push('parent_id = ?')
      params.push(nextParentId)
    }
    if (data.source !== undefined) {
      sets.push('source = ?')
      params.push(data.source)
    }
    if (data.confidence !== undefined) {
      sets.push('confidence = ?')
      params.push(data.confidence)
    }
    sets.push('updated_at = ?')
    params.push(new Date().toISOString())

    if (sets.length === 0) {
      return queryOne<Tag>('SELECT * FROM tags WHERE id = ?', [id])
    }

    params.push(tagId)
    run(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    markLibraryStateCacheDirty()
    return queryOne<Tag>('SELECT * FROM tags WHERE id = ?', [tagId])
  })

  ipcMain.handle('tags:delete', async (_event, id: string): Promise<boolean> => {
    transaction(() => {
      run('DELETE FROM document_tags WHERE tag_id = ?', [id])
      run('DELETE FROM tags WHERE id = ?', [id])
    })
    refreshTagUsage()
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('tags:addDocument', async (_event, docId: string, tagId: string): Promise<boolean> => {
    const now = new Date().toISOString()
    run(
      `INSERT INTO document_tags (
        doc_id, tag_id, is_manual, is_metadata, created_at, updated_at
      ) VALUES (?, ?, 1, 0, ?, ?)
      ON CONFLICT(doc_id, tag_id) DO UPDATE SET
        is_manual = 1,
        is_metadata = 0,
        source_field = NULL,
        confidence = NULL,
        updated_at = excluded.updated_at`,
      [docId, tagId, now, now],
    )
    refreshTagUsage()
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('tags:addDocuments', async (_event, docIds: string[], tagIds: string[]): Promise<BulkAssociationResult> => {
    const uniqueDocIds = [...new Set((docIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    const uniqueTagIds = [...new Set((tagIds || []).map((id) => String(id || '').trim()).filter(Boolean))]
    if (uniqueDocIds.length === 0 || uniqueTagIds.length === 0) return { count: 0 }

    const now = new Date().toISOString()
    transaction(() => {
      for (const docId of uniqueDocIds) {
        for (const tagId of uniqueTagIds) {
          run(
            `INSERT INTO document_tags (
              doc_id, tag_id, is_manual, is_metadata, created_at, updated_at
            ) VALUES (?, ?, 1, 0, ?, ?)
            ON CONFLICT(doc_id, tag_id) DO UPDATE SET
              is_manual = 1,
              is_metadata = 0,
              source_field = NULL,
              confidence = NULL,
              updated_at = excluded.updated_at`,
            [docId, tagId, now, now],
          )
        }
      }
    })
    refreshTagUsage()
    saveDatabase()
    markLibraryStateCacheDirty()
    return { count: uniqueDocIds.length * uniqueTagIds.length }
  })

  ipcMain.handle('tags:removeDocument', async (_event, docId: string, tagId: string): Promise<boolean> => {
    run('DELETE FROM document_tags WHERE doc_id = ? AND tag_id = ?', [docId, tagId])
    refreshTagUsage()
    saveDatabase()
    markLibraryStateCacheDirty()
    return true
  })

  ipcMain.handle('tags:clearMetadataBindings', async (): Promise<MetadataTagBindingCleanupResult> => {
    const result = clearMetadataTagBindings()
    markLibraryStateCacheDirty()
    return result
  })
}

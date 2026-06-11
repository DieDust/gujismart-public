import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { queryAll, queryOne, refreshTagUsage, run, saveDatabase, transaction } from '../database'
import { clearMetadataTagBindings } from '../metadata-tags'
import type { BulkAssociationResult, MetadataTagBindingCleanupResult, Tag, TagCreatePayload, TagUpdatePayload } from '../../shared/types'

function normalizeTagName(name: string): string {
  return name.trim().toLowerCase()
}

export function registerTagIpc(): void {
  ipcMain.handle('tags:list', async (_event, search?: string): Promise<Tag[]> => {
    refreshTagUsage()
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
    const name = data.name.trim()
    const normalizedName = normalizeTagName(name)
    const existing = queryOne<Tag>('SELECT * FROM tags WHERE normalized_name = ?', [normalizedName])
    if (existing) return existing

    const id = nanoid()
    const now = new Date().toISOString()
    run(
      'INSERT INTO tags (id, name, color, parent_id, source, confidence, usage_count, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, data.color || '#1890ff', data.parent_id || null, data.source || 'manual', data.confidence ?? null, 0, normalizedName, now, now]
    )
    saveDatabase()
    return queryOne<Tag>('SELECT * FROM tags WHERE id = ?', [id])
  })

  ipcMain.handle('tags:update', async (_event, id: string, data: TagUpdatePayload): Promise<Tag | null> => {
    const sets: string[] = []
    const params: unknown[] = []

    if (data.name !== undefined) {
      sets.push('name = ?')
      params.push(String(data.name).trim())
      sets.push('normalized_name = ?')
      params.push(normalizeTagName(String(data.name)))
    }
    if (data.color !== undefined) {
      sets.push('color = ?')
      params.push(data.color)
    }
    if (data.parent_id !== undefined) {
      sets.push('parent_id = ?')
      params.push(data.parent_id)
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

    params.push(id)
    run(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    return queryOne<Tag>('SELECT * FROM tags WHERE id = ?', [id])
  })

  ipcMain.handle('tags:delete', async (_event, id: string): Promise<boolean> => {
    transaction(() => {
      run('DELETE FROM document_tags WHERE tag_id = ?', [id])
      run('DELETE FROM tags WHERE id = ?', [id])
    })
    refreshTagUsage()
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
    return { count: uniqueDocIds.length * uniqueTagIds.length }
  })

  ipcMain.handle('tags:removeDocument', async (_event, docId: string, tagId: string): Promise<boolean> => {
    run('DELETE FROM document_tags WHERE doc_id = ? AND tag_id = ?', [docId, tagId])
    refreshTagUsage()
    return true
  })

  ipcMain.handle('tags:clearMetadataBindings', async (): Promise<MetadataTagBindingCleanupResult> => {
    return clearMetadataTagBindings()
  })
}

import { ipcMain } from 'electron'
import { writeProtectedSetting, revokeProtectedSetting } from '../settings-security'
import {
  cancelAllPendingEmbeddings,
  cancelDocumentsForEmbedding,
  enqueueDocumentsForEmbedding,
  getEmbeddingApiKey,
  getEmbeddingBaseUrl,
  getEmbeddingIndexStats,
  getEmbeddingProgressSnapshot,
  reindexAllReadyEmbeddings,
  reindexDocumentsForEmbedding,
  reindexStaleEmbeddings,
  requeueFailedEmbeddings,
  setEmbeddingQueuePaused,
  setEmbeddingSettings,
  vectorSearch,
} from '../embedding-index'

export function registerEmbeddingIpc(): void {
  ipcMain.handle('embedding:getStats', async () => getEmbeddingIndexStats())
  ipcMain.handle('embedding:getProgressSnapshot', async () => getEmbeddingProgressSnapshot())

  ipcMain.handle(
    'embedding:updateSettings',
    async (
      _event,
      input: {
        autoOnIngest?: boolean
        baseUrl?: string
        model?: string
        batchSize?: number
        dimensions?: number | null
        resetBatchSizeToProviderDefault?: boolean
        useLlmCredentials?: boolean
        sourceProfileId?: string | null
      },
    ) => setEmbeddingSettings(input || {}),
  )

  ipcMain.handle('embedding:requeueFailed', async () => {
    const result = requeueFailedEmbeddings()
    return { ...result, stats: getEmbeddingIndexStats() }
  })

  ipcMain.handle('embedding:reindexDocuments', async (_event, docIds: string[]) => {
    const result = reindexDocumentsForEmbedding(Array.isArray(docIds) ? docIds.map(String) : [])
    return { ...result, stats: getEmbeddingIndexStats() }
  })

  ipcMain.handle('embedding:reindexAllReady', async () => {
    const result = reindexAllReadyEmbeddings()
    return { ...result, stats: getEmbeddingIndexStats() }
  })

  ipcMain.handle('embedding:reindexStale', async () => {
    const result = reindexStaleEmbeddings()
    return { ...result, stats: getEmbeddingIndexStats() }
  })

  ipcMain.handle('embedding:setApiKey', async (_event, apiKey: string) => {
    const value = String(apiKey || '').trim()
    if (!value) {
      revokeProtectedSetting('embedding_api_key')
    } else {
      writeProtectedSetting('embedding_api_key', value)
    }
    return getEmbeddingIndexStats()
  })

  ipcMain.handle('embedding:enqueueDocuments', async (_event, docIds: string[], options?: { force?: boolean }) => {
    const result = enqueueDocumentsForEmbedding(
      Array.isArray(docIds) ? docIds.map(String) : [],
      options?.force ? { force: true } : undefined,
    )
    return { ...result, stats: getEmbeddingIndexStats() }
  })

  ipcMain.handle('embedding:setQueuePaused', async (_event, paused: boolean) =>
    setEmbeddingQueuePaused(Boolean(paused)),
  )

  ipcMain.handle('embedding:cancelDocuments', async (_event, docIds: string[]) => {
    const result = cancelDocumentsForEmbedding(Array.isArray(docIds) ? docIds.map(String) : [])
    return { ...result, stats: getEmbeddingIndexStats() }
  })

  ipcMain.handle('embedding:cancelAllPending', async () => {
    const result = cancelAllPendingEmbeddings()
    return { ...result, stats: getEmbeddingIndexStats() }
  })

  ipcMain.handle(
    'embedding:search',
    async (
      _event,
      query: string,
      options?: { limit?: number; folderId?: string; tagId?: string; docId?: string },
    ) => vectorSearch(String(query || ''), options),
  )

  /** List models using the currently linked AI provider baseUrl + Key. */
  ipcMain.handle('embedding:listModels', async (): Promise<string[]> => {
    const baseUrl = getEmbeddingBaseUrl()
    const apiKey = getEmbeddingApiKey()
    if (!baseUrl) throw new Error('请先在左侧选择 AI 配置中心已保存的服务商')
    if (!apiKey) throw new Error('所选服务商尚未保存 API Key，请先到「AI 配置中心」填写并保存')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      })
      const text = await response.text()
      let data: { data?: unknown[]; models?: unknown[]; error?: { message?: string } } = {}
      try {
        data = text ? JSON.parse(text) as typeof data : {}
      } catch {
        data = { error: { message: text || response.statusText } }
      }
      if (!response.ok || data.error) {
        throw new Error(data.error?.message || response.statusText || '模型列表请求失败')
      }
      const items = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []
      const modelIds = items
        .map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && 'id' in item ? String((item as { id?: string }).id || '') : ''))
        .map((id) => id.trim())
        .filter(Boolean)
      const unique = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b))
      const embeddingLike = unique.filter((id) => /embed/i.test(id))
      return embeddingLike.length > 0 ? embeddingLike : unique
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('模型列表请求超时，请检查网络与服务商')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  })
}

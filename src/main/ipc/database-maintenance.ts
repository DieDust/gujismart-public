import { ipcMain } from 'electron'
import type { DatabaseLockDiagnostics, DatabaseMaintenanceResult, DatabaseStorageDiagnostics } from '../../shared/types'
import {
  clearLegacySearchNgramIndex,
  cleanupExternalPagePayloadStorage,
  compactDatabase,
  externalizePagePayloadStorage,
  exportDatabaseStorageDiagnostics,
  getDatabaseStorageDiagnostics,
  getDatabaseStorageDiagnosticsAsync,
  optimizeLegacyDatabaseStorage,
} from '../database-maintenance'
import { queueAllDocumentsReindex } from '../semantic-search'
import { getDatabaseLockDiagnostics } from '../database-lock-diagnostics'

function hasLegacySearchIndexMaintenance(diagnostics: DatabaseStorageDiagnostics): boolean {
  const reasons = diagnostics.requiredMaintenance?.reasons || []
  return !!diagnostics.searchIndex.enterpriseSearchMigrationRecommended
    || diagnostics.searchIndex.ngramRows > 0
    || diagnostics.searchIndex.singleCharNgramRows > 0
    || diagnostics.searchIndex.ngramPositionsBytes > 0
    || reasons.some((reason) => (
    reason === 'legacy-ngram-index'
    || reason === 'legacy-single-char-ngram'
    || reason === 'legacy-ngram-positions'
    || reason === 'enterprise-search-index'
    || reason === 'inline-page-payloads'
  ))
}

export function registerDatabaseMaintenanceIpc(): void {
  ipcMain.handle('database:getStorageDiagnostics', async (): Promise<DatabaseStorageDiagnostics> => {
    return await getDatabaseStorageDiagnosticsAsync()
  })

  ipcMain.handle('database:getLockDiagnostics', async (): Promise<DatabaseLockDiagnostics> => {
    return await getDatabaseLockDiagnostics()
  })

  ipcMain.handle('database:exportStorageDiagnostics', async (): Promise<DatabaseMaintenanceResult> => {
    return exportDatabaseStorageDiagnostics()
  })

  ipcMain.handle('database:compact', async (): Promise<DatabaseMaintenanceResult> => {
    return compactDatabase()
  })

  ipcMain.handle('database:clearLegacySearchIndex', async (): Promise<DatabaseMaintenanceResult> => {
    return await clearLegacySearchNgramIndex()
  })

  ipcMain.handle('database:optimizeLegacyDatabase', async (): Promise<DatabaseMaintenanceResult> => {
    return await optimizeLegacyDatabaseStorage()
  })

  ipcMain.handle('database:externalizePagePayloads', async (): Promise<DatabaseMaintenanceResult> => {
    return await externalizePagePayloadStorage()
  })

  ipcMain.handle('database:cleanupExternalPayloads', async (): Promise<DatabaseMaintenanceResult> => {
    return await cleanupExternalPagePayloadStorage()
  })

  ipcMain.handle('search:rebuildLightweightIndex', async (): Promise<DatabaseMaintenanceResult> => {
    const diagnostics = getDatabaseStorageDiagnostics()
    if (!hasLegacySearchIndexMaintenance(diagnostics)) {
      return {
        success: true,
        message: '搜索索引已经是新版结构，无需再次瘦身或升级。',
        beforeBytes: diagnostics.databaseBytes,
        afterBytes: diagnostics.databaseBytes,
        deletedRows: 0,
        updatedRows: 0,
      }
    }

    const cleaned = await optimizeLegacyDatabaseStorage()
    if (!cleaned.success) return cleaned
    const queued = queueAllDocumentsReindex()
    return {
      ...cleaned,
      success: cleaned.success && Number(queued.queued || 0) >= 0,
      message: `${cleaned.message} 已提交后台重建任务：${queued.queued || 0} 篇文献。`,
      updatedRows: queued.queued || 0,
    }
  })
}

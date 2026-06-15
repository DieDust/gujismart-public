import { ipcMain } from 'electron'
import type { DatabaseMaintenanceResult, DatabaseStorageDiagnostics } from '../../shared/types'
import {
  clearLegacySearchNgramIndex,
  compactDatabase,
  exportDatabaseStorageDiagnostics,
  getDatabaseStorageDiagnostics,
  optimizeLegacyDatabaseStorage,
} from '../database-maintenance'
import { queueAllDocumentsReindex } from '../semantic-search'

function hasLegacySearchIndexMaintenance(diagnostics: DatabaseStorageDiagnostics): boolean {
  return Boolean(diagnostics.requiredMaintenance?.required)
}

export function registerDatabaseMaintenanceIpc(): void {
  ipcMain.handle('database:getStorageDiagnostics', async (): Promise<DatabaseStorageDiagnostics> => {
    return getDatabaseStorageDiagnostics()
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

  ipcMain.handle('search:rebuildLightweightIndex', async (): Promise<DatabaseMaintenanceResult> => {
    const diagnostics = getDatabaseStorageDiagnostics()
    if (!hasLegacySearchIndexMaintenance(diagnostics)) {
      return {
        success: true,
        message: '旧搜索索引已经清理完成，无需再次瘦身或重建索引。',
        beforeBytes: diagnostics.databaseBytes,
        afterBytes: diagnostics.databaseBytes,
        deletedRows: 0,
        updatedRows: 0,
      }
    }

    const cleaned = await clearLegacySearchNgramIndex()
    const queued = queueAllDocumentsReindex()
    return {
      ...cleaned,
      success: cleaned.success && Number(queued.queued || 0) >= 0,
      message: `${cleaned.message} 已提交后台重建任务：${queued.queued || 0} 篇文献。`,
      updatedRows: queued.queued || 0,
    }
  })
}

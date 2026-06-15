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

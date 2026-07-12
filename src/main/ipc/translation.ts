import { ipcMain } from 'electron'
import {
  cancelTranslationTask,
  clearMachineTranslationUnits,
  getPageTranslationUnits,
  translatePageUnits,
  updateTranslationUnit,
} from '../translation-service'
import { getTranslationContextSnapshot, listTranslationRevisions } from '../translation-revisions'
import type {
  CursorPage,
  PageTranslationRequest,
  PageTranslationResult,
  TranslationUnitUpdatePayload,
  TranslationContextSnapshot,
  TranslationUnitRevision,
  TranslationUnitV1,
} from '../../shared/types'

export function registerTranslationIpc(): void {
  ipcMain.handle('translation:getPageUnits', (_event, pageId: string): TranslationUnitV1[] => (
    getPageTranslationUnits(String(pageId || '').trim())
  ))

  ipcMain.handle('translation:getPagesUnits', (_event, pageIds: string[]): Record<string, TranslationUnitV1[]> => {
    const result: Record<string, TranslationUnitV1[]> = {}
    for (const pageId of [...new Set((pageIds || []).map((value) => String(value || '').trim()).filter(Boolean))]) {
      result[pageId] = getPageTranslationUnits(pageId)
    }
    return result
  })

  ipcMain.handle('translation:translatePage', async (_event, request: PageTranslationRequest): Promise<PageTranslationResult> => (
    translatePageUnits(request)
  ))

  ipcMain.handle('translation:updateUnit', (_event, unitId: string, payload: TranslationUnitUpdatePayload): TranslationUnitV1 | null => (
    updateTranslationUnit(String(unitId || '').trim(), payload)
  ))

  ipcMain.handle('translation:clearMachine', (_event, docId: string, pageId?: string): number => (
    clearMachineTranslationUnits(String(docId || '').trim(), String(pageId || '').trim() || undefined)
  ))

  ipcMain.handle('translation:cancelTask', (_event, taskId: string): boolean => (
    cancelTranslationTask(taskId)
  ))

  ipcMain.handle('translation:listRevisions', (
    _event,
    unitId: string,
    options?: { limit?: number; cursor?: string | null },
  ): CursorPage<TranslationUnitRevision> => listTranslationRevisions(unitId, options))

  ipcMain.handle('translation:getContextSnapshot', (_event, contextId: string): TranslationContextSnapshot | null => (
    getTranslationContextSnapshot(contextId)
  ))
}

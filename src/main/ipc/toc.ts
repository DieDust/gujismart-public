import { ipcMain } from 'electron'
import { getDocumentToc, rebuildRuleToc, runAiToc, saveDocumentToc } from '../toc-service'
import type { TocItemSource, TocItemV2 } from '../../shared/types'

function normalizeSaveSource(value: unknown): TocItemSource {
  return value === 'manual' || value === 'ai' || value === 'rule' || value === 'imported' || value === 'legacy'
    ? value
    : 'rule'
}

export function registerTocIpc(): void {
  ipcMain.handle('toc:getDocument', async (_event, docId: string): Promise<TocItemV2[]> => {
    return getDocumentToc(docId)
  })

  ipcMain.handle('toc:saveDocument', async (
    _event,
    docId: string,
    items: TocItemV2[],
    source?: TocItemSource,
  ): Promise<TocItemV2[]> => {
    return saveDocumentToc(docId, Array.isArray(items) ? items : [], normalizeSaveSource(source))
  })

  ipcMain.handle('toc:rebuildRule', async (_event, docId: string): Promise<TocItemV2[]> => {
    return rebuildRuleToc(docId)
  })

  ipcMain.handle('toc:runAi', async (_event, docId: string): Promise<TocItemV2[]> => {
    return runAiToc(docId)
  })
}

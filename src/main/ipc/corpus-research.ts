import { ipcMain } from 'electron'
import type { CorpusEntityQuery, CorpusEntityReview, CorpusResearchCreatePayload, CorpusResearchPageOptions } from '../../shared/types'
import { listCorpusEntities, reviewCorpusEntities } from '../corpus-entities'
import { captureActiveLibraryProjectId, withLibraryProjectContext } from '../library-projects'
import {
  createCorpusResearch, getCorpusResearch, listCorpusResearch, listCorpusResearchDocuments,
  listCorpusResearchFindings, pauseCorpusResearch, startCorpusResearch,
} from '../corpus-research'

export function registerCorpusResearchIpc(): void {
  ipcMain.handle('corpusResearch:entities', (_event, id: string, options?: CorpusEntityQuery) => listCorpusEntities(id, options))
  ipcMain.handle('corpusResearch:reviewEntities', (_event, id: string, payload: CorpusEntityReview) => reviewCorpusEntities(id, payload))
  ipcMain.handle('corpusResearch:create', (_event, payload: CorpusResearchCreatePayload) =>
    withLibraryProjectContext(captureActiveLibraryProjectId(), () => createCorpusResearch(payload)))
  ipcMain.handle('corpusResearch:get', (_event, id: string) => getCorpusResearch(id))
  ipcMain.handle('corpusResearch:list', (_event, projectId?: string) => listCorpusResearch(projectId))
  ipcMain.handle('corpusResearch:start', (_event, id: string, options?: { retryFailed?: boolean; additionalRequests?: number }) =>
    startCorpusResearch(id, options))
  ipcMain.handle('corpusResearch:pause', (_event, id: string) => pauseCorpusResearch(id))
  ipcMain.handle('corpusResearch:documents', (_event, id: string, options?: CorpusResearchPageOptions) => listCorpusResearchDocuments(id, options))
  ipcMain.handle('corpusResearch:findings', (_event, id: string, options?: CorpusResearchPageOptions) => listCorpusResearchFindings(id, options))
}

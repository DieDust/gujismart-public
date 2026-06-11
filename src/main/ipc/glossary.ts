import { ipcMain } from 'electron'
import {
  deleteTranslationGlossaryTerm,
  getActiveTranslationGlossary,
  getTranslationGlossaryVersionSignature,
  listTranslationGlossaryTerms,
  upsertTranslationGlossaryTerm,
} from '../glossary-service'
import type {
  ActiveTranslationGlossaryPayload,
  ActiveTranslationGlossaryResult,
  TranslationGlossaryListOptions,
  TranslationGlossaryTerm,
  TranslationGlossaryTermPayload,
} from '../../shared/types'

export function registerGlossaryIpc(): void {
  ipcMain.handle('glossary:listTerms', async (_event, payload: TranslationGlossaryListOptions = {}): Promise<TranslationGlossaryTerm[]> => {
    return listTranslationGlossaryTerms(payload)
  })

  ipcMain.handle('glossary:upsertTerm', async (_event, payload: TranslationGlossaryTermPayload = {}): Promise<TranslationGlossaryTerm> => {
    return upsertTranslationGlossaryTerm(payload)
  })

  ipcMain.handle('glossary:deleteTerm', async (_event, id: string): Promise<boolean> => {
    return deleteTranslationGlossaryTerm(String(id || '').trim())
  })

  ipcMain.handle('glossary:getActiveTerms', async (_event, payload: ActiveTranslationGlossaryPayload = {}): Promise<ActiveTranslationGlossaryResult> => {
    return getActiveTranslationGlossary(payload)
  })

  ipcMain.handle('glossary:getVersionSignature', async (_event, projectId?: string | null): Promise<string> => {
    return getTranslationGlossaryVersionSignature(projectId)
  })
}

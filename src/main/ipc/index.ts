import { registerDocumentIpc } from './documents'
import { registerFolderIpc } from './folders'
import { registerTagIpc } from './tags'
import { registerOcrIpc } from './ocr'
import { registerAiIpc } from './ai'
import { registerAiResearchIpc } from './ai-research'
import { registerBatchIpc } from './batch'
import { registerSearchIpc } from './search'
import { registerCitationIpc } from './citation'
import { registerSettingsIpc, registerAppIpc, registerExportIpc, registerTypesetIpc, registerFsIpc, registerBackupIpc } from './settings'
import { registerOnboardingIpc } from './onboarding'
import { registerResearchIpc } from './research'
import { registerTocIpc } from './toc'
import { registerGlossaryIpc } from './glossary'
import { registerLibraryIpc } from './library'
import { registerDatabaseMaintenanceIpc } from './database-maintenance'
import { registerTranslationIpc } from './translation'
import { registerEmbeddingIpc } from './embedding'
import { registerLibraryProjectIpc } from './library-projects'

export function registerAllIpcHandlers(): void {
  registerDocumentIpc()
  registerFolderIpc()
  registerTagIpc()
  registerOcrIpc()
  registerAiIpc()
  registerAiResearchIpc()
  registerBatchIpc()
  registerSearchIpc()
  registerCitationIpc()
  registerSettingsIpc()
  registerAppIpc()
  registerExportIpc()
  registerTypesetIpc()
  registerFsIpc()
  registerOnboardingIpc()
  registerBackupIpc()
  registerResearchIpc()
  registerTocIpc()
  registerGlossaryIpc()
  registerLibraryIpc()
  registerDatabaseMaintenanceIpc()
  registerTranslationIpc()
  registerEmbeddingIpc()
  registerLibraryProjectIpc()

  console.log('[IPC] All handlers registered')
}


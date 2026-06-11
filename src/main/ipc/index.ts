import { registerDocumentIpc } from './documents'
import { registerFolderIpc } from './folders'
import { registerTagIpc } from './tags'
import { registerOcrIpc } from './ocr'
import { registerAiIpc } from './ai'
import { registerBatchIpc } from './batch'
import { registerSearchIpc } from './search'
import { registerCitationIpc } from './citation'
import { registerSettingsIpc, registerAppIpc, registerExportIpc, registerTypesetIpc, registerFsIpc, registerBackupIpc } from './settings'
import { registerOnboardingIpc } from './onboarding'
import { registerResearchIpc } from './research'
import { registerTocIpc } from './toc'
import { registerGlossaryIpc } from './glossary'

export function registerAllIpcHandlers(): void {
  registerDocumentIpc()
  registerFolderIpc()
  registerTagIpc()
  registerOcrIpc()
  registerAiIpc()
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

  console.log('[IPC] All handlers registered')
}


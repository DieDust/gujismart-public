import { ipcMain, type WebContents } from 'electron'
import {
  addDocumentsToLibraryProject,
  copyDocumentsToLibraryProject,
  createLibraryProject,
  getActiveLibraryProject,
  listLibraryProjects,
  moveDocumentsToLibraryProject,
  removeDocumentsFromLibraryProject,
  setActiveLibraryProject,
} from '../library-projects'
import type {
  AddDocumentsToLibraryProjectResult,
  CopyDocumentsToLibraryProjectResult,
  CreateLibraryProjectPayload,
  LibraryProject,
  MoveDocumentsToLibraryProjectResult,
  RemoveDocumentsFromLibraryProjectResult,
} from '../../shared/types'
import { DEFAULT_LIBRARY_PROJECT_ID } from '../../shared/types'
import { markLibraryStateCacheDirty } from '../library-state-cache'
import { resumeEmbeddingQueueForActiveProject } from '../embedding-index'
import { notifySearchContentChanged } from '../semantic-search'
import { batchProcessor } from '../batch-processor'
import { scheduleStartupRecovery } from '../startup-recovery'
import { resumePendingImportAutoOcrTasks } from './ocr'

const PROJECT_SWITCH_BACKGROUND_RESUME_DELAY_MS = 30_000
let projectBackgroundResumeTimer: ReturnType<typeof setTimeout> | null = null

function scheduleProjectBackgroundResume(sender: WebContents): void {
  if (projectBackgroundResumeTimer) clearTimeout(projectBackgroundResumeTimer)
  projectBackgroundResumeTimer = setTimeout(() => {
    projectBackgroundResumeTimer = null
    if (sender.isDestroyed()) return
    try {
      resumeEmbeddingQueueForActiveProject()
    } catch (error) {
      console.warn('[LibraryProjects] Failed to resume project embedding queue:', error)
    }
    try {
      resumePendingImportAutoOcrTasks(sender)
    } catch (error) {
      console.warn('[LibraryProjects] Failed to resume project OCR queue:', error)
    }
    try {
      const summary = batchProcessor.resumePendingQueueFromDatabase()
      if (summary.resumedItems > 0) {
        console.log(
          `[LibraryProjects] Resumed batch OCR for selected project: ${summary.resumedItems} item(s) in ${summary.resumedJobs} job(s)`,
        )
      }
    } catch (error) {
      console.warn('[LibraryProjects] Failed to resume project batch OCR queue:', error)
    }
  }, PROJECT_SWITCH_BACKGROUND_RESUME_DELAY_MS)
  projectBackgroundResumeTimer.unref?.()
}

export function registerLibraryProjectIpc(): void {
  ipcMain.handle('libraryProjects:list', async (): Promise<LibraryProject[]> => {
    return listLibraryProjects()
  })
  ipcMain.handle('libraryProjects:getActive', async (): Promise<LibraryProject> => {
    return getActiveLibraryProject()
  })
  ipcMain.handle(
    'libraryProjects:create',
    async (_event, payload: CreateLibraryProjectPayload): Promise<LibraryProject> => {
      return createLibraryProject(payload)
    },
  )
  ipcMain.handle(
    'libraryProjects:setActive',
    async (event, projectId: string): Promise<LibraryProject> => {
      const project = setActiveLibraryProject(projectId)
      scheduleStartupRecovery()
      scheduleProjectBackgroundResume(event.sender)
      return project
    },
  )
  ipcMain.handle(
    'libraryProjects:addDocuments',
    async (_event, documentIds: string[], targetProjectId: string): Promise<AddDocumentsToLibraryProjectResult> => {
      const result = addDocumentsToLibraryProject(documentIds, targetProjectId)
      markLibraryStateCacheDirty([result.source_project_id, result.target_project_id])
      return result
    },
  )
  ipcMain.handle(
    'libraryProjects:removeDocuments',
    async (_event, documentIds: string[]): Promise<RemoveDocumentsFromLibraryProjectResult> => {
      const result = removeDocumentsFromLibraryProject(documentIds)
      const affectedProjects = [result.source_project_id]
      if (result.reassigned_to_default > 0) affectedProjects.push(DEFAULT_LIBRARY_PROJECT_ID)
      markLibraryStateCacheDirty(affectedProjects)
      if (result.removed > 0) notifySearchContentChanged()
      return result
    },
  )
  ipcMain.handle(
    'libraryProjects:moveDocuments',
    async (_event, documentIds: string[], targetProjectId: string): Promise<MoveDocumentsToLibraryProjectResult> => {
      const result = moveDocumentsToLibraryProject(documentIds, targetProjectId)
      markLibraryStateCacheDirty([...result.from_project_ids, result.target_project_id])
      return result
    },
  )
  ipcMain.handle(
    'libraryProjects:copyDocuments',
    async (_event, documentIds: string[], targetProjectId: string): Promise<CopyDocumentsToLibraryProjectResult> => {
      const result = await copyDocumentsToLibraryProject(documentIds, targetProjectId)
      markLibraryStateCacheDirty([result.source_project_id, result.target_project_id])
      notifySearchContentChanged()
      return result
    },
  )
}

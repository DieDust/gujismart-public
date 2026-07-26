import { ipcMain } from 'electron'
import {
  createLibraryProject,
  getActiveLibraryProject,
  listLibraryProjects,
  moveDocumentsToLibraryProject,
  setActiveLibraryProject,
} from '../library-projects'
import type {
  CreateLibraryProjectPayload,
  LibraryProject,
  MoveDocumentsToLibraryProjectResult,
} from '../../shared/types'
import { markLibraryStateCacheDirty } from '../library-state-cache'
import { resumeEmbeddingQueueForActiveProject } from '../embedding-index'
import { resumePendingImportAutoOcrTasks } from './ocr'

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
      markLibraryStateCacheDirty([project.id])
      try {
        resumeEmbeddingQueueForActiveProject()
      } catch (error) {
        console.warn('[LibraryProjects] Failed to resume project embedding queue:', error)
      }
      try {
        resumePendingImportAutoOcrTasks(event.sender)
      } catch (error) {
        console.warn('[LibraryProjects] Failed to resume project OCR queue:', error)
      }
      return project
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
}

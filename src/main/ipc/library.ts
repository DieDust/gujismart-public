import { ipcMain } from 'electron'
import type { LibraryFolderCounts, LibrarySmartViewCounts, LibraryStateCache } from '../../shared/types'
import {
  getLibraryStateCache,
  markLibraryStateCacheDirty,
  refreshLibraryFolderCounts,
  refreshLibrarySmartViewCounts,
  refreshLibraryStateCache,
} from '../library-state-cache'

export function registerLibraryIpc(): void {
  ipcMain.handle('library:getStateCache', async (): Promise<LibraryStateCache> => {
    return getLibraryStateCache()
  })

  ipcMain.handle('library:refreshStateCache', async (): Promise<LibraryStateCache> => {
    return refreshLibraryStateCache()
  })

  ipcMain.handle('library:refreshSmartViewCounts', async (): Promise<LibrarySmartViewCounts> => {
    return refreshLibrarySmartViewCounts()
  })

  ipcMain.handle('library:refreshFolderCounts', async (): Promise<LibraryFolderCounts> => {
    return refreshLibraryFolderCounts()
  })

  ipcMain.handle('library:markStateCacheDirty', async (): Promise<LibraryStateCache> => {
    return markLibraryStateCacheDirty()
  })
}


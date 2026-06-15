import { ipcMain } from 'electron'
import type { LibraryStateCache } from '../../shared/types'
import { getLibraryStateCache, markLibraryStateCacheDirty, refreshLibraryStateCache } from '../library-state-cache'

export function registerLibraryIpc(): void {
  ipcMain.handle('library:getStateCache', async (): Promise<LibraryStateCache> => {
    return getLibraryStateCache()
  })

  ipcMain.handle('library:refreshStateCache', async (): Promise<LibraryStateCache> => {
    return refreshLibraryStateCache()
  })

  ipcMain.handle('library:markStateCacheDirty', async (): Promise<LibraryStateCache> => {
    return markLibraryStateCacheDirty()
  })
}


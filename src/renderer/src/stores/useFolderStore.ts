import { create } from 'zustand'
import type { Folder, FolderUpdatePayload } from '@shared/types'

interface FolderState {
  folders: Folder[]
  selectedFolderId: string | null
  loading: boolean

  setFolders: (folders: Folder[]) => void
  setSelectedFolderId: (id: string | null) => void
  setLoading: (loading: boolean) => void
  addFolder: (folder: Folder) => void
  updateFolder: (id: string, data: FolderUpdatePayload) => void
  removeFolder: (id: string) => void
}

export const useFolderStore = create<FolderState>((set) => ({
  folders: [],
  selectedFolderId: null,
  loading: false,

  setFolders: (folders) => set({ folders }),
  setSelectedFolderId: (selectedFolderId) => set({ selectedFolderId }),
  setLoading: (loading) => set({ loading }),
  addFolder: (folder) => set((state) => ({
    folders: [...state.folders, folder]
  })),
  updateFolder: (id, data) => set((state) => ({
    folders: state.folders.map(f => f.id === id ? { ...f, ...data } : f)
  })),
  removeFolder: (id) => set((state) => ({
    folders: state.folders.filter(f => f.id !== id),
    selectedFolderId: state.selectedFolderId === id ? null : state.selectedFolderId
  }))
}))

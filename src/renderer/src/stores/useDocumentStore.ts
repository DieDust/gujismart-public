import { create } from 'zustand'
import type { DocumentListItem, LibraryFilter } from '@shared/types'

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => item === right[index])
}

function hasDocumentPatchChange(document: DocumentListItem, patch: Partial<DocumentListItem>): boolean {
  return Object.entries(patch).some(([key, value]) => document[key as keyof DocumentListItem] !== value)
}

interface DocumentState {
  documents: DocumentListItem[]
  selectedIds: string[]
  loading: boolean
  filter: LibraryFilter
  searchKey: string

  setDocuments: (docs: DocumentListItem[]) => void
  setSelectedIds: (ids: string[]) => void
  toggleSelect: (id: string) => void
  selectAll: () => void
  clearSelection: () => void
  setLoading: (loading: boolean) => void
  setFilter: (filter: LibraryFilter) => void
  setSearchKey: (key: string) => void
  updateDocumentInList: (id: string, data: Partial<DocumentListItem>) => void
  updateDocumentsInList: (patches: Array<{ id: string; data: Partial<DocumentListItem> }>) => void
  removeDocumentFromList: (id: string) => void
  removeDocumentsFromList: (ids: string[]) => void
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  documents: [],
  selectedIds: [],
  loading: false,
  filter: { type: 'all' },
  searchKey: '',

  setDocuments: (documents) => set({ documents }),
  setSelectedIds: (selectedIds) => set((state) => (
    sameStringArray(state.selectedIds, selectedIds) ? state : { selectedIds }
  )),
  toggleSelect: (id) => set((state) => {
    if (state.selectedIds.includes(id)) {
      return { selectedIds: state.selectedIds.filter(i => i !== id) }
    }
    return { selectedIds: [...state.selectedIds, id] }
  }),
  selectAll: () => set((state) => ({
    selectedIds: state.documents.map(d => d.id)
  })),
  clearSelection: () => set({ selectedIds: [] }),
  setLoading: (loading) => set({ loading }),
  setFilter: (filter) => set({ filter }),
  setSearchKey: (searchKey) => set({ searchKey }),
  updateDocumentInList: (id, data) => set((state) => {
    let changed = false
    const documents = state.documents.map((document) => {
      if (document.id !== id || !hasDocumentPatchChange(document, data)) return document
      changed = true
      return { ...document, ...data }
    })
    return changed ? { documents } : state
  }),
  updateDocumentsInList: (patches) => set((state) => {
    if (patches.length === 0) return state
    const patchesById = new Map(patches.map((patch) => [patch.id, patch.data]))
    let changed = false
    const documents = state.documents.map((document) => {
      const patch = patchesById.get(document.id)
      if (!patch) return document
      if (!hasDocumentPatchChange(document, patch)) return document
      changed = true
      return { ...document, ...patch }
    })
    return changed ? { documents } : state
  }),
  removeDocumentFromList: (id) => get().removeDocumentsFromList([id]),
  removeDocumentsFromList: (ids) => set((state) => {
    if (ids.length === 0) return state
    const removedIds = new Set(ids)
    const documents = state.documents.filter((document) => !removedIds.has(document.id))
    const selectedIds = state.selectedIds.filter((id) => !removedIds.has(id))
    if (documents.length === state.documents.length && selectedIds.length === state.selectedIds.length) return state
    return { documents, selectedIds }
  })
}))

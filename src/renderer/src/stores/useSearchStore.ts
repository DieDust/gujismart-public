import { create } from 'zustand'
import type { SearchGroupedResponse, SearchOptions, SearchResult } from '@shared/types'

export type SearchFilters = Pick<
  SearchOptions,
  | 'docType'
  | 'author'
  | 'dynasty'
  | 'folderId'
  | 'folderIds'
  | 'tagId'
  | 'tagIds'
  | 'docIds'
  | 'readStatus'
  | 'metadataStatus'
  | 'favoritesOnly'
  | 'yearFrom'
  | 'yearTo'
>

interface SearchState {
  keyword: string
  results: SearchResult[]
  groupedResponse: SearchGroupedResponse | null
  executedSearchSignature: string
  loading: boolean
  filters: SearchFilters
  history: string[]

  setKeyword: (keyword: string) => void
  setResults: (results: SearchResult[]) => void
  setGroupedResponse: (groupedResponse: SearchGroupedResponse | null) => void
  setExecutedSearchSignature: (signature: string) => void
  setLoading: (loading: boolean) => void
  setFilters: (filters: Partial<SearchFilters>) => void
  replaceFilters: (filters: SearchFilters) => void
  addHistory: (keyword: string) => void
  clearHistory: () => void
}

export const useSearchStore = create<SearchState>((set) => ({
  keyword: '',
  results: [],
  groupedResponse: null,
  executedSearchSignature: '',
  loading: false,
  filters: {},
  history: [],

  setKeyword: (keyword) => set({ keyword }),
  setResults: (results) => set({ results }),
  setGroupedResponse: (groupedResponse) => set({ groupedResponse }),
  setExecutedSearchSignature: (executedSearchSignature) => set({ executedSearchSignature }),
  setLoading: (loading) => set({ loading }),
  setFilters: (filters) => set((state) => ({
    filters: { ...state.filters, ...filters }
  })),
  replaceFilters: (filters) => set({ filters }),
  addHistory: (keyword) => set((state) => {
    if (!keyword.trim() || state.history.includes(keyword)) return state
    return { history: [keyword, ...state.history].slice(0, 20) }
  }),
  clearHistory: () => set({ history: [] })
}))

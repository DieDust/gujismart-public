import { create } from 'zustand'
import type { BatchQueueItem } from '@shared/types'

type BatchItem = Pick<
  BatchQueueItem,
  'id' | 'batch_id' | 'doc_id' | 'status' | 'batch_size' | 'progress' | 'error_message' | 'created_at'
>

interface BatchState {
  batches: BatchItem[]
  currentBatchId: string | null
  processing: boolean
  batchSize: number
  progress: {
    current: number
    total: number
    currentBatch: number
    totalBatches: number
    estimatedTime: number
  }

  setBatches: (batches: BatchItem[]) => void
  setCurrentBatchId: (id: string | null) => void
  setProcessing: (processing: boolean) => void
  setBatchSize: (size: number) => void
  setProgress: (progress: Partial<BatchState['progress']>) => void
  updateBatchItem: (id: string, data: Partial<BatchItem>) => void
  clearCompleted: () => void
}

export const useBatchStore = create<BatchState>((set) => ({
  batches: [],
  currentBatchId: null,
  processing: false,
  batchSize: 5,
  progress: {
    current: 0,
    total: 0,
    currentBatch: 0,
    totalBatches: 0,
    estimatedTime: 0
  },

  setBatches: (batches) => set({ batches }),
  setCurrentBatchId: (currentBatchId) => set({ currentBatchId }),
  setProcessing: (processing) => set({ processing }),
  setBatchSize: (batchSize) => set({ batchSize }),
  setProgress: (progressUpdate) => set((state) => ({
    progress: { ...state.progress, ...progressUpdate }
  })),
  updateBatchItem: (id, data) => set((state) => ({
    batches: state.batches.map(b => b.id === id ? { ...b, ...data } : b)
  })),
  clearCompleted: () => set((state) => ({
    batches: state.batches.filter(b => b.status !== 'completed' && b.status !== 'failed')
  }))
}))

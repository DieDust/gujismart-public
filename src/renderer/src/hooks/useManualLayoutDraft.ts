import { useCallback, useEffect, useReducer, useRef } from 'react'

export type ManualLayoutDraftBlock = Record<string, unknown>
export type ManualLayoutSaveState = 'clean' | 'dirty' | 'saving' | 'failed'

export interface ManualLayoutDraftState {
  pageId: string
  blocks: ManualLayoutDraftBlock[]
  activeBlockId: string | null
  revision: number
  acknowledgedRevision: number
  saveState: ManualLayoutSaveState
}

export type ManualLayoutDraftAction =
  | { type: 'create'; block: ManualLayoutDraftBlock }
  | { type: 'update'; blockId: string; changes: ManualLayoutDraftBlock }
  | { type: 'delete'; blockId: string }
  | { type: 'replace'; blocks: ManualLayoutDraftBlock[]; activeBlockId?: string | null }
  | { type: 'preview-replace'; blocks: ManualLayoutDraftBlock[] }
  | { type: 'set-active'; blockId: string | null }
  | { type: 'save-started'; pageId?: string; revision: number }
  | { type: 'save-failed'; pageId?: string; revision: number }
  | { type: 'server-ack'; pageId?: string; revision: number; blocks: ManualLayoutDraftBlock[] }
  | { type: 'server-echo'; pageId: string; blocks: ManualLayoutDraftBlock[] }
  | { type: 'retry' }
  | { type: 'page-changed'; pageId: string; blocks: ManualLayoutDraftBlock[] }

export type ManualLayoutSaveSchedule =
  | { kind: 'none' }
  | { kind: 'debounce'; revision: number }
  | { kind: 'flush'; revision: number }

type ManualLayoutSave = (
  pageId: string,
  blocks: ManualLayoutDraftBlock[],
  revision: number,
) => void | Promise<void>

interface UseManualLayoutDraftOptions {
  pageId: string
  blocks: ManualLayoutDraftBlock[]
  save: ManualLayoutSave
  debounceMs?: number
}

let manualBlockSequence = 0

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function createLocalDraftId(pageId: string, block: ManualLayoutDraftBlock, index: number): string {
  const irBlockId = stringValue(block.ir_block_id)
  if (irBlockId) return `${pageId}:ir:${irBlockId}`
  const sourceIndex = Number(block.__sourceIndex)
  const stableIndex = Number.isFinite(sourceIndex) && sourceIndex >= 0 ? sourceIndex : index
  return `${pageId}:draft:${stableIndex}`
}

export function createManualLayoutBlockId(pageId: string): string {
  manualBlockSequence += 1
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${manualBlockSequence.toString(36)}`
  const safePageId = pageId.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 36) || 'page'
  return `manual-${safePageId}-${randomId}`
}

export function getManualLayoutDraftBlockId(
  pageId: string,
  block: ManualLayoutDraftBlock,
  index: number,
): string {
  return stringValue(block.manual_block_id)
    || stringValue(block.__manualDraftId)
    || (stringValue(block.ir_block_id) ? `${pageId}:ir:${stringValue(block.ir_block_id)}` : '')
    || createLocalDraftId(pageId, block, index)
}

export function ensureManualLayoutBlockIdentity(
  pageId: string,
  block: ManualLayoutDraftBlock,
  index: number,
  forceManual = false,
): ManualLayoutDraftBlock {
  const manualBlockId = stringValue(block.manual_block_id)
  if (manualBlockId) {
    if (stringValue(block.__manualDraftId)) return block
    return { ...block, manual_block_id: manualBlockId, __manualDraftId: manualBlockId }
  }
  if (forceManual) {
    const nextManualBlockId = createManualLayoutBlockId(pageId)
    return {
      ...block,
      manual_block_id: nextManualBlockId,
      __manualDraftId: stringValue(block.__manualDraftId) || createLocalDraftId(pageId, block, index),
    }
  }
  const localId = stringValue(block.__manualDraftId) || createLocalDraftId(pageId, block, index)
  if (block.__manualDraftId === localId) return block
  return { ...block, __manualDraftId: localId }
}

function blockMatchesId(
  pageId: string,
  block: ManualLayoutDraftBlock,
  index: number,
  blockId: string,
): boolean {
  if (getManualLayoutDraftBlockId(pageId, block, index) === blockId) return true
  if (stringValue(block.__manualDraftId) === blockId) return true
  const irBlockId = stringValue(block.ir_block_id)
  return Boolean(irBlockId) && `${pageId}:ir:${irBlockId}` === blockId
}

function prepareBlocks(pageId: string, blocks: readonly ManualLayoutDraftBlock[]): ManualLayoutDraftBlock[] {
  const prepared = blocks.map((block, index) => ensureManualLayoutBlockIdentity(pageId, block, index))
  const identityCounts = new Map<string, number>()
  prepared.forEach((block, index) => {
    const blockId = getManualLayoutDraftBlockId(pageId, block, index)
    identityCounts.set(blockId, (identityCounts.get(blockId) || 0) + 1)
  })
  return prepared.map((block, index) => {
    const blockId = getManualLayoutDraftBlockId(pageId, block, index)
    if ((identityCounts.get(blockId) || 0) < 2 || stringValue(block.manual_block_id)) return block
    const sourceIndex = Number(block.__sourceIndex)
    const stableIndex = Number.isFinite(sourceIndex) && sourceIndex >= 0 ? sourceIndex : index
    return { ...block, __manualDraftId: `${blockId}:${stableIndex}` }
  })
}

function mergeAcknowledgedBlocks(
  pageId: string,
  localBlocks: readonly ManualLayoutDraftBlock[],
  serverBlocks: readonly ManualLayoutDraftBlock[],
): ManualLayoutDraftBlock[] {
  const normalizedServer = prepareBlocks(pageId, serverBlocks)
  const serverById = new Map(normalizedServer.map((block, index) => [
    getManualLayoutDraftBlockId(pageId, block, index),
    block,
  ]))
  return localBlocks.map((localBlock, index) => {
    const blockId = getManualLayoutDraftBlockId(pageId, localBlock, index)
    const serverBlock = serverById.get(blockId)
    return serverBlock ? { ...serverBlock, ...localBlock } : localBlock
  })
}

export function createManualLayoutDraft(
  pageId: string,
  blocks: readonly ManualLayoutDraftBlock[],
): ManualLayoutDraftState {
  return {
    pageId,
    blocks: prepareBlocks(pageId, blocks),
    activeBlockId: null,
    revision: 0,
    acknowledgedRevision: 0,
    saveState: 'clean',
  }
}

function nextEditedState(
  state: ManualLayoutDraftState,
  blocks: ManualLayoutDraftBlock[],
  activeBlockId = state.activeBlockId,
): ManualLayoutDraftState {
  return {
    ...state,
    blocks,
    activeBlockId,
    revision: state.revision + 1,
    saveState: 'dirty',
  }
}

export function reduceManualLayoutDraft(
  state: ManualLayoutDraftState,
  action: ManualLayoutDraftAction,
): ManualLayoutDraftState {
  switch (action.type) {
    case 'create': {
      const block = ensureManualLayoutBlockIdentity(state.pageId, action.block, state.blocks.length, true)
      return nextEditedState(
        state,
        [...state.blocks, block],
        getManualLayoutDraftBlockId(state.pageId, block, state.blocks.length),
      )
    }
    case 'update': {
      let nextActiveBlockId = state.activeBlockId
      let changed = false
      const blocks = state.blocks.map((block, index) => {
        if (!blockMatchesId(state.pageId, block, index, action.blockId)) return block
        const nextBlock = ensureManualLayoutBlockIdentity(
          state.pageId,
          { ...block, ...action.changes, segmentation_source: 'manual' },
          index,
          true,
        )
        const nextBlockId = getManualLayoutDraftBlockId(state.pageId, nextBlock, index)
        if (nextActiveBlockId === action.blockId) nextActiveBlockId = nextBlockId
        changed = true
        return nextBlock
      })
      return changed ? nextEditedState(state, blocks, nextActiveBlockId) : state
    }
    case 'delete': {
      const blocks = state.blocks.filter((block, index) => (
        !blockMatchesId(state.pageId, block, index, action.blockId)
      ))
      if (blocks.length === state.blocks.length) return state
      return nextEditedState(state, blocks, state.activeBlockId === action.blockId ? null : state.activeBlockId)
    }
    case 'replace': {
      const blocks = prepareBlocks(state.pageId, action.blocks)
      const activeBlockId = action.activeBlockId === undefined ? state.activeBlockId : action.activeBlockId
      return nextEditedState(state, blocks, activeBlockId)
    }
    case 'preview-replace':
      return { ...state, blocks: prepareBlocks(state.pageId, action.blocks) }
    case 'set-active':
      return state.activeBlockId === action.blockId ? state : { ...state, activeBlockId: action.blockId }
    case 'save-started':
      if ((action.pageId && action.pageId !== state.pageId) || action.revision !== state.revision) return state
      return { ...state, saveState: 'saving' }
    case 'save-failed':
      if ((action.pageId && action.pageId !== state.pageId) || action.revision > state.revision) return state
      if (state.acknowledgedRevision >= state.revision) return state
      if (action.revision < state.revision) return { ...state, saveState: 'dirty' }
      return { ...state, saveState: 'failed' }
    case 'server-ack': {
      if (action.pageId && action.pageId !== state.pageId) return state
      if (action.revision < state.acknowledgedRevision || action.revision > state.revision) return state
      const acknowledgedRevision = Math.max(state.acknowledgedRevision, action.revision)
      if (action.revision !== state.revision) {
        return {
          ...state,
          acknowledgedRevision,
          saveState: state.saveState === 'failed' ? 'failed' : 'dirty',
        }
      }
      return {
        ...state,
        blocks: mergeAcknowledgedBlocks(state.pageId, state.blocks, action.blocks),
        acknowledgedRevision,
        saveState: 'clean',
      }
    }
    case 'server-echo': {
      if (action.pageId !== state.pageId) return state
      if (state.saveState !== 'clean') {
        return {
          ...state,
          blocks: mergeAcknowledgedBlocks(state.pageId, state.blocks, action.blocks),
        }
      }
      const blocks = prepareBlocks(state.pageId, action.blocks)
      const activeBlockId = state.activeBlockId && blocks.some((block, index) => (
        getManualLayoutDraftBlockId(state.pageId, block, index) === state.activeBlockId
      ))
        ? state.activeBlockId
        : null
      return { ...state, blocks, activeBlockId }
    }
    case 'retry':
      return state.saveState === 'failed' ? { ...state, saveState: 'dirty' } : state
    case 'page-changed':
      return createManualLayoutDraft(action.pageId, action.blocks)
    default:
      return state
  }
}

export function getManualLayoutSaveSchedule(
  state: ManualLayoutDraftState,
  flush: boolean,
): ManualLayoutSaveSchedule {
  if (state.saveState === 'clean' || state.saveState === 'saving') return { kind: 'none' }
  if (flush) return { kind: 'flush', revision: state.revision }
  return state.saveState === 'dirty'
    ? { kind: 'debounce', revision: state.revision }
    : { kind: 'none' }
}

export async function continueManualLayoutSaveAfterSettlement(
  existingSave: Promise<boolean>,
  getLatestState: () => ManualLayoutDraftState,
  saveLatestRevision: () => Promise<boolean>,
): Promise<boolean> {
  const previousSaved = await existingSave
  const latestState = getLatestState()
  if (latestState.saveState === 'dirty') {
    return saveLatestRevision()
  }
  return previousSaved && latestState.saveState === 'clean'
}

export function useManualLayoutDraft({
  pageId,
  blocks,
  save,
  debounceMs = 450,
}: UseManualLayoutDraftOptions) {
  const [state, reducerDispatch] = useReducer(
    reduceManualLayoutDraft,
    undefined,
    () => createManualLayoutDraft(pageId, blocks),
  )
  const stateRef = useRef(state)
  const saveRef = useRef(save)
  const mountedRef = useRef(true)
  const timerRef = useRef<number | null>(null)
  const inFlightRef = useRef<Promise<boolean> | null>(null)
  const saveRunnerRef = useRef<() => Promise<boolean>>(async () => true)

  const dispatch = useCallback((action: ManualLayoutDraftAction) => {
    const current = stateRef.current
    let stableAction = action
    if (action.type === 'create') {
      stableAction = {
        ...action,
        block: ensureManualLayoutBlockIdentity(current.pageId, action.block, current.blocks.length, true),
      }
    } else if (action.type === 'update' && !stringValue(action.changes.manual_block_id)) {
      const targetIndex = current.blocks.findIndex((block, index) => (
        blockMatchesId(current.pageId, block, index, action.blockId)
      ))
      if (targetIndex >= 0 && !stringValue(current.blocks[targetIndex].manual_block_id)) {
        const identifiedBlock = ensureManualLayoutBlockIdentity(
          current.pageId,
          current.blocks[targetIndex],
          targetIndex,
          true,
        )
        stableAction = {
          ...action,
          changes: {
            ...action.changes,
            manual_block_id: identifiedBlock.manual_block_id,
          },
        }
      }
    }
    stateRef.current = reduceManualLayoutDraft(current, stableAction)
    if (mountedRef.current) reducerDispatch(stableAction)
  }, [])

  useEffect(() => {
    saveRef.current = save
  }, [save])

  const clearSaveTimer = useCallback(() => {
    if (timerRef.current == null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const saveCurrentRevision = useCallback(async (): Promise<boolean> => {
    const existingSave = inFlightRef.current
    if (existingSave) {
      return continueManualLayoutSaveAfterSettlement(
        existingSave,
        () => stateRef.current,
        () => saveRunnerRef.current(),
      )
    }
    const snapshot = stateRef.current
    if (getManualLayoutSaveSchedule(snapshot, true).kind === 'none') return snapshot.saveState === 'clean'
    clearSaveTimer()
    dispatch({ type: 'save-started', pageId: snapshot.pageId, revision: snapshot.revision })
    const savePromise = (async () => {
      try {
        await Promise.resolve(saveRef.current(snapshot.pageId, snapshot.blocks, snapshot.revision))
        dispatch({
          type: 'server-ack',
          pageId: snapshot.pageId,
          revision: snapshot.revision,
          blocks: snapshot.blocks,
        })
        return true
      } catch {
        dispatch({ type: 'save-failed', pageId: snapshot.pageId, revision: snapshot.revision })
        return false
      } finally {
        inFlightRef.current = null
      }
    })()
    inFlightRef.current = savePromise
    return savePromise
  }, [clearSaveTimer, dispatch])
  saveRunnerRef.current = saveCurrentRevision

  const flush = useCallback(async (): Promise<boolean> => {
    clearSaveTimer()
    while (stateRef.current.saveState !== 'clean') {
      const activeSave = inFlightRef.current
      if (activeSave) {
        if (!(await activeSave)) return false
      } else if (!(await saveCurrentRevision())) {
        return false
      }
    }
    return true
  }, [clearSaveTimer, saveCurrentRevision])

  useEffect(() => {
    clearSaveTimer()
    const schedule = getManualLayoutSaveSchedule(state, false)
    if (schedule.kind !== 'debounce') return undefined
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      if (stateRef.current.pageId !== state.pageId || stateRef.current.revision !== schedule.revision) return
      void saveCurrentRevision()
    }, Math.max(0, debounceMs))
    return clearSaveTimer
  }, [clearSaveTimer, debounceMs, saveCurrentRevision, state.pageId, state.revision, state.saveState])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearSaveTimer()
    }
  }, [clearSaveTimer])

  const createBlock = useCallback((block: ManualLayoutDraftBlock) => {
    dispatch({ type: 'create', block })
  }, [dispatch])
  const updateBlock = useCallback((blockId: string, changes: ManualLayoutDraftBlock) => {
    dispatch({ type: 'update', blockId, changes })
  }, [dispatch])
  const deleteBlock = useCallback((blockId: string) => {
    dispatch({ type: 'delete', blockId })
  }, [dispatch])
  const replaceBlocks = useCallback((nextBlocks: ManualLayoutDraftBlock[], activeBlockId?: string | null) => {
    dispatch({ type: 'replace', blocks: nextBlocks, activeBlockId })
  }, [dispatch])
  const previewBlocks = useCallback((nextBlocks: ManualLayoutDraftBlock[]) => {
    clearSaveTimer()
    dispatch({ type: 'preview-replace', blocks: nextBlocks })
  }, [clearSaveTimer, dispatch])
  const setActiveBlockId = useCallback((blockId: string | null) => {
    dispatch({ type: 'set-active', blockId })
  }, [dispatch])
  const receiveServerEcho = useCallback((echoPageId: string, nextBlocks: ManualLayoutDraftBlock[]) => {
    dispatch({ type: 'server-echo', pageId: echoPageId, blocks: nextBlocks })
  }, [dispatch])
  const changePage = useCallback((nextPageId: string, nextBlocks: ManualLayoutDraftBlock[]) => {
    clearSaveTimer()
    dispatch({ type: 'page-changed', pageId: nextPageId, blocks: nextBlocks })
  }, [clearSaveTimer, dispatch])
  const retry = useCallback(() => {
    dispatch({ type: 'retry' })
    void saveCurrentRevision()
  }, [dispatch, saveCurrentRevision])

  return {
    state,
    createBlock,
    updateBlock,
    deleteBlock,
    replaceBlocks,
    previewBlocks,
    setActiveBlockId,
    receiveServerEcho,
    changePage,
    retry,
    flush,
  }
}

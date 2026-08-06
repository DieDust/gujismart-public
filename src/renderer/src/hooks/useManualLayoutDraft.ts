import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

export type ManualLayoutDraftBlock = Record<string, unknown>
export type ManualLayoutSaveState = 'clean' | 'dirty' | 'saving' | 'failed'

export interface ManualLayoutDraftState {
  draftIdentity: string
  pageId: string
  blocks: ManualLayoutDraftBlock[]
  baselineBlocks: ManualLayoutDraftBlock[]
  activeBlockId: string | null
  revision: number
  acknowledgedRevision: number
  saveState: ManualLayoutSaveState
  discardPending: boolean
}

export type ManualLayoutDraftAction =
  | { type: 'create'; block: ManualLayoutDraftBlock }
  | { type: 'update'; blockId: string; changes: ManualLayoutDraftBlock }
  | { type: 'delete'; blockId: string }
  | { type: 'replace'; blocks: ManualLayoutDraftBlock[]; activeBlockId?: string | null }
  | { type: 'preview-replace'; blocks: ManualLayoutDraftBlock[] }
  | { type: 'set-active'; blockId: string | null }
  | { type: 'save-started'; draftIdentity?: string; pageId?: string; revision: number }
  | { type: 'save-failed'; draftIdentity?: string; pageId?: string; revision: number }
  | { type: 'server-ack'; draftIdentity?: string; pageId?: string; revision: number; blocks: ManualLayoutDraftBlock[]; completeDiscard?: boolean }
  | { type: 'server-echo'; pageId: string; blocks: ManualLayoutDraftBlock[] }
  | { type: 'retry' }
  | { type: 'discard' }
  | { type: 'discard-pending'; revision: number }
  | { type: 'page-changed'; pageId: string; draftIdentity: string; blocks: ManualLayoutDraftBlock[]; restoredState?: ManualLayoutDraftState | null }

export type ManualLayoutSaveSchedule =
  | { kind: 'none' }
  | { kind: 'debounce'; revision: number }
  | { kind: 'flush'; revision: number }

type ManualLayoutSave = (
  pageId: string,
  blocks: ManualLayoutDraftBlock[],
  revision: number,
) => void | Promise<void>

export interface ManualLayoutDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface UseManualLayoutDraftOptions {
  draftIdentity: string
  pageId: string
  blocks: ManualLayoutDraftBlock[]
  save: ManualLayoutSave
  debounceMs?: number
  storage?: ManualLayoutDraftStorage | null
}

interface StoredManualLayoutDraft {
  version: 1
  draftIdentity: string
  pageId: string
  blocks: ManualLayoutDraftBlock[]
  baselineBlocks?: ManualLayoutDraftBlock[]
  activeBlockId: string | null
  revision: number
  acknowledgedRevision: number
  saveState: Exclude<ManualLayoutSaveState, 'clean'>
  discardPending: boolean
  updatedAt: number
}

export type PendingManualLayoutPageAction = 'same-page' | 'apply-target' | 'confirm-target' | 'wait-for-save'

const MANUAL_LAYOUT_DRAFT_STORAGE_PREFIX = 'gujismart.manual-layout-draft.v1:'
const manualLayoutDraftStorageCache = new WeakMap<object, Map<string, StoredManualLayoutDraft | null>>()

let manualBlockSequence = 0

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function getManualLayoutDraftStorageKey(draftIdentity: string): string {
  return `${MANUAL_LAYOUT_DRAFT_STORAGE_PREFIX}${encodeURIComponent(draftIdentity.trim())}`
}

export function getPendingManualLayoutPageAction(
  draftIdentity: string,
  draftPageId: string,
  targetIdentity: string,
  targetPageId: string,
  saveState: ManualLayoutSaveState,
  pendingTargetIdentity: string,
): PendingManualLayoutPageAction {
  if (draftIdentity === targetIdentity && draftPageId === targetPageId) return 'same-page'
  if (saveState === 'clean') return 'apply-target'
  return pendingTargetIdentity === targetIdentity ? 'wait-for-save' : 'confirm-target'
}

function getBrowserDraftStorage(): ManualLayoutDraftStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

function getManualLayoutDraftStorageCache(storage: ManualLayoutDraftStorage): Map<string, StoredManualLayoutDraft | null> {
  const existing = manualLayoutDraftStorageCache.get(storage)
  if (existing) return existing
  const created = new Map<string, StoredManualLayoutDraft | null>()
  manualLayoutDraftStorageCache.set(storage, created)
  return created
}

function readStoredManualLayoutDraft(
  storage: ManualLayoutDraftStorage,
  draftIdentity: string,
): StoredManualLayoutDraft | null {
  const normalizedIdentity = draftIdentity.trim()
  if (!normalizedIdentity) return null
  const cache = getManualLayoutDraftStorageCache(storage)
  if (cache.has(normalizedIdentity)) return cache.get(normalizedIdentity) || null
  try {
    const raw = storage.getItem(getManualLayoutDraftStorageKey(normalizedIdentity))
    if (!raw) {
      cache.set(normalizedIdentity, null)
      return null
    }
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)
      || value.version !== 1
      || value.draftIdentity !== normalizedIdentity
      || typeof value.pageId !== 'string'
      || !Array.isArray(value.blocks)
      || (value.baselineBlocks !== undefined && !Array.isArray(value.baselineBlocks))
      || !value.blocks.every(isRecord)
      || (Array.isArray(value.baselineBlocks) && !value.baselineBlocks.every(isRecord))
      || (value.activeBlockId !== null && typeof value.activeBlockId !== 'string')
      || !Number.isInteger(value.revision)
      || !Number.isInteger(value.acknowledgedRevision)
      || typeof value.updatedAt !== 'number'
      || (value.discardPending !== undefined && typeof value.discardPending !== 'boolean')
      || !['dirty', 'saving', 'failed'].includes(String(value.saveState))) {
      cache.set(normalizedIdentity, null)
      return null
    }
    const stored = value as unknown as StoredManualLayoutDraft
    cache.set(normalizedIdentity, stored)
    return stored
  } catch {
    cache.delete(normalizedIdentity)
    return null
  }
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

export function persistManualLayoutDraftSnapshot(
  storage: ManualLayoutDraftStorage | null,
  state: ManualLayoutDraftState,
): boolean {
  const draftIdentity = state.draftIdentity.trim()
  if (!storage || !draftIdentity) return false
  const key = getManualLayoutDraftStorageKey(draftIdentity)
  const cache = getManualLayoutDraftStorageCache(storage)
  try {
    const existing = readStoredManualLayoutDraft(storage, draftIdentity)
    if (state.saveState === 'clean') {
      if (!existing || existing.revision <= state.acknowledgedRevision) {
        storage.removeItem(key)
        cache.set(draftIdentity, null)
      }
      return true
    }
    if (existing && existing.revision > state.revision) return true
    const stored: StoredManualLayoutDraft = {
      version: 1,
      draftIdentity,
      pageId: state.pageId,
      blocks: state.blocks,
      baselineBlocks: state.baselineBlocks,
      activeBlockId: state.activeBlockId,
      revision: state.revision,
      acknowledgedRevision: state.acknowledgedRevision,
      saveState: state.saveState,
      discardPending: state.discardPending,
      updatedAt: Date.now(),
    }
    storage.setItem(key, JSON.stringify(stored))
    cache.set(draftIdentity, stored)
    return true
  } catch {
    cache.delete(draftIdentity)
    return false
  }
}

export function discardManualLayoutDraftSnapshot(
  storage: ManualLayoutDraftStorage | null,
  draftIdentity: string,
  maximumDiscardedRevision: number,
): boolean {
  const normalizedIdentity = draftIdentity.trim()
  if (!storage || !normalizedIdentity) return false
  const cache = getManualLayoutDraftStorageCache(storage)
  try {
    const existing = readStoredManualLayoutDraft(storage, normalizedIdentity)
    if (existing && existing.revision > maximumDiscardedRevision) return false
    storage.removeItem(getManualLayoutDraftStorageKey(normalizedIdentity))
    cache.set(normalizedIdentity, null)
    return true
  } catch {
    cache.delete(normalizedIdentity)
    return false
  }
}

export function restoreManualLayoutDraftSnapshot(
  storage: ManualLayoutDraftStorage | null,
  draftIdentity: string,
  pageId: string,
  serverBlocks: readonly ManualLayoutDraftBlock[],
): ManualLayoutDraftState | null {
  if (!storage) return null
  const stored = readStoredManualLayoutDraft(storage, draftIdentity)
  if (!stored || stored.pageId !== pageId || stored.revision <= stored.acknowledgedRevision) return null
  const baselineBlocks = stored.discardPending && Array.isArray(stored.baselineBlocks)
    ? prepareBlocks(pageId, stored.baselineBlocks)
    : prepareBlocks(pageId, serverBlocks)
  const blocks = mergeAcknowledgedBlocks(pageId, prepareBlocks(pageId, stored.blocks), baselineBlocks)
  const activeBlockId = stored.activeBlockId && blocks.some((block, index) => (
    getManualLayoutDraftBlockId(pageId, block, index) === stored.activeBlockId
  ))
    ? stored.activeBlockId
    : null
  return {
    draftIdentity: draftIdentity.trim(),
    pageId,
    blocks,
    baselineBlocks,
    activeBlockId,
    revision: Math.max(1, stored.revision),
    acknowledgedRevision: Math.max(0, Math.min(stored.acknowledgedRevision, stored.revision - 1)),
    saveState: stored.saveState === 'failed' ? 'failed' : 'dirty',
    discardPending: stored.discardPending === true,
  }
}

export function createManualLayoutDraft(
  pageId: string,
  blocks: readonly ManualLayoutDraftBlock[],
  draftIdentity = pageId,
): ManualLayoutDraftState {
  const preparedBlocks = prepareBlocks(pageId, blocks)
  return {
    draftIdentity,
    pageId,
    blocks: preparedBlocks,
    baselineBlocks: preparedBlocks,
    activeBlockId: null,
    revision: 0,
    acknowledgedRevision: 0,
    saveState: 'clean',
    discardPending: false,
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

export function isManualLayoutContentMutationAction(action: ManualLayoutDraftAction): boolean {
  return ['create', 'update', 'delete', 'replace', 'preview-replace'].includes(action.type)
}

export function reduceManualLayoutDraft(
  state: ManualLayoutDraftState,
  action: ManualLayoutDraftAction,
): ManualLayoutDraftState {
  if (state.discardPending && isManualLayoutContentMutationAction(action)) return state
  if (state.discardPending && (action.type === 'server-echo' || action.type === 'page-changed')) return state
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
      if ((action.draftIdentity && action.draftIdentity !== state.draftIdentity)
        || (action.pageId && action.pageId !== state.pageId)
        || action.revision !== state.revision) return state
      return { ...state, saveState: 'saving' }
    case 'save-failed':
      if ((action.draftIdentity && action.draftIdentity !== state.draftIdentity)
        || (action.pageId && action.pageId !== state.pageId)
        || action.revision > state.revision) return state
      if (state.acknowledgedRevision >= state.revision) return state
      if (action.revision < state.revision) return { ...state, saveState: 'dirty' }
      return { ...state, saveState: 'failed' }
    case 'server-ack': {
      if ((action.draftIdentity && action.draftIdentity !== state.draftIdentity)
        || (action.pageId && action.pageId !== state.pageId)) return state
      if (action.revision < state.acknowledgedRevision || action.revision > state.revision) return state
      const acknowledgedRevision = Math.max(state.acknowledgedRevision, action.revision)
      const baselineBlocks = prepareBlocks(state.pageId, action.blocks)
      if (action.revision !== state.revision) {
        return {
          ...state,
          baselineBlocks,
          acknowledgedRevision,
          saveState: state.saveState === 'failed' ? 'failed' : 'dirty',
          discardPending: action.completeDiscard ? false : state.discardPending,
        }
      }
      return {
        ...state,
        blocks: mergeAcknowledgedBlocks(state.pageId, state.blocks, action.blocks),
        baselineBlocks,
        acknowledgedRevision,
        saveState: 'clean',
        discardPending: false,
      }
    }
    case 'server-echo': {
      if (action.pageId !== state.pageId) return state
      const baselineBlocks = prepareBlocks(state.pageId, action.blocks)
      if (state.saveState !== 'clean') {
        return {
          ...state,
          blocks: mergeAcknowledgedBlocks(state.pageId, state.blocks, baselineBlocks),
          baselineBlocks,
        }
      }
      const blocks = baselineBlocks
      const activeBlockId = state.activeBlockId && blocks.some((block, index) => (
        getManualLayoutDraftBlockId(state.pageId, block, index) === state.activeBlockId
      ))
        ? state.activeBlockId
        : null
      return { ...state, blocks, baselineBlocks, activeBlockId }
    }
    case 'retry':
      return state.saveState === 'failed' ? { ...state, saveState: 'dirty' } : state
    case 'discard':
      return {
        ...state,
        blocks: state.baselineBlocks.map((block) => ({ ...block })),
        activeBlockId: null,
        revision: state.acknowledgedRevision,
        saveState: 'clean',
        discardPending: false,
      }
    case 'discard-pending':
      return {
        ...state,
        blocks: state.baselineBlocks.map((block) => ({ ...block })),
        activeBlockId: null,
        revision: action.revision,
        saveState: 'saving',
        discardPending: true,
      }
    case 'page-changed':
      return action.restoredState || createManualLayoutDraft(action.pageId, action.blocks, action.draftIdentity)
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

export function shouldPersistManualLayoutDraftAction(action: ManualLayoutDraftAction): boolean {
  return action.type !== 'set-active' && action.type !== 'preview-replace'
}

function shouldClearManualLayoutPreview(action: ManualLayoutDraftAction): boolean {
  return ['create', 'update', 'delete', 'replace', 'discard', 'discard-pending', 'page-changed'].includes(action.type)
}

export function isManualLayoutSaveEpochCurrent(
  currentEpoch: number,
  capturedEpoch: number,
  currentDraftIdentity: string,
  capturedDraftIdentity: string,
): boolean {
  return currentEpoch === capturedEpoch && currentDraftIdentity === capturedDraftIdentity
}

export function finalizeManualLayoutDraftOnUnmount(
  committedState: ManualLayoutDraftState,
  clearTimer: () => void,
  persist: (state: ManualLayoutDraftState) => void,
  flush: () => Promise<boolean>,
): boolean {
  clearTimer()
  persist(committedState)
  if (committedState.saveState === 'clean') return false
  void Promise.resolve(flush()).catch(() => false)
  return true
}

export interface ManualLayoutDiscardCompensationSnapshot {
  draftIdentity: string
  pageId: string
  blocks: ManualLayoutDraftBlock[]
  revision: number
}

export function createManualLayoutDiscardCompensationSnapshot(
  state: ManualLayoutDraftState,
): ManualLayoutDiscardCompensationSnapshot {
  return {
    draftIdentity: state.draftIdentity,
    pageId: state.pageId,
    blocks: state.baselineBlocks.map((block) => ({ ...block })),
    revision: state.revision + 1,
  }
}

export function getManualLayoutDiscardCompensationSnapshot(
  state: ManualLayoutDraftState,
): ManualLayoutDiscardCompensationSnapshot {
  if (!state.discardPending) return createManualLayoutDiscardCompensationSnapshot(state)
  return {
    draftIdentity: state.draftIdentity,
    pageId: state.pageId,
    blocks: state.baselineBlocks.map((block) => ({ ...block })),
    revision: state.revision,
  }
}

export async function runManualLayoutDiscardCompensation(
  supersededSave: Promise<boolean>,
  snapshot: ManualLayoutDiscardCompensationSnapshot,
  persistBaseline: (snapshot: ManualLayoutDiscardCompensationSnapshot) => void | Promise<void>,
): Promise<boolean> {
  try {
    await supersededSave
  } catch {
    // A rejected caller cannot prove that the underlying write did not land.
    // The fixed baseline compensation must still run exactly once.
  }
  try {
    await Promise.resolve(persistBaseline(snapshot))
    return true
  } catch {
    return false
  }
}

export interface ManualLayoutDraftPageTarget {
  pageId: string
  draftIdentity: string
  blocks: ManualLayoutDraftBlock[]
}

export interface ManualLayoutDiscardQueueResult {
  success: boolean
  target: ManualLayoutDraftPageTarget | null
}

export interface ManualLayoutDiscardQueue {
  request(target: ManualLayoutDraftPageTarget | null): Promise<ManualLayoutDiscardQueueResult>
}

export function createManualLayoutDiscardQueue(
  runDiscard: () => Promise<boolean>,
  applyTarget: (target: ManualLayoutDraftPageTarget) => void,
): ManualLayoutDiscardQueue {
  let latestTarget: ManualLayoutDraftPageTarget | null = null
  let activePromise: Promise<ManualLayoutDiscardQueueResult> | null = null
  return {
    request(target) {
      latestTarget = target
      if (activePromise) return activePromise
      const operation = (async (): Promise<ManualLayoutDiscardQueueResult> => {
        let success = false
        try {
          success = await runDiscard()
        } catch {
          success = false
        }
        if (!success) {
          latestTarget = null
          return { success: false, target: null }
        }
        const appliedTarget = latestTarget
        latestTarget = null
        if (appliedTarget) applyTarget(appliedTarget)
        return { success: true, target: appliedTarget }
      })()
      activePromise = operation
      void operation.then(
        () => { if (activePromise === operation) activePromise = null },
        () => { if (activePromise === operation) activePromise = null },
      )
      return operation
    },
  }
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
  draftIdentity,
  pageId,
  blocks,
  save,
  debounceMs = 450,
  storage,
}: UseManualLayoutDraftOptions) {
  const storageRef = useRef<ManualLayoutDraftStorage | null>(
    storage === undefined ? getBrowserDraftStorage() : storage,
  )
  const [state, reducerDispatch] = useReducer(
    reduceManualLayoutDraft,
    undefined,
    () => restoreManualLayoutDraftSnapshot(storageRef.current, draftIdentity, pageId, blocks)
      || createManualLayoutDraft(pageId, blocks, draftIdentity),
  )
  const [previewBlocksState, setPreviewBlocksState] = useState<ManualLayoutDraftBlock[] | null>(null)
  const stateRef = useRef(state)
  const saveRef = useRef(save)
  const mountedRef = useRef(true)
  const timerRef = useRef<number | null>(null)
  const inFlightRef = useRef<Promise<boolean> | null>(null)
  const saveRunnerRef = useRef<() => Promise<boolean>>(async () => true)
  const saveEpochRef = useRef(0)
  const runDiscardRef = useRef<() => Promise<boolean>>(async () => true)
  const applyDiscardTargetRef = useRef<(target: ManualLayoutDraftPageTarget) => void>(() => undefined)
  const discardQueueRef = useRef<ManualLayoutDiscardQueue | null>(null)
  if (!discardQueueRef.current) {
    discardQueueRef.current = createManualLayoutDiscardQueue(
      () => runDiscardRef.current(),
      (target) => applyDiscardTargetRef.current(target),
    )
  }

  const dispatch = useCallback((action: ManualLayoutDraftAction) => {
    const current = stateRef.current
    if (current.discardPending && isManualLayoutContentMutationAction(action)) return
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
    if (shouldClearManualLayoutPreview(stableAction) && mountedRef.current) setPreviewBlocksState(null)
    if (shouldPersistManualLayoutDraftAction(stableAction)) {
      persistManualLayoutDraftSnapshot(storageRef.current, stateRef.current)
    }
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
    const saveEpoch = saveEpochRef.current
    clearSaveTimer()
    dispatch({
      type: 'save-started',
      draftIdentity: snapshot.draftIdentity,
      pageId: snapshot.pageId,
      revision: snapshot.revision,
    })
    const savePromise = (async () => {
      try {
        await Promise.resolve(saveRef.current(snapshot.pageId, snapshot.blocks, snapshot.revision))
        if (!isManualLayoutSaveEpochCurrent(
          saveEpochRef.current,
          saveEpoch,
          stateRef.current.draftIdentity,
          snapshot.draftIdentity,
        )) return true
        dispatch({
          type: 'server-ack',
          draftIdentity: snapshot.draftIdentity,
          pageId: snapshot.pageId,
          revision: snapshot.revision,
          blocks: snapshot.blocks,
        })
        return true
      } catch {
        if (isManualLayoutSaveEpochCurrent(
          saveEpochRef.current,
          saveEpoch,
          stateRef.current.draftIdentity,
          snapshot.draftIdentity,
        )) {
          dispatch({
            type: 'save-failed',
            draftIdentity: snapshot.draftIdentity,
            pageId: snapshot.pageId,
            revision: snapshot.revision,
          })
        }
        return false
      } finally {
        if (saveEpochRef.current === saveEpoch) inFlightRef.current = null
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
      finalizeManualLayoutDraftOnUnmount(
        stateRef.current,
        clearSaveTimer,
        (committedState) => { persistManualLayoutDraftSnapshot(storageRef.current, committedState) },
        () => saveRunnerRef.current(),
      )
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
    if (stateRef.current.discardPending) return
    clearSaveTimer()
    if (mountedRef.current) setPreviewBlocksState(prepareBlocks(stateRef.current.pageId, nextBlocks))
  }, [clearSaveTimer])
  const setActiveBlockId = useCallback((blockId: string | null) => {
    dispatch({ type: 'set-active', blockId })
  }, [dispatch])
  const receiveServerEcho = useCallback((echoPageId: string, nextBlocks: ManualLayoutDraftBlock[]) => {
    dispatch({ type: 'server-echo', pageId: echoPageId, blocks: nextBlocks })
  }, [dispatch])
  const changePage = useCallback((nextPageId: string, nextDraftIdentity: string, nextBlocks: ManualLayoutDraftBlock[]) => {
    clearSaveTimer()
    saveEpochRef.current += 1
    inFlightRef.current = null
    const restoredState = restoreManualLayoutDraftSnapshot(
      storageRef.current,
      nextDraftIdentity,
      nextPageId,
      nextBlocks,
    )
    dispatch({
      type: 'page-changed',
      pageId: nextPageId,
      draftIdentity: nextDraftIdentity,
      blocks: nextBlocks,
      restoredState,
    })
  }, [clearSaveTimer, dispatch])
  const runDiscardCompensation = useCallback(async (): Promise<boolean> => {
    clearSaveTimer()
    const discardedState = stateRef.current
    const compensationSnapshot = getManualLayoutDiscardCompensationSnapshot(discardedState)
    const supersededSave = inFlightRef.current
    saveEpochRef.current += 1
    inFlightRef.current = null
    discardManualLayoutDraftSnapshot(
      storageRef.current,
      compensationSnapshot.draftIdentity,
      discardedState.revision,
    )
    if (!supersededSave && !discardedState.discardPending) {
      dispatch({ type: 'discard' })
      return true
    }

    dispatch({ type: 'discard-pending', revision: compensationSnapshot.revision })
    const compensated = await runManualLayoutDiscardCompensation(
      supersededSave || Promise.resolve(true),
      compensationSnapshot,
      (fixedSnapshot) => saveRef.current(
        fixedSnapshot.pageId,
        fixedSnapshot.blocks,
        fixedSnapshot.revision,
      ),
    )
    if (compensated) {
      dispatch({
        type: 'server-ack',
        draftIdentity: compensationSnapshot.draftIdentity,
        pageId: compensationSnapshot.pageId,
        revision: compensationSnapshot.revision,
        blocks: compensationSnapshot.blocks,
        completeDiscard: true,
      })
      return true
    }
    dispatch({
      type: 'save-failed',
      draftIdentity: compensationSnapshot.draftIdentity,
      pageId: compensationSnapshot.pageId,
      revision: compensationSnapshot.revision,
    })
    return false
  }, [clearSaveTimer, dispatch])
  runDiscardRef.current = runDiscardCompensation
  applyDiscardTargetRef.current = (target) => {
    changePage(target.pageId, target.draftIdentity, target.blocks)
  }
  const discardCurrentDraft = useCallback(async (): Promise<boolean> => {
    const result = await discardQueueRef.current?.request(null)
    return result?.success === true
  }, [])
  const discardAndChangePage = useCallback(async (
    nextPageId: string,
    nextDraftIdentity: string,
    nextBlocks: ManualLayoutDraftBlock[],
  ): Promise<ManualLayoutDraftPageTarget | null> => {
    const result = await discardQueueRef.current?.request({
      pageId: nextPageId,
      draftIdentity: nextDraftIdentity,
      blocks: nextBlocks,
    })
    return result?.success ? result.target : null
  }, [])
  const retry = useCallback(() => {
    dispatch({ type: 'retry' })
    void saveCurrentRevision()
  }, [dispatch, saveCurrentRevision])

  const displayState = useMemo(() => (
    previewBlocksState ? { ...state, blocks: previewBlocksState } : state
  ), [previewBlocksState, state])

  return {
    state: displayState,
    createBlock,
    updateBlock,
    deleteBlock,
    replaceBlocks,
    previewBlocks,
    setActiveBlockId,
    receiveServerEcho,
    changePage,
    discardCurrentDraft,
    discardAndChangePage,
    retry,
    flush,
  }
}

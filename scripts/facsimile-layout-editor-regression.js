const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const helperPath = path.join(root, 'src/renderer/src/utils/facsimileTableEditing.ts')
const helperSource = fs.readFileSync(helperPath, 'utf8')
const transpiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const helperModule = { exports: {} }
new Function('exports', 'module', 'require', transpiled)(helperModule.exports, helperModule, require)

const draftHelperPath = path.join(root, 'src/renderer/src/hooks/useManualLayoutDraft.ts')
const draftHelperSource = fs.existsSync(draftHelperPath) ? fs.readFileSync(draftHelperPath, 'utf8') : ''
const draftHelperModule = { exports: {} }
if (draftHelperSource) {
  const draftTranspiled = ts.transpileModule(draftHelperSource, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  new Function('exports', 'module', 'require', draftTranspiled)(draftHelperModule.exports, draftHelperModule, require)
}

const textEditorSavingPath = path.join(root, 'src/renderer/src/utils/textEditorSaving.ts')
const textEditorSavingSource = fs.existsSync(textEditorSavingPath) ? fs.readFileSync(textEditorSavingPath, 'utf8') : ''
const textEditorSavingModule = { exports: {} }
if (textEditorSavingSource) {
  const textEditorSavingTranspiled = ts.transpileModule(textEditorSavingSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  new Function('exports', 'module', 'require', textEditorSavingTranspiled)(textEditorSavingModule.exports, textEditorSavingModule, require)
}

const underlayHelperPath = path.join(root, 'src/renderer/src/utils/manualLayoutUnderlay.ts')
const underlayHelperSource = fs.existsSync(underlayHelperPath) ? fs.readFileSync(underlayHelperPath, 'utf8') : ''
const underlayHelperModule = { exports: {} }
if (underlayHelperSource) {
  const underlayHelperTranspiled = ts.transpileModule(underlayHelperSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  new Function('exports', 'module', 'require', underlayHelperTranspiled)(underlayHelperModule.exports, underlayHelperModule, require)
}

const blockEditingHelperPath = path.join(root, 'src/renderer/src/utils/manualLayoutBlockEditing.ts')
assert.ok(fs.existsSync(blockEditingHelperPath), 'typed manual blocks must expose a pure interaction helper')
const blockEditingHelperSource = fs.readFileSync(blockEditingHelperPath, 'utf8')
const blockEditingHelperModule = { exports: {} }
const blockEditingTranspiled = ts.transpileModule(blockEditingHelperSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
new Function('exports', 'module', 'require', blockEditingTranspiled)(blockEditingHelperModule.exports, blockEditingHelperModule, require)

const {
  buildFacsimileTableCells,
  clearFacsimileTableSelection,
  deleteFacsimileTableColumn,
  deleteFacsimileTableRow,
  FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH,
  FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT,
  FACSIMILE_TABLE_MAX_CELLS,
  FACSIMILE_TABLE_MAX_COLUMN_WIDTH,
  FACSIMILE_TABLE_MAX_COLUMNS,
  FACSIMILE_TABLE_MAX_ROW_HEIGHT,
  FACSIMILE_TABLE_MAX_ROWS,
  FACSIMILE_TABLE_MIN_COLUMN_WIDTH,
  FACSIMILE_TABLE_MIN_ROW_HEIGHT,
  getFacsimileTableSelection,
  getFacsimileTableWholeColumnSelection,
  getFacsimileTableWholeRowSelection,
  insertFacsimileTableColumn,
  insertFacsimileTableRow,
  mergeFacsimileTableSelection,
  normalizeFacsimileTableColumnWidths,
  normalizeFacsimileTableMerges,
  normalizeFacsimileTableRows,
  normalizeFacsimileTableRowHeights,
  normalizeFacsimileTableSelection,
  parseFacsimileTableClipboard,
  parseFacsimileTableClipboardData,
  pasteFacsimileTableRange,
  splitFacsimileTableCell,
} = helperModule.exports

const {
  continueManualLayoutSaveAfterSettlement,
  createManualLayoutPreviewTransition,
  createManualLayoutDiscardCompensationSnapshot,
  createManualLayoutDiscardQueue,
  createManualLayoutDraft,
  discardManualLayoutDraftSnapshot,
  ensureManualLayoutBlockIdentity,
  finalizeManualLayoutDraftOnUnmount,
  getPendingManualLayoutPageAction,
  getManualLayoutDiscardCompensationSnapshot,
  getManualLayoutDraftBlockId,
  getManualLayoutDraftStorageKey,
  getManualLayoutSaveSchedule,
  isManualLayoutSaveEpochCurrent,
  isManualLayoutContentMutationAction,
  persistManualLayoutDraftSnapshot,
  reduceManualLayoutDraft,
  restoreManualLayoutDraftSnapshot,
  runManualLayoutDiscardCompensation,
  shouldPersistManualLayoutDraftAction,
} = draftHelperModule.exports

const { saveTextEditorPage } = textEditorSavingModule.exports
const { getManualLayoutUnderlayImageStyle } = underlayHelperModule.exports
const {
  MANUAL_LAYOUT_BLOCK_KINDS,
  MANUAL_LAYOUT_MORE_KINDS,
  MANUAL_LAYOUT_QUICK_KINDS,
  applyManualLayoutBlockConversion,
  clampManualLayoutBlockRect,
  commitManualLayoutGeometryPreview,
  createManualLayoutGeometryPreview,
  createManualLayoutPointerFrameScheduler,
  createManualLayoutTableSnapshot,
  getManualLayoutBlockConversionWarning,
  getManualLayoutEditEntryPreparation,
  getManualLayoutBlockVisualState,
  moveManualLayoutBlockRect,
  normalizeManualLayoutBlockRect,
  reduceManualLayoutTool,
  resizeManualLayoutBlockRect,
  rollbackManualLayoutGeometryPreview,
  updateManualLayoutGeometryPreview,
} = blockEditingHelperModule.exports

assert.strictEqual(typeof createManualLayoutDraft, 'function', 'manual layout drafts must expose a testable state factory')
assert.strictEqual(typeof createManualLayoutPreviewTransition, 'function', 'preview must expose an executable transition that preserves committed save scheduling')
assert.strictEqual(typeof reduceManualLayoutDraft, 'function', 'manual layout drafts must expose a pure reducer')
assert.strictEqual(typeof continueManualLayoutSaveAfterSettlement, 'function', 'an in-flight save must expose a testable continuation path for newer revisions')
assert.strictEqual(typeof saveTextEditorPage, 'function', 'text editor saves must expose a testable real-outcome adapter')
assert.strictEqual(typeof persistManualLayoutDraftSnapshot, 'function', 'dirty drafts must expose synchronous durable storage')
assert.strictEqual(typeof restoreManualLayoutDraftSnapshot, 'function', 'the same isolated page identity must restore its durable draft')
assert.strictEqual(typeof getPendingManualLayoutPageAction, 'function', 'pending page changes must expose a testable failure/retry state machine')
assert.strictEqual(typeof getManualLayoutUnderlayImageStyle, 'function', 'underlay rendering must expose a testable Alt-clear style')
assert.strictEqual(typeof discardManualLayoutDraftSnapshot, 'function', 'discarding a draft must explicitly remove only its own durable snapshot')
assert.strictEqual(typeof finalizeManualLayoutDraftOnUnmount, 'function', 'unmount cleanup must expose executable persistence and flush behavior')
assert.strictEqual(typeof shouldPersistManualLayoutDraftAction, 'function', 'preview and selection actions must be distinguishable from durable commits')
assert.strictEqual(typeof isManualLayoutSaveEpochCurrent, 'function', 'late save responses must be guarded by an explicit runtime epoch')
assert.strictEqual(typeof isManualLayoutContentMutationAction, 'function', 'discard compensation must expose the content-mutation guard')
assert.strictEqual(typeof createManualLayoutDiscardCompensationSnapshot, 'function', 'discard compensation must capture one immutable baseline snapshot')
assert.strictEqual(typeof getManualLayoutDiscardCompensationSnapshot, 'function', 'discard retry must expose the exact fixed snapshot used by the hook')
assert.strictEqual(typeof runManualLayoutDiscardCompensation, 'function', 'discard compensation must expose the serialized old-write barrier')
assert.strictEqual(typeof createManualLayoutDiscardQueue, 'function', 'repeated discard targets must share one serialized operation')

async function runAsyncDraftChecks() {
  const pageId = 'page-save-race'
  const original = ensureManualLayoutBlockIdentity(pageId, { ir_block_id: 'ocr-race', words: '0' }, 0)
  const blockId = getManualLayoutDraftBlockId(pageId, original, 0)
  let state = createManualLayoutDraft(pageId, [original])
  state = reduceManualLayoutDraft(state, { type: 'update', blockId, changes: { words: '1' } })
  const firstRevision = state.revision
  state = reduceManualLayoutDraft(state, { type: 'save-started', revision: firstRevision })
  state = reduceManualLayoutDraft(state, { type: 'update', blockId, changes: { words: '2' } })
  const latestRevision = state.revision

  let settleFirstSave
  const firstSave = new Promise((resolve) => {
    settleFirstSave = resolve
  })
  const savedRevisions = []
  const continuation = continueManualLayoutSaveAfterSettlement(
    firstSave,
    () => state,
    async () => {
      const snapshot = state
      savedRevisions.push(snapshot.revision)
      state = reduceManualLayoutDraft(snapshot, { type: 'save-started', revision: snapshot.revision })
      state = reduceManualLayoutDraft(state, {
        type: 'server-ack',
        revision: snapshot.revision,
        blocks: snapshot.blocks,
      })
      return true
    },
  )
  state = reduceManualLayoutDraft(state, {
    type: 'server-ack',
    revision: firstRevision,
    blocks: [{ ...original, words: '1' }],
  })
  settleFirstSave(true)
  assert.strictEqual(await continuation, true, 'the save chain must settle only after its latest revision is stored')
  assert.deepStrictEqual(savedRevisions, [latestRevision], 'the newer revision must automatically save after the old promise settles')
  assert.strictEqual(state.saveState, 'clean', 'the newer revision must not remain permanently dirty')
  assert.strictEqual(state.blocks[0].words, '2', 'the old acknowledgement must not overwrite the newer local edit')

  const discardIdentity = 'project-race/document-race/page-race'
  const discardBaseline = ensureManualLayoutBlockIdentity('page-race', { ir_block_id: 'ocr-baseline', words: 'server-baseline' }, 0)
  const discardBlockId = getManualLayoutDraftBlockId('page-race', discardBaseline, 0)
  let discardState = createManualLayoutDraft('page-race', [discardBaseline], discardIdentity)
  discardState = reduceManualLayoutDraft(discardState, { type: 'update', blockId: discardBlockId, changes: { words: 'abandoned-edit' } })
  const fixedCompensation = createManualLayoutDiscardCompensationSnapshot(discardState)
  assert.strictEqual(fixedCompensation.revision, discardState.revision + 1, 'the fixed compensation revision must be allocated before waiting for the old save')
  assert.strictEqual(fixedCompensation.blocks[0].words, 'server-baseline', 'compensation must capture the acknowledged baseline, never the abandoned edit')
  const discardPendingState = reduceManualLayoutDraft(discardState, { type: 'discard-pending', revision: fixedCompensation.revision })
  assert.strictEqual(discardPendingState.discardPending, true)
  assert.strictEqual(discardPendingState.blocks[0].words, 'server-baseline')
  const abandonedSamePageEcho = reduceManualLayoutDraft(discardPendingState, {
    type: 'server-echo',
    pageId: 'page-race',
    blocks: [{ ...discardBaseline, words: 'abandoned-edit-that-landed' }],
  })
  assert.strictEqual(abandonedSamePageEcho, discardPendingState, 'a same-page echo from the superseded save must leave every pending compensation field untouched')
  assert.deepStrictEqual({
    blocks: abandonedSamePageEcho.blocks,
    baselineBlocks: abandonedSamePageEcho.baselineBlocks,
    revision: abandonedSamePageEcho.revision,
    acknowledgedRevision: abandonedSamePageEcho.acknowledgedRevision,
    saveState: abandonedSamePageEcho.saveState,
    activeBlockId: abandonedSamePageEcho.activeBlockId,
    discardPending: abandonedSamePageEcho.discardPending,
  }, {
    blocks: discardPendingState.blocks,
    baselineBlocks: discardPendingState.baselineBlocks,
    revision: discardPendingState.revision,
    acknowledgedRevision: discardPendingState.acknowledgedRevision,
    saveState: discardPendingState.saveState,
    activeBlockId: discardPendingState.activeBlockId,
    discardPending: discardPendingState.discardPending,
  })
  const blockedIdentityChange = reduceManualLayoutDraft(discardPendingState, {
    type: 'page-changed',
    pageId: 'page-unauthorized',
    draftIdentity: 'project/document/page-unauthorized',
    blocks: [{ words: 'unauthorized-target' }],
  })
  assert.strictEqual(blockedIdentityChange, discardPendingState, 'only a target applied after successful compensation may change draft identity')
  const retryCompensation = getManualLayoutDiscardCompensationSnapshot(abandonedSamePageEcho)
  let baselineAfterIgnoredEcho = null
  assert.strictEqual(await runManualLayoutDiscardCompensation(
    Promise.resolve(true),
    retryCompensation,
    (snapshot) => { baselineAfterIgnoredEcho = snapshot },
  ), true)
  assert.strictEqual(baselineAfterIgnoredEcho.blocks[0].words, 'server-baseline', 'retrying after an ignored echo must still write the fixed baseline')
  assert.strictEqual(baselineAfterIgnoredEcho.revision, fixedCompensation.revision, 'retrying a pending discard must reuse its fixed revision')
  const interruptedValues = new Map()
  const interruptedStorage = {
    getItem: (key) => interruptedValues.get(key) ?? null,
    setItem: (key, value) => interruptedValues.set(key, value),
    removeItem: (key) => interruptedValues.delete(key),
  }
  persistManualLayoutDraftSnapshot(interruptedStorage, discardPendingState)
  const restoredCompensation = restoreManualLayoutDraftSnapshot(
    interruptedStorage,
    discardIdentity,
    'page-race',
    [{ ...discardBaseline, words: 'abandoned-edit-that-may-have-landed' }],
  )
  assert.ok(restoredCompensation)
  assert.strictEqual(restoredCompensation.discardPending, true)
  assert.strictEqual(restoredCompensation.baselineBlocks[0].words, 'server-baseline', 'an interrupted compensation must restore its fixed baseline instead of trusting a superseded write')
  assert.strictEqual(restoredCompensation.revision, fixedCompensation.revision, 'restarting must retain the fixed compensation revision')
  for (const action of [
    { type: 'create', block: { words: 'blocked-create' } },
    { type: 'update', blockId: discardBlockId, changes: { words: 'blocked-update' } },
    { type: 'delete', blockId: discardBlockId },
    { type: 'replace', blocks: [{ words: 'blocked-replace' }] },
    { type: 'preview-replace', blocks: [{ words: 'blocked-preview' }] },
  ]) {
    assert.strictEqual(isManualLayoutContentMutationAction(action), true)
    assert.strictEqual(reduceManualLayoutDraft(discardPendingState, action), discardPendingState, `${action.type} must be rejected while baseline compensation is pending`)
  }

  const defensiveNewer = {
    ...discardPendingState,
    blocks: [...discardPendingState.blocks, { manual_block_id: 'defensive-newer', words: 'defensive-newer-edit' }],
    revision: fixedCompensation.revision + 1,
    saveState: 'dirty',
  }
  const fixedAckWithNewerDraft = reduceManualLayoutDraft(defensiveNewer, {
    type: 'server-ack',
    draftIdentity: fixedCompensation.draftIdentity,
    pageId: fixedCompensation.pageId,
    revision: fixedCompensation.revision,
    blocks: fixedCompensation.blocks,
    completeDiscard: true,
  })
  assert.strictEqual(fixedAckWithNewerDraft.revision, defensiveNewer.revision, 'a fixed compensation acknowledgement must not acknowledge a defensive newer revision')
  assert.strictEqual(fixedAckWithNewerDraft.acknowledgedRevision, fixedCompensation.revision)
  assert.strictEqual(fixedAckWithNewerDraft.saveState, 'dirty')
  assert.strictEqual(fixedAckWithNewerDraft.discardPending, false)
  assert.ok(fixedAckWithNewerDraft.blocks.some((block) => block.words === 'defensive-newer-edit'), 'a defensive newer edit must remain dirty instead of being erased')
  const guardedCache = new Map()
  const guardedStorage = {
    getItem: (key) => guardedCache.get(key) ?? null,
    setItem: (key, value) => guardedCache.set(key, value),
    removeItem: (key) => guardedCache.delete(key),
  }
  persistManualLayoutDraftSnapshot(guardedStorage, defensiveNewer)
  persistManualLayoutDraftSnapshot(guardedStorage, fixedAckWithNewerDraft)
  assert.strictEqual(guardedCache.has(getManualLayoutDraftStorageKey(discardIdentity)), true, 'a fixed acknowledgement must retain the durable cache for a defensive newer revision')

  let settleOldWrite
  const oldWrite = new Promise((resolve) => { settleOldWrite = resolve })
  let compensationWrites = 0
  const compensatedRevisions = []
  const appliedTargets = []
  const targetA = { pageId: 'page-a', draftIdentity: 'project/document/page-a', blocks: [{ words: 'A' }] }
  const targetB = { pageId: 'page-b', draftIdentity: 'project/document/page-b', blocks: [{ words: 'B' }] }
  const discardQueue = createManualLayoutDiscardQueue(
    () => runManualLayoutDiscardCompensation(oldWrite, fixedCompensation, async (snapshot) => {
      compensationWrites += 1
      compensatedRevisions.push(snapshot.revision)
    }),
    (target) => appliedTargets.push(target),
  )
  const discardA = discardQueue.request(targetA)
  const discardB = discardQueue.request(targetB)
  assert.strictEqual(discardA, discardB, 'a second target must share the exact in-flight discard promise')
  await Promise.resolve()
  assert.strictEqual(compensationWrites, 0, 'baseline compensation must wait until the superseded save settles')
  settleOldWrite(true)
  const discardResult = await discardA
  assert.strictEqual(discardResult.success, true)
  assert.strictEqual(compensationWrites, 1, 'one serialized discard must persist its fixed baseline exactly once')
  assert.deepStrictEqual(compensatedRevisions, [fixedCompensation.revision])
  assert.deepStrictEqual(appliedTargets, [targetB], 'only the latest requested target may be applied')
  assert.strictEqual(discardResult.target, targetB)

  let compensationAfterRejectedOldWrite = 0
  assert.strictEqual(await runManualLayoutDiscardCompensation(
    Promise.reject(new Error('old caller rejected after a possible write')),
    fixedCompensation,
    () => { compensationAfterRejectedOldWrite += 1 },
  ), true)
  assert.strictEqual(compensationAfterRejectedOldWrite, 1, 'a rejected old save cannot cancel the mandatory baseline compensation')

  let failedBaselineState = discardPendingState
  const failedTargets = []
  const failingQueue = createManualLayoutDiscardQueue(async () => {
    const compensated = await runManualLayoutDiscardCompensation(
      Promise.resolve(true),
      fixedCompensation,
      async () => { throw new Error('baseline write failed') },
    )
    failedBaselineState = reduceManualLayoutDraft(failedBaselineState, {
      type: 'save-failed',
      draftIdentity: fixedCompensation.draftIdentity,
      pageId: fixedCompensation.pageId,
      revision: fixedCompensation.revision,
    })
    return compensated
  }, (target) => failedTargets.push(target))
  const failedDiscard = await failingQueue.request(targetB)
  assert.strictEqual(failedDiscard.success, false)
  assert.deepStrictEqual(failedTargets, [], 'a failed baseline compensation must never apply its target page')
  assert.strictEqual(failedBaselineState.saveState, 'failed')
  assert.strictEqual(failedBaselineState.discardPending, true)
  assert.strictEqual(failedBaselineState.blocks[0].words, 'server-baseline')
  const failedRevision = failedBaselineState.revision
  failedBaselineState = reduceManualLayoutDraft(failedBaselineState, { type: 'retry' })
  assert.strictEqual(failedBaselineState.revision, failedRevision, 'retrying baseline compensation must not allocate a new revision')
  failedBaselineState = reduceManualLayoutDraft(failedBaselineState, {
    type: 'save-started',
    draftIdentity: fixedCompensation.draftIdentity,
    pageId: fixedCompensation.pageId,
    revision: fixedCompensation.revision,
  })
  await Promise.resolve()
  failedBaselineState = reduceManualLayoutDraft(failedBaselineState, {
    type: 'server-ack',
    draftIdentity: fixedCompensation.draftIdentity,
    pageId: fixedCompensation.pageId,
    revision: fixedCompensation.revision,
    blocks: fixedCompensation.blocks,
  })
  assert.strictEqual(failedBaselineState.saveState, 'clean')
  assert.strictEqual(failedBaselineState.discardPending, false)
  assert.strictEqual(getPendingManualLayoutPageAction(
    failedBaselineState.draftIdentity,
    failedBaselineState.pageId,
    targetB.draftIdentity,
    targetB.pageId,
    failedBaselineState.saveState,
    targetB.draftIdentity,
  ), 'apply-target')
  failedBaselineState = reduceManualLayoutDraft(failedBaselineState, { type: 'page-changed', ...targetB })
  assert.strictEqual(failedBaselineState.draftIdentity, targetB.draftIdentity, 'a successful retry must finally apply the latest retained target')
  assert.strictEqual(failedBaselineState.blocks[0].words, 'B')

  assert.strictEqual(await saveTextEditorPage(async () => true), true, 'a confirmed text-editor write must report success')
  assert.strictEqual(await saveTextEditorPage(async () => false), false, 'a resolved false text-editor write must not report success')
  assert.strictEqual(await saveTextEditorPage(async () => { throw new Error('write failed') }), false, 'a rejected text-editor write must be contained and must not report success')
}

{
  const targetPageId = 'page-target'
  const sourceIdentity = 'project-a/document-a/page-source'
  const targetIdentity = 'project-a/document-a/page-target'
  let pendingTargetIdentity = ''
  assert.strictEqual(
    getPendingManualLayoutPageAction(sourceIdentity, 'page-source', targetIdentity, targetPageId, 'dirty', pendingTargetIdentity),
    'confirm-target',
    'the first dirty page change must request confirmation',
  )
  pendingTargetIdentity = targetIdentity
  assert.strictEqual(
    getPendingManualLayoutPageAction(sourceIdentity, 'page-source', targetIdentity, targetPageId, 'failed', pendingTargetIdentity),
    'wait-for-save',
    'a failed save must retain the original pending target without reopening confirmation',
  )
  assert.strictEqual(
    getPendingManualLayoutPageAction(sourceIdentity, 'page-source', targetIdentity, targetPageId, 'dirty', pendingTargetIdentity),
    'wait-for-save',
    'retrying the retained target must wait for its real save result',
  )
  assert.strictEqual(
    getPendingManualLayoutPageAction(sourceIdentity, 'page-source', targetIdentity, targetPageId, 'clean', pendingTargetIdentity),
    'apply-target',
    'a successful retry must automatically apply the original target page',
  )
  assert.strictEqual(
    getPendingManualLayoutPageAction(targetIdentity, targetPageId, targetIdentity, targetPageId, 'clean', ''),
    'same-page',
    'the applied target must settle as the active draft page',
  )
  assert.strictEqual(
    getPendingManualLayoutPageAction('project-a/document-a/shared-page', 'shared-page', 'project-b/document-b/shared-page', 'shared-page', 'dirty', ''),
    'confirm-target',
    'equal page IDs must not reuse a draft from another project or document identity',
  )

  let sourceDraft = createManualLayoutDraft('page-source', [], sourceIdentity)
  sourceDraft = reduceManualLayoutDraft(sourceDraft, { type: 'create', block: { words: 'pending-save' } })
  sourceDraft = reduceManualLayoutDraft(sourceDraft, { type: 'save-failed', revision: sourceDraft.revision })
  sourceDraft = reduceManualLayoutDraft(sourceDraft, { type: 'retry' })
  sourceDraft = reduceManualLayoutDraft(sourceDraft, { type: 'save-started', revision: sourceDraft.revision })
  sourceDraft = reduceManualLayoutDraft(sourceDraft, {
    type: 'server-ack',
    revision: sourceDraft.revision,
    blocks: sourceDraft.blocks,
  })
  assert.strictEqual(
    getPendingManualLayoutPageAction(sourceDraft.draftIdentity, sourceDraft.pageId, targetIdentity, targetPageId, sourceDraft.saveState, targetIdentity),
    'apply-target',
  )
  const appliedTarget = reduceManualLayoutDraft(sourceDraft, {
    type: 'page-changed',
    pageId: targetPageId,
    draftIdentity: targetIdentity,
    blocks: [{ words: 'target-page' }],
  })
  assert.strictEqual(appliedTarget.pageId, targetPageId, 'failure, retry, and success must finish the original target transition')
  assert.strictEqual(appliedTarget.draftIdentity, targetIdentity)
  assert.strictEqual(appliedTarget.blocks[0].words, 'target-page')
}

{
  const values = new Map()
  let storageReads = 0
  const storage = {
    getItem: (key) => {
      storageReads += 1
      return values.get(key) ?? null
    },
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  const identity = 'project-a/document-a/page-a'
  const pageId = 'page-a'
  let state = createManualLayoutDraft(pageId, [], identity)
  state = reduceManualLayoutDraft(state, { type: 'create', block: { words: 'survives-unmount', label: 'text' } })
  assert.strictEqual(persistManualLayoutDraftSnapshot(storage, state), true, 'dirty edits must synchronously enter durable cache before debounce')
  const readsAfterFirstCommit = storageReads
  const nextTypedState = reduceManualLayoutDraft(state, { type: 'update', blockId: state.activeBlockId, changes: { words: 'survives-unmount!' } })
  assert.strictEqual(persistManualLayoutDraftSnapshot(storage, nextTypedState), true)
  assert.strictEqual(storageReads, readsAfterFirstCommit, 'successive committed edits must reuse the module snapshot cache instead of reparsing the whole page')
  state = nextTypedState
  assert.ok(values.has(getManualLayoutDraftStorageKey(identity)), 'the durable key must include the explicit isolated identity')
  const restored = restoreManualLayoutDraftSnapshot(storage, identity, pageId, [])
  assert.ok(restored, 'remounting the same project/document/page must recover the draft')
  assert.strictEqual(restored.blocks[0].words, 'survives-unmount!', 'remount must recover the latest committed keystroke')
  assert.strictEqual(restored.activeBlockId, state.activeBlockId, 'remount must restore the active manual block')
  assert.strictEqual(restored.revision, state.revision)
  assert.strictEqual(restored.saveState, 'dirty', 'an interrupted dirty or saving draft must resume as saveable work')
  assert.strictEqual(restoreManualLayoutDraftSnapshot(storage, 'project-b/document-a/page-a', pageId, []), null, 'drafts must never cross project identities')
  assert.strictEqual(restoreManualLayoutDraftSnapshot(storage, 'project-a/document-b/page-a', pageId, []), null, 'drafts must never cross document identities')

  const saving = reduceManualLayoutDraft(state, { type: 'save-started', revision: state.revision })
  persistManualLayoutDraftSnapshot(storage, saving)
  assert.strictEqual(restoreManualLayoutDraftSnapshot(storage, identity, pageId, []).saveState, 'dirty', 'an interrupted in-flight save must retry after remount')
  const newerState = reduceManualLayoutDraft(state, { type: 'update', blockId: state.activeBlockId, changes: { words: 'newer-instance' } })
  persistManualLayoutDraftSnapshot(storage, newerState)
  const acknowledged = reduceManualLayoutDraft(saving, { type: 'server-ack', revision: saving.revision, blocks: saving.blocks })
  assert.strictEqual(persistManualLayoutDraftSnapshot(storage, acknowledged), true)
  assert.strictEqual(values.has(getManualLayoutDraftStorageKey(identity)), true, 'an old instance acknowledgement must not clear a newer remounted revision')
  const latestSaving = reduceManualLayoutDraft(newerState, { type: 'save-started', revision: newerState.revision })
  const latestAcknowledged = reduceManualLayoutDraft(latestSaving, { type: 'server-ack', revision: latestSaving.revision, blocks: latestSaving.blocks })
  assert.strictEqual(persistManualLayoutDraftSnapshot(storage, latestAcknowledged), true)
  assert.strictEqual(values.has(getManualLayoutDraftStorageKey(identity)), false, 'a real matching acknowledgement must clear durable cache')

  const failingStorage = {
    getItem: () => { throw new Error('quota read') },
    setItem: () => { throw new Error('quota write') },
    removeItem: () => { throw new Error('quota remove') },
  }
  assert.doesNotThrow(() => persistManualLayoutDraftSnapshot(failingStorage, state), 'storage failures must not break editing')
  assert.strictEqual(persistManualLayoutDraftSnapshot(failingStorage, state), false)
  assert.strictEqual(restoreManualLayoutDraftSnapshot(failingStorage, identity, pageId, []), null)
}

{
  assert.strictEqual(shouldPersistManualLayoutDraftAction({ type: 'set-active', blockId: 'block-a' }), false, 'selection-only changes must not serialize the full page')
  assert.strictEqual(shouldPersistManualLayoutDraftAction({ type: 'preview-replace', blocks: [] }), false, 'drag and resize preview frames must remain memory-only')
  assert.strictEqual(shouldPersistManualLayoutDraftAction({ type: 'update', blockId: 'block-a', changes: { words: 'committed' } }), true, 'typed content must remain synchronously durable')
  assert.strictEqual(shouldPersistManualLayoutDraftAction({ type: 'save-started', revision: 1 }), true, 'save-state transitions must remain durable')

  let clearedTimers = 0
  let persistedOnUnmount = 0
  let flushes = 0
  const dirtyState = reduceManualLayoutDraft(
    createManualLayoutDraft('page-unmount', [], 'project/document/page-unmount'),
    { type: 'create', block: { words: 'last-keystroke' } },
  )
  assert.strictEqual(finalizeManualLayoutDraftOnUnmount(
    dirtyState,
    () => { clearedTimers += 1 },
    () => { persistedOnUnmount += 1 },
    () => { flushes += 1; return Promise.resolve(true) },
  ), true)
  assert.deepStrictEqual({ clearedTimers, persistedOnUnmount, flushes }, { clearedTimers: 1, persistedOnUnmount: 1, flushes: 1 }, 'unmount must synchronously persist before its best-effort async flush')
  const cleanState = createManualLayoutDraft('page-clean', [], 'project/document/page-clean')
  assert.strictEqual(finalizeManualLayoutDraftOnUnmount(cleanState, () => { clearedTimers += 1 }, () => { persistedOnUnmount += 1 }, () => { flushes += 1; return Promise.resolve(true) }), false)
  assert.deepStrictEqual({ clearedTimers, persistedOnUnmount, flushes }, { clearedTimers: 2, persistedOnUnmount: 2, flushes: 1 }, 'clean unmount must not start a redundant save')
}

{
  const values = new Map()
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  const oldIdentity = 'project-a/document-a/page-old'
  const targetIdentity = 'project-a/document-a/page-target'
  const baselineBlocks = [{ ir_block_id: 'old-1', words: 'server-baseline' }]
  let oldDraft = createManualLayoutDraft('page-old', baselineBlocks, oldIdentity)
  const oldBlockId = getManualLayoutDraftBlockId('page-old', oldDraft.blocks[0], 0)
  oldDraft = reduceManualLayoutDraft(oldDraft, { type: 'update', blockId: oldBlockId, changes: { words: 'abandoned-local-edit' } })
  persistManualLayoutDraftSnapshot(storage, oldDraft)
  assert.strictEqual(discardManualLayoutDraftSnapshot(storage, oldIdentity, oldDraft.revision), true)
  const discarded = reduceManualLayoutDraft(oldDraft, { type: 'discard' })
  assert.strictEqual(discarded.blocks[0].words, 'server-baseline', 'discard must reset memory to the latest acknowledged baseline')
  assert.strictEqual(discarded.saveState, 'clean')
  const target = reduceManualLayoutDraft(discarded, { type: 'page-changed', pageId: 'page-target', draftIdentity: targetIdentity, blocks: [{ words: 'target' }] })
  assert.strictEqual(target.draftIdentity, targetIdentity)
  assert.strictEqual(restoreManualLayoutDraftSnapshot(storage, oldIdentity, 'page-old', baselineBlocks), null, 'returning to an explicitly discarded page must not recover abandoned content')

  const currentEpoch = 2
  assert.strictEqual(isManualLayoutSaveEpochCurrent(currentEpoch, 1, target.draftIdentity, oldIdentity), false, 'a late old-page acknowledgement must be ignored after discard-and-change')
  assert.strictEqual(isManualLayoutSaveEpochCurrent(currentEpoch, currentEpoch, target.draftIdentity, targetIdentity), true)
  const targetDirty = reduceManualLayoutDraft(target, { type: 'create', block: { words: 'new-target-edit' } })
  persistManualLayoutDraftSnapshot(storage, targetDirty)
  const oldAck = reduceManualLayoutDraft(oldDraft, { type: 'server-ack', draftIdentity: oldIdentity, revision: oldDraft.revision, blocks: oldDraft.blocks })
  persistManualLayoutDraftSnapshot(storage, oldAck)
  assert.ok(restoreManualLayoutDraftSnapshot(storage, targetIdentity, 'page-target', []).blocks.some((block) => block.words === 'new-target-edit'), 'a late old acknowledgement must not rewrite or clear the new target draft')

  const samePageTargetIdentity = 'project-b/document-b/shared-page'
  let samePageTarget = createManualLayoutDraft('shared-page', [{ ir_block_id: 'shared-1', words: 'new-project' }], samePageTargetIdentity)
  samePageTarget = reduceManualLayoutDraft(samePageTarget, {
    type: 'server-ack',
    draftIdentity: 'project-a/document-a/shared-page',
    pageId: 'shared-page',
    revision: 0,
    blocks: [{ ir_block_id: 'shared-1', words: 'late-old-project' }],
  })
  assert.strictEqual(samePageTarget.blocks[0].words, 'new-project', 'identity guards must reject a late ack even when two projects reuse the same page ID')
}

{
  const blurred = getManualLayoutUnderlayImageStyle({ layoutEditMode: true, altShowsClearUnderlay: false, blur: 65 })
  assert.ok(blurred.filter.includes('blur('), 'normal edit mode must retain the configured blur filter')
  assert.strictEqual(blurred.opacity, 0.52)
  const clear = getManualLayoutUnderlayImageStyle({ layoutEditMode: true, altShowsClearUnderlay: true, blur: 65 })
  assert.deepStrictEqual(clear, { opacity: 1, filter: 'none' }, 'holding Alt must show the fully opaque, unfiltered original underlay')
}

{
  const pageId = 'page-a'
  const original = ensureManualLayoutBlockIdentity(pageId, { ir_block_id: 'ocr-1', words: '\u7532' }, 0)
  const reorderedLegacy = ensureManualLayoutBlockIdentity(pageId, { ir_block_id: 'ocr-1', words: '\u7532' }, 9)
  assert.strictEqual(
    getManualLayoutDraftBlockId(pageId, original, 0),
    getManualLayoutDraftBlockId(pageId, reorderedLegacy, 9),
    'a unique legacy IR identity must survive server-side reordering',
  )
  const state = createManualLayoutDraft(pageId, [original])
  const createdBlock = ensureManualLayoutBlockIdentity(pageId, { words: '', label: 'text' }, 1, true)
  const createdBlockId = getManualLayoutDraftBlockId(pageId, createdBlock, 1)
  const created = reduceManualLayoutDraft(state, { type: 'create', block: createdBlock })
  const echoed = reduceManualLayoutDraft(created, { type: 'server-ack', revision: 0, blocks: [original] })
  assert.strictEqual(echoed.activeBlockId, createdBlockId, 'an old server echo must not close the newly-created block inspector')
  assert.strictEqual(echoed.blocks.length, 2, 'an old server echo must not erase a newly-created local block')
  assert.strictEqual(echoed.revision, 1)
  assert.strictEqual(echoed.acknowledgedRevision, 0)
  assert.strictEqual(echoed.saveState, 'dirty')

  const saving = reduceManualLayoutDraft(created, { type: 'save-started', revision: created.revision })
  const currentAck = reduceManualLayoutDraft(saving, {
    type: 'server-ack',
    revision: created.revision,
    blocks: created.blocks.map((block) => ({ ...block, server_normalized: true })),
  })
  assert.strictEqual(currentAck.acknowledgedRevision, created.revision, 'only the matching revision may become acknowledged')
  assert.strictEqual(currentAck.saveState, 'clean')
  assert.strictEqual(currentAck.activeBlockId, createdBlockId, 'a current acknowledgement must preserve the active inspector')
  assert.ok(currentAck.blocks.some((block) => block.manual_block_id === createdBlock.manual_block_id))

  const updated = reduceManualLayoutDraft(currentAck, {
    type: 'update',
    blockId: createdBlockId,
    changes: { words: '\u4e59' },
  })
  assert.strictEqual(updated.blocks.find((block) => block.manual_block_id === createdBlock.manual_block_id).words, '\u4e59', 'updates must target the stable block ID')
  assert.strictEqual(updated.saveState, 'dirty')

  const staleAck = reduceManualLayoutDraft(updated, {
    type: 'server-ack',
    revision: currentAck.revision,
    blocks: currentAck.blocks,
  })
  assert.strictEqual(staleAck.blocks.find((block) => block.manual_block_id === createdBlock.manual_block_id).words, '\u4e59', 'stale acknowledgements must not roll back newer edits')
  assert.strictEqual(staleAck.saveState, 'dirty')

  const staleFailure = reduceManualLayoutDraft(updated, {
    type: 'save-failed',
    revision: currentAck.revision,
  })
  assert.strictEqual(staleFailure.saveState, 'dirty', 'an older failed save must not strand a newer revision in the failed state')

  const failed = reduceManualLayoutDraft(updated, { type: 'save-failed', revision: updated.revision })
  assert.strictEqual(failed.saveState, 'failed', 'failed saves must retain an explicit retryable state')
  assert.deepStrictEqual(failed.blocks, updated.blocks, 'failed saves must retain the local draft')
  const retrying = reduceManualLayoutDraft(failed, { type: 'retry' })
  assert.strictEqual(retrying.saveState, 'dirty', 'retry must return a failed draft to the save queue')
  assert.deepStrictEqual(getManualLayoutSaveSchedule(retrying, false), { kind: 'debounce', revision: retrying.revision })
  assert.deepStrictEqual(getManualLayoutSaveSchedule(retrying, true), { kind: 'flush', revision: retrying.revision }, 'Ctrl+S must bypass debounce')
  assert.deepStrictEqual(getManualLayoutSaveSchedule(reduceManualLayoutDraft(retrying, { type: 'save-started', revision: retrying.revision }), false), { kind: 'none' }, 'a revision already in flight must not be scheduled twice')

  const rapidFirst = reduceManualLayoutDraft(state, { type: 'update', blockId: getManualLayoutDraftBlockId(pageId, original, 0), changes: { words: '1' } })
  const rapidSecond = reduceManualLayoutDraft(rapidFirst, { type: 'update', blockId: getManualLayoutDraftBlockId(pageId, original, 0), changes: { words: '2' } })
  assert.strictEqual(rapidSecond.revision, rapidFirst.revision + 1, 'rapid edits must create a monotonically newer debounce revision')
  assert.deepStrictEqual(getManualLayoutSaveSchedule(rapidSecond, false), { kind: 'debounce', revision: rapidSecond.revision })

  const queuedRevision = rapidSecond.revision
  const previewTransition = createManualLayoutPreviewTransition(rapidSecond, [{ ...rapidSecond.blocks[0], location: { left: 1, top: 2, width: 3, height: 4 } }])
  assert.strictEqual(previewTransition.committedState, rapidSecond, 'preview must retain the exact committed dirty state and its armed 450ms save')
  assert.strictEqual(previewTransition.committedState.revision, queuedRevision)
  assert.deepStrictEqual(previewTransition.saveSchedule, { kind: 'debounce', revision: queuedRevision })
  const cancelledPreview = createManualLayoutPreviewTransition(previewTransition.committedState, rapidSecond.blocks)
  assert.strictEqual(cancelledPreview.committedState, rapidSecond, 'cancel/lostcapture without a commit must not replace the dirty committed state')
  let autoSaved = reduceManualLayoutDraft(cancelledPreview.committedState, { type: 'save-started', revision: queuedRevision })
  autoSaved = reduceManualLayoutDraft(autoSaved, { type: 'server-ack', revision: queuedRevision, blocks: autoSaved.blocks })
  assert.strictEqual(autoSaved.saveState, 'clean', 'the originally queued dirty revision must still automatically settle clean after preview cancellation')
  const previewCommitted = reduceManualLayoutDraft(rapidSecond, {
    type: 'replace',
    blocks: previewTransition.previewBlocks,
    activeBlockId: rapidSecond.activeBlockId,
  })
  assert.strictEqual(previewCommitted.revision, queuedRevision + 1, 'pointerup preview commit must create exactly one new revision')

  const deleted = reduceManualLayoutDraft(updated, { type: 'delete', blockId: createdBlockId })
  assert.strictEqual(deleted.activeBlockId, null, 'deleting the active block must close its inspector')
  assert.strictEqual(deleted.blocks.length, 1)

  const samePageEcho = reduceManualLayoutDraft(updated, { type: 'server-echo', pageId, blocks: [original] })
  assert.strictEqual(samePageEcho.activeBlockId, createdBlockId, 'same-page echoes must not clear selection')
  assert.strictEqual(samePageEcho.blocks.length, 2, 'same-page echoes must merge without dropping dirty local blocks')

  const changedPage = reduceManualLayoutDraft(currentAck, { type: 'page-changed', pageId: 'page-b', blocks: [] })
  assert.strictEqual(changedPage.pageId, 'page-b')
  assert.deepStrictEqual(changedPage.blocks, [], 'a confirmed page identity change must load even an empty page')
  assert.strictEqual(changedPage.activeBlockId, null)
  assert.strictEqual(changedPage.saveState, 'clean')
}

assert.deepStrictEqual(
  parseFacsimileTableClipboard('\u7532\t\u4e59\n\u4e19\t\u4e01'),
  [['\u7532', '\u4e59'], ['\u4e19', '\u4e01']],
  'plain text clipboard data must preserve TSV rows and columns',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard('\u7532\t\u4e59\r\n\u4e19\t\r\n'),
  [['\u7532', '\u4e59'], ['\u4e19', ''], ['', '']],
  'CRLF, trailing empty cells, and a trailing empty row must be preserved',
)
assert.deepStrictEqual(parseFacsimileTableClipboard(''), [], 'an empty clipboard must not create a phantom cell')
assert.deepStrictEqual(parseFacsimileTableClipboard(null), [], 'malformed clipboard input must safely produce no cells')
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table><tr><td>\u7532&amp;\u4e59</td><td>\u4e19<br>\u4e01</td></tr><tr><th>&lt;\u620a&gt;</th><td>&nbsp;</td></tr></table>',
  }),
  [['\u7532&\u4e59', '\u4e19\n\u4e01'], ['<\u620a>', ' ']],
  'HTML table clipboard data must decode common entities and preserve line breaks without a DOM',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<TABLE><TR><TD>A<br>B<br/>C<br class="x">D<BR style="display:block">E</TD></TR></TABLE>',
  }),
  [['A\nB\nC\nD\nE']],
  'all valid BR forms, including attributes and uppercase tags, must become line breaks',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table data-label="outer>value"><tr data-row=\'left>right\'><td title="x>y">A<br title="a>b">B</td><th data-x=\'a>b\'>C<br data-x=\'c>d\'/>D</th></tr></table>',
  }),
  [['A\nB', 'C\nD']],
  'quoted greater-than signs in double- and single-quoted table, row, cell, and BR attributes must not leak into cell text',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table><tr><td title="unterminated>A</td></tr></table>',
    text: 'safe\tfallback',
  }),
  [['safe', 'fallback']],
  'malformed HTML with an unclosed attribute quote must safely fall back to plain text',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table><tr><td>&copy;&reg;&trade;&mdash;&ndash;&hellip;&nbsp;&quot;&apos;&amp;&lt;&gt;&#30002;&#x4E59;</td></tr></table>',
  }),
  [['\u00a9\u00ae\u2122\u2014\u2013\u2026 "\'&<>\u7532\u4e59']],
  'HTML clipboard parsing must decode common named, decimal, and hexadecimal entities',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({ html: '<table><tr><td>&bogus; &copy &#x110000;</td></tr></table>' }),
  [['&bogus; &copy &#x110000;']],
  'unknown and malformed entities must be preserved verbatim',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({ html: '<table><tr><td>&middot;&emsp;&ensp;&not-in-the-list;</td></tr></table>' }),
  [['\u00b7\u2003\u2002&not-in-the-list;']],
  'common spacing entities must decode while unknown named entities remain verbatim',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({ html: '<div>not a table</div>', text: 'fallback\tvalue' }),
  [['fallback', 'value']],
  'malformed or irrelevant HTML must safely fall back to plain text',
)

const rowspanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>',
})
assert.deepStrictEqual(rowspanClipboard.rows, [['A', 'B'], ['', 'C']], 'rowspan must reserve its covered column on following rows')
assert.deepStrictEqual(rowspanClipboard.merges, [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }], 'rowspan must be exposed as merge metadata')
assert.strictEqual(rowspanClipboard.source, 'html')
assert.strictEqual(rowspanClipboard.truncated, false)

const colspanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><td colspan="2">A</td><td>B</td></tr></table>',
})
assert.deepStrictEqual(colspanClipboard.rows, [['A', '', 'B']], 'colspan must reserve covered columns in the current row')
assert.deepStrictEqual(colspanClipboard.merges, [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }])

const combinedSpanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><th rowspan="2" colspan="2">A</th><td>B</td></tr><tr><td>C</td></tr></table>',
})
assert.deepStrictEqual(combinedSpanClipboard.rows, [['A', '', 'B'], ['', '', 'C']], 'combined row and column spans must build a rectangular placeholder grid')
assert.deepStrictEqual(combinedSpanClipboard.merges, [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }], 'combined spans must retain their normalized merge range')

const maliciousSpanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><td rowspan="999999999999999999" colspan="999999999999999999">A</td></tr></table>',
})
assert.strictEqual(maliciousSpanClipboard.truncated, true, 'malicious spans must be clamped and reported instead of expanding without bound')
assert.ok(maliciousSpanClipboard.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
assert.ok((maliciousSpanClipboard.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_COLUMNS)
assert.ok(maliciousSpanClipboard.rows.length * (maliciousSpanClipboard.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_CELLS)

{
  const veryTallRows = Array.from({ length: 130_000 }, () => ['x'])
  assert.doesNotThrow(() => normalizeFacsimileTableRows(veryTallRows, 0, 0), 'normalizing 130,000 rows must not spread into Math.max arguments')
  const veryTallText = `${'x\n'.repeat(130_000)}tail`
  const parsed = parseFacsimileTableClipboardData(veryTallText)
  assert.strictEqual(parsed.source, 'text')
  assert.strictEqual(parsed.truncated, true, 'large text clipboard input must report its budget truncation')
  assert.ok(parsed.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
  assert.ok(parsed.rows.length * (parsed.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_CELLS)
}

{
  const htmlUnit = '<tr><td data-note="x>y">value</td></tr>'
  const largeHtml = `<table>${htmlUnit.repeat(Math.ceil(2_400_000 / htmlUnit.length))}<td title="unclosed`
  assert.ok(Buffer.byteLength(largeHtml) >= 2_400_000, 'large HTML fixture must exercise a multi-megabyte clipboard')
  const heapBefore = process.memoryUsage().heapUsed
  const startedAt = process.hrtime.bigint()
  const parsed = parseFacsimileTableClipboardData({ html: largeHtml })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore
  assert.strictEqual(parsed.truncated, true)
  assert.strictEqual(parsed.source, 'html', 'the parser must stop at its budget instead of tokenizing a malformed tail')
  assert.ok(parsed.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
  assert.ok(parsed.rows.length * (parsed.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_CELLS)
  assert.ok(elapsedMs < 10_000, `streaming HTML parsing took an unexpectedly long ${elapsedMs.toFixed(1)}ms`)
  assert.ok(heapGrowth < 128 * 1024 * 1024, `streaming HTML parsing retained an unexpected ${Math.round(heapGrowth / 1024 / 1024)}MB`)
}

const rows = normalizeFacsimileTableRows([['甲', '乙'], ['丙', '丁']])
const selection = getFacsimileTableSelection({ row: 1, col: 1 }, { row: 0, col: 0 })
assert.deepStrictEqual(selection, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 }, 'Shift selection must normalize into a rectangular range')
assert.deepStrictEqual(
  normalizeFacsimileTableSelection({ row: 9, col: -4 }, { row: 1, col: 6 }, 4, 5),
  { startRow: 1, endRow: 3, startCol: 0, endCol: 4 },
  'drag selection must normalize direction and clamp to table bounds',
)
assert.deepStrictEqual(
  normalizeFacsimileTableSelection({ row: Number.NaN, col: Number.POSITIVE_INFINITY }, { row: -1, col: -1 }, 0, 0),
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  'invalid coordinates and empty dimensions must degrade to a stable origin selection',
)
assert.deepStrictEqual(
  getFacsimileTableWholeRowSelection(2, 0, 3, 4),
  { startRow: 0, endRow: 2, startCol: 0, endCol: 3 },
  'row headers must select complete rows across every column',
)
assert.deepStrictEqual(
  getFacsimileTableWholeColumnSelection(3, 1, 4, 4),
  { startRow: 0, endRow: 3, startCol: 1, endCol: 3 },
  'column headers must select complete columns across every row',
)

const merged = mergeFacsimileTableSelection(rows, [], selection)
assert.deepStrictEqual(merged.merges, [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }], 'visual table editor must create a real 2x2 merged cell')
assert.strictEqual(merged.rows[0][0], '甲\n乙\n丙\n丁', 'merging cells must preserve every cell value in reading order')
assert.strictEqual(buildFacsimileTableCells(merged.rows, merged.merges).length, 1, 'covered merged cells must not be serialized as duplicate cells')
assert.deepStrictEqual(
  buildFacsimileTableCells(merged.rows, merged.merges)[0],
  { row: 0, col: 0, text: '甲\n乙\n丙\n丁', rowSpan: 2, colSpan: 2, row_span: 2, col_span: 2 },
  'saved OCR cells must preserve rowSpan and colSpan for later rendering',
)

const inserted = insertFacsimileTableRow(merged.rows, merged.merges, 1)
assert.strictEqual(inserted.rows.length, 3, 'row insertion must update the visible grid')
assert.strictEqual(inserted.merges[0].rowSpan, 3, 'inserting inside a merged range must expand the merged cell')
const split = splitFacsimileTableCell(inserted.rows, inserted.merges, { row: 2, col: 1 })
assert.strictEqual(split.merges.length, 0, 'split must work when the selected coordinate is a covered merged cell')

const cleared = clearFacsimileTableSelection(
  [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }, { row: 2, col: 0, rowSpan: 1, colSpan: 2 }],
  { startRow: 0, endRow: 1, startCol: 1, endCol: 2 },
)
assert.deepStrictEqual(
  cleared.rows,
  [['1', '', ''], ['4', '', ''], ['7', '8', '9']],
  'clearing a multi-cell selection must clear every selected cell',
)
assert.deepStrictEqual(
  cleared.merges,
  [{ row: 2, col: 0, rowSpan: 1, colSpan: 2 }],
  'clearing through a merged range must remove only intersecting merges',
)

const pasteRows = [['origin', 'value']]
const pasted = pasteFacsimileTableRange(
  pasteRows,
  [],
  { row: 3, col: 4 },
  [['\u7532', '\u4e59'], ['\u4e19', '\u4e01']],
)
assert.strictEqual(pasted.rows.length, 5)
assert.strictEqual(pasted.rows[0].length, 6)
assert.strictEqual(pasted.rows[4][5], '\u4e01')
assert.deepStrictEqual(pasteRows, [['origin', 'value']], 'range paste must not mutate caller-owned rows')

const pastedAcrossMerge = pasteFacsimileTableRange(
  [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }, { row: 2, col: 1, rowSpan: 1, colSpan: 2 }],
  { row: 1, col: 1 },
  [['x', 'y']],
)
assert.deepStrictEqual(
  pastedAcrossMerge.merges,
  [{ row: 2, col: 1, rowSpan: 1, colSpan: 2 }],
  'pasting through a merged range must remove the intersecting merge without disturbing separate merges',
)
const pastedClipboardMerge = pasteFacsimileTableRange(
  [['0:0', '0:1', '0:2', '0:3'], ['1:0', '1:1', '1:2', '1:3'], ['2:0', '2:1', '2:2', '2:3'], ['3:0', '3:1', '3:2', '3:3']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }, { row: 3, col: 2, rowSpan: 1, colSpan: 2 }],
  { row: 1, col: 1 },
  [['A', ''], ['C', 'D']],
  [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }],
)
assert.deepStrictEqual(
  pastedClipboardMerge.merges,
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }, { row: 3, col: 2, rowSpan: 1, colSpan: 2 }],
  'clipboard merges must offset from the paste origin while replacing only conflicting target merges',
)
assert.strictEqual(pastedClipboardMerge.truncated, false)

{
  const largeMatrix = Array.from(
    { length: FACSIMILE_TABLE_MAX_ROWS + 10 },
    () => Array(FACSIMILE_TABLE_MAX_COLUMNS + 10).fill('x'),
  )
  const heapBefore = process.memoryUsage().heapUsed
  const rejected = pasteFacsimileTableRange([['base']], [], { row: Number.MAX_SAFE_INTEGER, col: Number.MAX_SAFE_INTEGER }, largeMatrix)
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore
  assert.deepStrictEqual(rejected.rows, [['base']], 'huge paste origins must not allocate a sparse or giant grid')
  assert.strictEqual(rejected.truncated, true, 'a paste rejected by its origin budget must be reported')
  assert.ok(heapGrowth < 64 * 1024 * 1024, `rejected paste retained an unexpected ${Math.round(heapGrowth / 1024 / 1024)}MB`)

  const bounded = pasteFacsimileTableRange([['base']], [], { row: 0, col: 0 }, largeMatrix)
  assert.strictEqual(bounded.truncated, true, 'large paste matrices must report truncation')
  assert.ok(bounded.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
  assert.ok(bounded.rows[0].length <= FACSIMILE_TABLE_MAX_COLUMNS)
  assert.ok(bounded.rows.length * bounded.rows[0].length <= FACSIMILE_TABLE_MAX_CELLS)

  const tallBase = Array.from({ length: FACSIMILE_TABLE_MAX_ROWS }, () => ['base'])
  const farColumn = pasteFacsimileTableRange(
    tallBase,
    [],
    { row: 0, col: FACSIMILE_TABLE_MAX_COLUMNS - 1 },
    [['x']],
  )
  assert.strictEqual(farColumn.truncated, true, 'base dimensions must participate in the final paste cell budget')
  assert.ok(farColumn.rows.length * farColumn.rows[0].length <= FACSIMILE_TABLE_MAX_CELLS)
  assert.strictEqual(farColumn.rows[0][0], 'base', 'a paste that cannot fit beside a tall base table must preserve existing data')
}
assert.deepStrictEqual(
  pasteFacsimileTableRange([['a']], [], { row: -5, col: Number.NaN }, [['x']]).rows,
  [['x']],
  'invalid paste coordinates must be clamped to the table origin',
)
assert.deepStrictEqual(
  pasteFacsimileTableRange([['a']], [], { row: 0, col: 0 }, []).rows,
  [['a']],
  'empty paste data must leave the table unchanged',
)

const structuralRows = Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, col) => `${row}:${col}`))
const structuralMerge = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }]
const rowInserted = insertFacsimileTableRow(structuralRows, structuralMerge, 2)
assert.deepStrictEqual(rowInserted.merges, [{ row: 1, col: 1, rowSpan: 3, colSpan: 2 }], 'row insertion inside a merge must expand rowSpan')
const columnInserted = insertFacsimileTableColumn(structuralRows, structuralMerge, 2)
assert.deepStrictEqual(columnInserted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 3 }], 'column insertion inside a merge must expand colSpan')
assert.deepStrictEqual(
  insertFacsimileTableRow(structuralRows, structuralMerge, 0).merges,
  [{ row: 2, col: 1, rowSpan: 2, colSpan: 2 }],
  'inserting a row before a merge must move its anchor without changing rowSpan',
)
assert.deepStrictEqual(
  insertFacsimileTableColumn(structuralRows, structuralMerge, 0).merges,
  [{ row: 1, col: 2, rowSpan: 2, colSpan: 2 }],
  'inserting a column before a merge must move its anchor without changing colSpan',
)
const rowDeleted = deleteFacsimileTableRow(structuralRows, [{ row: 1, col: 1, rowSpan: 3, colSpan: 2 }], 1)
assert.deepStrictEqual(rowDeleted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }], 'deleting the first row of a merge must retain a normalized anchor and rowSpan')
const columnDeleted = deleteFacsimileTableColumn(structuralRows, [{ row: 1, col: 1, rowSpan: 2, colSpan: 3 }], 1)
assert.deepStrictEqual(columnDeleted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }], 'deleting the first column of a merge must retain a normalized anchor and colSpan')
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, structuralMerge, 0).merges,
  [{ row: 0, col: 1, rowSpan: 2, colSpan: 2 }],
  'deleting a row before a merge must shift its anchor toward the origin',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, structuralMerge, 0).merges,
  [{ row: 1, col: 0, rowSpan: 2, colSpan: 2 }],
  'deleting a column before a merge must shift its anchor toward the origin',
)
const rowAxisMerge = [{ row: 1, col: 1, rowSpan: 3, colSpan: 2 }]
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 0).merges,
  [{ row: 0, col: 1, rowSpan: 3, colSpan: 2 }],
  'row deletion before a merge must shift its row anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 1).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'row deletion at a merge anchor must shrink rowSpan and retain the anchor coordinate',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 2).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'row deletion inside a merge must shrink rowSpan without moving its anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 4).merges,
  rowAxisMerge,
  'row deletion after a merge must leave its geometry unchanged',
)
const columnAxisMerge = [{ row: 1, col: 1, rowSpan: 2, colSpan: 3 }]
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 0).merges,
  [{ row: 1, col: 0, rowSpan: 2, colSpan: 3 }],
  'column deletion before a merge must shift its column anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 1).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'column deletion at a merge anchor must shrink colSpan and retain the anchor coordinate',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 2).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'column deletion inside a merge must shrink colSpan without moving its anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 4).merges,
  columnAxisMerge,
  'column deletion after a merge must leave its geometry unchanged',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, [{ row: 1, col: 1, rowSpan: 1, colSpan: 3 }], 1).merges,
  [],
  'deleting the only row occupied by a horizontal merge must remove that merge',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, [{ row: 1, col: 1, rowSpan: 3, colSpan: 1 }], 1).merges,
  [],
  'deleting the only column occupied by a vertical merge must remove that merge',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }], 1).merges,
  [],
  'deleting a row that collapses a merge to one cell must remove the redundant merge',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }], 1).merges,
  [],
  'deleting a column that collapses a merge to one cell must remove the redundant merge',
)

const rowAnchorDeleted = deleteFacsimileTableRow(
  [
    ['r0c0', 'r0c1', 'r0c2'],
    ['r1c0', 'ANCHOR', 'HIDDEN-1'],
    ['r2c0', 'COVERED', 'HIDDEN-2'],
    ['r3c0', 'AFTER', 'AFTER-HIDDEN'],
  ],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  1,
)
assert.strictEqual(rowAnchorDeleted.rows[1][1], 'ANCHOR', 'row deletion must preserve the merge anchor over stale covered-cell text')
assert.deepStrictEqual(rowAnchorDeleted.merges, [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }])
const rowAnchorCollapsed = deleteFacsimileTableRow(
  [['before', 'before'], ['deleted', 'ANCHOR'], ['survivor', 'COVERED']],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }],
  1,
)
assert.strictEqual(rowAnchorCollapsed.rows[1][1], 'ANCHOR', 'a merge collapsing to one cell after row deletion must preserve its anchor text')
assert.deepStrictEqual(rowAnchorCollapsed.merges, [])
const fullMergeRowDeleted = deleteFacsimileTableRow(
  [['before', 'BEFORE', 'x'], ['deleted', 'ANCHOR', 'hidden'], ['after', 'UNCHANGED', 'y']],
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }],
  1,
)
assert.strictEqual(fullMergeRowDeleted.rows[1][1], 'UNCHANGED', 'a fully deleted merge must not move its anchor text into an unrelated row')
assert.deepStrictEqual(fullMergeRowDeleted.merges, [])

const columnAnchorDeleted = deleteFacsimileTableColumn(
  [
    ['r0c0', 'r0c1', 'r0c2', 'r0c3'],
    ['r1c0', 'ANCHOR', 'COVERED', 'r1c3'],
    ['r2c0', 'HIDDEN-1', 'HIDDEN-2', 'r2c3'],
  ],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  1,
)
assert.strictEqual(columnAnchorDeleted.rows[1][1], 'ANCHOR', 'column deletion must preserve the merge anchor over stale covered-cell text')
assert.deepStrictEqual(columnAnchorDeleted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }])
const columnAnchorCollapsed = deleteFacsimileTableColumn(
  [['before', 'before', 'after'], ['row', 'ANCHOR', 'COVERED']],
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }],
  1,
)
assert.strictEqual(columnAnchorCollapsed.rows[1][1], 'ANCHOR', 'a merge collapsing to one cell after column deletion must preserve its anchor text')
assert.deepStrictEqual(columnAnchorCollapsed.merges, [])
const fullMergeColumnDeleted = deleteFacsimileTableColumn(
  [['before', 'deleted', 'after'], ['row', 'ANCHOR', 'UNCHANGED'], ['row2', 'hidden', 'still-here']],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }],
  1,
)
assert.strictEqual(fullMergeColumnDeleted.rows[1][1], 'UNCHANGED', 'a fully deleted merge must not move its anchor text into an unrelated column')
assert.deepStrictEqual(fullMergeColumnDeleted.merges, [])
assert.deepStrictEqual(
  normalizeFacsimileTableMerges([
    { row: 0, col: 0, rowSpan: 3, colSpan: 3 },
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
    { row: 3, col: 3, rowSpan: 9, colSpan: 9 },
    { row: 99, col: 99, rowSpan: 2, colSpan: 2 },
  ], 4, 4),
  [{ row: 0, col: 0, rowSpan: 3, colSpan: 3 }],
  'merge normalization must remove overlaps, one-cell remnants, and out-of-bounds ranges',
)
assert.deepStrictEqual(
  normalizeFacsimileTableMerges([
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
    { row: 0, col: 0, rowSpan: 3, colSpan: 3 },
  ], 4, 4),
  [{ row: 0, col: 0, rowSpan: 3, colSpan: 3 }],
  'overlapping malformed merges must use stable coordinate ordering rather than caller order',
)

assert.deepStrictEqual(
  normalizeFacsimileTableRowHeights([12, 50, 999], 5),
  [FACSIMILE_TABLE_MIN_ROW_HEIGHT, 50, FACSIMILE_TABLE_MAX_ROW_HEIGHT, FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT, FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT],
  'row height metadata must clamp values and fill missing entries with defaults',
)
assert.deepStrictEqual(
  normalizeFacsimileTableColumnWidths([1, 200, 9999], 5),
  [FACSIMILE_TABLE_MIN_COLUMN_WIDTH, 200, FACSIMILE_TABLE_MAX_COLUMN_WIDTH, FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH, FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH],
  'column width metadata must clamp values and fill missing entries with defaults',
)
assert.deepStrictEqual(
  normalizeFacsimileTableRowHeights(['invalid', undefined], 2),
  [FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT, FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT],
  'invalid row heights must fall back to the default instead of throwing',
)
assert.deepStrictEqual(normalizeFacsimileTableColumnWidths([], -3), [], 'invalid metadata lengths must safely normalize to an empty list')

const proofreader = fs.readFileSync(path.join(root, 'src/renderer/src/components/GujiFacsimileProofreader.tsx'), 'utf8')
assert.ok(proofreader.includes('onPointerDown={handlePageLayoutPointerDown}'), 'blank page dragging must create a typed manual box')
assert.ok(proofreader.includes('BLOCK_RESIZE_HANDLES.map'), 'the active text box must expose edge and corner resize handles')
assert.ok(proofreader.includes('setImageUnderlayMode(preparation.imageUnderlayMode)'), 'entering manual editing must automatically enable the page image underlay through the shared plan')
assert.ok(proofreader.includes("segmentation_source: 'manual'"), 'manual text, table, and geometry edits must be marked as manual data')
assert.ok(proofreader.includes('<ManualBlockInspector'), 'recognized tables must reach the visual grid through the docked inspector')
assert.ok(proofreader.includes("String(block.segmentation_source || '').toLowerCase() !== 'manual'"), 'manual tables must not be converted back into pseudo text tables on vertical pages')
assert.ok(proofreader.includes('useManualLayoutDraft({'), 'the proofreader must keep page edits in the revisioned local draft')
assert.ok(proofreader.includes('await Promise.resolve(onSave('), 'both synchronous saves and rejected async saves must use one awaited contract')
assert.ok(proofreader.includes('manualLayoutDraft.createBlock(nextBlock)'), 'a new stable block must enter the draft before its debounced save')
assert.ok(proofreader.includes('manualLayoutDraft.receiveServerEcho(pageId, incomingBlocks)'), 'same-page parent echoes must reconcile through the draft reducer')
assert.ok(proofreader.includes('manualLayoutDraft.setActiveBlockId(targetBlockId)'), 'the editor selection must use stable block identity rather than an array index')
assert.ok(proofreader.includes('const enterLayoutEditForBlock = useCallback('), 'all block edit affordances must atomically enter mode through one callback')
assert.ok(!proofreader.includes('const beginEditBlock = useCallback('), 'a partial edit entry callback must not leave editing state without the toolbar and inspector')
assert.ok(proofreader.includes('const editingBlockId = layoutEditMode ? manualLayoutDraft.state.activeBlockId : null'), 'stable selection must not expose an editing state while its toolbar and inspector are hidden')
assert.ok(proofreader.includes('enterLayoutEditForBlock()'), 'the main edit-mode button must reuse the same preparation path')
assert.ok((proofreader.match(/enterLayoutEditForBlock\(sourceIndex\)/g) || []).length >= 3, 'button, menu and double-click block affordances must all enter through the unified callback')
assert.ok(proofreader.includes('manualLayoutDraft.updateBlock(editingBlockId,'), 'text and table editor changes must enter the revisioned draft before debounce')
assert.ok(proofreader.includes('block={editingBlock}'), 'opening an existing block must keep the stable selected draft in the docked inspector')
assert.ok(proofreader.includes('onDeselect={resetBlockEditor}'), 'closing the docked inspector must clear selection without discarding the revisioned draft')
assert.ok(!proofreader.includes('setEditingIndex('), 'server echoes must not clear an index-based editor selection')
assert.ok(proofreader.includes("? '保存失败'"), 'the draft save failure must be visible in the toolbar')
assert.ok(proofreader.includes('onClick={manualLayoutDraft.retry}'), 'failed drafts must expose a retry control')
assert.ok(proofreader.includes("event.key.toLowerCase() !== 's'"), 'Ctrl+S must flush the current draft without waiting for debounce')
assert.ok(proofreader.includes("event.key === 'Alt'"), 'Alt must temporarily reveal the clear underlay even while an input is focused')
assert.ok(proofreader.includes('getManualLayoutUnderlayImageStyle({'), 'Alt preview must derive render-only styles without mutating the stored blur slider value')
assert.ok(!proofreader.includes("filter: layoutEditMode ? 'none'"), 'layout editing must retain the configured underlay blur')
assert.ok(proofreader.includes('return stored == null ? 65'), 'a user without a stored blur preference must receive the 65 recommendation')
assert.ok(proofreader.includes("title: '当前页还有未保存的版式修改'"), 'page identity changes must confirm before discarding an unsaved draft')
assert.ok(proofreader.includes('manualLayoutDraft.state.saveState,'), 'page-change reconciliation must rerun when retry changes the save state')
assert.ok(proofreader.includes('manualLayoutDraft.changePage(pageId, draftIdentity, incomingBlocks)'), 'page changes must restore only the explicitly isolated target draft')
assert.ok(proofreader.includes("title: '保存版式修改后退出？'"), 'leaving layout mode must protect dirty and failed drafts')
assert.ok(proofreader.includes('const { __rect, __synthetic, __sourceIndex, __manualDraftId, ...rest } = block'), 'renderer-only draft IDs must not leak into persisted OCR payloads')
assert.ok(proofreader.includes('if (!words && !isImage && !isManualBlock) return null'), 'an empty newly-created manual block must survive the parent save echo')

assert.ok(draftHelperSource.includes('persistManualLayoutDraftSnapshot(storageRef.current, stateRef.current)'), 'every draft action must synchronously update durable cache before React can unmount')
assert.ok(draftHelperSource.includes('finalizeManualLayoutDraftOnUnmount('), 'unmount must execute the tested synchronous-persist and best-effort-flush helper')
assert.ok(draftHelperSource.includes('createManualLayoutPreviewTransition(stateRef.current, nextBlocks)'), 'drag and resize preview frames must remain separate from the committed draft state')
const previewCallbackStart = draftHelperSource.indexOf('const previewBlocks = useCallback(')
const previewCallbackEnd = draftHelperSource.indexOf('const setActiveBlockId', previewCallbackStart)
assert.ok(previewCallbackStart >= 0 && previewCallbackEnd > previewCallbackStart)
assert.ok(!draftHelperSource.slice(previewCallbackStart, previewCallbackEnd).includes('clearSaveTimer'), 'preview and preview rollback must never cancel an already armed committed-revision save')
const clearPreviewStart = draftHelperSource.indexOf('const clearPreview = useCallback(')
assert.ok(clearPreviewStart > previewCallbackStart)
assert.ok(!draftHelperSource.slice(clearPreviewStart, previewCallbackEnd).includes('clearSaveTimer'), 'clearing a visual preview must not alter the committed revision save schedule')
assert.ok(proofreader.includes('manualLayoutDraft.discardAndChangePage(pageId, draftIdentity, incomingBlocks)'), 'the destructive page-change choice must explicitly discard the old draft before applying its target')
assert.ok(proofreader.includes('const layoutEditingLocked = manualLayoutDraft.state.discardPending'), 'the proofreader UI must derive its mutation lock from discard compensation state')
assert.ok(proofreader.includes("pointerEvents: layoutEditingLocked ? 'none'"), 'the layout canvas and inspector must block pointer mutations during discard compensation')
assert.ok(proofreader.includes('disabled={layoutEditingLocked}'), 'focused text editing controls must be disabled while discard compensation is pending')
assert.ok(draftHelperSource.includes('if (current.discardPending && isManualLayoutContentMutationAction(action)) return'), 'the hook boundary must reject every content mutation while discard compensation is pending')
assert.ok(draftHelperSource.includes('const compensationSnapshot = getManualLayoutDiscardCompensationSnapshot(discardedState)'), 'a failed compensation retry must reuse its fixed revision instead of bypassing the baseline write')
assert.ok(draftHelperSource.includes('discardQueueRef.current = createManualLayoutDiscardQueue('), 'all repeated discard requests must pass through one persistent serialized queue')

const documentView = fs.readFileSync(path.join(root, 'src/renderer/src/views/DocumentView.tsx'), 'utf8')
const textEditor = fs.readFileSync(path.join(root, 'src/renderer/src/components/TextEditor.tsx'), 'utf8')
assert.ok(documentView.includes('const handleSavePage = async (pageId: string, data: PageUpdatePayload): Promise<boolean>'), 'the shared page save path must report its real success outcome without rejecting legacy fire-and-forget callers')
assert.ok(documentView.includes("if (!saved) throw new Error('Facsimile page save failed')"), 'the facsimile-only adapter must convert a swallowed database failure into a rejected draft save')
assert.ok(documentView.includes('onSave={handleSaveFacsimilePage}'), 'the revisioned facsimile draft must receive the failure-propagating adapter')
assert.ok(documentView.includes('onSave={handleSavePage}'), 'the text editor must receive the real boolean save outcome')
assert.ok(documentView.includes("draftIdentity={`${doc?.library_project_id || 'unknown-project'}/${doc?.id || documentId}/${currentPage?.id || 'unknown-page'}`}"), 'draft storage identity must isolate project, document, and page')
assert.ok(documentView.includes('if (!saved) return'), 'proof status actions must not display success after a failed page write')
assert.ok(textEditor.includes('onSave: (pageId: string, data: PageUpdatePayload) => Promise<boolean>'), 'the text editor callback must expose the real async database outcome')
assert.ok(textEditor.includes('const saved = await saveToDb(nextData)'), 'text-block deletion must await the real database outcome')
assert.ok(textEditor.includes("if (saved) message.success('已删除文本块并写入数据库')"), 'text-block deletion must announce success only after a confirmed write')
assert.ok(!textEditor.includes("saveToDb(nextData)\n        message.success('已删除文本块并写入数据库')"), 'text-block deletion must not fire an unconditional success message')

const tableEditorPath = path.join(root, 'src/renderer/src/components/FacsimileTableEditor.tsx')
const tableEditorCssPath = path.join(root, 'src/renderer/src/components/FacsimileTableEditor.css')
const tableEditor = fs.readFileSync(tableEditorPath, 'utf8')
assert.ok(fs.existsSync(tableEditorCssPath), 'the Excel-style table editor must have theme-aware component styles')
const tableEditorCss = fs.readFileSync(tableEditorCssPath, 'utf8')

const transpiledTableEditor = ts.transpileModule(tableEditor, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText
const tableEditorModule = { exports: {} }
const tableEditorRequire = (request) => {
  if (request === 'react') return {}
  if (request === 'react/jsx-runtime') return { Fragment: Symbol('Fragment'), jsx: () => null, jsxs: () => null }
  if (request === 'antd') return { Button: () => null, Tooltip: () => null, message: {}, theme: {} }
  if (request === '../utils/facsimileTableEditing') return helperModule.exports
  if (request === './FacsimileTableEditor.css') return {}
  throw new Error(`Unexpected FacsimileTableEditor dependency: ${request}`)
}
new Function('exports', 'module', 'require', transpiledTableEditor)(
  tableEditorModule.exports,
  tableEditorModule,
  tableEditorRequire,
)
const {
  applyFacsimileTableClipboardCommand,
  applyFacsimileTableSelectionCommand,
  applyFacsimileTableStructureCommand,
  attachFacsimileTableContextMenuEscapeListener,
  attachFacsimileTableResizeListeners,
  buildFacsimileTableCellMergeLookup,
  canHandleFacsimileTableInteraction,
  clampFacsimileTableContextMenuPosition,
  createFacsimileTableCellContextSelection,
  createFacsimileTableHeaderContextSelection,
  createFacsimileTableThemeStyle,
  expandFacsimileTableSelectionForMerges,
  getFacsimileTableEditorKeyIntent,
  getFacsimileTableCommandAvailability,
  reconcileFacsimileTableEditorIdentity,
  reduceFacsimileTableHistory,
  resolveFacsimileTableCellContextSelection,
  serializeFacsimileTableSelectionForClipboard,
  serializeFacsimileTableSelectionAsTsv,
} = tableEditorModule.exports

for (const [name, value] of Object.entries({
  applyFacsimileTableClipboardCommand,
  applyFacsimileTableSelectionCommand,
  applyFacsimileTableStructureCommand,
  attachFacsimileTableContextMenuEscapeListener,
  attachFacsimileTableResizeListeners,
  buildFacsimileTableCellMergeLookup,
  canHandleFacsimileTableInteraction,
  clampFacsimileTableContextMenuPosition,
  createFacsimileTableCellContextSelection,
  createFacsimileTableHeaderContextSelection,
  createFacsimileTableThemeStyle,
  expandFacsimileTableSelectionForMerges,
  getFacsimileTableEditorKeyIntent,
  getFacsimileTableCommandAvailability,
  reconcileFacsimileTableEditorIdentity,
  reduceFacsimileTableHistory,
  resolveFacsimileTableCellContextSelection,
  serializeFacsimileTableSelectionForClipboard,
  serializeFacsimileTableSelectionAsTsv,
})) {
  assert.strictEqual(typeof value, 'function', `${name} must be an executable pure editor helper`)
}

for (const interaction of ['pointer', 'keyboard', 'paste', 'copy', 'cut', 'mutation', 'context-menu', 'toolbar', 'resize', 'textarea']) {
  assert.strictEqual(canHandleFacsimileTableInteraction(false, interaction), true, `${interaction} must remain enabled by default`)
  assert.strictEqual(canHandleFacsimileTableInteraction(true, interaction), false, `${interaction} must be rejected by the executable disabled dispatcher`)
}

const closureSelection = expandFacsimileTableSelectionForMerges(
  { startRow: 1, endRow: 2, startCol: 2, endCol: 2 },
  [
    { row: 0, col: 2, rowSpan: 2, colSpan: 2 },
    { row: 2, col: 3, rowSpan: 2, colSpan: 2 },
  ],
  5,
  6,
)
assert.deepStrictEqual(
  closureSelection,
  { startRow: 0, endRow: 3, startCol: 2, endCol: 4 },
  'merge-aware selection must recursively expand until every intersecting merged range is fully selected',
)

const mergeClearRows = [
  ['anchor', 'covered-a', 'keep'],
  ['covered-b', 'covered-c', 'keep'],
  ['keep', 'keep', 'keep'],
]
const mergeClear = applyFacsimileTableSelectionCommand(
  mergeClearRows,
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  'clear',
)
assert.deepStrictEqual(
  mergeClear.selection,
  { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
  'clicking one merged anchor must target the complete merged range',
)
assert.deepStrictEqual(mergeClear.rows.slice(0, 2).map((row) => row.slice(0, 2)), [['', ''], ['', '']])
assert.deepStrictEqual(mergeClear.merges, [], 'Delete on a merged cell must clear and remove the complete merge')
assert.deepStrictEqual(mergeClearRows[0], ['anchor', 'covered-a', 'keep'], 'selection commands must not mutate caller-owned rows')
const mergeAcrossExisting = applyFacsimileTableSelectionCommand(
  [['a', '', 'c'], ['', '', 'f']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  { startRow: 1, endRow: 1, startCol: 1, endCol: 2 },
  'merge',
)
assert.deepStrictEqual(
  mergeAcrossExisting.selection,
  { startRow: 0, endRow: 1, startCol: 0, endCol: 2 },
  'a partial drag through a merge must expand the command selection to the full old merge',
)
assert.deepStrictEqual(
  mergeAcrossExisting.merges,
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 3 }],
  'merge command must not rebuild an intersected merge as a smaller rectangle',
)

assert.deepStrictEqual(
  createFacsimileTableHeaderContextSelection('row', 10, 20, 5),
  { startRow: 10, endRow: 10, startCol: 0, endCol: 4 },
  'right-clicking row 10 must replace stale selection with row 10',
)
assert.deepStrictEqual(
  createFacsimileTableHeaderContextSelection('column', 3, 20, 5),
  { startRow: 0, endRow: 19, startCol: 3, endCol: 3 },
  'right-clicking a column header must select the complete current column',
)
assert.deepStrictEqual(
  createFacsimileTableCellContextSelection(
    { row: 1, col: 1 },
    { startRow: 0, endRow: 2, startCol: 0, endCol: 2 },
    [],
    4,
    4,
  ),
  { startRow: 0, endRow: 2, startCol: 0, endCol: 2 },
  'right-clicking inside an existing multi-cell selection must preserve it for context commands',
)
const columnContextResolution = resolveFacsimileTableCellContextSelection(
  { row: 2, col: 1 },
  { startRow: 0, endRow: 3, startCol: 1, endCol: 1 },
  'column',
  [],
  4,
  3,
)
assert.strictEqual(columnContextResolution.mode, 'column', 'right-clicking a cell inside a whole-column selection must retain column mode')
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    columnContextResolution.selection,
    columnContextResolution.mode,
    'delete-row',
  ).changed,
  false,
  'a cell context menu opened inside a column selection must still reject row deletion',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    columnContextResolution.selection,
    columnContextResolution.mode,
    'delete-column',
  ).rows[0].length,
  2,
  'the retained column mode must still allow deletion on its own axis',
)
const rowContextResolution = resolveFacsimileTableCellContextSelection(
  { row: 1, col: 2 },
  { startRow: 1, endRow: 1, startCol: 0, endCol: 2 },
  'row',
  [],
  4,
  3,
)
assert.strictEqual(rowContextResolution.mode, 'row', 'right-clicking a cell inside a whole-row selection must retain row mode')
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    rowContextResolution.selection,
    rowContextResolution.mode,
    'delete-column',
  ).changed,
  false,
  'a cell context menu opened inside a row selection must still reject column deletion',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    rowContextResolution.selection,
    rowContextResolution.mode,
    'delete-row',
  ).rows.length,
  3,
  'the retained row mode must still allow deletion on its own axis',
)
const outsideContextResolution = resolveFacsimileTableCellContextSelection(
  { row: 0, col: 0 },
  { startRow: 0, endRow: 3, startCol: 1, endCol: 1 },
  'column',
  [],
  4,
  3,
)
assert.strictEqual(outsideContextResolution.mode, 'cell', 'right-clicking outside the effective selection must switch to ordinary cell mode')
assert.deepStrictEqual(outsideContextResolution.selection, { startRow: 0, endRow: 0, startCol: 0, endCol: 0 })

const historyA = {
  rows: [['A']],
  merges: [],
  rowHeights: [40],
  columnWidths: [120],
}
const historyB = {
  rows: [['B']],
  merges: [],
  rowHeights: [52],
  columnWidths: [160],
}
const committedHistory = reduceFacsimileTableHistory(
  { past: [], present: historyA, future: [] },
  { type: 'commit', snapshot: historyB },
)
assert.strictEqual(committedHistory.past.length, 1)
assert.deepStrictEqual(committedHistory.present, historyB)
const undoneHistory = reduceFacsimileTableHistory(committedHistory, { type: 'undo' })
assert.deepStrictEqual(undoneHistory.present, historyA, 'undo must restore rows, merges, row heights, and column widths together')
assert.deepStrictEqual(undoneHistory.future, [historyB])
const redoneHistory = reduceFacsimileTableHistory(undoneHistory, { type: 'redo' })
assert.deepStrictEqual(redoneHistory.present, historyB, 'redo must restore the complete table snapshot')

const identityChanged = reconcileFacsimileTableEditorIdentity(
  'page-1:block-A',
  'page-1:block-B',
  JSON.stringify([[['A']], []]),
  JSON.stringify([[['A']], []]),
  committedHistory,
  historyA,
)
assert.strictEqual(identityChanged.kind, 'identity-change')
assert.deepStrictEqual(identityChanged.history.past, [], 'switching to a different block must clear undo history even when table content matches')
assert.deepStrictEqual(identityChanged.history.future, [], 'switching block identity must clear redo history')
const sameIdentityEcho = reconcileFacsimileTableEditorIdentity(
  'page-1:block-A',
  'page-1:block-A',
  JSON.stringify([[['B']], []]),
  JSON.stringify([[['B']], []]),
  committedHistory,
  historyB,
)
assert.strictEqual(sameIdentityEcho.kind, 'emitted-echo')
assert.strictEqual(sameIdentityEcho.history, committedHistory, 'a same-block onChange echo must preserve the existing undo stack')

assert.strictEqual(
  getFacsimileTableEditorKeyIntent({ key: 'Enter', isComposing: true }, false),
  'ignore-composition',
  'a native composing Enter must not commit a Chinese IME candidate as a cell edit',
)
assert.strictEqual(
  getFacsimileTableEditorKeyIntent({ key: 'Enter' }, true),
  'ignore-composition',
  'the composition session ref must protect candidate selection even when the browser key event omits isComposing',
)
assert.strictEqual(
  getFacsimileTableEditorKeyIntent({ key: 'Enter' }, false),
  'commit-next-row',
  'ordinary Enter must commit and move to the next row',
)

const axisRows = Array.from({ length: 12 }, (_, row) => [`${row}:0`, `${row}:1`])
const rowTenSelection = { startRow: 10, endRow: 10, startCol: 0, endCol: 1 }
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], rowTenSelection, 'row', 'delete-column').rows,
  axisRows,
  'row-header mode must reject column deletion in the dispatcher',
)
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], rowTenSelection, 'row', 'insert-column-right').rows,
  axisRows,
  'row-header mode must reject column insertion in the dispatcher',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], rowTenSelection, 'row', 'delete-row').rows.length,
  11,
  'row-header mode must allow deletion on its own axis',
)
const columnSelection = { startRow: 0, endRow: 11, startCol: 1, endCol: 1 }
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], columnSelection, 'column', 'delete-row').rows,
  axisRows,
  'column-header mode must reject row deletion in the dispatcher',
)
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], columnSelection, 'column', 'insert-row-below').rows,
  axisRows,
  'column-header mode must reject row insertion in the dispatcher',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], columnSelection, 'column', 'delete-column').rows[0].length,
  1,
  'column-header mode must allow deletion on its own axis',
)

const clipboardCommand = applyFacsimileTableClipboardCommand(
  [['base', ''], ['', '']],
  [],
  { startRow: 1, endRow: 1, startCol: 1, endCol: 1 },
  { html: '<table><tr><td colspan="2">A</td></tr></table>' },
)
assert.strictEqual(clipboardCommand.source, 'html')
assert.strictEqual(clipboardCommand.truncated, false)
assert.deepStrictEqual(
  clipboardCommand.merges,
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }],
  'clipboard commands must preserve and offset HTML merge metadata',
)
const truncatedClipboardCommand = applyFacsimileTableClipboardCommand(
  [['base']],
  [],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  { html: '<table><tr><td rowspan="999999999999999999" colspan="999999999999999999">A</td></tr></table>' },
)
assert.strictEqual(truncatedClipboardCommand.truncated, true, 'clipboard command must propagate parser and paste budget truncation')

const hiddenMergeRows = [
  ['ANCHOR', 'HIDDEN-A'],
  ['HIDDEN-B', 'HIDDEN-C'],
]
const hiddenMerge = [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }]
assert.strictEqual(
  serializeFacsimileTableSelectionAsTsv(
    hiddenMergeRows,
    hiddenMerge,
    { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  ),
  'ANCHOR\t\r\n\t',
  'copying a merged range must serialize covered cells as empty instead of leaking hidden OCR values',
)
const losslessClipboard = serializeFacsimileTableSelectionForClipboard(
  [['甲\n乙\t内', '丙']],
  [],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 1 },
)
assert.strictEqual(losslessClipboard.text, '甲\n乙\t内\t丙', 'plain TSV fallback must remain available for non-HTML targets')
assert.deepStrictEqual(
  parseFacsimileTableClipboardData({ html: losslessClipboard.html, text: losslessClipboard.text }).rows,
  [['甲\n乙\t内', '丙']],
  'structured HTML copy must preserve newlines and literal tabs inside cells on roundtrip',
)
const mergedClipboard = serializeFacsimileTableSelectionForClipboard(
  hiddenMergeRows,
  hiddenMerge,
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
)
assert.ok(mergedClipboard.html.includes('rowspan="2"') && mergedClipboard.html.includes('colspan="2"'))
assert.ok(!mergedClipboard.html.includes('HIDDEN-A') && !mergedClipboard.html.includes('HIDDEN-B'), 'structured copy must skip covered cells and their stale OCR values')
const mergedClipboardRoundtrip = parseFacsimileTableClipboardData(mergedClipboard)
assert.deepStrictEqual(mergedClipboardRoundtrip.rows, [['ANCHOR', ''], ['', '']])
assert.deepStrictEqual(mergedClipboardRoundtrip.merges, hiddenMerge, 'structured copy/paste must retain rowspan and colspan metadata')
const singleValueOverMerge = applyFacsimileTableClipboardCommand(
  hiddenMergeRows,
  hiddenMerge,
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  { text: 'NEW' },
)
assert.deepStrictEqual(singleValueOverMerge.rows, [['NEW', ''], ['', '']], 'a small paste must clear the rest of the effective merge closure')
assert.deepStrictEqual(singleValueOverMerge.merges, [], 'pasting a single value over a merge must remove the old merge')
const newMergeOverOldMerge = applyFacsimileTableClipboardCommand(
  hiddenMergeRows,
  hiddenMerge,
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  { html: '<table><tr><td colspan="2">NEW-MERGE</td></tr></table>' },
)
assert.deepStrictEqual(newMergeOverOldMerge.rows, [['NEW-MERGE', ''], ['', '']])
assert.deepStrictEqual(
  newMergeOverOldMerge.merges,
  [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }],
  'a pasted HTML merge must replace the old merge without exposing covered values outside the new range',
)
const partialFootprintRows = [
  ['KEEP-00', 'START', 'TARGET', 'CLEAR-03', 'KEEP-04'],
  ['KEEP-10', 'TARGET', 'ANCHOR', 'HIDDEN-A', 'KEEP-14'],
  ['KEEP-20', 'CLEAR-21', 'HIDDEN-B', 'HIDDEN-C', 'KEEP-24'],
  ['KEEP-30', 'KEEP-31', 'KEEP-32', 'KEEP-33', 'KEEP-34'],
]
const partialFootprintPaste = applyFacsimileTableClipboardCommand(
  partialFootprintRows,
  [{ row: 1, col: 2, rowSpan: 2, colSpan: 2 }],
  { startRow: 0, endRow: 0, startCol: 1, endCol: 1 },
  { text: 'N00\tN01\nN10\tN11' },
)
assert.deepStrictEqual(partialFootprintPaste.merges, [], 'a paste footprint touching a merge edge must remove the complete old merge')
assert.deepStrictEqual(
  partialFootprintPaste.rows.slice(0, 3).map((row) => row.slice(1, 4)),
  [['N00', 'N01', ''], ['N10', 'N11', ''], ['', '', '']],
  'the union of selection, actual paste footprint, and merge closure must be cleared before writing new cells',
)
assert.strictEqual(partialFootprintPaste.rows[0][0], 'KEEP-00')
assert.strictEqual(partialFootprintPaste.rows[3][3], 'KEEP-33')

const normalAvailability = getFacsimileTableCommandAvailability(
  [['a', 'b'], ['c', 'd']],
  [],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
)
assert.deepStrictEqual(normalAvailability, {
  insertRow: true,
  insertColumn: true,
  deleteRow: true,
  deleteColumn: true,
  merge: false,
  split: false,
  clear: true,
})
const rowModeAvailability = getFacsimileTableCommandAvailability(
  [['a', 'b'], ['c', 'd']],
  [],
  { startRow: 1, endRow: 1, startCol: 0, endCol: 1 },
  'row',
)
assert.strictEqual(rowModeAvailability.insertColumn, false)
assert.strictEqual(rowModeAvailability.deleteColumn, false, 'row-header context menus must disable the opposite column axis')
const columnModeAvailability = getFacsimileTableCommandAvailability(
  [['a', 'b'], ['c', 'd']],
  [],
  { startRow: 0, endRow: 1, startCol: 1, endCol: 1 },
  'column',
)
assert.strictEqual(columnModeAvailability.insertRow, false)
assert.strictEqual(columnModeAvailability.deleteRow, false, 'column-header context menus must disable the opposite row axis')
const maxColumnsRows = [Array.from({ length: FACSIMILE_TABLE_MAX_COLUMNS }, () => '')]
assert.strictEqual(
  getFacsimileTableCommandAvailability(maxColumnsRows, [], { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }).insertColumn,
  false,
  'column insertion must be disabled at the structural safety limit',
)
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(
    maxColumnsRows,
    [],
    { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
    'cell',
    'insert-column-right',
  ).rows,
  maxColumnsRows,
  'the dispatcher must enforce table budgets even if a disabled menu command is invoked directly',
)
const mergedAvailability = getFacsimileTableCommandAvailability(
  [['a', ''], ['', '']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
)
assert.strictEqual(mergedAvailability.merge, false, 'an already merged range must not offer a redundant merge command')
assert.strictEqual(mergedAvailability.split, true, 'an effective selection containing a merge must offer split')

const mergeLookup = buildFacsimileTableCellMergeLookup(
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  2,
  2,
)
assert.strictEqual(mergeLookup.size, 4, 'the render path must pre-index every cell of a merge once')
assert.deepStrictEqual(mergeLookup.get('1:1'), { row: 0, col: 0, rowSpan: 2, colSpan: 2 })
const denseMerges = Array.from({ length: 100 }, (_, row) => (
  Array.from({ length: 100 }, (_, index) => ({ row, col: index * 2, rowSpan: 1, colSpan: 2 }))
)).flat()
const denseLookupStartedAt = process.hrtime.bigint()
const denseLookup = buildFacsimileTableCellMergeLookup(denseMerges, 100, 200, true)
const denseLookupElapsedMs = Number(process.hrtime.bigint() - denseLookupStartedAt) / 1_000_000
assert.strictEqual(denseLookup.size, 20_000)
assert.ok(denseLookupElapsedMs < 1_000, `indexing 10,000 normalized merges took an unexpected ${denseLookupElapsedMs.toFixed(1)}ms`)

assert.deepStrictEqual(
  clampFacsimileTableContextMenuPosition(999, 999, 800, 600, 216, 328),
  { left: 576, top: 264 },
  'context menu coordinates must stay inside the viewport',
)

{
  const listeners = new Map()
  const removed = []
  let releases = 0
  let finished = 0
  const target = {
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { removed.push([type, listener]) },
    hasPointerCapture() { return true },
    releasePointerCapture() { releases += 1 },
  }
  const cleanup = attachFacsimileTableResizeListeners(target, 7, () => {}, () => { finished += 1 })
  assert.deepStrictEqual(
    [...listeners.keys()].sort(),
    ['lostpointercapture', 'pointercancel', 'pointermove', 'pointerup'],
    'resize must register every normal, cancellation, and lost-capture cleanup path',
  )
  listeners.get('pointercancel')({})
  assert.strictEqual(removed.length, 4, 'finishing resize must remove every registered listener')
  assert.strictEqual(releases, 1)
  assert.strictEqual(finished, 1)
  cleanup()
  assert.strictEqual(removed.length, 4, 'resize cleanup must be idempotent')
  assert.strictEqual(finished, 1)
}

{
  const listeners = new Map()
  const removed = []
  let escapeCloses = 0
  let prevented = 0
  const target = {
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { removed.push([type, listener]); if (listeners.get(type) === listener) listeners.delete(type) },
  }
  const cleanup = attachFacsimileTableContextMenuEscapeListener(target, () => { escapeCloses += 1 })
  assert.deepStrictEqual([...listeners.keys()], ['keydown'], 'an open context menu must register one Escape listener')
  listeners.get('keydown')({ key: 'Enter', preventDefault() { prevented += 1 } })
  assert.strictEqual(escapeCloses, 0)
  listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented += 1 } })
  assert.strictEqual(escapeCloses, 1, 'Escape must deterministically close the context menu')
  assert.strictEqual(prevented, 1)
  assert.strictEqual(removed.length, 1, 'Escape must clean its listener exactly once')
  cleanup()
  assert.strictEqual(removed.length, 1, 'context menu Escape cleanup must be idempotent for unmount')

  const first = attachFacsimileTableContextMenuEscapeListener(target, () => { escapeCloses += 1 })
  first()
  const second = attachFacsimileTableContextMenuEscapeListener(target, () => { escapeCloses += 1 })
  assert.strictEqual(listeners.size, 1, 'reopening the menu after cleanup must not leak an old keydown listener')
  second()
  assert.strictEqual(listeners.size, 0)
}

const darkThemeStyle = createFacsimileTableThemeStyle({
  colorBgContainer: '#141414',
  colorBgElevated: '#1f1f1f',
  colorBgLayout: '#000000',
  colorText: '#f0f0f0',
  colorTextSecondary: '#bfbfbf',
  colorBorderSecondary: '#303030',
  colorPrimaryBg: '#111a2c',
  colorPrimaryBgHover: '#112545',
  colorPrimary: '#1668dc',
  colorPrimaryBorder: '#15325b',
  boxShadowSecondary: '0 6px 16px #0008',
  colorTextDisabled: '#5c5c5c',
})
assert.strictEqual(darkThemeStyle['--table-bg'], '#141414')
assert.strictEqual(darkThemeStyle['--table-text'], '#f0f0f0')
assert.strictEqual(darkThemeStyle['--table-secondary'], '#bfbfbf')
assert.strictEqual(darkThemeStyle['--table-menu-bg'], '#1f1f1f')
assert.strictEqual(darkThemeStyle['--table-menu-hover'], '#112545')

assert.ok(tableEditor.includes('role="grid"'), 'the table editor must expose a single focusable ARIA grid root')
assert.ok(tableEditor.includes('role="row"') && tableEditor.includes('role="gridcell"'), 'rows and cells must expose ARIA grid semantics')
assert.ok(tableEditor.includes('facsimile-table-row-header'), 'the grid must render clickable row number headers')
assert.ok(tableEditor.includes('facsimile-table-column-header'), 'the grid must render clickable column letter headers')
assert.ok(tableEditor.includes('onPointerDown={handleCellPointerDown}'), 'pointer down must start rectangular cell selection')
assert.ok(tableEditor.includes('onPointerEnter={() => handleCellPointerEnter'), 'pointer drag must extend a rectangular selection')
assert.ok(!tableEditor.includes('<Input.TextArea'), 'ordinary cells must be display elements instead of one textarea per cell')
assert.strictEqual((tableEditor.match(/<textarea\b/g) || []).length, 1, 'the component source must define exactly one reusable active cell editor')
assert.ok(tableEditor.includes('editingCell &&'), 'the active cell editor must only mount while a single cell is being edited')
assert.ok(tableEditor.includes('const rawSelection = getFacsimileTableSelection(anchor, focus)'))
assert.ok(tableEditor.includes('expandFacsimileTableSelectionWithLookup(rawSelection'), 'rendering and commands must share one indexed merge-aware effective selection')
assert.ok(tableEditor.includes('const mergeLookup = useMemo('), 'the render path must memoize its cell-to-merge index')
assert.ok(tableEditor.includes('const commandAvailability = useMemo('), 'command availability must be memoized from the normalized table snapshot')

assert.ok(tableEditor.includes("event.clipboardData.getData('text/html')"), 'paste must read HTML clipboard data')
assert.ok(tableEditor.includes("event.clipboardData.getData('text/plain')"), 'paste must read plain text clipboard data')
assert.ok(tableEditor.includes("event.clipboardData.setData('text/html'"), 'copy must publish structured HTML alongside TSV fallback')
assert.ok(tableEditor.includes('parseFacsimileTableClipboardData'), 'paste must use the detailed Task 2 clipboard parser')
assert.ok(tableEditor.includes('parsed.merges'), 'paste must preserve HTML clipboard merge metadata')
assert.ok(tableEditor.includes('parsed.truncated') && tableEditor.includes('pasted.truncated'), 'clipboard budget truncation must produce a visible UI path')

for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Delete', 'Backspace', 'F2', 'Escape']) {
  assert.ok(tableEditor.includes(`'${key}'`), `the grid keyboard handler must support ${key}`)
}
assert.ok(tableEditor.includes('event.ctrlKey || event.metaKey'), 'the grid must recognize platform undo/redo shortcuts')
assert.ok(tableEditor.includes('undo') && tableEditor.includes('redo'), 'the grid must keep local undo and redo history')
assert.ok(tableEditor.includes('onDoubleClick'), 'double click must enter cell editing')
assert.ok(tableEditor.includes('isPrintableKey'), 'typing a printable key must start overwrite editing')
assert.ok(tableEditor.includes('onCompositionStart') && tableEditor.includes('onCompositionEnd'), 'the active editor must track Chinese IME composition sessions')
assert.ok(proofreader.includes('blockId={editingBlockId}'), 'the proofreader must pass stable block identity into the docked inspector')

assert.ok(tableEditor.includes('onContextMenu={handleContextMenu}'), 'the editor must expose a selection-aware context menu')
assert.ok(tableEditor.includes('onContextMenu={(event) => handleRowHeaderContextMenu'), 'row headers must replace stale selection before opening the context menu')
assert.ok(tableEditor.includes('onContextMenu={(event) => handleColumnHeaderContextMenu'), 'column headers must replace stale selection before opening the context menu')
assert.ok(tableEditor.includes('resolveFacsimileTableCellContextSelection('), 'cell context menus must preserve row or column mode when opened inside that selection')
assert.ok(tableEditor.includes('onScroll={() => closeContextMenu()}'), 'scrolling the grid must close the context menu and clean its Escape listener')
for (const action of ['上方插入行', '下方插入行', '左侧插入列', '右侧插入列', '删除行', '删除列', '合并选区', '拆分单元格', '清空选区']) {
  assert.ok(tableEditor.includes(action), `the table context controls must retain ${action}`)
}
assert.ok(tableEditor.includes('facsimile-table-row-resize-handle'), 'row headers must expose resize handles')
assert.ok(tableEditor.includes('facsimile-table-column-resize-handle'), 'column headers must expose resize handles')
assert.ok(tableEditor.includes('setPointerCapture'), 'resize and drag interactions must reliably capture pointer movement')
assert.ok(tableEditor.includes('resizeCleanupRef'), 'resize cleanup must survive event-handler rerenders and component unmount')
assert.ok(tableEditor.includes('contextMenuEscapeCleanupRef'), 'context menu Escape cleanup must survive rerenders and unmount')
assert.ok(tableEditor.includes("gridRef.current?.focus({ preventScroll: true })"), 'opening the context menu must keep keyboard focus on a deterministic Escape target')

assert.ok(tableEditor.includes('theme.useToken()'), 'the component must read the active Ant Design theme token set')
assert.ok(tableEditor.includes('createFacsimileTableThemeStyle(token)'), 'real Ant tokens must be connected to the grid CSS variables')
assert.ok(tableEditor.includes('style={tableThemeStyle}'), 'the grid root must receive its local theme variables inline')
assert.ok(!tableEditorCss.includes('--gs-') && !tableEditorCss.includes('--ant-'), 'component styles must not depend on undefined global theme variables')
assert.ok(tableEditorCss.includes('var(--table-bg,'), 'component theme variables must provide an explicit light fallback')
assert.ok(tableEditorCss.includes('overflow: auto'), 'narrow table editors must scroll instead of clipping columns')
assert.ok(!/background(?:-color)?\s*:\s*#fff(?:fff)?\b/i.test(tableEditorCss), 'table cells must not force a hard-coded white background')
assert.ok(!/background(?:-color)?\s*:\s*['"]?#fff(?:fff)?\b/i.test(tableEditor), 'the component must not force a hard-coded white background')

const toolbarStart = tableEditor.indexOf('className="facsimile-table-toolbar"')
const toolbarEnd = tableEditor.indexOf('className="facsimile-table-help"')
const toolbarSource = tableEditor.slice(toolbarStart, toolbarEnd)
assert.ok(toolbarSource.includes('撤销') && toolbarSource.includes('重做'), 'the compact toolbar must expose undo and redo controls')
for (const action of ['上方插入行', '下方插入行', '左侧插入列', '右侧插入列', '删除行', '删除列', '合并选区', '拆分单元格', '清空选区']) {
  assert.ok(!toolbarSource.includes(action), `the compact toolbar must leave ${action} in the context menu`)
}

assert.deepStrictEqual(
  [...MANUAL_LAYOUT_BLOCK_KINDS].sort(),
  ['abstract', 'footer', 'header', 'image', 'note', 'number', 'paragraph_title', 'reference', 'seal', 'table', 'text', 'title'].sort(),
  'the manual toolbox must use the complete shared canonical block-kind set',
)
assert.deepStrictEqual(MANUAL_LAYOUT_QUICK_KINDS, ['text', 'note', 'table', 'image'])
assert.deepStrictEqual(MANUAL_LAYOUT_MORE_KINDS, ['title', 'paragraph_title', 'abstract', 'reference', 'header', 'footer', 'number', 'seal'])
assert.strictEqual(reduceManualLayoutTool('note', { type: 'created' }), 'note', 'a draw tool must remain active for repeated creation')
assert.strictEqual(reduceManualLayoutTool('image', { type: 'escape' }), 'select', 'Escape must return every draw tool to selection')
assert.strictEqual(reduceManualLayoutTool('select', { type: 'choose-kind', kind: 'table' }), 'table')
assert.strictEqual(typeof getManualLayoutEditEntryPreparation, 'function', 'all edit entry points must share one executable preparation plan')
assert.deepStrictEqual(getManualLayoutEditEntryPreparation(), {
  imageUnderlayMode: 'on',
  showRules: true,
  translationOpen: false,
  pageRotation: 0,
  tool: 'select',
  layoutEditMode: true,
}, 'direct block edit must prepare the same underlay, rules, translation, rotation and tool state as the main edit-mode button')
assert.strictEqual(typeof createManualLayoutPointerFrameScheduler, 'function', 'pointer previews must expose an executable frame scheduler')

const queuedFrames = new Map()
const cancelledFrames = []
const appliedFrameValues = []
let nextFrameId = 1
const frameScheduler = createManualLayoutPointerFrameScheduler(
  (callback) => {
    const frameId = nextFrameId
    nextFrameId += 1
    queuedFrames.set(frameId, callback)
    return frameId
  },
  (frameId) => {
    cancelledFrames.push(frameId)
    queuedFrames.delete(frameId)
  },
  (value) => appliedFrameValues.push(value),
)
frameScheduler.schedule({ x: 1, y: 1 })
frameScheduler.schedule({ x: 2, y: 3 })
assert.strictEqual(queuedFrames.size, 1, 'many pointermoves in one frame must allocate only one animation frame')
const firstQueuedFrame = [...queuedFrames.entries()][0]
queuedFrames.delete(firstQueuedFrame[0])
firstQueuedFrame[1]()
assert.deepStrictEqual(appliedFrameValues, [{ x: 2, y: 3 }], 'one frame must prepare and preview only the latest pointer coordinate')
frameScheduler.schedule({ x: 5, y: 8 })
assert.strictEqual(frameScheduler.flush(), true, 'pointerup must synchronously flush the latest queued coordinate')
assert.deepStrictEqual(appliedFrameValues, [{ x: 2, y: 3 }, { x: 5, y: 8 }])
assert.strictEqual(queuedFrames.size, 0, 'flushing must cancel the stale browser callback')
frameScheduler.schedule({ x: 13, y: 21 })
frameScheduler.cancel()
assert.strictEqual(queuedFrames.size, 0, 'cancel/lostcapture/page/unmount must cancel the queued frame')
assert.strictEqual(frameScheduler.flush(), false, 'a cancelled frame must never apply a stale preview')
assert.ok(cancelledFrames.length >= 2, 'flush and cancel must both release their pending browser frame')

const editingBounds = { left: 0, top: 0, width: 1000, height: 800 }
assert.deepStrictEqual(
  normalizeManualLayoutBlockRect({ left: 80, top: 90, width: -60, height: -50 }),
  { left: 20, top: 40, width: 60, height: 50 },
  'reverse drag rectangles must normalize before creation',
)
assert.deepStrictEqual(
  clampManualLayoutBlockRect({ left: -20, top: 790, width: 5, height: 5 }, editingBounds, { width: 20, height: 16 }),
  { left: 0, top: 784, width: 20, height: 16 },
  'creation and resize must clamp to the page and enforce minimum dimensions',
)
assert.deepStrictEqual(
  moveManualLayoutBlockRect({ left: 900, top: 700, width: 100, height: 100 }, 80, 80, editingBounds, { width: 20, height: 16 }),
  { left: 900, top: 700, width: 100, height: 100 },
  'moving a block must preserve its size while clamping it inside the page',
)
for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
  const resized = resizeManualLayoutBlockRect(
    { left: 300, top: 250, width: 200, height: 120 },
    handle,
    25,
    20,
    editingBounds,
    { width: 20, height: 16 },
  )
  assert.ok(resized.width >= 20 && resized.height >= 16, `${handle} resize must preserve minimum size`)
  assert.ok(resized.left >= 0 && resized.top >= 0 && resized.left + resized.width <= 1000 && resized.top + resized.height <= 800, `${handle} resize must stay inside page bounds`)
}

const previewBlocks = [
  { manual_block_id: 'm1', label: 'text', location: { left: 10, top: 20, width: 100, height: 80 } },
  { manual_block_id: 'm2', label: 'note', location: { left: 300, top: 20, width: 100, height: 80 } },
]
const geometryPreview = createManualLayoutGeometryPreview(previewBlocks, 'm1')
const previewUpdated = updateManualLayoutGeometryPreview(geometryPreview, { left: 30, top: 40, width: 120, height: 90 })
assert.deepStrictEqual(previewUpdated.blocks[0].location, { left: 30, top: 40, width: 120, height: 90 })
assert.strictEqual(previewUpdated.blocks[1], previewBlocks[1], 'preview updates must leave unrelated blocks referentially stable')
assert.deepStrictEqual(commitManualLayoutGeometryPreview(previewUpdated), previewUpdated.blocks, 'pointerup must commit the latest preview exactly once')
assert.deepStrictEqual(rollbackManualLayoutGeometryPreview(previewUpdated), previewBlocks, 'Escape/pointercancel must restore the interaction baseline')

assert.strictEqual(typeof createManualLayoutTableSnapshot, 'function', 'table conversion must expose one canonical snapshot normalizer')
const tableConversionSource = {
  manual_block_id: 'table-1',
  label: 'table',
  rows: [['A', 'B']],
  table_rows: [['stale alias']],
  tableRows: [['another stale alias']],
  cells: [{ row: 0, col: 0, text: 'A', colSpan: 2 }],
  table_cells: [{ row: 0, col: 0, text: 'stale' }],
  merges: [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }],
  rowHeights: [31],
  columnWidths: [90, 120],
}
assert.deepStrictEqual(createManualLayoutTableSnapshot(tableConversionSource), {
  version: 1,
  rows: [['A', 'B']],
  merges: [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }],
  rowHeights: [31],
  columnWidths: [90, 120],
}, 'alias-rich active tables must normalize to one bounded canonical archive')
assert.deepStrictEqual(createManualLayoutTableSnapshot({
  label: 'table',
  table_html: '<table><tr><td rowspan="2">甲</td><td>乙</td></tr><tr><td>丙</td></tr></table>',
}), {
  version: 1,
  rows: [['甲', '乙'], ['', '丙']],
  merges: [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }],
  rowHeights: [40, 40],
  columnWidths: [120, 120],
}, 'legacy HTML-only archives must remain readable and normalize row spans without retaining markup aliases')
assert.ok(getManualLayoutBlockConversionWarning(tableConversionSource, 'text'), 'structured-to-text conversion must require a warning')
assert.strictEqual(applyManualLayoutBlockConversion(tableConversionSource, 'text', false).blocked, true, 'unconfirmed structured conversion must be blocked')
const confirmedTableConversion = applyManualLayoutBlockConversion(tableConversionSource, 'text', true)
assert.strictEqual(confirmedTableConversion.block.label, 'text')
assert.deepStrictEqual(confirmedTableConversion.block.manual_preserved_table, createManualLayoutTableSnapshot(tableConversionSource), 'confirmed conversion must preserve exactly one canonical table snapshot')
assert.strictEqual(confirmedTableConversion.block.rows, undefined, 'inactive table rows must not keep rendering after conversion to text')
const restoredCanonicalTable = applyManualLayoutBlockConversion(confirmedTableConversion.block, 'table', true).block
assert.deepStrictEqual(restoredCanonicalTable.rows, [['A', 'B']], 'switching back to table must restore the preserved structure')
assert.deepStrictEqual(restoredCanonicalTable.merges, [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }])
assert.strictEqual(restoredCanonicalTable.manual_preserved_table, undefined, 'the consumed archive must not remain beside active table data')
for (const alias of ['table_rows', 'tableRows', 'cells', 'table_cells', 'tableCells', 'table_merges', 'tableMerges']) {
  assert.strictEqual(restoredCanonicalTable[alias], undefined, `restored active tables must not duplicate canonical data into ${alias}`)
}
const emptyTableArchive = applyManualLayoutBlockConversion({ label: 'table', rows: [['']], merges: [] }, 'text', true).block
assert.deepStrictEqual(
  applyManualLayoutBlockConversion(emptyTableArchive, 'table', true).block.rows,
  [['']],
  'an intentionally empty table must remain a table instead of being replaced by fallback text',
)
const manuallyEditedText = { ...confirmedTableConversion.block, words: '人工改写后的正文' }
const restoredTableAfterTextEdit = applyManualLayoutBlockConversion(manuallyEditedText, 'table', true).block
assert.deepStrictEqual(restoredTableAfterTextEdit.rows, [['A', 'B']], 'switching back to table must restore the original structured table')
assert.deepStrictEqual(restoredTableAfterTextEdit.manual_preserved_text, {
  text: '人工改写后的正文',
  source: 'manual-type-conversion',
  version: 1,
}, 'switching back to table must archive the latest manually edited text independently')
const restoredEditedText = applyManualLayoutBlockConversion(restoredTableAfterTextEdit, 'text', true).block
assert.strictEqual(restoredEditedText.words, '人工改写后的正文', 'returning to text must restore the latest manual text instead of the table projection')
const editedAgain = { ...restoredEditedText, words: '第二次人工改写' }
const secondTableRoundtrip = applyManualLayoutBlockConversion(editedAgain, 'table', true).block
assert.strictEqual(secondTableRoundtrip.manual_preserved_text.text, '第二次人工改写')
assert.strictEqual(secondTableRoundtrip.manual_preserved_text.version, 2, 'each new text archive must advance its explicit version')
assert.strictEqual(applyManualLayoutBlockConversion(secondTableRoundtrip, 'text', true).block.words, '第二次人工改写')
const emptyTextRoundtrip = applyManualLayoutBlockConversion({ ...restoredEditedText, words: '' }, 'table', true).block
assert.strictEqual(emptyTextRoundtrip.manual_preserved_text.text, '', 'an intentional empty manual text must remain distinguishable from no archive')
assert.strictEqual(applyManualLayoutBlockConversion(emptyTextRoundtrip, 'text', true).block.words, '', 'an intentional empty text must survive a complete table roundtrip')
let repeatedRoundtrip = restoredTableAfterTextEdit
const repeatedRoundtripSizes = []
for (let index = 0; index < 6; index += 1) {
  const asText = applyManualLayoutBlockConversion(repeatedRoundtrip, 'text', true).block
  assert.deepStrictEqual(asText.manual_preserved_table, createManualLayoutTableSnapshot(repeatedRoundtrip), 'each table-to-text transition must archive only the current active structure')
  repeatedRoundtrip = applyManualLayoutBlockConversion({ ...asText, words: '稳定人工正文' }, 'table', true).block
  assert.strictEqual(repeatedRoundtrip.manual_preserved_table, undefined)
  assert.strictEqual(repeatedRoundtrip.manual_preserved_text.text, '稳定人工正文')
  repeatedRoundtripSizes.push(JSON.stringify(repeatedRoundtrip).length)
}
assert.strictEqual(new Set(repeatedRoundtripSizes).size, 1, 'repeated roundtrips must not grow JSON through nested or duplicate table archives')
assert.match(getManualLayoutBlockConversionWarning(manuallyEditedText, 'table'), /独立保留|归档/, 'the confirmation must accurately explain where current manual text is retained')
const imageConversionSource = { manual_block_id: 'image-1', label: 'image', image_asset_path: 'managed/image.png', caption: '图一' }
assert.ok(getManualLayoutBlockConversionWarning(imageConversionSource, 'note'), 'image-to-text conversion must require a warning')
assert.strictEqual(applyManualLayoutBlockConversion(imageConversionSource, 'note', true).block.image_asset_path, 'managed/image.png', 'confirmed image conversion must preserve managed asset metadata')

const manualToolbarPath = path.join(root, 'src/renderer/src/components/ManualLayoutToolbar.tsx')
const manualInspectorPath = path.join(root, 'src/renderer/src/components/ManualBlockInspector.tsx')
assert.ok(fs.existsSync(manualToolbarPath), 'edit mode must have a compact typed block toolbar')
assert.ok(fs.existsSync(manualInspectorPath), 'edit mode must have a docked stable-ID inspector')
const manualToolbarSource = fs.readFileSync(manualToolbarPath, 'utf8')
const manualInspectorSource = fs.readFileSync(manualInspectorPath, 'utf8')
assert.ok(manualToolbarSource.includes('MANUAL_LAYOUT_QUICK_KINDS') && manualToolbarSource.includes('MANUAL_LAYOUT_MORE_KINDS'), 'toolbar UI must be driven by the canonical quick/more kind lists')
assert.ok(manualToolbarSource.includes("tool === 'select'"), 'toolbar must expose an explicit selection tool')
assert.ok(manualInspectorSource.includes('blockId'), 'inspector identity must be a stable block ID rather than an array index')
assert.ok(manualInspectorSource.includes('<FacsimileTableEditor'), 'table blocks must reuse the Excel-style editor')
assert.ok(manualInspectorSource.includes('editorKey={blockId}'), 'table editor state must be isolated by stable block ID')
assert.ok(manualInspectorSource.includes('重新裁剪') && manualInspectorSource.includes('替换图片'), 'image-like inspectors must expose honest follow-up entry points')
assert.ok(manualInspectorSource.includes('未选择区块'), 'the docked inspector must remain mounted and guide the user without a selection')
assert.ok(proofreader.includes('<ManualLayoutToolbar'), 'the proofreader must mount the typed toolbar in edit mode')
assert.ok(proofreader.includes('<ManualBlockInspector'), 'the proofreader must mount the inspector throughout edit mode')
assert.ok(proofreader.includes('setPointerCapture'), 'block move/resize/draw must use pointer capture')
assert.ok(proofreader.includes('onPointerCancel'), 'pointer cancellation must roll back a geometry preview')
assert.ok(proofreader.includes('layoutPointerFrameSchedulerRef.current?.schedule({'), 'pointermove must enqueue only the latest raw coordinate')
assert.ok(proofreader.includes('layoutPointerFrameSchedulerRef.current?.flush()'), 'pointerup must flush its final coordinate before the single commit')
assert.ok((proofreader.match(/layoutPointerFrameSchedulerRef\.current\?\.cancel\(\)/g) || []).length >= 6, 'cancel, page change, lock, mode exit and unmount must all cancel pending preview frames')
const pointerUpStart = proofreader.indexOf('const handlePageLayoutPointerUp = useCallback(')
const pointerUpEnd = proofreader.indexOf('const handlePageLayoutPointerCancel', pointerUpStart)
const pointerUpSource = proofreader.slice(pointerUpStart, pointerUpEnd)
assert.ok(pointerUpSource.indexOf('.schedule({') < pointerUpSource.indexOf('.flush()'), 'pointerup must queue its own final coordinate before flushing')
assert.ok(pointerUpSource.indexOf('.flush()') < pointerUpSource.indexOf('commitBlocks(committedBlocks'), 'the final frame must be applied before the one committed revision')
const stageTableStart = proofreader.indexOf('const stageTableBlockChange = useCallback(')
const stageTableEnd = proofreader.indexOf('const applyInspectorTypeChange', stageTableStart)
const stageTableSource = proofreader.slice(stageTableStart, stageTableEnd)
assert.ok(stageTableSource.includes('merges: normalizedMerges') && stageTableSource.includes('rowHeights: normalizedRowHeights') && stageTableSource.includes('columnWidths: normalizedColumnWidths'), 'table edits must persist one canonical structure including visual sizes')
assert.ok(!stageTableSource.includes('table_rows: normalizedRows') && !stageTableSource.includes('tableCells: cells'), 'table edits must not fan canonical data back out into legacy aliases')
for (const handle of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
  assert.ok(proofreader.includes(`handle: '${handle}'`), `the selected block must expose the ${handle} resize handle`)
}

assert.deepStrictEqual(
  getManualLayoutBlockVisualState('block-a', 'block-b', 4, 4),
  { editingActive: false, parentHighlighted: true },
  'a parent search/highlight hit must not become the editing-active block',
)
assert.deepStrictEqual(
  getManualLayoutBlockVisualState('block-a', 'block-a', 4, 9),
  { editingActive: true, parentHighlighted: false },
  'stable block identity alone must control editing handles and inspector selection',
)
assert.ok(proofreader.includes('layoutEditMode && isEditingActive ? BLOCK_RESIZE_HANDLES.map'), 'resize handles must render only for stable editing selection')
assert.ok(proofreader.includes("cursor: layoutEditMode ? (isEditingActive ? 'move' : 'pointer')"), 'move cursor must belong only to the stable editing-active block')
assert.ok(!proofreader.includes('layoutEditMode && isActive ? BLOCK_RESIZE_HANDLES.map'), 'parent highlight must never create a second resize-handle set')

assert.ok(tableEditor.includes('disabled?: boolean'), 'the Excel-style editor must expose an optional disabled contract')
assert.ok(tableEditor.includes('disabled = false'), 'the disabled contract must preserve compatibility by default')
assert.ok(tableEditor.includes('aria-disabled={disabled}'))
assert.ok(tableEditor.includes('tabIndex={disabled ? -1 : 0}'), 'a disabled table grid must leave the keyboard focus order')
assert.ok(tableEditor.includes('onCut={handleCut}'), 'cut must have an explicit guarded path')
for (const handler of [
  'handleCellPointerDown',
  'handleCellPointerEnter',
  'handleColumnResizePointerDown',
  'handleRowResizePointerDown',
  'handlePaste',
  'handleCut',
  'handleContextMenu',
  'handleCellContextMenu',
  'handleRowHeaderContextMenu',
  'handleColumnHeaderContextMenu',
  'handleGridKeyDown',
  'handleEditorKeyDown',
]) {
  const start = tableEditor.indexOf(`const ${handler}`)
  assert.ok(start >= 0, `${handler} must exist`)
  assert.ok(tableEditor.slice(start, start + 700).includes('disabled'), `${handler} must explicitly reject disabled interactions`)
}
assert.ok(tableEditor.includes('if (disabled) return') && tableEditor.includes('if (disabled) {'), 'central state mutations and event handlers must reject disabled mode')
assert.ok(tableEditor.includes('disabled={disabled}'), 'internal native/Ant controls must receive their real disabled state')
assert.ok(manualInspectorSource.includes('disabled={disabled}'), 'discardPending must reach the actual table editor instead of a visual overlay')
assert.ok(!manualInspectorSource.includes('manual-block-inspector-disabled-cover'), 'the inspector must not fake table disabling with an overlay')
const tableEditorCallers = fs.readdirSync(path.join(root, 'src/renderer/src'), { recursive: true })
  .filter((entry) => typeof entry === 'string' && entry.endsWith('.tsx'))
  .map((entry) => path.join(root, 'src/renderer/src', entry))
  .filter((sourcePath) => sourcePath !== tableEditorPath && fs.readFileSync(sourcePath, 'utf8').includes('<FacsimileTableEditor'))
  .sort()
assert.deepStrictEqual(
  tableEditorCallers.map((sourcePath) => path.relative(root, sourcePath).replace(/\\/g, '/')),
  ['src/renderer/src/components/ManualBlockInspector.tsx'],
  'every FacsimileTableEditor call site must be explicit and the sole current caller must forward disabled state',
)

runAsyncDraftChecks()
  .then(() => console.log('Facsimile layout editor regression passed.'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

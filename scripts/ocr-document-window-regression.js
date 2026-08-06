const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-document-window-'))

async function bundle(entry, outfile) {
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  return require(outfile)
}

async function main() {
  const schedulerBundle = path.join(tempRoot, 'scheduler.cjs')
  const summaryBundle = path.join(tempRoot, 'summary.cjs')
  const { SlidingWindowScheduler } = await bundle(
    path.join(root, 'src/main/ocr-document-window.ts'),
    schedulerBundle,
  )
  const { buildOcrActivitySummary } = await bundle(
    path.join(root, 'src/renderer/src/utils/ocrActivitySummary.ts'),
    summaryBundle,
  )

  const scheduler = new SlidingWindowScheduler()
  assert.deepStrictEqual(
    scheduler.getSnapshot(),
    { activeCount: 0, queuedCount: 0, documentTailCount: 0 },
    'scheduler should expose an empty queue snapshot before work starts',
  )
  const releases = []
  const started = []
  let active = 0
  let peak = 0
  const tasks = Array.from({ length: 8 }, (_, index) => scheduler.run(5, async () => {
    started.push(index)
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => releases[index] = resolve)
    active -= 1
  }))

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(started, [0, 1, 2, 3, 4], 'only five documents may start initially')
  releases[2]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(started, [0, 1, 2, 3, 4, 5], 'the next document should fill the first released slot immediately')
  assert.strictEqual(peak, 5, 'global OCR document concurrency must never exceed the configured window')
  started.forEach((index) => releases[index]?.())
  await new Promise((resolve) => setImmediate(resolve))
  for (let index = 0; index < releases.length; index += 1) releases[index]?.()
  await Promise.all(tasks)

  const heavyScheduler = new SlidingWindowScheduler()
  const heavyReleases = []
  const heavyStarted = []
  const heavyTasks = Array.from({ length: 4 }, (_, index) => heavyScheduler.run(2, async () => {
    heavyStarted.push(index)
    await new Promise((resolve) => { heavyReleases[index] = resolve })
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(heavyStarted, [0, 1], 'large PDFs should retain a bounded two-document window')
  heavyReleases[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(heavyStarted, [0, 1, 2], 'the next large PDF should start when one bounded slot is released')
  heavyStarted.forEach((index) => heavyReleases[index]?.())
  await new Promise((resolve) => setImmediate(resolve))
  for (let index = 0; index < heavyReleases.length; index += 1) heavyReleases[index]?.()
  await Promise.all(heavyTasks)

  const combinedTotalScheduler = new SlidingWindowScheduler()
  const combinedHeavyScheduler = new SlidingWindowScheduler()
  const combinedHeavyStarted = []
  const combinedOrdinaryStarted = []
  let combinedActive = 0
  let combinedPeak = 0
  let releaseCombined
  const combinedBarrier = new Promise((resolve) => { releaseCombined = resolve })
  const combinedHeavyTasks = Array.from({ length: 3 }, (_, index) => combinedHeavyScheduler.run(2, () => (
    combinedTotalScheduler.run(4, async () => {
      combinedHeavyStarted.push(index)
      combinedActive += 1
      combinedPeak = Math.max(combinedPeak, combinedActive)
      await combinedBarrier
      combinedActive -= 1
    })
  )))
  const combinedOrdinaryTasks = Array.from({ length: 3 }, (_, index) => combinedTotalScheduler.run(4, async () => {
    combinedOrdinaryStarted.push(index)
    combinedActive += 1
    combinedPeak = Math.max(combinedPeak, combinedActive)
    await combinedBarrier
    combinedActive -= 1
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(combinedHeavyStarted, [0, 1], 'the heavy sub-window should enforce its own limit')
  assert.deepStrictEqual(combinedOrdinaryStarted, [0, 1], 'ordinary documents should fill unused total OCR slots')
  assert.strictEqual(combinedPeak, 4, 'the independent heavy limit must not shrink the configured total window')
  releaseCombined()
  await Promise.all([...combinedHeavyTasks, ...combinedOrdinaryTasks])

  const ownershipScheduler = new SlidingWindowScheduler()
  const ownershipStarted = []
  let releaseOwnedDocument
  const firstOwned = ownershipScheduler.runForDocument('doc-shared', 2, async () => {
    ownershipStarted.push('first')
    await new Promise((resolve) => { releaseOwnedDocument = resolve })
  })
  const secondOwned = ownershipScheduler.runForDocument('doc-shared', 2, async () => {
    ownershipStarted.push('second')
  })
  const otherOwned = ownershipScheduler.runForDocument('doc-other', 2, async () => {
    ownershipStarted.push('other')
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepStrictEqual(
    ownershipStarted,
    ['first', 'other'],
    'the same document must be serialized while a different document can use another slot',
  )
  releaseOwnedDocument()
  await Promise.all([firstOwned, secondOwned, otherOwned])
  assert.deepStrictEqual(ownershipStarted, ['first', 'other', 'second'])

  const releasableScheduler = new SlidingWindowScheduler()
  let forceRelease
  const forcedRelease = new Promise((resolve) => { forceRelease = resolve })
  const hung = releasableScheduler.runForDocument(
    'doc-hung',
    1,
    async () => new Promise(() => undefined),
    forcedRelease,
  )
  let followerStarted = false
  const follower = releasableScheduler.runForDocument('doc-follower', 1, async () => {
    followerStarted = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(followerStarted, false)
  forceRelease()
  await Promise.all([hung, follower])
  assert.strictEqual(followerStarted, true, 'forced cancellation must release a hung global OCR slot')

  const cancelQueuedScheduler = new SlidingWindowScheduler()
  let releaseCancelQueued
  const cancelQueuedBarrier = new Promise((resolve) => { releaseCancelQueued = resolve })
  const cancelQueuedStarted = []
  const cancelQueuedRunning = cancelQueuedScheduler.run(1, async () => {
    cancelQueuedStarted.push('running')
    await cancelQueuedBarrier
  })
  const cancelQueuedFollowers = [0, 1, 2].map((index) => cancelQueuedScheduler.run(1, async () => {
    cancelQueuedStarted.push(index)
  }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.strictEqual(cancelQueuedScheduler.getSnapshot().queuedCount, 3)
  assert.strictEqual(cancelQueuedScheduler.cancelQueued(), 3, 'cancelQueued should remove all not-yet-started work')
  assert.strictEqual(cancelQueuedScheduler.getSnapshot().queuedCount, 0)
  releaseCancelQueued()
  await Promise.all([cancelQueuedRunning, ...cancelQueuedFollowers])
  assert.deepStrictEqual(cancelQueuedStarted, ['running'], 'cancelQueued must not start canceled work')

  assert.strictEqual(
    buildOcrActivitySummary([
      { status: 'processing' },
      { status: 'processing' },
      { status: 'queued' },
      { status: 'queued' },
      { status: 'completed' },
    ]),
    'OCR：2 篇处理中，2 篇等待',
  )
  assert.strictEqual(
    buildOcrActivitySummary([
      { status: 'processing', title: '甲书' },
      { status: 'processing', title: '乙书' },
      { status: 'queued', title: '丙书' },
    ]),
    'OCR：2 篇处理中，1 篇等待 · 正在处理 《甲书》、《乙书》',
  )

  const libraryView = fs.readFileSync(path.join(root, 'src/renderer/src/views/LibraryView.tsx'), 'utf8')
  const ocrIpc = fs.readFileSync(path.join(root, 'src/main/ipc/ocr.ts'), 'utf8')
  const batchProcessor = fs.readFileSync(path.join(root, 'src/main/batch-processor.ts'), 'utf8')
  const manualBatchHandler = ocrIpc.slice(
    ocrIpc.indexOf("ipcMain.handle('documents:batchOcr'"),
    ocrIpc.indexOf("ipcMain.handle('pages:rerunOcr'"),
  )
  assert.ok(libraryView.includes("const OCR_ACTIVITY_MESSAGE_KEY = 'ocr-activity'"), 'Library should use one aggregate OCR message key')
  assert.ok(
    libraryView.includes('buildLibraryOcrActivitySummary(Object.values(nextProgressByDoc), documentsRef.current)'),
    'Library should aggregate document progress with active document titles',
  )
  assert.ok(!libraryView.includes('message.loading({\n          content: getOcrProgressText(nextInfo),\n          key: toastKey'), 'Library must not open one persistent toast per document')
  assert.ok(
    ocrIpc.includes('runBoundedDocumentWorkers')
      && ocrIpc.includes('runOcrDocumentInConfiguredWindows')
      && ocrIpc.includes('globalOcrDocumentWindow.runForDocument(')
      && ocrIpc.includes('getOcrDocumentConcurrency'),
    'automatic and manual OCR should share document ownership and the global window via the bounded worker pool',
  )
  assert.ok(
    ocrIpc.includes('getOcrQueueWaitMessage')
      && ocrIpc.includes('任务可能位于其他项目或筛选结果中')
      && ocrIpc.includes('releaseAbortedOcrRuntimeSlots'),
    'queued OCR cards should explain the shared wait state and release already-aborted runtime slots',
  )
  assert.ok(
    ocrIpc.includes('heavyPdfOcrDocumentWindow.run(getOcrHeavyPdfDocumentConcurrency(), runInTotalWindow)')
      && ocrIpc.includes('documentConcurrency,')
      && !ocrIpc.includes('HEAVY_PDF_DOCUMENT_CONCURRENCY'),
    'large PDFs should use a configurable sub-window without shrinking the total OCR window',
  )
  assert.ok(
    batchProcessor.includes('globalOcrDocumentWindow.runForDocument(docId, getOcrDocumentConcurrency()'),
    'legacy resumed OCR should share document ownership and the global window',
  )
  const importAutoWorker = ocrIpc.slice(
    ocrIpc.indexOf('async function runImportAutoOcrTask'),
    ocrIpc.indexOf('function startImportAutoOcrTaskRun'),
  )
  const importAutoAcquireIndex = importAutoWorker.indexOf('await acquireDocumentOcrSlot(docId)')
  assert.ok(
    importAutoAcquireIndex >= 0
      && importAutoWorker.indexOf('await processImportAutoOcrClaim(', importAutoAcquireIndex) > importAutoAcquireIndex
      && ocrIpc.includes('activeTask.done,')
      && manualBatchHandler.includes('}, activeTask.done)'),
    'document ownership must precede the global slot, and forced cancel must release hung slots',
  )
  assert.ok(
    ocrIpc.includes('async function cancelPersistedOcrQueueForDocument')
      && ocrIpc.includes('await transactionAsync(() => {')
      && ocrIpc.includes('await cancelPersistedOcrQueueForDocument(safeDocId)'),
    'single-document OCR cancellation must wait asynchronously for SQLite before persisting queue and document state',
  )
  assert.ok(
    ocrIpc.includes('async function cancelAllPersistedOcrQueues')
      && ocrIpc.includes('const summary = await cancelAllPersistedOcrQueues()')
      && ocrIpc.includes('globalOcrDocumentWindow.cancelQueued()')
      && ocrIpc.includes('heavyPdfOcrDocumentWindow.cancelQueued()')
      && ocrIpc.includes('listResumableImportAutoOcrTasks(null)'),
    'cancel-all must use the same nonblocking SQLite writer-lock path',
  )
  const cancelHandler = ocrIpc.slice(
    ocrIpc.indexOf("ipcMain.handle('ocr:cancelDocument'"),
    ocrIpc.indexOf("ipcMain.handle('ocr:cancelAllPending'"),
  )
  assert.ok(
    cancelHandler.indexOf('forceReleaseActiveOcrTask(safeDocId)')
      < cancelHandler.indexOf('await cancelPersistedOcrQueueForDocument(safeDocId)'),
    'OCR cancellation must abort and release the live task before waiting for the database writer lock',
  )
  assert.ok(
    manualBatchHandler.indexOf("message: 'OCR 正在写入队列'")
      < manualBatchHandler.indexOf('await transactionAsync(() => {')
      && manualBatchHandler.indexOf('await transactionAsync(() => {')
        < manualBatchHandler.indexOf('createRecoverableBatchOcrItems(persistedChunk, documentConcurrency)')
      && manualBatchHandler.indexOf('createRecoverableBatchOcrItems(persistedChunk, documentConcurrency)')
        < manualBatchHandler.indexOf("['queued', 'processing', 'pending', null, now, ...persistedChunk]"),
    'Manual OCR should publish queue entry before atomically persisting recovery and document state under the acquired writer lock',
  )
  assert.ok(
    !manualBatchHandler.includes('transactionAsync(() => undefined')
      && ocrIpc.includes('async function updateRecoverableBatchOcrItem(')
      && ocrIpc.includes("await updateRecoverableBatchOcrItem(recoverableQueueItemIdsByDocId, docId, 'processing')")
      && ocrIpc.includes('OCR_QUEUE_WRITER_MAX_WAIT_MS = 5 * 60 * 1000')
      && ocrIpc.includes('OCR_QUEUE_STATUS_MAX_WAIT_MS = 5 * 1000')
      && ocrIpc.includes('maxWaitMs: OCR_QUEUE_STATUS_MAX_WAIT_MS')
      && ocrIpc.includes('Deferred recoverable queue status update'),
    'Initial queue persistence may wait for SQLite, but per-book recovery bookkeeping must fail open after a short wait',
  )
  assert.ok(
    ocrIpc.includes('onWorkerError?: (item: T, index: number, error: unknown)')
      && ocrIpc.includes('Bounded worker failed at item')
      && ocrIpc.includes('await onWorkerError?.(items[index], index, error)')
      && manualBatchHandler.includes('已跳过并继续后续文献'),
    'One unexpected document failure must be reported and skipped without terminating the remaining worker queue',
  )
  assert.ok(
    ocrIpc.includes('const completedAtProcessStart = completedBefore')
      && ocrIpc.includes('const madeForwardProgress = pageSummary.completed > completedAtProcessStart')
      && ocrIpc.includes('if (pageSummary.total > 0 && madeForwardProgress)')
      && ocrIpc.includes("UPDATE pages SET ocr_status = 'pending' WHERE doc_id = ? AND ocr_status IN ('queued', 'processing')")
      && !ocrIpc.includes("ocr_status IN ('error', 'queued', 'processing')"),
    'A hard retry failure must expose the real error while preserving genuine failed-page evidence and resetting only transient claims',
  )
  assert.ok(
    manualBatchHandler.indexOf('await runOcrDocumentInConfiguredWindows(docId, documentConcurrency, heavy, async () => {')
      < manualBatchHandler.indexOf('activeOcrTasks.set(docId, activeTask)')
      && manualBatchHandler.indexOf('activeOcrTasks.set(docId, activeTask)')
        < manualBatchHandler.indexOf("status: 'processing'")
      && manualBatchHandler.indexOf("status: 'queued'")
        < manualBatchHandler.indexOf('await runOcrDocumentInConfiguredWindows(docId, documentConcurrency, heavy, async () => {'),
    'New manual retry calls must remain visibly queued until the shared OCR window starts them, without preempting active books',
  )
  assert.ok(
    manualBatchHandler.includes('queuedOcrDocIds.delete(docId)')
      && manualBatchHandler.includes("message: 'OCR 入队失败'")
      && manualBatchHandler.includes('retry_count = 0, last_retry_at = NULL'),
    'Failed queue persistence must release in-memory queue slots and successful enqueue must atomically reset retry state',
  )

  console.log('OCR document sliding-window regression passed.')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))

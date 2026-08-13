const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let capabilityInputSequence = 0

async function importFilesWithCapabilities(win, filePaths) {
  const inputId = `ocr-status-capability-input-${++capabilityInputSequence}`
  await win.evaluate((id) => {
    const input = document.createElement('input')
    input.id = id
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
  }, inputId)
  try {
    await win.locator(`#${inputId}`).setInputFiles(filePaths)
    return await win.evaluate(async (id) => {
      const input = document.getElementById(id)
      const selection = await window.api.grantDroppedImportSources(Array.from(input?.files || []))
      if (!selection.ok) throw new Error(selection.error.message)
      const results = []
      let cursor = null
      try {
        while (true) {
          const page = await window.api.readImportSelectionBatch(selection.value.selectionId, cursor, 200)
          if (!page.ok) throw new Error(page.error.message)
          if (page.value.items.length > 0) {
            results.push(...await window.api.importDocuments(page.value.items.map((item) => item.grantId)))
          }
          if (page.value.done) break
          cursor = page.value.nextCursor
        }
      } finally {
        await window.api.releaseImportSelection(selection.value.selectionId)
      }
      return results
    }, inputId)
  } finally {
    await win.evaluate((id) => document.getElementById(id)?.remove(), inputId)
  }
}

async function run() {
  const userDataDir = path.join(os.tmpdir(), 'gujismart-ocr-status-user-' + Date.now())
  const profileDir = path.join(os.tmpdir(), 'gujismart-ocr-status-profile-' + Date.now())
  const dataDir = path.join(os.tmpdir(), 'gujismart-ocr-status-db-' + Date.now())
  const samplePath = path.join(userDataDir, 'library-ocr-status-reconcile.json')
  const reviewSamplePath = path.join(userDataDir, 'library-ocr-review-reconcile.json')
  const title = 'library ocr status reconcile regression'
  const reviewTitle = 'library ocr review reconcile regression'

  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(samplePath, JSON.stringify({
    title,
    doc_type: 'pdf',
    pages: Array.from({ length: 3 }, (_item, index) => {
      const pageNum = index + 1
      const text = `ocr status reconcile page ${pageNum}`
      return {
        page_num: pageNum,
        ocr_text: text,
        proofed_text: text,
        ocr_status: 'completed',
        ocr_result: {
          text,
          words_result: [{ words: text }],
          layout_result: [{
            label: 'text',
            words: text,
            location: { left: 40, top: 40, width: 520, height: 80 },
          }],
        },
      }
    }),
  }), 'utf8')
  fs.writeFileSync(reviewSamplePath, JSON.stringify({
    title: reviewTitle,
    doc_type: 'pdf',
    pages: Array.from({ length: 3 }, (_item, index) => {
      const pageNum = index + 1
      const text = `ocr review reconcile page ${pageNum}`
      return {
        page_num: pageNum,
        ocr_text: text,
        proofed_text: text,
        ocr_status: 'completed',
        ocr_result: {
          text,
          words_result: [{ words: text }],
        },
      }
    }),
  }), 'utf8')

  const app = await electron.launch({
    args: [
      '--disable-gpu',
      '--user-data-dir=' + userDataDir,
      '.',
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      GUJISMART_SMOKE: '1',
      GUJISMART_DATA_DIR: dataDir,
      GUJISMART_PROFILE_DIR: profileDir,
    },
  })

  try {
    const win = await app.firstWindow({ timeout: 20000 })
    await win.waitForLoadState('domcontentloaded')
    await win.waitForFunction(() => !!window.api, null, { timeout: 15000 })

    const importResults = await importFilesWithCapabilities(win, [samplePath])
    assert(Array.isArray(importResults) && importResults[0]?.success, `Import failed: ${JSON.stringify(importResults)}`)
    const docId = importResults[0].id

    const detail = await win.evaluate(async (id) => window.api.getDocument(id), docId)
    assert(detail?.pages?.length === 3, `Expected imported pages, saw ${JSON.stringify(detail)}`)
    const pagePatchResults = await win.evaluate(async (pages) => {
      const results = []
      for (const page of pages) {
        const text = `ocr status reconcile page ${page.page_num}`
        results.push(await window.api.updatePage(page.id, {
          ocr_text: text,
          proofed_text: '',
          ocr_status: 'pending',
        }))
      }
      return results
    }, detail.pages)
    assert(pagePatchResults.every(Boolean), `Failed to patch imported pages: ${JSON.stringify(pagePatchResults)}`)

    const lightAfterPagePatch = await win.evaluate(async (id) => window.api.getDocumentLight(id), docId)
    assert(
      lightAfterPagePatch?.pages?.every((page) => page.has_text),
      `Expected patched pages to have OCR text, saw ${JSON.stringify(lightAfterPagePatch?.pages)}`,
    )

    const patched = await win.evaluate(async (id) => window.api.updateDocument(id, {
      ocr_status: 'pending',
      import_status: 'stored',
      error_message: 'simulated stale document status',
    }), docId)
    assert(patched, 'Failed to simulate stale document OCR status')

    const completedPage = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr status reconcile',
      searchFields: ['title'],
      limit: 10,
      offset: 0,
    }))
    const listed = completedPage.items.find((item) => item.id === docId)
    assert(listed, `Expected reconciled document in normal list, saw ${JSON.stringify(completedPage)}`)
    assert(listed.ocr_status === 'completed', `Expected page-derived completed status, saw ${JSON.stringify(listed)}`)
    assert(listed.import_status === 'processed', `Expected page-derived processed import status, saw ${JSON.stringify(listed)}`)
    assert(!listed.error_message, `Expected stale error cleared, saw ${JSON.stringify(listed)}`)
    assert(Number(listed.text_page_count) === 3, `Expected empty proofed_text to fall back to ocr_text, saw ${JSON.stringify(listed)}`)

    const persistedDetail = await win.evaluate(async (id) => window.api.getDocument(id), docId)
    assert(persistedDetail?.ocr_status === 'completed', `Expected reconciled status persisted, saw ${JSON.stringify(persistedDetail)}`)
    assert(persistedDetail?.import_status === 'processed', `Expected reconciled import status persisted, saw ${JSON.stringify(persistedDetail)}`)

    const pendingPage = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr status reconcile',
      searchFields: ['title'],
      ocrStatus: 'pending',
      limit: 10,
      offset: 0,
    }))
    assert(!pendingPage.items.some((item) => item.id === docId), `Completed document leaked into pending filter: ${JSON.stringify(pendingPage)}`)

    const repairPageAfterReconcile = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr status reconcile',
      searchFields: ['title'],
      ocrNeedsRepair: true,
      limit: 10,
      offset: 0,
    }))
    assert(
      !repairPageAfterReconcile.items.some((item) => item.id === docId),
      `Document with usable OCR text leaked into OCR repair filter: ${JSON.stringify(repairPageAfterReconcile)}`,
    )
    assert(
      repairPageAfterReconcile.total === 0,
      `Document with usable OCR text inflated OCR repair count: ${JSON.stringify(repairPageAfterReconcile)}`,
    )
    const countsAfterReconcile = await win.evaluate(async () => window.api.refreshLibrarySmartViewCounts())
    assert(
      Number(countsAfterReconcile.ocrNeedsRepair || 0) === 0,
      `Sidebar OCR repair count retained a repaired document: ${JSON.stringify(countsAfterReconcile)}`,
    )

    const completedFilterPage = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr status reconcile',
      searchFields: ['title'],
      ocrStatus: 'completed',
      limit: 10,
      offset: 0,
    }))
    assert(completedFilterPage.items.some((item) => item.id === docId), `Reconciled document missing from completed filter: ${JSON.stringify(completedFilterPage)}`)

    const healthReport = await win.evaluate(async () => window.api.getDocumentHealthReport({ refresh: false }))
    const healthRow = healthReport.rows.find((row) => row.id === docId)
    assert(healthRow?.ocr_status === 'completed', `Expected health report to derive completed OCR status, saw ${JSON.stringify(healthRow)}`)
    assert(!healthReport.rows.some((row) => row.id === docId && row.ocr_status !== 'completed'), `Expected health report not to flag reconciled doc as incomplete: ${JSON.stringify(healthReport)}`)

    const reviewImportResults = await importFilesWithCapabilities(win, [reviewSamplePath])
    assert(Array.isArray(reviewImportResults) && reviewImportResults[0]?.success, `Review import failed: ${JSON.stringify(reviewImportResults)}`)
    const reviewDocId = reviewImportResults[0].id
    const reviewDetail = await win.evaluate(async (id) => window.api.getDocument(id), reviewDocId)
    assert(reviewDetail?.pages?.length === 3, `Expected review imported pages, saw ${JSON.stringify(reviewDetail)}`)
    const reviewPendingPage = reviewDetail.pages.find((page) => page.page_num === 3)
    assert(reviewPendingPage, 'Expected page 3 to exist for pending-page repair simulation')
    const pendingPageSaved = await win.evaluate(async (page) => window.api.updatePage(page.id, {
      ocr_text: '',
      ocr_result: null,
      proofed_text: '',
      ocr_status: 'pending',
    }), reviewPendingPage)
    assert(pendingPageSaved, 'Failed to simulate a pending OCR page')
    const pendingDocumentSaved = await win.evaluate(async (id) => window.api.updateDocument(id, {
      ocr_status: 'completed',
      import_status: 'processed',
      error_message: null,
    }), reviewDocId)
    assert(pendingDocumentSaved, 'Failed to simulate completed document with a pending OCR page')
    const pendingRepairPage = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr review reconcile',
      searchFields: ['title'],
      ocrNeedsRepair: true,
      limit: 10,
      offset: 0,
    }))
    const pendingRepairListed = pendingRepairPage.items.find((item) => item.id === reviewDocId)
    assert(pendingRepairListed, `Pending OCR page was missing from OCR repair filter: ${JSON.stringify(pendingRepairPage)}`)
    assert(
      String(pendingRepairListed.error_message || '').includes('OCR待修复')
        && String(pendingRepairListed.error_message || '').includes('3')
        && Number(pendingRepairListed.text_page_count) === 2,
      `Pending OCR page should expose a repair message and page-derived counts: ${JSON.stringify(pendingRepairListed)}`,
    )
    const reviewPagePatchResults = await win.evaluate(async (pages) => {
      const results = []
      for (const page of pages) {
        if (page.page_num === 3) {
          results.push(await window.api.updatePage(page.id, {
            ocr_text: '',
            ocr_result: {
              error: 'simulated page quality issue',
              failed_at: new Date().toISOString(),
            },
            proofed_text: '',
            ocr_status: 'error',
          }))
        }
      }
      return results
    }, reviewDetail.pages)
    assert(reviewPagePatchResults.every(Boolean), `Failed to patch review page status: ${JSON.stringify(reviewPagePatchResults)}`)

    const reviewPatched = await win.evaluate(async (id) => window.api.updateDocument(id, {
      ocr_status: 'error',
      import_status: 'error',
      error_message: '第 3 页：simulated page quality issue',
    }), reviewDocId)
    assert(reviewPatched, 'Failed to simulate old document-level OCR failure with settled page error')

    const reviewListPage = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr review reconcile',
      searchFields: ['title'],
      limit: 10,
      offset: 0,
    }))
    const reviewListed = reviewListPage.items.find((item) => item.id === reviewDocId)
    assert(reviewListed, `Expected review document in normal list, saw ${JSON.stringify(reviewListPage)}`)
    assert(reviewListed.ocr_status === 'completed', `Expected review document to normalize to completed, saw ${JSON.stringify(reviewListed)}`)
    assert(reviewListed.import_status === 'processed', `Expected review document to normalize to processed, saw ${JSON.stringify(reviewListed)}`)
    assert(
      String(reviewListed.error_message || '').includes('OCR待修复')
        && String(reviewListed.error_message || '').includes('OCR 未成功')
        && String(reviewListed.error_message || '').includes('3'),
      `Expected short review warning listing failed page nums, saw ${JSON.stringify(reviewListed)}`,
    )

    const reviewPersistedDetail = await win.evaluate(async (id) => window.api.getDocument(id), reviewDocId)
    assert(reviewPersistedDetail?.ocr_status === 'completed', `Expected review normalized status persisted, saw ${JSON.stringify(reviewPersistedDetail)}`)
    assert(reviewPersistedDetail?.import_status === 'processed', `Expected review normalized import status persisted, saw ${JSON.stringify(reviewPersistedDetail)}`)
    assert(
      String(reviewPersistedDetail?.error_message || '').includes('OCR待修复')
        && String(reviewPersistedDetail?.error_message || '').includes('OCR 未成功'),
      `Expected short review warning persisted, saw ${JSON.stringify(reviewPersistedDetail)}`,
    )

    const reviewRepairPage = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr review reconcile',
      searchFields: ['title'],
      ocrNeedsRepair: true,
      limit: 10,
      offset: 0,
    }))
    assert(
      reviewRepairPage.items.some((item) => item.id === reviewDocId),
      `Genuine failed page was missing from OCR repair filter: ${JSON.stringify(reviewRepairPage)}`,
    )
    const countsWithGenuineFailure = await win.evaluate(async () => window.api.refreshLibrarySmartViewCounts())
    assert(
      Number(countsWithGenuineFailure.ocrNeedsRepair || 0) === 1,
      `Sidebar OCR repair count missed the genuine failed document: ${JSON.stringify(countsWithGenuineFailure)}`,
    )

    const repairedReviewPage = reviewDetail.pages.find((page) => page.page_num === 3)
    assert(repairedReviewPage, 'Expected page 3 to exist for manual OCR repair simulation')
    const repairedPageSaved = await win.evaluate(async (page) => {
      const text = 'manually repaired review page text'
      return window.api.updatePage(page.id, {
        ocr_text: text,
        proofed_text: text,
        ocr_result: {
          layout_result: [{
            manual_block_id: `manual-${page.id}-ocr-repair`,
            segmentation_source: 'manual',
            label: 'text',
            words: text,
            location: { left: 40, top: 40, width: 520, height: 80 },
          }],
          words_result: [{ words: text }],
        },
      })
    }, repairedReviewPage)
    assert(repairedPageSaved, 'Failed to persist manually repaired OCR page')

    const manuallyRepairedDetail = await win.evaluate(async (id) => window.api.getDocument(id), reviewDocId)
    const manuallyRepairedPage = manuallyRepairedDetail?.pages?.find((page) => page.page_num === 3)
    assert(
      manuallyRepairedPage?.ocr_status === 'completed',
      `Manual text save should complete the repaired page without a separate OCR action: ${JSON.stringify(manuallyRepairedPage)}`,
    )
    assert(
      manuallyRepairedDetail?.ocr_status === 'completed'
        && manuallyRepairedDetail?.import_status === 'processed'
        && !manuallyRepairedDetail?.error_message,
      `Manual text save should clear the document-level OCR repair state immediately: ${JSON.stringify(manuallyRepairedDetail)}`,
    )
    const repairPageAfterStaleError = await win.evaluate(async () => window.api.listDocumentsPage({
      search: 'library ocr review reconcile',
      searchFields: ['title'],
      ocrNeedsRepair: true,
      limit: 10,
      offset: 0,
    }))
    assert(
      !repairPageAfterStaleError.items.some((item) => item.id === reviewDocId),
      `Manually repaired page leaked into OCR repair filter: ${JSON.stringify(repairPageAfterStaleError)}`,
    )
    const countsAfterStaleErrorRepair = await win.evaluate(async () => window.api.refreshLibrarySmartViewCounts())
    assert(
      Number(countsAfterStaleErrorRepair.ocrNeedsRepair || 0) === 0,
      `Sidebar OCR repair count retained a manually repaired page: ${JSON.stringify(countsAfterStaleErrorRepair)}`,
    )

    console.log('Library OCR status reconcile regression passed.')
  } finally {
    await app.close()
  }
}

run()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    console.error('Library OCR status reconcile regression failed.')
    console.error(error)
    process.exit(1)
  })

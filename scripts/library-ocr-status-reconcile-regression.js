const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run() {
  const userDataDir = path.join(os.tmpdir(), 'gujismart-ocr-status-user-' + Date.now())
  const profileDir = path.join(os.tmpdir(), 'gujismart-ocr-status-profile-' + Date.now())
  const dataDir = path.join(os.tmpdir(), 'gujismart-ocr-status-db-' + Date.now())
  const samplePath = path.join(userDataDir, 'library-ocr-status-reconcile.json')
  const title = 'library ocr status reconcile regression'

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

    const importResults = await win.evaluate(async (filePath) => window.api.importDocuments([filePath]), samplePath)
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

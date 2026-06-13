const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run() {
  const userDataDir = path.join(os.tmpdir(), 'gujismart-structured-ocr-user-' + Date.now())
  const dataDir = path.join(os.tmpdir(), 'gujismart-structured-ocr-db-' + Date.now())
  const samplePath = path.join(userDataDir, 'source-structured-ocr-regression.json')
  const layoutOnlyText = 'structured OCR layout-only reader marker'
  const tableCellText = 'structured OCR table cell marker'
  const rawLayoutOnlyText = 'structured OCR raw-layout recovered marker'
  const rawLayoutMissingText = 'structured OCR raw-layout missing line marker'
  const repeatedOcrLine = 'structured OCR repeated line marker'
  const htmlTableHeader = '学習科目'
  const htmlTableBody = '国民科'
  const htmlTableTail = '算数'

  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(samplePath, JSON.stringify({
    title: 'source-structured-ocr-regression',
    doc_type: 'pdf',
    pages: [{
      page_num: 1,
      layout_result: [
        {
          label: 'text',
          words: layoutOnlyText,
          location: { left: 80, top: 120, width: 520, height: 80 },
        },
        {
          label: 'table',
          rows: [['A', tableCellText]],
          location: { left: 80, top: 240, width: 520, height: 120 },
        },
        {
          label: 'table',
          words: `${htmlTableTail}\t6\t6\t6\t6\n体育\t3\t3\t3\t3\n音楽`,
          rows: [[htmlTableTail, '6', '6', '6', '6'], ['体育', '3', '3', '3', '3'], ['音楽']],
          html: `<table><tr><td>${htmlTableHeader}</td><td>第一学年</td><td>第二学年</td><td>第三学年</td><td>第四学年</td></tr><tr><td>${htmlTableBody}</td><td>13</td><td>14</td><td>15</td><td>17</td></tr><tr><td>${htmlTableTail}</td><td>6</td><td>6</td><td>6</td><td>6</td></tr><tr><td>体育</td><td rowspan="2">3</td><td rowspan="2">3</td><td rowspan="2">3</td><td rowspan="2">3</td></tr><tr><td>音楽</td></tr></table>`,
          table_html: `<table><tr><td>${htmlTableHeader}</td><td>第一学年</td><td>第二学年</td><td>第三学年</td><td>第四学年</td></tr><tr><td>${htmlTableBody}</td><td>13</td><td>14</td><td>15</td><td>17</td></tr><tr><td>${htmlTableTail}</td><td>6</td><td>6</td><td>6</td><td>6</td></tr><tr><td>体育</td><td rowspan="2">3</td><td rowspan="2">3</td><td rowspan="2">3</td><td rowspan="2">3</td></tr><tr><td>音楽</td></tr></table>`,
          location: { left: 80, top: 380, width: 620, height: 180 },
        },
      ],
    },
    {
      page_num: 2,
      layout_result: [
        {
          label: 'text',
          words: 'short incomplete layout marker',
          location: { left: 420, top: 100, width: 24, height: 120 },
        },
      ],
      raw_layout_result: [
        {
          label: 'vertical_text',
          words: rawLayoutOnlyText,
          location: { left: 420, top: 100, width: 24, height: 180 },
        },
        {
          label: 'vertical_text',
          words: rawLayoutMissingText,
          location: { left: 380, top: 100, width: 24, height: 180 },
        },
        {
          label: 'vertical_text',
          words: 'structured OCR raw-layout filler alpha beta gamma delta epsilon zeta',
          location: { left: 340, top: 100, width: 24, height: 180 },
        },
      ],
    },
    {
      page_num: 3,
      layout_result: [
        {
          label: 'text',
          words: Array.from({ length: 32 }, () => repeatedOcrLine).join('\n'),
          location: { left: 80, top: 120, width: 520, height: 320 },
        },
      ],
    }],
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
    },
  })

  try {
    const win = await app.firstWindow({ timeout: 20000 })
    await win.waitForLoadState('domcontentloaded')
    await win.waitForFunction(() => !!window.api && !!window.__smokeOpenDocument, null, { timeout: 15000 })

    const importResults = await win.evaluate(async (filePath) => window.api.importDocuments([filePath]), samplePath)
    assert(Array.isArray(importResults) && importResults[0]?.success, `Import failed: ${JSON.stringify(importResults)}`)
    const docId = importResults[0].id

    const metadata = await win.evaluate(async (id) => {
      const light = await window.api.getDocumentLight(id)
      const readingWindow = await window.api.getDocumentReadingWindow(id, 0, 1)
      return {
        lightHasText: light?.pages?.[0]?.has_text,
        lightHasOcrResult: light?.pages?.[0]?.has_ocr_result,
        fullOcrText: readingWindow?.pages?.[0]?.ocr_text,
        fullHasOcrText: readingWindow?.pages?.[0]?.has_ocr_text,
        fullOcrResult: readingWindow?.pages?.[0]?.ocr_result,
      }
    }, docId)
    assert(!String(metadata.fullOcrText || '').trim(), `Expected no inline ocr_text, saw ${JSON.stringify(metadata)}`)
    assert(Boolean(metadata.lightHasOcrResult), `Expected light page to expose structured OCR result, saw ${JSON.stringify(metadata)}`)
    assert(Boolean(metadata.fullHasOcrText), `Expected reading window to mark structured OCR as readable, saw ${JSON.stringify(metadata)}`)

    await win.evaluate((id) => window.__smokeOpenDocument({ docId: id }), docId)
    try {
      await win.waitForFunction(({ bodyText, tableText }) => {
        const text = document.querySelector('main')?.textContent || ''
        return text.includes(bodyText) && text.includes(tableText)
      }, { bodyText: layoutOnlyText, tableText: tableCellText }, { timeout: 20000 })
    } catch (error) {
      const snapshot = await win.evaluate(() => ({
        mainText: (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1600),
        sourceReaderVisible: !!document.querySelector('[data-source-reader-page="true"]'),
        readerScrollVisible: !!document.querySelector('[data-reader-scroll="true"]'),
        emptyText: document.querySelector('.ant-empty-description')?.textContent || '',
        spinnerCount: document.querySelectorAll('.ant-spin').length,
      }))
      throw new Error(`Reader did not show structured OCR text. Snapshot: ${JSON.stringify(snapshot)}; ${error.message}`)
    }

    const state = await win.evaluate(() => ({
      sourceReaderVisible: !!document.querySelector('[data-source-reader-page="true"]'),
      text: (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim(),
      spinnerCount: document.querySelectorAll('.ant-spin').length,
    }))
    assert(state.sourceReaderVisible, `Expected source-page reader, saw ${JSON.stringify(state)}`)
    assert(state.text.includes(layoutOnlyText), `Expected body text in reader, saw ${JSON.stringify(state)}`)
    assert(state.text.includes(tableCellText), `Expected table text in reader, saw ${JSON.stringify(state)}`)
    assert(state.text.includes(htmlTableHeader), `Expected HTML table header in reader, saw ${JSON.stringify(state)}`)
    assert(state.text.includes(htmlTableBody), `Expected HTML table body row in reader, saw ${JSON.stringify(state)}`)
    assert(state.text.includes(htmlTableTail), `Expected HTML table tail row in reader, saw ${JSON.stringify(state)}`)

    const tableState = await win.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('[data-source-anchor="true"] table'))
      return tables.map((table) => ({
        rows: table.querySelectorAll('tr').length,
        firstRowCells: table.querySelector('tr')?.querySelectorAll('td').length || 0,
        lastRowCells: table.querySelector('tr:last-child')?.querySelectorAll('td').length || 0,
        text: (table.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
    })
    const restoredTable = tableState.find((table) => table.text.includes(htmlTableHeader))
    assert(restoredTable?.rows >= 5, `Expected restored HTML table rows, saw ${JSON.stringify(tableState)}`)
    assert(restoredTable?.firstRowCells === 5, `Expected restored HTML table columns, saw ${JSON.stringify(tableState)}`)
    assert(restoredTable?.lastRowCells === 5, `Expected rowspan-expanded final row columns, saw ${JSON.stringify(tableState)}`)

    await win.evaluate((id) => window.__smokeOpenDocument({ docId: id, pageIndex: 1 }), docId)
    await win.waitForFunction((marker) => (document.querySelector('main')?.textContent || '').includes(marker), rawLayoutMissingText, { timeout: 12000 })
    const rawLayoutState = await win.evaluate(() => ({
      text: (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim(),
      anchorCount: document.querySelectorAll('[data-source-anchor="true"]').length,
    }))
    assert(rawLayoutState.text.includes(rawLayoutOnlyText), `Expected raw layout text in reader, saw ${JSON.stringify(rawLayoutState)}`)
    assert(rawLayoutState.text.includes(rawLayoutMissingText), `Expected raw-only missing text in reader, saw ${JSON.stringify(rawLayoutState)}`)

    await win.evaluate((id) => window.__smokeOpenDocument({ docId: id, pageIndex: 2 }), docId)
    await win.waitForFunction((marker) => (document.querySelector('main')?.textContent || '').includes(marker), repeatedOcrLine, { timeout: 12000 })
    const repeatedState = await win.evaluate((marker) => {
      const text = (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim()
      const anchorText = Array.from(document.querySelectorAll('[data-source-anchor="true"]'))
        .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
        .join('\n')
      return {
        text,
        occurrences: anchorText.split(marker).length - 1,
      }
    }, repeatedOcrLine)
    assert(repeatedState.occurrences === 1, `Expected repeated OCR line to render once, saw ${JSON.stringify(repeatedState)}`)

    console.log('Source structured OCR regression passed.')
  } finally {
    await app.close()
  }
}

run().catch((error) => {
  console.error('Source structured OCR regression failed.')
  console.error(error)
  process.exit(1)
})

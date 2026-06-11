const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, '')
}

async function run() {
  const userDataDir = path.join(os.tmpdir(), 'gujismart-footnote-user-' + Date.now())
  const dataDir = path.join(os.tmpdir(), 'gujismart-footnote-db-' + Date.now())
  const samplePath = path.join(userDataDir, 'source-footnote-regression.json')
  const numberedBody = '3. Body numbered paragraph must stay in the main reader flow.'
  const realFootnote = '1. Real footnote should be rendered in the footnote area.'

  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(samplePath, JSON.stringify({
    title: 'source-footnote-regression',
    doc_type: 'pdf',
    pages: [{
      page_num: 1,
      proofed_text: `${numberedBody}\n\n${realFootnote}`,
      ocr_result: {
        text: `${numberedBody}\n\n${realFootnote}`,
        layout_result: [
          {
            label: 'text',
            words: numberedBody,
            location: { left: 80, top: 120, width: 520, height: 80 },
          },
          {
            label: 'footnote',
            words: realFootnote,
            location: { left: 80, top: 640, width: 520, height: 40 },
          },
        ],
      },
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
    await win.evaluate((docId) => window.__smokeOpenDocument({ docId }), importResults[0].id)
    try {
      await win.waitForFunction((text) => (document.querySelector('main')?.textContent || '').includes(text), numberedBody, { timeout: 18000 })
    } catch (error) {
      const snapshot = await win.evaluate(() => ({
        mainText: (document.querySelector('main')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
        hasSourceReader: !!document.querySelector('[data-source-reader-page="true"]'),
        hasReaderScroll: !!document.querySelector('[data-reader-scroll="true"]'),
        pageCount: document.querySelectorAll('[data-reader-page="true"]').length,
        emptyText: document.querySelector('.ant-empty-description')?.textContent || '',
      }))
      throw new Error(`Reader did not show numbered body paragraph. Snapshot: ${JSON.stringify(snapshot)}`)
    }

    const state = await win.evaluate(({ numberedBody, realFootnote }) => {
      const bodyAnchor = Array.from(document.querySelectorAll('[data-source-anchor="true"]'))
        .find((node) => (node.textContent || '').includes(numberedBody))
      const footnoteSections = Array.from(document.querySelectorAll('section[aria-label="footnotes"]'))
      const footnoteText = footnoteSections.map((node) => node.textContent || '').join('\n')
      const compact = (value) => String(value || '').replace(/\s+/g, '')
      return {
        sourceReaderVisible: !!document.querySelector('[data-source-reader-page="true"]'),
        bodyAnchorText: bodyAnchor?.textContent || '',
        bodyInFootnote: !!bodyAnchor?.closest('section[aria-label="footnotes"]'),
        footnoteText,
        footnoteHasRealNote: compact(footnoteText).includes(compact(realFootnote)),
        footnoteHasNumberedBody: compact(footnoteText).includes(compact(numberedBody)),
      }
    }, { numberedBody, realFootnote })

    assert(state.sourceReaderVisible, `Expected source reader page, saw ${JSON.stringify(state)}`)
    assert(compactText(state.bodyAnchorText).includes(compactText(numberedBody)), `Expected numbered body anchor, saw ${JSON.stringify(state)}`)
    assert(!state.bodyInFootnote, `Numbered body paragraph was rendered as a footnote: ${JSON.stringify(state)}`)
    assert(state.footnoteHasRealNote, `Expected explicit footnote label to render as footnote: ${JSON.stringify(state)}`)
    assert(!state.footnoteHasNumberedBody, `Footnote area contains numbered body text: ${JSON.stringify(state)}`)

    console.log('Source footnote regression passed.')
  } finally {
    await app.close()
  }
}

run().catch((error) => {
  console.error('Source footnote regression failed.')
  console.error(error)
  process.exit(1)
})

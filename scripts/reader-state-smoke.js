const { _electron: electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForReaderPage(window, expectedPageNum) {
  await window.waitForFunction((pageNum) => {
    const text = document.querySelector('main')?.textContent || ''
    const currentLeaf = document.querySelector('[data-reader-scroll="true"]')?.getAttribute('data-reader-current-leaf')
    return currentLeaf === String(pageNum - 1) || text.includes(`reader state smoke page ${pageNum}`)
  }, expectedPageNum, { timeout: 8000 })
}

async function clickNextPage(window) {
  const dataButton = window.locator('[data-reader-page-next="true"]').first()
  if (await dataButton.count()) {
    await dataButton.click()
    return
  }
  const buttons = window.locator('button')
  const index = await buttons.evaluateAll((nodes) => nodes.findIndex((node) => (node.textContent || '').trim() === '下一页' && !node.disabled))
  assert(index >= 0, 'Missing enabled next page button')
  await buttons.nth(index).click()
}

async function jumpToReaderPage(window, pageNum) {
  const jumped = await window.evaluate((targetPageNum) => {
    const inputs = Array.from(document.querySelectorAll('input'))
    const pageInput = inputs.find((input) => {
      const value = String(input.value || '').trim()
      const rect = input.getBoundingClientRect()
      return rect.width > 40 && rect.width < 120 && /^\d+$/.test(value)
    })
    if (!pageInput) return false
    pageInput.focus()
    pageInput.value = String(targetPageNum)
    pageInput.dispatchEvent(new Event('input', { bubbles: true }))
    pageInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    pageInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }))
    pageInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))
    return true
  }, pageNum)
  assert(jumped, 'Missing reader page input')
}

async function run() {
  const userDataDir = path.join(os.tmpdir(), 'gujismart-reader-state-user-' + Date.now())
  const smokeDbDir = path.join(os.tmpdir(), 'gujismart-reader-state-db-' + Date.now())
  const samplePath = path.join(userDataDir, 'reader-state-smoke.json')

  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(samplePath, JSON.stringify({
    title: 'reader-state-smoke',
    pages: Array.from({ length: 6 }, (_item, index) => {
      const pageNum = index + 1
      const text = `reader state smoke page ${pageNum}\nThis page verifies reader history persistence.`
      return {
        page_num: pageNum,
        proofed_text: text,
        ocr_result: {
          text,
          words_result: [{ words: text }],
          layout_result: [{
            words: text,
            type: 'text',
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
      GUJISMART_DATA_DIR: smokeDbDir,
    },
  })

  try {
    const window = await app.firstWindow({ timeout: 20000 })
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(() => !!window.api && !!window.__smokeOpenDocument, null, { timeout: 15000 })

    const importResults = await window.evaluate(async (filePath) => window.api.importDocuments([filePath]), samplePath)
    assert(Array.isArray(importResults) && importResults[0]?.success, `Import failed: ${JSON.stringify(importResults)}`)
    const docId = importResults[0].id

    await window.evaluate((id) => window.__smokeOpenDocument({ docId: id }), docId)
    await waitForReaderPage(window, 1)

    await jumpToReaderPage(window, 4)
    await waitForReaderPage(window, 4)

    await window.locator('.document-back-button').click()
    await window.waitForFunction(() => {
      const text = document.querySelector('main')?.textContent || ''
      return !text.includes('reader state smoke page 4')
    }, null, { timeout: 8000 })

    const savedState = await window.evaluate(async (id) => window.api.getReaderState(id), docId)
    assert(savedState?.location_key === 'page:4', `Expected saved page:4, saw ${JSON.stringify(savedState)}`)

    await window.evaluate((id) => window.__smokeOpenDocument({ docId: id }), docId)
    await waitForReaderPage(window, 4)

    const restored = await window.evaluate(() => {
      const text = document.querySelector('main')?.textContent || ''
      const currentLeaf = document.querySelector('[data-reader-scroll="true"]')?.getAttribute('data-reader-current-leaf')
      return { text, currentLeaf }
    })
    assert(restored.text.includes('reader state smoke page 4') || restored.currentLeaf === '3', `Expected UI to restore page 4, saw ${JSON.stringify(restored)}`)

    console.log('Reader state smoke test passed.')
  } finally {
    await app.close()
  }
}

run().catch((error) => {
  console.error('Reader state smoke test failed.')
  console.error(error)
  process.exit(1)
})

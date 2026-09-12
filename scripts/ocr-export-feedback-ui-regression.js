// Real renderer/preload/IPC against an isolated library, without OCR or model requests.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: electron } = require('playwright')
const { enterResearchFixture } = require('./research-ui-fixture-startup')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-export-ui-'))
  const fixture = path.join(root, 'source.txt')
  fs.writeFileSync(fixture, '中文阅读导出样例\n这是一份虚构的界面回归材料，用于检查中文正文及末尾文字是否保留。\nTextEndMarker\n')
  const app = await electron.launch({ args: ['--disable-gpu', `--user-data-dir=${path.join(root, 'user')}`, '.'], cwd: path.join(__dirname, '..'),
    env: { ...process.env, GUJISMART_SMOKE: '1', GUJISMART_TEST_BACKGROUND: '1', GUJISMART_DATA_DIR: path.join(root, 'data'), GUJISMART_PROFILE_DIR: path.join(root, 'profile') } })
  try {
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await enterResearchFixture(page, true)
    await page.evaluate(() => window.api.setSetting('ocr_async_model', 'PaddleOCR-VL'))
    async function openOcrSettings() {
      await page.locator('.ant-menu-item').filter({ hasText: /^设置$/ }).click()
      await page.getByRole('navigation', { name: '设置分类' }).locator('button').filter({ hasText: /^OCR$/ }).click()
      await page.locator('.settings-provider-item:visible').filter({ hasText: '飞桨云端 OCR' }).click()
    }
    const model = page.locator('input[id="ocr_async_model"]:visible')
    await openOcrSettings()
    assert.equal(await model.inputValue(), 'PaddleOCR-VL')
    for (const value of ['PaddleOCR-VL-1.5', 'PP-StructureV3', 'PaddleOCR-VL']) {
      await model.fill(value)
      await model.press('Tab')
      await page.getByRole('button', { name: /保存设置/ }).click()
      await page.waitForFunction(async (expected) => (await window.api.getAllSettings()).ocr_async_model === expected, value)
      await page.getByText('设置已保存', { exact: true }).waitFor()
      await page.reload()
      await enterResearchFixture(page)
      await openOcrSettings()
      assert.equal(await model.inputValue(), value, 'saved model survives renderer reload')
    }
    await page.screenshot({ path: path.join(root, 'ocr-model-persisted.png') })
    await page.evaluate(() => {
      const input = document.createElement('input'); input.id = 'feedback-import'; input.type = 'file'; document.body.appendChild(input)
    })
    await page.locator('#feedback-import').setInputFiles(fixture)
    const docId = await page.evaluate(async () => {
      const grant = await window.api.grantDroppedImportSources(Array.from(document.querySelector('#feedback-import').files))
      if (!grant.ok) throw new Error(grant.error.message)
      try {
        const batch = await window.api.readImportSelectionBatch(grant.value.selectionId, null, 10)
        if (!batch.ok) throw new Error(batch.error.message)
        const [result] = await window.api.importDocuments(batch.value.items.map((item) => item.grantId))
        if (!result.success) throw new Error(result.error)
        return result.id
      } finally { await window.api.releaseImportSelection(grant.value.selectionId) }
    })
    const pdfPath = path.join(root, 'reading.pdf')
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, pdfPath)
    const start = Date.now()
    assert(await page.evaluate((id) => window.api.exportDocument(id, 'reading-pdf', { readingFontFamily: 'SimSun, serif' }), docId))
    const elapsedMs = Date.now() - start
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const loading = getDocument({ data: new Uint8Array(fs.readFileSync(pdfPath)), useSystemFonts: true })
    const pdf = await loading.promise
    let text = ''
    for (let index = 1; index <= pdf.numPages; index++) {
      const content = await (await pdf.getPage(index)).getTextContent()
      text += content.items.map((item) => item.str || '').join('')
    }
    assert(text.includes('中文阅读导出样例'), 'Chinese body must survive PDF export')
    assert(text.includes('TextEndMarker'), 'export must preserve the final text')
    await loading.destroy()
    assert.deepEqual(errors, [])
    console.log(`OCR settings save/reload and Chinese reading PDF export passed (${elapsedMs}ms). Fixtures: ${root}`)
  } catch (error) {
    const page = app.windows()[0]
    if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => undefined)
    console.error(`Failure fixture: ${root}`)
    throw error
  } finally { await app.close() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })

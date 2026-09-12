// Actual facsimile component with synthetic OCR and delayed saves; no database or paid services.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { _electron: electron } = require('playwright')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-facsimile-editing-'))
  buildSync({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import Editor from './src/renderer/src/components/GujiFacsimileProofreader';
    const initial = { layout_result: [
      { label: 'text', words: 'Original evidence', reading_order: 0, orientation: 'horizontal', location: { left: 40, top: 60, width: 500, height: 80 } },
      { label: 'table', words: 'Table evidence', rows: [['Table evidence', 'B']], reading_order: 1, location: { left: 40, top: 220, width: 500, height: 100 } }
    ] };
    window.fixture = { writes: [], fail: false };
    window.api = { getSetting: async () => null };
    function Fixture() {
      const [page, setPage] = useState({ id: 'page-a', ocr: initial });
      window.fixture.nextPage = () => setPage({ id: 'page-b', ocr: initial });
      return <Editor draftIdentity={page.id} pageId={page.id} ocrResult={page.ocr} coordinateSourceSize={{ width: 600, height: 800 }} onSave={async (id, payload) => {
        window.fixture.writes.push({ id, payload });
        await new Promise(resolve => setTimeout(resolve, 80));
        if (window.fixture.fail) throw new Error('Synthetic save failure');
        setPage(previous => previous.id === id ? { ...previous, ocr: JSON.parse(JSON.stringify(payload.ocr_result)) } : previous);
      }} />;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `, resolveDir: path.join(__dirname, '..'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(root, 'fixture.js'), logLevel: 'silent' })
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="fixture.css"></head><body><div id="root" style="height:94vh"></div><script src="fixture.js"></script></body></html>')
  fs.writeFileSync(path.join(root, 'main.cjs'), `process.on('uncaughtException', error => { console.error(error); process.exit(1); }); const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))}); app.whenReady().then(() => { const win = new BrowserWindow({ width: 1400, height: 1000, show: false }); win.loadFile(${JSON.stringify(path.join(root, 'index.html'))}); });`)
  const app = await electron.launch({ args: [path.join(root, 'main.cjs')], timeout: 15000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const undo = page.getByRole('button', { name: '撤销', exact: true })
    const redo = page.getByRole('button', { name: '重做', exact: true })
    const textBlock = page.locator('[data-guji-block-index="0"]')
    await textBlock.dblclick()
    const inspector = page.locator('[data-manual-block-inspector="true"]')
    await inspector.getByRole('textbox').fill('Corrected evidence')
    await page.getByText('已保存', { exact: true }).waitFor()
    assert(await undo.isEnabled(), 'text editing must be undoable after save acknowledgement')
    await undo.click()
    await page.waitForFunction(() => document.querySelector('[data-guji-block-index="0"]')?.textContent.includes('Original evidence'))
    await page.getByText('已保存', { exact: true }).waitFor()
    assert(await redo.isEnabled(), 'undo must preserve redo after saving')
    await redo.click()
    await page.waitForFunction(() => document.querySelector('[data-guji-block-index="0"]')?.textContent.includes('Corrected evidence'))
    await page.getByText('已保存', { exact: true }).waitFor()
    await textBlock.dblclick()
    await inspector.getByText('竖排', { exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await undo.click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await textBlock.dblclick()
    assert(await inspector.getByRole('radio', { name: '横排' }).isChecked(), 'orientation changes must undo with the block')
    await page.locator('[data-guji-block-index="1"]').dblclick()
    await inspector.locator('[data-table-row="0"][data-table-col="0"]').dblclick()
    const cellEditor = inspector.getByRole('textbox', { name: '编辑第 1 行第 A 列' })
    await cellEditor.fill('Corrected table cell')
    await cellEditor.press('Enter')
    await page.getByText('已保存', { exact: true }).waitFor()
    await undo.click()
    await page.waitForFunction(() => document.querySelector('[data-guji-block-index="1"]')?.textContent.includes('Table evidence'))
    await redo.click()
    await page.waitForFunction(() => document.querySelector('[data-guji-block-index="1"]')?.textContent.includes('Corrected table cell'))
    await page.getByText('已保存', { exact: true }).waitFor()
    await textBlock.dblclick()
    await page.evaluate(() => { window.fixture.fail = true })
    await inspector.getByRole('textbox').fill('Recoverable draft')
    await page.getByText('保存失败', { exact: true }).waitFor()
    assert.equal(await inspector.getByRole('textbox').inputValue(), 'Recoverable draft')
    await page.evaluate(() => { window.fixture.fail = false })
    await page.getByRole('button').filter({ hasText: /^重试$/ }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    const writes = await page.evaluate(() => window.fixture.writes)
    assert(writes.some(write => write.payload.proofed_text.includes('Corrected evidence')), 'saved correction must reach searchable page text')
    assert(writes.some(write => write.payload.proofed_text.includes('Corrected table cell')), 'edited table cells must reach searchable page text')
    assert(writes.at(-1).payload.proofed_text.includes('Recoverable draft'))
    await page.evaluate(() => window.fixture.nextPage())
    await page.waitForFunction(() => document.querySelector('[data-guji-block-index="0"]')?.textContent.includes('Original evidence'))
    assert(await undo.isDisabled(), 'undo history must not cross pages')
    assert(await redo.isDisabled(), 'redo history must not cross pages')
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(root, 'facsimile.png') })
    console.log('Facsimile editing UI passed: ' + root)
  } catch (error) {
    await (await app.firstWindow()).screenshot({ path: path.join(root, 'failure.png') })
    console.error('Facsimile fixture: ' + root)
    throw error
  } finally { await app.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })

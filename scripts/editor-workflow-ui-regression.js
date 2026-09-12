// Real editor in an isolated Electron window; no corpus, database or network.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')
const { _electron: electron } = require('playwright')

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-editor-workflow-'))
  buildSync({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import TextEditor from './src/renderer/src/components/TextEditor';
    const initial = { layout_result: [{ label: 'text', words: 'Original evidence', raw_words: 'Original evidence', reading_order: 0, location: { left: 10, top: 10, width: 300, height: 60 } }] };
    window.fixture = { writes: [], delay: 50 };
    function Fixture() {
      const [page, setPage] = useState({ id: 'page-a', ocr: initial, echo: undefined });
      window.fixture.external = () => setPage({ id: 'page-a', ocr: { layout_result: [{ ...initial.layout_result[0], words: 'External OCR', raw_words: 'External OCR' }] }, echo: undefined });
      window.fixture.nextPage = () => setPage({ id: 'page-b', ocr: initial, echo: undefined });
      return <TextEditor pageId={page.id} ocrResult={page.ocr} saveEchoToken={page.echo} onReset={() => {}} onSave={async (id, payload, token) => {
        window.fixture.writes.push({ id, payload });
        await new Promise(resolve => setTimeout(resolve, window.fixture.delay));
        setPage(previous => previous.id === id ? { ...previous, ocr: JSON.parse(JSON.stringify(payload.ocr_result)), echo: token } : previous);
        return true;
      }} />;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `, resolveDir: path.join(__dirname, '..'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', outfile: path.join(root, 'fixture.js'), logLevel: 'silent' })
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root" style="height:90vh"></div><script src="fixture.js"></script></body></html>')
  fs.writeFileSync(path.join(root, 'main.cjs'), `process.on('uncaughtException', error => { console.error(error); process.exit(1); }); const { app, BrowserWindow } = require('electron'); app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))}); app.whenReady().then(() => { const win = new BrowserWindow({ width: 1200, height: 900, show: false }); win.loadFile(${JSON.stringify(path.join(root, 'index.html'))}); });`)
  const app = await electron.launch({ args: [path.join(root, 'main.cjs')], timeout: 15000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } })
  try {
    const page = await app.firstWindow()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.getByText('Original evidence', { exact: true }).dblclick()
    await page.getByRole('textbox').fill('Corrected evidence')
    await page.getByRole('button', { name: /保存/ }).click()
    await page.waitForFunction(() => window.fixture.writes.length === 1)
    await page.waitForTimeout(160)
    assert(await page.getByTitle('撤销', { exact: true }).isEnabled(), 'server acknowledgement must preserve undo')
    await page.getByTitle('撤销', { exact: true }).click()
    await page.getByText('Original evidence', { exact: true }).waitFor()
    await page.waitForFunction(() => window.fixture.writes.length === 2)
    await page.waitForTimeout(160)
    assert(await page.getByTitle('重做', { exact: true }).isEnabled(), 'undo acknowledgement must preserve redo')
    await page.getByTitle('重做', { exact: true }).click()
    await page.waitForFunction(() => window.fixture.writes.length === 3)
    await page.waitForTimeout(160)
    await page.evaluate(() => { window.fixture.delay = 600 })
    await page.getByText('Corrected evidence', { exact: true }).dblclick()
    await page.getByRole('textbox').fill('Next saved evidence')
    await page.getByRole('button', { name: /保存/ }).click()
    await page.waitForFunction(() => window.fixture.writes.length === 4)
    await page.getByText('Next saved evidence', { exact: true }).dblclick()
    await page.getByRole('textbox').fill('Unsubmitted draft')
    await page.waitForTimeout(800)
    assert.equal(await page.getByRole('textbox').inputValue(), 'Unsubmitted draft', 'older save acknowledgement must not close current editing')
    await page.evaluate(() => window.fixture.external())
    await page.getByText('External OCR', { exact: true }).waitFor()
    assert(await page.getByTitle('撤销', { exact: true }).isDisabled(), 'actual external OCR replaces the baseline')
    await page.evaluate(() => window.fixture.nextPage())
    await page.getByText('Original evidence', { exact: true }).waitFor()
    assert(await page.getByTitle('撤销', { exact: true }).isDisabled(), 'history never crosses pages')
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(root, 'editor.png') })
    console.log(`Editor workflow UI passed. Screenshot: ${path.join(root, 'editor.png')}`)
  } catch (error) {
    await (await app.firstWindow()).screenshot({ path: path.join(root, 'failure.png') })
    console.error(`Editor failure screenshot: ${root}`)
    throw error
  } finally { await app.close() }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })

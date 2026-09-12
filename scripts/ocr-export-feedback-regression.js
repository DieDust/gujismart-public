// Synthetic fixtures only. --baseline checks the committed version before local fixes.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { execFileSync } = require('node:child_process')
const ts = require('typescript')
const { PDFDocument, PDFName } = require('pdf-lib')
const root = path.resolve(__dirname, '..')
const baseline = process.argv.includes('--baseline')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-export-feedback-'))
const failures = []

function source(file) {
  const text = baseline ? execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, file), 'utf8')
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}
function find(tree, predicate) {
  let found
  function visit(node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit) }
  visit(tree)
  assert(found, 'source fixture target must exist')
  return found
}
function functions(tree, names, context) {
  const code = names.map((name) => find(tree, (node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(tree)).join('\n')
  return vm.runInNewContext(ts.transpileModule(`${code}\nmodule.exports = { ${names.join(',')} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { module: { exports: {} }, ...context })
}
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`) } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) }
}
async function run() {
  const exportsSource = source('src/main/export.ts')
  const validators = functions(exportsSource, ['assertPdfHasNoType3Fonts', 'validateRenderedExport'], { readFileSync: fs.readFileSync, console })
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([100, 100])
  const glyph = pdf.context.register(pdf.context.stream('600 0 0 0 600 700 d1\n0 0 600 700 re f'))
  const font = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 600, 700],
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0], CharProcs: { A: glyph },
    Encoding: { Type: 'Encoding', Differences: [65, 'A'] }, FirstChar: 65, LastChar: 65, Widths: [600], Resources: {} }))
  page.node.setFontDictionary(PDFName.of('F1'), font)
  page.node.addContentStream(pdf.context.register(pdf.context.stream('BT /F1 12 Tf 10 10 Td (A) Tj ET')))
  const pdfPath = path.join(temp, 'type3.pdf')
  fs.writeFileSync(pdfPath, await pdf.save({ useObjectStreams: false }))
  assert.equal((await PDFDocument.load(fs.readFileSync(pdfPath))).getPageCount(), 1)
  for (const format of ['pdf', 'reading-pdf', 'layout-searchable-pdf']) {
    await check(`${format} accepts a valid reading PDF with Type 3 glyphs`, () => validators.validateRenderedExport(format, pdfPath))
  }
  await check('editable layout PDF retains its font guard', () => assert.throws(() => validators.validateRenderedExport('layout-pdf', pdfPath), /Type 3/))
  const invalidPath = path.join(temp, 'invalid.pdf')
  fs.writeFileSync(invalidPath, 'not a PDF')
  await check('reading export still rejects invalid files', () => assert.throws(() => validators.validateRenderedExport('reading-pdf', invalidPath), /PDF/))
  await check('settings and onboarding preserve all supported model selections', () => {
    const settingsTree = source('src/renderer/src/views/SettingsView.tsx')
    const value = find(settingsTree, (node) => ts.isPropertyAssignment(node) && node.name.getText(settingsTree) === 'ocr_async_model').initializer.getText(settingsTree)
    const onboardingTree = source('src/renderer/src/components/OnboardingWizard.tsx')
    const onboardingValue = find(onboardingTree, (node) => ts.isCallExpression(node) && node.expression.getText(onboardingTree) === 'setPaddleModel').arguments[0].getText(onboardingTree)
    const { normalizeAsyncOcrModel } = functions(source('src/main/ocr.ts'), ['normalizeAsyncOcrModel'], { DEFAULT_ASYNC_OCR_MODEL: 'PaddleOCR-VL-1.6' })
    for (const model of ['PaddleOCR-VL', 'PaddleOCR-VL-1.5', 'PaddleOCR-VL-1.6', 'PP-StructureV3']) {
      assert.equal(vm.runInNewContext(value, { settings: { ocr_async_model: model } }), model)
      assert.equal(vm.runInNewContext(onboardingValue, { nextSettings: { ocr_async_model: model } }), model)
      assert.equal(normalizeAsyncOcrModel(model), model)
    }
    assert.equal(normalizeAsyncOcrModel(''), 'PaddleOCR-VL-1.6')
  })
  await check('export waits for assets without waiting again for the completed load event', async () => {
    const timers = []
    let closed = false
    let assetScript = ''
    class BrowserWindow {
      constructor() { this.webContents = { once: () => {}, executeJavaScript: async (script) => { assetScript = script }, printToPDF: async () => fs.readFileSync(pdfPath) } }
      async loadFile() {}
      isDestroyed() { return closed }
      close() { closed = true }
    }
    const { exportPdfFromHtml } = functions(exportsSource, ['exportPdfFromHtml'], { BrowserWindow, getDataDir: () => temp,
      join: path.join, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, unlinkSync: fs.unlinkSync,
      randomUUID: () => 'fixture', Buffer, setTimeout: (callback, ms) => { timers.push(ms); queueMicrotask(callback); return 1 }, clearTimeout: () => {} })
    await exportPdfFromHtml('<html><body>fixture</body></html>', path.join(temp, 'output.pdf'))
    assert(closed)
    assert(!timers.includes(12000), 'loadFile already completed, but export waits another 12 seconds')
    assert(assetScript.includes('document.fonts.ready'))
  })
  for (const state of ['pending', 'queued', 'waiting', 'processing']) {
    await check(`async ${state} distinguishes acknowledged queue from stalled processing`, async () => {
      let now = 0
      let polls = 0
      const { waitForAsyncPdfResult } = functions(source('src/main/ocr.ts'), ['waitForAsyncPdfResult'], {
        Date: { now: () => now },
        throwIfAborted: () => {},
        queryAsyncPdfJob: async () => {
          polls += 1
          now += 11 * 60 * 1000
          return polls < 3 ? { state } : { state: 'done', jsonUrl: 'mock://result' }
        },
        isOcrAbortError: () => false, isPaddleOcrTokenFailure: () => false, isRetryableNetworkFailure: () => false,
        getJsonUrl: (payload) => payload.jsonUrl,
        getCompletedPages: () => 0, getTotalPages: () => 0,
        getAsyncPollDelayMs: () => 0, sleep: async () => {},
        ASYNC_JOB_STALLED_TIMEOUT_MS: 10 * 60 * 1000,
        ASYNC_JOB_STALLED_AFTER_PROGRESS_TIMEOUT_MS: 3 * 60 * 1000,
        ASYNC_JOB_STALLED_PREFIX: '[async_job_stalled]',
      })
      const result = waitForAsyncPdfResult('fixture-job', { id: 'fixture', token: 'fixture' })
      if (state === 'processing') {
        await assert.rejects(result, /async_job_stalled/)
        assert.equal(polls, 2)
      } else {
        assert.equal(await result, 'mock://result')
        assert.equal(polls, 3, 'keep polling the original queued job')
      }
    })
  }
  await check('vertical historical PDFs retain enclosing text regions without changing general documents', () => {
    const { getAsyncPdfOptionalPayload } = functions(source('src/main/ocr.ts'), ['getAsyncPdfOptionalPayload'], {})
    for (const model of ['PaddleOCR-VL', 'PaddleOCR-VL-1.5', 'PaddleOCR-VL-1.6']) {
      assert.equal(getAsyncPdfOptionalPayload({ profile: 'guji_print_vertical' }, model).layoutMergeBboxesMode, 'large')
      assert.equal(getAsyncPdfOptionalPayload({ profile: 'general' }, model).layoutMergeBboxesMode, 'small')
      assert.equal(getAsyncPdfOptionalPayload(undefined, model).layoutMergeBboxesMode, 'small')
      assert.equal(getAsyncPdfOptionalPayload({ profile: 'guji_print_vertical' }, model).useDocUnwarping, false)
    }
    assert.equal(getAsyncPdfOptionalPayload({ profile: 'guji_print_vertical' }, 'PP-StructureV3').layoutMergeBboxesMode, 'small')
    assert.equal(getAsyncPdfOptionalPayload({ profile: 'guji_print_vertical' }, 'unsupported'), undefined)
  })
  assert.equal(failures.length, 0, `${failures.length} feedback regressions failed`)
}
run().catch((error) => { console.error(error.message); process.exitCode = 1 }).finally(() => fs.rmSync(temp, { recursive: true, force: true }))

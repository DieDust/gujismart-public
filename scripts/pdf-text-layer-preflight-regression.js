const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { buildSync } = require('esbuild')
const { PDFDocument, StandardFonts } = require('pdf-lib')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(root, '.tmp-pdf-preflight-'))
const bundlePath = path.join(tempRoot, 'pdf-preflight.cjs')

function removeDirectoryTree(directoryPath) {
  if (!fs.existsSync(directoryPath)) return
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name)
    if (entry.isDirectory()) removeDirectoryTree(entryPath)
    else fs.unlinkSync(entryPath)
  }
  fs.rmdirSync(directoryPath)
}

async function writePdf(fileName, pageKinds) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const kind of pageKinds) {
    const page = pdf.addPage([612, 792])
    if (kind === 'text') {
      const lines = [
        'GujiSmart native PDF text layer verification fixture.',
        'This page contains enough searchable characters and coordinates.',
        'The preflight should preserve this text without invoking OCR.',
      ]
      lines.forEach((line, index) => page.drawText(line, { x: 54, y: 720 - index * 28, size: 12, font }))
    }
  }
  const filePath = path.join(tempRoot, fileName)
  fs.writeFileSync(filePath, await pdf.save())
  return filePath
}

async function runAssertions() {
  buildSync({
    entryPoints: [path.join(root, 'src', 'main', 'pdf-preflight.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    external: ['pdfjs-dist/legacy/build/pdf.mjs'],
    logLevel: 'silent',
  })
  const preflight = require(bundlePath)

  const textPdf = await writePdf('text.pdf', ['text'])
  const textAnalysis = await preflight.analyzePdfTextLayer(textPdf, { analyzeAllPages: true })
  assert.strictEqual(textAnalysis.mode, 'native_text')
  assert.strictEqual(textAnalysis.nativeTextPageCount, 1)
  assert.ok(textAnalysis.pages[0].cleanCharacterCount >= 50)
  assert.ok(textAnalysis.pages[0].coordinateCoverage >= 0.9)
  assert.ok(textAnalysis.pages[0].layoutBlocks.length > 0)
  assert.ok(textAnalysis.pages[0].layoutBlocks.every((block) => block.segmentation_source === 'native_pdf_text'))

  const blankPdf = await writePdf('blank.pdf', ['blank'])
  const blankAnalysis = await preflight.analyzePdfTextLayer(blankPdf, { analyzeAllPages: true })
  assert.strictEqual(blankAnalysis.mode, 'ocr')
  assert.ok(blankAnalysis.pages[0].reasons.includes('too_few_clean_characters'))

  const mixedPdf = await writePdf('mixed.pdf', ['text', 'blank'])
  const mixedAnalysis = await preflight.analyzePdfTextLayer(mixedPdf, { analyzeAllPages: true })
  assert.strictEqual(mixedAnalysis.mode, 'mixed')
  assert.deepStrictEqual(mixedAnalysis.pages.map((page) => page.mode), ['native_text', 'ocr'])
  assert.deepStrictEqual(mixedAnalysis.sampledPageNums, [1, 2])

  const cachedAnalysis = await preflight.analyzePdfTextLayer(mixedPdf, { analyzeAllPages: true })
  assert.strictEqual(cachedAnalysis.analyzedAt, mixedAnalysis.analyzedAt)

  console.log('PDF text-layer preflight regression passed')
}

async function main() {
  try {
    await runAssertions()
  } finally {
    removeDirectoryTree(tempRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

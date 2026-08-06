const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-manual-cross-mode-'))
const entryPath = path.join(tempRoot, 'entry.js')
const bundlePath = path.join(tempRoot, 'bundle.cjs')

function countOccurrences(source, value) {
  return String(source).split(value).length - 1
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

fs.writeFileSync(entryPath, `
  const manualLayout = require(${JSON.stringify(path.join(root, 'src', 'shared', 'manual-layout.ts'))})
  const ocrText = require(${JSON.stringify(path.join(root, 'src', 'renderer', 'src', 'utils', 'ocrText.ts'))})
  module.exports = { manualLayout, ocrText }
`)

try {
  buildSync({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    alias: { '@shared': path.join(root, 'src', 'shared') },
    logLevel: 'silent',
  })

  const { manualLayout, ocrText } = require(bundlePath)
  const noteText = 'manual note alpha'
  const tableCellText = 'manual table beta'
  const imageCaption = 'manual image gamma'
  const fabricatedImageOcr = 'fabricated image OCR must stay hidden'
  const noteId = 'manual-page-cross-note001'
  const tableId = 'manual-page-cross-table001'
  const imageId = 'manual-page-cross-image001'
  const blocks = [
    {
      manual_block_id: noteId,
      segmentation_source: 'manual',
      label: 'note',
      words: noteText,
      reading_order: 1,
      location: { left: 12, top: 20, width: 260, height: 72 },
    },
    {
      manual_block_id: tableId,
      segmentation_source: 'manual',
      label: 'table',
      words: 'stale table projection',
      rows: [[tableCellText, 'B2'], ['A2', 'B3']],
      cells: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2, text: tableCellText }],
      merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }],
      rowHeights: [28, 32],
      columnWidths: [120, 180],
      reading_order: 2,
      location: { left: 24, top: 112, width: 420, height: 180 },
    },
    {
      manual_block_id: imageId,
      segmentation_source: 'manual',
      label: 'image',
      words: fabricatedImageOcr,
      caption: imageCaption,
      alt_text: 'neutral illustration',
      image_asset_path: 'page-assets/page-cross/image001.png',
      image_crop: {
        source_page_id: 'page-cross',
        left: 40,
        top: 320,
        width: 360,
        height: 220,
      },
      reading_order: 3,
      location: { left: 40, top: 320, width: 360, height: 220 },
    },
  ]
  const page = {
    id: 'page-cross',
    page_num: 1,
    ocr_result: { layout_result: blocks },
    ocr_text: null,
    proofed_text: null,
  }

  const elements = ocrText.getReadablePageElements(page)
  const note = elements.find((element) => element.blockId === noteId)
  const table = elements.find((element) => element.blockId === tableId)
  const image = elements.find((element) => element.blockId === imageId)
  assert.ok(note && note.type === 'paragraph', 'manual note should be readable and keep its stable block id')
  assert.ok(table && table.type === 'table', 'manual table should be readable and keep its stable block id')
  assert.ok(image && image.type === 'image', 'manual image should be readable and keep its stable block id')
  assert.deepStrictEqual(note.rect, blocks[0].location)
  assert.deepStrictEqual(table.rows, blocks[1].rows)
  assert.strictEqual(image.imagePath, blocks[2].image_asset_path)
  assert.strictEqual(image.text, imageCaption)
  assert.deepStrictEqual(image.rect, blocks[2].location)

  const readableText = ocrText.getReadablePageText(page)
  assert.strictEqual(countOccurrences(readableText, noteText), 1)
  assert.strictEqual(countOccurrences(readableText, tableCellText), 1)
  assert.strictEqual(countOccurrences(readableText, imageCaption), 1)
  assert.ok(!readableText.includes(fabricatedImageOcr), 'reader text must not fabricate OCR text for image blocks')

  const projectedText = manualLayout.projectLayoutBlocksToPageText(blocks)
  assert.strictEqual(countOccurrences(projectedText, noteText), 1)
  assert.strictEqual(countOccurrences(projectedText, tableCellText), 1)
  assert.strictEqual(countOccurrences(projectedText, imageCaption), 1)
  assert.ok(!projectedText.includes(fabricatedImageOcr), 'shared text projection must ignore stale image words')

  const searchSegments = manualLayout.getManualLayoutSearchSegments(blocks)
  assert.deepStrictEqual(searchSegments.map((segment) => segment.blockId), [noteId, tableId, imageId])
  assert.deepStrictEqual(searchSegments[0].location, blocks[0].location)
  assert.ok(searchSegments.some((segment) => segment.text.includes(tableCellText)))
  assert.ok(searchSegments.some((segment) => segment.text.includes(imageCaption)))
  assert.ok(searchSegments.every((segment) => !segment.text.includes(fabricatedImageOcr)))

  const structured = manualLayout.getManualLayoutStructuredBlocks(blocks)
  const structuredTable = structured.find((block) => block.manual_block_id === tableId)
  const structuredImage = structured.find((block) => block.manual_block_id === imageId)
  assert.deepStrictEqual(structuredTable.rows, blocks[1].rows)
  assert.deepStrictEqual(structuredTable.cells, blocks[1].cells)
  assert.deepStrictEqual(structuredTable.merges, blocks[1].merges)
  assert.deepStrictEqual(structuredTable.rowHeights, blocks[1].rowHeights)
  assert.deepStrictEqual(structuredTable.columnWidths, blocks[1].columnWidths)
  assert.strictEqual(structuredImage.image_asset_path, blocks[2].image_asset_path)
  assert.deepStrictEqual(structuredImage.image_crop, blocks[2].image_crop)
  assert.strictEqual(structuredImage.caption, imageCaption)

  const semanticSearch = read('src/main/semantic-search.ts')
  const searchWorker = read('src/main/search-index-worker.ts')
  const exportSource = read('src/main/export.ts')
  const documentsIpc = read('src/main/ipc/documents.ts')
  const documentView = read('src/renderer/src/views/DocumentView.tsx')
  assert.match(semanticSearch, /getManualLayoutSearchSegments/)
  assert.match(searchWorker, /getManualLayoutSearchSegments/)
  assert.match(exportSource, /getManualLayoutStructuredBlocks/)
  assert.match(exportSource, /projectLayoutBlocksToPageText/)
  assert.match(documentsIpc, /projectLayoutBlocksToPageText/)
  assert.match(documentView, /locator\.blockId/)
  assert.match(documentView, /parseManualLayoutLocationKey/)

  console.log('Manual layout cross-mode regression checks passed.')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

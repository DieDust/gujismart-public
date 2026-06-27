const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-ocr-ir-'))
const entryPath = path.join(tempRoot, 'entry.js')
const bundlePath = path.join(tempRoot, 'bundle.cjs')

fs.writeFileSync(entryPath, `
  const ocrIr = require(${JSON.stringify(path.join(root, 'src', 'shared', 'ocr-ir.ts'))})
  const translation = require(${JSON.stringify(path.join(root, 'src', 'shared', 'translation-source.ts'))})
  module.exports = { ocrIr, translation }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  logLevel: 'silent',
})

function textBlock(words, top, extra = {}) {
  return {
    words,
    label: 'text',
    reading_order: top,
    location: { left: 100, top, width: 700, height: 60 },
    confidence: 0.92,
    ...extra,
  }
}

function tableBlock(top, rows, extra = {}) {
  return {
    words: rows.map((row) => row.join('\t')).join('\n'),
    label: 'table',
    reading_order: top,
    location: { left: 80, top, width: 840, height: 180 },
    rows,
    cells: rows.flatMap((row, rowIndex) => row.map((text, column) => ({
      row: rowIndex,
      column,
      text,
      row_span: rowIndex === 0 && column === 0 ? 2 : 1,
      column_span: 1,
    }))),
    ...extra,
  }
}

try {
  const { ocrIr, translation } = require(bundlePath)

  const source = {
    source_type: 'vision_model_ocr',
    layout_result: [
      { words: 'Running header', label: 'header', reading_order: 0, location: { left: 80, top: 15, width: 840, height: 30 } },
      textBlock('First source block', 1, { manual_reading_order: 1 }),
      textBlock('Second source block', 2, { manual_reading_order: 0 }),
      tableBlock(3, [['A', 'B'], ['C', 'D']]),
      {
        words: 'x^2+y^2',
        latex: 'x^2+y^2',
        label: 'formula',
        reading_order: 4,
        location: { left: 300, top: 600, width: 300, height: 50 },
        confidence: 0.8,
      },
    ],
  }
  const normalized = ocrIr.ensureOcrResultIr(source, {
    pageIndex: 1,
    pageWidth: 1000,
    pageHeight: 1000,
    engine: 'paddle',
    generatedAt: '2026-01-01T00:00:00.000Z',
    forceRebuild: true,
  })
  const ir = ocrIr.getOcrPageIr(normalized)
  assert.ok(ir)
  assert.strictEqual(ir.schemaVersion, 'gujismart-ocr-ir/v1')
  assert.strictEqual(ir.pipelineVersion, '1.2.0')
  assert.strictEqual(ir.page.discardedBlocks.length, 1)
  assert.strictEqual(ir.page.discardedBlocks[0].type, 'page_header')
  assert.deepStrictEqual(ir.page.blocks.slice(0, 2).map((block) => block.text), [
    'Second source block',
    'First source block',
  ])
  assert.deepStrictEqual(source.layout_result.slice(1, 3).map((block) => block.words), [
    'First source block',
    'Second source block',
  ])
  assert.strictEqual(ir.page.blocks[0].source.engine, 'vision_model')
  assert.strictEqual(ir.page.blocks[0].normalizedBbox.top, 2)
  assert.strictEqual(ir.page.blocks.find((block) => block.type === 'table').table.complexity, 'complex')
  assert.strictEqual(ir.page.blocks.find((block) => block.type === 'formula_display').formula.latex, 'x^2+y^2')
  assert.ok(!ocrIr.deriveOcrTextFromIr(ir).includes('Running header'))
  assert.ok(ocrIr.deriveOcrTextFromIr(ir).indexOf('Second source block') < ocrIr.deriveOcrTextFromIr(ir).indexOf('First source block'))
  assert.ok(normalized.words_result.every((block) => block.ir_block_id))
  const oldPipelineResult = {
    ...normalized,
    gujismart_ir: {
      ...normalized.gujismart_ir,
      pipelineVersion: '1.0.0',
    },
  }
  assert.strictEqual(ocrIr.getOrBuildOcrPageIr(oldPipelineResult).pipelineVersion, '1.2.0')

  const nativeResult = ocrIr.ensureOcrResultIr({
    source_type: 'native_pdf_text',
    layout_result: [textBlock('Native PDF text with coordinates', 1)],
  }, {
    pageWidth: 1000,
    pageHeight: 1000,
    engine: 'paddle',
    generatedAt: '2026-01-01T00:00:00.000Z',
    forceRebuild: true,
  })
  assert.strictEqual(ocrIr.getOcrPageIr(nativeResult).page.blocks[0].source.engine, 'native_pdf_text')

  const proofed = translation.getCanonicalPageTranslationSourceText({
    proofed_text: 'Human proofed text',
    ocr_text: 'Derived OCR text',
    ocr_result: normalized,
  })
  assert.strictEqual(proofed, 'Human proofed text')

  const pages = [1, 2, 3].map((pageNum) => ({
    page_num: pageNum,
    page_width: 1000,
    page_height: 1000,
    layout_result: [
      textBlock('Repeated publication title', 0, {
        reading_order: 0,
        location: { left: 100, top: 20, width: 800, height: 35 },
      }),
      textBlock(pageNum === 1 ? 'Paragraph continues' : `Page ${pageNum} body text`, 1, {
        reading_order: 1,
        location: { left: 100, top: 180, width: 800, height: 500 },
      }),
      ...(pageNum === 1
        ? [tableBlock(2, [['H1', 'H2'], ['A', 'B']], {
            location: { left: 80, top: 800, width: 840, height: 190 },
          })]
        : pageNum === 2
          ? [tableBlock(2, [['C', 'D']], {
              location: { left: 80, top: 20, width: 840, height: 180 },
            })]
          : []),
    ],
  }))
  const documentIr = ocrIr.buildOcrDocumentV1(pages, {
    generatedAt: '2026-01-01T00:00:00.000Z',
    forceRebuild: true,
  })
  assert.strictEqual(documentIr.pages.length, 3)
  assert.ok(documentIr.pages.every((page) => page.discardedBlocks.some((block) => block.text === 'Repeated publication title')))
  assert.ok(documentIr.pages.every((page) => !page.blocks.some((block) => block.text === 'Repeated publication title')))
  assert.strictEqual(documentIr.pages[0].paragraphs.find((paragraph) => paragraph.text.includes('Paragraph continues')).continuesToNextPage, true)
  assert.strictEqual(documentIr.pages[1].paragraphs.find((paragraph) => paragraph.text.includes('Page 2 body text')).continuesFromPreviousPage, true)
  assert.strictEqual(documentIr.pages[0].blocks.find((block) => block.type === 'table').table.continuesToNextPage, true)
  assert.strictEqual(documentIr.pages[1].blocks.find((block) => block.type === 'table').table.continuesFromPreviousPage, true)

  const structuredLayout = ocrIr.buildOcrPageIr({
    page_width: 1000,
    page_height: 1000,
    layout_result: [
      textBlock('Horizontal paragraph starts', 100, {
        location: { left: 80, top: 100, width: 380, height: 80 },
        column_index: 0,
      }),
      textBlock('and continues in the same column', 190, {
        location: { left: 82, top: 190, width: 375, height: 75 },
        column_index: 0,
      }),
      textBlock('Other column must remain separate', 200, {
        location: { left: 540, top: 105, width: 380, height: 80 },
        column_index: 1,
      }),
      {
        words: '图一 示例',
        label: 'caption',
        reading_order: 4,
        location: { left: 120, top: 500, width: 300, height: 35 },
      },
      {
        words: 'figure',
        label: 'image',
        reading_order: 5,
        location: { left: 100, top: 545, width: 340, height: 220 },
      },
      {
        words: '正文内容',
        label: 'text',
        reading_order: 6,
        location: { left: 520, top: 500, width: 380, height: 100 },
      },
      {
        words: '脚注说明',
        label: 'footnote',
        reading_order: 7,
        location: { left: 520, top: 620, width: 380, height: 50 },
      },
      textBlock('Low confidence region', 8, {
        confidence: 0.2,
        needs_enhancement: true,
        location: { left: 80, top: 820, width: 380, height: 60 },
      }),
    ],
  }, {
    pageIndex: 1,
    pageWidth: 1000,
    pageHeight: 1000,
    forceRebuild: true,
  })
  assert.ok(structuredLayout.page.paragraphs.some((paragraph) => (
    paragraph.text === 'Horizontal paragraph starts and continues in the same column'
    && paragraph.blockIds.length === 2
  )))
  assert.ok(ocrIr.deriveOcrReadingBlocksFromIr(structuredLayout).some((block) => (
    block.words === 'Horizontal paragraph starts and continues in the same column'
    && block.ir_block_ids.length === 2
  )))
  assert.ok(structuredLayout.page.paragraphs.some((paragraph) => paragraph.text === 'Other column must remain separate'))
  const caption = structuredLayout.page.blocks.find((block) => block.type === 'caption')
  const image = structuredLayout.page.blocks.find((block) => block.type === 'image')
  assert.strictEqual(caption.parentBlockId, image.id)
  assert.ok(image.childBlockIds.includes(caption.id))
  const footnote = structuredLayout.page.blocks.find((block) => block.type === 'footnote')
  assert.strictEqual(
    structuredLayout.page.blocks.find((block) => block.id === footnote.parentBlockId).text,
    '正文内容',
  )
  const regionCandidates = ocrIr.getOcrRegionRerecognitionCandidates(structuredLayout, 8)
  assert.strictEqual(regionCandidates.length, 1)
  assert.deepStrictEqual(regionCandidates[0].reasons.sort(), ['low_confidence', 'needs_enhancement'])

  const verticalLayout = ocrIr.buildOcrPageIr({
    page_width: 1000,
    page_height: 1000,
    layout_result: [
      textBlock('天地玄黄', 1, {
        orientation: 'vertical',
        column_index: 0,
        location: { left: 820, top: 100, width: 45, height: 600 },
      }),
      textBlock('宇宙洪荒', 2, {
        orientation: 'vertical',
        column_index: 1,
        location: { left: 760, top: 105, width: 45, height: 595 },
      }),
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  assert.strictEqual(verticalLayout.page.paragraphs.length, 1)
  assert.strictEqual(verticalLayout.page.paragraphs[0].text, '天地玄黄宇宙洪荒')

  const verticalCoordinateFallback = ocrIr.buildOcrPageIr({
    page_width: 1000,
    page_height: 1000,
    layout_result: [
      {
        words: 'Left column second',
        label: 'text',
        orientation: 'vertical',
        location: { left: 650, top: 100, width: 45, height: 600 },
      },
      {
        words: 'Right column first',
        label: 'text',
        orientation: 'vertical',
        location: { left: 820, top: 100, width: 45, height: 600 },
      },
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  assert.deepStrictEqual(verticalCoordinateFallback.page.blocks.map((block) => block.text), [
    'Right column first',
    'Left column second',
  ])
  assert.ok(verticalCoordinateFallback.page.blocks.every((block) => block.readingOrderSource === 'coordinate'))
  assert.ok(verticalCoordinateFallback.page.blocks.every((block) => block.sourceReadingOrder === undefined))
  const coordinateRoundTrip = ocrIr.buildOcrPageIr({
    page_width: 1000,
    page_height: 1000,
    words_result: ocrIr.deriveOcrWordsResultFromIr(verticalCoordinateFallback),
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  assert.deepStrictEqual(coordinateRoundTrip.page.blocks.map((block) => block.text), [
    'Right column first',
    'Left column second',
  ])
  assert.ok(coordinateRoundTrip.page.blocks.every((block) => block.readingOrderSource === 'coordinate'))

  const explicitOcrOrder = ocrIr.buildOcrPageIr({
    page_width: 1000,
    page_height: 1000,
    layout_result: [
      {
        words: 'OCR says left is first',
        label: 'text',
        orientation: 'vertical',
        reading_order: 0,
        location: { left: 650, top: 100, width: 45, height: 600 },
      },
      {
        words: 'OCR says right is second',
        label: 'text',
        orientation: 'vertical',
        reading_order: 1,
        location: { left: 820, top: 100, width: 45, height: 600 },
      },
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  assert.deepStrictEqual(explicitOcrOrder.page.blocks.map((block) => block.text), [
    'OCR says left is first',
    'OCR says right is second',
  ])
  assert.deepStrictEqual(explicitOcrOrder.page.blocks.map((block) => block.sourceReadingOrder), [0, 1])

  const verticalDocument = ocrIr.buildOcrDocumentV1([
    {
      page_width: 1000,
      page_height: 1000,
      layout_result: [
        textBlock('Vertical body one with enough text', 0, {
          orientation: 'vertical',
          location: { left: 820, top: 100, width: 45, height: 600 },
        }),
        textBlock('Misclassified horizontal body', 1, {
          orientation: 'horizontal',
          location: { left: 120, top: 760, width: 700, height: 60 },
        }),
      ],
    },
    {
      page_width: 1000,
      page_height: 1000,
      layout_result: [
        textBlock('Vertical body two with enough text', 0, {
          orientation: 'vertical',
          location: { left: 820, top: 100, width: 45, height: 600 },
        }),
        textBlock('Vertical body three with enough text', 1, {
          orientation: 'vertical',
          location: { left: 760, top: 100, width: 45, height: 600 },
        }),
      ],
    },
  ], { forceRebuild: true })
  assert.strictEqual(verticalDocument.orientation, 'vertical')
  assert.ok(verticalDocument.orientationConfidence > 0.5)
  assert.ok(verticalDocument.pages.every((page) => page.orientation === 'vertical'))
  assert.ok(verticalDocument.pages.flatMap((page) => page.blocks).every((block) => block.orientation === 'vertical'))
  const verticalOutlier = verticalDocument.pages[0].blocks.find((block) => block.text === 'Misclassified horizontal body')
  assert.strictEqual(verticalOutlier.sourceOrientation, 'horizontal')
  assert.strictEqual(verticalOutlier.orientationSource, 'document_consensus')
  assert.ok(verticalOutlier.processing.some((event) => event.action === 'apply_dominant_reading_orientation'))

  const manualOrientationDocument = ocrIr.buildOcrDocumentV1([
    {
      page_width: 1000,
      page_height: 1000,
      layout_result: [
        textBlock('Vertical body one with enough text', 0, {
          orientation: 'vertical',
          location: { left: 820, top: 100, width: 45, height: 600 },
        }),
        textBlock('Manual horizontal body should stay horizontal', 1, {
          orientation: 'horizontal',
          orientation_source: 'manual',
          source_orientation: 'horizontal',
          source_orientation_source: 'ocr',
          location: { left: 120, top: 760, width: 700, height: 60 },
        }),
      ],
    },
    {
      page_width: 1000,
      page_height: 1000,
      layout_result: [
        textBlock('Vertical body two with enough text', 0, {
          orientation: 'vertical',
          location: { left: 820, top: 100, width: 45, height: 600 },
        }),
        textBlock('Vertical body three with enough text', 1, {
          orientation: 'vertical',
          location: { left: 760, top: 100, width: 45, height: 600 },
        }),
      ],
    },
  ], { forceRebuild: true })
  const manualHorizontal = manualOrientationDocument.pages[0].blocks.find((block) => block.text === 'Manual horizontal body should stay horizontal')
  assert.strictEqual(manualHorizontal.orientation, 'horizontal')
  assert.strictEqual(manualHorizontal.orientationSource, 'manual')
  assert.ok(!manualHorizontal.processing.some((event) => event.action === 'apply_dominant_reading_orientation'))

  const horizontalDocument = ocrIr.buildOcrDocumentV1([{
    page_width: 1000,
    page_height: 1000,
    layout_result: [
      textBlock('Horizontal body one', 0, { orientation: 'horizontal' }),
      textBlock('Horizontal body two', 1, { orientation: 'horizontal' }),
      textBlock('Narrow block misclassified as vertical', 2, {
        orientation: 'vertical',
        location: { left: 850, top: 100, width: 40, height: 300 },
      }),
    ],
  }], { forceRebuild: true })
  assert.strictEqual(horizontalDocument.orientation, 'horizontal')
  assert.ok(horizontalDocument.pages[0].blocks.every((block) => block.orientation === 'horizontal'))

  const sourceFiles = [
    'src/shared/ocr-ir.ts',
    'src/main/pdf-preflight.ts',
    'src/main/ipc/ocr.ts',
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n')
  assert.ok(!/from ['"][^'"]*mineru|require\([^)]*mineru/i.test(sourceFiles))

  console.log('OCR IR regression passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

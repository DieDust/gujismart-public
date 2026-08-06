const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-manual-layout-'))
const entryPath = path.join(tempRoot, 'entry.js')
const bundlePath = path.join(tempRoot, 'bundle.cjs')

fs.writeFileSync(entryPath, `
  const manualLayout = require(${JSON.stringify(path.join(root, 'src', 'shared', 'manual-layout.ts'))})
  const ocrIr = require(${JSON.stringify(path.join(root, 'src', 'shared', 'ocr-ir.ts'))})
  module.exports = { manualLayout, ocrIr }
`)

try {
  buildSync({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  })

  const { manualLayout, ocrIr } = require(bundlePath)
  const {
    getLayoutBlockSearchText,
    getManualBlockId,
    isManualLayoutBlock,
    projectLayoutBlocksToPageText,
  } = manualLayout

  const blocks = [
    { manual_block_id: 'm-text', label: 'note', words: '夹注内容', reading_order: 1 },
    { manual_block_id: 'm-table', label: 'table', rows: [['甲', '乙'], ['丙', '丁']], reading_order: 2 },
    { manual_block_id: 'm-image', label: 'image', caption: '图一', reading_order: 3 },
  ]

  assert.strictEqual(projectLayoutBlocksToPageText(blocks), '夹注内容\n甲\t乙\n丙\t丁\n图一')
  assert.strictEqual(getManualBlockId(blocks[0]), 'm-text')
  assert.ok(isManualLayoutBlock(blocks[0]))
  assert.strictEqual(getManualBlockId({ manual_block_id: '  m-trimmed  ' }), 'm-trimmed')
  assert.strictEqual(getManualBlockId({ manual_block_id: 42 }), undefined)
  assert.ok(!isManualLayoutBlock({ segmentation_source: 'manual' }))
  assert.strictEqual(getLayoutBlockSearchText(null), '')
  assert.strictEqual(projectLayoutBlocksToPageText(undefined), '')
  assert.strictEqual(
    getLayoutBlockSearchText({ label: 'image', words: '不应进入文本流' }),
    '',
    '空图片块不得把旧 words 当作 OCR 文本',
  )
  assert.strictEqual(
    getLayoutBlockSearchText({ label: 'seal', words: '不应进入文本流', alt_text: '藏书印' }),
    '藏书印',
    '印章块只能投影说明或替代文字',
  )
  assert.strictEqual(
    getLayoutBlockSearchText({ label: 'legacy-custom', block_content: '旧 OCR 可读文本' }),
    '旧 OCR 可读文本',
    '未知旧 OCR 区块仍应从常见字段读出文字',
  )
  assert.strictEqual(
    getLayoutBlockSearchText({ label: 'table', rows: [['A', ''], ['', 'B']] }),
    'A\t\n\tB',
    '表格投影必须保留空单元格所在的行列边界',
  )
  assert.strictEqual(
    projectLayoutBlocksToPageText([{
      manual_block_id: 'roundtrip-table',
      label: 'table',
      rows: [['表', '格']],
      words: '表格',
      manual_preserved_text: { text: '人工正文', source: 'manual-type-conversion', version: 2 },
    }]),
    '表\t格',
    '表格活动态不得把归档人工文本重复投影到阅读、检索或导出文本',
  )
  assert.strictEqual(
    projectLayoutBlocksToPageText([{
      manual_block_id: 'roundtrip-text',
      label: 'text',
      words: '人工正文',
      manual_preserved_table: { rows: [['表', '格']] },
    }]),
    '人工正文',
    '正文活动态不得把归档表格 metadata 当成活动内容',
  )
  assert.strictEqual(
    projectLayoutBlocksToPageText([
      { words: '无序一' },
      { words: '第二', reading_order: 2 },
      { words: '第一', reading_order: 1 },
      { words: '无序二' },
    ]),
    '第一\n第二\n无序一\n无序二',
    '应按 reading_order 投影，缺失顺序的区块必须稳定保持原始次序',
  )
  assert.strictEqual(
    projectLayoutBlocksToPageText([
      { words: '空顺序一', reading_order: null },
      { words: '显式顺序', reading_order: 1 },
      { words: '空顺序二', reading_order: '' },
    ]),
    '显式顺序\n空顺序一\n空顺序二',
    'null 和空字符串必须按缺失 reading_order 处理',
  )

  const canonicalBlocks = blocks.map((block, index) => ({
    ...block,
    segmentation_source: 'manual',
    location: { left: 10, top: 20 + index * 100, width: 300, height: 80 },
    orientation: 'vertical',
    ...(block.manual_block_id === 'm-image'
      ? {
          alt_text: '古籍插图',
          image_asset_path: 'assets/manual-image.png',
          image_crop: { source_page_id: 'page-1', left: 10, top: 220, width: 300, height: 80 },
          words: '不应保留的旧图片词',
        }
      : {}),
  }))
  const normalized = ocrIr.ensureOcrResultIr({ layout_result: canonicalBlocks }, {
    pageIndex: 1,
    pageWidth: 1000,
    pageHeight: 1000,
    generatedAt: '2026-08-05T00:00:00.000Z',
    forceRebuild: true,
  })

  assert.strictEqual(normalized.text, '夹注内容\n甲\t乙\n丙\t丁\n图一\n古籍插图')
  assert.strictEqual(normalized.ir_text, normalized.text)
  assert.ok(
    normalized.gujismart_ir.page.blocks.some((block) => block.id === 'm-text' && block.manualBlockId === 'm-text'),
    'OCR IR 区块身份必须使用稳定的人工区块 ID',
  )
  const normalizedBlocksById = new Map(normalized.words_result.map((block) => [getManualBlockId(block), block]))
  const normalizedImage = normalizedBlocksById.get('m-image')
  assert.ok(normalizedImage, '经过 OCR IR 重建后必须保留人工区块 ID')
  assert.strictEqual(normalizedImage.segmentation_source, 'manual')
  assert.strictEqual(normalizedImage.label, 'image')
  assert.deepStrictEqual(normalizedImage.location, { left: 10, top: 220, width: 300, height: 80 })
  assert.strictEqual(normalizedImage.reading_order, 3)
  assert.strictEqual(normalizedImage.orientation, 'vertical')
  assert.strictEqual(normalizedImage.caption, '图一')
  assert.strictEqual(normalizedImage.alt_text, '古籍插图')
  assert.strictEqual(normalizedImage.image_asset_path, 'assets/manual-image.png')
  assert.deepStrictEqual(normalizedImage.image_crop, {
    source_page_id: 'page-1', left: 10, top: 220, width: 300, height: 80,
  })
  assert.deepStrictEqual(normalizedBlocksById.get('m-table').rows, [['甲', '乙'], ['丙', '丁']])
  assert.ok(!normalized.text.includes('不应保留的旧图片词'))
  assert.strictEqual(
    ocrIr.deriveOcrTextFromIr(normalized.gujismart_ir),
    '夹注内容\n甲\t乙\n丙\t丁\n图一\n古籍插图',
    '人工 note/table/image 从 IR 重建文本时必须使用共享单换行投影',
  )

  const wordsOnlyRoundTrip = ocrIr.ensureOcrResultIr({
    words_result: normalized.words_result,
  }, {
    pageIndex: 1,
    pageWidth: 1000,
    pageHeight: 1000,
    generatedAt: '2026-08-05T00:00:01.000Z',
    forceRebuild: true,
  })
  assert.strictEqual(
    wordsOnlyRoundTrip.text,
    '夹注内容\n甲\t乙\n丙\t丁\n图一\n古籍插图',
    '人工区块从 words_result 回灌时仍必须使用共享文本投影',
  )
  const wordsOnlyImage = wordsOnlyRoundTrip.words_result.find((block) => getManualBlockId(block) === 'm-image')
  assert.strictEqual(wordsOnlyImage.image_asset_path, 'assets/manual-image.png')
  assert.deepStrictEqual(wordsOnlyImage.image_crop, {
    source_page_id: 'page-1', left: 10, top: 220, width: 300, height: 80,
  })

  const unchangedWithExistingIr = ocrIr.ensureOcrResultIr(normalized, {
    pageIndex: 1,
    pageWidth: 1000,
    pageHeight: 1000,
  })
  assert.strictEqual(
    unchangedWithExistingIr.gujismart_ir,
    normalized.gujismart_ir,
    '人工区块未变更时应继续复用已有 IR，避免无必要全量重建',
  )

  const changedCanonicalBlocks = canonicalBlocks
    .map((block) => block.manual_block_id === 'm-text'
      ? { ...block, words: '已修改的夹注内容' }
      : block)
    .concat({
      manual_block_id: 'm-title-new',
      segmentation_source: 'manual',
      label: 'title',
      words: '新增人工标题',
      reading_order: 4,
      location: { left: 10, top: 320, width: 400, height: 60 },
      orientation: 'horizontal',
    })
  const changedWithExistingIr = ocrIr.ensureOcrResultIr({
    ...normalized,
    layout_result: changedCanonicalBlocks,
  }, {
    pageIndex: 1,
    pageWidth: 1000,
    pageHeight: 1000,
  })
  assert.strictEqual(
    changedWithExistingIr.text,
    '已修改的夹注内容\n甲\t乙\n丙\t丁\n图一\n古籍插图\n新增人工标题',
  )
  const changedWordsById = new Map(
    changedWithExistingIr.words_result.map((block) => [getManualBlockId(block), block]),
  )
  assert.strictEqual(changedWordsById.get('m-text').words, '已修改的夹注内容')
  assert.strictEqual(changedWordsById.get('m-title-new').words, '新增人工标题')
  assert.ok(
    changedWithExistingIr.gujismart_ir.page.blocks.some((block) => block.id === 'm-title-new'),
    '已有 IR 后新增人工区块时，默认 ensure 必须同步重建 IR',
  )

  const partialDeletionResult = ocrIr.ensureOcrResultIr({
    ...normalized,
    layout_result: canonicalBlocks.filter((block) => block.manual_block_id !== 'm-image'),
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.deepStrictEqual(
    partialDeletionResult.words_result.map(getManualBlockId),
    ['m-text', 'm-table'],
    '删除部分人工区块后不得从旧 IR 补回',
  )
  assert.ok(!partialDeletionResult.gujismart_ir.page.blocks.some((block) => block.id === 'm-image'))

  const legacyImageBlock = {
    label: 'image',
    words: '',
    reading_order: 2,
    location: { left: 400, top: 20, width: 300, height: 300 },
  }
  const manualWithEmptyLegacyImage = ocrIr.ensureOcrResultIr({
    layout_result: [
      {
        manual_block_id: 'm-note-before-image-only',
        segmentation_source: 'manual',
        label: 'note',
        words: '待删除人工夹注',
        reading_order: 1,
        location: { left: 20, top: 20, width: 300, height: 100 },
      },
      legacyImageBlock,
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const legacyImageOnlyResult = ocrIr.ensureOcrResultIr({
    ...manualWithEmptyLegacyImage,
    layout_result: [legacyImageBlock],
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.strictEqual(legacyImageOnlyResult.text, '')
  assert.strictEqual(legacyImageOnlyResult.ir_text, '')
  assert.strictEqual(legacyImageOnlyResult.words_result.length, 1)
  assert.strictEqual(legacyImageOnlyResult.words_result[0].label, 'image')
  assert.strictEqual(legacyImageOnlyResult.words_result[0].words, '')
  assert.ok(!legacyImageOnlyResult.words_result.some(isManualLayoutBlock))
  assert.strictEqual(legacyImageOnlyResult.gujismart_ir.page.blocks.length, 1)
  assert.strictEqual(legacyImageOnlyResult.gujismart_ir.page.blocks[0].type, 'image')

  const singleManualResult = ocrIr.ensureOcrResultIr({
    layout_result: [{
      manual_block_id: 'm-last-block',
      segmentation_source: 'manual',
      label: 'note',
      words: '最后一个人工区块',
      reading_order: 1,
      location: { left: 20, top: 20, width: 300, height: 80 },
    }],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const clearedManualResult = ocrIr.ensureOcrResultIr({
    ...singleManualResult,
    layout_result: [],
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.notStrictEqual(
    clearedManualResult.gujismart_ir,
    singleManualResult.gujismart_ir,
    '显式空 canonical layout 必须废弃旧人工 IR',
  )
  assert.strictEqual(clearedManualResult.text, '')
  assert.strictEqual(clearedManualResult.ir_text, '')
  assert.deepStrictEqual(clearedManualResult.words_result, [])
  assert.deepStrictEqual(clearedManualResult.gujismart_ir.page.blocks, [])
  assert.deepStrictEqual(clearedManualResult.gujismart_ir.page.discardedBlocks, [])

  const clearedManualWordsResult = ocrIr.ensureOcrResultIr({
    text: singleManualResult.text,
    ir_text: singleManualResult.ir_text,
    words_result: [],
    gujismart_ir: singleManualResult.gujismart_ir,
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.notStrictEqual(
    clearedManualWordsResult.gujismart_ir,
    singleManualResult.gujismart_ir,
    '显式空 words_result 必须废弃旧人工 IR',
  )
  assert.strictEqual(clearedManualWordsResult.text, '')
  assert.strictEqual(clearedManualWordsResult.ir_text, '')
  assert.deepStrictEqual(clearedManualWordsResult.words_result, [])
  assert.deepStrictEqual(clearedManualWordsResult.gujismart_ir.page.blocks, [])
  assert.deepStrictEqual(clearedManualWordsResult.gujismart_ir.page.discardedBlocks, [])

  const legacyEmptyWordsResult = ocrIr.ensureOcrResultIr({
    text: '旧 OCR 纯文本回退',
    words_result: [],
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.strictEqual(legacyEmptyWordsResult.text, '旧 OCR 纯文本回退')
  assert.deepStrictEqual(legacyEmptyWordsResult.words_result, [])
  assert.deepStrictEqual(legacyEmptyWordsResult.gujismart_ir.page.blocks, [])

  const legacyWordsResult = ocrIr.ensureOcrResultIr({
    layout_result: [],
    words_result: [{
      label: 'text',
      words: '旧 OCR 正文',
      reading_order: 1,
      location: { left: 20, top: 20, width: 300, height: 80 },
    }],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  assert.strictEqual(legacyWordsResult.text, '旧 OCR 正文')
  assert.strictEqual(legacyWordsResult.words_result[0].words, '旧 OCR 正文')
  const legacyEmptyLayoutRoundTrip = ocrIr.ensureOcrResultIr({
    ...legacyWordsResult,
    layout_result: [],
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.strictEqual(legacyEmptyLayoutRoundTrip.gujismart_ir, legacyWordsResult.gujismart_ir)
  assert.strictEqual(legacyEmptyLayoutRoundTrip.text, '旧 OCR 正文')

  const manualWordsPayload = {
    layout_result: [],
    words_result: [{
      manual_block_id: 'm-words-canonical-source',
      segmentation_source: 'manual',
      label: 'note',
      words: '人工 words_result 来源',
      reading_order: 1,
      location: { left: 20, top: 20, width: 400, height: 100 },
    }],
  }
  const firstManualWordsEnsure = ocrIr.ensureOcrResultIr(manualWordsPayload, {
    pageWidth: 1000,
    pageHeight: 1000,
  })
  assert.strictEqual(firstManualWordsEnsure.text, '人工 words_result 来源')
  assert.deepStrictEqual(
    firstManualWordsEnsure.layout_result.map(getManualBlockId),
    ['m-words-canonical-source'],
    '人工 words_result 必须同步为稳定 canonical layout_result',
  )
  const secondManualWordsEnsure = ocrIr.ensureOcrResultIr(firstManualWordsEnsure, {
    pageWidth: 1000,
    pageHeight: 1000,
  })
  assert.strictEqual(secondManualWordsEnsure.text, firstManualWordsEnsure.text)
  assert.strictEqual(secondManualWordsEnsure.ir_text, firstManualWordsEnsure.ir_text)
  assert.deepStrictEqual(
    secondManualWordsEnsure.words_result.map(getManualBlockId),
    ['m-words-canonical-source'],
  )
  assert.deepStrictEqual(
    secondManualWordsEnsure.layout_result.map(getManualBlockId),
    ['m-words-canonical-source'],
  )
  assert.ok(
    secondManualWordsEnsure.gujismart_ir.page.blocks.some(
      (block) => block.id === 'm-words-canonical-source',
    ),
  )
  assert.strictEqual(secondManualWordsEnsure.gujismart_ir, firstManualWordsEnsure.gujismart_ir)

  const losslessTableRows = [
    [' A  B ', '  C'],
    ['第一行\r\n    第二行  ', ''],
    ['   ', 'D  E'],
  ]
  const expectedLosslessTableRows = [
    [' A  B ', '  C'],
    ['第一行\n    第二行  ', ''],
    ['   ', 'D  E'],
  ]
  const expectedLosslessTableText = ' A  B \t  C\n第一行\n    第二行  \t\n   \tD  E'
  const losslessTableResult = ocrIr.ensureOcrResultIr({
    layout_result: [{
      manual_block_id: 'm-lossless-table',
      segmentation_source: 'manual',
      label: 'table',
      words: 'STALE_TABLE_TEXT',
      rows: losslessTableRows,
      reading_order: 1,
      location: { left: 20, top: 20, width: 500, height: 300 },
    }],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const losslessTableWordsBlock = losslessTableResult.words_result.find(
    (block) => getManualBlockId(block) === 'm-lossless-table',
  )
  const losslessTableIrBlock = losslessTableResult.gujismart_ir.page.blocks.find(
    (block) => block.id === 'm-lossless-table',
  )
  assert.strictEqual(losslessTableResult.text, expectedLosslessTableText)
  assert.strictEqual(losslessTableWordsBlock.words, expectedLosslessTableText)
  assert.deepStrictEqual(losslessTableWordsBlock.rows, expectedLosslessTableRows)
  assert.deepStrictEqual(losslessTableIrBlock.table.rows, expectedLosslessTableRows)

  const unchangedLosslessTable = ocrIr.ensureOcrResultIr({
    words_result: losslessTableResult.words_result,
    gujismart_ir: losslessTableResult.gujismart_ir,
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.strictEqual(
    unchangedLosslessTable.gujismart_ir,
    losslessTableResult.gujismart_ir,
    '无损表格未修改时应继续命中缓存',
  )

  const emptyManualTable = ocrIr.ensureOcrResultIr({
    layout_result: [{
      manual_block_id: 'm-empty-table',
      segmentation_source: 'manual',
      label: 'table',
      words: 'STALE_EMPTY_TABLE_TEXT',
      rows: [['', ''], ['', '']],
      reading_order: 1,
      location: { left: 20, top: 20, width: 500, height: 300 },
    }],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const emptyTableWordsBlock = emptyManualTable.words_result.find(
    (block) => getManualBlockId(block) === 'm-empty-table',
  )
  assert.strictEqual(emptyManualTable.text, '')
  assert.strictEqual(emptyManualTable.ir_text, '')
  assert.strictEqual(emptyTableWordsBlock.words, '\t\n\t')
  assert.deepStrictEqual(emptyTableWordsBlock.rows, [['', ''], ['', '']])

  const emptyImageResult = ocrIr.ensureOcrResultIr({
    text: '已过期的图片 OCR 文字',
    words_result: [{ words: '已过期的图片 OCR 文字' }],
    layout_result: [{
      manual_block_id: 'm-empty-image',
      segmentation_source: 'manual',
      label: 'image',
      words: '不应进入文本流',
      reading_order: 1,
      location: { left: 20, top: 20, width: 100, height: 100 },
    }],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  assert.strictEqual(emptyImageResult.text, '', '空人工图片块必须清除旧页面文本，不得回退到过期 OCR')
  assert.strictEqual(emptyImageResult.words_result[0].words, '')

  const mixedOrientationResult = ocrIr.ensureOcrResultIr({
    layout_result: [
      {
        label: 'text', words: '竖排旧 OCR 正文一', reading_order: 1, orientation: 'vertical',
        location: { left: 800, top: 20, width: 40, height: 500 },
      },
      {
        label: 'text', words: '竖排旧 OCR 正文二', reading_order: 2, orientation: 'vertical',
        location: { left: 740, top: 20, width: 40, height: 500 },
      },
      {
        manual_block_id: 'm-horizontal', segmentation_source: 'manual', label: 'note',
        words: '人工横排夹注', reading_order: 9, orientation: 'horizontal',
        location: { left: 100, top: 700, width: 600, height: 50 },
      },
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const manualHorizontal = mixedOrientationResult.gujismart_ir.page.blocks.find((block) => block.id === 'm-horizontal')
  assert.strictEqual(manualHorizontal.orientation, 'horizontal', '人工方向不得被页面 OCR 多数方向覆盖')
  assert.strictEqual(manualHorizontal.orientationSource, 'manual')

  const coordinateOrientationResult = ocrIr.ensureOcrResultIr({
    layout_result: [{
      manual_block_id: 'm-coordinate-orientation',
      segmentation_source: 'manual',
      label: 'note',
      words: '坐标推断方向',
      reading_order: 1,
      location: { left: 20, top: 20, width: 500, height: 80 },
    }],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const coordinateWordsBlock = coordinateOrientationResult.words_result.find(
    (block) => getManualBlockId(block) === 'm-coordinate-orientation',
  )
  const coordinateIrBlock = coordinateOrientationResult.gujismart_ir.page.blocks.find(
    (block) => block.id === 'm-coordinate-orientation',
  )
  assert.strictEqual(coordinateWordsBlock.orientation, 'horizontal')
  assert.strictEqual(coordinateWordsBlock.orientation_source, 'coordinate')
  assert.strictEqual(coordinateWordsBlock.source_orientation, 'horizontal')
  assert.strictEqual(coordinateWordsBlock.source_orientation_source, 'coordinate')
  assert.strictEqual(coordinateIrBlock.orientationSource, 'coordinate')

  const consensusAdjustedManualResult = ocrIr.ensureOcrResultIr({
    layout_result: [
      {
        manual_block_id: 'm-consensus-adjusted',
        segmentation_source: 'manual',
        label: 'note',
        words: '短注',
        reading_order: 1,
        location: { left: 20, top: 20, width: 500, height: 80 },
      },
      {
        label: 'text',
        words: '竖排正文内容竖排正文内容竖排正文内容竖排正文内容',
        reading_order: 2,
        orientation: 'vertical',
        location: { left: 800, top: 20, width: 40, height: 700 },
      },
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const consensusAdjustedManualBlock = consensusAdjustedManualResult.gujismart_ir.page.blocks.find(
    (block) => block.id === 'm-consensus-adjusted',
  )
  assert.strictEqual(consensusAdjustedManualBlock.sourceOrientation, 'horizontal')
  assert.strictEqual(consensusAdjustedManualBlock.sourceOrientationSource, 'coordinate')
  assert.strictEqual(consensusAdjustedManualBlock.orientation, 'vertical')
  assert.strictEqual(consensusAdjustedManualBlock.orientationSource, 'page_consensus')

  const lockedManualOrientationResult = ocrIr.ensureOcrResultIr({
    layout_result: [
      {
        manual_block_id: 'm-locked-horizontal',
        segmentation_source: 'manual',
        label: 'note',
        words: '手动锁定横排',
        reading_order: 1,
        orientation: 'horizontal',
        orientation_source: 'manual',
        source_orientation: 'horizontal',
        source_orientation_source: 'coordinate',
        location: { left: 20, top: 20, width: 500, height: 80 },
      },
      {
        label: 'text',
        words: '竖排共识正文竖排共识正文竖排共识正文竖排共识正文',
        reading_order: 2,
        orientation: 'vertical',
        location: { left: 800, top: 20, width: 40, height: 700 },
      },
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const lockedManualWordsBlock = lockedManualOrientationResult.words_result.find(
    (block) => getManualBlockId(block) === 'm-locked-horizontal',
  )
  const lockedManualIrBlock = lockedManualOrientationResult.gujismart_ir.page.blocks.find(
    (block) => block.id === 'm-locked-horizontal',
  )
  assert.strictEqual(lockedManualWordsBlock.orientation, 'horizontal')
  assert.strictEqual(lockedManualWordsBlock.orientation_source, 'manual')
  assert.strictEqual(lockedManualWordsBlock.source_orientation, 'horizontal')
  assert.strictEqual(lockedManualWordsBlock.source_orientation_source, 'coordinate')
  assert.strictEqual(lockedManualIrBlock.orientation, 'horizontal')
  assert.strictEqual(lockedManualIrBlock.orientationSource, 'manual')
  assert.strictEqual(lockedManualIrBlock.sourceOrientation, 'horizontal')
  assert.strictEqual(lockedManualIrBlock.sourceOrientationSource, 'coordinate')

  const coordinateWordsOnlySource = {
    words_result: coordinateOrientationResult.words_result,
    gujismart_ir: coordinateOrientationResult.gujismart_ir,
  }
  const unchangedCoordinateRoundTrip = ocrIr.ensureOcrResultIr(coordinateWordsOnlySource, {
    pageWidth: 1000,
    pageHeight: 1000,
  })
  assert.strictEqual(
    unchangedCoordinateRoundTrip.gujismart_ir,
    coordinateOrientationResult.gujismart_ir,
    '只有坐标推断回灌、未人工覆盖时应继续复用缓存',
  )

  const manualOrientationOverride = ocrIr.ensureOcrResultIr({
    ...coordinateWordsOnlySource,
    words_result: coordinateOrientationResult.words_result.map((block) => (
      getManualBlockId(block) === 'm-coordinate-orientation'
        ? { ...block, orientation: 'vertical', orientation_source: 'manual' }
        : block
    )),
  }, { pageWidth: 1000, pageHeight: 1000 })
  const overriddenWordsBlock = manualOrientationOverride.words_result.find(
    (block) => getManualBlockId(block) === 'm-coordinate-orientation',
  )
  const overriddenIrBlock = manualOrientationOverride.gujismart_ir.page.blocks.find(
    (block) => block.id === 'm-coordinate-orientation',
  )
  assert.strictEqual(overriddenWordsBlock.orientation, 'vertical')
  assert.strictEqual(overriddenWordsBlock.orientation_source, 'manual')
  assert.strictEqual(overriddenWordsBlock.source_orientation, 'horizontal')
  assert.strictEqual(overriddenWordsBlock.source_orientation_source, 'coordinate')
  assert.strictEqual(overriddenIrBlock.orientation, 'vertical')
  assert.strictEqual(overriddenIrBlock.orientationSource, 'manual')
  assert.strictEqual(overriddenIrBlock.sourceOrientation, 'horizontal')
  assert.strictEqual(overriddenIrBlock.sourceOrientationSource, 'coordinate')

  const manualDecorativeResult = ocrIr.ensureOcrResultIr({
    layout_result: [
      {
        manual_block_id: 'm-header', segmentation_source: 'manual', label: 'header', words: '人工页眉',
        reading_order: 1, location: { left: 10, top: 10, width: 300, height: 30 },
      },
      {
        manual_block_id: 'm-footer', segmentation_source: 'manual', label: 'footer', words: '人工页脚',
        reading_order: 2, location: { left: 10, top: 900, width: 300, height: 30 },
      },
      {
        manual_block_id: 'm-number', segmentation_source: 'manual', label: 'number', words: '一',
        reading_order: 3, location: { left: 480, top: 940, width: 40, height: 30 },
      },
    ],
  }, { pageWidth: 1000, pageHeight: 1000, forceRebuild: true })
  const manualDecorativeIds = manualDecorativeResult.words_result.map(getManualBlockId)
  assert.deepStrictEqual(
    manualDecorativeIds,
    ['m-header', 'm-footer', 'm-number'],
    '人工页眉、页脚和页码即使位于 IR discardedBlocks，往返 words_result 也不得丢失',
  )
  assert.deepStrictEqual(
    manualDecorativeResult.words_result.map((block) => block.label),
    ['header', 'footer', 'number'],
    '人工装饰区块的 canonical 类型必须保留',
  )

  const mixedLegacyAndManualResult = ocrIr.ensureOcrResultIr({
    layout_result: [
      {
        label: 'header', words: 'LEGACY_HEADER', reading_order: 1,
        location: { left: 10, top: 10, width: 400, height: 30 },
      },
      {
        label: 'text', words: 'BODY', reading_order: 2,
        location: { left: 10, top: 100, width: 400, height: 300 },
      },
      {
        manual_block_id: 'm-mixed-note', segmentation_source: 'manual', label: 'note',
        words: 'MANUAL_NOTE', reading_order: 3,
        location: { left: 420, top: 100, width: 200, height: 200 },
      },
      {
        manual_block_id: 'm-mixed-header', segmentation_source: 'manual', label: 'header',
        words: 'MANUAL_HEADER', reading_order: 4,
        location: { left: 10, top: 50, width: 400, height: 30 },
      },
      {
        label: 'footer', words: 'LEGACY_FOOTER', reading_order: 5,
        location: { left: 10, top: 900, width: 400, height: 30 },
      },
      {
        manual_block_id: 'm-mixed-footer', segmentation_source: 'manual', label: 'footer',
        words: 'MANUAL_FOOTER', reading_order: 6,
        location: { left: 10, top: 860, width: 400, height: 30 },
      },
      {
        label: 'page_number', words: 'LEGACY_PAGE_NUMBER', reading_order: 7,
        location: { left: 480, top: 940, width: 40, height: 30 },
      },
    ],
  }, { pageWidth: 1000, pageHeight: 1000 })
  assert.strictEqual(
    mixedLegacyAndManualResult.text,
    'BODY\nMANUAL_NOTE\nMANUAL_HEADER\nMANUAL_FOOTER',
    '混合人工区块时，旧 OCR 页眉、页脚和页码仍不得泄漏进正文',
  )
  assert.strictEqual(
    ocrIr.deriveOcrTextFromIr(mixedLegacyAndManualResult.gujismart_ir, true),
    'LEGACY_HEADER\nBODY\nMANUAL_NOTE\nMANUAL_HEADER\nLEGACY_FOOTER\nMANUAL_FOOTER\nLEGACY_PAGE_NUMBER',
    'includeDiscarded=true 必须继续显式包含旧 OCR 装饰区块',
  )
  assert.ok(!mixedLegacyAndManualResult.words_result.some((block) => (
    block.words === 'LEGACY_HEADER'
    || block.words === 'LEGACY_FOOTER'
    || block.words === 'LEGACY_PAGE_NUMBER'
  )))
  assert.deepStrictEqual(
    mixedLegacyAndManualResult.words_result
      .map(getManualBlockId)
      .filter(Boolean),
    ['m-mixed-note', 'm-mixed-header', 'm-mixed-footer'],
    '人工 note/header/footer 必须继续完整往返',
  )

  console.log('Manual layout block regression passed')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

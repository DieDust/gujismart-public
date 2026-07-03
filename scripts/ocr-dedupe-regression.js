const assert = require('assert')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-ocr-dedupe-'))
const bundlePath = join(tempRoot, 'ocr-dedupe-bundle.cjs')
const entryPath = join(tempRoot, 'ocr-dedupe-entry.js')

writeFileSync(entryPath, `
  const ocr = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'ocr.ts'))})
  const ocrText = require(${JSON.stringify(join(__dirname, '..', 'src', 'renderer', 'src', 'utils', 'ocrText.ts'))})
  const translationSource = require(${JSON.stringify(join(__dirname, '..', 'src', 'shared', 'translation-source.ts'))})
  module.exports = { ocr, ocrText, translationSource }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3', '@napi-rs/canvas'],
  alias: {
    '@shared': join(__dirname, '..', 'src', 'shared'),
    electron: join(__dirname, 'stubs', 'electron.js'),
  },
  logLevel: 'silent',
})

function block(words, left, top, width = 42, height = 360, extra = {}) {
  return {
    words,
    label: 'vertical_text',
    location: { left, top, width, height },
    score: 0.9,
    ...extra,
  }
}

try {
  const { ocr, ocrText, translationSource } = require(bundlePath)
  const runawayRepeatIssue = ocr.findSuspiciousRepeatedOcrText({
    words_result: [{ words: '<table><tr><td>第一課 ' + '金魚'.repeat(1023) + '</td></tr></table>' }],
    layout_result: [{ words: '第一課 ' + Array.from({ length: 1023 }, () => '金魚').join('\n') }],
    markdown: { text: '<table><tr><td>第一課 ' + Array.from({ length: 1023 }, () => '金魚').join('\n') + '</td></tr></table>' },
  })
  assert.ok(runawayRepeatIssue)
  assert.strictEqual(runawayRepeatIssue.unit, '金魚')
  assert.ok(runawayRepeatIssue.repeatCount >= 1000)
  assert.ok(ocr.formatSuspiciousRepeatedOcrTextIssue(runawayRepeatIssue).includes('OCR 结果疑似重复生成'))

  const normalRepeatIssue = ocr.findSuspiciousRepeatedOcrText({
    words_result: [{ words: Array.from({ length: 24 }, (_item, index) => `第${index + 1}課 金魚`).join('\n') }],
  })
  assert.strictEqual(normalRepeatIssue, null)

  const repeatedText = 'county council report about school affairs and public administration procedure '.repeat(5)
  const repeated = Array.from({ length: 5 }, (_item, index) => block(repeatedText, 120 + index * 48, 80, 44, 620, { reading_order: index }))
  const repeatedResult = ocr.normalizePageResult({ layout_result: repeated, text: repeated.map((item) => item.words).join('\n') })
  assert.strictEqual(repeatedResult.layout_result.length, 5)
  assert.strictEqual(repeatedResult.words_result.length, 1)
  assert.strictEqual(repeatedResult.dedupe_meta.removed_duplicate_blocks, 4)
  assert.ok(repeatedResult.layout_result.every((item) => item.words))
  assert.ok(!repeatedResult.layout_result.some((item) => item.deduped_duplicate))

  const adjacent = ocr.normalizePageResult({
    layout_result: [
      block('budget report should be handled according to the regulation', 400, 80),
      block('work report and school status should be filed separately', 340, 80),
      block('administrative order for meeting memorial procedures', 280, 80),
    ],
  })
  assert.strictEqual(adjacent.layout_result.length, 3)
  assert.strictEqual(adjacent.words_result.length, 3)

  const shortRepeated = ocr.normalizePageResult({
    layout_result: [
      block('report', 100, 80, 32, 70),
      block('report', 145, 80, 32, 70),
      block('report', 190, 80, 32, 70),
    ],
  })
  assert.strictEqual(shortRepeated.layout_result.length, 3)

  const nearDuplicate = ocr.normalizePageResult({
    layout_result: [
      block('county government work report and school affairs stop the memorial week procedure', 240, 100, 44, 420, { score: 0.8 }),
      block('county government work report and school affairs stop the memorial week procedure report', 242, 112, 44, 410, { score: 0.9 }),
    ],
  })
  assert.strictEqual(nearDuplicate.layout_result.length, 2)
  assert.strictEqual(nearDuplicate.words_result.length, 1)
  assert.strictEqual(nearDuplicate.dedupe_meta.removed_duplicate_blocks, 1)
  assert.ok(nearDuplicate.layout_result.every((item) => item.words))
  assert.ok(!nearDuplicate.layout_result.some((item) => item.deduped_duplicate))

  const rawWordsCanContainRepeatedColumnText = ocr.normalizePageResult({
    layout_result: [
      block('A', 300, 80, 30, 300, { raw_words: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
      block('B', 260, 80, 30, 300, { raw_words: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
      block('C', 220, 80, 30, 300, { raw_words: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
    ],
  })
  assert.deepStrictEqual(rawWordsCanContainRepeatedColumnText.layout_result.map((item) => item.words), ['A', 'B', 'C'])
  assert.deepStrictEqual(rawWordsCanContainRepeatedColumnText.words_result.map((item) => item.words), ['A', 'B', 'C'])

  const firstBody = 'Xiangxi became a regional name because administrative divisions shaped this concept. It began as a modern administrative term, and it stabilized through repeated adjustments, evidence, comparison, and local practice.'
  const secondBody = 'Putting greater Xiangxi into a single administrative area began in the Qing period, and the later republican system adjusted it again.'
  const modernArticle = ocr.normalizePageResult({
    markdown: [
      '# Xiangxi administrative divisions',
      'Lead paragraph, with modern horizontal punctuation, enough length, and clear sentence flow.',
      '## Part one',
      firstBody,
      '<div><img src="imgs/img_in_image_box_669_418_1113_1076.jpg" alt="Image" /></div>',
      '## Part two',
      secondBody,
    ].join('\n'),
    layout_result: [
      { words: 'Xiangxi administrative divisions', label: 'doc_title', location: { left: 175, top: 156, width: 923, height: 110 }, block_order: 1 },
      { words: 'Part two', label: 'paragraph_title', location: { left: 737, top: 1318, width: 315, height: 29 }, block_order: 8 },
      { words: secondBody, label: 'text', location: { left: 632, top: 1379, width: 524, height: 124 }, block_order: 9 },
      { words: 'Lead paragraph, with modern horizontal punctuation, enough length, and clear sentence flow.', label: 'text', location: { left: 103, top: 423, width: 508, height: 126 }, block_order: 3 },
      { words: 'Part one', label: 'paragraph_title', location: { left: 243, top: 578, width: 226, height: 31 }, block_order: 4 },
      { words: firstBody, label: 'text', location: { left: 101, top: 638, width: 514, height: 861 }, block_order: 5, orientation: 'vertical' },
    ],
  })
  const articleTexts = modernArticle.layout_result.map((item) => item.words)
  assert.ok(articleTexts.indexOf('Part one') < articleTexts.indexOf('Part two'))
  assert.strictEqual(modernArticle.layout_result.find((item) => item.words === firstBody)?.orientation, 'horizontal')
  assert.ok(modernArticle.layout_result.some((item) => item.label === 'image' && item.location.left === 669 && item.location.top === 418))

  const legacyArticle = {
    ocr_result: {
      layout_result: [
        { words: 'title', label: 'doc_title', location: { left: 100, top: 100, width: 400, height: 40 }, reading_order: 0, block_order: 1 },
        { words: 'part two', label: 'paragraph_title', location: { left: 700, top: 1300, width: 240, height: 30 }, reading_order: 2, block_order: 8 },
        { words: 'second body', label: 'text', location: { left: 630, top: 1360, width: 500, height: 120 }, reading_order: 3, block_order: 9 },
        { words: '6', label: 'number', location: { left: 600, top: 1580, width: 40, height: 40 }, reading_order: 5, block_order: 0 },
        { words: 'header', label: 'header', location: { left: 100, top: 10, width: 300, height: 60 }, reading_order: 6, block_order: 0 },
        { words: 'lead', label: 'text', location: { left: 100, top: 420, width: 500, height: 120 }, reading_order: 7, block_order: 3 },
        { words: 'part one', label: 'paragraph_title', location: { left: 240, top: 580, width: 220, height: 30 }, reading_order: 8, block_order: 4 },
        { words: firstBody, label: 'text', location: { left: 100, top: 640, width: 510, height: 860 }, reading_order: 9, block_order: 5, orientation: 'vertical' },
        { words: 'footer', label: 'footer', location: { left: 0, top: 1620, width: 370, height: 20 }, reading_order: 11, block_order: 0 },
      ],
    },
  }
  const legacyTexts = ocrText.getOrderedOcrBlocks(legacyArticle).map((item) => item.words)
  assert.ok(legacyTexts.indexOf('part one') < legacyTexts.indexOf('part two'))
  assert.ok(legacyTexts.indexOf('6') > legacyTexts.indexOf('part two'))
  const legacyTranslationTexts = translationSource.getCanonicalTranslationBlocksFromOcrResult(legacyArticle.ocr_result).map((item) => item.words)
  assert.ok(legacyTranslationTexts.indexOf('part one') < legacyTranslationTexts.indexOf('part two'))

  console.log('OCR dedupe regression passed')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

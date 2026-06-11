const assert = require('assert')
const { mkdtempSync, rmSync, writeFileSync } = require('fs')
const { join } = require('path')
const { buildSync } = require('esbuild')

const tempRoot = mkdtempSync(join(__dirname, '.tmp-ocr-dedupe-'))
const bundlePath = join(tempRoot, 'ocr-dedupe-bundle.cjs')
const entryPath = join(tempRoot, 'ocr-dedupe-entry.js')

writeFileSync(entryPath, `
  const ocr = require(${JSON.stringify(join(__dirname, '..', 'src', 'main', 'ocr.ts'))})
  module.exports = { ocr }
`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  external: ['better-sqlite3'],
  alias: {
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
  const { ocr } = require(bundlePath)
  const repeatedText = '八層奉內政部民字第五五二三號代電以縣參議員於開會時如有始終不出席者即認為無正當理由一律依照縣參議會組織條例辦理'
  const repeated = Array.from({ length: 5 }, (_, index) => block(repeatedText, 120 + index * 48, 80, 44, 620, { reading_order: index }))
  const repeatedResult = ocr.normalizePageResult({ layout_result: repeated, text: repeated.map((item) => item.words).join('\n') })
  assert.strictEqual(repeatedResult.layout_result.length, 5)
  assert.strictEqual(repeatedResult.words_result.length, 1)
  assert.strictEqual(repeatedResult.dedupe_meta.removed_duplicate_blocks, 4)
  assert.ok(repeatedResult.layout_result.every((item) => item.words))
  assert.ok(!repeatedResult.layout_result.some((item) => item.deduped_duplicate))

  const adjacent = ocr.normalizePageResult({
    layout_result: [
      block('核縣決算為其職權關於縣預算之報告應照章辦理', 400, 80),
      block('等因特提會報告縣政府工作報告及各級學校概況', 340, 80),
      block('層奉行政院令以總理紀念週及開會默讀遺囑辦法', 280, 80),
    ],
  })
  assert.strictEqual(adjacent.layout_result.length, 3)
  assert.strictEqual(adjacent.words_result.length, 3)

  const shortRepeated = ocr.normalizePageResult({
    layout_result: [
      block('報告', 100, 80, 32, 70),
      block('報告', 145, 80, 32, 70),
      block('報告', 190, 80, 32, 70),
    ],
  })
  assert.strictEqual(shortRepeated.layout_result.length, 3)

  const nearDuplicate = ocr.normalizePageResult({
    layout_result: [
      block('縣政府工作報告及各級學校一律停止舉行總理紀念週', 240, 100, 44, 420, { score: 0.8 }),
      block('縣政府工作報告及各級學校一律停止舉行總理紀念週報', 242, 112, 44, 410, { score: 0.9 }),
    ],
  })
  assert.strictEqual(nearDuplicate.layout_result.length, 2)
  assert.strictEqual(nearDuplicate.words_result.length, 1)
  assert.strictEqual(nearDuplicate.dedupe_meta.removed_duplicate_blocks, 1)
  assert.ok(nearDuplicate.layout_result.every((item) => item.words))
  assert.ok(!nearDuplicate.layout_result.some((item) => item.deduped_duplicate))

  const rawWordsCanContainRepeatedColumnText = ocr.normalizePageResult({
    layout_result: [
      block('甲', 300, 80, 30, 300, { raw_words: '甲乙丙丁戊己庚辛壬癸' }),
      block('乙', 260, 80, 30, 300, { raw_words: '甲乙丙丁戊己庚辛壬癸' }),
      block('丙', 220, 80, 30, 300, { raw_words: '甲乙丙丁戊己庚辛壬癸' }),
    ],
  })
  assert.deepStrictEqual(rawWordsCanContainRepeatedColumnText.layout_result.map((item) => item.words), ['甲', '乙', '丙'])
  assert.deepStrictEqual(rawWordsCanContainRepeatedColumnText.words_result.map((item) => item.words), ['甲', '乙', '丙'])

  console.log('OCR dedupe regression passed')
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

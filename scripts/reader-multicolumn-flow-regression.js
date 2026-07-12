const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-reader-multicolumn-'))
const entryPath = path.join(tempRoot, 'entry.js')
const bundlePath = path.join(tempRoot, 'bundle.cjs')

function block(words, left, top, width, blockOrder, extra = {}) {
  return {
    words,
    label: 'text',
    block_order: blockOrder,
    reading_order: blockOrder,
    location: { left, top, width, height: 18 },
    ...extra,
  }
}

fs.writeFileSync(entryPath, `module.exports = require(${JSON.stringify(path.join(root, 'src', 'renderer', 'src', 'utils', 'ocrText.ts'))})\n`)

buildSync({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundlePath,
  alias: { '@shared': path.join(root, 'src', 'shared') },
  logLevel: 'silent',
})

try {
  const { getReadablePageElements } = require(bundlePath)
  const layoutResult = [
    block('论文标题', 250, 20, 160, 1),
    block('作者', 310, 48, 60, 2),
    block('左栏第一行尚未结束', 70, 100, 190, 3),
    block('右栏第一行尚未结束', 360, 100, 190, 4),
    block('左栏第二行继续。', 70, 124, 190, 5),
    block('右栏第二行继续。', 360, 124, 190, 6),
    block('一、跨栏小标题', 70, 164, 480, 7, { label: 'section_title' }),
    block('下部左栏第一行', 70, 202, 190, 8),
    block('下部右栏第一行', 360, 202, 190, 9),
    block('下部左栏第二行。', 70, 226, 190, 10),
    block('下部右栏第二行。', 360, 226, 190, 11),
  ]
  const page = { page_num: 1, ocr_result: { layout_result: layoutResult } }
  const elements = getReadablePageElements(page)
  const texts = elements.map((element) => element.text)

  assert.deepStrictEqual(texts, [
    '论文标题',
    '作者',
    '左栏第一行尚未结束左栏第二行继续。',
    '右栏第一行尚未结束右栏第二行继续。',
    '一、跨栏小标题',
    '下部左栏第一行下部左栏第二行。',
    '下部右栏第一行下部右栏第二行。',
  ], 'two-column reading mode should read each column continuously and merge OCR line boxes')

  const singleColumn = getReadablePageElements({
    page_num: 1,
    ocr_result: {
      layout_result: [
        block('单栏短行一。', 80, 80, 160, 1),
        block('单栏较长的第二行保持原顺序。', 80, 104, 420, 2),
        block('单栏短行三。', 80, 128, 160, 3),
        block('单栏较长的第四行保持原顺序。', 80, 152, 420, 4),
        block('单栏短行五。', 80, 176, 160, 5),
        block('单栏较长的第六行保持原顺序。', 80, 200, 420, 6),
        block('单栏短行七。', 80, 224, 160, 7),
        block('单栏较长的第八行保持原顺序。', 80, 248, 420, 8),
      ],
    },
  }).map((element) => element.text)
  assert.deepStrictEqual(singleColumn, [
    '单栏短行一。',
    '单栏较长的第二行保持原顺序。',
    '单栏短行三。',
    '单栏较长的第四行保持原顺序。',
    '单栏短行五。',
    '单栏较长的第六行保持原顺序。',
    '单栏短行七。',
    '单栏较长的第八行保持原顺序。',
  ], 'variable-width single-column lines must not be mistaken for multiple columns')

  const manuallyOrdered = getReadablePageElements({
    page_num: 1,
    ocr_result: {
      layout_result: [
        block('左栏', 70, 100, 190, 1, { manual_reading_order: 2 }),
        block('右栏', 360, 100, 190, 2, { manual_reading_order: 1 }),
      ],
    },
  }).map((element) => element.text)
  assert.deepStrictEqual(manuallyOrdered, ['右栏', '左栏'], 'manual proofreading order must remain authoritative')

  console.log('Reader multi-column flow regression passed.')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

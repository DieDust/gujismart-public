const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const helperPath = path.join(root, 'src/renderer/src/utils/facsimileTableEditing.ts')
const helperSource = fs.readFileSync(helperPath, 'utf8')
const transpiled = ts.transpileModule(helperSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const helperModule = { exports: {} }
new Function('exports', 'module', 'require', transpiled)(helperModule.exports, helperModule, require)

const {
  buildFacsimileTableCells,
  getFacsimileTableSelection,
  insertFacsimileTableRow,
  mergeFacsimileTableSelection,
  normalizeFacsimileTableRows,
  splitFacsimileTableCell,
} = helperModule.exports

const rows = normalizeFacsimileTableRows([['甲', '乙'], ['丙', '丁']])
const selection = getFacsimileTableSelection({ row: 1, col: 1 }, { row: 0, col: 0 })
assert.deepStrictEqual(selection, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 }, 'Shift selection must normalize into a rectangular range')

const merged = mergeFacsimileTableSelection(rows, [], selection)
assert.deepStrictEqual(merged.merges, [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }], 'visual table editor must create a real 2x2 merged cell')
assert.strictEqual(merged.rows[0][0], '甲\n乙\n丙\n丁', 'merging cells must preserve every cell value in reading order')
assert.strictEqual(buildFacsimileTableCells(merged.rows, merged.merges).length, 1, 'covered merged cells must not be serialized as duplicate cells')
assert.deepStrictEqual(
  buildFacsimileTableCells(merged.rows, merged.merges)[0],
  { row: 0, col: 0, text: '甲\n乙\n丙\n丁', rowSpan: 2, colSpan: 2, row_span: 2, col_span: 2 },
  'saved OCR cells must preserve rowSpan and colSpan for later rendering',
)

const inserted = insertFacsimileTableRow(merged.rows, merged.merges, 1)
assert.strictEqual(inserted.rows.length, 3, 'row insertion must update the visible grid')
assert.strictEqual(inserted.merges[0].rowSpan, 3, 'inserting inside a merged range must expand the merged cell')
const split = splitFacsimileTableCell(inserted.rows, inserted.merges, { row: 2, col: 1 })
assert.strictEqual(split.merges.length, 0, 'split must work when the selected coordinate is a covered merged cell')

const proofreader = fs.readFileSync(path.join(root, 'src/renderer/src/components/GujiFacsimileProofreader.tsx'), 'utf8')
assert.ok(proofreader.includes('onMouseDown={handlePageLayoutMouseDown}'), 'blank page dragging must create a manual text box')
assert.ok(proofreader.includes('BLOCK_RESIZE_HANDLES.map'), 'the active text box must expose edge and corner resize handles')
assert.ok(proofreader.includes("setImageUnderlayMode('on')"), 'entering manual editing must automatically enable the page image underlay')
assert.ok(proofreader.includes("segmentation_source: 'manual'"), 'manual text, table, and geometry edits must be marked as manual data')
assert.ok(proofreader.includes('<FacsimileTableEditor'), 'recognized tables must use the visual grid editor instead of raw table code')
assert.ok(proofreader.includes("String(block.segmentation_source || '').toLowerCase() !== 'manual'"), 'manual tables must not be converted back into pseudo text tables on vertical pages')

console.log('Facsimile layout editor regression passed.')

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
  clearFacsimileTableSelection,
  deleteFacsimileTableColumn,
  deleteFacsimileTableRow,
  FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH,
  FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT,
  FACSIMILE_TABLE_MAX_CELLS,
  FACSIMILE_TABLE_MAX_COLUMN_WIDTH,
  FACSIMILE_TABLE_MAX_COLUMNS,
  FACSIMILE_TABLE_MAX_ROW_HEIGHT,
  FACSIMILE_TABLE_MAX_ROWS,
  FACSIMILE_TABLE_MIN_COLUMN_WIDTH,
  FACSIMILE_TABLE_MIN_ROW_HEIGHT,
  getFacsimileTableSelection,
  getFacsimileTableWholeColumnSelection,
  getFacsimileTableWholeRowSelection,
  insertFacsimileTableColumn,
  insertFacsimileTableRow,
  mergeFacsimileTableSelection,
  normalizeFacsimileTableColumnWidths,
  normalizeFacsimileTableMerges,
  normalizeFacsimileTableRows,
  normalizeFacsimileTableRowHeights,
  normalizeFacsimileTableSelection,
  parseFacsimileTableClipboard,
  parseFacsimileTableClipboardData,
  pasteFacsimileTableRange,
  splitFacsimileTableCell,
} = helperModule.exports

assert.deepStrictEqual(
  parseFacsimileTableClipboard('\u7532\t\u4e59\n\u4e19\t\u4e01'),
  [['\u7532', '\u4e59'], ['\u4e19', '\u4e01']],
  'plain text clipboard data must preserve TSV rows and columns',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard('\u7532\t\u4e59\r\n\u4e19\t\r\n'),
  [['\u7532', '\u4e59'], ['\u4e19', ''], ['', '']],
  'CRLF, trailing empty cells, and a trailing empty row must be preserved',
)
assert.deepStrictEqual(parseFacsimileTableClipboard(''), [], 'an empty clipboard must not create a phantom cell')
assert.deepStrictEqual(parseFacsimileTableClipboard(null), [], 'malformed clipboard input must safely produce no cells')
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table><tr><td>\u7532&amp;\u4e59</td><td>\u4e19<br>\u4e01</td></tr><tr><th>&lt;\u620a&gt;</th><td>&nbsp;</td></tr></table>',
  }),
  [['\u7532&\u4e59', '\u4e19\n\u4e01'], ['<\u620a>', ' ']],
  'HTML table clipboard data must decode common entities and preserve line breaks without a DOM',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<TABLE><TR><TD>A<br>B<br/>C<br class="x">D<BR style="display:block">E</TD></TR></TABLE>',
  }),
  [['A\nB\nC\nD\nE']],
  'all valid BR forms, including attributes and uppercase tags, must become line breaks',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table data-label="outer>value"><tr data-row=\'left>right\'><td title="x>y">A<br title="a>b">B</td><th data-x=\'a>b\'>C<br data-x=\'c>d\'/>D</th></tr></table>',
  }),
  [['A\nB', 'C\nD']],
  'quoted greater-than signs in double- and single-quoted table, row, cell, and BR attributes must not leak into cell text',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table><tr><td title="unterminated>A</td></tr></table>',
    text: 'safe\tfallback',
  }),
  [['safe', 'fallback']],
  'malformed HTML with an unclosed attribute quote must safely fall back to plain text',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({
    html: '<table><tr><td>&copy;&reg;&trade;&mdash;&ndash;&hellip;&nbsp;&quot;&apos;&amp;&lt;&gt;&#30002;&#x4E59;</td></tr></table>',
  }),
  [['\u00a9\u00ae\u2122\u2014\u2013\u2026 "\'&<>\u7532\u4e59']],
  'HTML clipboard parsing must decode common named, decimal, and hexadecimal entities',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({ html: '<table><tr><td>&bogus; &copy &#x110000;</td></tr></table>' }),
  [['&bogus; &copy &#x110000;']],
  'unknown and malformed entities must be preserved verbatim',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({ html: '<table><tr><td>&middot;&emsp;&ensp;&not-in-the-list;</td></tr></table>' }),
  [['\u00b7\u2003\u2002&not-in-the-list;']],
  'common spacing entities must decode while unknown named entities remain verbatim',
)
assert.deepStrictEqual(
  parseFacsimileTableClipboard({ html: '<div>not a table</div>', text: 'fallback\tvalue' }),
  [['fallback', 'value']],
  'malformed or irrelevant HTML must safely fall back to plain text',
)

const rowspanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><td rowspan="2">A</td><td>B</td></tr><tr><td>C</td></tr></table>',
})
assert.deepStrictEqual(rowspanClipboard.rows, [['A', 'B'], ['', 'C']], 'rowspan must reserve its covered column on following rows')
assert.deepStrictEqual(rowspanClipboard.merges, [{ row: 0, col: 0, rowSpan: 2, colSpan: 1 }], 'rowspan must be exposed as merge metadata')
assert.strictEqual(rowspanClipboard.source, 'html')
assert.strictEqual(rowspanClipboard.truncated, false)

const colspanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><td colspan="2">A</td><td>B</td></tr></table>',
})
assert.deepStrictEqual(colspanClipboard.rows, [['A', '', 'B']], 'colspan must reserve covered columns in the current row')
assert.deepStrictEqual(colspanClipboard.merges, [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }])

const combinedSpanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><th rowspan="2" colspan="2">A</th><td>B</td></tr><tr><td>C</td></tr></table>',
})
assert.deepStrictEqual(combinedSpanClipboard.rows, [['A', '', 'B'], ['', '', 'C']], 'combined row and column spans must build a rectangular placeholder grid')
assert.deepStrictEqual(combinedSpanClipboard.merges, [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }], 'combined spans must retain their normalized merge range')

const maliciousSpanClipboard = parseFacsimileTableClipboardData({
  html: '<table><tr><td rowspan="999999999999999999" colspan="999999999999999999">A</td></tr></table>',
})
assert.strictEqual(maliciousSpanClipboard.truncated, true, 'malicious spans must be clamped and reported instead of expanding without bound')
assert.ok(maliciousSpanClipboard.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
assert.ok((maliciousSpanClipboard.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_COLUMNS)
assert.ok(maliciousSpanClipboard.rows.length * (maliciousSpanClipboard.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_CELLS)

{
  const veryTallRows = Array.from({ length: 130_000 }, () => ['x'])
  assert.doesNotThrow(() => normalizeFacsimileTableRows(veryTallRows, 0, 0), 'normalizing 130,000 rows must not spread into Math.max arguments')
  const veryTallText = `${'x\n'.repeat(130_000)}tail`
  const parsed = parseFacsimileTableClipboardData(veryTallText)
  assert.strictEqual(parsed.source, 'text')
  assert.strictEqual(parsed.truncated, true, 'large text clipboard input must report its budget truncation')
  assert.ok(parsed.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
  assert.ok(parsed.rows.length * (parsed.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_CELLS)
}

{
  const htmlUnit = '<tr><td data-note="x>y">value</td></tr>'
  const largeHtml = `<table>${htmlUnit.repeat(Math.ceil(2_400_000 / htmlUnit.length))}<td title="unclosed`
  assert.ok(Buffer.byteLength(largeHtml) >= 2_400_000, 'large HTML fixture must exercise a multi-megabyte clipboard')
  const heapBefore = process.memoryUsage().heapUsed
  const startedAt = process.hrtime.bigint()
  const parsed = parseFacsimileTableClipboardData({ html: largeHtml })
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore
  assert.strictEqual(parsed.truncated, true)
  assert.strictEqual(parsed.source, 'html', 'the parser must stop at its budget instead of tokenizing a malformed tail')
  assert.ok(parsed.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
  assert.ok(parsed.rows.length * (parsed.rows[0]?.length || 0) <= FACSIMILE_TABLE_MAX_CELLS)
  assert.ok(elapsedMs < 10_000, `streaming HTML parsing took an unexpectedly long ${elapsedMs.toFixed(1)}ms`)
  assert.ok(heapGrowth < 128 * 1024 * 1024, `streaming HTML parsing retained an unexpected ${Math.round(heapGrowth / 1024 / 1024)}MB`)
}

const rows = normalizeFacsimileTableRows([['甲', '乙'], ['丙', '丁']])
const selection = getFacsimileTableSelection({ row: 1, col: 1 }, { row: 0, col: 0 })
assert.deepStrictEqual(selection, { startRow: 0, endRow: 1, startCol: 0, endCol: 1 }, 'Shift selection must normalize into a rectangular range')
assert.deepStrictEqual(
  normalizeFacsimileTableSelection({ row: 9, col: -4 }, { row: 1, col: 6 }, 4, 5),
  { startRow: 1, endRow: 3, startCol: 0, endCol: 4 },
  'drag selection must normalize direction and clamp to table bounds',
)
assert.deepStrictEqual(
  normalizeFacsimileTableSelection({ row: Number.NaN, col: Number.POSITIVE_INFINITY }, { row: -1, col: -1 }, 0, 0),
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  'invalid coordinates and empty dimensions must degrade to a stable origin selection',
)
assert.deepStrictEqual(
  getFacsimileTableWholeRowSelection(2, 0, 3, 4),
  { startRow: 0, endRow: 2, startCol: 0, endCol: 3 },
  'row headers must select complete rows across every column',
)
assert.deepStrictEqual(
  getFacsimileTableWholeColumnSelection(3, 1, 4, 4),
  { startRow: 0, endRow: 3, startCol: 1, endCol: 3 },
  'column headers must select complete columns across every row',
)

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

const cleared = clearFacsimileTableSelection(
  [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }, { row: 2, col: 0, rowSpan: 1, colSpan: 2 }],
  { startRow: 0, endRow: 1, startCol: 1, endCol: 2 },
)
assert.deepStrictEqual(
  cleared.rows,
  [['1', '', ''], ['4', '', ''], ['7', '8', '9']],
  'clearing a multi-cell selection must clear every selected cell',
)
assert.deepStrictEqual(
  cleared.merges,
  [{ row: 2, col: 0, rowSpan: 1, colSpan: 2 }],
  'clearing through a merged range must remove only intersecting merges',
)

const pasteRows = [['origin', 'value']]
const pasted = pasteFacsimileTableRange(
  pasteRows,
  [],
  { row: 3, col: 4 },
  [['\u7532', '\u4e59'], ['\u4e19', '\u4e01']],
)
assert.strictEqual(pasted.rows.length, 5)
assert.strictEqual(pasted.rows[0].length, 6)
assert.strictEqual(pasted.rows[4][5], '\u4e01')
assert.deepStrictEqual(pasteRows, [['origin', 'value']], 'range paste must not mutate caller-owned rows')

const pastedAcrossMerge = pasteFacsimileTableRange(
  [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }, { row: 2, col: 1, rowSpan: 1, colSpan: 2 }],
  { row: 1, col: 1 },
  [['x', 'y']],
)
assert.deepStrictEqual(
  pastedAcrossMerge.merges,
  [{ row: 2, col: 1, rowSpan: 1, colSpan: 2 }],
  'pasting through a merged range must remove the intersecting merge without disturbing separate merges',
)
const pastedClipboardMerge = pasteFacsimileTableRange(
  [['0:0', '0:1', '0:2', '0:3'], ['1:0', '1:1', '1:2', '1:3'], ['2:0', '2:1', '2:2', '2:3'], ['3:0', '3:1', '3:2', '3:3']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }, { row: 3, col: 2, rowSpan: 1, colSpan: 2 }],
  { row: 1, col: 1 },
  [['A', ''], ['C', 'D']],
  [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }],
)
assert.deepStrictEqual(
  pastedClipboardMerge.merges,
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }, { row: 3, col: 2, rowSpan: 1, colSpan: 2 }],
  'clipboard merges must offset from the paste origin while replacing only conflicting target merges',
)
assert.strictEqual(pastedClipboardMerge.truncated, false)

{
  const largeMatrix = Array.from(
    { length: FACSIMILE_TABLE_MAX_ROWS + 10 },
    () => Array(FACSIMILE_TABLE_MAX_COLUMNS + 10).fill('x'),
  )
  const heapBefore = process.memoryUsage().heapUsed
  const rejected = pasteFacsimileTableRange([['base']], [], { row: Number.MAX_SAFE_INTEGER, col: Number.MAX_SAFE_INTEGER }, largeMatrix)
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore
  assert.deepStrictEqual(rejected.rows, [['base']], 'huge paste origins must not allocate a sparse or giant grid')
  assert.strictEqual(rejected.truncated, true, 'a paste rejected by its origin budget must be reported')
  assert.ok(heapGrowth < 64 * 1024 * 1024, `rejected paste retained an unexpected ${Math.round(heapGrowth / 1024 / 1024)}MB`)

  const bounded = pasteFacsimileTableRange([['base']], [], { row: 0, col: 0 }, largeMatrix)
  assert.strictEqual(bounded.truncated, true, 'large paste matrices must report truncation')
  assert.ok(bounded.rows.length <= FACSIMILE_TABLE_MAX_ROWS)
  assert.ok(bounded.rows[0].length <= FACSIMILE_TABLE_MAX_COLUMNS)
  assert.ok(bounded.rows.length * bounded.rows[0].length <= FACSIMILE_TABLE_MAX_CELLS)

  const tallBase = Array.from({ length: FACSIMILE_TABLE_MAX_ROWS }, () => ['base'])
  const farColumn = pasteFacsimileTableRange(
    tallBase,
    [],
    { row: 0, col: FACSIMILE_TABLE_MAX_COLUMNS - 1 },
    [['x']],
  )
  assert.strictEqual(farColumn.truncated, true, 'base dimensions must participate in the final paste cell budget')
  assert.ok(farColumn.rows.length * farColumn.rows[0].length <= FACSIMILE_TABLE_MAX_CELLS)
  assert.strictEqual(farColumn.rows[0][0], 'base', 'a paste that cannot fit beside a tall base table must preserve existing data')
}
assert.deepStrictEqual(
  pasteFacsimileTableRange([['a']], [], { row: -5, col: Number.NaN }, [['x']]).rows,
  [['x']],
  'invalid paste coordinates must be clamped to the table origin',
)
assert.deepStrictEqual(
  pasteFacsimileTableRange([['a']], [], { row: 0, col: 0 }, []).rows,
  [['a']],
  'empty paste data must leave the table unchanged',
)

const structuralRows = Array.from({ length: 5 }, (_, row) => Array.from({ length: 5 }, (_, col) => `${row}:${col}`))
const structuralMerge = [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }]
const rowInserted = insertFacsimileTableRow(structuralRows, structuralMerge, 2)
assert.deepStrictEqual(rowInserted.merges, [{ row: 1, col: 1, rowSpan: 3, colSpan: 2 }], 'row insertion inside a merge must expand rowSpan')
const columnInserted = insertFacsimileTableColumn(structuralRows, structuralMerge, 2)
assert.deepStrictEqual(columnInserted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 3 }], 'column insertion inside a merge must expand colSpan')
assert.deepStrictEqual(
  insertFacsimileTableRow(structuralRows, structuralMerge, 0).merges,
  [{ row: 2, col: 1, rowSpan: 2, colSpan: 2 }],
  'inserting a row before a merge must move its anchor without changing rowSpan',
)
assert.deepStrictEqual(
  insertFacsimileTableColumn(structuralRows, structuralMerge, 0).merges,
  [{ row: 1, col: 2, rowSpan: 2, colSpan: 2 }],
  'inserting a column before a merge must move its anchor without changing colSpan',
)
const rowDeleted = deleteFacsimileTableRow(structuralRows, [{ row: 1, col: 1, rowSpan: 3, colSpan: 2 }], 1)
assert.deepStrictEqual(rowDeleted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }], 'deleting the first row of a merge must retain a normalized anchor and rowSpan')
const columnDeleted = deleteFacsimileTableColumn(structuralRows, [{ row: 1, col: 1, rowSpan: 2, colSpan: 3 }], 1)
assert.deepStrictEqual(columnDeleted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }], 'deleting the first column of a merge must retain a normalized anchor and colSpan')
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, structuralMerge, 0).merges,
  [{ row: 0, col: 1, rowSpan: 2, colSpan: 2 }],
  'deleting a row before a merge must shift its anchor toward the origin',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, structuralMerge, 0).merges,
  [{ row: 1, col: 0, rowSpan: 2, colSpan: 2 }],
  'deleting a column before a merge must shift its anchor toward the origin',
)
const rowAxisMerge = [{ row: 1, col: 1, rowSpan: 3, colSpan: 2 }]
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 0).merges,
  [{ row: 0, col: 1, rowSpan: 3, colSpan: 2 }],
  'row deletion before a merge must shift its row anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 1).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'row deletion at a merge anchor must shrink rowSpan and retain the anchor coordinate',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 2).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'row deletion inside a merge must shrink rowSpan without moving its anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, rowAxisMerge, 4).merges,
  rowAxisMerge,
  'row deletion after a merge must leave its geometry unchanged',
)
const columnAxisMerge = [{ row: 1, col: 1, rowSpan: 2, colSpan: 3 }]
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 0).merges,
  [{ row: 1, col: 0, rowSpan: 2, colSpan: 3 }],
  'column deletion before a merge must shift its column anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 1).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'column deletion at a merge anchor must shrink colSpan and retain the anchor coordinate',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 2).merges,
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  'column deletion inside a merge must shrink colSpan without moving its anchor',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, columnAxisMerge, 4).merges,
  columnAxisMerge,
  'column deletion after a merge must leave its geometry unchanged',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, [{ row: 1, col: 1, rowSpan: 1, colSpan: 3 }], 1).merges,
  [],
  'deleting the only row occupied by a horizontal merge must remove that merge',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, [{ row: 1, col: 1, rowSpan: 3, colSpan: 1 }], 1).merges,
  [],
  'deleting the only column occupied by a vertical merge must remove that merge',
)
assert.deepStrictEqual(
  deleteFacsimileTableRow(structuralRows, [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }], 1).merges,
  [],
  'deleting a row that collapses a merge to one cell must remove the redundant merge',
)
assert.deepStrictEqual(
  deleteFacsimileTableColumn(structuralRows, [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }], 1).merges,
  [],
  'deleting a column that collapses a merge to one cell must remove the redundant merge',
)

const rowAnchorDeleted = deleteFacsimileTableRow(
  [
    ['r0c0', 'r0c1', 'r0c2'],
    ['r1c0', 'ANCHOR', 'HIDDEN-1'],
    ['r2c0', 'COVERED', 'HIDDEN-2'],
    ['r3c0', 'AFTER', 'AFTER-HIDDEN'],
  ],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  1,
)
assert.strictEqual(rowAnchorDeleted.rows[1][1], 'ANCHOR', 'row deletion must preserve the merge anchor over stale covered-cell text')
assert.deepStrictEqual(rowAnchorDeleted.merges, [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }])
const rowAnchorCollapsed = deleteFacsimileTableRow(
  [['before', 'before'], ['deleted', 'ANCHOR'], ['survivor', 'COVERED']],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }],
  1,
)
assert.strictEqual(rowAnchorCollapsed.rows[1][1], 'ANCHOR', 'a merge collapsing to one cell after row deletion must preserve its anchor text')
assert.deepStrictEqual(rowAnchorCollapsed.merges, [])
const fullMergeRowDeleted = deleteFacsimileTableRow(
  [['before', 'BEFORE', 'x'], ['deleted', 'ANCHOR', 'hidden'], ['after', 'UNCHANGED', 'y']],
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }],
  1,
)
assert.strictEqual(fullMergeRowDeleted.rows[1][1], 'UNCHANGED', 'a fully deleted merge must not move its anchor text into an unrelated row')
assert.deepStrictEqual(fullMergeRowDeleted.merges, [])

const columnAnchorDeleted = deleteFacsimileTableColumn(
  [
    ['r0c0', 'r0c1', 'r0c2', 'r0c3'],
    ['r1c0', 'ANCHOR', 'COVERED', 'r1c3'],
    ['r2c0', 'HIDDEN-1', 'HIDDEN-2', 'r2c3'],
  ],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 2 }],
  1,
)
assert.strictEqual(columnAnchorDeleted.rows[1][1], 'ANCHOR', 'column deletion must preserve the merge anchor over stale covered-cell text')
assert.deepStrictEqual(columnAnchorDeleted.merges, [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }])
const columnAnchorCollapsed = deleteFacsimileTableColumn(
  [['before', 'before', 'after'], ['row', 'ANCHOR', 'COVERED']],
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }],
  1,
)
assert.strictEqual(columnAnchorCollapsed.rows[1][1], 'ANCHOR', 'a merge collapsing to one cell after column deletion must preserve its anchor text')
assert.deepStrictEqual(columnAnchorCollapsed.merges, [])
const fullMergeColumnDeleted = deleteFacsimileTableColumn(
  [['before', 'deleted', 'after'], ['row', 'ANCHOR', 'UNCHANGED'], ['row2', 'hidden', 'still-here']],
  [{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }],
  1,
)
assert.strictEqual(fullMergeColumnDeleted.rows[1][1], 'UNCHANGED', 'a fully deleted merge must not move its anchor text into an unrelated column')
assert.deepStrictEqual(fullMergeColumnDeleted.merges, [])
assert.deepStrictEqual(
  normalizeFacsimileTableMerges([
    { row: 0, col: 0, rowSpan: 3, colSpan: 3 },
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
    { row: 3, col: 3, rowSpan: 9, colSpan: 9 },
    { row: 99, col: 99, rowSpan: 2, colSpan: 2 },
  ], 4, 4),
  [{ row: 0, col: 0, rowSpan: 3, colSpan: 3 }],
  'merge normalization must remove overlaps, one-cell remnants, and out-of-bounds ranges',
)
assert.deepStrictEqual(
  normalizeFacsimileTableMerges([
    { row: 1, col: 1, rowSpan: 2, colSpan: 2 },
    { row: 0, col: 0, rowSpan: 3, colSpan: 3 },
  ], 4, 4),
  [{ row: 0, col: 0, rowSpan: 3, colSpan: 3 }],
  'overlapping malformed merges must use stable coordinate ordering rather than caller order',
)

assert.deepStrictEqual(
  normalizeFacsimileTableRowHeights([12, 50, 999], 5),
  [FACSIMILE_TABLE_MIN_ROW_HEIGHT, 50, FACSIMILE_TABLE_MAX_ROW_HEIGHT, FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT, FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT],
  'row height metadata must clamp values and fill missing entries with defaults',
)
assert.deepStrictEqual(
  normalizeFacsimileTableColumnWidths([1, 200, 9999], 5),
  [FACSIMILE_TABLE_MIN_COLUMN_WIDTH, 200, FACSIMILE_TABLE_MAX_COLUMN_WIDTH, FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH, FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH],
  'column width metadata must clamp values and fill missing entries with defaults',
)
assert.deepStrictEqual(
  normalizeFacsimileTableRowHeights(['invalid', undefined], 2),
  [FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT, FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT],
  'invalid row heights must fall back to the default instead of throwing',
)
assert.deepStrictEqual(normalizeFacsimileTableColumnWidths([], -3), [], 'invalid metadata lengths must safely normalize to an empty list')

const proofreader = fs.readFileSync(path.join(root, 'src/renderer/src/components/GujiFacsimileProofreader.tsx'), 'utf8')
assert.ok(proofreader.includes('onMouseDown={handlePageLayoutMouseDown}'), 'blank page dragging must create a manual text box')
assert.ok(proofreader.includes('BLOCK_RESIZE_HANDLES.map'), 'the active text box must expose edge and corner resize handles')
assert.ok(proofreader.includes("setImageUnderlayMode('on')"), 'entering manual editing must automatically enable the page image underlay')
assert.ok(proofreader.includes("segmentation_source: 'manual'"), 'manual text, table, and geometry edits must be marked as manual data')
assert.ok(proofreader.includes('<FacsimileTableEditor'), 'recognized tables must use the visual grid editor instead of raw table code')
assert.ok(proofreader.includes("String(block.segmentation_source || '').toLowerCase() !== 'manual'"), 'manual tables must not be converted back into pseudo text tables on vertical pages')

const tableEditorPath = path.join(root, 'src/renderer/src/components/FacsimileTableEditor.tsx')
const tableEditorCssPath = path.join(root, 'src/renderer/src/components/FacsimileTableEditor.css')
const tableEditor = fs.readFileSync(tableEditorPath, 'utf8')
assert.ok(fs.existsSync(tableEditorCssPath), 'the Excel-style table editor must have theme-aware component styles')
const tableEditorCss = fs.readFileSync(tableEditorCssPath, 'utf8')

const transpiledTableEditor = ts.transpileModule(tableEditor, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText
const tableEditorModule = { exports: {} }
const tableEditorRequire = (request) => {
  if (request === 'react') return {}
  if (request === 'react/jsx-runtime') return { Fragment: Symbol('Fragment'), jsx: () => null, jsxs: () => null }
  if (request === 'antd') return { Button: () => null, Tooltip: () => null, message: {}, theme: {} }
  if (request === '../utils/facsimileTableEditing') return helperModule.exports
  if (request === './FacsimileTableEditor.css') return {}
  throw new Error(`Unexpected FacsimileTableEditor dependency: ${request}`)
}
new Function('exports', 'module', 'require', transpiledTableEditor)(
  tableEditorModule.exports,
  tableEditorModule,
  tableEditorRequire,
)
const {
  applyFacsimileTableClipboardCommand,
  applyFacsimileTableSelectionCommand,
  applyFacsimileTableStructureCommand,
  attachFacsimileTableContextMenuEscapeListener,
  attachFacsimileTableResizeListeners,
  buildFacsimileTableCellMergeLookup,
  clampFacsimileTableContextMenuPosition,
  createFacsimileTableCellContextSelection,
  createFacsimileTableHeaderContextSelection,
  createFacsimileTableThemeStyle,
  expandFacsimileTableSelectionForMerges,
  getFacsimileTableEditorKeyIntent,
  getFacsimileTableCommandAvailability,
  reconcileFacsimileTableEditorIdentity,
  reduceFacsimileTableHistory,
  resolveFacsimileTableCellContextSelection,
  serializeFacsimileTableSelectionForClipboard,
  serializeFacsimileTableSelectionAsTsv,
} = tableEditorModule.exports

for (const [name, value] of Object.entries({
  applyFacsimileTableClipboardCommand,
  applyFacsimileTableSelectionCommand,
  applyFacsimileTableStructureCommand,
  attachFacsimileTableContextMenuEscapeListener,
  attachFacsimileTableResizeListeners,
  buildFacsimileTableCellMergeLookup,
  clampFacsimileTableContextMenuPosition,
  createFacsimileTableCellContextSelection,
  createFacsimileTableHeaderContextSelection,
  createFacsimileTableThemeStyle,
  expandFacsimileTableSelectionForMerges,
  getFacsimileTableEditorKeyIntent,
  getFacsimileTableCommandAvailability,
  reconcileFacsimileTableEditorIdentity,
  reduceFacsimileTableHistory,
  resolveFacsimileTableCellContextSelection,
  serializeFacsimileTableSelectionForClipboard,
  serializeFacsimileTableSelectionAsTsv,
})) {
  assert.strictEqual(typeof value, 'function', `${name} must be an executable pure editor helper`)
}

const closureSelection = expandFacsimileTableSelectionForMerges(
  { startRow: 1, endRow: 2, startCol: 2, endCol: 2 },
  [
    { row: 0, col: 2, rowSpan: 2, colSpan: 2 },
    { row: 2, col: 3, rowSpan: 2, colSpan: 2 },
  ],
  5,
  6,
)
assert.deepStrictEqual(
  closureSelection,
  { startRow: 0, endRow: 3, startCol: 2, endCol: 4 },
  'merge-aware selection must recursively expand until every intersecting merged range is fully selected',
)

const mergeClearRows = [
  ['anchor', 'covered-a', 'keep'],
  ['covered-b', 'covered-c', 'keep'],
  ['keep', 'keep', 'keep'],
]
const mergeClear = applyFacsimileTableSelectionCommand(
  mergeClearRows,
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  'clear',
)
assert.deepStrictEqual(
  mergeClear.selection,
  { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
  'clicking one merged anchor must target the complete merged range',
)
assert.deepStrictEqual(mergeClear.rows.slice(0, 2).map((row) => row.slice(0, 2)), [['', ''], ['', '']])
assert.deepStrictEqual(mergeClear.merges, [], 'Delete on a merged cell must clear and remove the complete merge')
assert.deepStrictEqual(mergeClearRows[0], ['anchor', 'covered-a', 'keep'], 'selection commands must not mutate caller-owned rows')
const mergeAcrossExisting = applyFacsimileTableSelectionCommand(
  [['a', '', 'c'], ['', '', 'f']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  { startRow: 1, endRow: 1, startCol: 1, endCol: 2 },
  'merge',
)
assert.deepStrictEqual(
  mergeAcrossExisting.selection,
  { startRow: 0, endRow: 1, startCol: 0, endCol: 2 },
  'a partial drag through a merge must expand the command selection to the full old merge',
)
assert.deepStrictEqual(
  mergeAcrossExisting.merges,
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 3 }],
  'merge command must not rebuild an intersected merge as a smaller rectangle',
)

assert.deepStrictEqual(
  createFacsimileTableHeaderContextSelection('row', 10, 20, 5),
  { startRow: 10, endRow: 10, startCol: 0, endCol: 4 },
  'right-clicking row 10 must replace stale selection with row 10',
)
assert.deepStrictEqual(
  createFacsimileTableHeaderContextSelection('column', 3, 20, 5),
  { startRow: 0, endRow: 19, startCol: 3, endCol: 3 },
  'right-clicking a column header must select the complete current column',
)
assert.deepStrictEqual(
  createFacsimileTableCellContextSelection(
    { row: 1, col: 1 },
    { startRow: 0, endRow: 2, startCol: 0, endCol: 2 },
    [],
    4,
    4,
  ),
  { startRow: 0, endRow: 2, startCol: 0, endCol: 2 },
  'right-clicking inside an existing multi-cell selection must preserve it for context commands',
)
const columnContextResolution = resolveFacsimileTableCellContextSelection(
  { row: 2, col: 1 },
  { startRow: 0, endRow: 3, startCol: 1, endCol: 1 },
  'column',
  [],
  4,
  3,
)
assert.strictEqual(columnContextResolution.mode, 'column', 'right-clicking a cell inside a whole-column selection must retain column mode')
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    columnContextResolution.selection,
    columnContextResolution.mode,
    'delete-row',
  ).changed,
  false,
  'a cell context menu opened inside a column selection must still reject row deletion',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    columnContextResolution.selection,
    columnContextResolution.mode,
    'delete-column',
  ).rows[0].length,
  2,
  'the retained column mode must still allow deletion on its own axis',
)
const rowContextResolution = resolveFacsimileTableCellContextSelection(
  { row: 1, col: 2 },
  { startRow: 1, endRow: 1, startCol: 0, endCol: 2 },
  'row',
  [],
  4,
  3,
)
assert.strictEqual(rowContextResolution.mode, 'row', 'right-clicking a cell inside a whole-row selection must retain row mode')
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    rowContextResolution.selection,
    rowContextResolution.mode,
    'delete-column',
  ).changed,
  false,
  'a cell context menu opened inside a row selection must still reject column deletion',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(
    [['a', 'b', 'c'], ['d', 'e', 'f'], ['g', 'h', 'i'], ['j', 'k', 'l']],
    [],
    rowContextResolution.selection,
    rowContextResolution.mode,
    'delete-row',
  ).rows.length,
  3,
  'the retained row mode must still allow deletion on its own axis',
)
const outsideContextResolution = resolveFacsimileTableCellContextSelection(
  { row: 0, col: 0 },
  { startRow: 0, endRow: 3, startCol: 1, endCol: 1 },
  'column',
  [],
  4,
  3,
)
assert.strictEqual(outsideContextResolution.mode, 'cell', 'right-clicking outside the effective selection must switch to ordinary cell mode')
assert.deepStrictEqual(outsideContextResolution.selection, { startRow: 0, endRow: 0, startCol: 0, endCol: 0 })

const historyA = {
  rows: [['A']],
  merges: [],
  rowHeights: [40],
  columnWidths: [120],
}
const historyB = {
  rows: [['B']],
  merges: [],
  rowHeights: [52],
  columnWidths: [160],
}
const committedHistory = reduceFacsimileTableHistory(
  { past: [], present: historyA, future: [] },
  { type: 'commit', snapshot: historyB },
)
assert.strictEqual(committedHistory.past.length, 1)
assert.deepStrictEqual(committedHistory.present, historyB)
const undoneHistory = reduceFacsimileTableHistory(committedHistory, { type: 'undo' })
assert.deepStrictEqual(undoneHistory.present, historyA, 'undo must restore rows, merges, row heights, and column widths together')
assert.deepStrictEqual(undoneHistory.future, [historyB])
const redoneHistory = reduceFacsimileTableHistory(undoneHistory, { type: 'redo' })
assert.deepStrictEqual(redoneHistory.present, historyB, 'redo must restore the complete table snapshot')

const identityChanged = reconcileFacsimileTableEditorIdentity(
  'page-1:block-A',
  'page-1:block-B',
  JSON.stringify([[['A']], []]),
  JSON.stringify([[['A']], []]),
  committedHistory,
  historyA,
)
assert.strictEqual(identityChanged.kind, 'identity-change')
assert.deepStrictEqual(identityChanged.history.past, [], 'switching to a different block must clear undo history even when table content matches')
assert.deepStrictEqual(identityChanged.history.future, [], 'switching block identity must clear redo history')
const sameIdentityEcho = reconcileFacsimileTableEditorIdentity(
  'page-1:block-A',
  'page-1:block-A',
  JSON.stringify([[['B']], []]),
  JSON.stringify([[['B']], []]),
  committedHistory,
  historyB,
)
assert.strictEqual(sameIdentityEcho.kind, 'emitted-echo')
assert.strictEqual(sameIdentityEcho.history, committedHistory, 'a same-block onChange echo must preserve the existing undo stack')

assert.strictEqual(
  getFacsimileTableEditorKeyIntent({ key: 'Enter', isComposing: true }, false),
  'ignore-composition',
  'a native composing Enter must not commit a Chinese IME candidate as a cell edit',
)
assert.strictEqual(
  getFacsimileTableEditorKeyIntent({ key: 'Enter' }, true),
  'ignore-composition',
  'the composition session ref must protect candidate selection even when the browser key event omits isComposing',
)
assert.strictEqual(
  getFacsimileTableEditorKeyIntent({ key: 'Enter' }, false),
  'commit-next-row',
  'ordinary Enter must commit and move to the next row',
)

const axisRows = Array.from({ length: 12 }, (_, row) => [`${row}:0`, `${row}:1`])
const rowTenSelection = { startRow: 10, endRow: 10, startCol: 0, endCol: 1 }
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], rowTenSelection, 'row', 'delete-column').rows,
  axisRows,
  'row-header mode must reject column deletion in the dispatcher',
)
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], rowTenSelection, 'row', 'insert-column-right').rows,
  axisRows,
  'row-header mode must reject column insertion in the dispatcher',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], rowTenSelection, 'row', 'delete-row').rows.length,
  11,
  'row-header mode must allow deletion on its own axis',
)
const columnSelection = { startRow: 0, endRow: 11, startCol: 1, endCol: 1 }
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], columnSelection, 'column', 'delete-row').rows,
  axisRows,
  'column-header mode must reject row deletion in the dispatcher',
)
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], columnSelection, 'column', 'insert-row-below').rows,
  axisRows,
  'column-header mode must reject row insertion in the dispatcher',
)
assert.strictEqual(
  applyFacsimileTableStructureCommand(axisRows, [], columnSelection, 'column', 'delete-column').rows[0].length,
  1,
  'column-header mode must allow deletion on its own axis',
)

const clipboardCommand = applyFacsimileTableClipboardCommand(
  [['base', ''], ['', '']],
  [],
  { startRow: 1, endRow: 1, startCol: 1, endCol: 1 },
  { html: '<table><tr><td colspan="2">A</td></tr></table>' },
)
assert.strictEqual(clipboardCommand.source, 'html')
assert.strictEqual(clipboardCommand.truncated, false)
assert.deepStrictEqual(
  clipboardCommand.merges,
  [{ row: 1, col: 1, rowSpan: 1, colSpan: 2 }],
  'clipboard commands must preserve and offset HTML merge metadata',
)
const truncatedClipboardCommand = applyFacsimileTableClipboardCommand(
  [['base']],
  [],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  { html: '<table><tr><td rowspan="999999999999999999" colspan="999999999999999999">A</td></tr></table>' },
)
assert.strictEqual(truncatedClipboardCommand.truncated, true, 'clipboard command must propagate parser and paste budget truncation')

const hiddenMergeRows = [
  ['ANCHOR', 'HIDDEN-A'],
  ['HIDDEN-B', 'HIDDEN-C'],
]
const hiddenMerge = [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }]
assert.strictEqual(
  serializeFacsimileTableSelectionAsTsv(
    hiddenMergeRows,
    hiddenMerge,
    { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  ),
  'ANCHOR\t\r\n\t',
  'copying a merged range must serialize covered cells as empty instead of leaking hidden OCR values',
)
const losslessClipboard = serializeFacsimileTableSelectionForClipboard(
  [['甲\n乙\t内', '丙']],
  [],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 1 },
)
assert.strictEqual(losslessClipboard.text, '甲\n乙\t内\t丙', 'plain TSV fallback must remain available for non-HTML targets')
assert.deepStrictEqual(
  parseFacsimileTableClipboardData({ html: losslessClipboard.html, text: losslessClipboard.text }).rows,
  [['甲\n乙\t内', '丙']],
  'structured HTML copy must preserve newlines and literal tabs inside cells on roundtrip',
)
const mergedClipboard = serializeFacsimileTableSelectionForClipboard(
  hiddenMergeRows,
  hiddenMerge,
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
)
assert.ok(mergedClipboard.html.includes('rowspan="2"') && mergedClipboard.html.includes('colspan="2"'))
assert.ok(!mergedClipboard.html.includes('HIDDEN-A') && !mergedClipboard.html.includes('HIDDEN-B'), 'structured copy must skip covered cells and their stale OCR values')
const mergedClipboardRoundtrip = parseFacsimileTableClipboardData(mergedClipboard)
assert.deepStrictEqual(mergedClipboardRoundtrip.rows, [['ANCHOR', ''], ['', '']])
assert.deepStrictEqual(mergedClipboardRoundtrip.merges, hiddenMerge, 'structured copy/paste must retain rowspan and colspan metadata')
const singleValueOverMerge = applyFacsimileTableClipboardCommand(
  hiddenMergeRows,
  hiddenMerge,
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  { text: 'NEW' },
)
assert.deepStrictEqual(singleValueOverMerge.rows, [['NEW', ''], ['', '']], 'a small paste must clear the rest of the effective merge closure')
assert.deepStrictEqual(singleValueOverMerge.merges, [], 'pasting a single value over a merge must remove the old merge')
const newMergeOverOldMerge = applyFacsimileTableClipboardCommand(
  hiddenMergeRows,
  hiddenMerge,
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
  { html: '<table><tr><td colspan="2">NEW-MERGE</td></tr></table>' },
)
assert.deepStrictEqual(newMergeOverOldMerge.rows, [['NEW-MERGE', ''], ['', '']])
assert.deepStrictEqual(
  newMergeOverOldMerge.merges,
  [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }],
  'a pasted HTML merge must replace the old merge without exposing covered values outside the new range',
)
const partialFootprintRows = [
  ['KEEP-00', 'START', 'TARGET', 'CLEAR-03', 'KEEP-04'],
  ['KEEP-10', 'TARGET', 'ANCHOR', 'HIDDEN-A', 'KEEP-14'],
  ['KEEP-20', 'CLEAR-21', 'HIDDEN-B', 'HIDDEN-C', 'KEEP-24'],
  ['KEEP-30', 'KEEP-31', 'KEEP-32', 'KEEP-33', 'KEEP-34'],
]
const partialFootprintPaste = applyFacsimileTableClipboardCommand(
  partialFootprintRows,
  [{ row: 1, col: 2, rowSpan: 2, colSpan: 2 }],
  { startRow: 0, endRow: 0, startCol: 1, endCol: 1 },
  { text: 'N00\tN01\nN10\tN11' },
)
assert.deepStrictEqual(partialFootprintPaste.merges, [], 'a paste footprint touching a merge edge must remove the complete old merge')
assert.deepStrictEqual(
  partialFootprintPaste.rows.slice(0, 3).map((row) => row.slice(1, 4)),
  [['N00', 'N01', ''], ['N10', 'N11', ''], ['', '', '']],
  'the union of selection, actual paste footprint, and merge closure must be cleared before writing new cells',
)
assert.strictEqual(partialFootprintPaste.rows[0][0], 'KEEP-00')
assert.strictEqual(partialFootprintPaste.rows[3][3], 'KEEP-33')

const normalAvailability = getFacsimileTableCommandAvailability(
  [['a', 'b'], ['c', 'd']],
  [],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
)
assert.deepStrictEqual(normalAvailability, {
  insertRow: true,
  insertColumn: true,
  deleteRow: true,
  deleteColumn: true,
  merge: false,
  split: false,
  clear: true,
})
const rowModeAvailability = getFacsimileTableCommandAvailability(
  [['a', 'b'], ['c', 'd']],
  [],
  { startRow: 1, endRow: 1, startCol: 0, endCol: 1 },
  'row',
)
assert.strictEqual(rowModeAvailability.insertColumn, false)
assert.strictEqual(rowModeAvailability.deleteColumn, false, 'row-header context menus must disable the opposite column axis')
const columnModeAvailability = getFacsimileTableCommandAvailability(
  [['a', 'b'], ['c', 'd']],
  [],
  { startRow: 0, endRow: 1, startCol: 1, endCol: 1 },
  'column',
)
assert.strictEqual(columnModeAvailability.insertRow, false)
assert.strictEqual(columnModeAvailability.deleteRow, false, 'column-header context menus must disable the opposite row axis')
const maxColumnsRows = [Array.from({ length: FACSIMILE_TABLE_MAX_COLUMNS }, () => '')]
assert.strictEqual(
  getFacsimileTableCommandAvailability(maxColumnsRows, [], { startRow: 0, endRow: 0, startCol: 0, endCol: 0 }).insertColumn,
  false,
  'column insertion must be disabled at the structural safety limit',
)
assert.deepStrictEqual(
  applyFacsimileTableStructureCommand(
    maxColumnsRows,
    [],
    { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
    'cell',
    'insert-column-right',
  ).rows,
  maxColumnsRows,
  'the dispatcher must enforce table budgets even if a disabled menu command is invoked directly',
)
const mergedAvailability = getFacsimileTableCommandAvailability(
  [['a', ''], ['', '']],
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
)
assert.strictEqual(mergedAvailability.merge, false, 'an already merged range must not offer a redundant merge command')
assert.strictEqual(mergedAvailability.split, true, 'an effective selection containing a merge must offer split')

const mergeLookup = buildFacsimileTableCellMergeLookup(
  [{ row: 0, col: 0, rowSpan: 2, colSpan: 2 }],
  2,
  2,
)
assert.strictEqual(mergeLookup.size, 4, 'the render path must pre-index every cell of a merge once')
assert.deepStrictEqual(mergeLookup.get('1:1'), { row: 0, col: 0, rowSpan: 2, colSpan: 2 })
const denseMerges = Array.from({ length: 100 }, (_, row) => (
  Array.from({ length: 100 }, (_, index) => ({ row, col: index * 2, rowSpan: 1, colSpan: 2 }))
)).flat()
const denseLookupStartedAt = process.hrtime.bigint()
const denseLookup = buildFacsimileTableCellMergeLookup(denseMerges, 100, 200, true)
const denseLookupElapsedMs = Number(process.hrtime.bigint() - denseLookupStartedAt) / 1_000_000
assert.strictEqual(denseLookup.size, 20_000)
assert.ok(denseLookupElapsedMs < 1_000, `indexing 10,000 normalized merges took an unexpected ${denseLookupElapsedMs.toFixed(1)}ms`)

assert.deepStrictEqual(
  clampFacsimileTableContextMenuPosition(999, 999, 800, 600, 216, 328),
  { left: 576, top: 264 },
  'context menu coordinates must stay inside the viewport',
)

{
  const listeners = new Map()
  const removed = []
  let releases = 0
  let finished = 0
  const target = {
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { removed.push([type, listener]) },
    hasPointerCapture() { return true },
    releasePointerCapture() { releases += 1 },
  }
  const cleanup = attachFacsimileTableResizeListeners(target, 7, () => {}, () => { finished += 1 })
  assert.deepStrictEqual(
    [...listeners.keys()].sort(),
    ['lostpointercapture', 'pointercancel', 'pointermove', 'pointerup'],
    'resize must register every normal, cancellation, and lost-capture cleanup path',
  )
  listeners.get('pointercancel')({})
  assert.strictEqual(removed.length, 4, 'finishing resize must remove every registered listener')
  assert.strictEqual(releases, 1)
  assert.strictEqual(finished, 1)
  cleanup()
  assert.strictEqual(removed.length, 4, 'resize cleanup must be idempotent')
  assert.strictEqual(finished, 1)
}

{
  const listeners = new Map()
  const removed = []
  let escapeCloses = 0
  let prevented = 0
  const target = {
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) { removed.push([type, listener]); if (listeners.get(type) === listener) listeners.delete(type) },
  }
  const cleanup = attachFacsimileTableContextMenuEscapeListener(target, () => { escapeCloses += 1 })
  assert.deepStrictEqual([...listeners.keys()], ['keydown'], 'an open context menu must register one Escape listener')
  listeners.get('keydown')({ key: 'Enter', preventDefault() { prevented += 1 } })
  assert.strictEqual(escapeCloses, 0)
  listeners.get('keydown')({ key: 'Escape', preventDefault() { prevented += 1 } })
  assert.strictEqual(escapeCloses, 1, 'Escape must deterministically close the context menu')
  assert.strictEqual(prevented, 1)
  assert.strictEqual(removed.length, 1, 'Escape must clean its listener exactly once')
  cleanup()
  assert.strictEqual(removed.length, 1, 'context menu Escape cleanup must be idempotent for unmount')

  const first = attachFacsimileTableContextMenuEscapeListener(target, () => { escapeCloses += 1 })
  first()
  const second = attachFacsimileTableContextMenuEscapeListener(target, () => { escapeCloses += 1 })
  assert.strictEqual(listeners.size, 1, 'reopening the menu after cleanup must not leak an old keydown listener')
  second()
  assert.strictEqual(listeners.size, 0)
}

const darkThemeStyle = createFacsimileTableThemeStyle({
  colorBgContainer: '#141414',
  colorBgElevated: '#1f1f1f',
  colorBgLayout: '#000000',
  colorText: '#f0f0f0',
  colorTextSecondary: '#bfbfbf',
  colorBorderSecondary: '#303030',
  colorPrimaryBg: '#111a2c',
  colorPrimaryBgHover: '#112545',
  colorPrimary: '#1668dc',
  colorPrimaryBorder: '#15325b',
  boxShadowSecondary: '0 6px 16px #0008',
  colorTextDisabled: '#5c5c5c',
})
assert.strictEqual(darkThemeStyle['--table-bg'], '#141414')
assert.strictEqual(darkThemeStyle['--table-text'], '#f0f0f0')
assert.strictEqual(darkThemeStyle['--table-secondary'], '#bfbfbf')
assert.strictEqual(darkThemeStyle['--table-menu-bg'], '#1f1f1f')
assert.strictEqual(darkThemeStyle['--table-menu-hover'], '#112545')

assert.ok(tableEditor.includes('role="grid"'), 'the table editor must expose a single focusable ARIA grid root')
assert.ok(tableEditor.includes('role="row"') && tableEditor.includes('role="gridcell"'), 'rows and cells must expose ARIA grid semantics')
assert.ok(tableEditor.includes('facsimile-table-row-header'), 'the grid must render clickable row number headers')
assert.ok(tableEditor.includes('facsimile-table-column-header'), 'the grid must render clickable column letter headers')
assert.ok(tableEditor.includes('onPointerDown={handleCellPointerDown}'), 'pointer down must start rectangular cell selection')
assert.ok(tableEditor.includes('onPointerEnter={() => handleCellPointerEnter'), 'pointer drag must extend a rectangular selection')
assert.ok(!tableEditor.includes('<Input.TextArea'), 'ordinary cells must be display elements instead of one textarea per cell')
assert.strictEqual((tableEditor.match(/<textarea\b/g) || []).length, 1, 'the component source must define exactly one reusable active cell editor')
assert.ok(tableEditor.includes('editingCell &&'), 'the active cell editor must only mount while a single cell is being edited')
assert.ok(tableEditor.includes('const rawSelection = getFacsimileTableSelection(anchor, focus)'))
assert.ok(tableEditor.includes('expandFacsimileTableSelectionWithLookup(rawSelection'), 'rendering and commands must share one indexed merge-aware effective selection')
assert.ok(tableEditor.includes('const mergeLookup = useMemo('), 'the render path must memoize its cell-to-merge index')
assert.ok(tableEditor.includes('const commandAvailability = useMemo('), 'command availability must be memoized from the normalized table snapshot')

assert.ok(tableEditor.includes("event.clipboardData.getData('text/html')"), 'paste must read HTML clipboard data')
assert.ok(tableEditor.includes("event.clipboardData.getData('text/plain')"), 'paste must read plain text clipboard data')
assert.ok(tableEditor.includes("event.clipboardData.setData('text/html'"), 'copy must publish structured HTML alongside TSV fallback')
assert.ok(tableEditor.includes('parseFacsimileTableClipboardData'), 'paste must use the detailed Task 2 clipboard parser')
assert.ok(tableEditor.includes('parsed.merges'), 'paste must preserve HTML clipboard merge metadata')
assert.ok(tableEditor.includes('parsed.truncated') && tableEditor.includes('pasted.truncated'), 'clipboard budget truncation must produce a visible UI path')

for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Delete', 'Backspace', 'F2', 'Escape']) {
  assert.ok(tableEditor.includes(`'${key}'`), `the grid keyboard handler must support ${key}`)
}
assert.ok(tableEditor.includes('event.ctrlKey || event.metaKey'), 'the grid must recognize platform undo/redo shortcuts')
assert.ok(tableEditor.includes('undo') && tableEditor.includes('redo'), 'the grid must keep local undo and redo history')
assert.ok(tableEditor.includes('onDoubleClick'), 'double click must enter cell editing')
assert.ok(tableEditor.includes('isPrintableKey'), 'typing a printable key must start overwrite editing')
assert.ok(tableEditor.includes('onCompositionStart') && tableEditor.includes('onCompositionEnd'), 'the active editor must track Chinese IME composition sessions')
assert.ok(proofreader.includes('editorKey='), 'the proofreader must provide a stable block identity to isolate editor state')

assert.ok(tableEditor.includes('onContextMenu={handleContextMenu}'), 'the editor must expose a selection-aware context menu')
assert.ok(tableEditor.includes('onContextMenu={(event) => handleRowHeaderContextMenu'), 'row headers must replace stale selection before opening the context menu')
assert.ok(tableEditor.includes('onContextMenu={(event) => handleColumnHeaderContextMenu'), 'column headers must replace stale selection before opening the context menu')
assert.ok(tableEditor.includes('resolveFacsimileTableCellContextSelection('), 'cell context menus must preserve row or column mode when opened inside that selection')
assert.ok(tableEditor.includes('onScroll={() => closeContextMenu()}'), 'scrolling the grid must close the context menu and clean its Escape listener')
for (const action of ['上方插入行', '下方插入行', '左侧插入列', '右侧插入列', '删除行', '删除列', '合并选区', '拆分单元格', '清空选区']) {
  assert.ok(tableEditor.includes(action), `the table context controls must retain ${action}`)
}
assert.ok(tableEditor.includes('facsimile-table-row-resize-handle'), 'row headers must expose resize handles')
assert.ok(tableEditor.includes('facsimile-table-column-resize-handle'), 'column headers must expose resize handles')
assert.ok(tableEditor.includes('setPointerCapture'), 'resize and drag interactions must reliably capture pointer movement')
assert.ok(tableEditor.includes('resizeCleanupRef'), 'resize cleanup must survive event-handler rerenders and component unmount')
assert.ok(tableEditor.includes('contextMenuEscapeCleanupRef'), 'context menu Escape cleanup must survive rerenders and unmount')
assert.ok(tableEditor.includes("gridRef.current?.focus({ preventScroll: true })"), 'opening the context menu must keep keyboard focus on a deterministic Escape target')

assert.ok(tableEditor.includes('theme.useToken()'), 'the component must read the active Ant Design theme token set')
assert.ok(tableEditor.includes('createFacsimileTableThemeStyle(token)'), 'real Ant tokens must be connected to the grid CSS variables')
assert.ok(tableEditor.includes('style={tableThemeStyle}'), 'the grid root must receive its local theme variables inline')
assert.ok(!tableEditorCss.includes('--gs-') && !tableEditorCss.includes('--ant-'), 'component styles must not depend on undefined global theme variables')
assert.ok(tableEditorCss.includes('var(--table-bg,'), 'component theme variables must provide an explicit light fallback')
assert.ok(tableEditorCss.includes('overflow: auto'), 'narrow table editors must scroll instead of clipping columns')
assert.ok(!/background(?:-color)?\s*:\s*#fff(?:fff)?\b/i.test(tableEditorCss), 'table cells must not force a hard-coded white background')
assert.ok(!/background(?:-color)?\s*:\s*['"]?#fff(?:fff)?\b/i.test(tableEditor), 'the component must not force a hard-coded white background')

const toolbarStart = tableEditor.indexOf('className="facsimile-table-toolbar"')
const toolbarEnd = tableEditor.indexOf('className="facsimile-table-help"')
const toolbarSource = tableEditor.slice(toolbarStart, toolbarEnd)
assert.ok(toolbarSource.includes('撤销') && toolbarSource.includes('重做'), 'the compact toolbar must expose undo and redo controls')
for (const action of ['上方插入行', '下方插入行', '左侧插入列', '右侧插入列', '删除行', '删除列', '合并选区', '拆分单元格', '清空选区']) {
  assert.ok(!toolbarSource.includes(action), `the compact toolbar must leave ${action} in the context menu`)
}

console.log('Facsimile layout editor regression passed.')

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

console.log('Facsimile layout editor regression passed.')

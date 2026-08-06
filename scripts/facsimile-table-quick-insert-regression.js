const assert = require('assert')
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const editorPath = path.join(root, 'src', 'renderer', 'src', 'components', 'FacsimileTableEditor.tsx')
const cssPath = path.join(root, 'src', 'renderer', 'src', 'components', 'FacsimileTableEditor.css')
const helperPath = path.join(root, 'src', 'renderer', 'src', 'utils', 'facsimileTableEditing.ts')
const editorSource = fs.readFileSync(editorPath, 'utf8')
const cssSource = fs.readFileSync(cssPath, 'utf8')
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
  insertFacsimileTableColumn,
  insertFacsimileTableRow,
} = helperModule.exports

assert.match(editorSource, /facsimile-table-quick-insert-column/, 'column quick insert control must be rendered')
assert.match(editorSource, /facsimile-table-quick-insert-row/, 'row quick insert control must be rendered')
assert.match(editorSource, /insertQuickColumnAfter\(col\)/, 'column quick insert must target the hovered column')
assert.match(editorSource, /insertQuickRowAfter\(rowIndex\)/, 'row quick insert must target the hovered row')
assert.match(editorSource, /'insert-column-right'/, 'column quick insert must insert after the hovered column')
assert.match(editorSource, /'insert-row-below'/, 'row quick insert must insert after the hovered row')
assert.match(cssSource, /opacity:\s*0[;\n]/, 'quick insert controls must stay hidden until hover')
assert.match(cssSource, /pointer-events:\s*none/, 'hidden quick insert controls must not block table editing')
assert.match(cssSource, /\.facsimile-table-column-heading:hover[\s\S]*opacity:\s*1/, 'column control must appear on column-header hover')
assert.match(cssSource, /\.facsimile-table-row-heading:hover[\s\S]*opacity:\s*1/, 'row control must appear on row-header hover')
assert.match(cssSource, /\.facsimile-table-column-heading:hover\s*\{[\s\S]*z-index:\s*10/, 'hovered column heading must rise above adjacent headings')
assert.match(cssSource, /\.facsimile-table-row-heading:hover\s*\{[\s\S]*z-index:\s*10/, 'hovered row heading must rise above adjacent headings')
assert.match(editorSource, /is-edge/, 'edge quick insert controls must avoid clipping at the last row or column')

const rows = [['A', 'B'], ['C', 'D']]
const merges = [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }]
const insertedRow = insertFacsimileTableRow(rows, merges, 1)
assert.deepStrictEqual(insertedRow.rows, [['A', 'B'], ['', ''], ['C', 'D']])
assert.deepStrictEqual(insertedRow.merges, [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }])

const insertedColumn = insertFacsimileTableColumn(rows, merges, 1)
assert.deepStrictEqual(insertedColumn.rows, [['A', '', 'B'], ['C', '', 'D']])
assert.deepStrictEqual(insertedColumn.merges, [{ row: 0, col: 0, rowSpan: 1, colSpan: 3 }])

console.log('Facsimile table quick insert regression checks passed.')

export type FacsimileTableMerge = {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

export type FacsimileTablePoint = { row: number; col: number }
export type FacsimileTableSelection = {
  startRow: number
  endRow: number
  startCol: number
  endCol: number
}

export type FacsimileTableClipboardInput = string | {
  text?: unknown
  html?: unknown
}

export type FacsimileTableEditResult = {
  rows: string[][]
  merges: FacsimileTableMerge[]
}

export type FacsimileTableClipboardSource = 'none' | 'text' | 'html'
export type FacsimileTableClipboardData = FacsimileTableEditResult & {
  truncated: boolean
  source: FacsimileTableClipboardSource
}
export type FacsimileTablePasteResult = FacsimileTableEditResult & {
  truncated: boolean
}

export const FACSIMILE_TABLE_MAX_ROWS = 2_000
export const FACSIMILE_TABLE_MAX_COLUMNS = 256
export const FACSIMILE_TABLE_MAX_CELLS = 20_000
export const FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT = 40
export const FACSIMILE_TABLE_MIN_ROW_HEIGHT = 24
export const FACSIMILE_TABLE_MAX_ROW_HEIGHT = 240
export const FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH = 120
export const FACSIMILE_TABLE_MIN_COLUMN_WIDTH = 48
export const FACSIMILE_TABLE_MAX_COLUMN_WIDTH = 640

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteIndex(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

function finiteCount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function cellText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (!isRecord(value)) return ''
  for (const key of ['text', 'words', 'content', 'value']) {
    const candidate = value[key]
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate)
  }
  return ''
}

export function normalizeFacsimileTableRows(rows: unknown, minRows = 1, minCols = 1): string[][] {
  const source = Array.isArray(rows) ? rows : []
  const normalized = source.map((row) => Array.isArray(row) ? row.map(cellText) : [])
  const rowCount = Math.max(finiteCount(minRows), normalized.length)
  let colCount = finiteCount(minCols)
  for (const row of normalized) colCount = Math.max(colCount, row.length)
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: colCount }, (_, colIndex) => normalized[rowIndex]?.[colIndex] ?? '')
  ))
}

function decodeFacsimileTableHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    copy: '\u00a9',
    emsp: '\u2003',
    ensp: '\u2002',
    hellip: '\u2026',
    mdash: '\u2014',
    ndash: '\u2013',
    gt: '>',
    lt: '<',
    middot: '\u00b7',
    nbsp: ' ',
    quot: '"',
    reg: '\u00ae',
    trade: '\u2122',
  }
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, token: string) => {
    if (token[0] !== '#') return namedEntities[token.toLowerCase()] ?? entity
    const hexadecimal = token[1]?.toLowerCase() === 'x'
    const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return entity
    }
  })
}

type FacsimileTableHtmlTag = {
  name: string
  closing: boolean
  rowSpan: number
  colSpan: number
  spanClamped: boolean
}

type FacsimileTableHtmlTagScan = {
  tag: FacsimileTableHtmlTag | null
  nextIndex: number
}

type FacsimileTableHtmlParseResult = FacsimileTableEditResult & {
  truncated: boolean
  valid: boolean
}

function parseFacsimileTableHtmlSpan(value: string, maximum: number): { value: number; clamped: boolean } {
  const source = value.trim()
  if (!source) return { value: 1, clamped: false }
  let parsed = 0
  let exceeded = false
  for (let index = 0; index < source.length; index += 1) {
    const digit = source.charCodeAt(index) - 48
    if (digit < 0 || digit > 9) return { value: 1, clamped: false }
    if (exceeded || parsed > Math.floor((maximum - digit) / 10)) exceeded = true
    else parsed = parsed * 10 + digit
  }
  if (exceeded) return { value: maximum, clamped: true }
  if (parsed < 1) return { value: 1, clamped: false }
  return { value: parsed, clamped: false }
}

function scanFacsimileTableHtmlTag(html: string, tagStart: number): FacsimileTableHtmlTagScan | null {
  if (html.startsWith('<!--', tagStart)) {
    const commentEnd = html.indexOf('-->', tagStart + 4)
    return commentEnd < 0 ? null : { tag: null, nextIndex: commentEnd + 3 }
  }
  let quote: '"' | "'" | null = null
  let tagEnd = -1
  for (let index = tagStart + 1; index < html.length; index += 1) {
    const character = html[index]
    if (quote) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      tagEnd = index
      break
    }
  }
  if (tagEnd < 0) return null

  const source = html.slice(tagStart + 1, tagEnd).trim()
  const closing = source.startsWith('/')
  const body = closing ? source.slice(1).trimStart() : source
  const nameMatch = /^[a-z][a-z0-9:-]*/i.exec(body)
  if (!nameMatch) return { tag: null, nextIndex: tagEnd + 1 }

  let rowSpan = 1
  let colSpan = 1
  let spanClamped = false
  const attributeSource = body.endsWith('/') ? body.slice(0, -1) : body
  let cursor = nameMatch[0].length
  while (!closing && cursor < attributeSource.length) {
    while (cursor < attributeSource.length && /\s/.test(attributeSource[cursor])) cursor += 1
    if (cursor >= attributeSource.length) break
    const nameStart = cursor
    while (cursor < attributeSource.length && !/[\s=]/.test(attributeSource[cursor])) cursor += 1
    if (cursor === nameStart) {
      cursor += 1
      continue
    }
    const attributeName = attributeSource.slice(nameStart, cursor).toLowerCase()
    while (cursor < attributeSource.length && /\s/.test(attributeSource[cursor])) cursor += 1
    let attributeValue = ''
    if (attributeSource[cursor] === '=') {
      cursor += 1
      while (cursor < attributeSource.length && /\s/.test(attributeSource[cursor])) cursor += 1
      const attributeQuote = attributeSource[cursor]
      if (attributeQuote === '"' || attributeQuote === "'") {
        cursor += 1
        const valueStart = cursor
        while (cursor < attributeSource.length && attributeSource[cursor] !== attributeQuote) cursor += 1
        attributeValue = attributeSource.slice(valueStart, cursor)
        if (cursor < attributeSource.length) cursor += 1
      } else {
        const valueStart = cursor
        while (cursor < attributeSource.length && !/\s/.test(attributeSource[cursor])) cursor += 1
        attributeValue = attributeSource.slice(valueStart, cursor)
      }
    }
    if (attributeName === 'rowspan') {
      const parsed = parseFacsimileTableHtmlSpan(attributeValue, FACSIMILE_TABLE_MAX_ROWS)
      rowSpan = parsed.value
      spanClamped ||= parsed.clamped
    } else if (attributeName === 'colspan') {
      const parsed = parseFacsimileTableHtmlSpan(attributeValue, FACSIMILE_TABLE_MAX_COLUMNS)
      colSpan = parsed.value
      spanClamped ||= parsed.clamped
    }
  }
  return {
    tag: { name: nameMatch[0].toLowerCase(), closing, rowSpan, colSpan, spanClamped },
    nextIndex: tagEnd + 1,
  }
}

function facsimileTableHtmlCellText(value: string): string {
  return decodeFacsimileTableHtmlEntities(value)
}

function parseFacsimileTableHtml(html: string): FacsimileTableHtmlParseResult {
  const parsedRows: string[][] = []
  const parsedMerges: FacsimileTableMerge[] = []
  const occupiedUntilRow: number[] = []
  let tableDepth = 0
  let foundTable = false
  let closedTable = false
  let stoppedByBudget = false
  let truncated = false
  let currentRow: string[] | null = null
  let currentRowIndex = -1
  let nextColumn = 0
  let maximumColumnCount = 0
  let currentCell: { parts: string[]; rowSpan: number; colSpan: number } | null = null

  const finishCell = (): boolean => {
    if (!currentRow || !currentCell) return true
    while (nextColumn < FACSIMILE_TABLE_MAX_COLUMNS && occupiedUntilRow[nextColumn] > currentRowIndex) {
      currentRow[nextColumn] = ''
      nextColumn += 1
    }
    const maximumWidthForRowCount = Math.floor(FACSIMILE_TABLE_MAX_CELLS / (currentRowIndex + 1))
    const availableColumns = Math.min(FACSIMILE_TABLE_MAX_COLUMNS, maximumWidthForRowCount) - nextColumn
    if (availableColumns < 1) {
      currentCell = null
      truncated = true
      return false
    }
    const colSpan = Math.min(currentCell.colSpan, availableColumns)
    const rowSpan = Math.min(currentCell.rowSpan, FACSIMILE_TABLE_MAX_ROWS - currentRowIndex)
    if (colSpan < currentCell.colSpan || rowSpan < currentCell.rowSpan) truncated = true
    currentRow[nextColumn] = facsimileTableHtmlCellText(currentCell.parts.join(''))
    for (let offset = 1; offset < colSpan; offset += 1) currentRow[nextColumn + offset] = ''
    if (rowSpan > 1) {
      for (let offset = 0; offset < colSpan; offset += 1) {
        occupiedUntilRow[nextColumn + offset] = Math.max(
          occupiedUntilRow[nextColumn + offset] || 0,
          currentRowIndex + rowSpan,
        )
      }
    }
    if (rowSpan > 1 || colSpan > 1) {
      parsedMerges.push({ row: currentRowIndex, col: nextColumn, rowSpan, colSpan })
    }
    nextColumn += colSpan
    maximumColumnCount = Math.max(maximumColumnCount, nextColumn)
    currentCell = null
    return true
  }
  const finishRow = (): boolean => {
    if (!currentRow) return true
    const cellFinished = finishCell()
    for (let col = 0; col < Math.min(occupiedUntilRow.length, FACSIMILE_TABLE_MAX_COLUMNS); col += 1) {
      if (occupiedUntilRow[col] > currentRowIndex) currentRow[col] ??= ''
    }
    if (currentRow.length > 0) parsedRows.push(currentRow)
    currentRow = null
    currentRowIndex = -1
    return cellFinished
  }

  let cursor = 0
  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor)
    if (tagStart < 0) {
      if (tableDepth > 0 && currentCell) currentCell.parts.push(html.slice(cursor))
      cursor = html.length
      break
    }
    if (tagStart > cursor && tableDepth > 0 && currentCell) currentCell.parts.push(html.slice(cursor, tagStart))
    const scanned = scanFacsimileTableHtmlTag(html, tagStart)
    if (!scanned) return { rows: [], merges: [], truncated: false, valid: false }
    cursor = scanned.nextIndex
    const tag = scanned.tag
    if (!tag) continue
    if (tag.name === 'table') {
      if (tag.closing) {
        if (tableDepth === 1) {
          finishRow()
          tableDepth = 0
          closedTable = true
          break
        }
        if (tableDepth > 1) tableDepth -= 1
      } else if (tableDepth > 0) {
        tableDepth += 1
      } else if (!foundTable) {
        foundTable = true
        tableDepth = 1
      }
      continue
    }
    if (tableDepth < 1) continue
    if (tableDepth === 1 && tag.name === 'tr') {
      if (tag.closing) {
        if (!finishRow()) {
          stoppedByBudget = true
          break
        }
      }
      else {
        if (!finishRow()) {
          stoppedByBudget = true
          break
        }
        const rowIndex = parsedRows.length
        const requiredWidth = Math.max(1, maximumColumnCount)
        if (rowIndex >= FACSIMILE_TABLE_MAX_ROWS || (rowIndex + 1) * requiredWidth > FACSIMILE_TABLE_MAX_CELLS) {
          truncated = true
          stoppedByBudget = true
          break
        }
        currentRow = []
        currentRowIndex = rowIndex
        nextColumn = 0
      }
      continue
    }
    if (tableDepth === 1 && (tag.name === 'td' || tag.name === 'th')) {
      if (tag.closing) {
        if (!finishCell()) {
          stoppedByBudget = true
          break
        }
      }
      else if (currentRow) {
        if (!finishCell()) {
          stoppedByBudget = true
          break
        }
        currentCell = { parts: [], rowSpan: tag.rowSpan, colSpan: tag.colSpan }
        if (tag.spanClamped) truncated = true
      }
      continue
    }
    if (!tag.closing && tag.name === 'br' && currentCell) currentCell.parts.push('\n')
  }
  if (stoppedByBudget) finishRow()
  const valid = foundTable && (closedTable || stoppedByBudget) && parsedRows.length > 0
  if (!valid) return { rows: [], merges: [], truncated: false, valid: false }
  const rows = normalizeFacsimileTableRows(parsedRows, parsedRows.length, 0)
  return {
    rows,
    merges: normalizeFacsimileTableMerges(parsedMerges, rows.length, rows[0]?.length || 0),
    truncated,
    valid: true,
  }
}

function parseFacsimileTableText(text: string): FacsimileTableClipboardData {
  if (text.length === 0) return { rows: [], merges: [], truncated: false, source: 'none' }
  const parsedRows: string[][] = []
  let currentRow: string[] = []
  let cellStart = 0
  let maximumColumnCount = 0
  let truncated = false
  let cursor = 0
  while (cursor <= text.length) {
    const character = text[cursor]
    const atEnd = cursor === text.length
    const atCellEnd = atEnd || character === '\t' || character === '\r' || character === '\n'
    if (!atCellEnd) {
      cursor += 1
      continue
    }
    const candidateColumnCount = Math.max(maximumColumnCount, currentRow.length + 1)
    const candidateRowCount = parsedRows.length + 1
    if (
      candidateRowCount > FACSIMILE_TABLE_MAX_ROWS
      || candidateColumnCount > FACSIMILE_TABLE_MAX_COLUMNS
      || candidateRowCount * candidateColumnCount > FACSIMILE_TABLE_MAX_CELLS
    ) {
      truncated = true
      if (currentRow.length > 0) parsedRows.push(currentRow)
      break
    }
    currentRow.push(text.slice(cellStart, cursor))
    maximumColumnCount = candidateColumnCount
    if (atEnd) {
      parsedRows.push(currentRow)
      break
    }
    if (character === '\t') {
      cursor += 1
      cellStart = cursor
      continue
    }
    if (character === '\r' && text[cursor + 1] === '\n') cursor += 1
    parsedRows.push(currentRow)
    currentRow = []
    cursor += 1
    cellStart = cursor
  }
  const rows = normalizeFacsimileTableRows(parsedRows, parsedRows.length, 0)
  return { rows, merges: [], truncated, source: rows.length > 0 ? 'text' : 'none' }
}

export function parseFacsimileTableClipboardData(input: FacsimileTableClipboardInput): FacsimileTableClipboardData {
  if (typeof input === 'string') return parseFacsimileTableText(input)
  if (!isRecord(input)) return { rows: [], merges: [], truncated: false, source: 'none' }
  const html = typeof input.html === 'string' ? input.html : ''
  const parsedHtml = html ? parseFacsimileTableHtml(html) : null
  if (parsedHtml?.valid) {
    return { rows: parsedHtml.rows, merges: parsedHtml.merges, truncated: parsedHtml.truncated, source: 'html' }
  }
  return typeof input.text === 'string'
    ? parseFacsimileTableText(input.text)
    : { rows: [], merges: [], truncated: false, source: 'none' }
}

export function parseFacsimileTableClipboard(input: FacsimileTableClipboardInput): string[][] {
  return parseFacsimileTableClipboardData(input).rows
}

export function getFacsimileTableSelection(anchor: FacsimileTablePoint, focus: FacsimileTablePoint): FacsimileTableSelection {
  return {
    startRow: Math.min(anchor.row, focus.row),
    endRow: Math.max(anchor.row, focus.row),
    startCol: Math.min(anchor.col, focus.col),
    endCol: Math.max(anchor.col, focus.col),
  }
}

function clampFacsimileTablePoint(
  point: FacsimileTablePoint,
  rowCount: number,
  colCount: number,
): FacsimileTablePoint {
  return {
    row: clamp(finiteIndex(point?.row), 0, Math.max(0, finiteCount(rowCount) - 1)),
    col: clamp(finiteIndex(point?.col), 0, Math.max(0, finiteCount(colCount) - 1)),
  }
}

export function normalizeFacsimileTableSelection(
  anchor: FacsimileTablePoint,
  focus: FacsimileTablePoint,
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  return getFacsimileTableSelection(
    clampFacsimileTablePoint(anchor, rowCount, colCount),
    clampFacsimileTablePoint(focus, rowCount, colCount),
  )
}

export function getFacsimileTableWholeRowSelection(
  anchorRow: number,
  focusRow: number,
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  return normalizeFacsimileTableSelection(
    { row: anchorRow, col: 0 },
    { row: focusRow, col: Math.max(0, finiteCount(colCount) - 1) },
    rowCount,
    colCount,
  )
}

export function getFacsimileTableWholeColumnSelection(
  anchorCol: number,
  focusCol: number,
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  return normalizeFacsimileTableSelection(
    { row: 0, col: anchorCol },
    { row: Math.max(0, finiteCount(rowCount) - 1), col: focusCol },
    rowCount,
    colCount,
  )
}

function normalizeFacsimileTableSelectionRange(
  selection: FacsimileTableSelection,
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  return normalizeFacsimileTableSelection(
    { row: selection?.startRow, col: selection?.startCol },
    { row: selection?.endRow, col: selection?.endCol },
    rowCount,
    colCount,
  )
}

function mergeContains(merge: FacsimileTableMerge, row: number, col: number): boolean {
  return row >= merge.row && row < merge.row + merge.rowSpan && col >= merge.col && col < merge.col + merge.colSpan
}

function mergesOverlap(left: FacsimileTableMerge, right: FacsimileTableMerge): boolean {
  return left.row < right.row + right.rowSpan
    && left.row + left.rowSpan > right.row
    && left.col < right.col + right.colSpan
    && left.col + left.colSpan > right.col
}

function selectionAsFacsimileTableMerge(selection: FacsimileTableSelection): FacsimileTableMerge {
  return {
    row: selection.startRow,
    col: selection.startCol,
    rowSpan: selection.endRow - selection.startRow + 1,
    colSpan: selection.endCol - selection.startCol + 1,
  }
}

export function normalizeFacsimileTableMerges(
  merges: FacsimileTableMerge[],
  rowCount: number,
  colCount: number,
): FacsimileTableMerge[] {
  const safeRowCount = finiteCount(rowCount)
  const safeColCount = finiteCount(colCount)
  if (safeRowCount === 0 || safeColCount === 0) return []
  const accepted: FacsimileTableMerge[] = []
  const source = Array.isArray(merges) ? merges : []
  const candidates = source.flatMap((raw) => {
    const row = finiteIndex(raw?.row)
    const col = finiteIndex(raw?.col)
    if (row >= safeRowCount || col >= safeColCount) return []
    const rowSpan = Math.max(1, Math.min(safeRowCount - row, finiteIndex(raw?.rowSpan) || 1))
    const colSpan = Math.max(1, Math.min(safeColCount - col, finiteIndex(raw?.colSpan) || 1))
    return rowSpan === 1 && colSpan === 1 ? [] : [{ row, col, rowSpan, colSpan }]
  }).sort((left, right) => (
    left.row - right.row
    || left.col - right.col
    || left.rowSpan - right.rowSpan
    || left.colSpan - right.colSpan
  ))
  for (const merge of candidates) {
    if (!accepted.some((existing) => mergesOverlap(existing, merge))) accepted.push(merge)
  }
  return accepted
}

export function getFacsimileTableMergesFromCells(cells: unknown, rowCount: number, colCount: number): FacsimileTableMerge[] {
  if (!Array.isArray(cells)) return []
  return normalizeFacsimileTableMerges(cells.flatMap((cell) => {
    if (!isRecord(cell)) return []
    const rowSpan = finiteIndex(cell.rowSpan ?? cell.row_span ?? cell.rowspan) || 1
    const colSpan = finiteIndex(cell.colSpan ?? cell.col_span ?? cell.colspan) || 1
    if (rowSpan === 1 && colSpan === 1) return []
    return [{
      row: finiteIndex(cell.row ?? cell.row_index ?? cell.rowIndex),
      col: finiteIndex(cell.col ?? cell.col_index ?? cell.colIndex),
      rowSpan,
      colSpan,
    }]
  }), rowCount, colCount)
}

export function findFacsimileTableMerge(
  merges: FacsimileTableMerge[],
  row: number,
  col: number,
): FacsimileTableMerge | null {
  return merges.find((merge) => mergeContains(merge, row, col)) || null
}

export function isFacsimileTableCoveredCell(merges: FacsimileTableMerge[], row: number, col: number): boolean {
  const merge = findFacsimileTableMerge(merges, row, col)
  return !!merge && (merge.row !== row || merge.col !== col)
}

export function mergeFacsimileTableSelection(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
): FacsimileTableEditResult {
  const nextRows = normalizeFacsimileTableRows(rows)
  const safeSelection = normalizeFacsimileTableSelectionRange(
    selection,
    nextRows.length,
    nextRows[0]?.length || 1,
  )
  const nextMerge = selectionAsFacsimileTableMerge(safeSelection)
  const normalizedMerges = normalizeFacsimileTableMerges(merges, nextRows.length, nextRows[0]?.length || 1)
  if (nextMerge.rowSpan === 1 && nextMerge.colSpan === 1) return { rows: nextRows, merges: normalizedMerges }
  const texts: string[] = []
  for (let row = safeSelection.startRow; row <= safeSelection.endRow; row += 1) {
    for (let col = safeSelection.startCol; col <= safeSelection.endCol; col += 1) {
      const value = String(nextRows[row]?.[col] || '').trim()
      if (value) texts.push(value)
      if (nextRows[row]) nextRows[row][col] = ''
    }
  }
  nextRows[safeSelection.startRow][safeSelection.startCol] = texts.join('\n')
  const kept = normalizedMerges.filter((merge) => !mergesOverlap(merge, nextMerge))
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges([...kept, nextMerge], nextRows.length, nextRows[0]?.length || 1),
  }
}

export function splitFacsimileTableCell(
  rows: string[][],
  merges: FacsimileTableMerge[],
  point: FacsimileTablePoint,
): FacsimileTableEditResult {
  const target = findFacsimileTableMerge(merges, point.row, point.col)
  if (!target) return { rows, merges }
  return { rows, merges: merges.filter((merge) => merge !== target) }
}

export function clearFacsimileTableSelection(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
): FacsimileTableEditResult {
  const nextRows = normalizeFacsimileTableRows(rows)
  const safeSelection = normalizeFacsimileTableSelectionRange(
    selection,
    nextRows.length,
    nextRows[0]?.length || 1,
  )
  for (let row = safeSelection.startRow; row <= safeSelection.endRow; row += 1) {
    for (let col = safeSelection.startCol; col <= safeSelection.endCol; col += 1) {
      nextRows[row][col] = ''
    }
  }
  const clearedRange = selectionAsFacsimileTableMerge(safeSelection)
  const normalizedMerges = normalizeFacsimileTableMerges(merges, nextRows.length, nextRows[0]?.length || 1)
  return {
    rows: nextRows,
    merges: normalizedMerges.filter((merge) => !mergesOverlap(merge, clearedRange)),
  }
}

function normalizeFacsimileTablePasteRows(rows: unknown): { rows: string[][]; truncated: boolean } {
  if (!Array.isArray(rows) || rows.length === 0) return { rows: [], truncated: false }
  const normalized: string[][] = []
  let maximumColumnCount = 0
  let truncated = false
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (rowIndex >= FACSIMILE_TABLE_MAX_ROWS) {
      truncated = true
      break
    }
    const sourceRow = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : []
    const sourceColumnCount = Math.max(1, sourceRow.length)
    let targetColumnCount = Math.min(sourceColumnCount, FACSIMILE_TABLE_MAX_COLUMNS)
    if (sourceColumnCount > FACSIMILE_TABLE_MAX_COLUMNS) truncated = true
    const maximumWidthForRowCount = Math.floor(FACSIMILE_TABLE_MAX_CELLS / (normalized.length + 1))
    if (Math.max(maximumColumnCount, targetColumnCount) > maximumWidthForRowCount) {
      if (maximumColumnCount > maximumWidthForRowCount) {
        truncated = true
        break
      }
      targetColumnCount = maximumWidthForRowCount
      truncated = true
    }
    maximumColumnCount = Math.max(maximumColumnCount, targetColumnCount)
    normalized.push(Array.from(
      { length: targetColumnCount },
      (_, colIndex) => cellText(sourceRow[colIndex]),
    ))
  }
  if (normalized.length < rows.length) truncated = true
  return {
    rows: normalizeFacsimileTableRows(normalized, normalized.length, 1),
    truncated,
  }
}

function facsimileTableDimensionsWithinBudget(rows: string[][]): boolean {
  if (rows.length > FACSIMILE_TABLE_MAX_ROWS) return false
  let columnCount = 0
  for (const row of rows) {
    columnCount = Math.max(columnCount, Array.isArray(row) ? row.length : 0)
    if (columnCount > FACSIMILE_TABLE_MAX_COLUMNS) return false
  }
  return rows.length * columnCount <= FACSIMILE_TABLE_MAX_CELLS
}

export function pasteFacsimileTableRange(
  rows: string[][],
  merges: FacsimileTableMerge[],
  start: FacsimileTablePoint,
  values: unknown,
  valueMerges: FacsimileTableMerge[] = [],
): FacsimileTablePasteResult {
  if (!facsimileTableDimensionsWithinBudget(rows)) {
    let sourceColumnCount = 0
    for (const row of rows) sourceColumnCount = Math.max(sourceColumnCount, Array.isArray(row) ? row.length : 0)
    return {
      rows,
      merges: normalizeFacsimileTableMerges(merges, rows.length, sourceColumnCount),
      truncated: true,
    }
  }
  const baseRows = normalizeFacsimileTableRows(rows)
  const startRow = finiteIndex(start?.row)
  const startCol = finiteIndex(start?.col)
  if (startRow >= FACSIMILE_TABLE_MAX_ROWS || startCol >= FACSIMILE_TABLE_MAX_COLUMNS) {
    return {
      rows: baseRows,
      merges: normalizeFacsimileTableMerges(merges, baseRows.length, baseRows[0]?.length || 1),
      truncated: true,
    }
  }
  const normalizedPaste = normalizeFacsimileTablePasteRows(values)
  const pasteRows = normalizedPaste.rows
  if (pasteRows.length === 0) {
    return {
      rows: baseRows,
      merges: normalizeFacsimileTableMerges(merges, baseRows.length, baseRows[0]?.length || 1),
      truncated: normalizedPaste.truncated,
    }
  }
  let pasteRowCount = Math.min(pasteRows.length, FACSIMILE_TABLE_MAX_ROWS - startRow)
  let pasteColCount = Math.min(pasteRows[0]?.length || 1, FACSIMILE_TABLE_MAX_COLUMNS - startCol)
  const baseRowCount = baseRows.length
  const baseColCount = baseRows[0]?.length || 1
  const minimumFinalRowCount = Math.max(baseRowCount, startRow + 1)
  const maximumFinalColumnCount = Math.floor(FACSIMILE_TABLE_MAX_CELLS / minimumFinalRowCount)
  pasteColCount = Math.min(pasteColCount, Math.max(0, maximumFinalColumnCount - startCol))
  const finalColCount = Math.max(baseColCount, startCol + pasteColCount)
  const maximumFinalRowCount = Math.floor(FACSIMILE_TABLE_MAX_CELLS / finalColCount)
  pasteRowCount = Math.min(pasteRowCount, Math.max(0, maximumFinalRowCount - startRow))
  const truncated = normalizedPaste.truncated
    || pasteRowCount < pasteRows.length
    || pasteColCount < (pasteRows[0]?.length || 1)
  if (pasteRowCount < 1 || pasteColCount < 1) {
    return {
      rows: baseRows,
      merges: normalizeFacsimileTableMerges(merges, baseRowCount, baseColCount),
      truncated: true,
    }
  }
  const rowCount = Math.max(baseRowCount, startRow + pasteRowCount)
  const colCount = Math.max(baseColCount, startCol + pasteColCount)
  const nextRows = normalizeFacsimileTableRows(baseRows, rowCount, colCount)
  for (let rowOffset = 0; rowOffset < pasteRowCount; rowOffset += 1) {
    for (let colOffset = 0; colOffset < pasteColCount; colOffset += 1) {
      nextRows[startRow + rowOffset][startCol + colOffset] = pasteRows[rowOffset][colOffset]
    }
  }
  const pastedRange: FacsimileTableMerge = {
    row: startRow,
    col: startCol,
    rowSpan: pasteRowCount,
    colSpan: pasteColCount,
  }
  const normalizedMerges = normalizeFacsimileTableMerges(merges, rowCount, colCount)
  const pastedMerges = normalizeFacsimileTableMerges(valueMerges, pasteRowCount, pasteColCount).map((merge) => ({
    ...merge,
    row: merge.row + startRow,
    col: merge.col + startCol,
  }))
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges(
      [...normalizedMerges.filter((merge) => !mergesOverlap(merge, pastedRange)), ...pastedMerges],
      rowCount,
      colCount,
    ),
    truncated,
  }
}

function adjustMergesForInsertedAxis(
  merges: FacsimileTableMerge[],
  index: number,
  axis: 'row' | 'col',
): FacsimileTableMerge[] {
  return merges.map((merge) => {
    const start = merge[axis]
    const spanKey = axis === 'row' ? 'rowSpan' : 'colSpan'
    if (start >= index) return { ...merge, [axis]: start + 1 }
    if (start + merge[spanKey] > index) return { ...merge, [spanKey]: merge[spanKey] + 1 }
    return merge
  })
}

function adjustMergesForDeletedAxis(
  merges: FacsimileTableMerge[],
  index: number,
  axis: 'row' | 'col',
): FacsimileTableMerge[] {
  const spanKey = axis === 'row' ? 'rowSpan' : 'colSpan'
  return merges.flatMap((merge) => {
    const start = merge[axis]
    const span = merge[spanKey]
    if (index < start) return [{ ...merge, [axis]: start - 1 }]
    if (index >= start + span) return [merge]
    if (span <= 1) return []
    const nextSpan = span - 1
    if (nextSpan === 1 && (axis === 'row' ? merge.colSpan : merge.rowSpan) === 1) return []
    return [{ ...merge, [spanKey]: nextSpan }]
  })
}

export function insertFacsimileTableRow(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): FacsimileTableEditResult {
  const normalized = normalizeFacsimileTableRows(rows)
  const insertion = clamp(finiteIndex(index), 0, normalized.length)
  const nextRows = [...normalized]
  nextRows.splice(insertion, 0, Array(normalized[0].length).fill(''))
  const normalizedMerges = normalizeFacsimileTableMerges(merges, normalized.length, normalized[0].length)
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges(
      adjustMergesForInsertedAxis(normalizedMerges, insertion, 'row'),
      nextRows.length,
      nextRows[0].length,
    ),
  }
}

export function insertFacsimileTableColumn(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): FacsimileTableEditResult {
  const normalized = normalizeFacsimileTableRows(rows)
  const insertion = clamp(finiteIndex(index), 0, normalized[0].length)
  const nextRows = normalized.map((row) => {
    const next = [...row]
    next.splice(insertion, 0, '')
    return next
  })
  const normalizedMerges = normalizeFacsimileTableMerges(merges, normalized.length, normalized[0].length)
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges(
      adjustMergesForInsertedAxis(normalizedMerges, insertion, 'col'),
      nextRows.length,
      nextRows[0].length,
    ),
  }
}

export function deleteFacsimileTableRow(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): FacsimileTableEditResult {
  const normalized = normalizeFacsimileTableRows(rows)
  const normalizedMerges = normalizeFacsimileTableMerges(merges, normalized.length, normalized[0].length)
  if (normalized.length <= 1) return { rows: normalized, merges: normalizedMerges }
  const deletion = clamp(finiteIndex(index), 0, normalized.length - 1)
  const nextRows = normalized.filter((_, rowIndex) => rowIndex !== deletion)
  for (const merge of normalizedMerges) {
    if (merge.row !== deletion || merge.rowSpan <= 1) continue
    const targetRow = Math.min(deletion, nextRows.length - 1)
    if (!nextRows[targetRow]) continue
    const preserved = normalized[deletion]?.[merge.col] ?? ''
    nextRows[targetRow][merge.col] = preserved
  }
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges(adjustMergesForDeletedAxis(normalizedMerges, deletion, 'row'), nextRows.length, nextRows[0].length),
  }
}

export function deleteFacsimileTableColumn(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): FacsimileTableEditResult {
  const normalized = normalizeFacsimileTableRows(rows)
  const normalizedMerges = normalizeFacsimileTableMerges(merges, normalized.length, normalized[0].length)
  if (normalized[0].length <= 1) return { rows: normalized, merges: normalizedMerges }
  const deletion = clamp(finiteIndex(index), 0, normalized[0].length - 1)
  const nextRows = normalized.map((row) => row.filter((_, colIndex) => colIndex !== deletion))
  for (const merge of normalizedMerges) {
    if (merge.col !== deletion || merge.colSpan <= 1) continue
    const targetCol = Math.min(deletion, nextRows[merge.row].length - 1)
    const preserved = normalized[merge.row]?.[deletion] ?? ''
    nextRows[merge.row][targetCol] = preserved
  }
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges(adjustMergesForDeletedAxis(normalizedMerges, deletion, 'col'), nextRows.length, nextRows[0].length),
  }
}

function normalizeFacsimileTableSizes(
  values: unknown,
  count: number,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number[] {
  const source = Array.isArray(values) ? values : []
  return Array.from({ length: finiteCount(count) }, (_, index) => {
    const value = source[index]
    if (typeof value !== 'number' || !Number.isFinite(value)) return defaultValue
    return clamp(value, minimum, maximum)
  })
}

export function normalizeFacsimileTableRowHeights(values: unknown, rowCount: number): number[] {
  return normalizeFacsimileTableSizes(
    values,
    rowCount,
    FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT,
    FACSIMILE_TABLE_MIN_ROW_HEIGHT,
    FACSIMILE_TABLE_MAX_ROW_HEIGHT,
  )
}

export function normalizeFacsimileTableColumnWidths(values: unknown, colCount: number): number[] {
  return normalizeFacsimileTableSizes(
    values,
    colCount,
    FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH,
    FACSIMILE_TABLE_MIN_COLUMN_WIDTH,
    FACSIMILE_TABLE_MAX_COLUMN_WIDTH,
  )
}

export function buildFacsimileTableCells(rows: string[][], merges: FacsimileTableMerge[]): JsonRecord[] {
  const normalized = normalizeFacsimileTableRows(rows)
  const normalizedMerges = normalizeFacsimileTableMerges(merges, normalized.length, normalized[0].length)
  const cells: JsonRecord[] = []
  for (let row = 0; row < normalized.length; row += 1) {
    for (let col = 0; col < normalized[row].length; col += 1) {
      if (isFacsimileTableCoveredCell(normalizedMerges, row, col)) continue
      const merge = findFacsimileTableMerge(normalizedMerges, row, col)
      cells.push({
        row,
        col,
        text: normalized[row][col],
        ...(merge ? { rowSpan: merge.rowSpan, colSpan: merge.colSpan, row_span: merge.rowSpan, col_span: merge.colSpan } : {}),
      })
    }
  }
  return cells
}

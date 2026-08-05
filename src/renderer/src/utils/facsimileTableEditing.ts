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

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteIndex(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0
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
  const rowCount = Math.max(minRows, normalized.length)
  const colCount = Math.max(minCols, ...normalized.map((row) => row.length), 0)
  return Array.from({ length: rowCount }, (_, rowIndex) => (
    Array.from({ length: colCount }, (_, colIndex) => normalized[rowIndex]?.[colIndex] || '')
  ))
}

export function getFacsimileTableSelection(anchor: FacsimileTablePoint, focus: FacsimileTablePoint): FacsimileTableSelection {
  return {
    startRow: Math.min(anchor.row, focus.row),
    endRow: Math.max(anchor.row, focus.row),
    startCol: Math.min(anchor.col, focus.col),
    endCol: Math.max(anchor.col, focus.col),
  }
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

export function normalizeFacsimileTableMerges(
  merges: FacsimileTableMerge[],
  rowCount: number,
  colCount: number,
): FacsimileTableMerge[] {
  const accepted: FacsimileTableMerge[] = []
  for (const raw of merges || []) {
    const row = finiteIndex(raw?.row)
    const col = finiteIndex(raw?.col)
    const rowSpan = Math.max(1, Math.min(rowCount - row, finiteIndex(raw?.rowSpan) || 1))
    const colSpan = Math.max(1, Math.min(colCount - col, finiteIndex(raw?.colSpan) || 1))
    if (row >= rowCount || col >= colCount || (rowSpan === 1 && colSpan === 1)) continue
    const merge = { row, col, rowSpan, colSpan }
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
): { rows: string[][]; merges: FacsimileTableMerge[] } {
  const nextRows = normalizeFacsimileTableRows(rows)
  const nextMerge: FacsimileTableMerge = {
    row: selection.startRow,
    col: selection.startCol,
    rowSpan: selection.endRow - selection.startRow + 1,
    colSpan: selection.endCol - selection.startCol + 1,
  }
  if (nextMerge.rowSpan === 1 && nextMerge.colSpan === 1) return { rows: nextRows, merges }
  const texts: string[] = []
  for (let row = selection.startRow; row <= selection.endRow; row += 1) {
    for (let col = selection.startCol; col <= selection.endCol; col += 1) {
      const value = String(nextRows[row]?.[col] || '').trim()
      if (value) texts.push(value)
      if (nextRows[row]) nextRows[row][col] = ''
    }
  }
  nextRows[selection.startRow][selection.startCol] = texts.join('\n')
  const kept = merges.filter((merge) => !mergesOverlap(merge, nextMerge))
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges([...kept, nextMerge], nextRows.length, nextRows[0]?.length || 1),
  }
}

export function splitFacsimileTableCell(
  rows: string[][],
  merges: FacsimileTableMerge[],
  point: FacsimileTablePoint,
): { rows: string[][]; merges: FacsimileTableMerge[] } {
  const target = findFacsimileTableMerge(merges, point.row, point.col)
  if (!target) return { rows, merges }
  return { rows, merges: merges.filter((merge) => merge !== target) }
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
    const nextSpan = span - 1
    if (nextSpan <= 1 && (axis === 'row' ? merge.colSpan : merge.rowSpan) <= 1) return []
    return [{ ...merge, [spanKey]: Math.max(1, nextSpan) }]
  })
}

export function insertFacsimileTableRow(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): { rows: string[][]; merges: FacsimileTableMerge[] } {
  const normalized = normalizeFacsimileTableRows(rows)
  const insertion = Math.max(0, Math.min(normalized.length, index))
  const nextRows = [...normalized]
  nextRows.splice(insertion, 0, Array(normalized[0].length).fill(''))
  return { rows: nextRows, merges: adjustMergesForInsertedAxis(merges, insertion, 'row') }
}

export function insertFacsimileTableColumn(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): { rows: string[][]; merges: FacsimileTableMerge[] } {
  const normalized = normalizeFacsimileTableRows(rows)
  const insertion = Math.max(0, Math.min(normalized[0].length, index))
  const nextRows = normalized.map((row) => {
    const next = [...row]
    next.splice(insertion, 0, '')
    return next
  })
  return { rows: nextRows, merges: adjustMergesForInsertedAxis(merges, insertion, 'col') }
}

export function deleteFacsimileTableRow(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): { rows: string[][]; merges: FacsimileTableMerge[] } {
  const normalized = normalizeFacsimileTableRows(rows)
  if (normalized.length <= 1) return { rows: normalized, merges }
  const deletion = Math.max(0, Math.min(normalized.length - 1, index))
  const nextRows = normalized.filter((_, rowIndex) => rowIndex !== deletion)
  for (const merge of merges) {
    if (merge.row !== deletion || merge.rowSpan <= 1) continue
    const targetRow = Math.min(deletion, nextRows.length - 1)
    if (!nextRows[targetRow]) continue
    const preserved = normalized[deletion]?.[merge.col] || ''
    if (preserved && !nextRows[targetRow][merge.col]) nextRows[targetRow][merge.col] = preserved
  }
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges(adjustMergesForDeletedAxis(merges, deletion, 'row'), nextRows.length, nextRows[0].length),
  }
}

export function deleteFacsimileTableColumn(
  rows: string[][],
  merges: FacsimileTableMerge[],
  index: number,
): { rows: string[][]; merges: FacsimileTableMerge[] } {
  const normalized = normalizeFacsimileTableRows(rows)
  if (normalized[0].length <= 1) return { rows: normalized, merges }
  const deletion = Math.max(0, Math.min(normalized[0].length - 1, index))
  const nextRows = normalized.map((row) => row.filter((_, colIndex) => colIndex !== deletion))
  for (const merge of merges) {
    if (merge.col !== deletion || merge.colSpan <= 1) continue
    const targetCol = Math.min(deletion, nextRows[merge.row].length - 1)
    const preserved = normalized[merge.row]?.[deletion] || ''
    if (preserved && !nextRows[merge.row][targetCol]) nextRows[merge.row][targetCol] = preserved
  }
  return {
    rows: nextRows,
    merges: normalizeFacsimileTableMerges(adjustMergesForDeletedAxis(merges, deletion, 'col'), nextRows.length, nextRows[0].length),
  }
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

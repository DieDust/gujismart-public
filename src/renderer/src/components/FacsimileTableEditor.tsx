import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Button, Tooltip, message, theme } from 'antd'
import {
  buildFacsimileTableCells,
  clearFacsimileTableSelection,
  deleteFacsimileTableColumn,
  deleteFacsimileTableRow,
  FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH,
  FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT,
  FACSIMILE_TABLE_MAX_CELLS,
  FACSIMILE_TABLE_MAX_COLUMNS,
  FACSIMILE_TABLE_MAX_ROWS,
  findFacsimileTableMerge,
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
  parseFacsimileTableClipboardData,
  pasteFacsimileTableRange,
  type FacsimileTableClipboardInput,
  type FacsimileTableClipboardSource,
  type FacsimileTableMerge,
  type FacsimileTablePoint,
  type FacsimileTableSelection,
} from '../utils/facsimileTableEditing'
import './FacsimileTableEditor.css'

export type FacsimileTableEditorValue = {
  rows: string[][]
  merges: FacsimileTableMerge[]
  cells: Record<string, unknown>[]
  rowHeights: number[]
  columnWidths: number[]
}

type Props = {
  editorKey: string
  rows: string[][]
  merges: FacsimileTableMerge[]
  rowHeights?: number[]
  columnWidths?: number[]
  disabled?: boolean
  onChange: (value: FacsimileTableEditorValue) => void
}

export type TableSnapshot = {
  rows: string[][]
  merges: FacsimileTableMerge[]
  rowHeights: number[]
  columnWidths: number[]
}

export type SelectionMode = 'cell' | 'row' | 'column'
export type FacsimileTableInteractionKind =
  | 'pointer'
  | 'keyboard'
  | 'paste'
  | 'copy'
  | 'cut'
  | 'mutation'
  | 'context-menu'
  | 'toolbar'
  | 'resize'
  | 'textarea'

export function canHandleFacsimileTableInteraction(
  disabled: boolean,
  _kind: FacsimileTableInteractionKind,
): boolean {
  return !disabled
}

type TableAction =
  | 'insert-row-above'
  | 'insert-row-below'
  | 'insert-column-left'
  | 'insert-column-right'
  | 'delete-row'
  | 'delete-column'
  | 'merge'
  | 'split'
  | 'clear'

type ContextMenuState = { left: number; top: number }

export type FacsimileTableHistory = {
  past: TableSnapshot[]
  present: TableSnapshot
  future: TableSnapshot[]
}

export type FacsimileTableHistoryAction =
  | { type: 'commit'; snapshot: TableSnapshot }
  | { type: 'undo' }
  | { type: 'redo' }

export type FacsimileTableCommandAvailability = {
  insertRow: boolean
  insertColumn: boolean
  deleteRow: boolean
  deleteColumn: boolean
  merge: boolean
  split: boolean
  clear: boolean
}

export type FacsimileTableStructureAction = Extract<
  TableAction,
  'insert-row-above' | 'insert-row-below' | 'insert-column-left' | 'insert-column-right' | 'delete-row' | 'delete-column'
>

export type FacsimileTableStructureMutation = {
  kind: 'insert' | 'delete'
  indexes: number[]
}

export type FacsimileTableStructureResult = {
  rows: string[][]
  merges: FacsimileTableMerge[]
  selection: FacsimileTableSelection
  changed: boolean
  rowMutation?: FacsimileTableStructureMutation
  columnMutation?: FacsimileTableStructureMutation
}

export type FacsimileTableEditorKeyIntent =
  | 'ignore-composition'
  | 'cancel'
  | 'commit-next-column'
  | 'commit-previous-column'
  | 'commit-next-row'
  | 'commit-previous-row'
  | 'none'

export type FacsimileTableIdentityReconciliation = {
  kind: 'identity-change' | 'emitted-echo' | 'external-change'
  history: FacsimileTableHistory
}

export type FacsimileTableThemeToken = {
  colorBgContainer: string
  colorBgElevated: string
  colorBgLayout: string
  colorText: string
  colorTextSecondary: string
  colorBorderSecondary: string
  colorPrimaryBg: string
  colorPrimaryBgHover: string
  colorPrimary: string
  colorPrimaryBorder: string
  boxShadowSecondary: string
  colorTextDisabled: string
}

export type FacsimileTableThemeStyle = CSSProperties & {
  '--table-bg': string
  '--table-menu-bg': string
  '--table-text': string
  '--table-secondary': string
  '--table-grid': string
  '--table-selection': string
  '--table-active': string
  '--table-header': string
  '--table-menu-hover': string
  '--table-focus': string
  '--table-shadow': string
  '--table-disabled': string
}

type FacsimileTableResizeEventName = 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture'
type FacsimileTableResizeListener = (event: unknown) => void

export type FacsimileTableResizeTarget = {
  addEventListener: (type: FacsimileTableResizeEventName, listener: FacsimileTableResizeListener) => void
  removeEventListener: (type: FacsimileTableResizeEventName, listener: FacsimileTableResizeListener) => void
  hasPointerCapture: (pointerId: number) => boolean
  releasePointerCapture: (pointerId: number) => void
}

export type FacsimileTableResizeOutcome = 'commit' | 'cancel'

export type FacsimileTableResizeResolution = {
  snapshot: TableSnapshot
  shouldCommit: boolean
}

export type FacsimileTableKeyboardTarget = {
  addEventListener: (type: 'keydown', listener: (event: unknown) => void) => void
  removeEventListener: (type: 'keydown', listener: (event: unknown) => void) => void
}

const HISTORY_LIMIT = 100
const LARGE_CLIPBOARD_BYTES = 2_000_000

function cloneSnapshot(snapshot: TableSnapshot): TableSnapshot {
  return {
    rows: snapshot.rows.map((row) => [...row]),
    merges: snapshot.merges.map((merge) => ({ ...merge })),
    rowHeights: [...snapshot.rowHeights],
    columnWidths: [...snapshot.columnWidths],
  }
}

export function createFacsimileTableSnapshot(
  rows: unknown,
  merges: FacsimileTableMerge[],
  rowHeights: unknown = [],
  columnWidths: unknown = [],
): TableSnapshot {
  const safeRows = normalizeFacsimileTableRows(rows)
  return {
    rows: safeRows,
    merges: normalizeFacsimileTableMerges(merges, safeRows.length, safeRows[0]?.length || 1),
    rowHeights: normalizeFacsimileTableRowHeights(rowHeights, safeRows.length),
    columnWidths: normalizeFacsimileTableColumnWidths(columnWidths, safeRows[0]?.length || 1),
  }
}

function normalizeSnapshot(snapshot: TableSnapshot): TableSnapshot {
  const rows = normalizeFacsimileTableRows(snapshot.rows)
  return {
    rows,
    merges: normalizeFacsimileTableMerges(snapshot.merges, rows.length, rows[0]?.length || 1),
    rowHeights: normalizeFacsimileTableRowHeights(snapshot.rowHeights, rows.length),
    columnWidths: normalizeFacsimileTableColumnWidths(snapshot.columnWidths, rows[0]?.length || 1),
  }
}

function snapshotSignature(snapshot: TableSnapshot): string {
  return JSON.stringify([snapshot.rows, snapshot.merges, snapshot.rowHeights, snapshot.columnWidths])
}

export function resolveFacsimileTableResize(
  before: TableSnapshot,
  after: TableSnapshot,
  outcome: FacsimileTableResizeOutcome,
  disabled: boolean,
): FacsimileTableResizeResolution {
  const baseline = normalizeSnapshot(before)
  if (outcome !== 'commit' || disabled) {
    return { snapshot: baseline, shouldCommit: false }
  }
  const next = normalizeSnapshot(after)
  return {
    snapshot: next,
    shouldCommit: snapshotSignature(baseline) !== snapshotSignature(next),
  }
}

function selectionsIntersect(left: FacsimileTableSelection, right: FacsimileTableSelection): boolean {
  return left.startRow <= right.endRow
    && left.endRow >= right.startRow
    && left.startCol <= right.endCol
    && left.endCol >= right.startCol
}

function mergeSelection(merge: FacsimileTableMerge): FacsimileTableSelection {
  return {
    startRow: merge.row,
    endRow: merge.row + merge.rowSpan - 1,
    startCol: merge.col,
    endCol: merge.col + merge.colSpan - 1,
  }
}

function mergeLookupKey(row: number, col: number): string {
  return `${row}:${col}`
}

export function buildFacsimileTableCellMergeLookup(
  merges: FacsimileTableMerge[],
  rowCount: number,
  colCount: number,
  assumeNormalized = false,
): Map<string, FacsimileTableMerge> {
  const safeRowCount = Math.max(1, Math.floor(rowCount) || 1)
  const safeColCount = Math.max(1, Math.floor(colCount) || 1)
  const safeMerges = assumeNormalized
    ? merges
    : normalizeFacsimileTableMerges(merges, safeRowCount, safeColCount)
  const lookup = new Map<string, FacsimileTableMerge>()
  for (const merge of safeMerges) {
    const endRow = Math.min(safeRowCount, merge.row + merge.rowSpan)
    const endCol = Math.min(safeColCount, merge.col + merge.colSpan)
    for (let row = Math.max(0, merge.row); row < endRow; row += 1) {
      for (let col = Math.max(0, merge.col); col < endCol; col += 1) {
        lookup.set(mergeLookupKey(row, col), merge)
      }
    }
  }
  return lookup
}

function expandFacsimileTableSelectionWithLookup(
  selection: FacsimileTableSelection,
  mergeLookup: Map<string, FacsimileTableMerge>,
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  let effective = normalizeFacsimileTableSelection(
    { row: selection.startRow, col: selection.startCol },
    { row: selection.endRow, col: selection.endCol },
    rowCount,
    colCount,
  )
  const queue: FacsimileTablePoint[] = []
  const visited = new Set<string>()
  const enqueueCell = (row: number, col: number) => {
    const key = mergeLookupKey(row, col)
    if (visited.has(key)) return
    visited.add(key)
    queue.push({ row, col })
  }
  const enqueueRange = (range: FacsimileTableSelection, previous?: FacsimileTableSelection) => {
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let col = range.startCol; col <= range.endCol; col += 1) {
        if (
          previous
          && row >= previous.startRow
          && row <= previous.endRow
          && col >= previous.startCol
          && col <= previous.endCol
        ) continue
        enqueueCell(row, col)
      }
    }
  }
  enqueueRange(effective)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const point = queue[cursor]
    const merge = mergeLookup.get(mergeLookupKey(point.row, point.col))
    if (!merge) continue
    const range = mergeSelection(merge)
    const next = {
      startRow: Math.min(effective.startRow, range.startRow),
      endRow: Math.max(effective.endRow, range.endRow),
      startCol: Math.min(effective.startCol, range.startCol),
      endCol: Math.max(effective.endCol, range.endCol),
    }
    if (
      next.startRow === effective.startRow
      && next.endRow === effective.endRow
      && next.startCol === effective.startCol
      && next.endCol === effective.endCol
    ) continue
    const previous = effective
    effective = next
    enqueueRange(effective, previous)
  }
  return effective
}

export function expandFacsimileTableSelectionForMerges(
  selection: FacsimileTableSelection,
  merges: FacsimileTableMerge[],
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  const safeMerges = normalizeFacsimileTableMerges(merges, rowCount, colCount)
  return expandFacsimileTableSelectionWithLookup(
    selection,
    buildFacsimileTableCellMergeLookup(safeMerges, rowCount, colCount, true),
    rowCount,
    colCount,
  )
}

export function createFacsimileTableHeaderContextSelection(
  axis: 'row' | 'column',
  index: number,
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  return axis === 'row'
    ? getFacsimileTableWholeRowSelection(index, index, rowCount, colCount)
    : getFacsimileTableWholeColumnSelection(index, index, rowCount, colCount)
}

export function createFacsimileTableCellContextSelection(
  point: FacsimileTablePoint,
  currentSelection: FacsimileTableSelection,
  merges: FacsimileTableMerge[],
  rowCount: number,
  colCount: number,
): FacsimileTableSelection {
  return resolveFacsimileTableCellContextSelection(
    point,
    currentSelection,
    'cell',
    merges,
    rowCount,
    colCount,
  ).selection
}

export function resolveFacsimileTableCellContextSelection(
  point: FacsimileTablePoint,
  currentSelection: FacsimileTableSelection,
  currentMode: SelectionMode,
  merges: FacsimileTableMerge[],
  rowCount: number,
  colCount: number,
): { selection: FacsimileTableSelection; mode: SelectionMode } {
  const effectiveCurrent = expandFacsimileTableSelectionForMerges(currentSelection, merges, rowCount, colCount)
  const safePoint = clampPoint(point, rowCount, colCount)
  if (
    safePoint.row >= effectiveCurrent.startRow
    && safePoint.row <= effectiveCurrent.endRow
    && safePoint.col >= effectiveCurrent.startCol
    && safePoint.col <= effectiveCurrent.endCol
  ) return { selection: effectiveCurrent, mode: currentMode }
  return {
    selection: expandFacsimileTableSelectionForMerges(
      getFacsimileTableSelection(safePoint, safePoint),
      merges,
      rowCount,
      colCount,
    ),
    mode: 'cell',
  }
}

export function applyFacsimileTableSelectionCommand(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
  command: 'clear' | 'merge' | 'split',
): { rows: string[][]; merges: FacsimileTableMerge[]; selection: FacsimileTableSelection } {
  const safeRows = normalizeFacsimileTableRows(rows)
  const safeMerges = normalizeFacsimileTableMerges(merges, safeRows.length, safeRows[0]?.length || 1)
  const effective = expandFacsimileTableSelectionForMerges(
    selection,
    safeMerges,
    safeRows.length,
    safeRows[0]?.length || 1,
  )
  if (command === 'clear') {
    return { ...clearFacsimileTableSelection(safeRows, safeMerges, effective), selection: effective }
  }
  if (command === 'merge') {
    return { ...mergeFacsimileTableSelection(safeRows, safeMerges, effective), selection: effective }
  }
  return {
    rows: safeRows,
    merges: safeMerges.filter((merge) => !selectionsIntersect(effective, mergeSelection(merge))),
    selection: effective,
  }
}

function getFacsimileTableCommandAvailabilityForNormalizedSnapshot(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
  selectionMode: SelectionMode,
): FacsimileTableCommandAvailability {
  const rowCount = rows.length
  const colCount = rows[0]?.length || 1
  const rowAxisAllowed = selectionMode !== 'column'
  const columnAxisAllowed = selectionMode !== 'row'
  const intersectingMerges = merges.filter((merge) => selectionsIntersect(selection, mergeSelection(merge)))
  const exactMerge = intersectingMerges.length === 1
    && mergeSelection(intersectingMerges[0]).startRow === selection.startRow
    && mergeSelection(intersectingMerges[0]).endRow === selection.endRow
    && mergeSelection(intersectingMerges[0]).startCol === selection.startCol
    && mergeSelection(intersectingMerges[0]).endCol === selection.endCol
  return {
    insertRow: rowAxisAllowed
      && rowCount < FACSIMILE_TABLE_MAX_ROWS
      && (rowCount + 1) * colCount <= FACSIMILE_TABLE_MAX_CELLS,
    insertColumn: columnAxisAllowed
      && colCount < FACSIMILE_TABLE_MAX_COLUMNS
      && rowCount * (colCount + 1) <= FACSIMILE_TABLE_MAX_CELLS,
    deleteRow: rowAxisAllowed && rowCount > 1,
    deleteColumn: columnAxisAllowed && colCount > 1,
    merge: (selection.startRow !== selection.endRow || selection.startCol !== selection.endCol) && !exactMerge,
    split: intersectingMerges.length > 0,
    clear: true,
  }
}

export function getFacsimileTableCommandAvailability(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
  selectionMode: SelectionMode = 'cell',
): FacsimileTableCommandAvailability {
  const safeRows = normalizeFacsimileTableRows(rows)
  const safeMerges = normalizeFacsimileTableMerges(merges, safeRows.length, safeRows[0]?.length || 1)
  const effective = expandFacsimileTableSelectionForMerges(
    selection,
    safeMerges,
    safeRows.length,
    safeRows[0]?.length || 1,
  )
  return getFacsimileTableCommandAvailabilityForNormalizedSnapshot(
    safeRows,
    safeMerges,
    effective,
    selectionMode,
  )
}

export function applyFacsimileTableStructureCommand(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
  selectionMode: SelectionMode,
  action: FacsimileTableStructureAction,
): FacsimileTableStructureResult {
  const safeRows = normalizeFacsimileTableRows(rows)
  const safeMerges = normalizeFacsimileTableMerges(merges, safeRows.length, safeRows[0]?.length || 1)
  const rowCount = safeRows.length
  const colCount = safeRows[0]?.length || 1
  const effective = expandFacsimileTableSelectionForMerges(selection, safeMerges, rowCount, colCount)
  const availability = getFacsimileTableCommandAvailabilityForNormalizedSnapshot(
    safeRows,
    safeMerges,
    effective,
    selectionMode,
  )
  const unchanged = (): FacsimileTableStructureResult => ({
    rows: safeRows,
    merges: safeMerges,
    selection: effective,
    changed: false,
  })
  const isRowAction = action === 'insert-row-above' || action === 'insert-row-below' || action === 'delete-row'
  if ((selectionMode === 'row' && !isRowAction) || (selectionMode === 'column' && isRowAction)) return unchanged()

  if (action === 'insert-row-above' || action === 'insert-row-below') {
    if (!availability.insertRow) return unchanged()
    const index = action === 'insert-row-above' ? effective.startRow : effective.endRow + 1
    const result = insertFacsimileTableRow(safeRows, safeMerges, index)
    return {
      ...result,
      selection: getFacsimileTableSelection(
        { row: index, col: effective.startCol },
        { row: index, col: effective.startCol },
      ),
      changed: true,
      rowMutation: { kind: 'insert', indexes: [index] },
    }
  }
  if (action === 'insert-column-left' || action === 'insert-column-right') {
    if (!availability.insertColumn) return unchanged()
    const index = action === 'insert-column-left' ? effective.startCol : effective.endCol + 1
    const result = insertFacsimileTableColumn(safeRows, safeMerges, index)
    return {
      ...result,
      selection: getFacsimileTableSelection(
        { row: effective.startRow, col: index },
        { row: effective.startRow, col: index },
      ),
      changed: true,
      columnMutation: { kind: 'insert', indexes: [index] },
    }
  }
  if (action === 'delete-row') {
    if (!availability.deleteRow) return unchanged()
    let result = { rows: safeRows, merges: safeMerges }
    const deleted: number[] = []
    for (const index of selectedIndexes(effective.startRow, effective.endRow).reverse()) {
      const beforeLength = result.rows.length
      result = deleteFacsimileTableRow(result.rows, result.merges, index)
      if (result.rows.length < beforeLength) deleted.push(index)
    }
    if (deleted.length === 0) return unchanged()
    const target = clampPoint({ row: effective.startRow, col: effective.startCol }, result.rows.length, result.rows[0]?.length || 1)
    return {
      ...result,
      selection: getFacsimileTableSelection(target, target),
      changed: true,
      rowMutation: { kind: 'delete', indexes: deleted },
    }
  }
  if (!availability.deleteColumn) return unchanged()
  let result = { rows: safeRows, merges: safeMerges }
  const deleted: number[] = []
  for (const index of selectedIndexes(effective.startCol, effective.endCol).reverse()) {
    const beforeLength = result.rows[0]?.length || 1
    result = deleteFacsimileTableColumn(result.rows, result.merges, index)
    if ((result.rows[0]?.length || 1) < beforeLength) deleted.push(index)
  }
  if (deleted.length === 0) return unchanged()
  const target = clampPoint({ row: effective.startRow, col: effective.startCol }, result.rows.length, result.rows[0]?.length || 1)
  return {
    ...result,
    selection: getFacsimileTableSelection(target, target),
    changed: true,
    columnMutation: { kind: 'delete', indexes: deleted },
  }
}

export function applyFacsimileTableClipboardCommand(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
  input: FacsimileTableClipboardInput,
): {
  rows: string[][]
  merges: FacsimileTableMerge[]
  selection: FacsimileTableSelection
  truncated: boolean
  source: FacsimileTableClipboardSource
} {
  const safeRows = normalizeFacsimileTableRows(rows)
  const safeMerges = normalizeFacsimileTableMerges(merges, safeRows.length, safeRows[0]?.length || 1)
  const effective = expandFacsimileTableSelectionForMerges(
    selection,
    safeMerges,
    safeRows.length,
    safeRows[0]?.length || 1,
  )
  const parsed = parseFacsimileTableClipboardData(input)
  if (parsed.source === 'none' || parsed.rows.length === 0) {
    return { rows: safeRows, merges: safeMerges, selection: effective, truncated: parsed.truncated, source: parsed.source }
  }
  const pasteStart = { row: effective.startRow, col: effective.startCol }
  const probe = pasteFacsimileTableRange(safeRows, safeMerges, pasteStart, parsed.rows, parsed.merges)
  const baseColumnCount = safeRows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const baseWithinBudget = safeRows.length <= FACSIMILE_TABLE_MAX_ROWS
    && baseColumnCount <= FACSIMILE_TABLE_MAX_COLUMNS
    && safeRows.length * baseColumnCount <= FACSIMILE_TABLE_MAX_CELLS
  const parsedColumnCount = parsed.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const probeColumnCount = probe.rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const pasteRowCount = baseWithinBudget
    ? Math.min(parsed.rows.length, Math.max(0, probe.rows.length - pasteStart.row))
    : 0
  const pasteColCount = baseWithinBudget
    ? Math.min(parsedColumnCount, Math.max(0, probeColumnCount - pasteStart.col))
    : 0
  if (pasteRowCount < 1 || pasteColCount < 1) {
    return {
      rows: safeRows,
      merges: safeMerges,
      selection: effective,
      truncated: true,
      source: parsed.source,
    }
  }
  const footprint: FacsimileTableSelection = {
    startRow: pasteStart.row,
    endRow: pasteStart.row + pasteRowCount - 1,
    startCol: pasteStart.col,
    endCol: pasteStart.col + pasteColCount - 1,
  }
  const clearSelection = expandFacsimileTableSelectionForMerges({
    startRow: Math.min(effective.startRow, footprint.startRow),
    endRow: Math.max(effective.endRow, footprint.endRow),
    startCol: Math.min(effective.startCol, footprint.startCol),
    endCol: Math.max(effective.endCol, footprint.endCol),
  }, safeMerges, safeRows.length, baseColumnCount)
  const cleared = clearFacsimileTableSelection(safeRows, safeMerges, clearSelection)
  const pasted = pasteFacsimileTableRange(
    cleared.rows,
    cleared.merges,
    pasteStart,
    parsed.rows,
    parsed.merges,
  )
  return {
    rows: pasted.rows,
    merges: pasted.merges,
    selection: effective,
    truncated: parsed.truncated || probe.truncated || pasted.truncated,
    source: parsed.source,
  }
}

export function serializeFacsimileTableSelectionAsTsv(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
): string {
  const safeRows = normalizeFacsimileTableRows(rows)
  const safeMerges = normalizeFacsimileTableMerges(merges, safeRows.length, safeRows[0]?.length || 1)
  const mergeLookup = buildFacsimileTableCellMergeLookup(
    safeMerges,
    safeRows.length,
    safeRows[0]?.length || 1,
    true,
  )
  const effective = expandFacsimileTableSelectionWithLookup(
    selection,
    mergeLookup,
    safeRows.length,
    safeRows[0]?.length || 1,
  )
  return serializeFacsimileTableSelectionAsTsvWithLookup(safeRows, effective, mergeLookup)
}

function serializeFacsimileTableSelectionAsTsvWithLookup(
  rows: string[][],
  selection: FacsimileTableSelection,
  mergeLookup: Map<string, FacsimileTableMerge>,
): string {
  const lines: string[] = []
  for (let row = selection.startRow; row <= selection.endRow; row += 1) {
    const cells: string[] = []
    for (let col = selection.startCol; col <= selection.endCol; col += 1) {
      const merge = mergeLookup.get(mergeLookupKey(row, col))
      cells.push(merge && (merge.row !== row || merge.col !== col) ? '' : rows[row][col])
    }
    lines.push(cells.join('\t'))
  }
  return lines.join('\r\n')
}

function escapeFacsimileTableHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n?|\n/g, '<br>')
}

export function serializeFacsimileTableSelectionForClipboard(
  rows: string[][],
  merges: FacsimileTableMerge[],
  selection: FacsimileTableSelection,
  assumeNormalized = false,
): { text: string; html: string } {
  const safeRows = normalizeFacsimileTableRows(rows)
  const rowCount = safeRows.length
  const colCount = safeRows[0]?.length || 1
  const safeMerges = assumeNormalized ? merges : normalizeFacsimileTableMerges(merges, rowCount, colCount)
  const mergeLookup = buildFacsimileTableCellMergeLookup(safeMerges, rowCount, colCount, true)
  const effective = expandFacsimileTableSelectionWithLookup(selection, mergeLookup, rowCount, colCount)
  const htmlRows: string[] = []
  for (let row = effective.startRow; row <= effective.endRow; row += 1) {
    const htmlCells: string[] = []
    for (let col = effective.startCol; col <= effective.endCol; col += 1) {
      const merge = mergeLookup.get(mergeLookupKey(row, col))
      if (merge && (merge.row !== row || merge.col !== col)) continue
      const rowSpan = merge?.rowSpan || 1
      const colSpan = merge?.colSpan || 1
      const spanAttributes = `${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''}${colSpan > 1 ? ` colspan="${colSpan}"` : ''}`
      htmlCells.push(`<td style="white-space:pre-wrap"${spanAttributes}>${escapeFacsimileTableHtml(safeRows[row][col])}</td>`)
    }
    htmlRows.push(`<tr>${htmlCells.join('')}</tr>`)
  }
  return {
    text: serializeFacsimileTableSelectionAsTsvWithLookup(safeRows, effective, mergeLookup),
    html: `<table><tbody>${htmlRows.join('')}</tbody></table>`,
  }
}

export function reduceFacsimileTableHistory(
  history: FacsimileTableHistory,
  action: FacsimileTableHistoryAction,
): FacsimileTableHistory {
  if (action.type === 'commit') {
    if (snapshotSignature(history.present) === snapshotSignature(action.snapshot)) return history
    return {
      past: [...history.past.slice(-(HISTORY_LIMIT - 1)), cloneSnapshot(history.present)],
      present: cloneSnapshot(action.snapshot),
      future: [],
    }
  }
  if (action.type === 'undo') {
    const previous = history.past.at(-1)
    if (!previous) return history
    return {
      past: history.past.slice(0, -1),
      present: cloneSnapshot(previous),
      future: [cloneSnapshot(history.present), ...history.future].slice(0, HISTORY_LIMIT),
    }
  }
  const next = history.future[0]
  if (!next) return history
  return {
    past: [...history.past.slice(-(HISTORY_LIMIT - 1)), cloneSnapshot(history.present)],
    present: cloneSnapshot(next),
    future: history.future.slice(1),
  }
}

export function reconcileFacsimileTableEditorIdentity(
  currentEditorKey: string,
  nextEditorKey: string,
  nextDataSignature: string,
  lastEmittedDataSignature: string,
  history: FacsimileTableHistory,
  nextSnapshot: TableSnapshot,
): FacsimileTableIdentityReconciliation {
  if (currentEditorKey !== nextEditorKey) {
    return {
      kind: 'identity-change',
      history: { past: [], present: cloneSnapshot(nextSnapshot), future: [] },
    }
  }
  if (nextDataSignature === lastEmittedDataSignature) {
    return { kind: 'emitted-echo', history }
  }
  return {
    kind: 'external-change',
    history: { past: [], present: cloneSnapshot(nextSnapshot), future: [] },
  }
}

export function getFacsimileTableEditorKeyIntent(
  event: { key: string; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean },
  compositionActive: boolean,
): FacsimileTableEditorKeyIntent {
  if (event.isComposing || compositionActive) return 'ignore-composition'
  if (event.key === 'Escape') return 'cancel'
  if (event.key === 'Tab') return event.shiftKey ? 'commit-previous-column' : 'commit-next-column'
  if (event.key === 'Enter' && !event.altKey) return event.shiftKey ? 'commit-previous-row' : 'commit-next-row'
  return 'none'
}

export function clampFacsimileTableContextMenuPosition(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth: number,
  menuHeight: number,
): ContextMenuState {
  return {
    left: Math.max(8, Math.min(clientX, viewportWidth - menuWidth - 8)),
    top: Math.max(8, Math.min(clientY, viewportHeight - menuHeight - 8)),
  }
}

export function attachFacsimileTableResizeListeners(
  target: FacsimileTableResizeTarget,
  pointerId: number,
  onMove: FacsimileTableResizeListener,
  onFinish: (outcome: FacsimileTableResizeOutcome) => void,
): () => void {
  let cleaned = false
  const finish = (outcome: FacsimileTableResizeOutcome) => {
    if (cleaned) return
    cleaned = true
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', handlePointerUp)
    target.removeEventListener('pointercancel', handleCancel)
    target.removeEventListener('lostpointercapture', handleCancel)
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    onFinish(outcome)
  }
  const handlePointerUp = () => finish('commit')
  const handleCancel = () => finish('cancel')
  const cleanup = () => finish('cancel')
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', handlePointerUp)
  target.addEventListener('pointercancel', handleCancel)
  target.addEventListener('lostpointercapture', handleCancel)
  return cleanup
}

export function attachFacsimileTableContextMenuEscapeListener(
  target: FacsimileTableKeyboardTarget,
  onEscape: () => void,
): () => void {
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    target.removeEventListener('keydown', handleKeyDown)
  }
  const handleKeyDown = (rawEvent: unknown) => {
    if (typeof rawEvent !== 'object' || rawEvent === null) return
    const event = rawEvent as { key?: unknown; preventDefault?: unknown }
    if (event.key !== 'Escape') return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    onEscape()
    cleanup()
  }
  target.addEventListener('keydown', handleKeyDown)
  return cleanup
}

export function createFacsimileTableThemeStyle(token: FacsimileTableThemeToken): FacsimileTableThemeStyle {
  return {
    '--table-bg': token.colorBgContainer,
    '--table-menu-bg': token.colorBgElevated,
    '--table-text': token.colorText,
    '--table-secondary': token.colorTextSecondary,
    '--table-grid': token.colorBorderSecondary,
    '--table-selection': token.colorPrimaryBg,
    '--table-active': token.colorPrimary,
    '--table-header': token.colorBgLayout,
    '--table-menu-hover': token.colorPrimaryBgHover,
    '--table-focus': token.colorPrimaryBorder,
    '--table-shadow': token.boxShadowSecondary,
    '--table-disabled': token.colorTextDisabled,
  }
}

function dataSignature(rows: string[][], merges: FacsimileTableMerge[]): string {
  return JSON.stringify([rows, merges])
}

function clampPoint(point: FacsimileTablePoint, rowCount: number, colCount: number): FacsimileTablePoint {
  return {
    row: Math.max(0, Math.min(Math.max(0, rowCount - 1), Number.isFinite(point.row) ? Math.floor(point.row) : 0)),
    col: Math.max(0, Math.min(Math.max(0, colCount - 1), Number.isFinite(point.col) ? Math.floor(point.col) : 0)),
  }
}

function selectionIntersectsCell(
  selection: FacsimileTableSelection,
  row: number,
  col: number,
  merge: FacsimileTableMerge | null,
): boolean {
  const endRow = merge ? row + merge.rowSpan - 1 : row
  const endCol = merge ? col + merge.colSpan - 1 : col
  return selection.startRow <= endRow
    && selection.endRow >= row
    && selection.startCol <= endCol
    && selection.endCol >= col
}

function columnLabel(index: number): string {
  let value = Math.max(0, Math.floor(index)) + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

function isPrintableKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && !event.nativeEvent.isComposing
}

function resizeArrayForInsertion(values: number[], index: number, defaultValue: number, targetLength: number): number[] {
  const next = [...values]
  next.splice(Math.max(0, Math.min(next.length, index)), 0, defaultValue)
  return next.slice(0, targetLength)
}

function selectedIndexes(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => start + offset)
}

export default function FacsimileTableEditor({
  editorKey,
  rows,
  merges,
  rowHeights = [],
  columnWidths = [],
  disabled = false,
  onChange,
}: Props) {
  const { token } = theme.useToken()
  const tableThemeStyle = useMemo(() => createFacsimileTableThemeStyle(token), [token])
  const normalizedPropRows = useMemo(() => normalizeFacsimileTableRows(rows), [rows])
  const normalizedPropMerges = useMemo(
    () => normalizeFacsimileTableMerges(merges, normalizedPropRows.length, normalizedPropRows[0]?.length || 1),
    [merges, normalizedPropRows],
  )
  const normalizedPropRowHeights = useMemo(
    () => normalizeFacsimileTableRowHeights(rowHeights, normalizedPropRows.length),
    [normalizedPropRows.length, rowHeights],
  )
  const normalizedPropColumnWidths = useMemo(
    () => normalizeFacsimileTableColumnWidths(columnWidths, normalizedPropRows[0]?.length || 1),
    [columnWidths, normalizedPropRows],
  )
  const propDataSignature = useMemo(
    () => snapshotSignature({
      rows: normalizedPropRows,
      merges: normalizedPropMerges,
      rowHeights: normalizedPropRowHeights,
      columnWidths: normalizedPropColumnWidths,
    }),
    [normalizedPropColumnWidths, normalizedPropMerges, normalizedPropRowHeights, normalizedPropRows],
  )
  const [tableState, setTableState] = useState<TableSnapshot>(() => createFacsimileTableSnapshot(rows, merges, rowHeights, columnWidths))
  const tableStateRef = useRef(tableState)
  const onChangeRef = useRef(onChange)
  const editorKeyRef = useRef(editorKey)
  const lastEmittedDataSignatureRef = useRef(propDataSignature)
  const focusRef = useRef<FacsimileTablePoint>({ row: 0, col: 0 })
  const undoStackRef = useRef<TableSnapshot[]>([])
  const redoStackRef = useRef<TableSnapshot[]>([])
  const gridRef = useRef<HTMLTableElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const mountedRef = useRef(true)
  const disabledRef = useRef(disabled)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const contextMenuEscapeCleanupRef = useRef<(() => void) | null>(null)
  const draggingSelectionRef = useRef(false)
  const axisAnchorRef = useRef(0)
  const editingCellRef = useRef<FacsimileTablePoint | null>(null)
  const editValueRef = useRef('')
  const compositionRef = useRef(false)
  const [anchor, setAnchor] = useState<FacsimileTablePoint>({ row: 0, col: 0 })
  const [focus, setFocus] = useState<FacsimileTablePoint>({ row: 0, col: 0 })
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('cell')
  const [editingCell, setEditingCell] = useState<FacsimileTablePoint | null>(null)
  const [editValue, setEditValue] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [, setHistoryVersion] = useState(0)

  tableStateRef.current = tableState
  onChangeRef.current = onChange
  focusRef.current = focus
  disabledRef.current = disabled

  const rowCount = tableState.rows.length
  const colCount = tableState.rows[0]?.length || 1
  const mergeLookup = useMemo(
    () => buildFacsimileTableCellMergeLookup(tableState.merges, rowCount, colCount, true),
    [colCount, rowCount, tableState.merges],
  )
  const rawSelection = getFacsimileTableSelection(anchor, focus)
  const selection = useMemo(
    () => expandFacsimileTableSelectionWithLookup(rawSelection, mergeLookup, rowCount, colCount),
    [anchor.col, anchor.row, colCount, focus.col, focus.row, mergeLookup, rowCount],
  )
  const activePoint = clampPoint(focus, rowCount, colCount)
  const activeMerge = mergeLookup.get(mergeLookupKey(activePoint.row, activePoint.col))
  const activeCell = activeMerge ? { row: activeMerge.row, col: activeMerge.col } : activePoint
  const commandAvailability = useMemo(
    () => getFacsimileTableCommandAvailabilityForNormalizedSnapshot(
      tableState.rows,
      tableState.merges,
      selection,
      selectionMode,
    ),
    [selection, selectionMode, tableState.merges, tableState.rows],
  )

  const updateHistoryRefs = (history: FacsimileTableHistory) => {
    undoStackRef.current = history.past
    redoStackRef.current = history.future
    if (mountedRef.current) setHistoryVersion((version) => version + 1)
  }

  const emitSnapshot = (next: TableSnapshot, previous: TableSnapshot) => {
    const nextDataSignature = snapshotSignature(next)
    if (nextDataSignature === snapshotSignature(previous)) return
    lastEmittedDataSignatureRef.current = nextDataSignature
    onChangeRef.current({
      rows: next.rows,
      merges: next.merges,
      cells: buildFacsimileTableCells(next.rows, next.merges),
      rowHeights: next.rowHeights,
      columnWidths: next.columnWidths,
    })
  }

  const applySnapshot = (candidate: TableSnapshot, options: { record?: boolean; emit?: boolean } = {}) => {
    if (!canHandleFacsimileTableInteraction(disabled, 'mutation')) return false
    const previous = tableStateRef.current
    const next = normalizeSnapshot(candidate)
    if (snapshotSignature(previous) === snapshotSignature(next)) return false
    if (options.record !== false) {
      updateHistoryRefs(reduceFacsimileTableHistory({
        past: undoStackRef.current,
        present: previous,
        future: redoStackRef.current,
      }, { type: 'commit', snapshot: next }))
    }
    tableStateRef.current = next
    setTableState(next)
    if (options.emit !== false) emitSnapshot(next, previous)
    return true
  }

  const focusGrid = () => {
    if (disabled) return
    window.requestAnimationFrame(() => gridRef.current?.focus({ preventScroll: true }))
  }

  const closeContextMenu = () => {
    const cleanup = contextMenuEscapeCleanupRef.current
    contextMenuEscapeCleanupRef.current = null
    cleanup?.()
    if (mountedRef.current) setContextMenu(null)
  }

  const selectPoint = (point: FacsimileTablePoint, extend = false) => {
    if (disabled) return
    const safePoint = clampPoint(point, rowCount, colCount)
    const targetMerge = findFacsimileTableMerge(tableStateRef.current.merges, safePoint.row, safePoint.col)
    const target = targetMerge ? { row: targetMerge.row, col: targetMerge.col } : safePoint
    if (!extend) setAnchor(target)
    setFocus(target)
    setSelectionMode('cell')
  }

  useEffect(() => {
    const previous = tableStateRef.current
    const identityChanged = editorKeyRef.current !== editorKey
    const next = identityChanged
      ? createFacsimileTableSnapshot(normalizedPropRows, normalizedPropMerges, normalizedPropRowHeights, normalizedPropColumnWidths)
      : normalizeSnapshot({
          rows: normalizedPropRows,
          merges: normalizedPropMerges,
          rowHeights: normalizedPropRowHeights,
          columnWidths: normalizedPropColumnWidths,
        })
    const reconciliation = reconcileFacsimileTableEditorIdentity(
      editorKeyRef.current,
      editorKey,
      propDataSignature,
      lastEmittedDataSignatureRef.current,
      { past: undoStackRef.current, present: previous, future: redoStackRef.current },
      next,
    )
    if (reconciliation.kind === 'emitted-echo') return
    if (identityChanged) {
      resizeCleanupRef.current?.()
      resizeCleanupRef.current = null
      closeContextMenu()
      compositionRef.current = false
    }
    editorKeyRef.current = editorKey
    tableStateRef.current = next
    setTableState(next)
    updateHistoryRefs(reconciliation.history)
    lastEmittedDataSignatureRef.current = propDataSignature
    const nextPoint = identityChanged
      ? { row: 0, col: 0 }
      : clampPoint(focusRef.current, next.rows.length, next.rows[0]?.length || 1)
    setAnchor(nextPoint)
    setFocus(nextPoint)
    if (identityChanged) setSelectionMode('cell')
    editingCellRef.current = null
    setEditingCell(null)
    editValueRef.current = ''
    setEditValue('')
  }, [editorKey, propDataSignature])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      resizeCleanupRef.current?.()
      resizeCleanupRef.current = null
      contextMenuEscapeCleanupRef.current?.()
      contextMenuEscapeCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    const stopDragging = () => {
      draggingSelectionRef.current = false
    }
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
    return () => {
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
    }
  }, [])

  useEffect(() => {
    if (!editingCell) return
    editorRef.current?.focus()
    editorRef.current?.select()
  }, [editingCell])

  useEffect(() => {
    if (!disabled) return
    draggingSelectionRef.current = false
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = null
    closeContextMenu()
    compositionRef.current = false
    editingCellRef.current = null
    setEditingCell(null)
    editValueRef.current = ''
    setEditValue('')
  }, [disabled])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => closeContextMenu()
    window.addEventListener('pointerdown', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [contextMenu])

  const startEditing = (point: FacsimileTablePoint, replacement?: string) => {
    if (disabled) return
    const safePoint = clampPoint(point, rowCount, colCount)
    const merge = findFacsimileTableMerge(tableStateRef.current.merges, safePoint.row, safePoint.col)
    const target = merge ? { row: merge.row, col: merge.col } : safePoint
    const value = replacement ?? tableStateRef.current.rows[target.row]?.[target.col] ?? ''
    setAnchor(target)
    setFocus(target)
    setSelectionMode('cell')
    editingCellRef.current = target
    editValueRef.current = value
    setEditValue(value)
    setEditingCell(target)
  }

  const finishEditing = (move?: 'next-column' | 'previous-column' | 'next-row' | 'previous-row') => {
    if (disabled) {
      editingCellRef.current = null
      setEditingCell(null)
      return
    }
    const target = editingCellRef.current
    if (!target) return
    editingCellRef.current = null
    setEditingCell(null)
    const current = tableStateRef.current
    const nextRows = current.rows.map((row) => [...row])
    nextRows[target.row][target.col] = editValueRef.current
    applySnapshot({ ...current, rows: nextRows })
    if (move) moveSelection(move, false, target)
    focusGrid()
  }

  const cancelEditing = () => {
    editingCellRef.current = null
    setEditingCell(null)
    focusGrid()
  }

  const moveSelection = (
    direction: 'left' | 'right' | 'up' | 'down' | 'next-column' | 'previous-column' | 'next-row' | 'previous-row',
    extend: boolean,
    origin = activeCell,
  ) => {
    if (disabled) return
    const current = tableStateRef.current
    const currentMerge = findFacsimileTableMerge(current.merges, origin.row, origin.col)
    let row = origin.row
    let col = origin.col
    if (direction === 'left') col -= 1
    if (direction === 'right') col += currentMerge?.colSpan || 1
    if (direction === 'up') row -= 1
    if (direction === 'down') row += currentMerge?.rowSpan || 1
    if (direction === 'previous-row') row -= 1
    if (direction === 'next-row') row += currentMerge?.rowSpan || 1
    if (direction === 'next-column') {
      col += currentMerge?.colSpan || 1
      if (col >= colCount) {
        col = 0
        row += 1
      }
    }
    if (direction === 'previous-column') {
      col -= 1
      if (col < 0) {
        col = colCount - 1
        row -= 1
      }
    }
    selectPoint(clampPoint({ row, col }, rowCount, colCount), extend)
  }

  const undo = () => {
    if (disabled) return
    const current = tableStateRef.current
    const history = reduceFacsimileTableHistory({
      past: undoStackRef.current,
      present: current,
      future: redoStackRef.current,
    }, { type: 'undo' })
    if (history.present === current) return
    updateHistoryRefs(history)
    applySnapshot(history.present, { record: false })
    const point = clampPoint(activeCell, history.present.rows.length, history.present.rows[0]?.length || 1)
    setAnchor(point)
    setFocus(point)
  }

  const redo = () => {
    if (disabled) return
    const current = tableStateRef.current
    const history = reduceFacsimileTableHistory({
      past: undoStackRef.current,
      present: current,
      future: redoStackRef.current,
    }, { type: 'redo' })
    if (history.present === current) return
    updateHistoryRefs(history)
    applySnapshot(history.present, { record: false })
    const point = clampPoint(activeCell, history.present.rows.length, history.present.rows[0]?.length || 1)
    setAnchor(point)
    setFocus(point)
  }

  const applyStructureAction = (action: FacsimileTableStructureAction) => {
    if (disabled) return
    const current = tableStateRef.current
    const result = applyFacsimileTableStructureCommand(
      current.rows,
      current.merges,
      selection,
      selectionMode,
      action,
    )
    if (!result.changed) return
    let rowHeights = [...current.rowHeights]
    let columnWidths = [...current.columnWidths]
    if (result.rowMutation?.kind === 'insert') {
      rowHeights = resizeArrayForInsertion(
        rowHeights,
        result.rowMutation.indexes[0],
        FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT,
        result.rows.length,
      )
    } else if (result.rowMutation?.kind === 'delete') {
      for (const index of result.rowMutation.indexes) rowHeights.splice(index, 1)
    }
    if (result.columnMutation?.kind === 'insert') {
      columnWidths = resizeArrayForInsertion(
        columnWidths,
        result.columnMutation.indexes[0],
        FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH,
        result.rows[0]?.length || 1,
      )
    } else if (result.columnMutation?.kind === 'delete') {
      for (const index of result.columnMutation.indexes) columnWidths.splice(index, 1)
    }
    applySnapshot({ ...current, rows: result.rows, merges: result.merges, rowHeights, columnWidths })
    const point = clampPoint(
      { row: result.selection.startRow, col: result.selection.startCol },
      result.rows.length,
      result.rows[0]?.length || 1,
    )
    setAnchor(point)
    setFocus(point)
    setSelectionMode('cell')
  }

  const applySelectionCommand = (command: 'clear' | 'merge' | 'split') => {
    if (disabled) return
    const current = tableStateRef.current
    const result = applyFacsimileTableSelectionCommand(current.rows, current.merges, selection, command)
    applySnapshot({ ...current, ...result })
    const target = clampPoint(
      { row: result.selection.startRow, col: result.selection.startCol },
      result.rows.length,
      result.rows[0]?.length || 1,
    )
    setAnchor(target)
    setFocus(target)
    setSelectionMode('cell')
  }

  const performAction = (action: TableAction) => {
    if (disabled) return
    closeContextMenu()
    if (
      action === 'insert-row-above'
      || action === 'insert-row-below'
      || action === 'insert-column-left'
      || action === 'insert-column-right'
      || action === 'delete-row'
      || action === 'delete-column'
    ) applyStructureAction(action)
    else if (action === 'merge') applySelectionCommand('merge')
    else if (action === 'split') applySelectionCommand('split')
    else if (action === 'clear') applySelectionCommand('clear')
    focusGrid()
  }

  const handleCellPointerDown = (event: ReactPointerEvent<HTMLTableCellElement>) => {
    if (disabled) return
    if (event.button !== 0) return
    const row = Number(event.currentTarget.dataset.tableRow)
    const col = Number(event.currentTarget.dataset.tableCol)
    const point = clampPoint({ row, col }, rowCount, colCount)
    draggingSelectionRef.current = true
    if (event.shiftKey) setFocus(point)
    else {
      setAnchor(point)
      setFocus(point)
    }
    setSelectionMode('cell')
    gridRef.current?.focus({ preventScroll: true })
  }

  const handleCellPointerEnter = (point: FacsimileTablePoint) => {
    if (disabled) return
    if (!draggingSelectionRef.current) return
    setFocus(clampPoint(point, rowCount, colCount))
    setSelectionMode('cell')
  }

  const selectWholeRow = (event: ReactPointerEvent<HTMLButtonElement>, row: number) => {
    if (disabled) return
    if (event.button !== 0) return
    event.preventDefault()
    const anchorRow = event.shiftKey && selectionMode === 'row' ? axisAnchorRef.current : row
    if (!event.shiftKey || selectionMode !== 'row') axisAnchorRef.current = row
    const wholeRow = getFacsimileTableWholeRowSelection(anchorRow, row, rowCount, colCount)
    setAnchor({ row: wholeRow.startRow, col: wholeRow.startCol })
    setFocus({ row: wholeRow.endRow, col: wholeRow.endCol })
    setSelectionMode('row')
    gridRef.current?.focus({ preventScroll: true })
  }

  const selectWholeColumn = (event: ReactPointerEvent<HTMLButtonElement>, col: number) => {
    if (disabled) return
    if (event.button !== 0) return
    event.preventDefault()
    const anchorCol = event.shiftKey && selectionMode === 'column' ? axisAnchorRef.current : col
    if (!event.shiftKey || selectionMode !== 'column') axisAnchorRef.current = col
    const wholeColumn = getFacsimileTableWholeColumnSelection(anchorCol, col, rowCount, colCount)
    setAnchor({ row: wholeColumn.startRow, col: wholeColumn.startCol })
    setFocus({ row: wholeColumn.endRow, col: wholeColumn.endCol })
    setSelectionMode('column')
    gridRef.current?.focus({ preventScroll: true })
  }

  const startResize = (
    event: ReactPointerEvent<HTMLElement>,
    axis: 'row' | 'column',
    index: number,
  ) => {
    if (disabled) return
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    resizeCleanupRef.current?.()
    resizeCleanupRef.current = null
    const handle = event.currentTarget
    const pointerId = event.pointerId
    const startCoordinate = axis === 'row' ? event.clientY : event.clientX
    const before = cloneSnapshot(tableStateRef.current)
    const startSize = axis === 'row' ? before.rowHeights[index] : before.columnWidths[index]
    handle.setPointerCapture(pointerId)
    const handleMove = (rawEvent: unknown) => {
      if (!mountedRef.current || disabledRef.current || !(rawEvent instanceof PointerEvent)) return
      const moveEvent = rawEvent
      const distance = (axis === 'row' ? moveEvent.clientY : moveEvent.clientX) - startCoordinate
      const current = tableStateRef.current
      if (axis === 'row') {
        const rowHeights = [...before.rowHeights]
        rowHeights[index] = startSize + distance
        const next = { ...current, rowHeights: normalizeFacsimileTableRowHeights(rowHeights, current.rows.length) }
        tableStateRef.current = next
        setTableState(next)
      } else {
        const columnWidths = [...before.columnWidths]
        columnWidths[index] = startSize + distance
        const next = { ...current, columnWidths: normalizeFacsimileTableColumnWidths(columnWidths, current.rows[0]?.length || 1) }
        tableStateRef.current = next
        setTableState(next)
      }
    }
    const resizeTarget: FacsimileTableResizeTarget = {
      addEventListener: (type, listener) => handle.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) => handle.removeEventListener(type, listener as EventListener),
      hasPointerCapture: (id) => handle.hasPointerCapture(id),
      releasePointerCapture: (id) => handle.releasePointerCapture(id),
    }
    let cleanup: () => void = () => undefined
    cleanup = attachFacsimileTableResizeListeners(resizeTarget, pointerId, handleMove, (outcome) => {
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null
      const after = tableStateRef.current
      const resolution = resolveFacsimileTableResize(before, after, outcome, disabledRef.current)
      tableStateRef.current = resolution.snapshot
      if (mountedRef.current) setTableState(resolution.snapshot)
      if (!resolution.shouldCommit) return
      const baseHistory = {
        past: undoStackRef.current,
        present: before,
        future: redoStackRef.current,
      }
      const history = reduceFacsimileTableHistory(baseHistory, { type: 'commit', snapshot: resolution.snapshot })
      if (history !== baseHistory) updateHistoryRefs(history)
      emitSnapshot(resolution.snapshot, before)
    })
    resizeCleanupRef.current = cleanup
  }

  const resetSize = (axis: 'row' | 'column', index: number) => {
    if (disabled) return
    const current = tableStateRef.current
    if (axis === 'row') {
      const rowHeights = [...current.rowHeights]
      rowHeights[index] = FACSIMILE_TABLE_DEFAULT_ROW_HEIGHT
      applySnapshot({ ...current, rowHeights })
    } else {
      const columnWidths = [...current.columnWidths]
      columnWidths[index] = FACSIMILE_TABLE_DEFAULT_COLUMN_WIDTH
      applySnapshot({ ...current, columnWidths })
    }
  }

  const handleColumnResizePointerDown = (event: ReactPointerEvent<HTMLSpanElement>, col: number) => {
    if (disabled) return
    startResize(event, 'column', col)
  }

  const handleRowResizePointerDown = (event: ReactPointerEvent<HTMLSpanElement>, row: number) => {
    if (disabled) return
    startResize(event, 'row', row)
  }

  const handlePaste = (event: ReactClipboardEvent<HTMLTableElement>) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    if (event.target instanceof HTMLTextAreaElement) return
    const html = event.clipboardData.getData('text/html')
    const text = event.clipboardData.getData('text/plain')
    if (!html && !text) return
    event.preventDefault()
    const clipboardBytes = (html.length + text.length) * 2
    if (clipboardBytes > LARGE_CLIPBOARD_BYTES) message.info('剪贴板内容较大，正在按安全上限导入，请稍候。')
    const current = tableStateRef.current
    const pasted = applyFacsimileTableClipboardCommand(current.rows, current.merges, selection, { html, text })
    if (pasted.source === 'none') return
    applySnapshot({
      ...current,
      rows: pasted.rows,
      merges: pasted.merges,
      rowHeights: normalizeFacsimileTableRowHeights(current.rowHeights, pasted.rows.length),
      columnWidths: normalizeFacsimileTableColumnWidths(current.columnWidths, pasted.rows[0]?.length || 1),
    })
    if (pasted.truncated) {
      message.warning('粘贴内容超过表格安全上限，已导入可容纳的部分。')
    }
  }

  const handleCopy = (event: ReactClipboardEvent<HTMLTableElement>) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    if (event.target instanceof HTMLTextAreaElement) return
    event.preventDefault()
    const clipboard = serializeFacsimileTableSelectionForClipboard(
      tableState.rows,
      tableState.merges,
      selection,
      true,
    )
    event.clipboardData.setData('text/plain', clipboard.text)
    event.clipboardData.setData('text/html', clipboard.html)
  }

  const handleCut = (event: ReactClipboardEvent<HTMLTableElement>) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    if (event.target instanceof HTMLTextAreaElement) return
    event.preventDefault()
    const clipboard = serializeFacsimileTableSelectionForClipboard(
      tableState.rows,
      tableState.merges,
      selection,
      true,
    )
    event.clipboardData.setData('text/plain', clipboard.text)
    event.clipboardData.setData('text/html', clipboard.html)
    performAction('clear')
  }

  const openContextMenu = (clientX: number, clientY: number) => {
    if (disabled) return
    closeContextMenu()
    gridRef.current?.focus({ preventScroll: true })
    const menuWidth = 216
    const menuHeight = 328
    setContextMenu(clampFacsimileTableContextMenuPosition(
      clientX,
      clientY,
      window.innerWidth,
      window.innerHeight,
      menuWidth,
      menuHeight,
    ))
    const keyboardTarget: FacsimileTableKeyboardTarget = {
      addEventListener: (type, listener) => window.addEventListener(type, listener as EventListener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener as EventListener),
    }
    contextMenuEscapeCleanupRef.current = attachFacsimileTableContextMenuEscapeListener(
      keyboardTarget,
      closeContextMenu,
    )
  }

  const setContextSelection = (next: FacsimileTableSelection, mode: SelectionMode) => {
    if (disabled) return
    setAnchor({ row: next.startRow, col: next.startCol })
    setFocus({ row: next.endRow, col: next.endCol })
    setSelectionMode(mode)
  }

  const handleContextMenu = (event: ReactMouseEvent<HTMLTableElement>) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    openContextMenu(event.clientX, event.clientY)
  }

  const handleCellContextMenu = (
    event: ReactMouseEvent<HTMLTableCellElement>,
    point: FacsimileTablePoint,
  ) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const resolution = resolveFacsimileTableCellContextSelection(
      point,
      selection,
      selectionMode,
      tableState.merges,
      rowCount,
      colCount,
    )
    setContextSelection(resolution.selection, resolution.mode)
    openContextMenu(event.clientX, event.clientY)
  }

  const handleRowHeaderContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, row: number) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    axisAnchorRef.current = row
    setContextSelection(createFacsimileTableHeaderContextSelection('row', row, rowCount, colCount), 'row')
    openContextMenu(event.clientX, event.clientY)
  }

  const handleColumnHeaderContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, col: number) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    axisAnchorRef.current = col
    setContextSelection(createFacsimileTableHeaderContextSelection('column', col, rowCount, colCount), 'column')
    openContextMenu(event.clientX, event.clientY)
  }

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLTableElement>) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    if (event.target instanceof HTMLTextAreaElement) return
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (key === 'y') {
        event.preventDefault()
        redo()
        return
      }
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key.slice(5).toLowerCase() as 'up' | 'down' | 'left' | 'right'
      moveSelection(direction, event.shiftKey)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      moveSelection(event.shiftKey ? 'previous-column' : 'next-column', false)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      moveSelection(event.shiftKey ? 'previous-row' : 'next-row', false)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      performAction('clear')
    } else if (event.key === 'F2') {
      event.preventDefault()
      startEditing(activeCell)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeContextMenu()
      setAnchor(activeCell)
      setFocus(activeCell)
      setSelectionMode('cell')
    } else if (isPrintableKey(event)) {
      event.preventDefault()
      startEditing(activeCell, event.key)
    }
  }

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (disabled) {
      event.preventDefault()
      return
    }
    event.stopPropagation()
    const intent = getFacsimileTableEditorKeyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      isComposing: event.nativeEvent.isComposing,
    }, compositionRef.current)
    if (intent === 'ignore-composition' || intent === 'none') return
    if (intent === 'cancel') {
      event.preventDefault()
      cancelEditing()
    } else if (intent === 'commit-next-column' || intent === 'commit-previous-column') {
      event.preventDefault()
      finishEditing(intent === 'commit-previous-column' ? 'previous-column' : 'next-column')
    } else {
      event.preventDefault()
      finishEditing(intent === 'commit-previous-row' ? 'previous-row' : 'next-row')
    }
  }

  return (
    <div className={`facsimile-table-editor${disabled ? ' is-disabled' : ''}`} aria-disabled={disabled} style={tableThemeStyle}>
      <div className="facsimile-table-toolbar" role="toolbar" aria-label="表格编辑历史">
        <Tooltip title="撤销上一步表格编辑（Ctrl+Z）">
          <Button
            size="small"
            aria-label="撤销表格编辑"
            disabled={disabled || undoStackRef.current.length === 0}
            onClick={undo}
          >
            撤销
          </Button>
        </Tooltip>
        <Tooltip title="重做下一步表格编辑（Ctrl+Y / Ctrl+Shift+Z）">
          <Button
            size="small"
            aria-label="重做表格编辑"
            disabled={disabled || redoStackRef.current.length === 0}
            onClick={redo}
          >
            重做
          </Button>
        </Tooltip>
        <span className="facsimile-table-status">{rowCount} 行 × {colCount} 列；结构操作请使用右键菜单</span>
      </div>
      <div className="facsimile-table-help">
        单击选择，拖动框选，双击或按 F2 编辑；可直接粘贴 Excel/WPS/网页表格。Alt+Enter 可在单元格内换行。
      </div>
      <div className="facsimile-table-grid-shell" onScroll={() => closeContextMenu()}>
        <table
          ref={gridRef}
          role="grid"
          aria-label="版式表格编辑器"
          aria-rowcount={rowCount}
          aria-colcount={colCount}
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          className="facsimile-table-grid"
          style={tableThemeStyle}
          onKeyDown={handleGridKeyDown}
          onPaste={handlePaste}
          onCopy={handleCopy}
          onCut={handleCut}
          onContextMenu={handleContextMenu}
        >
          <colgroup>
            <col className="facsimile-table-row-number-column" />
            {tableState.columnWidths.map((width, col) => <col key={col} style={{ width }} />)}
          </colgroup>
          <thead role="rowgroup">
            <tr role="row">
              <th className="facsimile-table-corner" aria-hidden="true" />
              {tableState.columnWidths.map((_, col) => (
                <th key={col} role="columnheader" className="facsimile-table-column-heading" aria-colindex={col + 1}>
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={disabled}
                    className="facsimile-table-column-header"
                    aria-label={`选择第 ${columnLabel(col)} 列`}
                    onPointerDown={(event) => selectWholeColumn(event, col)}
                    onContextMenu={(event) => handleColumnHeaderContextMenu(event, col)}
                  >
                    {columnLabel(col)}
                  </button>
                  <span
                    className="facsimile-table-column-resize-handle"
                    role="separator"
                    aria-label={`调整第 ${columnLabel(col)} 列宽度`}
                    aria-orientation="vertical"
                    aria-disabled={disabled}
                    onPointerDown={(event) => handleColumnResizePointerDown(event, col)}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      resetSize('column', col)
                    }}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {tableState.rows.map((row, rowIndex) => (
              <tr key={rowIndex} role="row" style={{ height: tableState.rowHeights[rowIndex] }}>
                <th role="rowheader" className="facsimile-table-row-heading" aria-rowindex={rowIndex + 1}>
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={disabled}
                    className="facsimile-table-row-header"
                    aria-label={`选择第 ${rowIndex + 1} 行`}
                    onPointerDown={(event) => selectWholeRow(event, rowIndex)}
                    onContextMenu={(event) => handleRowHeaderContextMenu(event, rowIndex)}
                  >
                    {rowIndex + 1}
                  </button>
                  <span
                    className="facsimile-table-row-resize-handle"
                    role="separator"
                    aria-label={`调整第 ${rowIndex + 1} 行高度`}
                    aria-orientation="horizontal"
                    aria-disabled={disabled}
                    onPointerDown={(event) => handleRowResizePointerDown(event, rowIndex)}
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      resetSize('row', rowIndex)
                    }}
                  />
                </th>
                {row.map((cell, colIndex) => {
                  const merge = mergeLookup.get(mergeLookupKey(rowIndex, colIndex))
                  if (merge && (merge.row !== rowIndex || merge.col !== colIndex)) return null
                  const selected = selectionIntersectsCell(selection, rowIndex, colIndex, merge ?? null)
                  const active = activeCell.row === rowIndex && activeCell.col === colIndex
                  const editing = editingCell?.row === rowIndex && editingCell.col === colIndex
                  const className = [
                    'facsimile-table-cell',
                    selected ? 'is-selected' : '',
                    active ? 'is-active' : '',
                    merge ? 'is-merged' : '',
                  ].filter(Boolean).join(' ')
                  return (
                    <td
                      key={colIndex}
                      role="gridcell"
                      aria-colindex={colIndex + 1}
                      aria-selected={selected}
                      aria-rowspan={merge?.rowSpan}
                      aria-colspan={merge?.colSpan}
                      rowSpan={merge?.rowSpan}
                      colSpan={merge?.colSpan}
                      data-table-row={rowIndex}
                      data-table-col={colIndex}
                      data-covered-cells={merge ? merge.rowSpan * merge.colSpan - 1 : 0}
                      className={className}
                      onPointerDown={handleCellPointerDown}
                      onPointerEnter={() => handleCellPointerEnter({ row: rowIndex, col: colIndex })}
                      onDoubleClick={() => startEditing({ row: rowIndex, col: colIndex })}
                      onContextMenu={(event) => handleCellContextMenu(event, { row: rowIndex, col: colIndex })}
                    >
                      {editingCell && editing ? (
                        <textarea
                          ref={editorRef}
                          className="facsimile-table-active-editor"
                          aria-label={`编辑第 ${rowIndex + 1} 行第 ${columnLabel(colIndex)} 列`}
                          disabled={disabled}
                          tabIndex={disabled ? -1 : 0}
                          value={editValue}
                          onPointerDown={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            if (disabled) return
                            editValueRef.current = event.target.value
                            setEditValue(event.target.value)
                          }}
                          onCompositionStart={() => {
                            if (disabled) return
                            compositionRef.current = true
                          }}
                          onCompositionEnd={() => {
                            if (disabled) return
                            compositionRef.current = false
                          }}
                          onKeyDown={handleEditorKeyDown}
                          onBlur={() => finishEditing()}
                        />
                      ) : (
                        <div className="facsimile-table-cell-display">{cell}</div>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {contextMenu ? (
        <div
          className="facsimile-table-context-menu"
          role="menu"
          aria-label="表格操作"
          style={{ left: contextMenu.left, top: contextMenu.top }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            closeContextMenu()
            focusGrid()
          }}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget
            if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) closeContextMenu()
          }}
        >
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.insertRow} onClick={() => performAction('insert-row-above')}>上方插入行</button>
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.insertRow} onClick={() => performAction('insert-row-below')}>下方插入行</button>
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.insertColumn} onClick={() => performAction('insert-column-left')}>左侧插入列</button>
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.insertColumn} onClick={() => performAction('insert-column-right')}>右侧插入列</button>
          <div className="facsimile-table-context-divider" role="separator" />
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.deleteRow} onClick={() => performAction('delete-row')}>删除行</button>
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.deleteColumn} onClick={() => performAction('delete-column')}>删除列</button>
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.merge} onClick={() => performAction('merge')}>合并选区</button>
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.split} onClick={() => performAction('split')}>拆分单元格</button>
          <button type="button" role="menuitem" disabled={disabled || !commandAvailability.clear} onClick={() => performAction('clear')}>清空选区</button>
        </div>
      ) : null}
    </div>
  )
}

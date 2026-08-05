import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Button, Input, Space, Tooltip } from 'antd'
import {
  buildFacsimileTableCells,
  deleteFacsimileTableColumn,
  deleteFacsimileTableRow,
  findFacsimileTableMerge,
  getFacsimileTableSelection,
  insertFacsimileTableColumn,
  insertFacsimileTableRow,
  isFacsimileTableCoveredCell,
  mergeFacsimileTableSelection,
  normalizeFacsimileTableMerges,
  normalizeFacsimileTableRows,
  splitFacsimileTableCell,
  type FacsimileTableMerge,
  type FacsimileTablePoint,
} from '../utils/facsimileTableEditing'

export type FacsimileTableEditorValue = {
  rows: string[][]
  merges: FacsimileTableMerge[]
  cells: Record<string, unknown>[]
}

type Props = {
  rows: string[][]
  merges: FacsimileTableMerge[]
  onChange: (value: FacsimileTableEditorValue) => void
}

function selectionContains(selection: ReturnType<typeof getFacsimileTableSelection>, row: number, col: number): boolean {
  return row >= selection.startRow && row <= selection.endRow && col >= selection.startCol && col <= selection.endCol
}

export default function FacsimileTableEditor({ rows, merges, onChange }: Props) {
  const normalizedRows = useMemo(() => normalizeFacsimileTableRows(rows), [rows])
  const normalizedMerges = useMemo(
    () => normalizeFacsimileTableMerges(merges, normalizedRows.length, normalizedRows[0]?.length || 1),
    [merges, normalizedRows],
  )
  const [anchor, setAnchor] = useState<FacsimileTablePoint>({ row: 0, col: 0 })
  const [focus, setFocus] = useState<FacsimileTablePoint>({ row: 0, col: 0 })
  const selection = getFacsimileTableSelection(anchor, focus)
  const selectedMerge = findFacsimileTableMerge(normalizedMerges, focus.row, focus.col)
  const emit = (nextRows: string[][], nextMerges: FacsimileTableMerge[]) => {
    const safeRows = normalizeFacsimileTableRows(nextRows)
    const safeMerges = normalizeFacsimileTableMerges(nextMerges, safeRows.length, safeRows[0].length)
    onChange({ rows: safeRows, merges: safeMerges, cells: buildFacsimileTableCells(safeRows, safeMerges) })
  }
  const selectCell = (event: ReactMouseEvent, point: FacsimileTablePoint) => {
    if (event.shiftKey) setFocus(point)
    else {
      setAnchor(point)
      setFocus(point)
    }
  }
  const applyStructure = (result: { rows: string[][]; merges: FacsimileTableMerge[] }, nextPoint: FacsimileTablePoint) => {
    emit(result.rows, result.merges)
    setAnchor(nextPoint)
    setFocus(nextPoint)
  }
  const currentRow = Math.max(0, Math.min(normalizedRows.length - 1, focus.row))
  const currentCol = Math.max(0, Math.min((normalizedRows[0]?.length || 1) - 1, focus.col))

  return (
    <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Space size={[6, 6]} wrap>
        <Button size="small" onClick={() => applyStructure(insertFacsimileTableRow(normalizedRows, normalizedMerges, currentRow), { row: currentRow, col: currentCol })}>上方插入行</Button>
        <Button size="small" onClick={() => applyStructure(insertFacsimileTableRow(normalizedRows, normalizedMerges, currentRow + 1), { row: currentRow + 1, col: currentCol })}>下方插入行</Button>
        <Button size="small" danger disabled={normalizedRows.length <= 1} onClick={() => applyStructure(deleteFacsimileTableRow(normalizedRows, normalizedMerges, currentRow), { row: Math.max(0, currentRow - 1), col: currentCol })}>删除行</Button>
        <Button size="small" onClick={() => applyStructure(insertFacsimileTableColumn(normalizedRows, normalizedMerges, currentCol), { row: currentRow, col: currentCol })}>左侧插入列</Button>
        <Button size="small" onClick={() => applyStructure(insertFacsimileTableColumn(normalizedRows, normalizedMerges, currentCol + 1), { row: currentRow, col: currentCol + 1 })}>右侧插入列</Button>
        <Button size="small" danger disabled={(normalizedRows[0]?.length || 1) <= 1} onClick={() => applyStructure(deleteFacsimileTableColumn(normalizedRows, normalizedMerges, currentCol), { row: currentRow, col: Math.max(0, currentCol - 1) })}>删除列</Button>
        <Tooltip title="先点一个单元格，再按住 Shift 点击另一个单元格选择矩形区域">
          <Button
            size="small"
            type="primary"
            ghost
            disabled={selection.startRow === selection.endRow && selection.startCol === selection.endCol}
            onClick={() => {
              const result = mergeFacsimileTableSelection(normalizedRows, normalizedMerges, selection)
              emit(result.rows, result.merges)
              setAnchor({ row: selection.startRow, col: selection.startCol })
              setFocus({ row: selection.startRow, col: selection.startCol })
            }}
          >
            合并选区
          </Button>
        </Tooltip>
        <Button
          size="small"
          disabled={!selectedMerge}
          onClick={() => {
            const result = splitFacsimileTableCell(normalizedRows, normalizedMerges, focus)
            emit(result.rows, result.merges)
          }}
        >
          拆分单元格
        </Button>
      </Space>
      <div style={{ color: 'var(--gs-text-secondary)', fontSize: 12 }}>
        直接修改单元格文字；按住 Shift 点击可框选连续单元格，再执行合并。合并后的文字会保留在左上角单元格。
      </div>
      <div style={{ overflow: 'auto', maxHeight: 'min(54vh, 520px)', border: '1px solid rgba(45,33,21,0.2)', borderRadius: 6, background: '#fff' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: '100%', tableLayout: 'fixed' }}>
          <tbody>
            {normalizedRows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, colIndex) => {
                  if (isFacsimileTableCoveredCell(normalizedMerges, rowIndex, colIndex)) return null
                  const merge = findFacsimileTableMerge(normalizedMerges, rowIndex, colIndex)
                  const selected = selectionContains(selection, rowIndex, colIndex)
                  return (
                    <td
                      key={colIndex}
                      rowSpan={merge?.rowSpan}
                      colSpan={merge?.colSpan}
                      onMouseDown={(event) => selectCell(event, { row: rowIndex, col: colIndex })}
                      style={{
                        border: selected ? '2px solid #1677ff' : '1px solid rgba(64,48,32,0.28)',
                        padding: 3,
                        minWidth: 112,
                        background: selected ? 'rgba(22,119,255,0.08)' : '#fff',
                        verticalAlign: 'top',
                      }}
                    >
                      <Input.TextArea
                        value={cell}
                        autoSize={{ minRows: 2, maxRows: 8 }}
                        onFocus={() => {
                          setAnchor({ row: rowIndex, col: colIndex })
                          setFocus({ row: rowIndex, col: colIndex })
                        }}
                        onChange={(event) => {
                          const nextRows = normalizedRows.map((item) => [...item])
                          nextRows[rowIndex][colIndex] = event.target.value
                          emit(nextRows, normalizedMerges)
                        }}
                        style={{ resize: 'vertical', border: 0, boxShadow: 'none', background: 'transparent' }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

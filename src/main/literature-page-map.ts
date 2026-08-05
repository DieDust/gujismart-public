/**
 * Persist continuity-resolved literature page numbers on pages.*.
 * Called after OCR (and available for manual rebuild / calibration).
 */
import {
  applyForwardLiteratureAnchor,
  extractPrintedPageFromOcrResult,
  extractPrintedPageFromPlainText,
  resolveLiteraturePageNumbers,
  type LiteraturePageSource,
} from '../shared/literature-page-numbers'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'
import { hydratePagePayloadRows } from './page-payload-store'

interface PageLabelRow {
  id: string
  page_num: number | null
  ocr_result?: string | null
  ocr_result_ref?: string | null
  literature_page_num?: number | null
  literature_page_source?: string | null
  ocr_text?: string | null
  proofed_text?: string | null
}

export interface LiteraturePageMapStats {
  updated: number
  inferred: number
  ocr: number
  fallback: number
  manual: number
}

export interface RecomputeLiteraturePageMapAsyncOptions {
  chunkSize?: number
  yieldControl?: () => Promise<void>
  onProgress?: (progress: {
    phase: 'load' | 'resolve' | 'write'
    completed: number
    total: number
  }) => void
}

const EMPTY_PAGE_MAP_STATS: LiteraturePageMapStats = {
  updated: 0,
  inferred: 0,
  ocr: 0,
  fallback: 0,
  manual: 0,
}

function isManualSource(value: unknown): boolean {
  return String(value || '').trim() === 'manual'
}

export function recomputeLiteraturePageMap(docId: string): {
  updated: number
  inferred: number
  ocr: number
  fallback: number
  manual: number
} {
  const id = String(docId || '').trim()
  if (!id) return { updated: 0, inferred: 0, ocr: 0, fallback: 0, manual: 0 }

  const rawRows = queryAll<PageLabelRow>(
    `SELECT id, page_num, ocr_result, ocr_result_ref, ocr_text, proofed_text,
            literature_page_num, literature_page_source
     FROM pages
     WHERE doc_id = ?
     ORDER BY page_num ASC`,
    [id],
  )
  if (rawRows.length === 0) return { updated: 0, inferred: 0, ocr: 0, fallback: 0, manual: 0 }

  // Ensure externalized ocr_result payloads are readable for label extraction.
  const rows = hydratePagePayloadRows(rawRows) as PageLabelRow[]

  const resolved = resolveLiteraturePageNumbers(
    rows.map((row) => {
      const physicalPageNum = Number(row.page_num || 0)
      const manualLabel = isManualSource(row.literature_page_source)
        && Number(row.literature_page_num || 0) > 0
        ? Math.floor(Number(row.literature_page_num))
        : null
      const fromResult = extractPrintedPageFromOcrResult(row.ocr_result)
      if (fromResult) {
        return { physicalPageNum, ocrLabel: fromResult, manualLabel }
      }
      // Also scan plain OCR/proof text for footer marks like "·-283-·" / "558".
      const plain = String(row.proofed_text || row.ocr_text || '')
      const fromPlain = extractPrintedPageFromPlainText(plain)
      if (fromPlain) {
        return { physicalPageNum, ocrLabel: fromPlain, manualLabel }
      }
      return { physicalPageNum, ocrLabel: null, manualLabel }
    }),
  )

  let inferred = 0
  let ocr = 0
  let fallback = 0
  let manual = 0
  const byPhysical = new Map(resolved.map((item) => [item.physicalPageNum, item]))

  transaction(() => {
    for (const row of rows) {
      const physical = Number(row.page_num || 0)
      const item = byPhysical.get(physical)
      if (!item) continue
      const source = item.source as LiteraturePageSource
      if (source === 'inferred') inferred += 1
      else if (source === 'ocr') ocr += 1
      else if (source === 'manual') manual += 1
      else fallback += 1
      run(
        `UPDATE pages
         SET literature_page_num = ?,
             literature_page_source = ?,
             ocr_page_label = ?
         WHERE id = ?`,
        [
          item.literaturePageNum,
          source,
          item.ocrLabel,
          row.id,
        ],
      )
    }
  })

  scheduleDatabaseSave({ minDelayMs: 400 })
  return { updated: rows.length, inferred, ocr, fallback, manual }
}

function getAsyncPageMapChunkSize(value: unknown): number {
  const parsed = Math.floor(Number(value) || 0)
  return Math.max(4, Math.min(64, parsed || 16))
}

async function yieldPageMapWork(
  options: RecomputeLiteraturePageMapAsyncOptions,
  phase: 'load' | 'resolve' | 'write',
  completed: number,
  total: number,
): Promise<void> {
  options.onProgress?.({ phase, completed, total })
  if (options.yieldControl) {
    await options.yieldControl()
    return
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/**
 * Large-book variant used by OCR completion. It keeps the same mapping rules while
 * yielding between payload hydration, label extraction, and small write transactions.
 */
export async function recomputeLiteraturePageMapAsync(
  docId: string,
  options: RecomputeLiteraturePageMapAsyncOptions = {},
): Promise<LiteraturePageMapStats> {
  const id = String(docId || '').trim()
  if (!id) return { ...EMPTY_PAGE_MAP_STATS }

  const rawRows = queryAll<PageLabelRow>(
    `SELECT id, page_num, ocr_result, ocr_result_ref, ocr_text, proofed_text,
            literature_page_num, literature_page_source
     FROM pages
     WHERE doc_id = ?
     ORDER BY page_num ASC`,
    [id],
  )
  if (rawRows.length === 0) return { ...EMPTY_PAGE_MAP_STATS }

  const chunkSize = getAsyncPageMapChunkSize(options.chunkSize)
  const rows: PageLabelRow[] = []
  for (let index = 0; index < rawRows.length; index += chunkSize) {
    const end = Math.min(rawRows.length, index + chunkSize)
    rows.push(...hydratePagePayloadRows(rawRows.slice(index, end)) as PageLabelRow[])
    await yieldPageMapWork(options, 'load', end, rawRows.length)
  }

  const pageInputs: Array<{
    physicalPageNum: number
    ocrLabel: ReturnType<typeof extractPrintedPageFromOcrResult>
    manualLabel: number | null
  }> = []
  for (let index = 0; index < rows.length; index += chunkSize) {
    const end = Math.min(rows.length, index + chunkSize)
    for (let rowIndex = index; rowIndex < end; rowIndex += 1) {
      const row = rows[rowIndex]
      const physicalPageNum = Number(row.page_num || 0)
      const manualLabel = isManualSource(row.literature_page_source)
        && Number(row.literature_page_num || 0) > 0
        ? Math.floor(Number(row.literature_page_num))
        : null
      const fromResult = extractPrintedPageFromOcrResult(row.ocr_result)
      const ocrLabel = fromResult || extractPrintedPageFromPlainText(String(row.proofed_text || row.ocr_text || ''))
      pageInputs.push({ physicalPageNum, ocrLabel, manualLabel })
    }
    await yieldPageMapWork(options, 'resolve', end, rows.length)
  }

  const resolved = resolveLiteraturePageNumbers(pageInputs)
  const byPhysical = new Map(resolved.map((item) => [item.physicalPageNum, item]))
  let inferred = 0
  let ocr = 0
  let fallback = 0
  let manual = 0

  for (let index = 0; index < rows.length; index += chunkSize) {
    const end = Math.min(rows.length, index + chunkSize)
    transaction(() => {
      for (let rowIndex = index; rowIndex < end; rowIndex += 1) {
        const row = rows[rowIndex]
        const physical = Number(row.page_num || 0)
        const item = byPhysical.get(physical)
        if (!item) continue
        const source = item.source as LiteraturePageSource
        if (source === 'inferred') inferred += 1
        else if (source === 'ocr') ocr += 1
        else if (source === 'manual') manual += 1
        else fallback += 1
        run(
          `UPDATE pages
           SET literature_page_num = ?,
               literature_page_source = ?,
               ocr_page_label = ?
           WHERE id = ?`,
          [item.literaturePageNum, source, item.ocrLabel, row.id],
        )
      }
    })
    await yieldPageMapWork(options, 'write', end, rows.length)
  }

  scheduleDatabaseSave({ minDelayMs: 400 })
  return { updated: rows.length, inferred, ocr, fallback, manual }
}

/**
 * Manual calibration: set literature page at physical P to L, then auto-generate
 * L+1, L+2… for all later physical pages. Earlier pages are left unchanged.
 */
export function applyManualLiteraturePageAnchor(
  docId: string,
  physicalPageNum: number,
  literaturePageNum: number,
): {
  updated: number
  anchorPhysical: number
  anchorLiterature: number
  /** Full mapping so the renderer can update UI without a second fetch. */
  pages: Array<{ id: string; page_num: number; literature_page_num: number; literature_page_source: string }>
} {
  const id = String(docId || '').trim()
  const physical = Math.floor(Number(physicalPageNum) || 0)
  const literature = Math.floor(Number(literaturePageNum) || 0)
  if (!id || physical < 1 || literature < 1) {
    return { updated: 0, anchorPhysical: physical, anchorLiterature: literature, pages: [] }
  }

  const rows = queryAll<{ id: string; page_num: number | null; literature_page_num?: number | null; literature_page_source?: string | null }>(
    `SELECT id, page_num, literature_page_num, literature_page_source
     FROM pages
     WHERE doc_id = ?
     ORDER BY page_num ASC`,
    [id],
  )
  if (rows.length === 0) {
    return { updated: 0, anchorPhysical: physical, anchorLiterature: literature, pages: [] }
  }

  const resolved = applyForwardLiteratureAnchor(
    rows.map((row) => {
      const phys = Number(row.page_num || 0)
      const existingLit = Number(row.literature_page_num || 0)
      return {
        physicalPageNum: phys,
        literaturePageNum: existingLit > 0 ? existingLit : phys,
        source: (isManualSource(row.literature_page_source) ? 'manual' : 'fallback') as LiteraturePageSource,
      }
    }),
    physical,
    literature,
  )
  const byPhysical = new Map(resolved.map((item) => [item.physicalPageNum, item]))
  let updated = 0
  const pages: Array<{ id: string; page_num: number; literature_page_num: number; literature_page_source: string }> = []

  transaction(() => {
    for (const row of rows) {
      const phys = Number(row.page_num || 0)
      const item = byPhysical.get(phys)
      if (!item) continue
      run(
        `UPDATE pages
         SET literature_page_num = ?,
             literature_page_source = ?
         WHERE id = ?`,
        [item.literaturePageNum, item.source, row.id],
      )
      updated += 1
      pages.push({
        id: row.id,
        page_num: phys,
        literature_page_num: item.literaturePageNum,
        literature_page_source: item.source,
      })
    }
  })

  scheduleDatabaseSave({ minDelayMs: 200 })
  return { updated, anchorPhysical: physical, anchorLiterature: literature, pages }
}

/**
 * Clear all manual/auto literature labels and re-detect from OCR + continuity.
 * Use when the user mis-calibrated and wants to restore automatic numbering.
 */
export function resetLiteraturePageMap(docId: string): {
  updated: number
  inferred: number
  ocr: number
  fallback: number
  manual: number
  pages: Array<{ id: string; page_num: number; literature_page_num: number; literature_page_source: string }>
} {
  const id = String(docId || '').trim()
  if (!id) {
    return { updated: 0, inferred: 0, ocr: 0, fallback: 0, manual: 0, pages: [] }
  }

  // Drop every stored label (including manual anchors) so recompute starts clean.
  transaction(() => {
    run(
      `UPDATE pages
       SET literature_page_num = NULL,
           literature_page_source = NULL,
           ocr_page_label = NULL
       WHERE doc_id = ?`,
      [id],
    )
  })

  const stats = recomputeLiteraturePageMap(id)
  const pages = queryAll<{ id: string; page_num: number | null; literature_page_num?: number | null; literature_page_source?: string | null }>(
    `SELECT id, page_num, literature_page_num, literature_page_source
     FROM pages
     WHERE doc_id = ?
     ORDER BY page_num ASC`,
    [id],
  ).map((row) => {
    const phys = Number(row.page_num || 0)
    const lit = Number(row.literature_page_num || 0)
    return {
      id: row.id,
      page_num: phys,
      literature_page_num: lit > 0 ? lit : phys,
      literature_page_source: String(row.literature_page_source || 'fallback'),
    }
  })

  return { ...stats, pages }
}

export function getLiteraturePageNumForPhysical(docId: string, physicalPageNum: number): number | null {
  const row = queryOne<{ literature_page_num?: number | null }>(
    `SELECT literature_page_num FROM pages WHERE doc_id = ? AND page_num = ? LIMIT 1`,
    [String(docId || '').trim(), Number(physicalPageNum) || 0],
  )
  const value = Number(row?.literature_page_num || 0)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Prefer stored literature page; fall back to physical. */
export function resolveDisplayPageNum(
  page: { page_num?: number | null; literature_page_num?: number | null } | null | undefined,
): number {
  const literature = Number(page?.literature_page_num || 0)
  if (Number.isFinite(literature) && literature > 0) return Math.floor(literature)
  const physical = Number(page?.page_num || 0)
  return Number.isFinite(physical) && physical > 0 ? Math.floor(physical) : 0
}

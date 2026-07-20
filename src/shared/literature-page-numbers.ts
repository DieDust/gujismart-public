/**
 * Literature (printed) page numbers vs physical PDF page indices.
 *
 * Books are treated as mostly continuous: physical page i+1 usually carries
 * printed page N+1. OCR may miss or garble a few labels (e.g. 01 / 10 instead of 101).
 * When OCR conflicts with the continuity implied by neighbours, continuity wins.
 */

export type LiteraturePageSource = 'ocr' | 'inferred' | 'fallback' | 'manual'

export interface LiteraturePageInput {
  /** 1-based physical page index in the app (pages.page_num). */
  physicalPageNum: number
  /** OCR-detected printed page label, if any. */
  ocrLabel: number | null
  /**
   * User-set literature page at this physical sheet (hard anchor).
   * Survives OCR recompute and never loses to continuity overrides.
   */
  manualLabel?: number | null
}

export interface LiteraturePageOutput {
  physicalPageNum: number
  literaturePageNum: number
  ocrLabel: number | null
  source: LiteraturePageSource
}

function isPositiveInt(value: unknown): value is number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && Math.floor(n) === n
}

/** Reject issue/volume numbers mistaken as page marks (e.g. 「第6期」). */
function looksLikeNonPageContext(raw: string): boolean {
  const text = String(raw || '').normalize('NFKC')
  // 期/卷/年 as primary unit — not a page number.
  if (/(?:第)?\s*\d{1,4}\s*期/.test(text) && !/页|頁/.test(text)) return true
  if (/(?:第)?\s*\d{1,4}\s*卷/.test(text) && !/页|頁/.test(text)) return true
  if (/\d{4}\s*年/.test(text) && !/页|頁/.test(text)) return true
  if (/ISSN|CN\s*\d|DOI|http/i.test(text)) return true
  return false
}

/** Parse a short printed page label such as "558", "第558页", "p.12", "- 12 -", "·-283-·". */
export function parsePrintedPageLabel(value: string): number | null {
  const raw = String(value || '')
  if (!raw.trim() || looksLikeNonPageContext(raw)) return null
  const text = raw
    .normalize('NFKC')
    .replace(/[［【\[(（〔〈《「『]/g, '')
    .replace(/[］】\])）〕〉》」』]/g, '')
    // Strip common decorative page-mark wrappers: —12— ·12· ·-283-· - 12 -
    .replace(/^[·•●○◆◇※*__\-–—=~．.。、|/／\\]+/g, '')
    .replace(/[·•●○◆◇※*_\-–—=~．.。、|/／\\]+$/g, '')
    .replace(/\s+/g, '')
    .trim()
  if (!text) return null
  // After stripping, allow a single remaining wrapper pair around digits (·-283-· → 283).
  const unwrapped = text
    .replace(/^[·•\-–—._=]+/, '')
    .replace(/[·•\-–—._=]+$/, '')
  const body = unwrapped || text
  const direct = body.match(/^(?:第)?([0-9]{1,5})(?:页|頁|面)?$/)
  if (direct) {
    const pageNum = Number(direct[1])
    return isPositiveInt(pageNum) ? pageNum : null
  }
  const labeled = body.match(/(?:页码|頁碼|页号|頁號|page|p\.?)(?:[:：])?([0-9]{1,5})/i)
  if (labeled) {
    const pageNum = Number(labeled[1])
    return isPositiveInt(pageNum) ? pageNum : null
  }
  // Last resort: pure decorative short mark "·-283-·" still holding one integer.
  if (body.length <= 8) {
    const lone = body.match(/^([0-9]{1,5})$/)
    if (lone) {
      const pageNum = Number(lone[1])
      return isPositiveInt(pageNum) ? pageNum : null
    }
  }
  return null
}

function readBlockText(row: Record<string, unknown>): string {
  const candidates = [
    row.text,
    row.words,
    row.word,
    row.content,
    row.block_content,
    row.raw_words,
    row.raw_text,
    row.transcription,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
    if (Array.isArray(candidate)) {
      const joined = candidate
        .map((item) => {
          if (typeof item === 'string' || typeof item === 'number') return String(item)
          const rec = asRecord(item)
          if (!rec) return ''
          return String(rec.text || rec.words || rec.word || rec.content || '')
        })
        .join('')
        .trim()
      if (joined) return joined
    }
  }
  return ''
}

function blockSortKeyForPageMark(row: Record<string, unknown>): number {
  // Prefer lower on the page (footer). Location may be percent or pixel coords.
  const location = asRecord(row.location) || asRecord(row.rect) || asRecord(row.bbox)
  const top = Number(location?.top ?? location?.y ?? row.top ?? row.y ?? 0)
  return Number.isFinite(top) ? top : 0
}

function isPageNumberLabel(label: string): boolean {
  const normalized = String(label || '').trim().toLowerCase().replace(/[_-]+/g, ' ')
  return /^(?:page\s*number|page\s*no|pageno|page\s*num|number|page)$/i.test(normalized)
    || /页码|頁碼|页号|頁號/.test(normalized)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readPath(record: Record<string, unknown> | null, path: string[]): unknown {
  let current: unknown = record
  for (const key of path) {
    const row = asRecord(current)
    if (!row) return undefined
    current = row[key]
  }
  return current
}

/**
 * Best-effort extract of the printed page number from a stored ocr_result JSON blob.
 * Handles CNKI/journal footers like "·-283-·" labeled as page_number.
 */
export function extractPrintedPageFromOcrResult(ocrResult: unknown): number | null {
  if (ocrResult == null || ocrResult === '') return null
  let parsed: unknown = ocrResult
  if (typeof ocrResult === 'string') {
    try {
      parsed = JSON.parse(ocrResult)
    } catch {
      return parsePrintedPageLabel(ocrResult)
    }
  }
  const root = asRecord(parsed)
  if (!root) return null

  const directCandidates = [
    root.page_number,
    root.pageNumber,
    root.original_page_number,
    root.originalPageNumber,
    readPath(root, ['page', 'number']),
    readPath(root, ['page', 'page_number']),
  ]
  for (const candidate of directCandidates) {
    if (isPositiveInt(candidate)) return Math.floor(Number(candidate))
    const parsedLabel = parsePrintedPageLabel(String(candidate ?? ''))
    if (parsedLabel) return parsedLabel
  }

  const blockLists = [
    root.layout_aware_blocks,
    root.layoutAwareBlocks,
    root.layout_result,
    root.layoutResult,
    root.blocks,
    root.regions,
    root.paragraphs,
    root.lines,
    root.words_result,
    root.wordsResult,
    root.parsing_res_list,
    root.parsingResList,
  ]

  type Ranked = { pageNum: number; score: number }
  const ranked: Ranked[] = []

  for (const list of blockLists) {
    if (!Array.isArray(list)) continue
    for (const block of list) {
      const row = asRecord(block)
      if (!row) continue
      const label = String(row.label || row.type || row.category || row.block_type || row.class || '')
      const text = readBlockText(row)
      if (!text || text.length > 24) continue
      if (looksLikeNonPageContext(text)) continue
      const pageNum = parsePrintedPageLabel(text)
      if (!pageNum) continue
      let score = 1
      if (isPageNumberLabel(label) || /page[_\s-]*number|页码|页号/i.test(label)) score += 10
      if (/footer|header|页脚|页眉|^number$/i.test(label)) score += 6
      // Prefer marks lower on the page (journal footers).
      const top = blockSortKeyForPageMark(row)
      if (top >= 70) score += 3
      else if (top >= 50) score += 1
      // Prefer multi-digit journal-style pages over tiny false positives (期号 etc.).
      if (pageNum >= 10) score += 2
      if (pageNum >= 100) score += 2
      ranked.push({ pageNum, score })
    }
  }

  if (ranked.length > 0) {
    ranked.sort((a, b) => b.score - a.score || b.pageNum - a.pageNum)
    return ranked[0].pageNum
  }

  // Fallback: short standalone numeric lines often used as printed page marks (e.g. bottom "·-283-·").
  const plainText = String(root.text || root.ocr_text || root.full_text || root.raw_text || '')
  if (plainText) {
    const lines = plainText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const candidates = [
      ...lines.slice(-6),
      ...lines.slice(0, 3),
    ]
    for (const line of candidates) {
      if (line.length > 16) continue
      if (looksLikeNonPageContext(line)) continue
      const pageNum = parsePrintedPageLabel(line)
      if (pageNum) return pageNum
    }
  }
  return null
}

/** Scan plain OCR/proof text for a printed page mark (footer-style). */
export function extractPrintedPageFromPlainText(plainText: string): number | null {
  const lines = String(plainText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return null
  const candidates = [...lines.slice(-8), ...lines.slice(0, 4)]
  for (const line of candidates) {
    if (line.length > 18) continue
    if (looksLikeNonPageContext(line)) continue
    const pageNum = parsePrintedPageLabel(line)
    if (pageNum) return pageNum
  }
  // Whole-line decorative patterns even if slightly longer.
  for (const line of candidates) {
    if (looksLikeNonPageContext(line)) continue
    const match = line.normalize('NFKC').match(/^[·•\s\-–—._=]*([0-9]{2,5})[·•\s\-–—._=]*$/)
    if (match) {
      const pageNum = Number(match[1])
      if (isPositiveInt(pageNum)) return pageNum
    }
  }
  return null
}

/**
 * Whether OCR printed-page labels are dense enough to trust continuity inference.
 * If a book generally has no page numbers (sparse / noisy anchors), callers must
 * fall back to physical 1..N instead of inventing literature pages from a few hits.
 */
export function hasReliableLiteraturePageAnchors(
  inputs: Array<Pick<LiteraturePageInput, 'ocrLabel' | 'physicalPageNum' | 'manualLabel'>>,
): boolean {
  const n = inputs.length
  if (n <= 0) return false
  let anchorCount = 0
  const offsetVotes: number[] = []
  const strongOffsetVotes: number[] = [] // multi-digit journal footers (≥10, and label ≠ physical)
  for (const item of inputs) {
    const label = isPositiveInt(item.manualLabel)
      ? Math.floor(Number(item.manualLabel))
      : (isPositiveInt(item.ocrLabel) ? Math.floor(Number(item.ocrLabel)) : null)
    if (label == null) continue
    anchorCount += 1
    const physical = Number(item.physicalPageNum || 0)
    if (!isPositiveInt(physical)) continue
    const offset = label - physical
    if (label >= 20) offsetVotes.push(offset)
    // CNKI-style: print page is far from PDF sheet index (e.g. phys 1 → 63).
    if (label >= 10 && Math.abs(offset) >= 2) strongOffsetVotes.push(offset)
  }
  if (anchorCount === 0) return false
  // Journal-style PDFs (CNKI etc.): multi-digit footers with a consistent offset
  // (e.g. physical 1 → 63, physical 2 → 64) — even a single strong footer is enough
  // for article-length PDFs (≤120 sheets), because sheet index is not the print page.
  if (strongOffsetVotes.length >= 1 && n <= 120) {
    const sorted = [...strongOffsetVotes].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const consistent = strongOffsetVotes.filter((vote) => Math.abs(vote - median) <= 1)
    if (consistent.length >= 1 && (strongOffsetVotes.length === 1 || consistent.length >= Math.ceil(strongOffsetVotes.length * 0.5))) {
      return true
    }
  }
  if (offsetVotes.length >= 2) {
    const sorted = [...offsetVotes].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const consistent = offsetVotes.filter((vote) => Math.abs(vote - median) <= 1)
    if (consistent.length >= 2) return true
  }
  // Tiny docs: need at least 2 independent labels.
  if (n < 10) return anchorCount >= 2
  // Medium/large docs: require both a floor and a coverage share so TOC/list
  // false positives (a few "1"/"7" marks) cannot remap the whole book.
  const minAbsolute = Math.max(3, Math.min(12, Math.ceil(n * 0.04)))
  const minCoverage = n >= 40 ? 0.06 : 0.1
  return anchorCount >= minAbsolute && anchorCount / n >= minCoverage
}

/**
 * Resolve continuous literature page numbers for an ordered physical page list.
 *
 * Rules (user requirement):
 * - Pagination is treated as continuous (+1 per physical page in body runs).
 * - If left=100 and right=102, middle must be 101 even if OCR says 01/10/garbage.
 * - When OCR conflicts with neighbour-derived continuity, continuity wins.
 * - Sparse anchors also vote a global offset (literature ≈ physical + offset),
 *   so a late reliable label like physical 577 → 558 can back-fill the whole body.
 * - Missing labels are filled by forward/backward +1 chains from anchors.
 * - If printed page numbers are generally missing (sparse anchors), fall back to
 *   physical page_num 1, 2, 3, 4… for the whole document.
 */
export function resolveLiteraturePageNumbers(inputs: LiteraturePageInput[]): LiteraturePageOutput[] {
  const pages = [...inputs]
    .filter((item) => isPositiveInt(item.physicalPageNum))
    .sort((a, b) => a.physicalPageNum - b.physicalPageNum)
  const n = pages.length
  if (n === 0) return []

  const ocr: Array<number | null> = pages.map((page) => (
    isPositiveInt(page.ocrLabel) ? Math.floor(Number(page.ocrLabel)) : null
  ))
  const manual: Array<number | null> = pages.map((page) => (
    isPositiveInt(page.manualLabel) ? Math.floor(Number(page.manualLabel)) : null
  ))
  const reapplyManual = (lit: Array<number | null>, source: LiteraturePageSource[]) => {
    for (let i = 0; i < n; i += 1) {
      if (manual[i] == null) continue
      lit[i] = manual[i]
      source[i] = 'manual'
    }
  }
  const hasManual = manual.some((value) => value != null)

  // Generally no page numbers → physical 1..N, but keep user manuals and forward-fill from them.
  if (!hasReliableLiteraturePageAnchors(pages.map((page, index) => ({
    physicalPageNum: page.physicalPageNum,
    ocrLabel: ocr[index],
    manualLabel: manual[index],
  })))) {
    const lit: Array<number | null> = pages.map((page, index) => (
      manual[index] != null ? manual[index] : null
    ))
    const source: LiteraturePageSource[] = pages.map((_, index) => (manual[index] != null ? 'manual' : 'fallback'))
    // Forward-fill from each manual (+1 per physical sheet).
    for (let i = 1; i < n; i += 1) {
      if (lit[i] != null) continue
      if (lit[i - 1] != null) {
        lit[i] = (lit[i - 1] as number) + 1
        source[i] = 'inferred'
      }
    }
    for (let i = 0; i < n; i += 1) {
      if (lit[i] == null) {
        lit[i] = pages[i].physicalPageNum
        source[i] = 'fallback'
      }
    }
    reapplyManual(lit, source)
    return pages.map((page, index) => ({
      physicalPageNum: page.physicalPageNum,
      literaturePageNum: lit[index] as number,
      ocrLabel: ocr[index],
      source: source[index],
    }))
  }

  const lit: Array<number | null> = ocr.slice()
  const source: LiteraturePageSource[] = ocr.map((value) => (value == null ? 'fallback' : 'ocr'))
  reapplyManual(lit, source)

  // Pass 0: global offset from OCR anchors (literature = physical + offset).
  // Outlier anchors that disagree with the median offset are ignored.
  const offsetVotes: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (ocr[i] == null && manual[i] == null) continue
    const label = (manual[i] ?? ocr[i]) as number
    offsetVotes.push(label - pages[i].physicalPageNum)
  }
  let globalOffset: number | null = null
  if (offsetVotes.length > 0) {
    const sortedVotes = [...offsetVotes].sort((a, b) => a - b)
    const median = sortedVotes[Math.floor(sortedVotes.length / 2)]
    const consistent = offsetVotes.filter((vote) => Math.abs(vote - median) <= 1)
    if (consistent.length >= Math.max(2, Math.ceil(offsetVotes.length * 0.5))) {
      globalOffset = median
    }
  }
  if (globalOffset != null) {
    for (let i = 0; i < n; i += 1) {
      if (manual[i] != null) continue
      const expected = pages[i].physicalPageNum + globalOffset
      if (expected < 1) {
        // Front matter before printed page 1: keep OCR if sensible, else leave for later fill/fallback.
        if (ocr[i] != null && (ocr[i] as number) >= 1) {
          lit[i] = ocr[i]
          source[i] = 'ocr'
        }
        continue
      }
      if (ocr[i] == null || Math.abs((ocr[i] as number) - expected) > 0) {
        // Prefer continuity; OCR only wins if it matches expected.
        lit[i] = expected
        source[i] = ocr[i] === expected ? 'ocr' : 'inferred'
      } else {
        lit[i] = ocr[i]
        source[i] = 'ocr'
      }
    }
    reapplyManual(lit, source)
  }

  // Pass 1: for every OCR/manual anchor pair with exact continuous spacing, force the whole span.
  const anchors: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (ocr[i] != null || manual[i] != null) anchors.push(i)
  }
  for (let a = 0; a < anchors.length; a += 1) {
    for (let b = a + 1; b < anchors.length; b += 1) {
      const i = anchors[a]
      const j = anchors[b]
      const dPhys = j - i
      const left = manual[i] ?? ocr[i]
      const right = manual[j] ?? ocr[j]
      if (left == null || right == null || dPhys <= 0) continue
      const dLab = right - left
      // Continuous body: literature advances exactly one per physical page between anchors.
      if (dLab === dPhys) {
        for (let k = i; k <= j; k += 1) {
          if (manual[k] != null) continue
          const expected = left + (k - i)
          if (lit[k] !== expected) {
            lit[k] = expected
            source[k] = ocr[k] === expected ? 'ocr' : 'inferred'
          } else if (ocr[k] === expected) {
            source[k] = 'ocr'
          }
        }
      }
    }
  }
  reapplyManual(lit, source)

  // Pass 2: local triples — prev and next known with gap 2 => middle must be prev+1.
  for (let i = 1; i < n - 1; i += 1) {
    if (manual[i] != null) continue
    const left = lit[i - 1]
    const right = lit[i + 1]
    if (left == null || right == null) continue
    if (right === left + 2) {
      const expected = left + 1
      if (lit[i] !== expected) {
        lit[i] = expected
        source[i] = ocr[i] === expected ? 'ocr' : 'inferred'
      }
    }
  }

  // Pass 3: consecutive conflict — immediate neighbour should be +1 unless next continues a deliberate jump.
  for (let i = 1; i < n; i += 1) {
    if (manual[i] != null) continue
    const prev = lit[i - 1]
    const cur = lit[i]
    if (prev == null || cur == null) continue
    if (cur === prev + 1) continue
    const next = i + 1 < n ? lit[i + 1] : null
    const expected = prev + 1
    const nextSupportsCurrent = next != null && next === cur + 1
    const nextSupportsExpected = next != null && next === expected + 1
    const looksGarble = cur <= prev
      || cur > prev + 8
      || (String(cur).length < String(prev).length && cur < 100 && prev >= 100)
    if (nextSupportsExpected || (looksGarble && !nextSupportsCurrent)) {
      lit[i] = expected
      source[i] = ocr[i] === expected ? 'ocr' : 'inferred'
    }
  }

  // Pass 4: fill null forward (+1).
  for (let i = 1; i < n; i += 1) {
    if (lit[i] == null && lit[i - 1] != null) {
      lit[i] = (lit[i - 1] as number) + 1
      source[i] = 'inferred'
    }
  }

  // Pass 5: fill null backward (-1), stop before inventing pages < 1.
  for (let i = n - 2; i >= 0; i -= 1) {
    if (lit[i] == null && lit[i + 1] != null) {
      const expected = (lit[i + 1] as number) - 1
      if (expected >= 1) {
        lit[i] = expected
        source[i] = 'inferred'
      }
    }
  }

  // Pass 6: absolute fallback to physical index.
  for (let i = 0; i < n; i += 1) {
    if (lit[i] == null) {
      lit[i] = pages[i].physicalPageNum
      source[i] = 'fallback'
    } else if (source[i] === 'fallback' && ocr[i] === lit[i]) {
      source[i] = 'ocr'
    }
  }
  reapplyManual(lit, source)

  // When user manuals exist, forward-fill between / after manuals so discontinuous
  // plates (e.g. unnumbered illustrations) can be fixed by a single anchor click.
  if (hasManual) {
    for (let i = 1; i < n; i += 1) {
      if (manual[i] != null) continue
      // Only rewrite inferred/fallback after a manual or inferred chain.
      if (source[i - 1] === 'manual' || source[i - 1] === 'inferred') {
        const expected = (lit[i - 1] as number) + 1
        if (lit[i] !== expected && source[i] !== 'manual') {
          lit[i] = expected
          source[i] = 'inferred'
        }
      }
    }
    reapplyManual(lit, source)
  }

  return pages.map((page, index) => ({
    physicalPageNum: page.physicalPageNum,
    literaturePageNum: lit[index] as number,
    ocrLabel: ocr[index],
    source: source[index],
  }))
}

/**
 * From physical page P set literature = L, then pages after P become L+1, L+2, …
 * Pages before P are left unchanged. The anchor page is marked source=manual.
 */
export function applyForwardLiteratureAnchor(
  pages: Array<{ physicalPageNum: number; literaturePageNum: number; source?: LiteraturePageSource }>,
  anchorPhysical: number,
  anchorLiterature: number,
): Array<{ physicalPageNum: number; literaturePageNum: number; source: LiteraturePageSource }> {
  const physical = Math.floor(Number(anchorPhysical) || 0)
  const literature = Math.floor(Number(anchorLiterature) || 0)
  if (!isPositiveInt(physical) || !isPositiveInt(literature)) {
    return pages.map((page) => ({
      physicalPageNum: page.physicalPageNum,
      literaturePageNum: page.literaturePageNum,
      source: (page.source || 'fallback') as LiteraturePageSource,
    }))
  }
  return [...pages]
    .sort((a, b) => a.physicalPageNum - b.physicalPageNum)
    .map((page) => {
      if (page.physicalPageNum < physical) {
        return {
          physicalPageNum: page.physicalPageNum,
          literaturePageNum: page.literaturePageNum,
          source: (page.source || 'fallback') as LiteraturePageSource,
        }
      }
      const nextLit = literature + (page.physicalPageNum - physical)
      return {
        physicalPageNum: page.physicalPageNum,
        literaturePageNum: nextLit,
        source: page.physicalPageNum === physical ? 'manual' : 'inferred',
      }
    })
}

/** Prefer resolved literature page, then OCR label, then physical. */
export function pickDisplayPageNumber(input: {
  literaturePageNum?: number | null
  ocrLabel?: number | null
  physicalPageNum?: number | null
}): number | null {
  if (isPositiveInt(input.literaturePageNum)) return Math.floor(Number(input.literaturePageNum))
  if (isPositiveInt(input.ocrLabel)) return Math.floor(Number(input.ocrLabel))
  if (isPositiveInt(input.physicalPageNum)) return Math.floor(Number(input.physicalPageNum))
  return null
}

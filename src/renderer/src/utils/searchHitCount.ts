import OpenCC from 'opencc-js'
import type { DocumentPage, SearchHit, SearchHitLocator } from '@shared/types'
import { getReadablePageElements, type ReadablePageElement } from './ocrText'

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })

type ViewerSearchPage = Partial<Pick<DocumentPage, 'id' | 'doc_id' | 'page_num' | 'ocr_text' | 'ocr_result' | 'proofed_text'>>

interface OcrTextBox {
  words?: unknown
  word?: unknown
  text?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (isRecord(value)) return value
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function uniqueSearchTerms(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const tokens = trimmed
    .split(/[\s,\uFF0C\u3002\uFF1B;\u3001/\\()[\]{}"'\u201C\u201D\u2018\u2019<>\u300A\u300B]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return Array.from(new Set([trimmed, ...tokens])).sort((left, right) => right.length - left.length)
}

export function findSearchOccurrences(text: string, query: string): Array<{ charIndex: number; keyword: string }> {
  const value = String(text || '')
  const lowerText = value.toLowerCase()
  const terms = uniqueSearchTerms(query)
  if (!lowerText || terms.length === 0) return []

  const collect = (term: string) => {
    const lowerTerm = term.toLowerCase()
    const hits: Array<{ charIndex: number; keyword: string }> = []
    if (!lowerTerm) return hits
    let index = lowerText.indexOf(lowerTerm)
    while (index >= 0) {
      hits.push({ charIndex: index, keyword: value.slice(index, index + term.length) || term })
      index = lowerText.indexOf(lowerTerm, index + Math.max(1, lowerTerm.length))
    }
    return hits
  }

  const exactHits = collect(terms[0])
  if (exactHits.length > 0) return exactHits

  return terms
    .slice(1)
    .flatMap(collect)
    .sort((left, right) => left.charIndex - right.charIndex || right.keyword.length - left.keyword.length)
}

function getBoxText(box: OcrTextBox): string {
  return String(box?.words || box?.word || box?.text || '')
}

function getLayoutBoxes(page: ViewerSearchPage): OcrTextBox[] {
  const parsed = parseJsonObject(page?.ocr_result)
  const boxes = parsed?.layout_result || parsed?.words_result || []
  return Array.isArray(boxes) ? boxes.filter(isRecord) : []
}

function countProofLayoutPageHits(page: ViewerSearchPage, keyword: string): number {
  const text = String(page?.proofed_text || page?.ocr_text || '')
  const pageHits = findSearchOccurrences(text, keyword)
  if (pageHits.length === 0) return 0

  const boxes = getLayoutBoxes(page)
  if (boxes.length === 0) return pageHits.length

  const boxHitCount = boxes.reduce((sum, box) => (
    sum + findSearchOccurrences(getBoxText(box), keyword).length
  ), 0)
  return boxHitCount || pageHits.length
}

function normalizeReaderSearchText(value: string): string {
  return toSimplified(String(value || '')).toLocaleLowerCase()
}

function getReaderSearchOffsets(text: string, keyword: string): number[] {
  const source = normalizeReaderSearchText(text)
  const query = normalizeReaderSearchText(keyword.trim())
  if (!source || !query) return []

  const offsets: number[] = []
  let cursor = 0
  while (cursor <= source.length) {
    const next = source.indexOf(query, cursor)
    if (next < 0) break
    offsets.push(next)
    cursor = next + Math.max(1, query.length)
    if (offsets.length >= 20000) break
  }
  return offsets
}

function getReaderElementSearchText(element: ReadablePageElement): string {
  return element.type === 'table' && element.rows?.length ? element.rows.flat().join('\n') : element.text
}

export function buildViewerSearchHits(pages: ViewerSearchPage[], keyword: string, docId = ''): SearchHit[] {
  const query = String(keyword || '').trim()
  if (!query || !Array.isArray(pages) || pages.length === 0) return []
  const hits: SearchHit[] = []

  ;[...pages]
    .sort((left, right) => Number(left.page_num || 0) - Number(right.page_num || 0))
    .forEach((page, pageIndex) => {
      const pageId = String(page?.id || '')
      let pageOccurrenceIndex = 0
      getReadablePageElements(page).forEach((element, elementIndex) => {
        const text = getReaderElementSearchText(element)
        getReaderSearchOffsets(text, query).forEach((offset) => {
          const matchText = String(text || '').slice(offset, offset + query.length) || query
          const charStart = Number(element.charStart || 0) + offset
          const locator: SearchHitLocator = {
            docId: docId || String(page?.doc_id || ''),
            segmentId: `${docId || page?.doc_id || 'doc'}:${pageId || pageIndex}:${elementIndex}`,
            pageId: pageId || null,
            pageNum: Number(page?.page_num || pageIndex + 1),
            pageIndex,
            href: null,
            segmentOrdinal: pageIndex,
            charStart,
            charEnd: charStart + matchText.length,
            matchText,
            queryTerm: query,
            occurrenceIndex: pageOccurrenceIndex,
          }
          const snippetStart = Math.max(0, offset - 48)
          const snippetEnd = Math.min(String(text || '').length, offset + query.length + 72)
          const snippet = `${snippetStart > 0 ? '...' : ''}${String(text || '').slice(snippetStart, snippetEnd)}${snippetEnd < String(text || '').length ? '...' : ''}`
          hits.push({
            id: `${locator.segmentId}:${pageOccurrenceIndex}:${hits.length}`,
            locator,
            snippet,
            score: Math.max(1, 100000 - hits.length),
          })
          pageOccurrenceIndex += 1
        })
      })
    })

  return hits
}

export function countViewerSearchHits(pages: ViewerSearchPage[], keyword: string): number {
  const query = String(keyword || '').trim()
  if (!query || !Array.isArray(pages) || pages.length === 0) return 0
  return buildViewerSearchHits(pages, query).length
}

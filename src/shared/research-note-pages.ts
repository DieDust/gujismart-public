import type { ResearchNote } from './types'

type NotePageSource = Pick<ResearchNote, 'doc_id' | 'page_num' | 'source_id'> & { locator_json?: string | null }

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return record(JSON.parse(value)) } catch { return {} }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function page(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

export function getResearchNotePageSource(note: NotePageSource): { sourcePageId?: string; sourcePageNum?: number } {
  const source = record(note.source_id)
  const outer = record(note.locator_json)
  const candidates = [record(outer.locator), outer, record(source.locator), source]
  let sourcePageId: string | undefined
  let sourcePageNum: number | undefined
  for (const locator of candidates) {
    const docId = locator.documentId || locator.docId || locator.doc_id
    if (docId && docId !== note.doc_id) continue
    const id = locator.sourcePageId || locator.pageId || locator.page_id
    if (!sourcePageId && typeof id === 'string' && id.trim()) sourcePageId = id.trim()
    sourcePageNum ??= page(locator.internalPageNum) ?? page(locator.sourcePageNum)
      ?? page(locator.pageNum) ?? page(locator.page_num)
      ?? (Number.isSafeInteger(locator.pageIndex) && Number(locator.pageIndex) >= 0 ? Number(locator.pageIndex) + 1 : undefined)
  }
  // note.page_num is a citation label, not a physical locator.
  return { sourcePageId, sourcePageNum }
}

export function getResearchNoteCitationPage(note: NotePageSource): number | null {
  const source = record(note.source_id)
  return page(source.citationPageNum) ?? page(source.originalPageNum) ?? page(source.displayPageNum)
    ?? page(note.page_num) ?? page(source.sourcePageNum) ?? null
}

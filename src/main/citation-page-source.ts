import type { CitationGenerateOptions } from '../shared/types'
import { queryOne } from './database'

interface SourcePage { page_num: number; literature_page_num: number | null }

export function findCitationSourcePage(docId: string, source: Pick<CitationGenerateOptions, 'sourcePageId' | 'sourcePageNum'>): SourcePage | null {
  // A missing stable ID must not silently retarget a different page at the old ordinal.
  if (source.sourcePageId) return queryOne<SourcePage>(
    'SELECT page_num, literature_page_num FROM pages WHERE doc_id = ? AND id = ?', [docId, source.sourcePageId],
  )
  if (!Number.isSafeInteger(source.sourcePageNum) || Number(source.sourcePageNum) <= 0) return null
  return queryOne<SourcePage>(
    'SELECT page_num, literature_page_num FROM pages WHERE doc_id = ? AND page_num = ?', [docId, source.sourcePageNum],
  )
}

export function resolveCitationPageOptions(docId: string, options?: CitationGenerateOptions): CitationGenerateOptions | undefined {
  if (!options?.sourcePageId && !options?.sourcePageNum) return options
  const page = findCitationSourcePage(docId, options)
  return page ? { ...options, pageNum: Number(page.literature_page_num) > 0 ? page.literature_page_num : page.page_num } : options
}

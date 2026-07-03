export interface ResearchLocatorDefaults {
  docId?: string | null
  pageNum?: number | string | null
  sourceType?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePageNum(value: ResearchLocatorDefaults['pageNum']): number | null {
  if (value === null || value === undefined || value === '') return null
  const pageNum = Number(value)
  return Number.isFinite(pageNum) && pageNum > 0 ? pageNum : null
}

export function normalizeResearchLocator(locator: Record<string, unknown>, defaults: ResearchLocatorDefaults): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...locator }
  const docId = String(defaults.docId || '').trim()
  const pageNum = normalizePageNum(defaults.pageNum)
  const sourceType = String(defaults.sourceType || '').trim()
  if (docId && !normalized.docId && !normalized.doc_id) normalized.docId = docId
  if (pageNum !== null && normalized.pageNum === undefined && normalized.page_num === undefined) normalized.pageNum = pageNum
  if (sourceType && !normalized.sourceType && !normalized.source_type) normalized.sourceType = sourceType
  return normalized
}

export function stringifyResearchLocator(value: unknown, defaults: ResearchLocatorDefaults): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return isRecord(parsed) ? JSON.stringify(normalizeResearchLocator(parsed, defaults)) : trimmed
    } catch {
      return trimmed
    }
  }

  if (!isRecord(value)) return ''
  return JSON.stringify(normalizeResearchLocator(value, defaults))
}

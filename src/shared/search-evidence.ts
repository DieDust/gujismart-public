export function buildSearchExcerptSourceHashInput(payload: {
  docId?: string | null
  pageNum?: string | number | null
  excerpt?: string | null
}): string {
  const docId = String(payload.docId || '').trim()
  const pageNum = payload.pageNum === null || payload.pageNum === undefined ? '' : String(payload.pageNum)
  const excerpt = String(payload.excerpt || '')
  return `${docId}:${pageNum}:${excerpt}`
}

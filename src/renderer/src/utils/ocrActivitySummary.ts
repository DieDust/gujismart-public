type OcrActivityItem = {
  docId?: string
  status?: string
  aiStatus?: string
  title?: string
}

export function buildOcrActivitySummary(items: OcrActivityItem[]): string | null {
  const activeItems = items.filter((item) => item.status === 'processing' || item.aiStatus === 'processing')
  const activeCount = activeItems.length
  const queuedCount = items.filter((item) => item.status === 'queued').length
  if (activeCount === 0 && queuedCount === 0) return null
  const base = queuedCount === 0
    ? `OCR：${activeCount} 篇处理中`
    : `OCR：${activeCount} 篇处理中，${queuedCount} 篇等待`
  const activeTitles = [...new Set(activeItems
    .map((item) => String(item.title || '').trim())
    .filter(Boolean))]
  if (activeTitles.length === 0) return base
  const visibleTitles = activeTitles.slice(0, 2).map((title) => `《${title.slice(0, 40)}》`).join('、')
  const remainder = activeTitles.length > 2 ? `等 ${activeTitles.length} 篇` : ''
  return `${base} · 正在处理 ${visibleTitles}${remainder}`
}

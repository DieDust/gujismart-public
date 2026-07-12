type OcrActivityItem = {
  status?: string
  aiStatus?: string
}

export function buildOcrActivitySummary(items: OcrActivityItem[]): string | null {
  const activeCount = items.filter((item) => item.status === 'processing' || item.aiStatus === 'processing').length
  const queuedCount = items.filter((item) => item.status === 'queued').length
  if (activeCount === 0 && queuedCount === 0) return null
  if (queuedCount === 0) return `OCR：${activeCount} 篇处理中`
  return `OCR：${activeCount} 篇处理中，${queuedCount} 篇等待`
}

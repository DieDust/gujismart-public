import type { DocumentPage } from '@shared/types'

function hasStoredPageText(page: DocumentPage): boolean {
  return Boolean(
    page.has_text
    || page.has_ocr_text
    || String(page.proofed_text || page.ocr_text || '').trim()
    || page.canonical_content?.text,
  )
}

export function isDocumentPagePayloadHydrated(page: DocumentPage | null | undefined): boolean {
  return page?.__full === true
}

export function retainDocumentPagePayloadWindow(
  pages: DocumentPage[],
  centerIndex: number,
  radius: number,
): DocumentPage[] {
  if (pages.length === 0) return pages
  const safeCenter = Math.max(0, Math.min(pages.length - 1, Math.round(Number(centerIndex || 0))))
  const safeRadius = Math.max(0, Math.round(Number(radius || 0)))
  const start = Math.max(0, safeCenter - safeRadius)
  const end = Math.min(pages.length - 1, safeCenter + safeRadius)

  return pages.map((page, index) => {
    if (index >= start && index <= end) return page
    if (!page.__full && !page.ocr_text && !page.proofed_text && !page.ocr_result && !page.canonical_content) return page
    const hasText = hasStoredPageText(page)
    return {
      ...page,
      ocr_text: null,
      ocr_result: null,
      proofed_text: null,
      canonical_content: undefined,
      has_text: hasText,
      has_ocr_text: hasText,
      __full: false,
      __light: true,
      __search_text_only: false,
    }
  })
}

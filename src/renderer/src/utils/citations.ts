import type { CitationGenerateOptions, ResearchKnowledgeKind, ResearchNote } from '@shared/types'

type CitationNote = Pick<ResearchNote,
  'id' | 'doc_id' | 'page_num' | 'excerpt' | 'note' | 'tags' | 'kind' | 'citation_text' | 'source_id' | 'doc_title' | 'doc_author' | 'doc_type'
>

type JsonRecord = Record<string, unknown>

interface ResolveCitationOptions extends CitationGenerateOptions {
  styleId?: string
  docType?: string | null
}

interface NoteMarkdownOptions extends ResolveCitationOptions {
  kindLabel?: string
  sourceLabel?: string
  sourceState?: string
}

const KIND_LABELS: Record<ResearchKnowledgeKind, string> = {
  quote: '摘录',
  summary: '概述',
  comment: '评论',
  idea: '想法',
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(value?: string | null): JsonRecord | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function splitTags(value?: string | null): string[] {
  return String(value || '')
    .split(/[,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function cleanupCitation(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/，\s*，/g, '，')
    .replace(/,\s*,/g, ',')
    .replace(/，\s*。/g, '。')
    .replace(/,\s*\./g, '.')
    .replace(/^[\s，,；;：:]+|[\s，,；;：:]+$/g, '')
    .trim()
}

export function appendPageToCitation(citation: string, pageNum?: number | null): string {
  const base = cleanupCitation(citation)
  const page = Number(pageNum || 0)
  if (!base || !Number.isFinite(page) || page <= 0) return base

  const compact = base.replace(/\s+/g, '')
  if (
    /第\d{1,5}[页頁]/.test(compact) ||
    /\b(?:p|P)\.?\s*\d{1,5}\b/.test(base) ||
    compact.includes(`第${page}页`) ||
    new RegExp(`(?:p|P)\\.?\\s*${page}(?:\\D|$)`).test(base)
  ) {
    return base
  }

  const pageText = `第 ${page} 页`
  const terminal = base.match(/[。.]$/)?.[0] || ''
  const body = terminal ? base.slice(0, -terminal.length).trim() : base
  return cleanupCitation(`${body}，${pageText}${terminal}`)
}

export function buildDirectQuoteCitationText(text: string, citation?: string | null): string {
  const quote = String(text || '').replace(/\s+/g, ' ').trim()
  const source = cleanupCitation(citation) || '未命名文献'
  return quote ? `“${quote}”（${source}）` : source
}

function getSourceCitation(note: CitationNote): string {
  const source = parseJson(note.source_id)
  const citation = source?.citation
  return typeof citation === 'string' ? citation : ''
}

function getSourceCitationPageNum(note: CitationNote): number | null {
  const source = parseJson(note.source_id)
  const candidates = [
    source?.citationPageNum,
    source?.originalPageNum,
    source?.displayPageNum,
    source?.sourcePageNum,
  ]
  for (const candidate of candidates) {
    const pageNum = Number(candidate || 0)
    if (Number.isFinite(pageNum) && pageNum > 0) return pageNum
  }
  const fallbackPageNum = Number(note.page_num || 0)
  return Number.isFinite(fallbackPageNum) && fallbackPageNum > 0 ? fallbackPageNum : null
}

export function buildResearchNoteFallbackCitation(note: CitationNote): string {
  const pageNum = getSourceCitationPageNum(note)
  const stored = cleanupCitation(note.citation_text)
  if (stored) return appendPageToCitation(stored, pageNum)

  const sourceCitation = cleanupCitation(getSourceCitation(note))
  if (sourceCitation) return appendPageToCitation(sourceCitation, pageNum)

  const title = cleanupCitation(note.doc_title) || '未命名文献'
  const author = cleanupCitation(note.doc_author)
  return appendPageToCitation([author, title].filter(Boolean).join('，'), pageNum)
}

export async function resolveDefaultCitationStyleId(): Promise<string | undefined> {
  const styles = await window.api.listCitationStyles()
  const list = Array.isArray(styles) ? styles : []
  return list.find((style) => Number(style.is_default) === 1)?.id || list[0]?.id
}

export async function resolveDocumentCitation(docId: string, options: ResolveCitationOptions = {}): Promise<string | null> {
  const styleId = options.styleId || await resolveDefaultCitationStyleId()
  if (!docId || !styleId) return null
  const generated: unknown = await window.api.generateCitationByStyle(
    docId,
    styleId,
    options.docType || undefined,
    { pageNum: options.pageNum ?? null, fieldOverrides: options.fieldOverrides },
  )
  const citation = cleanupCitation(generated)
  return citation || null
}

export async function resolveResearchNoteCitation(note: CitationNote, options: ResolveCitationOptions = {}): Promise<string> {
  try {
    const citation = await resolveDocumentCitation(note.doc_id, {
      ...options,
      docType: options.docType || note.doc_type,
      pageNum: options.pageNum ?? getSourceCitationPageNum(note),
    })
    if (citation) return citation
  } catch (error) {
    console.warn('Failed to generate citation from active style, falling back to stored citation.', error)
  }
  return buildResearchNoteFallbackCitation(note)
}

export async function resolveResearchNoteCitationMap(
  notes: CitationNote[],
  options: ResolveCitationOptions = {},
): Promise<Record<string, string>> {
  const styleId = options.styleId || await resolveDefaultCitationStyleId()
  const entries = await Promise.all(notes.map(async (note) => [note.id, await resolveResearchNoteCitation(note, { ...options, styleId })] as const))
  return Object.fromEntries(entries)
}

export function formatResearchNoteMarkdown(note: CitationNote, citation: string, options: NoteMarkdownOptions = {}): string {
  const tags = splitTags(note.tags)
  const kindLabel = options.kindLabel || KIND_LABELS[note.kind] || KIND_LABELS.quote
  const sourceLabel = options.sourceLabel ? ` / ${options.sourceLabel}` : ''
  const body = note.kind === 'quote'
    ? `> ${String(note.excerpt || '').replace(/\n/g, '\n> ')}`
    : `**${kindLabel}**：${note.excerpt}`
  return [
    body,
    options.sourceState || '',
    '',
    `- 来源：${citation}`,
    `- 类型：${kindLabel}${sourceLabel}`,
    note.note ? `- 备注：${note.note}` : '',
    tags.length ? `- 标签：${tags.join('、')}` : '',
  ].filter(Boolean).join('\n')
}

export async function buildResearchNoteMarkdown(note: CitationNote, options: NoteMarkdownOptions = {}): Promise<string> {
  const citation = await resolveResearchNoteCitation(note, options)
  return formatResearchNoteMarkdown(note, citation, options)
}

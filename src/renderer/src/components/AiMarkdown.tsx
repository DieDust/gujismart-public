import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { EvidenceQaSource, OpenDocumentTarget, SearchHit, SearchHitLocator } from '@shared/types'

function stripSnippetMarkers(value: string): string {
  return String(value || '').replace(/<<|>>/g, '').replace(/\s+/g, ' ').trim()
}

function buildSourceSearchSession(sources: EvidenceQaSource[] | undefined, clickedIndex: number, prompt: string) {
  const clicked = sources?.[clickedIndex]
  if (!clicked) return undefined
  const sameDocSources = (sources || []).filter((source) => source.doc_id === clicked.doc_id)
  const hits: SearchHit[] = sameDocSources.map((source, index) => {
    const pageNum = Number(source.page_num || source.locator?.pageNum || 1)
    const locator: SearchHitLocator = source.locator || {
      docId: source.doc_id,
      segmentId: `${source.doc_id}:ai:${pageNum}:${index}`,
      pageId: null,
      pageNum,
      pageIndex: Math.max(0, pageNum - 1),
      href: null,
      segmentOrdinal: pageNum - 1,
      charStart: 0,
      charEnd: 0,
      matchText: source.matched_query || prompt,
      queryTerm: source.matched_query || prompt,
      occurrenceIndex: index,
    }
    return {
      id: `${locator.segmentId}:${locator.occurrenceIndex}:${index}`,
      locator,
      snippet: source.snippet || '',
      score: Number(source.rank || index),
    }
  })
  const activeHitIndex = Math.max(0, sameDocSources.findIndex((source) => source === clicked))
  return {
    query: prompt,
    hits,
    activeHitIndex,
    status: hits.length > 0 ? 'ready' as const : 'empty' as const,
  }
}

function sourceToTarget(source: EvidenceQaSource, sources: EvidenceQaSource[] | undefined, index: number, prompt: string): OpenDocumentTarget {
  const keyword = source.locator?.queryTerm || source.matched_query || stripSnippetMarkers(source.snippet || '').slice(0, 40) || prompt
  return {
    docId: source.doc_id,
    pageIndex: source.locator?.pageIndex ?? Math.max((source.page_num || 1) - 1, 0),
    keyword,
    excerpt: source.snippet,
    highlightExcerpt: stripSnippetMarkers(source.snippet || ''),
    sourceId: `ai-cite-${index + 1}`,
    sourceLabel: `[${index + 1}] ${source.doc_title || '原文'}`,
    locator: source.locator,
    searchSession: buildSourceSearchSession(sources, index, keyword),
    revealToc: true,
  }
}

interface AiMarkdownProps {
  content: string
  sources?: EvidenceQaSource[]
  prompt?: string
  onOpenDocument?: (target: OpenDocumentTarget) => void
}

export default function AiMarkdown({ content, sources = [], prompt = '', onOpenDocument }: AiMarkdownProps) {
  const components: Components = {
    a: ({ href, children }) => {
      const text = String(children?.toString?.() || '')
      const refMatch = text.match(/^\[(\d+)\]$/) || String(href || '').match(/^#source-(\d+)$/)
      const sourceIndex = refMatch ? Number(refMatch[1]) - 1 : -1
      const source = sourceIndex >= 0 ? sources[sourceIndex] : null
      if (source) {
        return (
          <button
            type="button"
            className="ai-citation-link"
            title={stripSnippetMarkers(source.snippet || '') || source.doc_title}
            onClick={() => onOpenDocument?.(sourceToTarget(source, sources, sourceIndex, prompt))}
          >
            [{sourceIndex + 1}]
          </button>
        )
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    },
    p: ({ children }) => <p>{children}</p>,
    code: ({ children }) => <code>{children}</code>,
  }

  const linkedContent = String(content || '').replace(/(?<!\!)\[(\d{1,2})\](?!\()/g, (_match, index) => {
    const sourceIndex = Number(index) - 1
    return sources[sourceIndex] ? `[[${index}]](#source-${index})` : `[${index}]`
  })

  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {linkedContent}
      </ReactMarkdown>
    </div>
  )
}

export { sourceToTarget, stripSnippetMarkers }

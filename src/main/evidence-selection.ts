import type { EvidenceQaCluster, SearchResult } from '../shared/types'

export const EVIDENCE_SOURCE_LIMIT = 8
export const EVIDENCE_CANDIDATE_LIMIT = 64
// A model-independent text bound, not a claim about any provider's exact tokenizer.
export const EVIDENCE_CONTEXT_BYTES = 18_000
const CLUSTER_CONTEXT_BYTES = 6000

export function researchEvidenceAspects(question: string): string[][] {
  const aspects: string[][] = []
  if (/资料|史料|材料来源|获取材料/.test(question)) aspects.push(['档案', '报刊', '报纸', '史料', '资料'])
  if (/方法|如何研究|怎么研究/.test(question)) aspects.push(['访谈', '口述', '定量', '比较', '统计', '方法'])
  if (/偏见|偏向|偏差|局限|立场/.test(question)) aspects.push(['偏见', '立场', '偏向', '局限', '筛选', '中心主义'])
  return aspects
}

function normalized(text: string): string {
  return text.replace(/<<|>>/g, '').replace(/\s+/g, '').toLowerCase()
}

function resultKey(item: SearchResult): string {
  return JSON.stringify([item.doc_id, item.page_num, item.locator?.segmentId || normalized(item.snippet)])
}

export function fuseEvidenceRanks(keyword: SearchResult[], semantic: SearchResult[]): SearchResult[] {
  const fused = new Map<string, SearchResult>()
  // Reciprocal ranks avoid comparing cosine scores with full-text scores.
  for (const list of [keyword, semantic]) {
    const seen = new Set<string>()
    list.forEach((item, rank) => {
      const key = resultKey(item)
      if (seen.has(key)) return
      seen.add(key)
      const previous = fused.get(key)
      fused.set(key, {
        ...(previous || item),
        relevance_score: (previous?.relevance_score || 0) + 1 / (60 + rank + 1),
      })
    })
  }
  return [...fused.values()].sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
    .slice(0, EVIDENCE_CANDIDATE_LIMIT)
}

export function evidenceExcerpt(text: string, anchors: string[], maxChars: number): string {
  const clean = String(text || '').trim()
  if (clean.length <= maxChars) return clean
  const lower = clean.toLowerCase()
  const match = anchors.map((anchor) => anchor.trim()).filter(Boolean)
    .map((anchor) => ({ start: lower.indexOf(anchor.toLowerCase()), length: anchor.length }))
    .find((item) => item.start >= 0)
  let start = Math.max(0, (match?.start || 0) - Math.floor(maxChars / 3))
  if (start > 0 && /[\uDC00-\uDFFF]/.test(clean[start])) start -= 1
  let end = Math.min(clean.length, start + maxChars)
  if (end < clean.length && /[\uDC00-\uDFFF]/.test(clean[end])) end -= 1
  return `${start ? '...' : ''}${clean.slice(start, end)}${end < clean.length ? '...' : ''}`
}

export function renderEvidenceCluster(cluster: EvidenceQaCluster, index: number): string {
  const pageTexts = cluster.pages.map((page) => normalized(page.text))
  const sources = cluster.sources.map((source, sourceIndex) => {
    const contained = pageTexts.some((text) => text.includes(normalized(source.snippet)))
    return `S${index + 1}.${sourceIndex + 1} ${source.doc_title} 第 ${source.page_num || '?'} 页${contained ? '（原文见下）' : `：${source.snippet}`}`
  }).join('\n')
  const pages = cluster.pages.map((page) => `[${page.role === 'hit' ? '命中页' : page.role === 'before' ? '前页' : '后页'} 第 ${page.page_num} 页]\n${page.text}`).join('\n\n')
  return [`【证据组 ${index + 1}】${cluster.doc_title}`, sources, pages].filter(Boolean).join('\n')
}

function grams(text: string): Set<string> {
  const value = normalized(text).slice(0, 1800)
  return new Set(Array.from({ length: Math.max(0, value.length - 1) }, (_, i) => value.slice(i, i + 2)))
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const gram of left) if (right.has(gram)) overlap += 1
  return overlap / (left.size + right.size - overlap)
}

export function selectEvidenceClusters(candidates: EvidenceQaCluster[], aspects: string[][] = []): {
  clusters: EvidenceQaCluster[]; bytes: number; sourceCount: number
} {
  const pool = [...candidates].sort((a, b) => b.score - a.score).slice(0, EVIDENCE_CANDIDATE_LIMIT).map((cluster) => ({
    cluster,
    grams: grams(cluster.sources.map((source) => source.snippet).join('\n')),
  }))
  const highest = Math.max(...pool.map(({ cluster }) => cluster.score), 1e-9)
  const selected: EvidenceQaCluster[] = []
  const selectedGrams: Set<string>[] = []
  const documentCounts = new Map<string, number>()
  const originalClusters = new Map(candidates.map((cluster) => [cluster.id, cluster]))
  const usedSources = new Set<string>()
  const pageKeys = new Set<string>()
  const coveredAspects = new Set<number>()
  let bytes = 0
  let sourceCount = 0
  while (pool.length && sourceCount < EVIDENCE_SOURCE_LIMIT) {
    const score = (item: typeof pool[number]) => {
      const text = item.cluster.sources.map((source) => source.snippet).join('')
      const readable = (text.match(/[\p{L}\p{N}]/gu)?.length || 0) / Math.max(1, text.length)
      const traceable = item.cluster.sources.some((source) => source.locator || source.stableLocator) ? 1 : 0
      const redundancy = Math.max(0, ...selectedGrams.map((other) => similarity(item.grams, other)))
      const matchedAspects = aspects.map((terms, index) => terms.some((term) => text.includes(term)) ? index : -1).filter((index) => index >= 0)
      const aspectRelevance = matchedAspects.length / Math.max(1, aspects.length)
      const novelAspects = matchedAspects.filter((index) => !coveredAspects.has(index)).length / Math.max(1, aspects.length)
      return 0.8 * item.cluster.score / highest + 0.1 * readable + 0.1 * traceable
        + 0.3 * aspectRelevance + 0.15 * novelAspects
        - 0.18 * (documentCounts.get(item.cluster.doc_id) || 0) - 0.25 * redundancy
    }
    const scores = new Map(pool.map((item) => [item, score(item)]))
    pool.sort((left, right) => scores.get(right)! - scores.get(left)!)
    const next = pool.shift()!
    const seen = new Set<string>()
    const sources = next.cluster.sources.filter((source) => {
      const key = JSON.stringify([source.doc_id, source.page_num, normalized(source.snippet)])
      if (!source.snippet.trim() || seen.has(key) || usedSources.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, Math.min(2, EVIDENCE_SOURCE_LIMIT - sourceCount))
    if (!sources.length) continue
    const separatorBytes = selected.length ? Buffer.byteLength('\n\n---\n\n') : 0
    const budget = Math.min(CLUSTER_CONTEXT_BYTES, EVIDENCE_CONTEXT_BYTES - bytes - separatorBytes)
    let fitted: EvidenceQaCluster = { ...next.cluster, sources, pages: [] }
    const size = (cluster: EvidenceQaCluster) => Buffer.byteLength(renderEvidenceCluster(cluster, selected.length), 'utf8')
    if (size(fitted) > budget && sources.length > 1) fitted = { ...fitted, sources: sources.slice(0, 1) }
    // Skip oversized material instead of discarding all lower-ranked evidence after it.
    if (size(fitted) > budget) continue
    selected.push(fitted)
    aspects.forEach((terms, index) => {
      if (fitted.sources.some((source) => terms.some((term) => source.snippet.includes(term)))) coveredAspects.add(index)
    })
    fitted.sources.forEach((source) => usedSources.add(JSON.stringify([source.doc_id, source.page_num, normalized(source.snippet)])))
    selectedGrams.push(next.grams)
    documentCounts.set(fitted.doc_id, (documentCounts.get(fitted.doc_id) || 0) + 1)
    sourceCount += fitted.sources.length
    bytes += separatorBytes + Buffer.byteLength(renderEvidenceCluster(fitted, selected.length - 1), 'utf8')
  }
  // Reserve space for primary evidence first; optional page expansion cannot crowd out later sources.
  for (const role of ['hit', 'before', 'after'] as const) {
    selected.forEach((cluster, index) => {
      for (const page of originalClusters.get(cluster.id)?.pages.filter((item) => item.role === role) || []) {
        const key = JSON.stringify([cluster.doc_id, page.page_num])
        if (pageKeys.has(key)) continue
        const expanded = { ...cluster, pages: [...cluster.pages, page].sort((a, b) => a.page_num - b.page_num) }
        const size = Buffer.byteLength(renderEvidenceCluster(expanded, index), 'utf8')
        const delta = size - Buffer.byteLength(renderEvidenceCluster(cluster, index), 'utf8')
        if (size <= CLUSTER_CONTEXT_BYTES && bytes + delta <= EVIDENCE_CONTEXT_BYTES) {
          cluster.pages = expanded.pages
          bytes += delta
          pageKeys.add(key)
        }
      }
    })
  }
  return { clusters: selected, bytes, sourceCount }
}

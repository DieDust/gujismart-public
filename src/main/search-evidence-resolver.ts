import type { ResolvedSearchEvidence, StableReaderLocator } from '../shared/types'
import { relocateStableReaderLocator, validateStableReaderLocator } from '../shared/stable-reader-locator'
import { queryOne } from './database'
import { resolveCanonicalPageContent } from './canonical-content'

function unresolved(locator: StableReaderLocator, verificationStatus: ResolvedSearchEvidence['verificationStatus'], reason: string): ResolvedSearchEvidence {
  return {
    stableLocator: locator,
    text: '',
    sourceKind: locator.sourceKind || 'page',
    precision: locator.precision,
    resolution: 'unresolved',
    verificationStatus,
    reason,
  }
}

function findPageId(locator: StableReaderLocator): string | null {
  if (locator.sourcePageId) return locator.sourcePageId
  if (!locator.pageNum) return null
  return queryOne<{ id: string }>(
    'SELECT id FROM pages WHERE doc_id = ? AND page_num = ? ORDER BY page_num LIMIT 1',
    [locator.documentId, locator.pageNum],
  )?.id || null
}

export function resolveSearchEvidence(locatorValue: StableReaderLocator): ResolvedSearchEvidence {
  const locator = validateStableReaderLocator(locatorValue)
  if (locator.precision === 'document') return unresolved(locator, 'migration-pending', 'document-precision')
  if (locator.precision === 'block') return unresolved(locator, 'migration-pending', 'block-mapping-unavailable')
  const pageId = findPageId(locator)
  if (!pageId) return unresolved(locator, 'source-missing', 'page-not-found')
  let canonical
  try {
    canonical = resolveCanonicalPageContent(pageId)
  } catch {
    return unresolved(locator, 'source-missing', 'canonical-source-missing')
  }
  const contentVersion = canonical.artifactId || canonical.baseArtifactId || `${canonical.source}:${canonical.sourceHash}`
  if (locator.precision === 'page') {
    return {
      stableLocator: locator,
      text: canonical.text,
      sourceKind: canonical.source,
      precision: 'page',
      resolution: 'exact',
      verificationStatus: locator.verificationStatus === 'legacy-unverified' ? 'legacy-unverified' : 'verified',
      contentVersion,
      sourceHash: canonical.sourceHash,
    }
  }
  const resolution = relocateStableReaderLocator(locator, {
    text: canonical.text,
    contentVersion,
    sourceHash: canonical.sourceHash,
  })
  if (resolution.resolution === 'unresolved' || resolution.locator.precision !== 'exact') {
    return unresolved(locator, canonical.sourceHash === locator.sourceHash ? 'source-missing' : 'stale', resolution.reason || 'locator-unresolved')
  }
  const range = resolution.locator.sourceRanges[0]
  return {
    stableLocator: resolution.locator,
    text: canonical.text.slice(range.start, range.end),
    sourceKind: canonical.source,
    precision: 'exact',
    resolution: resolution.resolution,
    verificationStatus: 'verified',
    contentVersion,
    sourceHash: canonical.sourceHash,
  }
}

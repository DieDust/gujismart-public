import type {
  SearchHitLocator,
  StableReaderBlockLocator,
  StableReaderDocumentLocator,
  StableReaderExactLocator,
  StableReaderLocator,
  StableReaderLocatorResolutionResult,
  StableReaderLocatorVerificationStatus,
  StableReaderPageLocator,
  StableReaderSourceRange,
} from './types'

const SCHEMA_VERSION = 'stable-reader-locator/v2' as const
const MAX_TEXT = 4096
type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requiredText(value: unknown, code: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new Error(code)
  const text = value.trim()
  if (!text || text.length > max) throw new Error(code)
  return text
}

function optionalText(value: unknown, max = MAX_TEXT): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > max) throw new Error('stable_locator_text_invalid')
  const text = value.trim()
  return text || undefined
}

function integer(value: unknown, code: string, minimum = 0): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(code)
  return number
}

function optionalInteger(value: unknown, minimum = 0): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return integer(value, 'stable_locator_number_invalid', minimum)
}

function base(value: JsonRecord, precision: StableReaderLocator['precision']) {
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('stable_locator_schema_invalid')
  const documentId = requiredText(value.documentId, 'stable_locator_document_invalid', 512)
  const sourcePageId = optionalText(value.sourcePageId, 512)
  const pageNum = optionalInteger(value.pageNum, 1)
  const href = optionalText(value.href, 2048)
  const sourceKind = optionalText(value.sourceKind, 120)
  const progressFallback = value.progressFallback === undefined ? undefined : Number(value.progressFallback)
  if (progressFallback !== undefined && (!Number.isFinite(progressFallback) || progressFallback < 0 || progressFallback > 1)) {
    throw new Error('stable_locator_progress_invalid')
  }
  let chapterPath: string[] | undefined
  if (value.chapterPath !== undefined) {
    if (!Array.isArray(value.chapterPath)) throw new Error('stable_locator_chapter_invalid')
    chapterPath = value.chapterPath.map((item) => requiredText(item, 'stable_locator_chapter_invalid', 512)).slice(0, 64)
  }
  const verificationStatus: StableReaderLocatorVerificationStatus = value.verificationStatus === undefined
    ? 'verified'
    : value.verificationStatus === 'verified' || value.verificationStatus === 'legacy-unverified'
      ? value.verificationStatus
      : (() => { throw new Error('stable_locator_verification_invalid') })()
  return {
    schemaVersion: SCHEMA_VERSION,
    precision,
    documentId,
    ...(sourcePageId ? { sourcePageId } : {}),
    ...(pageNum ? { pageNum } : {}),
    ...(href ? { href } : {}),
    ...(chapterPath ? { chapterPath } : {}),
    ...(progressFallback !== undefined ? { progressFallback } : {}),
    ...(sourceKind ? { sourceKind } : {}),
    verificationStatus,
  }
}

function validateRanges(value: unknown): StableReaderSourceRange[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) throw new Error('stable_locator_ranges_invalid')
  let previousEnd = -1
  return value.map((item) => {
    if (!isRecord(item)) throw new Error('stable_locator_range_invalid')
    const start = integer(item.start, 'stable_locator_range_invalid')
    const end = integer(item.end, 'stable_locator_range_invalid')
    if (end <= start || start < previousEnd) throw new Error('stable_locator_range_invalid')
    previousEnd = end
    return { start, end }
  })
}

export function validateStableReaderLocator(value: unknown): StableReaderLocator {
  if (!isRecord(value)) throw new Error('stable_locator_invalid')
  const precision = value.precision
  if (precision !== 'exact' && precision !== 'block' && precision !== 'page' && precision !== 'document') {
    throw new Error('stable_locator_precision_invalid')
  }
  const common = base(value, precision)
  if (precision === 'exact') {
    if (value.offsetUnit !== 'utf16-code-unit') throw new Error('stable_locator_offset_unit_invalid')
    if (typeof value.prefix !== 'string' || value.prefix.length > MAX_TEXT) throw new Error('stable_locator_prefix_invalid')
    if (typeof value.suffix !== 'string' || value.suffix.length > MAX_TEXT) throw new Error('stable_locator_suffix_invalid')
    return {
      ...common,
      precision,
      contentVersion: requiredText(value.contentVersion, 'stable_locator_content_version_invalid', 512),
      sourceHash: requiredText(value.sourceHash, 'stable_locator_source_hash_invalid', 256),
      offsetUnit: 'utf16-code-unit',
      sourceRanges: validateRanges(value.sourceRanges),
      quote: requiredText(value.quote, 'stable_locator_quote_invalid'),
      prefix: value.prefix,
      suffix: value.suffix,
      occurrenceIndex: integer(value.occurrenceIndex, 'stable_locator_occurrence_invalid'),
    }
  }
  if (precision === 'block') {
    return {
      ...common,
      precision,
      blockId: requiredText(value.blockId, 'stable_locator_block_invalid', 512),
      contentVersion: requiredText(value.contentVersion, 'stable_locator_content_version_invalid', 512),
      sourceHash: requiredText(value.sourceHash, 'stable_locator_source_hash_invalid', 256),
    }
  }
  if ('sourceRanges' in value || 'quote' in value || 'blockId' in value) throw new Error('stable_locator_precision_fields_invalid')
  const version = optionalText(value.contentVersion, 512)
  const sourceHash = optionalText(value.sourceHash, 256)
  return {
    ...common,
    precision,
    ...(version ? { contentVersion: version } : {}),
    ...(sourceHash ? { sourceHash } : {}),
  } as StableReaderPageLocator | StableReaderDocumentLocator
}

export function tryParseStableReaderLocator(value: unknown): StableReaderLocator | null {
  try {
    return validateStableReaderLocator(value)
  } catch {
    return null
  }
}

export function stableLocatorFromLegacySearchLocator(
  legacy: SearchHitLocator,
  context?: { contentVersion?: string; sourceHash?: string; quote?: string; prefix?: string; suffix?: string },
): StableReaderLocator {
  const documentId = requiredText(legacy?.docId, 'stable_locator_document_invalid', 512)
  const shared = {
    schemaVersion: SCHEMA_VERSION,
    documentId,
    ...(legacy.pageId ? { sourcePageId: String(legacy.pageId) } : {}),
    ...(Number(legacy.pageNum) > 0 ? { pageNum: Math.floor(Number(legacy.pageNum)) } : {}),
    ...(legacy.href ? { href: String(legacy.href) } : {}),
    ...(legacy.sourceType ? { sourceKind: String(legacy.sourceType) } : {}),
  }
  const contentVersion = optionalText(context?.contentVersion, 512)
  const sourceHash = optionalText(context?.sourceHash, 256)
  const start = Number(legacy.charStart)
  const end = Number(legacy.charEnd)
  const quote = String(context?.quote || legacy.matchText || '').trim()
  if (contentVersion && sourceHash && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && quote) {
    return validateStableReaderLocator({
      ...shared,
      precision: 'exact',
      verificationStatus: 'verified',
      contentVersion,
      sourceHash,
      offsetUnit: 'utf16-code-unit',
      sourceRanges: [{ start, end }],
      quote,
      prefix: String(context?.prefix || ''),
      suffix: String(context?.suffix || ''),
      occurrenceIndex: Math.max(0, Math.floor(Number(legacy.occurrenceIndex) || 0)),
    })
  }
  if (legacy.blockId && contentVersion && sourceHash) {
    return validateStableReaderLocator({
      ...shared,
      precision: 'block',
      verificationStatus: 'verified',
      blockId: legacy.blockId,
      contentVersion,
      sourceHash,
    }) as StableReaderBlockLocator
  }
  if (legacy.pageId || Number(legacy.pageNum) > 0 || legacy.href) {
    return validateStableReaderLocator({ ...shared, precision: 'page', verificationStatus: 'legacy-unverified' })
  }
  return validateStableReaderLocator({ ...shared, precision: 'document', verificationStatus: 'legacy-unverified' })
}

export function projectStableLocatorToLegacy(locatorValue: StableReaderLocator): SearchHitLocator | null {
  const locator = validateStableReaderLocator(locatorValue)
  if (locator.precision !== 'exact' || locator.sourceRanges.length !== 1) return null
  const range = locator.sourceRanges[0]
  return {
    docId: locator.documentId,
    segmentId: `stable:${locator.sourcePageId || locator.href || locator.documentId}:${range.start}`,
    sourceType: locator.sourceKind,
    pageId: locator.sourcePageId || null,
    pageNum: locator.pageNum || null,
    pageIndex: locator.pageNum ? locator.pageNum - 1 : null,
    href: locator.href || null,
    segmentOrdinal: locator.pageNum ? locator.pageNum - 1 : 0,
    charStart: range.start,
    charEnd: range.end,
    matchText: locator.quote,
    queryTerm: locator.quote,
    occurrenceIndex: locator.occurrenceIndex,
  }
}

export function legacySearchLocatorFromUnknown(value: unknown): SearchHitLocator | null {
  const stable = tryParseStableReaderLocator(value)
  if (stable) return projectStableLocatorToLegacy(stable)
  if (!isRecord(value)) return null
  if (typeof value.docId !== 'string' || !value.docId.trim()) return null
  if (typeof value.segmentId !== 'string' || !value.segmentId.trim()) return null
  const numericKeys = ['segmentOrdinal', 'charStart', 'charEnd', 'occurrenceIndex'] as const
  if (numericKeys.some((key) => !Number.isFinite(Number(value[key])))) return null
  return value as unknown as SearchHitLocator
}

function quotePositions(text: string, quote: string): number[] {
  const positions: number[] = []
  let cursor = 0
  while (positions.length < 512) {
    const found = text.indexOf(quote, cursor)
    if (found < 0) break
    positions.push(found)
    cursor = found + Math.max(1, quote.length)
  }
  return positions
}

export function relocateStableReaderLocator(
  locatorValue: StableReaderLocator,
  source: { text: string; contentVersion: string; sourceHash: string },
): StableReaderLocatorResolutionResult {
  const locator = validateStableReaderLocator(locatorValue)
  if (locator.precision !== 'exact') return { resolution: 'exact', locator }
  const text = String(source.text || '')
  const direct = locator.sourceRanges.length === 1 ? locator.sourceRanges[0] : null
  if (direct && locator.contentVersion === source.contentVersion && locator.sourceHash === source.sourceHash && text.slice(direct.start, direct.end) === locator.quote) {
    return { resolution: 'exact', locator }
  }
  const positions = quotePositions(text, locator.quote)
  if (positions.length === 0) return { resolution: 'unresolved', locator, reason: 'quote-not-found' }
  const contextMatches = positions.filter((position) => {
    const prefixMatches = !locator.prefix || text.slice(Math.max(0, position - locator.prefix.length), position) === locator.prefix
    const suffixStart = position + locator.quote.length
    const suffixMatches = !locator.suffix || text.slice(suffixStart, suffixStart + locator.suffix.length) === locator.suffix
    return prefixMatches && suffixMatches
  })
  const candidates = contextMatches.length > 0 ? contextMatches : positions
  const position = candidates[Math.min(locator.occurrenceIndex, candidates.length - 1)]
  const relocated: StableReaderExactLocator = {
    ...locator,
    contentVersion: requiredText(source.contentVersion, 'stable_locator_content_version_invalid', 512),
    sourceHash: requiredText(source.sourceHash, 'stable_locator_source_hash_invalid', 256),
    sourceRanges: [{ start: position, end: position + locator.quote.length }],
    verificationStatus: 'verified',
  }
  return { resolution: 'relocated', locator: relocated }
}

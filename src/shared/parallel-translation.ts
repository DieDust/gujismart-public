export type ParallelTranslationSegment = {
  id: string
  source: string
  translation: string
}

export interface ParallelTranslationInputOptions {
  maxChars?: number
  maxSegments?: number
}

export interface ParallelTranslationInput {
  input: string
  segmentCount: number
  truncated: boolean
  segments: string[]
}

type TranslationAlignmentParts = {
  segments: string[]
  marked: boolean
}

function cleanParallelSegment(value: string): string {
  return String(value || '').replace(/[ \t\u00a0]+/g, ' ').trim()
}

function normalizeNaturalLine(value: string): string {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function lineEndsWithSentenceBoundary(value: string): boolean {
  return /[\u3002\uff01\uff1f!?\uff1b;]$/.test(String(value || '').trim())
}

function lineEndsWithSoftContinuation(value: string): boolean {
  return /[\uff0c\u3001,\uff1a:\uff08(\u300a\u300c\u300e\u201c\u2018\-\u2014\u2013]$/.test(String(value || '').trim())
}

function lineStartsWithContinuation(value: string): boolean {
  return /^[\uff0c\u3001,\u3002\uff01\uff1f!?\uff1b;\uff1a:\uff09)\u300b\u300d\u300f\u201d\u2019]/.test(String(value || '').trim())
}

function looksLikeTableLine(value: string): boolean {
  const line = String(value || '').trim()
  if (!line) return false
  if (/^\|?[\s:|\-]+\|[\s:|\-]+$/.test(line)) return true
  return (line.match(/\|/g) || []).length >= 2 || (line.match(/\t/g) || []).length >= 2
}

function looksLikeListLine(value: string): boolean {
  return /^(?:[\-+*]\s+|\d{1,3}[.)\u3001]\s*|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+[\u3001.]\s*)/.test(String(value || '').trim())
}

function hasKanaOrLatin(value: string): boolean {
  return /[A-Za-z\u3040-\u30ff]/.test(String(value || ''))
}

function countMatches(value: string, pattern: RegExp): number {
  return (String(value || '').match(pattern) || []).length
}

function looksLikeShortGlossLine(value: string): boolean {
  const line = String(value || '').trim()
  if (!line || line.length > 36) return false
  if (/^※+$/.test(line)) return true
  if (/[\u300c\u300e\u300a\uff08(].{1,24}[\u300d\u300f\u300b\uff09)]/.test(line)) return true
  const hanCount = countMatches(line, /[\u3400-\u9fff]/g)
  if (hasKanaOrLatin(line) && line.length <= 12 && hanCount <= 2) return true
  return /[-\u30fc]$/.test(line)
}

function shouldInsertSpaceBetweenLines(left: string, right: string): boolean {
  const current = String(left || '').trim()
  const next = String(right || '').trim()
  if (!current || !next) return false
  if (/[\uff08(\u300a\u300c\u300e\u201c\u2018\-\u2014\u2013]$/.test(current)) return false
  if (/^[\uff0c\u3001,\u3002\uff01\uff1f!?\uff1b;\uff1a:\uff09)\u300b\u300d\u300f\u201d\u2019]/.test(next)) return false
  if (hasKanaOrLatin(current) || hasKanaOrLatin(next)) return true
  if (!lineEndsWithSentenceBoundary(current) && (current.length <= 12 || next.length <= 12)) return true
  return false
}

function joinNaturalLines(lines: string[]): string {
  return lines
    .map(normalizeNaturalLine)
    .filter(Boolean)
    .reduce((text, line) => {
      if (!text) return line
      return `${text}${shouldInsertSpaceBetweenLines(text, line) ? ' ' : ''}${line}`
    }, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function shouldMergeNaturalLine(currentLines: string[], nextLine: string, forcedBoundary: boolean): boolean {
  if (forcedBoundary || currentLines.length === 0) return false
  const currentText = joinNaturalLines(currentLines)
  const lastLine = currentLines[currentLines.length - 1] || ''
  const currentLooksLikeGlossBlock = currentLines.every(looksLikeShortGlossLine)
  if (!currentText || !nextLine) return false
  if (looksLikeTableLine(lastLine) || looksLikeTableLine(nextLine)) return false
  if (looksLikeListLine(nextLine) && lineEndsWithSentenceBoundary(lastLine)) return false
  if (!currentLooksLikeGlossBlock && currentLines.length >= 2 && currentText.length <= 48 && looksLikeShortGlossLine(lastLine) && looksLikeShortGlossLine(nextLine)) return false
  if (!currentLooksLikeGlossBlock && looksLikeShortGlossLine(nextLine) && currentText.length >= 60) return false
  if (currentLooksLikeGlossBlock && looksLikeShortGlossLine(nextLine) && currentText.length + nextLine.length <= 80) return true
  if (currentLooksLikeGlossBlock && !looksLikeShortGlossLine(nextLine)) return false
  if (lineStartsWithContinuation(nextLine) || lineEndsWithSoftContinuation(lastLine)) return true
  if (lineEndsWithSentenceBoundary(lastLine)) return false
  if (currentText.length >= 120 && nextLine.length >= 18 && looksLikeUnpunctuatedSentenceEnd(lastLine)) return false
  if (currentText.length >= 420) return false
  return true
}

function looksLikeUnpunctuatedSentenceEnd(value: string): boolean {
  return /(?:です|ます|ました|ません|ませう|ましょう|あります|ありません|なりました|思ってるます|ところです)$/.test(String(value || '').trim())
}

function looksLikePreSegmentedNaturalText(lines: string[]): boolean {
  if (lines.length <= 1) return false
  const averageLength = lines.reduce((total, line) => total + line.length, 0) / lines.length
  const sentenceBoundaryCount = lines.filter(lineEndsWithSentenceBoundary).length
  const structuralCount = lines.filter((line) => looksLikeTableLine(line) || looksLikeListLine(line)).length
  const substantialCount = lines.filter((line) => line.length >= 42).length
  if (averageLength >= 44) return true
  if (averageLength >= 24 && sentenceBoundaryCount / lines.length >= 0.55) return true
  if (averageLength >= 24 && (sentenceBoundaryCount + structuralCount + substantialCount) / lines.length >= 0.7) return true
  return false
}

function shouldSplitLineAfterSentenceBoundary(candidate: string, rest: string): boolean {
  const head = String(candidate || '').trim().replace(/[\u300d\u300f\u300b\uff09)\u201d\u2019]+$/g, '')
  const tail = String(rest || '').trim()
  if (head.length < 2 || tail.length < 4) return false
  if (/^[\u3400-\u9fff]{1,4}[\u3002\uff01\uff1f!?]$/.test(head)) return false
  return true
}

function splitNaturalLineChunks(value: string): string[] {
  const line = normalizeNaturalLine(value)
  if (!line) return []
  const chunks: string[] = []
  let current = ''
  for (let index = 0; index < line.length; index += 1) {
    current += line[index]
    if (!/[\u3002\uff01\uff1f!?\uff1b;]/.test(line[index])) continue
    while (index + 1 < line.length && /[\u300d\u300f\u300b\uff09)\u201d\u2019]/.test(line[index + 1])) {
      index += 1
      current += line[index]
    }
    const rest = line.slice(index + 1)
    if (shouldSplitLineAfterSentenceBoundary(current, rest)) {
      chunks.push(current.trim())
      current = ''
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.length ? chunks : [line]
}

function splitSentenceChunks(value: string): string[] {
  const line = normalizeNaturalLine(value)
  if (!line) return []
  const chunks: string[] = []
  let current = ''
  for (let index = 0; index < line.length; index += 1) {
    current += line[index]
    if (!/[\u3002\uff01\uff1f!?\uff1b;]/.test(line[index])) continue
    while (index + 1 < line.length && /[\u300d\u300f\u300b\uff09)\u201d\u2019]/.test(line[index + 1])) {
      index += 1
      current += line[index]
    }
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.length ? chunks : [line]
}

export function buildSentenceTranslationSegments(value: string): string[] {
  const normalized = String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!normalized) return []

  return normalized
    .split(/\n+/)
    .flatMap((line) => splitSentenceChunks(line))
    .map(normalizeNaturalLine)
    .filter(Boolean)
}

function normalizeTranslationMarkerCharacters(value: string): string {
  return String(value || '')
    .replace(/[\uff10-\uff19]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[\uff33\uff53]/g, 'S')
    .replace(/\uff3b/g, '[')
    .replace(/\uff3d/g, ']')
}

function normalizeMarkedTranslationText(value: string): string {
  const source = normalizeTranslationMarkerCharacters(value)
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/```[A-Za-z0-9_-]*\s*/g, '')
    .replace(/```/g, '')
    .trim()
  if (!source) return ''
  return source
    .replace(/(\s*)(\[?\s*S\s*\d{1,4}\s*\]?\s*[:\uff1a.\-\u3001]?\s*)/gi, (match, space: string, marker: string, offset: number, fullText: string) => {
      const atLineStart = offset === 0 || /\n\s*$/.test(fullText.slice(0, offset))
      return `${atLineStart ? space : '\n'}${marker}`
    })
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function splitUnmarkedTranslationSentences(value: string): string[] {
  const source = String(value || '').trim()
  if (!source) return []
  const chunks: string[] = []
  let current = ''
  for (let index = 0; index < source.length; index += 1) {
    current += source[index]
    if (!/[\u3002\uff01\uff1f!?\uff1b;]/.test(source[index])) continue
    while (index + 1 < source.length && /[\u300d\u300f\u300b\uff09)\u201d\u2019]/.test(source[index + 1])) {
      index += 1
      current += source[index]
    }
    if (cleanParallelSegment(current)) chunks.push(cleanParallelSegment(current))
    current = ''
  }
  if (cleanParallelSegment(current)) chunks.push(cleanParallelSegment(current))
  return chunks
}

export function buildNaturalTranslationSegments(value: string): string[] {
  const normalized = String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!normalized) return []
  const normalizedLines = normalized.split('\n').flatMap(splitNaturalLineChunks).filter(Boolean)
  if (looksLikePreSegmentedNaturalText(normalizedLines)) return normalizedLines

  const segments: string[] = []
  let currentLines: string[] = []
  let forcedBoundary = false
  const flush = () => {
    const segment = joinNaturalLines(currentLines)
    if (segment) segments.push(segment)
    currentLines = []
  }

  for (const line of normalizedLines) {
    if (!line) {
      flush()
      forcedBoundary = true
      continue
    }
    if (!shouldMergeNaturalLine(currentLines, line, forcedBoundary)) flush()
    currentLines.push(line)
    forcedBoundary = false
  }
  flush()
  return segments
}

export function normalizeNaturalParallelSourceText(value: string): string {
  return buildSentenceTranslationSegments(value).join('\n').trim()
}

export function splitTextForParallelTranslation(value: string): string[] {
  return buildSentenceTranslationSegments(value)
}

export function normalizeParallelSegmentForMatch(value: string): string {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function splitTranslationForAlignmentParts(value: string, expectedCount: number): TranslationAlignmentParts {
  const normalized = normalizeMarkedTranslationText(value)
  if (!normalized) return { segments: [], marked: false }

  const markedSegments = new Map<number, string[]>()
  let currentMarker = 0
  for (const rawLine of normalized.split(/\n+/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^\[?\s*S\s*(\d{1,4})\s*\]?\s*[:\uff1a.\-\u3001]?\s*(.*)$/i)
    if (match) {
      currentMarker = Number(match[1])
      if (!markedSegments.has(currentMarker)) markedSegments.set(currentMarker, [])
      const body = match[2]?.trim()
      if (body) markedSegments.get(currentMarker)?.push(body)
      continue
    }
    if (currentMarker > 0) {
      markedSegments.get(currentMarker)?.push(line)
    }
  }
  if (markedSegments.size > 0) {
    return {
      marked: true,
      segments: Array.from({ length: Math.max(expectedCount, markedSegments.size) }, (_item, index) => (
        cleanParallelSegment((markedSegments.get(index + 1) || []).join(' '))
      )),
    }
  }

  const lineSegments = normalized
    .split(/\n+/)
    .map(cleanParallelSegment)
    .filter(Boolean)
  if (lineSegments.length !== expectedCount && expectedCount > 1) {
    const sentenceSegments = splitUnmarkedTranslationSentences(normalized)
    if (sentenceSegments.length === expectedCount) return { segments: sentenceSegments, marked: false }
  }
  if (expectedCount > 1) return { segments: lineSegments, marked: false }

  const singleSegment = cleanParallelSegment(lineSegments.join(' '))
  return { segments: singleSegment ? [singleSegment] : [], marked: false }
}

function splitTranslationForAlignment(value: string, expectedCount: number): string[] {
  return splitTranslationForAlignmentParts(value, expectedCount).segments
}

function hasIncompleteTranslationNotice(value: string): boolean {
  return /(?:\u672c\u9875\u6587\u672c\u8f83\u957f|\u5df2\u4f18\u5148\u7ffb\u8bd1\u524d|\u5df2\u4f18\u5148\u6574\u7406\u524d|\u5f85\u8865\u8bd1|\u6682\u65e0\u7ffb\u8bd1)/.test(String(value || ''))
}

export function buildParallelTranslationSegments(sourceText: string, translationText: string): ParallelTranslationSegment[] {
  const sourceSegments = splitTextForParallelTranslation(sourceText)
  const translationParts = splitTranslationForAlignmentParts(translationText, sourceSegments.length)
  const translationSegments = translationParts.segments
  const total = Math.max(sourceSegments.length, translationSegments.length, 1)
  return Array.from({ length: total }, (_item, index) => ({
    id: `parallel-translation-${index}`,
    source: sourceSegments[index] || '',
    translation: translationSegments[index] || '',
  }))
}

export function buildParallelTranslationInputFromSegments(segments: string[], options: ParallelTranslationInputOptions = {}): ParallelTranslationInput {
  const maxChars = Math.max(1, Number(options.maxChars || 3600))
  const maxSegments = Math.max(1, Number(options.maxSegments || 80))
  const selectedSegments: string[] = []
  let totalLength = 0

  for (const segment of segments) {
    const nextLength = totalLength + segment.length
    if (selectedSegments.length > 0 && nextLength > maxChars) break
    selectedSegments.push(segment)
    totalLength = nextLength
    if (selectedSegments.length >= maxSegments) break
  }

  const effectiveSegments = selectedSegments
  const input = effectiveSegments
    .map((segment, index) => `[S${String(index + 1).padStart(3, '0')}] ${segment}`)
    .join('\n')
  return {
    input,
    segmentCount: effectiveSegments.length,
    truncated: effectiveSegments.length < segments.length,
    segments: effectiveSegments,
  }
}

export function buildParallelTranslationInput(text: string, options: ParallelTranslationInputOptions = {}): ParallelTranslationInput {
  return buildParallelTranslationInputFromSegments(
    buildSentenceTranslationSegments(text).filter(Boolean),
    options,
  )
}

export function buildParallelTranslationInputBatches(text: string, options: ParallelTranslationInputOptions = {}): ParallelTranslationInput[] {
  const segments = buildSentenceTranslationSegments(text).filter(Boolean)
  const batches: ParallelTranslationInput[] = []
  let cursor = 0

  while (cursor < segments.length) {
    const batch = buildParallelTranslationInputFromSegments(segments.slice(cursor), options)
    if (batch.segmentCount <= 0) break
    batches.push(batch)
    cursor += batch.segmentCount
  }

  return batches
}

export function normalizeParallelTranslationLayout(text: string, segmentCount: number): string {
  const expectedCount = Math.max(0, Math.floor(Number(segmentCount) || 0))
  if (expectedCount <= 0) return ''
  const parts = splitTranslationForAlignmentParts(text, expectedCount)
  if (parts.segments.length !== expectedCount) return ''
  if (parts.segments.some((segment) => !segment.trim())) return ''
  return parts.segments.map(cleanParallelSegment).join('\n')
}

export function isParallelTranslationAligned(sourceText: string, translationText: string): boolean {
  const sourceSegments = splitTextForParallelTranslation(sourceText)
  const expectedCount = sourceSegments.length
  if (expectedCount <= 0) return false
  const translationSegments = splitTranslationForAlignmentParts(translationText, expectedCount).segments
  if (translationSegments.length !== expectedCount) return false
  return translationSegments.every((segment) => Boolean(segment.trim()))
}

export function isParallelTranslationDisplayReady(sourceText: string, translationText: string): boolean {
  if (hasIncompleteTranslationNotice(translationText)) return false
  return isParallelTranslationAligned(sourceText, translationText)
}

export type ParallelTranslationCoverageProjection = {
  translations: string[]
  covered: boolean[]
}

function emptyCoverageProjection(unitCount: number): ParallelTranslationCoverageProjection {
  return {
    translations: Array.from({ length: Math.max(0, unitCount) }, () => ''),
    covered: Array.from({ length: Math.max(0, unitCount) }, () => false),
  }
}

export function projectParallelTranslationBySourceCoverage(
  targetUnits: string[],
  sourceText: string,
  translationText: string,
): ParallelTranslationCoverageProjection {
  const units = (targetUnits || []).map((unit) => String(unit || ''))
  if (!isParallelTranslationDisplayReady(sourceText, translationText)) return emptyCoverageProjection(units.length)
  const sourceSegments = buildParallelTranslationSegments(sourceText, translationText)
  const sourceCompacts = sourceSegments.map((segment) => normalizeParallelSegmentForMatch(segment.source))
  if (!sourceCompacts.some(Boolean)) return emptyCoverageProjection(units.length)

  const translations = Array.from({ length: units.length }, () => '')
  const covered = Array.from({ length: units.length }, () => false)
  let segmentIndex = 0
  let segmentOffset = 0

  const advanceEmptySegments = () => {
    while (segmentIndex < sourceCompacts.length && !sourceCompacts[segmentIndex]) {
      segmentIndex += 1
      segmentOffset = 0
    }
  }

  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    let remaining = normalizeParallelSegmentForMatch(units[unitIndex])
    if (!remaining) continue
    const translationParts: string[] = []

    while (remaining) {
      advanceEmptySegments()
      if (segmentIndex >= sourceCompacts.length) return emptyCoverageProjection(units.length)
      const segmentCompact = sourceCompacts[segmentIndex]
      const segmentRemaining = segmentCompact.slice(segmentOffset)
      if (!segmentRemaining) {
        segmentIndex += 1
        segmentOffset = 0
        continue
      }

      if (remaining.startsWith(segmentRemaining)) {
        if (segmentOffset === 0) {
          const translation = sourceSegments[segmentIndex]?.translation?.trim()
          if (translation) translationParts.push(translation)
        }
        remaining = remaining.slice(segmentRemaining.length)
        covered[unitIndex] = true
        segmentIndex += 1
        segmentOffset = 0
        continue
      }

      if (segmentRemaining.startsWith(remaining)) {
        if (segmentOffset === 0) {
          const translation = sourceSegments[segmentIndex]?.translation?.trim()
          if (translation) translationParts.push(translation)
        }
        segmentOffset += remaining.length
        covered[unitIndex] = true
        remaining = ''
        continue
      }

      return emptyCoverageProjection(units.length)
    }

    translations[unitIndex] = translationParts.join(' ').replace(/[ \t]+/g, ' ').trim()
  }

  advanceEmptySegments()
  if (segmentOffset !== 0 || segmentIndex !== sourceCompacts.length) return emptyCoverageProjection(units.length)
  return { translations, covered }
}

export function projectParallelTranslationTextToSource(
  sourceText: string,
  cachedSourceText: string,
  translationText: string,
): string {
  const targetSegments = splitTextForParallelTranslation(sourceText)
  if (!targetSegments.length) return ''
  const projection = projectParallelTranslationBySourceCoverage(targetSegments, cachedSourceText, translationText)
  if (!projection.covered.every(Boolean)) return ''
  if (projection.translations.some((segment) => !segment.trim())) return ''
  const projected = projection.translations.join('\n').trim()
  return isParallelTranslationDisplayReady(sourceText, projected) ? projected : ''
}

export const buildNaturalParallelTranslationInput = buildParallelTranslationInput
export const buildNaturalParallelTranslationInputBatches = buildParallelTranslationInputBatches
export const isNaturalParallelTranslationAligned = isParallelTranslationAligned
export const isNaturalParallelTranslationDisplayReady = isParallelTranslationDisplayReady

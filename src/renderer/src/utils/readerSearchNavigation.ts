export interface PageSearchHitLike {
  pageIndex: number
}

export interface SearchOccurrenceContainer {
  containerIndex: number
  occurrenceIndex: number
}

export interface ReadingOrderSearchHitLike extends PageSearchHitLike {
  elementOrder: number
  charIndex: number
}

function normalizeSearchValue(value: string): string {
  return toSimplified(String(value || '')).toLocaleLowerCase()
}

export function findSearchOccurrenceIndexNearChar(text: string, query: string, charIndex: number): number {
  const source = normalizeSearchValue(text)
  const needle = normalizeSearchValue(query.trim())
  if (!source || !needle) return -1
  const targetCharIndex = Math.max(0, Math.floor(Number(charIndex) || 0))
  const occurrences: number[] = []
  let cursor = 0
  for (;;) {
    const index = source.indexOf(needle, cursor)
    if (index < 0) break
    occurrences.push(index)
    cursor = index + Math.max(1, needle.length)
  }
  if (occurrences.length === 0) return -1
  return occurrences
    .map((index, occurrenceIndex) => ({ occurrenceIndex, distance: Math.abs(index - targetCharIndex) }))
    .sort((left, right) => left.distance - right.distance || left.occurrenceIndex - right.occurrenceIndex)[0].occurrenceIndex
}

function countOccurrences(text: string, query: string): number {
  const source = normalizeSearchValue(text)
  const needle = normalizeSearchValue(query.trim())
  if (!source || !needle) return 0
  let count = 0
  let cursor = 0
  for (;;) {
    const index = source.indexOf(needle, cursor)
    if (index < 0) return count
    count += 1
    cursor = index + Math.max(1, needle.length)
  }
}

export function findFirstSearchHitAtOrAfterPage<T extends PageSearchHitLike>(hits: T[], pageIndex: number): number {
  if (!Array.isArray(hits) || hits.length === 0) return -1
  const targetPageIndex = Math.max(0, Math.floor(Number(pageIndex) || 0))
  const index = hits.findIndex((hit) => Number(hit?.pageIndex) >= targetPageIndex)
  return index >= 0 ? index : 0
}

export function sortSearchIndexesByReadingOrder<T extends ReadingOrderSearchHitLike>(hits: T[]): number[] {
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => (
      left.hit.pageIndex - right.hit.pageIndex
      || left.hit.elementOrder - right.hit.elementOrder
      || left.hit.charIndex - right.hit.charIndex
      || left.index - right.index
    ))
    .map(({ index }) => index)
}

export function findSearchOccurrenceContainer(
  containerTexts: string[],
  query: string,
  pageOccurrenceIndex: number,
): SearchOccurrenceContainer | null {
  const targetOccurrence = Math.max(0, Math.floor(Number(pageOccurrenceIndex) || 0))
  let occurrenceCursor = 0
  for (let containerIndex = 0; containerIndex < containerTexts.length; containerIndex += 1) {
    const occurrenceCount = countOccurrences(containerTexts[containerIndex], query)
    if (targetOccurrence < occurrenceCursor + occurrenceCount) {
      return {
        containerIndex,
        occurrenceIndex: targetOccurrence - occurrenceCursor,
      }
    }
    occurrenceCursor += occurrenceCount
  }
  return null
}
import OpenCC from 'opencc-js'

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })

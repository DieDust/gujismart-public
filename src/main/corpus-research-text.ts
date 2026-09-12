import { createHash } from 'crypto'
import type { CorpusEntityExtraction } from '../shared/types'

export interface CorpusTextUnit {
  start: number
  end: number
  text: string
}

export interface CorpusFinding {
  entities?: CorpusEntityExtraction[]
  claim: string
  quote: string
  stance: 'support' | 'challenge' | 'context'
  dimension: string
  uncertainty: string
  start: number
  end: number
}

const MAX_RESPONSE_BYTES = 262_144
const MAX_FINDINGS = 64
const FIELD_BYTES = { claim: 4096, quote: 12_000, dimension: 1024, uncertainty: 4096 } as const

/** Exact UTF-8 SHA-256, without whitespace or Unicode normalization. */
export function corpusTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Contiguous, half-open UTF-16 offsets; concatenating units reproduces the input.
 * UTF-8 bytes are a conservative token proxy. The caller owns maxTotal and all
 * system/prompt/output reservations; this function never limits total coverage.
 */
export function splitCorpusText(text: string, maxBytes = 12_000): CorpusTextUnit[] {
  if (typeof text !== 'string') throw new TypeError('Corpus text must be a string')
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer')
  }
  const units: CorpusTextUnit[] = []
  let start = 0
  while (start < text.length) {
    let end = start
    let bytes = 0
    while (end < text.length) {
      const point = text.codePointAt(end)!
      const width = point > 0xffff ? 2 : 1
      // Lone surrogates cost three UTF-8 bytes, but their original code units survive.
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : width === 2 ? 4 : 3
      if (bytes + size > maxBytes) break
      bytes += size
      end += width
    }
    if (end === start) throw new RangeError(`maxBytes cannot fit the code point at UTF-16 offset ${start}`)

    if (end < text.length) {
      // Prefer a blank-line paragraph boundary, then a line boundary, then a hard split.
      // Keep delimiters in the preceding unit, including all trailing whitespace.
      const candidate = text.slice(start, end)
      let paragraphEnd = 0
      let lineEnd = 0
      for (const match of candidate.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) {
        const boundary = match.index + match[0].length
        if (match[0] === '\r' && text.charAt(start + boundary) === '\n') continue
        if (match[0] === '\u2029' || (lineEnd > 0 && candidate.slice(lineEnd, match.index).trim() === '')) {
          paragraphEnd = boundary
        }
        lineEnd = boundary
      }
      end = start + (paragraphEnd || lineEnd || candidate.length)
    }
    units.push({ start, end, text: text.slice(start, end) })
    start = end
  }
  return units
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findingField(record: Record<string, unknown>, field: keyof typeof FIELD_BYTES, index: number): string {
  const value = record[field]
  if (typeof value !== 'string' || (field !== 'uncertainty' && !value.trim())) {
    throw new Error(`Finding ${index}: ${field} must be ${field === 'uncertainty' ? 'a string' : 'a nonempty string'}`)
  }
  if (Buffer.byteLength(value, 'utf8') > FIELD_BYTES[field]) {
    throw new RangeError(`Finding ${index}: ${field} exceeds ${FIELD_BYTES[field]} UTF-8 bytes`)
  }
  return value
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/**
 * Accept only a JSON object, not prose or Markdown fences. Empty findings require
 * reviewed:true. Limits: 256 KiB raw JSON, 64 findings, and FIELD_BYTES per string.
 * No trimming, fuzzy quote matching, or partial success. Quote offsets are local,
 * half-open UTF-16 positions of the first exact match with intact surrogate pairs.
 * Negation, attribution and semantic fidelity remain the caller prompt's duty.
 */
export function parseCorpusFindings(raw: string, unitText: string): CorpusFinding[] {
  if (typeof raw !== 'string' || typeof unitText !== 'string') {
    throw new TypeError('Response and unitText must be strings')
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new RangeError(`Response exceeds ${MAX_RESPONSE_BYTES} UTF-8 bytes`)
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) {
    throw new Error('Response must be a JSON object with a findings array')
  }
  if ('reviewed' in parsed && typeof parsed.reviewed !== 'boolean') {
    throw new Error('reviewed must be a boolean')
  }
  if (parsed.findings.length > MAX_FINDINGS) throw new RangeError(`Response exceeds ${MAX_FINDINGS} findings`)
  if (parsed.findings.length === 0 && parsed.reviewed !== true) {
    throw new Error('Empty findings require explicit reviewed:true')
  }
  return parsed.findings.map((value: unknown, index: number): CorpusFinding => {
    if (!isRecord(value)) throw new Error(`Finding ${index} must be an object`)
    const claim = findingField(value, 'claim', index)
    const quote = findingField(value, 'quote', index)
    const dimension = findingField(value, 'dimension', index)
    const uncertainty = findingField(value, 'uncertainty', index)
    const stance = value.stance
    if (stance !== 'support' && stance !== 'challenge' && stance !== 'context') {
      throw new Error(`Finding ${index}: invalid stance`)
    }
    let start = unitText.indexOf(quote)
    while (start >= 0 && (splitsSurrogate(unitText, start) || splitsSurrogate(unitText, start + quote.length))) {
      start = unitText.indexOf(quote, start + 1)
    }
    if (start < 0) throw new Error(`Finding ${index}: quote is not an exact substring of unitText at valid boundaries`)
    const entities = value.entities === undefined ? undefined : parseCorpusEntities(value.entities, quote)
    return { claim, quote, stance, dimension, uncertainty, start, end: start + quote.length, ...(entities ? { entities } : {}) }
  })
}

function parseCorpusEntities(value: unknown, quote: string): CorpusEntityExtraction[] {
  if (!Array.isArray(value) || value.length > 24) throw new Error('entities must be an array of at most 24 mentions')
  return value.map((item: unknown) => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100 || !quote.includes(item.name)) throw new Error('Entity name must occur verbatim in its evidence quote')
    const kind = item.kind
    if (kind !== 'person' && kind !== 'place' && kind !== 'organization' && kind !== 'time' && kind !== 'event') throw new Error('Invalid entity kind')
    if (!Array.isArray(item.aliases) || item.aliases.length > 8) throw new Error('Invalid entity aliases')
    const name = item.name
    const aliases = item.aliases.map((alias: unknown) => {
      if (!isRecord(alias) || typeof alias.name !== 'string' || !alias.name.trim() || alias.name.length > 100
        || typeof alias.quote !== 'string' || !alias.quote || !quote.includes(alias.quote)
        || !alias.quote.includes(name) || !alias.quote.includes(alias.name)) throw new Error('Alias requires a contiguous source quote containing both names')
      return { name: alias.name, quote: alias.quote }
    })
    return { name, kind, aliases }
  })
}

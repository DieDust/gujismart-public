import type {
  DocumentPage,
  TranslationMode,
  TranslationUnitStatus,
  TranslationUnitV1,
} from './types'
import {
  getCanonicalTranslationBlockText,
  getCanonicalTranslationBlocksFromOcrResult,
  type CanonicalTranslationBlock,
} from './translation-source'
import { normalizeTranslationSourceText } from './translation-cache'

type JsonRecord = Record<string, unknown>

export interface TranslationUnitDraft {
  id: string
  blockId: string
  blockIndex: number
  order: number
  blockType: string
  sourceText: string
  sourceHash: string
  skipped: boolean
  sourceRect?: TranslationUnitV1['sourceRect']
  sourceIndex?: number | null
}

export interface ProtectedTranslationText {
  text: string
  placeholders: Record<string, string>
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

export function fnv1aTranslationHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function normalizeBlockType(block: CanonicalTranslationBlock): string {
  return firstText(block.label, block.block_label, block.block_type, block.type, block.category, 'text')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
}

export function shouldSkipTranslationBlock(blockType: string, sourceText: string): boolean {
  const label = String(blockType || '').toLowerCase()
  if (/header|footer|page number|page_number|页眉|頁眉|页脚|頁腳|页码|頁碼|seal|stamp|decorat|ornament|image|figure|picture|photo/.test(label)) return true
  if (/^(?:formula|equation|math|code|barcode|qr code)$/.test(label.trim())) return true
  const compact = String(sourceText || '').replace(/\s+/g, '')
  if (!compact) return true
  const mathSignals = (compact.match(/[=+\-*/^_{}[\]\\∑∫√≈≠≤≥]/g) || []).length
  const languageSignals = (compact.match(/[A-Za-z\u3040-\u30ff\u3400-\u9fff]/g) || []).length
  return mathSignals >= 4 && mathSignals > languageSignals
}

function getBlockManualOrder(block: CanonicalTranslationBlock, fallback: number): number {
  const record = block as JsonRecord
  for (const key of ['manual_reading_order', 'manualReadingOrder', 'reading_order', 'block_order']) {
    const value = Number(record[key])
    if (Number.isFinite(value)) return value
  }
  return fallback
}

function getStableBlockId(pageId: string, block: CanonicalTranslationBlock, blockIndex: number): string {
  const record = block as JsonRecord
  const direct = firstText(
    record.translation_block_id,
    record.block_id,
    record.blockId,
    record.uuid,
    record.id,
    record.key,
  )
  if (direct) return direct
  const rect = block.__rect
  const coordinateKey = rect
    ? [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(Number(value) * 100) / 100).join(':')
    : ''
  const originalOrder = firstText(record.original_reading_order, record.block_order, block.__sourceIndex, blockIndex)
  const fingerprint = [pageId, normalizeBlockType(block), coordinateKey, originalOrder].join('|')
  return `tb_${fnv1aTranslationHash(fingerprint)}`
}

export function buildTranslationUnitDrafts(page: Pick<DocumentPage, 'id' | 'page_num' | 'ocr_result' | 'proofed_text' | 'ocr_text'>): TranslationUnitDraft[] {
  const blocks = getCanonicalTranslationBlocksFromOcrResult(page.ocr_result)
  const drafts = blocks.map((block, blockIndex): TranslationUnitDraft | null => {
    const sourceText = normalizeTranslationSourceText(getCanonicalTranslationBlockText(block))
    const blockType = normalizeBlockType(block)
    if (!sourceText && !shouldSkipTranslationBlock(blockType, sourceText)) return null
    const blockId = getStableBlockId(page.id, block, blockIndex)
    return {
      id: `tu_${fnv1aTranslationHash(`${page.id}|${blockId}`)}`,
      blockId,
      blockIndex,
      order: getBlockManualOrder(block, blockIndex),
      blockType,
      sourceText,
      sourceHash: fnv1aTranslationHash(sourceText),
      skipped: shouldSkipTranslationBlock(blockType, sourceText),
      sourceRect: block.__rect ? { ...block.__rect } : null,
      sourceIndex: Number.isFinite(Number(block.__sourceIndex)) ? Number(block.__sourceIndex) : blockIndex,
    }
  }).filter((unit): unit is TranslationUnitDraft => unit !== null)

  if (drafts.length > 0) {
    return drafts
      .sort((left, right) => left.order - right.order || left.blockIndex - right.blockIndex)
      .map((unit, order) => ({ ...unit, order }))
  }

  const fallbackText = normalizeTranslationSourceText(String(page.proofed_text || page.ocr_text || ''))
  if (!fallbackText) return []
  return fallbackText.split(/\n+/).map((sourceText, index) => {
    const blockId = `fallback_${index}`
    return {
      id: `tu_${fnv1aTranslationHash(`${page.id}|${blockId}`)}`,
      blockId,
      blockIndex: index,
      order: index,
      blockType: 'text',
      sourceText,
      sourceHash: fnv1aTranslationHash(sourceText),
      skipped: false,
      sourceRect: null,
      sourceIndex: index,
    }
  })
}

const PROTECTED_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /\$\$[\s\S]*?\$\$/g,
  /\$[^$\n]+\$/g,
  /\\\([\s\S]*?\\\)/g,
  /\\\[[\s\S]*?\\\]/g,
]

export function protectTranslationText(value: string): ProtectedTranslationText {
  let text = String(value || '')
  const placeholders: Record<string, string> = {}
  let placeholderIndex = 0
  for (const pattern of PROTECTED_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const token = `__GS_PH_${String(placeholderIndex).padStart(4, '0')}__`
      placeholderIndex += 1
      placeholders[token] = match
      return token
    })
  }
  return { text, placeholders }
}

export function restoreTranslationText(value: string, placeholders: Record<string, string>): { text: string; complete: boolean } {
  let text = String(value || '')
  let complete = true
  for (const [token, original] of Object.entries(placeholders)) {
    if (!text.includes(token)) complete = false
    text = text.split(token).join(original)
  }
  return { text: text.trim(), complete }
}

export function formatTranslationUnitInput(units: Array<Pick<TranslationUnitV1, 'id' | 'sourceText'>>): {
  input: string
  protectedById: Record<string, ProtectedTranslationText>
} {
  const protectedById: Record<string, ProtectedTranslationText> = {}
  const lines = units.map((unit) => {
    const protectedText = protectTranslationText(unit.sourceText)
    protectedById[unit.id] = protectedText
    return `[${unit.id}] ${protectedText.text}`
  })
  return { input: lines.join('\n'), protectedById }
}

export function parseTranslationUnitOutput(value: string): Map<string, string> {
  const normalized = String(value || '')
    .replace(/\r/g, '\n')
    .replace(/```[A-Za-z0-9_-]*\s*/g, '')
    .replace(/```/g, '')
    .trim()
  const results = new Map<string, string>()
  let currentId = ''
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const marker = line.match(/^\[\s*(tu_[A-Za-z0-9_-]+)\s*\]\s*[:：.-]?\s*(.*)$/i)
    if (marker) {
      currentId = marker[1]
      results.set(currentId, marker[2].trim())
      continue
    }
    if (currentId) results.set(currentId, `${results.get(currentId) || ''} ${line}`.trim())
  }
  return results
}

export function joinTranslationUnits(
  units: Array<Pick<TranslationUnitV1, 'sourceText' | 'translationText' | 'skipped'>>,
  side: 'source' | 'translation',
): string {
  return units
    .map((unit) => side === 'source'
      ? unit.sourceText
      : String(unit.translationText || (unit.skipped ? unit.sourceText : '')).trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function normalizeTranslationMode(value: unknown): TranslationMode {
  return value === 'fast' || value === 'quality' ? value : 'balanced'
}

export function normalizeTranslationUnitStatus(value: unknown): TranslationUnitStatus {
  return value === 'processing'
    || value === 'ready'
    || value === 'stale'
    || value === 'error'
    || value === 'skipped'
    ? value
    : 'pending'
}

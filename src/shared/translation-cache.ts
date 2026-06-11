import { normalizeNaturalParallelSourceText } from './parallel-translation'

export const TRANSLATION_CACHE_VERSION = 'translation-cache-v7-strict-sentence-line'
export const LEGACY_BOOK_TRANSLATION_CACHE_VERSION = 'book-translation-v1'
export const DEFAULT_TRANSLATION_STYLE = 'academic_smooth'
export const DEFAULT_TRANSLATION_MODEL = 'default'
export const DEFAULT_TRANSLATION_GLOSSARY = 'none'

export interface TranslationCacheKeyOptions {
  docId?: string | null
  pageId: string
  sourceText: string
  modelSignature?: string | null
  glossarySignature?: string | null
  style?: string | null
}

function normalizeCachePart(value: unknown, fallback = ''): string {
  return String(value ?? fallback).trim() || fallback
}

export function normalizeTranslationSourceText(value: string): string {
  const naturalSource = normalizeNaturalParallelSourceText(value)
  return String(naturalSource || value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function fnv1aHex(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function buildTranslationCacheKey(options: TranslationCacheKeyOptions): string {
  const parts = [
    TRANSLATION_CACHE_VERSION,
    normalizeCachePart(options.docId, 'unknown-doc'),
    normalizeCachePart(options.pageId, 'unknown-page'),
    normalizeCachePart(options.modelSignature, DEFAULT_TRANSLATION_MODEL),
    normalizeCachePart(options.glossarySignature, DEFAULT_TRANSLATION_GLOSSARY),
    normalizeCachePart(options.style, DEFAULT_TRANSLATION_STYLE),
    normalizeTranslationSourceText(options.sourceText),
  ]
  return fnv1aHex(parts.join('\u0000'))
}

export function buildLegacyReaderTranslationCacheKey(pageId: string, sourceText: string, modelSignature = DEFAULT_TRANSLATION_MODEL): string {
  const source = `parallel-v7:${modelSignature || DEFAULT_TRANSLATION_MODEL}:${pageId}:${normalizeTranslationSourceText(sourceText)}`
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

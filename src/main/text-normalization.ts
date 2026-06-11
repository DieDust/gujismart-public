import OpenCC from 'opencc-js'

const toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' })

export function normalizeWhitespace(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function normalizeChineseSearchText(value: string): string {
  const compact = normalizeWhitespace(value)
  return compact ? toSimplified(compact) : ''
}

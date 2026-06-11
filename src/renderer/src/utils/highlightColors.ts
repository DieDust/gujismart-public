export const DEFAULT_HIGHLIGHT_COLOR = '#ffe066'

export const HIGHLIGHT_COLOR_OPTIONS = [
  { value: '#ffe066', label: '\u9ec4\u8272' },
  { value: '#74c0fc', label: '\u84dd\u8272' },
  { value: '#8ce99a', label: '\u7eff\u8272' },
  { value: '#ff8787', label: '\u7ea2\u8272' },
  { value: '#b197fc', label: '\u7d2b\u8272' },
]

export function normalizeHighlightColor(value?: string | null): string {
  const color = String(value || '').trim()
  return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_HIGHLIGHT_COLOR
}

export function getHighlightColorLabel(value?: string | null): string {
  const color = normalizeHighlightColor(value)
  return HIGHLIGHT_COLOR_OPTIONS.find((item) => item.value.toLowerCase() === color.toLowerCase())?.label || '\u81ea\u5b9a\u4e49'
}

export function getHighlightTextColor(color: string): string {
  const hex = normalizeHighlightColor(color).slice(1)
  const red = parseInt(hex.slice(0, 2), 16)
  const green = parseInt(hex.slice(2, 4), 16)
  const blue = parseInt(hex.slice(4, 6), 16)
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  return luminance > 0.56 ? '#1f1608' : '#fffaf0'
}

export function hexToRgba(color: string, alpha: number): string {
  const hex = normalizeHighlightColor(color).slice(1)
  const red = parseInt(hex.slice(0, 2), 16)
  const green = parseInt(hex.slice(2, 4), 16)
  const blue = parseInt(hex.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

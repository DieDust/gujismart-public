export interface ManualLayoutUnderlayStyleOptions {
  layoutEditMode: boolean
  altShowsClearUnderlay: boolean
  blur: number
}

export interface ManualLayoutUnderlayImageStyle {
  opacity: number
  filter: string
}

export function getManualLayoutUnderlayImageStyle({
  layoutEditMode,
  altShowsClearUnderlay,
  blur,
}: ManualLayoutUnderlayStyleOptions): ManualLayoutUnderlayImageStyle {
  if (altShowsClearUnderlay) return { opacity: 1, filter: 'none' }
  const normalizedBlur = Math.max(0, Math.min(100, blur))
  return {
    opacity: layoutEditMode ? 0.52 : Math.max(0.08, 0.28 - normalizedBlur * 0.0016),
    filter: `blur(${(normalizedBlur / 28).toFixed(2)}px) saturate(${Math.max(0.35, 0.9 - normalizedBlur * 0.004).toFixed(2)}) contrast(${Math.max(0.55, 0.95 - normalizedBlur * 0.003).toFixed(2)})`,
  }
}

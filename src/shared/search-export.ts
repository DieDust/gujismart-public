/** User-selectable maximum for search excerpt exports and batch saves. */
export type SearchExportCount = number | 'all'

/** Default kept high enough for bulk research while avoiding an implicit unbounded task. */
export const DEFAULT_SEARCH_EXPORT_COUNT = 10_000

export function normalizeSearchExportCount(
  value: unknown,
  fallback: SearchExportCount = DEFAULT_SEARCH_EXPORT_COUNT,
): SearchExportCount {
  if (value === 'all') return 'all'

  const normalizedFallback = fallback === 'all'
    ? DEFAULT_SEARCH_EXPORT_COUNT
    : normalizeNumericSearchExportCount(fallback, DEFAULT_SEARCH_EXPORT_COUNT)
  return normalizeNumericSearchExportCount(value, normalizedFallback)
}

function normalizeNumericSearchExportCount(value: unknown, fallback: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.round(raw)))
}

/** Convert the user-facing count to a loop limit without losing the `all` meaning. */
export function searchExportCountToLimit(value: SearchExportCount): number {
  return value === 'all' ? Number.MAX_SAFE_INTEGER : value
}

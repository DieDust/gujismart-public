/** Default number of semantic hits requested by the desktop search page. */
export const VECTOR_SEARCH_DEFAULT_LIMIT = 200

/**
 * Safety bound for one renderer/MCP response.
 *
 * This is intentionally much higher than the desktop default: users may request
 * a larger evidence set before searching, while the main process still keeps a
 * bounded Top-K heap and IPC payload.
 */
export const VECTOR_SEARCH_MAX_LIMIT = 5_000

export function normalizeVectorSearchLimit(
  value: unknown,
  fallback = VECTOR_SEARCH_DEFAULT_LIMIT,
): number {
  const normalizedFallback = Math.min(
    VECTOR_SEARCH_MAX_LIMIT,
    Math.max(1, Math.round(Number(fallback)) || VECTOR_SEARCH_DEFAULT_LIMIT),
  )
  const raw = Math.round(Number(value))
  if (!Number.isFinite(raw) || raw <= 0) return normalizedFallback
  return Math.min(VECTOR_SEARCH_MAX_LIMIT, Math.max(1, raw))
}

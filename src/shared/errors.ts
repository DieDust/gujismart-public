export function getErrorMessage(error: unknown, fallback = '未知错误'): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'object' && error && 'message' in error) {
    const messageValue = (error as { message?: unknown }).message
    if (typeof messageValue === 'string' && messageValue.trim()) return messageValue
  }
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('name' in error)) return false
  return (error as { name?: unknown }).name === 'AbortError'
}

export function getResponseErrorMessage(data: unknown, fallback = '未知错误'): string {
  if (!data || typeof data !== 'object') return fallback
  const record = data as Record<string, unknown>
  const nestedError = record.error
  if (nestedError) return getErrorMessage(nestedError, fallback)
  return getErrorMessage(record.message, fallback)
}

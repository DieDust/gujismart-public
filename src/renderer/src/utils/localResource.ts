export function toLocalResourceUrl(filePath: unknown): string {
  const normalized = String(filePath || '').trim().replace(/\\/g, '/')
  return normalized ? `local-resource://file/${encodeURIComponent(normalized)}` : ''
}

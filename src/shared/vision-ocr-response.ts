export type VisionMessageOutput = {
  content: string
  reasoningContent: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function primitiveText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }
  return ''
}

function messagePartText(value: unknown): string {
  if (!Array.isArray(value)) return primitiveText(value)
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (!isRecord(item)) return ''
      return primitiveText(item.text) || primitiveText(item.content)
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function getVisionMessageOutput(data: unknown): VisionMessageOutput {
  const choices = isRecord(data) && Array.isArray(data.choices) ? data.choices : []
  const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : null
  const message = choice && isRecord(choice.message) ? choice.message : null
  return {
    content: messagePartText(message?.content),
    reasoningContent: messagePartText(message?.reasoning_content),
  }
}

export function shouldDisableVisionThinking(baseUrl: string, model: string): boolean {
  const target = `${baseUrl || ''} ${model || ''}`.toLowerCase()
  return /ark\.cn-beijing\.volces\.com/.test(target) && /doubao-seed/.test(target)
}

export function isUnsupportedVisionRequestField(
  errorMessage: string,
  field: 'thinking' | 'response_format',
): boolean {
  const normalized = String(errorMessage || '')
  if (field === 'thinking') {
    return /thinking/i.test(normalized) && /unknown|unsupported|not supported|not valid|invalid|extra field/i.test(normalized)
  }
  return /response_format|json_object/i.test(normalized) && /unknown|unsupported|not supported|not valid|invalid/i.test(normalized)
}

export function normalizeVisionFallbackText(value: string): string {
  const cleaned = String(value || '')
    .replace(/^```(?:text|plaintext|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  if (!cleaned) return ''
  try {
    const parsed = JSON.parse(cleaned) as unknown
    if (typeof parsed === 'string') return parsed.trim()
  } catch {
    // The fallback deliberately accepts plain text.
  }
  return cleaned
}

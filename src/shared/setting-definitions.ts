import type { SettingDefinition } from './types'

const definitions: Record<string, SettingDefinition> = {
  llm_api_key: { key: 'llm_api_key', type: 'secret', sensitivity: 'protected', rendererVisible: false },
  paddleocr_api_key: { key: 'paddleocr_api_key', type: 'secret', sensitivity: 'protected', rendererVisible: false },
  vision_ocr_api_key: { key: 'vision_ocr_api_key', type: 'secret', sensitivity: 'protected', rendererVisible: false },
  theme: { key: 'theme', type: 'string', sensitivity: 'public', rendererVisible: true, defaultValue: 'light' },
  batch_size: { key: 'batch_size', type: 'integer', sensitivity: 'public', rendererVisible: true, defaultValue: '5', min: 1, max: 100 },
  retry_count: { key: 'retry_count', type: 'integer', sensitivity: 'public', rendererVisible: true, defaultValue: '3', min: 0, max: 20 },
  auto_ocr_after_import: { key: 'auto_ocr_after_import', type: 'boolean', sensitivity: 'public', rendererVisible: true, defaultValue: 'true' },
  auto_ai_after_ocr: { key: 'auto_ai_after_ocr', type: 'boolean', sensitivity: 'public', rendererVisible: true, defaultValue: 'false' },
  auto_delete_pdf_assets_after_ocr: { key: 'auto_delete_pdf_assets_after_ocr', type: 'boolean', sensitivity: 'public', rendererVisible: true, defaultValue: 'false' },
  prefer_facsimile_proof_layout: { key: 'prefer_facsimile_proof_layout', type: 'boolean', sensitivity: 'public', rendererVisible: true, defaultValue: 'true' },
  /** First open of a document: read vs proof. Per-document manual switches still win via reader_state. */
  prefer_read_mode_on_open: { key: 'prefer_read_mode_on_open', type: 'boolean', sensitivity: 'public', rendererVisible: true, defaultValue: 'true' },
}

export const SETTING_DEFINITIONS: Readonly<Record<string, SettingDefinition>> = definitions

export function getSettingDefinition(key: string): SettingDefinition {
  const normalizedKey = String(key || '').trim()
  return definitions[normalizedKey] || {
    key: normalizedKey,
    type: 'string',
    sensitivity: 'public',
    rendererVisible: true,
  }
}

export function validateSettingValue(key: string, value: unknown): { key: string; value: string; known: boolean } {
  const normalizedKey = String(key || '').trim()
  if (!normalizedKey) throw new Error('setting_key_required')
  const definition = getSettingDefinition(normalizedKey)
  const known = Object.prototype.hasOwnProperty.call(definitions, normalizedKey)
  const raw = String(value ?? '')
  if (definition.type === 'boolean') {
    const normalized = raw.trim().toLowerCase()
    if (normalized !== 'true' && normalized !== 'false') throw new Error('setting_value_invalid_boolean')
    return { key: normalizedKey, value: normalized, known }
  }
  if (definition.type === 'integer') {
    const parsed = Number(raw)
    if (!Number.isInteger(parsed)) throw new Error('setting_value_invalid_integer')
    if ((definition.min !== undefined && parsed < definition.min) || (definition.max !== undefined && parsed > definition.max)) {
      throw new Error('setting_value_out_of_range')
    }
    return { key: normalizedKey, value: String(parsed), known }
  }
  return { key: normalizedKey, value: raw, known }
}

import { nativeImage } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { getDataDir, queryOne } from './database'
import { getResponseErrorMessage, isAbortError } from '../shared/errors'
import type { LlmProviderProfile, OcrRecognizeLayoutBlock, OcrRecognizeResult } from '../shared/types'
import { isProtectedSettingKey } from './protected-settings'
import { readProtectedSetting } from './settings-security'
import { getVisionOcrConnectionState, isCurrentVisionOcrConnectionVerified } from './vision-ocr-verification'

type JsonRecord = Record<string, unknown>

interface LayoutRect {
  left: number
  top: number
  width: number
  height: number
}

interface VisionLayoutBlock extends OcrRecognizeLayoutBlock {
  words: string
  label: string
  rows?: string[][]
  table_rows?: string[][]
  cells?: unknown[]
  table_cells?: unknown[]
  html?: string
  table_html?: string
  markdown?: string
  reading_order: number
  reading_order_source?: 'ocr' | 'source'
  confidence: number | null
  column_index: number | null
  orientation?: 'horizontal' | 'vertical'
  location: LayoutRect | null
  segmentation_source?: string
  rejected_title_reason?: string
}

interface VisionTocCandidate extends JsonRecord {
  title: string
  level: number
  entry_type: string | null
  parent_title: string | null
  pageNum: number | null
  confidence: number | null
  charIndex?: number
}

interface VisionOcrResult extends OcrRecognizeResult, JsonRecord {
  source_type?: string
  text: string
  corrected_text?: string
  correction_warnings?: unknown[]
  warnings?: unknown[]
  words_result?: VisionLayoutBlock[]
  layout_result?: VisionLayoutBlock[]
  layout_blocks?: VisionLayoutBlock[]
  toc_candidates?: VisionTocCandidate[]
  rejected_toc_candidates?: VisionTocCandidate[]
  image_original_bytes?: number
  image_upload_bytes?: number
}

interface VisionSourcePage {
  id: string
  page_num?: number | null
  image_path?: string | null
  ocr_text?: string | null
  ocr_result?: unknown
}

interface VisionAttemptLog extends JsonRecord {
  useJsonMode: boolean
  status: number
  statusText: string
  requestId: string | null
  finishReason: unknown
  usage: unknown
  rawPreview: string
}

interface VisionChatResponse extends JsonRecord {
  choices?: Array<{
    message?: {
      content?: unknown
    }
    finish_reason?: unknown
  }>
  usage?: unknown
  error?: unknown
}

export interface VisionOcrProgressPayload {
  pageId: string
  pageNum?: number
  completedPages: number
  totalPages: number
  activePages?: number
  status: 'processing' | 'completed' | 'error'
  error?: string
  elapsedMs?: number
  imageBytes?: number
  uploadBytes?: number
  result?: VisionOcrResult | null
  text?: string
}

export interface VisionOcrPageResult {
  pageId: string
  result: VisionOcrResult | null
  text: string
  status: 'completed' | 'error'
  error?: string
}

export interface VisionRefineSourcePage {
  id: string
  page_num?: number | null
  image_path?: string | null
  ocr_text?: string | null
  ocr_result?: unknown
}

interface VisionOcrSettings {
  apiKey: string
  baseUrl: string
  model: string
  concurrency: number
  timeoutMs: number
  maxImageSide: number
  jpegQuality: number
}

function getSetting(key: string): string {
  if (isProtectedSettingKey(key)) return readProtectedSetting(key).trim()
  return String(queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value || '').trim()
}

function isKnownTextOnlyVisionTarget(baseUrl: string, model: string): boolean {
  const target = `${baseUrl || ''} ${model || ''}`.toLowerCase()
  return /api\.deepseek\.com|deepseek-|deepseek\b/.test(target)
}

function assertVisionTargetSupported(baseUrl: string, model: string): void {
  if (!isKnownTextOnlyVisionTarget(baseUrl, model)) return
  throw new Error(
    '当前视觉 OCR 配置指向 DeepSeek 文本接口/模型，该接口不支持图片消息 image_url，不能用于视觉 OCR。'
    + '请在“设置 → 视觉 OCR”中关闭“跟随 AI 配置”，并选择豆包/火山方舟、OpenAI Vision 或其它支持图片输入的视觉模型。',
  )
}

function getStoredVisionOcrProfile(profileId: string): LlmProviderProfile | null {
  try {
    const parsed = JSON.parse(getSetting('vision_ocr_provider_profiles') || '[]') as unknown
    if (!Array.isArray(parsed)) return null
    const candidate = parsed.find((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false
      return String((item as JsonRecord).id || '').trim() === profileId
    }) as JsonRecord | undefined
    if (!candidate) return null
    const profile: LlmProviderProfile = {
      id: String(candidate.id || '').trim(),
      name: String(candidate.name || candidate.provider || '').trim(),
      provider: String(candidate.provider || candidate.name || '').trim(),
      baseUrl: String(candidate.baseUrl || '').trim().replace(/\/+$/, ''),
      model: String(candidate.model || '').trim(),
    }
    return profile.id && profile.baseUrl && profile.model ? profile : null
  } catch {
    return null
  }
}

export function hasVisionOcrConfig(profileId?: string): boolean {
  if (String(profileId || '').trim()) {
    try {
      getVisionOcrSettings(profileId)
      return true
    } catch {
      return false
    }
  }
  const useLlmConfig = getSetting('vision_ocr_use_llm_config') !== 'false'
  const visionBaseUrl = getSetting('vision_ocr_base_url') || 'https://ark.cn-beijing.volces.com/api/v3'
  const visionModel = getSetting('vision_ocr_model')
  const visionReady = !!getSetting('vision_ocr_api_key')
    && !!visionModel
    && !isKnownTextOnlyVisionTarget(visionBaseUrl, visionModel)
  const llmBaseUrl = getSetting('llm_base_url') || 'https://api.deepseek.com/v1'
  const llmModel = getSetting('llm_model')
  const llmReady = !!getSetting('llm_api_key')
    && !!llmModel
    && !isKnownTextOnlyVisionTarget(llmBaseUrl, llmModel)
  const configured = useLlmConfig ? llmReady : visionReady
  return configured && isCurrentVisionOcrConnectionVerified()
}

function getVisionOcrSettings(profileId?: string): VisionOcrSettings {
  const requestedProfileId = String(profileId || '').trim()
  if (requestedProfileId) {
    const activeProfileId = getSetting('vision_ocr_active_provider_id') || getSetting('vision_ocr_provider')
    const storedProfile = getStoredVisionOcrProfile(requestedProfileId)
    const selectedProfile = storedProfile || (requestedProfileId === activeProfileId
      ? {
          id: requestedProfileId,
          name: getSetting('vision_ocr_provider'),
          provider: getSetting('vision_ocr_provider'),
          baseUrl: getSetting('vision_ocr_base_url'),
          model: getSetting('vision_ocr_model'),
        }
      : null)
    if (!selectedProfile) throw new Error('未找到所选的大模型 OCR 配置，请刷新文献库后重试。')
    const selectedApiKey = readProtectedSetting(`vision_ocr_profile:${requestedProfileId}`)
      || (requestedProfileId === activeProfileId ? readProtectedSetting('vision_ocr_api_key') : '')
    if (!selectedApiKey || !selectedProfile.baseUrl || !selectedProfile.model) {
      throw new Error('所选的大模型 OCR 配置不完整，请先在设置页补全并测试连接。')
    }
    if (!getVisionOcrConnectionState(
      requestedProfileId,
      selectedProfile.baseUrl,
      selectedProfile.model,
      selectedApiKey,
    ).verified) {
      throw new Error('所选的大模型 OCR 配置尚未通过连接测试，请先在设置页测试成功。')
    }
    assertVisionTargetSupported(selectedProfile.baseUrl, selectedProfile.model)
    return buildVisionOcrSettings(selectedApiKey, selectedProfile.baseUrl, selectedProfile.model)
  }
  if (!isCurrentVisionOcrConnectionVerified()) {
    throw new Error('当前 AI OCR 配置尚未通过连接测试，请先在设置中测试成功后再使用。')
  }
  const useLlmConfig = getSetting('vision_ocr_use_llm_config') !== 'false'
  const visionApiKey = getSetting('vision_ocr_api_key')
  const visionBaseUrl = getSetting('vision_ocr_base_url')
  const visionModel = getSetting('vision_ocr_model')
  const llmBaseUrl = getSetting('llm_base_url') || 'https://api.deepseek.com/v1'
  const llmModel = getSetting('llm_model')
  const llmTargetTextOnly = isKnownTextOnlyVisionTarget(llmBaseUrl, llmModel)
  const visionTargetTextOnly = isKnownTextOnlyVisionTarget(visionBaseUrl, visionModel)
  const canUseExplicitVisionConfig = !!visionApiKey && !!visionModel && !visionTargetTextOnly
  const shouldUseLlmConfig = (useLlmConfig || (!visionApiKey && !visionModel)) && !(llmTargetTextOnly && canUseExplicitVisionConfig)
  const apiKey = shouldUseLlmConfig ? getSetting('llm_api_key') : visionApiKey
  const baseUrl = shouldUseLlmConfig
    ? llmBaseUrl
    : visionBaseUrl || 'https://ark.cn-beijing.volces.com/api/v3'
  const model = shouldUseLlmConfig ? llmModel : visionModel
  if (!apiKey || !model) {
    throw new Error('未配置视觉模型 OCR。请在设置页填写视觉模型配置，或开启“跟随 AI 配置”。')
  }
  assertVisionTargetSupported(baseUrl, model)
  return buildVisionOcrSettings(apiKey, baseUrl, model)
}

function buildVisionOcrSettings(apiKey: string, baseUrl: string, model: string): VisionOcrSettings {
  const configuredConcurrency = Number(getSetting('vision_ocr_concurrency') || 1)
  const rawTimeoutSeconds = getSetting('vision_ocr_timeout_seconds')
  const timeoutSeconds = !rawTimeoutSeconds || rawTimeoutSeconds === '180'
    ? 600
    : Number(rawTimeoutSeconds)
  const maxImageSide = Number(getSetting('vision_ocr_max_image_side') || 3200)
  const jpegQuality = Number(getSetting('vision_ocr_jpeg_quality') || 82)
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    concurrency: Math.max(1, Math.min(20, Number.isFinite(configuredConcurrency) ? Math.round(configuredConcurrency) : 1)),
    timeoutMs: Math.max(30, Math.min(900, Number.isFinite(timeoutSeconds) ? Math.round(timeoutSeconds) : 180)) * 1000,
    maxImageSide: Math.max(800, Math.min(4096, Number.isFinite(maxImageSide) ? Math.round(maxImageSide) : 3200)),
    jpegQuality: Math.max(50, Math.min(95, Number.isFinite(jpegQuality) ? Math.round(jpegQuality) : 82)),
  }
}

function createLimiter(concurrency: number) {
  let activeCount = 0
  const queue: Array<() => void> = []
  const next = () => {
    activeCount -= 1
    queue.shift()?.()
  }
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (activeCount >= concurrency) await new Promise<void>((resolve) => queue.push(resolve))
    activeCount += 1
    try {
      return await fn()
    } finally {
      next()
    }
  }
}

async function imagePathToDataUrl(imagePath: string, settings: VisionOcrSettings): Promise<{ dataUrl: string; originalBytes: number; uploadBytes: number }> {
  const originalBytes = (await stat(imagePath)).size
  const ext = extname(imagePath).toLowerCase()
  if ((ext === '.jpg' || ext === '.jpeg') && originalBytes <= 8 * 1024 * 1024) {
    const buffer = await readFile(imagePath)
    return {
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      originalBytes,
      uploadBytes: buffer.length,
    }
  }
  const image = nativeImage.createFromPath(imagePath)
  if (!image.isEmpty()) {
    const size = image.getSize()
    const longestSide = Math.max(size.width, size.height)
    const resized = longestSide > settings.maxImageSide
      ? image.resize({
          width: size.width >= size.height ? settings.maxImageSide : Math.max(1, Math.round(size.width * settings.maxImageSide / size.height)),
          height: size.height > size.width ? settings.maxImageSide : Math.max(1, Math.round(size.height * settings.maxImageSide / size.width)),
          quality: 'best',
        })
      : image
    const buffer = resized.toJPEG(settings.jpegQuality)
    return {
      dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      originalBytes,
      uploadBytes: buffer.length,
    }
  }
  const mime = ext === '.jpg' || ext === '.jpeg'
    ? 'image/jpeg'
    : ext === '.webp'
    ? 'image/webp'
    : 'image/png'
  const buffer = await readFile(imagePath)
  return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, originalBytes, uploadBytes: buffer.length }
}

function sanitizeJson(raw: string): string {
  return String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim()
}

function extractBalancedJsonCandidate(value: string): string | null {
  const source = String(value || '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return null
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(value: string): JsonRecord {
  const parsed = JSON.parse(value) as unknown
  if (isJsonRecord(parsed)) return parsed
  throw new Error('视觉模型没有返回 JSON 对象')
}

function parseResponseJson(value: string): VisionChatResponse {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return isJsonRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function parseOptionalJsonRecord(value: unknown): JsonRecord {
  if (isJsonRecord(value)) return value
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return isJsonRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isJsonRecord) : []
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readRecordValue(source: unknown, key: string): unknown {
  return isJsonRecord(source) ? source[key] : undefined
}

function firstRecordValue(source: unknown, keys: string[]): unknown {
  for (const key of keys) {
    const value = readRecordValue(source, key)
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function valueText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).replace(/\s+/g, ' ').trim()
  }
  return ''
}

function rawPrimitiveText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim()
  }
  return ''
}

function fieldText(source: unknown, keys: string[]): string {
  for (const key of keys) {
    const text = valueText(readRecordValue(source, key))
    if (text) return text
  }
  return ''
}

function rawFieldText(source: unknown, keys: string[]): string {
  for (const key of keys) {
    const text = rawPrimitiveText(readRecordValue(source, key))
    if (text) return text
  }
  return ''
}

function finiteNumber(value: unknown): number | null {
  const next = Number(value)
  return Number.isFinite(next) ? next : null
}

function positiveIntField(source: unknown, keys: string[], fallback: number): number {
  const value = finiteNumber(firstRecordValue(source, keys))
  return value === null ? fallback : Math.max(0, Math.floor(value))
}

function toVisionLayoutBlocks(value: unknown): VisionLayoutBlock[] {
  return asUnknownArray(value)
    .map(normalizeVisionBlock)
    .filter((block) => block.words)
}

function parseModelJson(raw: string): JsonRecord {
  const cleaned = sanitizeJson(raw)
  try {
    return parseJsonRecord(cleaned)
  } catch (firstError) {
    const match = cleaned.match(/\{[\s\S]*\}/)
    const candidate = extractBalancedJsonCandidate(cleaned)
    if (candidate) {
      try {
        return parseJsonRecord(candidate)
      } catch {
        // Fall back to the older greedy match below.
      }
    }
    if (!match) {
      const preview = cleaned.replace(/\s+/g, ' ').slice(0, 240)
      throw new Error(`视觉模型没有返回有效 JSON：${preview || (firstError as Error)?.message || '空响应'}`)
    }
    if (!match) throw new Error('视觉模型没有返回有效 JSON')
    return parseJsonRecord(match[0])
  }
}

function normalizeLabel(label: string): string {
  const value = String(label || '').toLowerCase()
  if (/title|heading|标题|篇名|章节/.test(value)) return 'title'
  if (/note|annotation|comment|注|小字|夹注/.test(value)) return 'note'
  if (/toc|目录|目次/.test(value)) return 'toc'
  if (/table|表格/.test(value)) return 'table'
  if (/caption|图注|图说/.test(value)) return 'caption'
  if (/header|footer|页眉|页脚/.test(value)) return 'header_footer'
  return 'text'
}

function normalizeOrientation(value: unknown): 'horizontal' | 'vertical' | undefined {
  const normalized = String(value || '').trim().toLowerCase()
  if (/vertical|top[-_\s]*to[-_\s]*bottom|ttb|竖排|直排/.test(normalized)) return 'vertical'
  if (/horizontal|横排/.test(normalized)) return 'horizontal'
  return undefined
}

function pointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  if (isJsonRecord(point)) return finiteNumber(point[key])
  if (Array.isArray(point)) return finiteNumber(point[tupleIndex])
  return null
}

function normalizeLocation(raw: unknown): LayoutRect | null {
  if (!raw) return null
  if (isJsonRecord(raw) && (raw.left !== undefined || raw.top !== undefined || raw.width !== undefined || raw.height !== undefined)) {
    const left = Number(raw.left || 0)
    const top = Number(raw.top || 0)
    const width = Number(raw.width || 0)
    const height = Number(raw.height || 0)
    if ([left, top, width, height].every(Number.isFinite) && width > 0 && height > 0) return { left, top, width, height }
  }
  const points = Array.isArray(raw) ? raw : asUnknownArray(readRecordValue(raw, 'points'))
  if (points && points.length > 0) {
    const xs = points.map((point) => pointCoordinate(point, 'x', 0)).filter((value): value is number => value !== null)
    const ys = points.map((point) => pointCoordinate(point, 'y', 1)).filter((value): value is number => value !== null)
    if (xs.length > 0 && ys.length > 0) {
      const left = Math.min(...xs)
      const top = Math.min(...ys)
      return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
    }
  }
  return null
}

function getCellText(cell: unknown): string {
  return valueText(cell) || fieldText(cell, ['text', 'words', 'word', 'value', 'content'])
}

function getCellRow(cell: unknown): number {
  return positiveIntField(cell, ['row', 'row_index', 'rowIndex', 'start_row', 'startRow'], 0)
}

function getCellCol(cell: unknown): number {
  return positiveIntField(cell, ['col', 'column', 'col_index', 'column_index', 'colIndex', 'columnIndex', 'start_col', 'startCol'], 0)
}

function normalizeTableRows(rows: unknown): string[][] {
  if (!Array.isArray(rows) || rows.length === 0) return []
  return rows
    .map((row) => Array.isArray(row)
      ? row.map(getCellText)
      : Array.isArray(readRecordValue(row, 'cells'))
        ? asUnknownArray(readRecordValue(row, 'cells')).map(getCellText)
        : [])
    .filter((row: string[]) => row.some((cell) => cell.trim()))
}

function tableRowsFromCells(cells: unknown): string[][] {
  if (!Array.isArray(cells) || cells.length === 0) return []
  const table: string[][] = []
  for (const cell of cells) {
    const rowIndex = getCellRow(cell)
    const colIndex = getCellCol(cell)
    if (!table[rowIndex]) table[rowIndex] = []
    table[rowIndex][colIndex] = getCellText(cell)
  }
  return table.map((row) => (row || []).map((cell) => cell || '')).filter((row) => row.some(Boolean))
}

function parseMarkdownTableRows(value: string): string[][] {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\|.+\|$/.test(line))
  if (lines.length < 2) return []
  return lines
    .filter((line) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()))
    .filter((row) => row.some(Boolean))
}

function tableRowsToText(rows: string[][]): string {
  return rows.map((row) => row.join('\t')).join('\n')
}

function normalizeVisionBlock(block: unknown, index: number): VisionLayoutBlock {
  const rows = normalizeTableRows(firstRecordValue(block, ['rows', 'table_rows', 'tableRows']))
  const rawCells = firstRecordValue(block, ['cells', 'table_cells', 'tableCells'])
  const cells = Array.isArray(rawCells) ? rawCells : []
  const cellRows = rows.length > 0 ? [] : tableRowsFromCells(cells)
  const markdown = rawFieldText(block, ['markdown', 'md'])
  const markdownRows = rows.length || cellRows.length ? [] : parseMarkdownTableRows(markdown || rawFieldText(block, ['words', 'text']))
  const tableRows = rows.length ? rows : cellRows.length ? cellRows : markdownRows
  const html = rawFieldText(block, ['html', 'table_html', 'tableHtml'])
  const words = String(tableRows.length > 0 ? tableRowsToText(tableRows) : rawFieldText(block, ['words', 'text'])).trim()
  const readingOrder = finiteNumber(readRecordValue(block, 'reading_order'))
  const confidence = finiteNumber(readRecordValue(block, 'confidence'))
  const columnIndex = finiteNumber(readRecordValue(block, 'column_index'))
  const orientation = normalizeOrientation(firstRecordValue(block, [
    'orientation',
    'text_orientation',
    'writing_mode',
  ]))
  return {
    words,
    label: tableRows.length > 0 ? 'table' : normalizeLabel(fieldText(block, ['label']) || 'text'),
    rows: tableRows.length > 0 ? tableRows : undefined,
    table_rows: tableRows.length > 0 ? tableRows : undefined,
    cells: cells.length ? cells : undefined,
    table_cells: cells.length ? cells : undefined,
    html: html || undefined,
    table_html: html || undefined,
    markdown: markdown || undefined,
    reading_order: readingOrder === null ? index : readingOrder,
    reading_order_source: readingOrder === null ? 'source' : 'ocr',
    confidence,
    column_index: columnIndex,
    orientation,
    location: normalizeLocation(firstRecordValue(block, ['location', 'bbox', 'box', 'points'])),
    segmentation_source: 'vision_model',
  }
}

function normalizeVisionResult(parsed: JsonRecord, page: VisionSourcePage, rawContent: string, settings: VisionOcrSettings, elapsedMs: number): VisionOcrResult {
  const text = rawFieldText(parsed, ['corrected_text', 'text'])
  const blocks = asUnknownArray(readRecordValue(parsed, 'layout_blocks'))
  const tocCandidates = asRecordArray(readRecordValue(parsed, 'toc_candidates'))
  const warnings = [
    ...asUnknownArray(readRecordValue(parsed, 'warnings')),
    ...asUnknownArray(readRecordValue(parsed, 'correction_warnings')),
  ].map((item) => String(item)).filter(Boolean)

  const normalizedBlocks = blocks
    .map(normalizeVisionBlock)
    .filter((block) => block.words)
  const fallbackText = normalizedBlocks.map((block) => block.words).filter(Boolean).join('\n')
  const normalizedText = text || fallbackText
  if (!normalizedText && tocCandidates.length === 0) throw new Error('视觉模型返回的 text 为空')
  const wordsResult = normalizedBlocks.length > 0
    ? normalizedBlocks.map(({ segmentation_source: _source, ...block }) => block)
    : normalizedText
      .split(/\n+/)
      .map((line, index): VisionLayoutBlock => ({
        words: line.trim(),
        label: 'text',
        reading_order: index,
        reading_order_source: 'source',
        confidence: null,
        column_index: null,
        location: null,
      }))
      .filter((block) => block.words)

  return {
    source_type: 'vision_model_ocr',
    model: settings.model,
    provider: 'openai_compatible_vision',
    page_num: Number(page.page_num || 0) || null,
    elapsed_ms: elapsedMs,
    raw_response_preview: rawContent.slice(0, 3000),
    warnings,
    corrected_text: text || normalizedText,
    correction_warnings: warnings,
    words_result: wordsResult,
    layout_result: normalizedBlocks,
    toc_candidates: tocCandidates
      .map((item): VisionTocCandidate => ({
        title: fieldText(item, ['title']),
        level: Math.max(1, Math.min(6, Number(readRecordValue(item, 'level')) || 2)),
        entry_type: fieldText(item, ['entry_type', 'type']) || null,
        parent_title: fieldText(item, ['parent_title', 'parentTitle']) || null,
        pageNum: finiteNumber(readRecordValue(item, 'pageNum')) ?? (Number(page.page_num || 0) || null),
        confidence: finiteNumber(readRecordValue(item, 'confidence')),
      }))
      .filter((item) => item.title),
    text: normalizedText,
  }
}

function buildVisionOcrPrompt(pageNum: number, docType?: string | null): string {
  const docTypeText = String(docType || '')
  const isGuji = /古籍|方志|善本|刻本|抄本/.test(docTypeText)
  const isNewspaper = /报纸|新闻|newspaper/i.test(docTypeText)
  return [
    'toc_candidates should include entry_type and parent_title when possible, for example {"title":"国外要闻","level":1,"entry_type":"section","parent_title":"","pageNum":1,"confidence":0.9}.',
    'For newspapers, do not decide hierarchy only by font size or visual position. Only real section headings such as 国内要闻, 国外要闻, 本埠新闻, 广告, 启事, 时评 should be section. Normal news, ad, notice, enrollment, rental, meeting, telegram titles are article/ad/notice and usually should not be parent items.',
    '必须逐字转录可见正文，不要摘要、不要改写、不要只列标题、不要用省略号省略未转录内容；看不清的字用 □ 或 [疑字] 标记。',
    '如果是报纸版面，按从右到左、同栏从上到下完整转录。每篇新闻、广告、栏目都应有 title block；正文必须进入紧随其后的 text block。不要把整版合成一段摘要。',
    '你是古籍、报纸和历史文献的视觉 OCR 与版面整理助手。',
    '请直接观察图片，不要只做普通 OCR。需要理解版面顺序、小字夹注、栏位、标题和目录线索。',
    '只返回严格 JSON，不要 Markdown，不要解释。',
    'JSON 格式：{"text":"","layout_blocks":[{"words":"","label":"title|text|note|toc|table|caption|header_footer","rows":[[""]],"cells":[{"row":0,"col":0,"text":""}],"reading_order":0,"column_index":0,"orientation":"horizontal|vertical","location":{"left":0,"top":0,"width":0,"height":0},"confidence":0.0}],"toc_candidates":[{"title":"","level":1,"pageNum":1,"confidence":0.0}],"warnings":[]}',
    `当前为校对模式原始第 ${pageNum} 页。toc_candidates.pageNum 必须使用这个原始页码或图中明确出现的页码。`,
    '必须保留 layout_blocks。每个 block 应尽量包含 location 坐标，并在 text 字段中给出适合阅读和检索的完整正文。',
    '每个文字 block 都要给出 orientation。普通文献应以整篇主方向为准，不要把局部窄框随意判成竖排；古籍竖排默认按从右到左排列。',
    isGuji
      ? '古籍要求：按原文顺序整理，尽量加现代标点和自然段；不得擅自补写原文没有的字；看不清用 □ 或 [疑字] 标记；小字夹注放在相邻正文后，用括注或单独 note block 表示。'
      : '',
    isNewspaper
      ? '报纸要求：按版面阅读顺序输出，保留栏目名、标题、副标题、广告、图注等结构；多栏不要串行错乱。'
      : '',
    '正文 text 应适合阅读和检索：去掉无意义断行，保留标题、段落、列表和注释结构。能确定表格行列时，table block 必须给出 rows 或 cells。',
  ].filter(Boolean).join('\n')
}
async function callVisionModelAttempt(page: VisionSourcePage, settings: VisionOcrSettings, docType?: string | null, promptOverride?: string, mode = 'structured'): Promise<VisionOcrResult> {
  if (!page.image_path) throw new Error(`第 ${page.page_num || ''} 页缺少页面图像，无法使用视觉模型 OCR`)
  const startedAt = Date.now()
  const imagePayload = await imagePathToDataUrl(page.image_path, settings)
  const imageUrl = imagePayload.dataUrl
  const promptText = promptOverride || buildVisionOcrPrompt(Number(page.page_num || 0), docType)
  const requestBody = {
    model: settings.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 12000,
  }
  const sendRequest = async (useJsonMode: boolean) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
    try {
      return await fetch(`${settings.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify(useJsonMode ? { ...requestBody, response_format: { type: 'json_object' } } : requestBody),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw new Error(`视觉模型 OCR 请求超时（${Math.round(settings.timeoutMs / 1000)} 秒）。可以调高超时时间，或降低图片最长边。`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  const attempts: VisionAttemptLog[] = []
  let usedJsonMode = true
  let response = await sendRequest(true)
  let responseText = await response.text().catch(() => '')
  let data = parseResponseJson(responseText)
  attempts.push({
    useJsonMode: true,
    status: response.status,
    statusText: response.statusText,
    requestId: response.headers.get('x-request-id') || response.headers.get('x-tt-logid') || response.headers.get('x-tt-trace-id') || null,
    finishReason: data?.choices?.[0]?.finish_reason || null,
    usage: data?.usage || null,
    rawPreview: responseText.slice(0, 12000),
  })
  const errorMessage = getResponseErrorMessage(data, response.statusText || '')
  if (!response.ok && /response_format|json_object|not supported|not valid/i.test(errorMessage)) {
    usedJsonMode = false
    response = await sendRequest(false)
    responseText = await response.text().catch(() => '')
    data = parseResponseJson(responseText)
    attempts.push({
      useJsonMode: false,
      status: response.status,
      statusText: response.statusText,
      requestId: response.headers.get('x-request-id') || response.headers.get('x-tt-logid') || response.headers.get('x-tt-trace-id') || null,
      finishReason: data?.choices?.[0]?.finish_reason || null,
      usage: data?.usage || null,
      rawPreview: responseText.slice(0, 12000),
    })
  }
  if (!response.ok || data.error) {
    const rawErrorMessage = getResponseErrorMessage(data, response.statusText || '')
    const friendlyErrorMessage = /unknown variant [`']?image_url|expected [`']?text|image_url/i.test(rawErrorMessage)
      ? `${rawErrorMessage}。当前接口不接受图片消息，请改用支持视觉输入的模型/接口，或在视觉 OCR 设置中关闭“跟随 AI 配置”后选择专用视觉模型。`
      : rawErrorMessage
    const logPath = await writeVisionDiagnosticLog({
      createdAt: new Date().toISOString(),
      ok: false,
      errorStage: 'http',
      errorMessage: friendlyErrorMessage,
      mode,
      pageId: page.id,
      pageNum: page.page_num || null,
      imagePath: page.image_path ? basename(page.image_path) : null,
      docType: docType || null,
      endpoint: `${settings.baseUrl}/chat/completions`,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      maxImageSide: settings.maxImageSide,
      jpegQuality: settings.jpegQuality,
      imageOriginalBytes: imagePayload.originalBytes,
      imageUploadBytes: imagePayload.uploadBytes,
      baseTextLength: String(page.ocr_text || '').length,
      baseTextPreview: String(page.ocr_text || '').slice(0, 6000),
      promptText,
      requestBodyPreview: redactDataUrl(JSON.stringify({ ...requestBody, response_format: usedJsonMode ? { type: 'json_object' } : undefined }, null, 2)).slice(0, 30000),
      attempts,
    })
    throw new Error(`视觉模型 OCR 请求失败：${friendlyErrorMessage}${logPath ? `；诊断日志：${logPath}` : ''}`)
  }
  const content = rawPrimitiveText(data.choices?.[0]?.message?.content)
  const finishReason = data.choices?.[0]?.finish_reason || null
  const diagnosticBase = {
    createdAt: new Date().toISOString(),
    mode,
    pageId: page.id,
    pageNum: page.page_num || null,
    imagePath: page.image_path ? basename(page.image_path) : null,
    docType: docType || null,
    endpoint: `${settings.baseUrl}/chat/completions`,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    maxImageSide: settings.maxImageSide,
    jpegQuality: settings.jpegQuality,
    imageOriginalBytes: imagePayload.originalBytes,
    imageUploadBytes: imagePayload.uploadBytes,
    baseTextLength: String(page.ocr_text || '').length,
    baseTextPreview: String(page.ocr_text || '').slice(0, 6000),
    promptText,
    requestBodyPreview: redactDataUrl(JSON.stringify({ ...requestBody, response_format: usedJsonMode ? { type: 'json_object' } : undefined }, null, 2)).slice(0, 30000),
    attempts,
    finishReason,
    usage: data?.usage || null,
    finalContentPreview: String(content || '').slice(0, 30000),
  }
  let parsed: JsonRecord
  try {
    parsed = parseModelJson(content)
  } catch (error) {
    const logPath = await writeVisionDiagnosticLog({
      ...diagnosticBase,
      ok: false,
      errorStage: 'parse_json',
      errorMessage: (error as Error)?.message || String(error),
    })
    throw new Error(`${(error as Error)?.message || String(error)}${logPath ? `；诊断日志：${logPath}` : ''}`)
  }
  let normalized: VisionOcrResult
  try {
    normalized = normalizeVisionResult(parsed, page, content, settings, Date.now() - startedAt)
  } catch (error) {
    const logPath = await writeVisionDiagnosticLog({
      ...diagnosticBase,
      ok: false,
      errorStage: 'normalize_result',
      errorMessage: (error as Error)?.message || String(error),
      parsed,
    })
    throw new Error(`${(error as Error)?.message || String(error)}${logPath ? `；诊断日志：${logPath}` : ''}`)
  }
  const successLogPath = await writeVisionDiagnosticLog({
    ...diagnosticBase,
    ok: true,
    parsedSummary: {
      textLength: String(normalized.text || '').length,
      layoutBlocks: Array.isArray(normalized.layout_result) ? normalized.layout_result.length : 0,
      tocCandidates: Array.isArray(normalized.toc_candidates) ? normalized.toc_candidates.length : 0,
    },
  })
  return {
    ...normalized,
    vision_request_mode: mode,
    image_original_bytes: imagePayload.originalBytes,
    image_upload_bytes: imagePayload.uploadBytes,
    vision_diagnostic_log_path: successLogPath,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableVisionError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '')
  return /5\d\d|429|internal error|unexpected internal|temporar|timeout|timed out|overload|rate limit|ECONN|fetch/i.test(message)
}

function buildVisionOcrFallbackPrompt(pageNum: number): string {
  return [
    'Return strict JSON only.',
    'OCR this image as completely as possible. Do not summarize. Do not use ellipsis for skipped visible text.',
    'For a newspaper, read columns from right to left and each column from top to bottom.',
    'Use one dominant orientation for normal body text; vertical historical text reads right to left.',
    'Use this schema: {"text":"","layout_blocks":[{"words":"","label":"text|title|table","rows":[[""]],"cells":[],"reading_order":0,"column_index":0,"orientation":"horizontal|vertical"}],"toc_candidates":[],"warnings":[]}.',
    `The original proofing page number is ${pageNum}.`,
  ].join('\n')
}

function extractTitleCandidatesFromBaseText(value: string): string[] {
  const seen = new Set<string>()
  return String(value || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => {
      const compact = line.replace(/\s+/g, '')
      if (compact.length < 2 || compact.length > 42) return false
      if (/^[\d\s\-—–=|:：。]+$/.test(compact)) return false
      if (/第\s*\d+\s*[页頁]/.test(compact)) return false
      if (seen.has(compact)) return false
      seen.add(compact)
      if (/^(?:■|□|◆|●)/.test(compact)) return true
      if (/[报闻讯电租售招会省局军政法选战]/.test(compact) && compact.length <= 20) return true
      if (/^[\u4e00-\u9fff]{2,14}$/.test(compact)) return true
      return false
    })
}

function normalizeVisionTitle(value: string): string {
  return String(value || '').replace(/[■□◆●◇\s　:：，,。；;、\-—–]+/g, '').trim()
}

function getBaseTextLines(value: string): string[] {
  return String(value || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function isTitleLikeInBaseText(title: string, baseText: string): boolean {
  const key = normalizeVisionTitle(title)
  if (!key || key.length < 2) return false
  return getBaseTextLines(baseText).some((line) => {
    const lineKey = normalizeVisionTitle(line)
    if (!lineKey.includes(key)) return false
    if (lineKey === key) return true
    if (lineKey.startsWith(key) && lineKey.length <= Math.max(key.length + 4, Math.ceil(key.length * 1.45))) return true
    return false
  })
}

function filterVisionStructureAgainstBaseText(refined: VisionOcrResult, baseText: string): VisionOcrResult {
  const validationText = String(refined.corrected_text || refined.text || baseText || '')
  const tocCandidates = Array.isArray(refined.toc_candidates) ? refined.toc_candidates : []
  const validTitleKeys = new Set<string>()
  const nextTocCandidates = tocCandidates.filter((item) => {
    const title = String(item.title || '').trim()
    const valid = isTitleLikeInBaseText(title, validationText)
    if (valid) validTitleKeys.add(normalizeVisionTitle(title))
    return valid
  })
  const nextLayout = toVisionLayoutBlocks(refined.layout_result)
    .map((block) => {
      if (String(block.label || '') !== 'title') return block
      const key = normalizeVisionTitle(block.words || '')
      if (validTitleKeys.has(key) || isTitleLikeInBaseText(String(block.words || ''), validationText)) return block
      return { ...block, label: 'text', rejected_title_reason: 'not_standalone_in_base_text' }
    })
  const nextWords = (Array.isArray(refined.words_result) ? toVisionLayoutBlocks(refined.words_result) : nextLayout)
    .map((block) => {
      if (String(block.label || '') !== 'title') return block
      const key = normalizeVisionTitle(block.words || '')
      if (validTitleKeys.has(key) || isTitleLikeInBaseText(String(block.words || ''), validationText)) return block
      return { ...block, label: 'text', rejected_title_reason: 'not_standalone_in_base_text' }
    })
  return {
    ...refined,
    layout_result: nextLayout,
    words_result: nextWords,
    toc_candidates: nextTocCandidates,
    rejected_toc_candidates: tocCandidates.filter((item) => !nextTocCandidates.includes(item)),
  }
}

function buildVisionRefinePrompt(pageNum: number, baseText: string): string {
  const titleCandidates = extractTitleCandidatesFromBaseText(baseText).slice(0, 80)
  return [
    'Return strict JSON only.',
    'You are doing hybrid OCR correction. Compare the page image with base_text and return a corrected full text plus layout structure.',
    'You may fix OCR mistakes, missing characters, wrong line breaks, table rows/columns, headings, notes, and toc anchors.',
    'Do not summarize, translate, modernize wording, invent invisible content, or change the meaning. If unclear, use □ or [疑字].',
    'corrected_text/text must contain the complete readable OCR text after correction. It may differ from base_text only where the image supports it.',
    'For each layout block, words should contain the corrected text for that block. For a table block, include rows or cells and also a tab/newline text form in words.',
    'For newspapers, identify article/ad/notice titles and column order from right to left. Do not put ordinary article titles under the previous article unless it is truly a section.',
    'Return at most 120 layout_blocks and at most 80 toc_candidates. Prefer faithful corrected content over compact anchors.',
    'Use one dominant orientation for normal body text. Set each text block orientation to horizontal or vertical; vertical historical text reads right to left.',
    'Use this schema: {"corrected_text":"","text":"","layout_blocks":[{"words":"","label":"title|text|note|toc|table|caption|header_footer","rows":[[""]],"cells":[{"row":0,"col":0,"text":""}],"reading_order":0,"column_index":0,"orientation":"horizontal|vertical","confidence":0.0}],"toc_candidates":[{"title":"","level":1,"entry_type":"section|article|ad|notice|commentary|unknown","parent_title":"","pageNum":1,"charIndex":0,"confidence":0.0}],"correction_warnings":[],"warnings":[]}.',
    `The original proofing page number is ${pageNum}.`,
    titleCandidates.length > 0 ? `Possible title/anchor lines from base_text:\n${titleCandidates.join('\n')}` : '',
    `base_text:\n${String(baseText || '').slice(0, 7000)}`,
  ].join('\n')
}

function buildVisionOcrNewspaperFullTextPrompt(pageNum: number): string {
  return [
    'Return strict JSON only.',
    'This is a historical newspaper page. Your top priority is COMPLETE TEXT TRANSCRIPTION, not summarization.',
    'Read from right to left by columns, and from top to bottom within each column.',
    'Transcribe every visible title, advertisement, notice, news item, and commentary. Do not output only the headings.',
    'If a character is unclear, use □ or [疑字]. Never replace unread text with ellipsis.',
    'Set orientation to vertical for body blocks unless the visible page is clearly horizontal.',
    'Use this schema: {"text":"","layout_blocks":[{"words":"","label":"title|text|note|toc|table|caption|header_footer","rows":[[""]],"cells":[],"reading_order":0,"column_index":0,"orientation":"horizontal|vertical","confidence":0.0}],"toc_candidates":[],"warnings":[]}.',
    `The original proofing page number is ${pageNum}.`,
  ].join('\n')
}

function getResultTextLength(result: VisionOcrResult): number {
  return String(result.text || '').replace(/\s+/g, '').length
}

function redactDataUrl(value: string): string {
  return String(value || '').replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, (match) => {
    const comma = match.indexOf(',')
    const prefix = comma >= 0 ? match.slice(0, comma + 1) : 'data:image/*;base64,'
    return `${prefix}<redacted:${Math.max(0, match.length - prefix.length)} chars>`
  })
}

function safeFilenamePart(value: unknown): string {
  return String(value || 'unknown').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'unknown'
}

async function writeVisionDiagnosticLog(payload: JsonRecord): Promise<string | null> {
  try {
    const dir = join(getDataDir(), 'logs', 'vision-ocr')
    await mkdir(dir, { recursive: true })
    const filePath = join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}_${safeFilenamePart(payload.mode)}_${safeFilenamePart(payload.pageId)}.json`,
    )
    await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
    return filePath
  } catch (error) {
    console.warn('[Vision OCR] Failed to write diagnostic log', error)
    return null
  }
}

function normalizeFallbackBlockLabel(label: unknown, words: string): string {
  const value = String(label || '').toLowerCase()
  const compact = words.replace(/\s+/g, '')
  if (/title|doc_title|paragraph_title|heading|标题|篇名/.test(value)) return 'title'
  if (/header|footer|number/.test(value)) return 'header_footer'
  if (/note|annotation|comment/.test(value)) return 'note'
  if (compact.length > 1 && compact.length <= 18 && /要闻|新闻|招生|出租|出售|来电|战局|参考|会议|选举|宪法|现状|广告|启事/.test(compact)) return 'title'
  return 'text'
}

function isFallbackTocTitle(title: string): boolean {
  const compact = String(title || '').replace(/\s+/g, '')
  if (compact.length < 2 || compact.length > 32) return false
  if (/^[|\-—–]+$/.test(compact)) return false
  return /要闻|新闻|招生|出租|出售|来电|战局|参考|会议|选举|宪法|现状|大公报|公告|广告|启事/.test(compact)
}

function buildFallbackHybridResult(page: VisionRefineSourcePage, message: string): VisionOcrResult | null {
  const baseText = String(page.ocr_text || '').trim()
  if (!baseText) return null
  const baseResult = parseOptionalJsonRecord(page.ocr_result)
  const layoutBlocks = asUnknownArray(readRecordValue(baseResult, 'layout_result'))
  const wordBlocks = asUnknownArray(readRecordValue(baseResult, 'words_result'))
  const sourceBlocks = layoutBlocks.length > 0 ? layoutBlocks : wordBlocks
  const layoutResult = sourceBlocks
    .map((block, index): VisionLayoutBlock => {
      const normalized = normalizeVisionBlock(block, index)
      const words = normalized.words
      const readingOrder = finiteNumber(readRecordValue(block, 'reading_order'))
      return {
        ...normalized,
        words,
        label: normalizeFallbackBlockLabel(readRecordValue(block, 'label'), words),
        reading_order: readingOrder === null ? index : readingOrder,
      }
    })
    .filter((block) => block.words)
  const tocCandidates = layoutResult
    .filter((block) => block.label === 'title' && isFallbackTocTitle(block.words))
    .map((block): VisionTocCandidate => ({
      title: String(block.words || '').split(/\n/)[0].trim(),
      level: /瑕佽仦|瑕侀椈/.test(String(block.words || '')) ? 1 : 2,
      entry_type: /出租|招生|启事|公告|广告/.test(String(block.words || '')) ? 'notice' : 'article',
      parent_title: '',
      pageNum: Number(page.page_num || 0) || null,
      confidence: 0.55,
    }))
  return {
    ...baseResult,
    source_type: 'hybrid_ocr_fallback',
    vision_refine_error: message,
    base_ocr_text: baseText,
    base_ocr_result: baseResult,
    corrected_text: baseText,
    correction_mode: 'fallback_base_ocr',
    correction_warnings: ['视觉模型校正失败，已保留传统 OCR 底稿。'],
    text: baseText,
    layout_result: layoutResult,
    words_result: layoutResult.length > 0
      ? layoutResult
      : baseText.split(/\n+/)
        .map((line, index): VisionLayoutBlock => ({
          words: line.trim(),
          label: 'text',
          reading_order: index,
          reading_order_source: 'source',
          confidence: null,
          column_index: null,
          location: null,
        }))
        .filter((block) => block.words),
    toc_candidates: tocCandidates,
    warnings: [...asUnknownArray(readRecordValue(baseResult, 'warnings')), '视觉模型整理失败，已使用传统 OCR 版面块生成临时目录和阅读结构。'],
  }
}

function mergeVisionRefinementWithBase(page: VisionRefineSourcePage, refined: VisionOcrResult): VisionOcrResult {
  const baseText = String(page.ocr_text || '').trim()
  const filteredRefined = filterVisionStructureAgainstBaseText(refined, baseText)
  const refinedText = String(filteredRefined.corrected_text || filteredRefined.text || '').trim()
  const refinedBlocks = toVisionLayoutBlocks(filteredRefined.layout_blocks)
  const refinedLayout = toVisionLayoutBlocks(filteredRefined.layout_result)
  const refinedWords = toVisionLayoutBlocks(filteredRefined.words_result)
  const normalizedLayout = refinedLayout.length > 0 ? refinedLayout : refinedBlocks
  const normalizedWords = refinedWords.length > 0 ? refinedWords : normalizedLayout
  if (baseText && refinedText.replace(/\s+/g, '').length < Math.max(120, baseText.replace(/\s+/g, '').length * 0.55)) {
    const nextWarnings = asUnknownArray(filteredRefined.warnings)
    return {
      ...filteredRefined,
      layout_result: normalizedLayout,
      words_result: normalizedWords,
      text: baseText,
      corrected_text: baseText,
      correction_mode: 'fallback_base_ocr_short_ai_output',
      correction_warnings: [...nextWarnings, 'AI 校正文过短，已保留传统 OCR 底稿。'],
      warnings: [...nextWarnings, '混合 OCR 已保留传统 OCR 全文；视觉模型仅用于版面、目录和栏目结构整理。'],
      hybrid_base_text_preserved: true,
      vision_structural_refine_only: false,
    }
  }
  return {
    ...filteredRefined,
    layout_result: normalizedLayout,
    words_result: normalizedWords,
    text: refinedText || baseText,
    corrected_text: refinedText || baseText,
    correction_mode: 'vision_corrected_ocr',
    correction_warnings: asUnknownArray(filteredRefined.correction_warnings),
  }
}

function looksLikeIncompleteNewspaperOcr(result: VisionOcrResult, docType?: string | null): boolean {
  const text = String(result.text || '')
  const blocks = toVisionLayoutBlocks(result.layout_result)
  const titleCount = blocks.filter((block) => String(block.label || '') === 'title').length
  const textBlocks = blocks.filter((block) => String(block.label || '') === 'text')
  const bodyLength = textBlocks.reduce((sum, block) => sum + String(block.words || '').replace(/\s+/g, '').length, 0)
  const typeText = `${docType || ''}`
  const newspaperLike = /报纸|新闻|newspaper/i.test(typeText) || titleCount >= 5
  if (!newspaperLike) return false
  if (titleCount >= 5 && textBlocks.length <= 2) return true
  if (titleCount >= 5 && bodyLength < titleCount * 35) return true
  if (text.length < 420 && titleCount >= 5) return true
  return false
}

async function callVisionModel(page: VisionSourcePage, settings: VisionOcrSettings, docType?: string | null): Promise<VisionOcrResult> {
  const pageNum = Number(page.page_num || 0)
  const plans = [
    { mode: 'structured', prompt: undefined as string | undefined, attempts: 3 },
    { mode: 'newspaper_full_text', prompt: buildVisionOcrNewspaperFullTextPrompt(pageNum), attempts: 2 },
    { mode: 'fallback_text', prompt: buildVisionOcrFallbackPrompt(pageNum), attempts: 2 },
  ]
  let lastError: unknown = null
  for (const plan of plans) {
    for (let attempt = 1; attempt <= plan.attempts; attempt += 1) {
      try {
        const result = await callVisionModelAttempt(page, settings, docType, plan.prompt, plan.mode)
        if (looksLikeIncompleteNewspaperOcr(result, docType) && plan.mode !== 'fallback_text') {
          throw new Error(`Vision OCR returned incomplete newspaper text: ${String(result.text || '').length} chars, ${Array.isArray(result.layout_result) ? result.layout_result.length : 0} layout blocks.`)
        }
        return { ...result, vision_retry_count: attempt - 1 }
      } catch (error) {
        lastError = error
        if (!isRetryableVisionError(error) && plan.mode === 'fallback_text') break
        if (!isRetryableVisionError(error) && attempt >= 2) break
        if (attempt < plan.attempts) {
          await sleep(Math.min(8000, 900 * attempt + Math.floor(Math.random() * 500)))
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Vision OCR request failed'))
}

export async function recognizePagesWithVisionModel(
  pages: VisionSourcePage[],
  docType?: string | null,
  onProgress?: (payload: VisionOcrProgressPayload) => void,
  profileId?: string,
): Promise<VisionOcrPageResult[]> {
  const settings = getVisionOcrSettings(profileId)
  const limit = createLimiter(settings.concurrency)
  let completedPages = 0
  let activePages = 0
  const totalPages = pages.length
  return Promise.all(pages.map((page) => limit(async () => {
    activePages += 1
    try {
      const startedAt = Date.now()
      onProgress?.({ pageId: page.id, pageNum: page.page_num ?? undefined, completedPages, totalPages, activePages, status: 'processing' })
      const result = await callVisionModel(page, settings, docType)
      completedPages += 1
      activePages = Math.max(0, activePages - 1)
      onProgress?.({
        pageId: page.id,
        pageNum: page.page_num ?? undefined,
        completedPages,
        totalPages,
        activePages,
        status: 'completed',
        elapsedMs: Date.now() - startedAt,
        imageBytes: result.image_original_bytes,
        uploadBytes: result.image_upload_bytes,
        result,
        text: result.text,
      })
      return { pageId: page.id, result, text: result.text, status: 'completed' as const }
    } catch (error) {
      completedPages += 1
      activePages = Math.max(0, activePages - 1)
      const message = (error as Error)?.message || String(error || '')
      onProgress?.({ pageId: page.id, pageNum: page.page_num ?? undefined, completedPages, totalPages, activePages, status: 'error', error: message })
      return { pageId: page.id, result: null, text: '', status: 'error' as const, error: message }
    }
  })))
}

export async function refinePagesWithVisionModel(
  pages: VisionRefineSourcePage[],
  docType?: string | null,
  onProgress?: (payload: VisionOcrProgressPayload) => void,
): Promise<VisionOcrPageResult[]> {
  const settings = getVisionOcrSettings()
  const limit = createLimiter(settings.concurrency)
  let completedPages = 0
  let activePages = 0
  const totalPages = pages.length
  return Promise.all(pages.map((page) => limit(async () => {
    activePages += 1
    try {
      const startedAt = Date.now()
      onProgress?.({ pageId: page.id, pageNum: page.page_num || undefined, completedPages, totalPages, activePages, status: 'processing' })
      const baseText = String(page.ocr_text || '').trim()
      if (!baseText) throw new Error('混合 OCR 缺少传统 OCR 底稿，无法进行视觉整理。')
      const result = await callVisionModelAttempt(
        page,
        settings,
        docType,
        buildVisionRefinePrompt(Number(page.page_num || 0), baseText),
        'hybrid_refine',
      )
      const baseOcrResult = parseOptionalJsonRecord(page.ocr_result)
      const merged = {
        ...mergeVisionRefinementWithBase(page, result),
        source_type: 'hybrid_ocr',
        base_ocr_source_type: fieldText(baseOcrResult, ['source_type']) || 'paddle_ocr',
        base_ocr_text: baseText,
        base_ocr_result: page.ocr_result || null,
        base_text_length: baseText.length,
        refined_text_length: getResultTextLength(result),
      }
      completedPages += 1
      activePages = Math.max(0, activePages - 1)
      onProgress?.({
        pageId: page.id,
        pageNum: page.page_num || undefined,
        completedPages,
        totalPages,
        activePages,
        status: 'completed',
        elapsedMs: Date.now() - startedAt,
        imageBytes: merged.image_original_bytes,
        uploadBytes: merged.image_upload_bytes,
        result: merged,
        text: merged.text,
      })
      return { pageId: page.id, result: merged, text: merged.text, status: 'completed' as const }
    } catch (error) {
      completedPages += 1
      activePages = Math.max(0, activePages - 1)
      const message = (error as Error)?.message || String(error || '')
      onProgress?.({ pageId: page.id, pageNum: page.page_num || undefined, completedPages, totalPages, activePages, status: 'error', error: message })
      const fallbackResult = buildFallbackHybridResult(page, message)
      if (fallbackResult) {
        return {
          pageId: page.id,
          result: fallbackResult,
          text: String(fallbackResult.text || ''),
          status: 'completed' as const,
          error: message,
        }
      }
      return { pageId: page.id, result: null, text: '', status: 'error' as const, error: message }
    }
  })))
}

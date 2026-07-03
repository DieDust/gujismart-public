import { ipcMain, dialog } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { basename, extname } from 'path'
import { queryAll, queryOne, run, saveDatabase } from '../database'
import { nanoid } from 'nanoid'
import { callLLM } from '../ai'
import JSZip from 'jszip'
import { getPdfJsNodeDocumentOptions } from '../pdfjs-assets'
import {
  CITATION_FORMAT_ORDER,
  CITATION_FORMAT_LABELS,
  CITATION_PLACEHOLDER_LABELS,
  mapDocTypeToHistoryCitationFormat,
} from '../../shared/history-citation'
import { buildCitationFieldResolutionReport } from '../../shared/citation-field-resolver'
import type {
  CitationFieldResolutionReport,
  CitationStyle,
  CitationGenerateOptions,
  CitationStyleDraft,
  CitationStyleDraftOptions,
  CitationStyleDraftWithRaw,
  CitationStylePayload,
  CitationStyleUpdatePayload,
  CitationTemplate,
  CitationTemplateDraft,
  CitationTemplateInference,
  CitationTemplatePayload,
  CitationTemplateUpdatePayload,
  Document,
} from '../../shared/types'

type CitationMetadata = Record<string, unknown>
type CitationDocumentRow = Pick<Document, 'title' | 'author' | 'dynasty' | 'source' | 'metadata'>
type CitationPageFieldKey = 'pages' | 'page_reference' | 'cite_pages'

export interface CitationWithDiagnostics {
  citation: string | null
  fieldReport: CitationFieldResolutionReport | null
}

const CITATION_PAGE_FIELD_KEYS: CitationPageFieldKey[] = ['pages', 'page_reference', 'cite_pages']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMetadata(value: unknown): CitationMetadata {
  if (!value || typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function requireQueryResult<T>(row: T | null, message: string): T {
  if (!row) throw new Error(message)
  return row
}

function ensureCitationSchema(): void {
  run(`
    CREATE TABLE IF NOT EXISTS citation_styles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  `)

  const columns = queryAll<{ name: string }>('PRAGMA table_info(citation_templates)')
  if (!columns.some((column) => column.name === 'style_id')) {
    run('ALTER TABLE citation_templates ADD COLUMN style_id TEXT')
  }

  const now = new Date().toISOString()
  run(
    `INSERT OR IGNORE INTO citation_styles (id, name, description, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['style_default_academic', '默认引用标准', '兼容旧引用模板的默认标准。', 1, now, now],
  )
  run("UPDATE citation_templates SET style_id = 'style_default_academic' WHERE style_id IS NULL OR style_id = ''")
  run('CREATE INDEX IF NOT EXISTS idx_citation_templates_style_id ON citation_templates(style_id)')
  run('CREATE INDEX IF NOT EXISTS idx_citation_templates_style_type ON citation_templates(style_id, format_type)')
  saveDatabase()
}

const FORMAT_TYPE_LABELS: Record<string, string> = {
  ...CITATION_FORMAT_LABELS,
  'GB-T7714': 'GB/T 7714',
  APA: 'APA',
  MLA: 'MLA',
  Chicago: 'Chicago',
  Custom: '自定义',
}

const CITATION_PLACEHOLDERS: Record<string, string> = {
  ...CITATION_PLACEHOLDER_LABELS,
  doi: 'DOI',
  isbn: 'ISBN',
  issn: 'ISSN',
}

function normalizeValue(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeValue(item))
      .filter(Boolean)
      .join('；')
  }
  return String(value).trim()
}

function pickMetadataValue(metadata: CitationMetadata, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeValue(metadata[key])
    if (value) return value
  }
  return ''
}

function stripWrappingPunctuation(value: string): string {
  return value
    .replace(/^[，,。；;：:\s]+|[，,。；;：:\s]+$/g, '')
    .trim()
}

function ensureChineseYear(value: string): string {
  const text = stripWrappingPunctuation(value)
  if (!text) return ''
  if (/\d{4}\s*年|不详|上|下|月|日/.test(text)) return text
  if (/^\d{4}$/.test(text)) return `${text} 年`
  return text
}

function ensurePageReference(value: string): string {
  const text = stripWrappingPunctuation(value)
  if (!text) return ''
  if (/^(第|p\.|pp\.|页|上册|下册|卷|册)/i.test(text) || /页|版|栏|a$|b$/i.test(text)) return text
  if (/^\d+([—-]\d+)?$/.test(text)) return `第 ${text} 页`
  return text
}

function joinCompact(...parts: string[]): string {
  return parts.map(stripWrappingPunctuation).filter(Boolean).join('')
}

function createCitationPageFieldOverrides(options?: CitationGenerateOptions): Partial<Record<CitationPageFieldKey, string>> {
  const overrides: Partial<Record<CitationPageFieldKey, string>> = {}
  const pageNum = normalizeValue(options?.pageNum)
  if (pageNum) {
    overrides.pages = pageNum
    overrides.cite_pages = pageNum
    overrides.page_reference = ensurePageReference(pageNum)
  }
  for (const key of CITATION_PAGE_FIELD_KEYS) {
    const value = normalizeValue(options?.fieldOverrides?.[key])
    if (!value) continue
    overrides[key] = key === 'page_reference' ? ensurePageReference(value) : value
  }
  return overrides
}

function createCitationFields(
  doc: CitationDocumentRow,
  metadata: CitationMetadata,
  options?: CitationGenerateOptions,
): Record<string, string> {
  const publicationYear = pickMetadataValue(metadata, 'publication_year', 'year')
  const publicationTime = pickMetadataValue(metadata, 'publication_time', 'publish_time', 'published_at')
    || ensureChineseYear(publicationYear)
  const pages = pickMetadataValue(metadata, 'pages', 'page_range', 'cite_pages')
  const archiveId = pickMetadataValue(metadata, 'archive_id', 'archive_number', '档号')
  const collection = pickMetadataValue(metadata, 'collection', '馆藏', 'source')
  const volumeIssue = pickMetadataValue(metadata, 'volume_issue')
    || joinCompact(
      pickMetadataValue(metadata, 'volume') ? `第 ${pickMetadataValue(metadata, 'volume')} 卷` : '',
      pickMetadataValue(metadata, 'issue') ? `第 ${pickMetadataValue(metadata, 'issue')} 期` : '',
    )

  const fields: Record<string, string> = {
    title: normalizeValue(doc.title) || pickMetadataValue(metadata, 'title'),
    author: normalizeValue(doc.author) || pickMetadataValue(metadata, 'author'),
    responsibility: pickMetadataValue(metadata, 'responsibility'),
    dynasty: normalizeValue(doc.dynasty) || pickMetadataValue(metadata, 'dynasty'),
    year: publicationYear || pickMetadataValue(metadata, 'date'),
    publication_year: publicationYear,
    publication_time: publicationTime,
    journal: pickMetadataValue(metadata, 'journal', 'container_title', 'source'),
    volume: pickMetadataValue(metadata, 'volume'),
    issue: pickMetadataValue(metadata, 'issue', 'number'),
    volume_issue: volumeIssue,
    issue_date: pickMetadataValue(metadata, 'issue_date', 'journal_issue', 'date') || (
      publicationYear && pickMetadataValue(metadata, 'issue') ? `${publicationYear} 年第 ${pickMetadataValue(metadata, 'issue')} 期` : ''
    ),
    pages,
    page_reference: pickMetadataValue(metadata, 'page_reference') || ensurePageReference(pages),
    doi: pickMetadataValue(metadata, 'doi'),
    isbn: pickMetadataValue(metadata, 'isbn'),
    issn: pickMetadataValue(metadata, 'issn'),
    publisher: pickMetadataValue(metadata, 'publisher'),
    publish_place: pickMetadataValue(metadata, 'publish_place', 'place', 'location'),
    source: normalizeValue(doc.source) || pickMetadataValue(metadata, 'source'),
    url: pickMetadataValue(metadata, 'url', 'link'),
    date: pickMetadataValue(metadata, 'date') || publicationTime,
    access_date: pickMetadataValue(metadata, 'access_date'),
    update_date: pickMetadataValue(metadata, 'update_date', 'modified_date', 'date'),
    medium: pickMetadataValue(metadata, 'medium'),
    archive_id: archiveId,
    collection,
    translator: pickMetadataValue(metadata, 'translator'),
    editor: pickMetadataValue(metadata, 'editor'),
    book_author: pickMetadataValue(metadata, 'book_author', 'collection_author'),
    book_responsibility: pickMetadataValue(metadata, 'book_responsibility', 'collection_responsibility'),
    book_title: pickMetadataValue(metadata, 'book_title', 'container_title'),
    edition: pickMetadataValue(metadata, 'edition'),
    edition_info: pickMetadataValue(metadata, 'edition_info'),
    version: pickMetadataValue(metadata, 'version', 'edition', 'engraving_style'),
    engraving_style: pickMetadataValue(metadata, 'engraving_style'),
    volume_info: pickMetadataValue(metadata, 'volume_info', '卷册', 'volume_title'),
    chapter: pickMetadataValue(metadata, 'chapter', '篇名', 'section'),
    page_side: pickMetadataValue(metadata, 'page_side'),
    column: pickMetadataValue(metadata, 'column'),
    series: pickMetadataValue(metadata, 'series'),
    series_volume: pickMetadataValue(metadata, 'series_volume'),
    degree_type: pickMetadataValue(metadata, 'degree_type'),
    university: pickMetadataValue(metadata, 'university', 'school'),
    location: pickMetadataValue(metadata, 'location', 'place', 'publish_place'),
    meeting_name: pickMetadataValue(metadata, 'meeting_name', 'conference'),
    original_author: pickMetadataValue(metadata, 'original_author'),
    original_title: pickMetadataValue(metadata, 'original_title'),
    original_source: pickMetadataValue(metadata, 'original_source'),
    original_pages: pickMetadataValue(metadata, 'original_pages'),
    cite_author: pickMetadataValue(metadata, 'cite_author'),
    cite_title: pickMetadataValue(metadata, 'cite_title'),
    cite_source: pickMetadataValue(metadata, 'cite_source'),
    cite_pages: pickMetadataValue(metadata, 'cite_pages'),
    newspaper: pickMetadataValue(metadata, 'newspaper', 'journal', 'source'),
    key: (doc.author || 'unknown').split(',')[0].trim().toLowerCase().replace(/\s+/g, '') + (publicationYear || new Date().getFullYear()),
  }
  return { ...fields, ...createCitationPageFieldOverrides(options) }
}

function cleanupCitationOutput(value: string): string {
  return value
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/《》/g, '')
    .replace(/“”/g, '')
    .replace(/（）|\(\)/g, '')
    .replace(/，\s*，/g, '，')
    .replace(/,\s*,/g, ',')
    .replace(/：\s*，/g, '：')
    .replace(/，\s*。/g, '。')
    .replace(/,\s*\./g, '.')
    .replace(/第\s*页/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s，,。；;：:]+|[\s，,；;：:]+$/g, '')
    .trim()
}

function parseJsonPayload(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || trimmed
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  const jsonText = firstBrace >= 0 && lastBrace > firstBrace
    ? candidate.slice(firstBrace, lastBrace + 1)
    : candidate
  return JSON.parse(jsonText)
}

function parseAnyJsonPayload(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || trimmed
  const firstBrace = candidate.indexOf('{')
  const firstBracket = candidate.indexOf('[')
  const starts = [firstBrace, firstBracket].filter((index) => index >= 0).sort((a, b) => a - b)
  const start = starts[0] ?? 0
  const closer = candidate[start] === '[' ? ']' : '}'
  const end = candidate.lastIndexOf(closer)
  const jsonText = end > start ? candidate.slice(start, end + 1) : candidate
  return JSON.parse(jsonText)
}

function normalizeTemplateText(templateText: string): string {
  let normalized = templateText.trim()
  normalized = normalized
    .replace(/｛｛/g, '{{')
    .replace(/｝｝/g, '}}')
    .replace(/(?<!\{)\{([a-z_]+)\}(?!\})/gi, '{{$1}}')

  return normalized
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function extractPdfText(filePath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument(getPdfJsNodeDocumentOptions({
    data: new Uint8Array(readFileSync(filePath)),
    disableFontFace: true,
  }))
  const pdf = await loadingTask.promise
  const pages: string[] = []
  const maxPages = Math.min(pdf.numPages, 40)

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    const items = Array.isArray((content as { items?: unknown }).items) ? (content as { items: unknown[] }).items : []
    const text = items
      .map((item) => (isRecord(item) && 'str' in item ? String(item.str) : ''))
      .filter(Boolean)
      .join(' ')
    if (text.trim()) pages.push(text)
  }

  await pdf.destroy()
  return normalizeWhitespace(pages.join('\n\n'))
}

async function extractDocxText(filePath: string): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(filePath))
  const documentXml = await zip.file('word/document.xml')?.async('string')
  if (!documentXml) return ''
  return normalizeWhitespace(
    documentXml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'"),
  )
}

async function extractCitationRuleText(filePath: string): Promise<string> {
  if (!filePath || !existsSync(filePath)) {
    throw new Error('规范文件不存在或无法访问。')
  }

  const ext = extname(filePath).toLowerCase()
  if (ext === '.pdf') return extractPdfText(filePath)
  if (ext === '.docx') return extractDocxText(filePath)
  if (['.txt', '.md', '.markdown'].includes(ext)) {
    return normalizeWhitespace(readFileSync(filePath, 'utf-8'))
  }

  throw new Error('暂只支持 PDF、DOCX、TXT 和 Markdown 格式的规范文件。')
}

function buildFormatGuide(): string {
  return CITATION_FORMAT_ORDER
    .map((key) => `- ${key}: ${FORMAT_TYPE_LABELS[key] || key}`)
    .join('\n')
}

function buildPlaceholderGuide(): string {
  return Object.entries(CITATION_PLACEHOLDERS)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n')
}

function sanitizeStyleName(value: unknown, fallbackName: string): string {
  const raw = String(value || '').trim()
  if (!raw) return `${fallbackName}注释体例`
  if (/体例|标准|格式|规范/.test(raw)) return raw.slice(0, 80)
  return `${raw.slice(0, 60)}注释体例`
}

function sanitizeTemplateDrafts(rawTemplates: unknown, styleName: string): CitationTemplateDraft[] {
  if (!Array.isArray(rawTemplates)) return []

  const allowedFormats = new Set(CITATION_FORMAT_ORDER)
  const allowedPlaceholders = new Set(Object.keys(CITATION_PLACEHOLDERS))
  const seen = new Set<string>()
  const templates: CitationTemplateDraft[] = []

  for (const item of rawTemplates) {
    const row = item as Record<string, unknown>
    const formatType = String(row?.format_type || row?.formatType || '').trim()
    if (!allowedFormats.has(formatType) || seen.has(formatType)) continue

    const templateText = normalizeTemplateText(String(row?.template_text || row?.templateText || ''))
    if (!templateText || !templateText.includes('{{')) continue

    const placeholders = Array.from(templateText.matchAll(/\{\{(\w+)\}\}/g)).map((match) => match[1])
    if (placeholders.some((key) => !allowedPlaceholders.has(key))) continue

    seen.add(formatType)
    templates.push({
      name: String(row?.name || `${styleName} / ${FORMAT_TYPE_LABELS[formatType] || formatType}`).trim().slice(0, 100),
      format_type: formatType,
      template_text: templateText,
      field_mappings: typeof row?.field_mappings === 'string' ? row.field_mappings : '{}',
      is_default: templates.length === 0 ? 1 : 0,
    })
  }

  return templates
}

async function inferCitationStyleFromRuleText(ruleText: string, sourceName: string): Promise<CitationStyleDraftWithRaw> {
  const clippedText = ruleText.slice(0, 26000)
  const baseName = basename(sourceName, extname(sourceName)).replace(/(引用|文献|注释|规范|格式|体例)+$/g, '') || basename(sourceName)
  const prompt = [
    '你是一个严谨的中文学术引文规范分析助手。',
    '用户会提供一份期刊、报纸、学校或机构的文献引用/注释规范。请把这份规范转换成软件可用的一整套引用标准。',
    '',
    '系统用“引用标准 style + 多个文献类型模板 template”的方式工作。模板中的可变部分必须使用 {{field}} 占位符。',
    '',
    '只允许使用以下文献类型 format_type：',
    buildFormatGuide(),
    '',
    '只允许使用以下占位符：',
    buildPlaceholderGuide(),
    '',
    '请返回严格 JSON，格式如下：',
    '{"styleName":"","description":"","templates":[{"name":"","format_type":"","template_text":"","notes":""}],"notes":""}',
    '',
    '要求：',
    '1. styleName 应从规范来源中提取，如“某某日报注释体例”“某某大学学位论文注释体例”。',
    '2. templates 至少生成专著、期刊论文、报纸、学位论文、电子文献；如果规范中出现其他类型，也要生成对应模板。',
    '3. template_text 必须直接可用于系统生成脚注，保留规范中的中文/英文标点、书名号、引号、顺序和固定文字。',
    '4. 不要发明占位符列表之外的字段；无法对应时选择最接近的占位符。',
    '5. 如果规范没有明确某类文献，可根据同一规范的规则谨慎推导，并在 notes 中说明。',
    '6. 不要把示例里的具体作者、题名、日期保留为固定文字，要替换成占位符。',
    '',
    `文件名：${sourceName}`,
    '',
    '规范正文：',
    clippedText,
  ].join('\n')

  const raw = await callLLM([{ role: 'user', content: prompt }])
  const parsed = parseAnyJsonPayload(raw) as Record<string, unknown>
  const styleName = sanitizeStyleName(parsed.styleName || parsed.name, baseName)
  const templates = sanitizeTemplateDrafts(parsed.templates, styleName)

  if (templates.length === 0) {
    throw new Error('AI 未能从规范文件中生成可用的引用模板，请换一份文字更清晰的规范文件再试。')
  }

  return {
    styleName,
    description: String(parsed.description || `由“${sourceName}”自动生成的引用注释体例。`).trim().slice(0, 300),
    templates,
    notes: String(parsed.notes || '').trim(),
    raw,
  }
}

function insertCitationStyleDraft(draft: CitationStyleDraft, isDefault?: boolean): CitationStyle {
  ensureCitationSchema()
  const id = nanoid()
  const now = new Date().toISOString()

  if (isDefault) {
    run('UPDATE citation_styles SET is_default = 0')
  }

  run(
    'INSERT INTO citation_styles (id, name, description, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, draft.styleName, draft.description || '', isDefault ? 1 : 0, now, now],
  )

  for (const template of draft.templates) {
    run(
      'INSERT INTO citation_templates (id, style_id, name, format_type, template_text, field_mappings, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        nanoid(),
        id,
        template.name,
        template.format_type,
        template.template_text,
        template.field_mappings || '{}',
        template.is_default || 0,
        now,
        now,
      ],
    )
  }

  saveDatabase()
  return requireQueryResult(
    queryOne<CitationStyle>('SELECT * FROM citation_styles WHERE id = ?', [id]),
    'Created citation style was not found',
  )
}

async function inferCitationTemplateFromSample(
  sampleText: string,
  preferredFormatType?: string,
): Promise<CitationTemplateInference & { raw: string }> {
  const placeholderGuide = Object.entries(CITATION_PLACEHOLDERS)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n')

  const formatGuide = Object.entries(FORMAT_TYPE_LABELS)
    .map(([key, label]) => `- ${key}: ${label}`)
    .join('\n')

  const prompt = [
    '你是一个学术引用格式模板提取助手。',
    '请根据用户提供的一条“已经确认正确”的引用示例，反推出可复用的模板。',
    '保留示例中的标点、顺序、连接词和版式，仅将可变信息替换为占位符。',
    '',
    '只允许使用以下占位符，格式必须是 {{field}}：',
    placeholderGuide,
    '',
    '可选的格式类型如下：',
    formatGuide,
    '',
    `用户偏好的格式类型：${preferredFormatType && FORMAT_TYPE_LABELS[preferredFormatType] ? preferredFormatType : '未指定'}`,
    '',
    '请返回严格 JSON，字段如下：',
    '{"nameSuggestion":"","formatType":"","templateText":"","notes":""}',
    '',
    '要求：',
    '1. templateText 必须可直接用于系统模板。',
    '2. 不要发明列表之外的占位符。',
    '3. 无法确定的固定文本保持原样。',
    '4. 如果判断不准，notes 里简短说明。',
    '',
    `示例引用：${sampleText.trim()}`,
  ].join('\n')

  const raw = await callLLM([{ role: 'user', content: prompt }])
  const parsed = parseJsonPayload(raw)

  const requestedType = preferredFormatType && FORMAT_TYPE_LABELS[preferredFormatType]
    ? preferredFormatType
    : 'Custom'
  const formatTypeCandidate = typeof parsed.formatType === 'string' ? parsed.formatType.trim() : ''
  const formatType = FORMAT_TYPE_LABELS[formatTypeCandidate] ? formatTypeCandidate : requestedType
  const templateText = normalizeTemplateText(String(parsed.templateText || ''))

  if (!templateText || !templateText.includes('{{')) {
    throw new Error('AI 未能识别出可用的引用模板，请换一条更完整的示例再试。')
  }

  return {
    nameSuggestion: typeof parsed.nameSuggestion === 'string' && parsed.nameSuggestion.trim()
      ? parsed.nameSuggestion.trim()
      : `AI 识别 / ${FORMAT_TYPE_LABELS[formatType] || '自定义'}`,
    formatType,
    templateText,
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '',
    raw,
  }
}

export function buildCitationWithDiagnostics(docId: string, templateId: string, options?: CitationGenerateOptions): CitationWithDiagnostics {
  ensureCitationSchema()
  const doc = queryOne<CitationDocumentRow>('SELECT title, author, dynasty, source, metadata FROM documents WHERE id = ?', [docId])
  if (!doc) return { citation: null, fieldReport: null }

  const template = queryOne<CitationTemplate>('SELECT * FROM citation_templates WHERE id = ?', [templateId])
  if (!template) return { citation: null, fieldReport: null }

  const metadata = parseMetadata(doc.metadata)

  const fields = createCitationFields(doc, metadata, options)

  let result = normalizeTemplateText(template.template_text as string)
  const fieldReport = buildCitationFieldResolutionReport(fields, result)
  for (const [key, value] of Object.entries(fields)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
  }
  return { citation: cleanupCitationOutput(result), fieldReport }
}

export function buildCitation(docId: string, templateId: string, options?: CitationGenerateOptions): string | null {
  return buildCitationWithDiagnostics(docId, templateId, options).citation
}

export function mapDocTypeToCitationFormat(docType: string): string {
  return mapDocTypeToHistoryCitationFormat(docType)
}

export function buildCitationByStyle(
  docId: string,
  styleId: string,
  docType?: string,
  options?: CitationGenerateOptions,
): string | null {
  ensureCitationSchema()
  const style = queryOne<CitationStyle>('SELECT * FROM citation_styles WHERE id = ?', [styleId])
  if (!style) return null

  const targetType = mapDocTypeToCitationFormat(docType || '')
  const template = queryOne<CitationTemplate>(
    `SELECT * FROM citation_templates
     WHERE style_id = ? AND format_type = ?
     ORDER BY is_default DESC, name ASC
     LIMIT 1`,
    [styleId, targetType],
  ) || queryOne<CitationTemplate>(
    `SELECT * FROM citation_templates
     WHERE style_id = ?
     ORDER BY is_default DESC, name ASC
     LIMIT 1`,
    [styleId],
  )

  return template?.id ? buildCitation(docId, template.id, options) : null
}

function getDefaultStyleId(): string | null {
  const style = queryOne<{ id?: string }>('SELECT id FROM citation_styles ORDER BY is_default DESC, name ASC LIMIT 1')
  return style?.id || null
}

export function registerCitationIpc(): void {
  ipcMain.handle('citation:selectRuleFile', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: '选择引用规范文件',
      properties: ['openFile'],
      filters: [
        { name: '引用规范文件', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown'] },
        { name: 'PDF 文档', extensions: ['pdf'] },
        { name: 'Word 文档', extensions: ['docx'] },
        { name: '文本文件', extensions: ['txt', 'md', 'markdown'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('citation:inferStyleFromRuleFile', async (_event, filePath: string): Promise<CitationStyleDraftWithRaw> => {
    ensureCitationSchema()
    const text = await extractCitationRuleText(filePath)
    if (!text || text.length < 80) {
      throw new Error('规范文件中可识别的文字太少，请确认文件不是扫描图片版，或先转成可复制文字的 PDF/DOCX/TXT。')
    }
    return inferCitationStyleFromRuleText(text, basename(filePath))
  })

  ipcMain.handle('citation:createStyleFromDraft', async (
    _event,
    draft: CitationStyleDraft,
    options?: CitationStyleDraftOptions,
  ): Promise<CitationStyle> => {
    ensureCitationSchema()
    const styleName = sanitizeStyleName(draft?.styleName, '新引用')
    const templates = sanitizeTemplateDrafts(draft?.templates, styleName)
    if (!templates.length) {
      throw new Error('没有可保存的引用模板。')
    }
    return insertCitationStyleDraft({
      styleName,
      description: String(draft?.description || '').trim(),
      templates,
      notes: String(draft?.notes || '').trim(),
    }, !!options?.is_default)
  })

  ipcMain.handle('citation:listStyles', async (): Promise<CitationStyle[]> => {
    ensureCitationSchema()
    const styles = queryAll<CitationStyle>('SELECT * FROM citation_styles ORDER BY is_default DESC, name')
    const templates = queryAll<CitationTemplate>('SELECT * FROM citation_templates ORDER BY format_type, is_default DESC, name')
    return styles.map((style) => ({
      ...style,
      templates: templates.filter((template) => template.style_id === style.id),
    }))
  })

  ipcMain.handle('citation:createStyle', async (_event, data: CitationStylePayload): Promise<CitationStyle> => {
    ensureCitationSchema()
    const id = nanoid()
    const now = new Date().toISOString()
    if (data.is_default) {
      run('UPDATE citation_styles SET is_default = 0')
    }
    run(
      'INSERT INTO citation_styles (id, name, description, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, data.name, data.description || '', data.is_default ? 1 : 0, now, now],
    )
    saveDatabase()
    return requireQueryResult(
      queryOne<CitationStyle>('SELECT * FROM citation_styles WHERE id = ?', [id]),
      'Created citation style was not found',
    )
  })

  ipcMain.handle('citation:updateStyle', async (_event, id: string, data: CitationStyleUpdatePayload): Promise<boolean> => {
    ensureCitationSchema()
    const allowedFields: Array<keyof CitationStyleUpdatePayload> = ['name', 'description', 'is_default']
    const sets: string[] = []
    const params: unknown[] = []
    if (data.is_default) {
      run('UPDATE citation_styles SET is_default = 0')
    }
    for (const field of allowedFields) {
      if (field in data) {
        sets.push(`${field} = ?`)
        params.push(field === 'is_default' ? (data[field] ? 1 : 0) : data[field])
      }
    }
    if (sets.length === 0) return false
    sets.push('updated_at = ?')
    params.push(new Date().toISOString(), id)
    run(`UPDATE citation_styles SET ${sets.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    return true
  })

  ipcMain.handle('citation:deleteStyle', async (_event, id: string): Promise<boolean> => {
    ensureCitationSchema()
    const count = queryOne<{ cnt?: number }>('SELECT COUNT(*) as cnt FROM citation_styles')
    if (Number(count?.cnt || 0) <= 1) throw new Error('至少需要保留一套引用标准')
    run('DELETE FROM citation_styles WHERE id = ?', [id])
    saveDatabase()
    return true
  })

  ipcMain.handle('citation:listTemplates', async (): Promise<CitationTemplate[]> => {
    ensureCitationSchema()
    return queryAll<CitationTemplate>('SELECT * FROM citation_templates ORDER BY is_default DESC, name')
  })

  ipcMain.handle('citation:getTemplate', async (_event, id: string): Promise<CitationTemplate | null> => {
    ensureCitationSchema()
    return queryOne<CitationTemplate>('SELECT * FROM citation_templates WHERE id = ?', [id])
  })

  ipcMain.handle('citation:createTemplate', async (_event, data: CitationTemplatePayload): Promise<CitationTemplate> => {
    ensureCitationSchema()
    const id = nanoid()
    const now = new Date().toISOString()
    const styleId = data.style_id || getDefaultStyleId()
    const templateText = normalizeTemplateText(data.template_text || '')
    run(
      'INSERT INTO citation_templates (id, style_id, name, format_type, template_text, field_mappings, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, styleId, data.name, data.format_type, templateText, data.field_mappings || '{}', data.is_default || 0, now, now]
    )
    saveDatabase()
    return requireQueryResult(
      queryOne<CitationTemplate>('SELECT * FROM citation_templates WHERE id = ?', [id]),
      'Created citation template was not found',
    )
  })

  ipcMain.handle('citation:updateTemplate', async (_event, id: string, data: CitationTemplateUpdatePayload): Promise<boolean> => {
    ensureCitationSchema()
    const allowedFields: Array<keyof CitationTemplateUpdatePayload> = ['name', 'style_id', 'format_type', 'template_text', 'field_mappings', 'is_default']
    const sets: string[] = []
    const params: unknown[] = []

    for (const field of allowedFields) {
      if (field in data) {
        sets.push(`${field} = ?`)
        let value = data[field]
        if (field === 'field_mappings' && typeof value !== 'string') {
          value = JSON.stringify(value)
        } else if (field === 'template_text') {
          value = normalizeTemplateText(String(value || ''))
        }
        params.push(value)
      }
    }

    if (sets.length === 0) return false

    sets.push('updated_at = ?')
    params.push(new Date().toISOString())
    params.push(id)

    run(`UPDATE citation_templates SET ${sets.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    return true
  })

  ipcMain.handle('citation:deleteTemplate', async (_event, id: string): Promise<boolean> => {
    ensureCitationSchema()
    run('DELETE FROM citation_templates WHERE id = ?', [id])
    saveDatabase()
    return true
  })

  ipcMain.handle('citation:generate', async (_event, docId: string, templateId: string, options?: CitationGenerateOptions): Promise<string> => {
    ensureCitationSchema()
    const result = buildCitation(docId, templateId, options)
    if (!result) throw new Error('文献或引用模板不存在')
    return result
  })

  ipcMain.handle('citation:generateBatch', async (_event, docIds: string[], templateId: string): Promise<string[]> => {
    ensureCitationSchema()
    const results: string[] = []
    for (const docId of docIds) {
      try {
        const citation = buildCitation(docId, templateId)
        if (citation) results.push(citation)
      } catch (e) {
        console.error(`Citation generation failed for ${docId}:`, e)
      }
    }
    return results
  })

  ipcMain.handle('citation:generateByStyle', async (
    _event,
    docId: string,
    styleId: string,
    docType?: string,
    options?: CitationGenerateOptions,
  ): Promise<string> => {
    ensureCitationSchema()
    const result = buildCitationByStyle(docId, styleId, docType, options)
    if (!result) throw new Error('文献或引用标准不存在')
    return result
  })

  ipcMain.handle('citation:inferTemplateFromSample', async (
    _event,
    sampleText: string,
    preferredFormatType?: string,
  ): Promise<CitationTemplateInference & { raw: string }> => {
    if (!sampleText || !sampleText.trim()) {
      throw new Error('请先粘贴一条已经确认正确的引用示例。')
    }
    return inferCitationTemplateFromSample(sampleText, preferredFormatType)
  })
}

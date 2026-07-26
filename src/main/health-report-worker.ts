import Database from 'better-sqlite3'
import { existsSync, statSync } from 'fs'
import { extname } from 'path'
import { parentPort } from 'worker_threads'
import { getErrorMessage } from '../shared/errors'
import type {
  Document,
  DocumentHealthIssue,
  DocumentHealthIssueType,
  DocumentHealthReport,
  DocumentHealthRow,
} from '../shared/types'
import type { HealthReportWorkerTask } from './health-report-worker-client'

type NativeDatabase = Database.Database
type JsonRecord = Record<string, unknown>

interface DocumentHealthSourceRow extends Document {
  text_page_count?: number | null
  ocr_completed_page_count?: number | null
  image_page_count?: number | null
  research_note_count?: number | null
  search_segment_count?: number | null
}

function queryAll<T = Record<string, unknown>>(sqlite: NativeDatabase, sql: string, params?: unknown[]): T[] {
  const statement = sqlite.prepare(sql)
  return params ? statement.all(...params) as T[] : statement.all() as T[]
}

function queryOne<T = Record<string, unknown>>(sqlite: NativeDatabase, sql: string, params?: unknown[]): T | null {
  const statement = sqlite.prepare(sql)
  const row = params ? statement.get(...params) : statement.get()
  return (row as T | undefined) || null
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDocumentMetadata(raw: unknown): JsonRecord {
  if (!raw) return {}
  if (isJsonRecord(raw)) return raw
  try {
    const parsed = JSON.parse(String(raw))
    return isJsonRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasValue)
  if (typeof value === 'number') return Number.isFinite(value)
  return String(value ?? '').trim().length > 0
}

function firstMetadataValue(metadata: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (hasValue(metadata[key])) return metadata[key]
  }
  return null
}

function buildPageContentAvailableCondition(alias = 'p'): string {
  return `(
    TRIM(COALESCE(NULLIF(${alias}.proofed_text, ''), NULLIF(${alias}.ocr_text, ''), '')) <> ''
    OR TRIM(COALESCE(${alias}.proofed_text_ref, ${alias}.ocr_text_ref, '')) <> ''
    OR (
      COALESCE(${alias}.ocr_status, '') = 'completed'
      AND TRIM(COALESCE(${alias}.ocr_result_ref, '')) <> ''
    )
    OR (
      TRIM(COALESCE(${alias}.ocr_result, '')) <> ''
      AND TRIM(COALESCE(${alias}.ocr_result, '')) <> '{"externalized":true}'
      AND NOT (
        COALESCE(${alias}.ocr_result, '') LIKE '%"error"%'
        AND COALESCE(${alias}.ocr_result, '') LIKE '%"failed_at"%'
      )
    )
  )`
}

function getPdfSizeBytes(doc: DocumentHealthSourceRow, metadata: JsonRecord): number {
  const metadataSize = Number(
    metadata.pdf_stored_size_bytes
      || metadata.file_size_bytes
      || metadata.pdf_compressed_size_bytes
      || metadata.pdf_size_bytes
      || 0,
  )
  if (Number.isFinite(metadataSize) && metadataSize > 0) return metadataSize

  const filePath = typeof doc.file_path === 'string' ? doc.file_path : ''
  if (filePath && extname(filePath).toLowerCase() === '.pdf' && existsSync(filePath)) {
    try {
      return statSync(filePath).size
    } catch {
      return 0
    }
  }
  return 0
}

function isReadableLocalAssetPath(filePath: unknown): boolean {
  const normalized = String(filePath || '').trim()
  if (!normalized || /^(?:https?|data):/i.test(normalized)) return false
  try {
    if (!existsSync(normalized)) return false
    const fileStat = statSync(normalized)
    return fileStat.isFile() && fileStat.size > 0
  } catch {
    return false
  }
}

function isReadableSourcePdf(doc: Pick<DocumentHealthSourceRow, 'file_path'>): boolean {
  const filePath = String(doc.file_path || '').trim()
  return extname(filePath).toLowerCase() === '.pdf' && isReadableLocalAssetPath(filePath)
}

function hasReadablePageImageForDocument(sqlite: NativeDatabase, docId: string, imagePageCount: number): boolean {
  if (imagePageCount <= 0) return false
  const rows = queryAll<{ image_path: string | null }>(
    sqlite,
    `SELECT image_path
     FROM pages
     WHERE doc_id = ?
       AND image_path IS NOT NULL
       AND TRIM(image_path) <> ''
     ORDER BY page_num ASC
     LIMIT 24`,
    [docId],
  )
  return rows.some((row) => isReadableLocalAssetPath(row.image_path))
}

function getHealthPdfAssetState(doc: DocumentHealthSourceRow, metadata: JsonRecord): string {
  const imagePageCount = Number(doc.image_page_count || 0)
  if (isReadableSourcePdf(doc) || imagePageCount > 0) return 'available'
  const explicitState = String(metadata.pdf_asset_state || '').trim()
  if (explicitState === 'text_only' || explicitState === 'available') return 'text_only'
  if (metadata.pdf_sha256 || metadata.pdf_size_bytes || metadata.pdf_page_count) return 'text_only'
  return 'unknown'
}

function addHealthIssue(
  issues: DocumentHealthIssue[],
  type: DocumentHealthIssueType,
  severity: DocumentHealthIssue['severity'],
  label: string,
  detail: string,
): void {
  issues.push({ type, severity, label, detail })
}

function buildDocumentHealthRow(doc: DocumentHealthSourceRow): DocumentHealthRow {
  const metadata = parseDocumentMetadata(doc.metadata)
  const pageCount = Number(doc.page_count || 0)
  const textPageCount = Number(doc.text_page_count || 0)
  const completedPageCount = Number(doc.ocr_completed_page_count || 0)
  const imagePageCount = Number(doc.image_page_count || 0)
  const researchNoteCount = Number(doc.research_note_count || 0)
  const searchSegmentCount = Number(doc.search_segment_count || 0)
  const pdfSizeBytes = getPdfSizeBytes(doc, metadata)
  const pdfAssetState = getHealthPdfAssetState(doc, metadata)
  const ocrStatus = pageCount > 0 && (completedPageCount >= pageCount || textPageCount >= pageCount)
    ? 'completed'
    : String(doc.ocr_status || 'pending')
  const issues: DocumentHealthIssue[] = []

  if (!hasValue(doc.author) && !hasValue(firstMetadataValue(metadata, ['author', 'authors', 'creator', 'editor', 'translator']))) {
    addHealthIssue(issues, 'missing_author', 'medium', '缺作者', '引用导出和 AI 综述会缺少责任者字段。')
  }
  if (!hasValue(firstMetadataValue(metadata, ['publication_year', 'year', 'publish_year', 'date', 'issue_date', 'publication_time']))) {
    addHealthIssue(issues, 'missing_year', 'medium', '缺年份', '按年代筛选、GB/T 7714 和 BibTeX 导出需要年份。')
  }
  if (!hasValue(firstMetadataValue(metadata, ['doi', 'DOI', 'isbn', 'ISBN', 'issn', 'identifier']))) {
    addHealthIssue(issues, 'missing_identifier', 'low', '缺标识符', 'DOI/ISBN/ISSN 为空，后续去重和规范引用会更吃力。')
  }
  if (!hasValue(firstMetadataValue(metadata, ['publisher', 'press', 'publisher_name']))) {
    addHealthIssue(issues, 'missing_publisher', 'low', '缺出版社', '图书、地方志或古籍类材料建议补出版社/出版机构。')
  }
  if (!hasValue(doc.source) && !hasValue(firstMetadataValue(metadata, ['source', 'journal', 'newspaper', 'book_title', 'collection', 'series', 'container_title']))) {
    addHealthIssue(issues, 'missing_source', 'medium', '缺来源', '期刊论文、章节和档案材料导出引用时会缺出处。')
  }

  const title = String(doc.title || '').trim()
  if (!title || /^(pdf合并|扫描|未命名|document|scan|image|new document)/i.test(title)) {
    addHealthIssue(issues, 'suspicious_title', 'medium', '题名疑似导入名', '建议从封面、目录或元数据推断真实题名。')
  }
  if (pageCount <= 0) {
    addHealthIssue(issues, 'zero_page', 'high', '零页', '文献页数为 0，通常是导入或 OCR 初始化失败留下的空记录。')
  }

  const docType = String(doc.doc_type || '').trim()
  if (!docType || docType === 'unknown' || docType === '其他') {
    addHealthIssue(issues, 'unknown_type', 'medium', '待分类', '文献类型会影响阅读器默认布局、引用模板和智能集合。')
  }

  const severityScore: Record<DocumentHealthIssue['severity'], number> = { high: 5, medium: 3, low: 1 }
  const riskScore = issues.reduce((sum, issue) => sum + severityScore[issue.severity], 0)

  return {
    id: String(doc.id),
    title: title || '未命名文献',
    author: doc.author || null,
    doc_type: docType || 'unknown',
    page_count: pageCount,
    file_path: doc.file_path || null,
    ocr_status: ocrStatus,
    proof_status: String(doc.proof_status || 'pending'),
    metadata_status: String(doc.metadata_status || 'pending'),
    read_status: String(doc.read_status || 'unread'),
    text_page_count: textPageCount,
    image_page_count: imagePageCount,
    research_note_count: researchNoteCount,
    search_segment_count: searchSegmentCount,
    pdf_size_bytes: pdfSizeBytes,
    pdf_asset_state: pdfAssetState,
    issues,
    risk_score: riskScore,
  }
}

function buildDocumentHealthReport(sqlite: NativeDatabase, libraryProjectId: string): DocumentHealthReport {
  const docs = queryAll<DocumentHealthSourceRow>(
    sqlite,
    `SELECT
      d.*,
      (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id AND ${buildPageContentAvailableCondition('p')}) as text_page_count,
      (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id AND p.ocr_status = 'completed' AND ${buildPageContentAvailableCondition('p')}) as ocr_completed_page_count,
      (SELECT COUNT(*) FROM pages p WHERE p.doc_id = d.id AND p.image_path IS NOT NULL AND TRIM(p.image_path) <> '') as image_page_count,
      (SELECT COUNT(*) FROM research_notes rn WHERE rn.doc_id = d.id AND rn.library_project_id = ?) as research_note_count,
      (SELECT COUNT(*) FROM search_index_segments sis WHERE sis.doc_id = d.id) as search_segment_count
    FROM documents d
    WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)`,
    [libraryProjectId, libraryProjectId],
  )
  const rows = docs
    .map((doc) => {
      const rawImagePageCount = Number(doc.image_page_count || 0)
      const readableImagePageCount = hasReadablePageImageForDocument(sqlite, String(doc.id), rawImagePageCount)
        ? rawImagePageCount
        : 0
      return buildDocumentHealthRow({ ...doc, image_page_count: readableImagePageCount })
    })
    .sort((left, right) => right.risk_score - left.risk_score || right.page_count - left.page_count || left.title.localeCompare(right.title, 'zh-Hans-CN'))
  const countIssue = (type: DocumentHealthIssueType) => rows.filter((row) => row.issues.some((issue) => issue.type === type)).length
  const pageStats = queryOne<{ total_pages: number; text_pages: number }>(
    sqlite,
    `SELECT
      COUNT(*) as total_pages,
      SUM(CASE WHEN ${buildPageContentAvailableCondition('pages')} THEN 1 ELSE 0 END) as text_pages
    FROM pages
    INNER JOIN documents d ON d.id = pages.doc_id
    WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)`,
    [libraryProjectId],
  )

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalDocuments: rows.length,
      totalPages: rows.reduce((sum, row) => sum + row.page_count, 0),
      pageRows: Number(pageStats?.total_pages || 0),
      textPages: Number(pageStats?.text_pages || 0),
      segments: Number(queryOne<{ count: number }>(
        sqlite,
        `SELECT COUNT(*) as count
         FROM search_index_segments sis
         INNER JOIN documents d ON d.id = sis.doc_id
         WHERE EXISTS (SELECT 1 FROM library_project_documents project_scope WHERE project_scope.document_id = d.id AND project_scope.project_id = ?)`,
        [libraryProjectId],
      )?.count || 0),
      tags: Number(queryOne<{ count: number }>(
        sqlite,
        'SELECT COUNT(*) as count FROM tags WHERE library_project_id = ?',
        [libraryProjectId],
      )?.count || 0),
      folders: Number(queryOne<{ count: number }>(
        sqlite,
        'SELECT COUNT(*) as count FROM folders WHERE library_project_id = ?',
        [libraryProjectId],
      )?.count || 0),
      researchProjects: Number(queryOne<{ count: number }>(
        sqlite,
        'SELECT COUNT(*) as count FROM research_projects WHERE library_project_id = ?',
        [libraryProjectId],
      )?.count || 0),
      researchNotes: Number(queryOne<{ count: number }>(
        sqlite,
        `SELECT COUNT(*) as count
         FROM research_notes rn
         WHERE rn.library_project_id = ?`,
        [libraryProjectId],
      )?.count || 0),
      missingAuthor: countIssue('missing_author'),
      missingYear: countIssue('missing_year'),
      missingIdentifier: countIssue('missing_identifier'),
      missingPublisher: countIssue('missing_publisher'),
      missingSource: countIssue('missing_source'),
      suspiciousTitle: countIssue('suspicious_title'),
      unknownType: countIssue('unknown_type'),
      zeroPage: countIssue('zero_page'),
      incompleteOcr: rows.filter((row) => row.ocr_status !== 'completed' || row.page_count <= 0).length,
    },
    rows,
  }
}

function runTask(task: HealthReportWorkerTask): DocumentHealthReport {
  const sqlite = new Database(task.dbFilePath)
  sqlite.pragma('busy_timeout = 5000')
  try {
    return buildDocumentHealthReport(sqlite, task.libraryProjectId)
  } finally {
    sqlite.close()
  }
}

parentPort?.on('message', (message: { type?: string; task?: HealthReportWorkerTask }) => {
  if (message?.type !== 'buildHealthReport' || !message.task) return
  try {
    parentPort?.postMessage({ type: 'result', report: runTask(message.task) })
  } catch (error: unknown) {
    parentPort?.postMessage({ type: 'error', error: getErrorMessage(error) })
  }
})

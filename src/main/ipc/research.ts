import { createHash } from 'crypto'
import { ipcMain } from 'electron'
import { nanoid } from 'nanoid'
import { callLLM, synthesizeDocumentIds } from '../ai'
import { queryAll, queryOne, run, saveDatabase } from '../database'
import { buildCitationByStyle } from './citation'
import type {
  AiSynthesisTemplate,
  Document,
  ResearchDashboardStats,
  ResearchKnowledgeKind,
  ResearchNote,
  ResearchNotePayload,
  ResearchNoteUpdatePayload,
  ResearchOutlineItem,
  ResearchOutlinePayload,
  ResearchOutlineUpdatePayload,
  ResearchOutput,
  ResearchOutputPayload,
  ResearchProject,
  ResearchProjectExportOptions,
  ResearchProjectExportResult,
  ResearchProjectPayload,
  ResearchProjectUpdatePayload,
  ResearchReferenceExportFormat,
} from '../../shared/types'

type ResearchMetadata = Record<string, unknown>
type ProjectRow = Pick<ResearchProject, 'id' | 'name' | 'description'>
type DocumentRow = Pick<Document, 'id' | 'title' | 'author' | 'source' | 'metadata' | 'created_at' | 'doc_type'>
type NoteRow = ResearchNote & { doc_title?: string | null; doc_type?: string | null }
type OutlineRow = ResearchOutlineItem

interface SynthesisSource {
  page_num: number
  snippet: string
  citation: string
}

interface SynthesisDocument {
  title: string
  text: string
  sources?: SynthesisSource[]
}

const KIND_LABELS: Record<ResearchKnowledgeKind, string> = {
  quote: '摘录',
  summary: '概述',
  comment: '评论',
  idea: '想法',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMetadata(raw: unknown): ResearchMetadata {
  if (!raw || typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function requireQueryResult<T>(row: T | null, message: string): T {
  if (!row) throw new Error(message)
  return row
}

function normalizeValue(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join('; ')
  return String(value).trim()
}

function normalizeTags(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).join(', ')
  return String(value || '').trim()
}

function normalizeKind(value: unknown): ResearchKnowledgeKind {
  return value === 'summary' || value === 'comment' || value === 'idea' ? value : 'quote'
}

function stableHash(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function stringifyLocator(data: ResearchNotePayload): string {
  if (typeof data.locator_json === 'string' && data.locator_json.trim()) return data.locator_json.trim()
  if (data.locator !== undefined) {
    try {
      return JSON.stringify(data.locator)
    } catch {
      return ''
    }
  }
  const legacy = data.source_id ?? data.sourceId
  return typeof legacy === 'string' ? legacy : ''
}

function normalizeNotePayload(data: ResearchNotePayload) {
  const docId = String(data.doc_id || data.docId || '').trim()
  const projectId = data.project_id ?? data.projectId ?? null
  const outlineId = data.outline_id ?? data.outlineId ?? null
  const pageNum = data.page_num ?? data.pageNum ?? null
  const excerpt = String(data.excerpt || '').trim()
  const locatorJson = stringifyLocator(data)
  const sourceHash = String(data.source_hash || data.sourceHash || '').trim()
    || stableHash([docId, pageNum || '', locatorJson || excerpt].join('|'))
  return {
    projectId: projectId ? String(projectId) : null,
    docId,
    pageNum: pageNum == null ? null : Number(pageNum) || null,
    excerpt,
    note: String(data.note || ''),
    tags: normalizeTags(data.tags),
    sourceType: data.source_type || data.sourceType || 'manual',
    sourceId: data.source_id ?? data.sourceId ?? null,
    kind: normalizeKind(data.kind),
    outlineId: outlineId ? String(outlineId) : null,
    color: String(data.color || ''),
    locatorJson,
    citationText: String(data.citation_text || data.citationText || ''),
    sourceHash,
    sortOrder: Number(data.sort_order || 0),
  }
}

function getCitationKey(doc: DocumentRow, metadata: ResearchMetadata): string {
  const author = normalizeValue(doc.author || metadata.author || 'unknown')
  const year = normalizeValue(
    metadata.publication_year ||
    metadata.year ||
    doc.created_at?.slice(0, 4) ||
    new Date().getFullYear(),
  )
  const title = normalizeValue(doc.title || metadata.title || 'document')
  return `${author.split(/[,\s，、]/)[0] || 'unknown'}${year}${title.slice(0, 8)}`
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .toLowerCase()
}

function buildBibtex(doc: DocumentRow): string {
  const metadata = parseMetadata(doc.metadata)
  const type = metadata.journal || metadata.doi ? 'article' : 'book'
  const fields: Record<string, string> = {
    author: normalizeValue(doc.author || metadata.author),
    title: normalizeValue(doc.title || metadata.title),
    year: normalizeValue(metadata.publication_year || metadata.year),
    journal: normalizeValue(metadata.journal || metadata.source || doc.source),
    publisher: normalizeValue(metadata.publisher),
    address: normalizeValue(metadata.publish_place),
    volume: normalizeValue(metadata.volume),
    number: normalizeValue(metadata.issue),
    pages: normalizeValue(metadata.pages),
    doi: normalizeValue(metadata.doi),
    url: normalizeValue(metadata.url),
  }
  const lines = Object.entries(fields)
    .filter(([, value]) => value)
    .map(([key, value]) => `  ${key} = {${value.replace(/[{}]/g, '')}}`)
  return `@${type}{${getCitationKey(doc, metadata)},\n${lines.join(',\n')}\n}`
}

function buildRis(doc: DocumentRow): string {
  const metadata = parseMetadata(doc.metadata)
  const type = metadata.journal || metadata.doi ? 'JOUR' : 'BOOK'
  const lines = [
    `TY  - ${type}`,
    `TI  - ${normalizeValue(doc.title || metadata.title)}`,
    `AU  - ${normalizeValue(doc.author || metadata.author)}`,
    `PY  - ${normalizeValue(metadata.publication_year || metadata.year)}`,
    `JO  - ${normalizeValue(metadata.journal || metadata.source || doc.source)}`,
    `PB  - ${normalizeValue(metadata.publisher)}`,
    `CY  - ${normalizeValue(metadata.publish_place)}`,
    `SP  - ${normalizeValue(metadata.pages)}`,
    `DO  - ${normalizeValue(metadata.doi)}`,
    `UR  - ${normalizeValue(metadata.url)}`,
    'ER  -',
  ]
  return lines.filter((line) => !line.endsWith(' - ')).join('\n')
}

function buildGbt7714(doc: DocumentRow): string {
  const metadata = parseMetadata(doc.metadata)
  const author = normalizeValue(doc.author || metadata.author) || '佚名'
  const title = normalizeValue(doc.title || metadata.title) || '未命名文献'
  const year = normalizeValue(metadata.publication_year || metadata.year)
  const journal = normalizeValue(metadata.journal || metadata.source || doc.source)
  const publisher = normalizeValue(metadata.publisher)
  const place = normalizeValue(metadata.publish_place)
  const pages = normalizeValue(metadata.pages)

  if (journal) {
    return `${author}. ${title}[J]. ${journal}${year ? `, ${year}` : ''}${pages ? `: ${pages}` : ''}.`
  }
  return `${author}. ${title}[M]. ${place ? `${place}: ` : ''}${publisher}${year ? `, ${year}` : ''}.`
}

function cleanupCitation(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/，\s*，/g, '，')
    .replace(/,\s*,/g, ',')
    .replace(/，\s*。/g, '。')
    .replace(/,\s*\./g, '.')
    .replace(/^[\s，,；;：:]+|[\s，,；;：:]+$/g, '')
    .trim()
}

function appendPageToCitation(citation: string, pageNum?: number | null): string {
  const base = cleanupCitation(citation)
  const page = Number(pageNum || 0)
  if (!base || !Number.isFinite(page) || page <= 0) return base
  const compact = base.replace(/\s+/g, '')
  if (compact.includes(`第${page}页`) || new RegExp(`(?:p|P)\\.?\\s*${page}(?:\\D|$)`).test(base)) {
    return base
  }
  const terminal = base.match(/[。.]$/)?.[0] || ''
  const body = terminal ? base.slice(0, -terminal.length).trim() : base
  return cleanupCitation(`${body}，第 ${page} 页${terminal}`)
}

function buildCitationFromStyle(
  doc: Pick<DocumentRow, 'id' | 'doc_type'>,
  citationStyleId?: string | null,
  pageNum?: number | null,
): string | null {
  const styleId = String(citationStyleId || '').trim()
  if (!styleId) return null
  const generated = buildCitationByStyle(doc.id, styleId, doc.doc_type || '', { pageNum: pageNum || null })
  return cleanupCitation(generated) || null
}

function buildReferenceCitation(
  doc: DocumentRow,
  format: ResearchReferenceExportFormat,
  citationStyleId?: string | null,
  pageNum?: number | null,
): string {
  if (format === 'bibtex') return buildBibtex(doc)
  if (format === 'ris') return buildRis(doc)
  const generated = buildCitationFromStyle(doc, citationStyleId, pageNum)
  if (generated) return generated
  const fallback = buildGbt7714(doc)
  return pageNum ? appendPageToCitation(fallback, pageNum) : fallback
}

function buildNoteFallbackCitation(note: NoteRow): string {
  const page = note.page_num ? `第 ${note.page_num} 页` : '页码待补'
  const base = cleanupCitation(note.citation_text)
    || [cleanupCitation(note.doc_author), cleanupCitation(note.doc_title) || '未命名文献'].filter(Boolean).join('，')
  return appendPageToCitation(base, note.page_num) || `${cleanupCitation(note.doc_title) || '未命名文献'}，${page}`
}

function buildNoteCitation(note: NoteRow, citationByNoteId: Map<string, string>): string {
  return citationByNoteId.get(note.id) || buildNoteFallbackCitation(note)
}

function buildNoteCitationMap(notes: NoteRow[], citationStyleId?: string | null): Map<string, string> {
  const styleId = String(citationStyleId || '').trim()
  const citations = new Map<string, string>()
  if (!styleId) return citations
  for (const note of notes) {
    const generated = cleanupCitation(buildCitationByStyle(note.doc_id, styleId, note.doc_type || '', { pageNum: note.page_num || null }))
    if (generated) citations.set(note.id, generated)
  }
  return citations
}

function getProjectDocIds(projectId: string): string[] {
  return queryAll<{ doc_id: string }>(
    'SELECT doc_id FROM research_project_documents WHERE project_id = ? ORDER BY created_at DESC',
    [projectId],
  ).map((item) => item.doc_id)
}

function getProjectDocs(projectId: string): DocumentRow[] {
  const docIds = getProjectDocIds(projectId)
  if (docIds.length === 0) return []
  const placeholders = docIds.map(() => '?').join(', ')
  return queryAll<DocumentRow>(`SELECT * FROM documents WHERE id IN (${placeholders}) ORDER BY author, title`, docIds)
}

function listOutline(projectId: string): OutlineRow[] {
  return queryAll<OutlineRow>(
    `SELECT roi.*,
       (SELECT COUNT(*) FROM research_notes rn WHERE rn.outline_id = roi.id) as note_count
     FROM research_outline_items roi
     WHERE roi.project_id = ?
     ORDER BY roi.sort_order ASC, roi.created_at ASC`,
    [projectId],
  )
}

function listNotes(projectId?: string | null): NoteRow[] {
  const params = projectId ? [projectId] : []
  return queryAll<NoteRow>(
    `SELECT rn.*,
       d.title as doc_title,
       d.author as doc_author,
       d.doc_type as doc_type,
       CASE
         WHEN EXISTS (SELECT 1 FROM pages p WHERE p.doc_id = rn.doc_id AND (rn.page_num IS NULL OR p.page_num = rn.page_num)) THEN 1
         ELSE 0
       END as source_available
     FROM research_notes rn
     INNER JOIN documents d ON rn.doc_id = d.id
     ${projectId ? 'WHERE rn.project_id = ?' : ''}
     ORDER BY COALESCE(rn.sort_order, 0) ASC, rn.updated_at DESC`,
    params,
  )
}

function findDuplicateNote(note: ReturnType<typeof normalizeNotePayload>, excludeId?: string): { id: string } | null {
  const params: unknown[] = [note.docId, note.sourceHash]
  let excludeSql = ''
  if (excludeId) {
    excludeSql = 'AND id != ?'
    params.push(excludeId)
  }
  if (note.sourceHash) {
    const byHash = queryOne<{ id: string }>(
      `SELECT id FROM research_notes
       WHERE doc_id = ? AND source_hash = ? ${excludeSql}
       LIMIT 1`,
      params,
    )
    if (byHash) return byHash
  }
  if (note.locatorJson) return null
  const excerptParams: unknown[] = [note.docId, note.excerpt]
  if (excludeId) excerptParams.push(excludeId)
  return queryOne<{ id: string }>(
    `SELECT id FROM research_notes
     WHERE doc_id = ? AND excerpt = ? ${excludeId ? 'AND id != ?' : ''}
     LIMIT 1`,
    excerptParams,
  )
}

function attachDocToProject(projectId: string | null, docId: string, now: string): void {
  if (!projectId) return
  run(
    'INSERT OR IGNORE INTO research_project_documents (project_id, doc_id, created_at) VALUES (?, ?, ?)',
    [projectId, docId, now],
  )
  run('UPDATE research_projects SET updated_at = ? WHERE id = ?', [now, projectId])
}

function getProjectSynthesisTexts(projectId: string, citationStyleId?: string | null): SynthesisDocument[] {
  const notes = queryAll<NoteRow>(
    `SELECT rn.*, d.title as doc_title, d.author as doc_author, d.doc_type as doc_type
     FROM research_notes rn
     INNER JOIN documents d ON rn.doc_id = d.id
     WHERE rn.project_id = ?
     ORDER BY rn.outline_id IS NULL, rn.sort_order ASC, d.title ASC, rn.page_num ASC, rn.created_at ASC`,
    [projectId],
  )

  if (notes.length > 0) {
    const grouped = new Map<string, { title: string; text: string; sources: SynthesisSource[] }>()
    const citationByNoteId = buildNoteCitationMap(notes, citationStyleId)
    for (const item of notes) {
      const current =
        grouped.get(item.doc_id) ||
        {
          title: item.doc_title || '未命名文献',
          text: '',
          sources: [] as SynthesisSource[],
        }

      const pageLabel = item.page_num ? `第 ${item.page_num} 页` : '未标页码'
      const citation = buildNoteCitation(item, citationByNoteId)
      current.text += `[${KIND_LABELS[item.kind] || '摘录'}][${pageLabel}] ${item.excerpt}${item.note ? `\n研究备注：${item.note}` : ''}\n\n`
      current.sources.push({
        page_num: Number(item.page_num || 0),
        snippet: item.excerpt,
        citation,
      })
      grouped.set(item.doc_id, current)
    }
    return [...grouped.values()]
  }

  const docs = getProjectDocs(projectId)
  return docs.map((doc) => {
    const pages = queryAll<{ page_num: number; text: string }>(
      "SELECT page_num, COALESCE(proofed_text, ocr_text, '') as text FROM pages WHERE doc_id = ? ORDER BY page_num",
      [doc.id],
    )
    return {
      title: doc.title || '未命名文献',
      text: pages.map((page) => `[第 ${page.page_num} 页]\n${page.text}`).join('\n\n').trim(),
      sources: pages
        .filter((page) => page.text)
        .slice(0, 5)
        .map((page) => ({
          page_num: page.page_num,
          snippet: page.text.slice(0, 180),
          citation: buildReferenceCitation(doc, 'gbt7714', citationStyleId, page.page_num),
        })),
    }
  }).filter((item) => item.text)
}

async function synthesizeProjectWithSources(
  texts: SynthesisDocument[],
  templateType: AiSynthesisTemplate,
  customPrompt?: string,
): Promise<string> {
  const templatePrompts: Partial<Record<AiSynthesisTemplate, string>> = {
    literature_review: '请写一份跨文献研究综述。先概括当前专题材料共同呈现的研究格局，再梳理研究脉络、核心议题、方法差异、关键分歧和研究空白；不要按文献顺序逐篇复述。',
    summary: '请生成专题综合摘要。重点说明这些材料合在一起揭示了什么、形成了哪些共识或分歧、哪些证据最关键、后续还缺什么；不要逐篇概括。',
    theme_analysis: '请按主题提炼共同问题、分歧、关键争议和相互关系。每个主题下综合多篇材料，只在代表性证据处点名文献。',
    timeline: '请按时间线或发展阶段整理观点、事件、材料变化或研究发展。每个阶段说明变化逻辑、代表性证据和仍待补证之处。',
    debate: '请整理主要争议点，按议题、不同解释、证据强弱、反证和可继续阅读组织。不要按文献清单展开。',
    reading_list: '请生成待读清单，说明阅读优先级、阅读理由和重点页码。',
    custom: customPrompt || '请根据材料生成研究分析。',
  }

  const corpus = texts.map((item, index) => {
    const sourceLines = (item.sources || [])
      .slice(0, 12)
      .map((source) => `- ${source.citation || `${item.title}，第 ${source.page_num || '?'} 页`}：${source.snippet.slice(0, 220)}`)
      .join('\n')

    return [
      `【文献 ${index + 1}】${item.title}`,
      item.text.slice(0, 2600),
      sourceLines ? `可引用来源：\n${sourceLines}` : '',
    ].filter(Boolean).join('\n\n')
  }).join('\n\n---\n\n')

  const systemPrompt = [
    templatePrompts[templateType] || templatePrompts.literature_review,
    '必须使用中文输出。',
    '先给总体判断，再分主题或阶段展开；除非用户明确要求，不要按检索结果、摘录顺序或文献顺序逐篇复述。',
    '请把结论限定为“当前专题材料显示/提示”，不要把有限材料直接说成整个领域的完整现状。',
    '凡涉及具体观点、事实、结论或比较，都必须标注来源，格式为“（文献标题，第 X 页）”。',
    '优先引用“可引用来源”中的摘录；如果证据不足，请明确标注“证据不足”。',
    '结尾增加“可继续追问的问题”小节，列出 3 个下一步研究问题。',
  ].join('\n')

  return callLLM([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `以下是专题材料和可引用来源：\n\n${corpus}` },
  ])
}

function renderNoteMarkdown(note: NoteRow, citationByNoteId: Map<string, string>): string {
  const citation = buildNoteCitation(note, citationByNoteId)
  const sourceState = note.source_available ? '' : '\n> 原文待恢复'
  const body = note.kind === 'quote'
    ? `> ${note.excerpt.replace(/\n/g, '\n> ')}`
    : `**${KIND_LABELS[note.kind]}**：${note.excerpt}`
  return [
    body,
    sourceState,
    note.note ? `\n备注：${note.note}` : '',
    `\n来源：${citation}`,
    note.tags ? `\n标签：${note.tags}` : '',
  ].filter(Boolean).join('\n')
}

function renderProjectMarkdown(
  project: ProjectRow,
  outline: OutlineRow[],
  notes: NoteRow[],
  references: string,
  citationByNoteId: Map<string, string>,
): string {
  const byOutline = new Map<string | null, NoteRow[]>()
  for (const note of notes) {
    const key = note.outline_id || null
    byOutline.set(key, [...(byOutline.get(key) || []), note])
  }

  const lines: string[] = [
    `# ${project.name}`,
    '',
    project.description ? `> ${project.description}` : '',
    '',
  ].filter(Boolean)

  const rootItems = outline.filter((item) => !item.parent_id)
  const childrenByParent = new Map<string, OutlineRow[]>()
  for (const item of outline) {
    if (!item.parent_id) continue
    childrenByParent.set(item.parent_id, [...(childrenByParent.get(item.parent_id) || []), item])
  }

  const renderSection = (item: OutlineRow, depth = 2) => {
    lines.push(`${'#'.repeat(Math.min(depth, 5))} ${item.title}`, '')
    if (item.description) lines.push(item.description, '')
    for (const note of byOutline.get(item.id) || []) {
      lines.push(renderNoteMarkdown(note, citationByNoteId), '')
    }
    for (const child of childrenByParent.get(item.id) || []) renderSection(child, depth + 1)
  }

  for (const item of rootItems) renderSection(item)

  const unassigned = byOutline.get(null) || []
  if (unassigned.length > 0) {
    lines.push('## 未归入大纲的摘录', '')
    for (const note of unassigned) lines.push(renderNoteMarkdown(note, citationByNoteId), '')
  }

  if (references.trim()) {
    lines.push('## 参考文献', '', references.trim(), '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

export function registerResearchIpc(): void {
  ipcMain.handle('research:listProjects', async (): Promise<ResearchProject[]> => {
    return queryAll<ResearchProject>(
      `SELECT rp.*,
        (SELECT COUNT(*) FROM research_project_documents rpd WHERE rpd.project_id = rp.id) as document_count,
        (SELECT COUNT(*) FROM research_notes rn WHERE rn.project_id = rp.id) as note_count,
        (SELECT COUNT(*) FROM research_outputs ro WHERE ro.project_id = rp.id) as output_count,
        (SELECT COUNT(*) FROM research_outline_items roi WHERE roi.project_id = rp.id) as outline_count,
        (SELECT COUNT(*) FROM ai_research_datasets ard WHERE ard.project_id = rp.id) as ai_dataset_count
       FROM research_projects rp
       ORDER BY rp.updated_at DESC`,
    )
  })

  ipcMain.handle('research:createProject', async (_event, data: ResearchProjectPayload): Promise<ResearchProject> => {
    const name = String(data.name || '').trim()
    if (!name) throw new Error('请输入专题名称')

    const id = nanoid()
    const now = new Date().toISOString()
    run(
      'INSERT INTO research_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name, data.description || '', data.status || 'active', now, now],
    )
    saveDatabase()
    return requireQueryResult(
      queryOne<ResearchProject>('SELECT * FROM research_projects WHERE id = ?', [id]),
      'Created research project was not found',
    )
  })

  ipcMain.handle('research:updateProject', async (_event, id: string, data: ResearchProjectUpdatePayload): Promise<boolean> => {
    const sets: string[] = []
    const params: unknown[] = []
    if ('name' in data) {
      sets.push('name = ?')
      params.push(String(data.name || '').trim())
    }
    if ('description' in data) {
      sets.push('description = ?')
      params.push(data.description || '')
    }
    if ('status' in data) {
      sets.push('status = ?')
      params.push(data.status || 'active')
    }
    if (sets.length === 0) return false
    sets.push('updated_at = ?')
    params.push(new Date().toISOString(), id)
    run(`UPDATE research_projects SET ${sets.join(', ')} WHERE id = ?`, params)
    saveDatabase()
    return true
  })

  ipcMain.handle('research:deleteProject', async (_event, id: string): Promise<boolean> => {
    run('DELETE FROM research_notes WHERE project_id = ?', [id])
    run('DELETE FROM research_outline_items WHERE project_id = ?', [id])
    run('DELETE FROM research_outputs WHERE project_id = ?', [id])
    run('DELETE FROM research_project_documents WHERE project_id = ?', [id])
    run('DELETE FROM research_projects WHERE id = ?', [id])
    saveDatabase()
    return true
  })

  ipcMain.handle('research:listOutline', async (_event, projectId: string): Promise<ResearchOutlineItem[]> => listOutline(projectId))

  ipcMain.handle('research:createOutlineItem', async (_event, data: ResearchOutlinePayload): Promise<ResearchOutlineItem> => {
    const projectId = String(data.project_id || '').trim()
    const title = String(data.title || '').trim()
    if (!projectId || !title) throw new Error('大纲节点需要专题和标题')
    const now = new Date().toISOString()
    const id = nanoid()
    const sortOrder = Number.isFinite(Number(data.sort_order))
      ? Number(data.sort_order)
      : Number(queryOne<{ max_order: number }>('SELECT MAX(sort_order) as max_order FROM research_outline_items WHERE project_id = ?', [projectId])?.max_order || 0) + 10
    run(
      `INSERT INTO research_outline_items (id, project_id, parent_id, title, description, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, projectId, data.parent_id || null, title, data.description || '', sortOrder, now, now],
    )
    run('UPDATE research_projects SET updated_at = ? WHERE id = ?', [now, projectId])
    saveDatabase()
    return requireQueryResult(
      queryOne<ResearchOutlineItem>('SELECT * FROM research_outline_items WHERE id = ?', [id]),
      'Created research outline item was not found',
    )
  })

  ipcMain.handle('research:updateOutlineItem', async (_event, id: string, data: ResearchOutlineUpdatePayload): Promise<boolean> => {
    const current = queryOne<OutlineRow>('SELECT * FROM research_outline_items WHERE id = ?', [id])
    if (!current) throw new Error('未找到大纲节点')
    const sets: string[] = []
    const params: unknown[] = []
    if ('title' in data) {
      const title = String(data.title || '').trim()
      if (!title) throw new Error('大纲标题不能为空')
      sets.push('title = ?')
      params.push(title)
    }
    if ('description' in data) {
      sets.push('description = ?')
      params.push(data.description || '')
    }
    if ('parent_id' in data) {
      sets.push('parent_id = ?')
      params.push(data.parent_id || null)
    }
    if ('sort_order' in data) {
      sets.push('sort_order = ?')
      params.push(Number(data.sort_order || 0))
    }
    if (sets.length === 0) return false
    const now = new Date().toISOString()
    sets.push('updated_at = ?')
    params.push(now, id)
    run(`UPDATE research_outline_items SET ${sets.join(', ')} WHERE id = ?`, params)
    run('UPDATE research_projects SET updated_at = ? WHERE id = ?', [now, current.project_id])
    saveDatabase()
    return true
  })

  ipcMain.handle('research:deleteOutlineItem', async (_event, id: string): Promise<boolean> => {
    const current = queryOne<OutlineRow>('SELECT * FROM research_outline_items WHERE id = ?', [id])
    if (!current) return true
    run('UPDATE research_notes SET outline_id = NULL WHERE outline_id = ?', [id])
    run('DELETE FROM research_outline_items WHERE id = ?', [id])
    run('UPDATE research_projects SET updated_at = ? WHERE id = ?', [new Date().toISOString(), current.project_id])
    saveDatabase()
    return true
  })

  ipcMain.handle('research:moveOutlineItem', async (_event, id: string, parentId: string | null, sortOrder: number): Promise<boolean> => {
    const current = queryOne<OutlineRow>('SELECT * FROM research_outline_items WHERE id = ?', [id])
    if (!current) throw new Error('未找到大纲节点')
    const now = new Date().toISOString()
    run('UPDATE research_outline_items SET parent_id = ?, sort_order = ?, updated_at = ? WHERE id = ?', [parentId || null, Number(sortOrder || 0), now, id])
    run('UPDATE research_projects SET updated_at = ? WHERE id = ?', [now, current.project_id])
    saveDatabase()
    return true
  })

  ipcMain.handle('research:addDocuments', async (_event, projectId: string, docIds: string[]): Promise<boolean> => {
    const now = new Date().toISOString()
    for (const docId of [...new Set(docIds.filter(Boolean))]) {
      attachDocToProject(projectId, docId, now)
    }
    saveDatabase()
    return true
  })

  ipcMain.handle('research:removeDocument', async (_event, projectId: string, docId: string): Promise<boolean> => {
    run('DELETE FROM research_project_documents WHERE project_id = ? AND doc_id = ?', [projectId, docId])
    run('UPDATE research_projects SET updated_at = ? WHERE id = ?', [new Date().toISOString(), projectId])
    saveDatabase()
    return true
  })

  ipcMain.handle('research:listProjectDocuments', async (_event, projectId: string): Promise<Document[]> => {
    return queryAll<Document>(
      `SELECT d.*
       FROM documents d
       INNER JOIN research_project_documents rpd ON d.id = rpd.doc_id
       WHERE rpd.project_id = ?
       ORDER BY rpd.created_at DESC`,
      [projectId],
    )
  })

  ipcMain.handle('research:createNote', async (_event, data: ResearchNotePayload): Promise<ResearchNote> => {
    const note = normalizeNotePayload(data)
    if (!note.docId || !note.excerpt) throw new Error('摘录需要文献和原文内容')
    const duplicate = findDuplicateNote(note)
    if (duplicate) {
      throw new Error('这条摘录已经保存过')
    }

    const id = nanoid()
    const now = new Date().toISOString()
    run(
      `INSERT INTO research_notes (
        id, project_id, doc_id, page_num, excerpt, note, tags, source_type, source_id,
        kind, outline_id, color, locator_json, citation_text, source_hash, sort_order,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        note.projectId,
        note.docId,
        note.pageNum,
        note.excerpt,
        note.note,
        note.tags,
        note.sourceType,
        note.sourceId,
        note.kind,
        note.outlineId,
        note.color,
        note.locatorJson,
        note.citationText,
        note.sourceHash,
        note.sortOrder,
        now,
        now,
      ],
    )
    attachDocToProject(note.projectId, note.docId, now)
    saveDatabase()
    return requireQueryResult(
      queryOne<ResearchNote>('SELECT * FROM research_notes WHERE id = ?', [id]),
      'Created research note was not found',
    )
  })

  ipcMain.handle('research:updateNote', async (_event, id: string, data: ResearchNoteUpdatePayload): Promise<boolean> => {
    const current = queryOne<NoteRow>('SELECT * FROM research_notes WHERE id = ?', [id])
    if (!current) throw new Error('未找到摘录')
    const next = normalizeNotePayload({
      project_id: current.project_id,
      doc_id: current.doc_id,
      page_num: current.page_num,
      excerpt: current.excerpt,
      note: current.note,
      tags: current.tags,
      source_type: current.source_type,
      source_id: current.source_id,
      kind: current.kind,
      outline_id: current.outline_id,
      color: current.color,
      locator_json: current.locator_json,
      citation_text: current.citation_text,
      source_hash: current.source_hash,
      sort_order: current.sort_order,
      ...data,
    })
    const duplicate = findDuplicateNote(next, id)
    if (duplicate) throw new Error('这条摘录已经保存过')
    const now = new Date().toISOString()
    run(
      `UPDATE research_notes
       SET project_id = ?, doc_id = ?, page_num = ?, excerpt = ?, note = ?, tags = ?,
           source_type = ?, source_id = ?, kind = ?, outline_id = ?, color = ?,
           locator_json = ?, citation_text = ?, source_hash = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.projectId,
        next.docId,
        next.pageNum,
        next.excerpt,
        next.note,
        next.tags,
        next.sourceType,
        next.sourceId,
        next.kind,
        next.outlineId,
        next.color,
        next.locatorJson,
        next.citationText,
        next.sourceHash,
        next.sortOrder,
        now,
        id,
      ],
    )
    attachDocToProject(next.projectId, next.docId, now)
    saveDatabase()
    return true
  })

  ipcMain.handle('research:assignNotesToOutline', async (_event, noteIds: string[], outlineId: string | null): Promise<boolean> => {
    const ids = [...new Set((noteIds || []).map((item) => String(item || '').trim()).filter(Boolean))]
    if (ids.length === 0) return true
    const now = new Date().toISOString()
    for (const id of ids) {
      run('UPDATE research_notes SET outline_id = ?, updated_at = ? WHERE id = ?', [outlineId || null, now, id])
    }
    saveDatabase()
    return true
  })

  ipcMain.handle('research:listNotes', async (_event, projectId?: string | null): Promise<ResearchNote[]> => listNotes(projectId))

  ipcMain.handle('research:deleteNote', async (_event, id: string): Promise<boolean> => {
    run('DELETE FROM research_notes WHERE id = ?', [id])
    saveDatabase()
    return true
  })

  ipcMain.handle('research:synthesizeProject', async (
    _event,
    projectId: string,
    templateType: AiSynthesisTemplate,
    customPrompt?: string,
    citationStyleId?: string,
  ): Promise<ResearchOutput> => {
    const project = queryOne<ProjectRow>('SELECT * FROM research_projects WHERE id = ?', [projectId])
    if (!project) throw new Error('专题不存在')

    const noteCount = Number(queryOne<{ count: number }>('SELECT COUNT(*) as count FROM research_notes WHERE project_id = ?', [projectId])?.count || 0)
    if (noteCount === 0) {
      const docIds = getProjectDocIds(projectId)
      if (docIds.length > 0) {
        const content = await synthesizeDocumentIds(docIds, templateType, customPrompt)
        const id = nanoid()
        run(
          'INSERT INTO research_outputs (id, project_id, output_type, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, projectId, templateType, `${project.name} - AI 研究综述`, content, new Date().toISOString()],
        )
        saveDatabase()
        return requireQueryResult(
          queryOne<ResearchOutput>('SELECT * FROM research_outputs WHERE id = ?', [id]),
          'Created research output was not found',
        )
      }
    }

    const texts = getProjectSynthesisTexts(projectId, citationStyleId)
    if (texts.length === 0) {
      throw new Error('专题中还没有可用于综述的 OCR 文本或研究摘录')
    }
    const content = await synthesizeProjectWithSources(texts, templateType, customPrompt)
    const id = nanoid()
    run(
      'INSERT INTO research_outputs (id, project_id, output_type, title, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, projectId, templateType, `${project.name} - AI 研究综述`, content, new Date().toISOString()],
    )
    saveDatabase()
    return requireQueryResult(
      queryOne<ResearchOutput>('SELECT * FROM research_outputs WHERE id = ?', [id]),
      'Created research output was not found',
    )
  })

  ipcMain.handle('research:createOutput', async (_event, payload: ResearchOutputPayload): Promise<ResearchOutput> => {
    const projectId = String(payload.project_id || '').trim()
    const title = String(payload.title || '').trim()
    const content = String(payload.content || '').trim()
    if (!projectId) throw new Error('请选择要保存到的研究专题')
    if (!title) throw new Error('请输入 AI 产出标题')
    if (!content) throw new Error('AI 产出内容为空，无法保存')
    const project = queryOne<ProjectRow>('SELECT * FROM research_projects WHERE id = ?', [projectId])
    if (!project) throw new Error('研究专题不存在')
    const id = nanoid()
    run(
      'INSERT INTO research_outputs (id, project_id, output_type, title, content, source_dataset_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, projectId, payload.output_type, title, content, payload.source_dataset_id || null, new Date().toISOString()],
    )
    saveDatabase()
    return requireQueryResult(
      queryOne<ResearchOutput>('SELECT * FROM research_outputs WHERE id = ?', [id]),
      'Created research output was not found',
    )
  })

  ipcMain.handle('research:listOutputs', async (_event, projectId: string): Promise<ResearchOutput[]> => {
    return queryAll<ResearchOutput>(
      `SELECT
        id,
        project_id,
        output_type,
        title,
        substr(content, 1, 900) as content,
        created_at,
        source_dataset_id
       FROM research_outputs
       WHERE project_id = ?
       ORDER BY created_at DESC`,
      [projectId],
    )
  })

  ipcMain.handle('research:getOutputContent', async (_event, outputId: string): Promise<string> => {
    const row = queryOne<{ content: string }>('SELECT content FROM research_outputs WHERE id = ?', [outputId])
    return row?.content || ''
  })

  ipcMain.handle('research:exportReferences', async (
    _event,
    projectId: string,
    format: ResearchReferenceExportFormat,
    citationStyleId?: string,
  ): Promise<string> => {
    const docs = getProjectDocs(projectId)
    return docs.map((doc) => buildReferenceCitation(doc, format, citationStyleId)).join('\n\n')
  })

  ipcMain.handle('research:exportProject', async (
    _event,
    projectId: string,
    options: ResearchProjectExportOptions,
  ): Promise<ResearchProjectExportResult> => {
    const project = queryOne<ProjectRow>('SELECT * FROM research_projects WHERE id = ?', [projectId])
    if (!project) throw new Error('专题不存在')
    const outline = listOutline(projectId)
    const notes = listNotes(projectId)
    const docs = getProjectDocs(projectId)
    const references = options?.includeReferences === false
      ? ''
      : docs.map((doc) => buildReferenceCitation(doc, 'gbt7714', options?.citationStyleId)).join('\n\n')
    const citationByNoteId = buildNoteCitationMap(notes, options?.citationStyleId)
    const format = options?.format === 'json' ? 'json' : 'markdown'
    const content = format === 'json'
      ? JSON.stringify({ project, outline, notes, references }, null, 2)
      : renderProjectMarkdown(project, outline, notes, references, citationByNoteId)
    return {
      format,
      content,
      noteCount: notes.length,
      outlineCount: outline.length,
      referenceCount: references ? docs.length : 0,
    }
  })

  ipcMain.handle('research:getDashboard', async (): Promise<ResearchDashboardStats> => {
    const totalDocuments = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM documents')?.count || 0
    const recentReadCount = queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM documents WHERE last_opened_at IS NOT NULL AND last_opened_at >= datetime('now', '-14 days')",
    )?.count || 0
    const pendingProofCount =
      queryOne<{ count: number }>("SELECT COUNT(*) as count FROM documents WHERE proof_status != 'completed'")?.count || 0
    const pendingMetadataCount =
      queryOne<{ count: number }>("SELECT COUNT(*) as count FROM documents WHERE metadata_status IN ('pending', 'review')")?.count || 0
    const aiReadyCount = queryOne<{ count: number }>(
      "SELECT COUNT(DISTINCT doc_id) as count FROM pages WHERE TRIM(COALESCE(proofed_text, '') || COALESCE(ocr_text, '')) != ''",
    )?.count || 0
    const projectCount = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM research_projects')?.count || 0
    const noteCount = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM research_notes')?.count || 0
    const docs = queryAll<DocumentRow>('SELECT author, metadata FROM documents')
    const citationMissingCount = docs.filter((doc) => {
      const metadata = parseMetadata(doc.metadata)
      return !normalizeValue(doc.author || metadata.author) || !normalizeValue(metadata.doi || metadata.isbn || metadata.publication_year || metadata.year)
    }).length

    return {
      totalDocuments,
      recentReadCount,
      pendingProofCount,
      pendingMetadataCount,
      citationMissingCount,
      aiReadyCount,
      projectCount,
      noteCount,
    }
  })
}

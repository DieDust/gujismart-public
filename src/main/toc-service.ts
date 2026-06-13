import { runAiTask } from './ai'
import { queryAll, queryOne, run, scheduleDatabaseSave, transaction } from './database'
import { normalizeChineseSearchText } from './text-normalization'
import type { OcrRecognizeLayoutBlock, OcrRecognizeResult, TocItemSource, TocItemStatus, TocItemV2 } from '../shared/types'

type TocRow = {
  id: string
  doc_id: string
  title: string
  href: string | null
  level: number | null
  order_index: number | null
  parent_id: string | null
  anchor_text: string | null
  anchor_context: string | null
  anchor_key: string | null
  source_page_num: number | null
  source: string | null
  confidence: number | null
  status: string | null
  created_at: string | null
  updated_at: string | null
}

type PageRow = {
  id: string
  page_num: number
  ocr_text: string | null
  proofed_text: string | null
  ocr_result: string | null
}

type JsonRecord = Record<string, unknown>
type TocOcrBlock = OcrRecognizeLayoutBlock & JsonRecord

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function getPathValue(source: unknown, path: readonly string[]): unknown {
  let current = source
  for (const key of path) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return current
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  if (Array.isArray(value)) return value.map(textValue).find(Boolean) || ''
  if (isRecord(value)) return textValue(value.text ?? value.words ?? value.word ?? value.title ?? value.name ?? value.value)
  return ''
}

const CHINESE_NUMERAL_MAP: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const TOC_KEYWORDS = ['目录', '目錄', '目次', 'CONTENTS', 'Contents']
const GENERIC_TITLES = new Set(['目录', '目錄', '目次', 'contents'])
const PAGE_REF_TOKEN = String.raw`(?:\d{1,5}|[一二两兩三四五六七八九十百千〇零○]{1,8})`
const TOC_PAGE_REF_SUFFIX_RE = new RegExp(String.raw`(?:\.{2,}|…{1,}|·{2,}|-{2,}|—{2,}|[|｜/／]|\s|第\s*)(${PAGE_REF_TOKEN})(?:\s*(?:页|頁|p\.?|P\.?))?\s*$`, 'i')
const TOC_PAGE_RANGE_SUFFIX_RE = new RegExp(String.raw`(?:\.{2,}|…{1,}|·{2,}|-{2,}|—{2,}|\s)(${PAGE_REF_TOKEN})\s*(?:[-–—~至])\s*${PAGE_REF_TOKEN}(?:\s*(?:页|頁))?\s*$`, 'i')
const STANDALONE_PAGE_REF_RE = new RegExp(String.raw`^\s*(?:第\s*)?(${PAGE_REF_TOKEN})(?:\s*(?:页|頁|p\.?|P\.?))?\s*$`, 'i')
const MAX_TOC_ITEMS = 2000
const TOC_RULE_AUTOGEN_ATTEMPT_VERSION = '2026-06-05-ocr-structure-v7'
const TOC_RULE_AUTOGEN_ATTEMPT_KEY_PREFIX = 'toc_rule_autogen_attempt:'
const CJK_NUMERAL = '一二两兩三四五六七八九十百千〇零○\\d'
const INSTITUTION_ROSTER_TITLE_RE = /(?:大学|大學|学院|學院|学校|學校|师范|師範|商業|商业|農業|农业|医学|醫学|专门|專門|中学|中學|高等)/
const CLASSICAL_VOLUME_WITH_NAME_RE = new RegExp(`^卷(?:之)?[${CJK_NUMERAL}]{1,6}[\\u4e00-\\u9fff]{1,16}$`)
const CLASSICAL_NAMED_VOLUME_RE = new RegExp(`^[\\u4e00-\\u9fff]{1,18}卷(?:之)?[${CJK_NUMERAL}]{1,6}$`)
const CLASSICAL_SECTION_RE = /^(凡例|序|原序|自序|跋|原跋|敘|叙|原敘|原叙|目錄|目次|圖|图|輿圖|舆图|疆域|沿革|星野|山川|城池|公署|學校|学校|田賦|田赋|戶口|户口|風俗|风俗|祠祀|職官|职官|選舉|选举|人物|列女|女貞|女贞|藝文|艺文|金石|雜志|杂志|災祥|灾祥|經部|经部|史部|子部|集部|詩|诗|文|書目|书目|補遺|补遗|卷首|卷末)(志|表|考|略|記|记|錄|录|目|上|下|一|二|三|四|五|六|七|八|九|十|卷)?$/
const CLASSICAL_CATALOG_ENTRY_RE = /^(?:卷(?:之)?[一二两兩三四五六七八九十百千〇零○\d]+|卷首|卷末|[一二两兩三四五六七八九十百千〇零○\d]+卷|凡例|序|原序|自序|跋|原跋|敘|叙|原敘|原叙|目錄|目次|圖|图|輿圖|舆图|地輿志|地舆志|營建志|营建志|民政志[上中下]?|選舉志[上中下]?|选举志[上中下]?|人物志[上中下]?|藝文志[上中下]?|艺文志[上中下]?|雜記|杂记|疆域|形勢|形势|沿革|星野|山川|岡嶺|冈岭|湖陂|古蹟|古迹|城池|官署|壇廟|坛庙|祠宇|鄉市|乡市|津梁|坊表|第宅|塚墓|冢墓|戶口|户口|保甲|田賦|田赋|堤防|學校|学校|書院|书院|考棚|賓興|宾兴|鄉飲|乡饮|職官|职官|宦績|宦绩|名宦|鄉賢|乡贤|進士|进士|舉人|举人|貢生|贡生|武科|例選|例选|封贈|封赠|廕襲|荫袭|儒林|忠義|忠义|孝友|文學|文学|隱逸|隐逸|方伎|流寓|列女|女貞|女贞|烈女|節孝|节孝|書目|书目|詩|诗|贊|赞|銘|铭|賦|赋|援古|補遺|补遗|經部|经部|史部|子部|集部)$/

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (!value) return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function extractJsonCandidate(value: string): string {
  const text = String(value || '').trim()
  if (!text) return ''
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() || text
  const objectStart = candidate.indexOf('{')
  const arrayStart = candidate.indexOf('[')
  const starts = [objectStart, arrayStart].filter((index) => index >= 0)
  if (starts.length === 0) return candidate
  const start = Math.min(...starts)
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  const end = candidate.lastIndexOf(close)
  return end > start ? candidate.slice(start, end + 1).trim() : candidate.slice(start).trim()
}

function parseAiJson(value: unknown): unknown {
  if (typeof value !== 'string') return parseJson(value, null)
  const direct = parseJson(value.trim(), null)
  if (direct) return direct
  return parseJson(extractJsonCandidate(value), null)
}

function extractAiTocItems(parsed: unknown): JsonRecord[] {
  const flatten = (items: unknown[], inheritedLevel = 1): JsonRecord[] => {
    const result: JsonRecord[] = []
    items.forEach((value) => {
      if (!isRecord(value)) return
      const item = value
      const level = Number(item.level ?? inheritedLevel) || inheritedLevel
      result.push({ ...item, level })
      const children = item.children || item.subitems || item.items || item.sections || item.chapters
      if (Array.isArray(children)) result.push(...flatten(children, level + 1))
    })
    return result
  }

  if (!parsed) return []
  if (Array.isArray(parsed)) return flatten(parsed)
  if (!isRecord(parsed)) return []

  const candidates = [
    parsed.items,
    parsed.toc,
    parsed.entries,
    parsed.chapters,
    parsed.directories,
    parsed.outline,
    parsed.result,
    getPathValue(parsed, ['data', 'items']),
    getPathValue(parsed, ['data', 'toc']),
    getPathValue(parsed, ['data', 'entries']),
    getPathValue(parsed, ['data', 'chapters']),
    parsed.tocItems,
    parsed.toc_items,
    parsed.tableOfContents,
    parsed.table_of_contents,
  ]

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return flatten(candidate)
  }
  return []
}

function getBlockText(block: unknown): string {
  if (!isRecord(block)) return ''
  return textValue(block.words || block.word || block.text).replace(/\s+/g, ' ').trim()
}

function getBlockLabel(block: unknown): string {
  if (!isRecord(block)) return ''
  return textValue(block.label || block.type || block.block_type || block.category).toLowerCase()
}

function getBlockOrder(block: unknown, fallback: number): number {
  const value = Number(isRecord(block) ? block.reading_order : undefined)
  return Number.isFinite(value) ? value : fallback
}

function getPointCoordinate(point: unknown, key: 'x' | 'y', tupleIndex: number): number | null {
  const value = isRecord(point)
    ? Number(point[key])
    : Array.isArray(point)
      ? Number(point[tupleIndex])
      : Number.NaN
  return Number.isFinite(value) ? value : null
}

function getBlockPoint(block: unknown): { top: number; left: number } {
  const loc = isRecord(block) ? block.location || block.points : undefined
  if (isRecord(loc) && (loc.top !== undefined || loc.left !== undefined)) {
    return {
      top: Number.isFinite(Number(loc.top)) ? Number(loc.top) : Number.MAX_SAFE_INTEGER,
      left: Number.isFinite(Number(loc.left)) ? Number(loc.left) : Number.MAX_SAFE_INTEGER,
    }
  }
  if (Array.isArray(loc) && loc.length > 0) {
    const xs = loc.map((point) => getPointCoordinate(point, 'x', 0)).filter((value): value is number => value !== null)
    const ys = loc.map((point) => getPointCoordinate(point, 'y', 1)).filter((value): value is number => value !== null)
    return {
      top: ys.length > 0 ? Math.min(...ys) : Number.MAX_SAFE_INTEGER,
      left: xs.length > 0 ? Math.min(...xs) : Number.MAX_SAFE_INTEGER,
    }
  }
  return { top: Number.MAX_SAFE_INTEGER, left: Number.MAX_SAFE_INTEGER }
}

function getOcrBlocks(page: PageRow): TocOcrBlock[] {
  const parsed = parseJson(page.ocr_result, null) as (OcrRecognizeResult & JsonRecord) | null
  const blocks = asRecordArray(parsed?.layout_result).length > 0
    ? asRecordArray(parsed?.layout_result)
    : asRecordArray(parsed?.layout_blocks).length > 0
      ? asRecordArray(parsed?.layout_blocks)
      : asRecordArray(parsed?.words_result)
  return [...blocks].sort((left, right) => {
    const leftOrder = Number(left.reading_order)
    const rightOrder = Number(right.reading_order)
    if (Number.isFinite(leftOrder) || Number.isFinite(rightOrder)) {
      return (Number.isFinite(leftOrder) ? leftOrder : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(rightOrder) ? rightOrder : Number.MAX_SAFE_INTEGER)
    }
    const leftPoint = getBlockPoint(left)
    const rightPoint = getBlockPoint(right)
    return leftPoint.top - rightPoint.top || leftPoint.left - rightPoint.left
  }) as TocOcrBlock[]
}

function isOcrTitleBlock(block: unknown, text: string): boolean {
  const label = getBlockLabel(block)
  if (/paragraph_title|doc_title|section_title|article_title|title|heading/.test(label)) return true
  if (/header|footer|number|page/.test(label)) return false
  return isLikelyHeadingLine(text)
}

function nowIso(): string {
  return new Date().toISOString()
}

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

function tocUid(docId: string, source: TocItemSource, index: number): string {
  return `${uid(`toc_${source}`)}_${String(docId || 'doc').slice(0, 8)}_${index}`
}

function normalizeTitle(value: string): string {
  return String(value || '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeForMatch(value: string): string {
  return normalizeChineseSearchText(normalizeTitle(value))
    .replace(/[《》「」『』“”‘’"'()[\]（）【】{}<>〈〉,，.。:：;；!！?？、·•…—_\-\s]/g, '')
    .replace(/第([一二两兩三四五六七八九十百千〇零\d]+)[章节卷編编篇部]/g, '第$1')
    .toLowerCase()
}

function normalizeHeadingKey(value: string): string {
  return normalizeForMatch(value)
    .replace(/^[0-9一二两兩三四五六七八九十百千〇零○]+/, '')
    .replace(/^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩivxlcdm]+/i, '')
}

function normalizeArchiveMatchKey(value: string): string {
  return normalizeForMatch(value)
    .replace(/响应/g, '应')
    .replace(/捐金/g, '献金')
    .replace(/捐款/g, '献款')
    .replace(/[之的及与和]/g, '')
}

function getTitleMatchKeys(value: string): string[] {
  const normalized = normalizeForMatch(value)
  const heading = normalizeHeadingKey(value)
  const archive = normalizeArchiveMatchKey(value)
  const keys = [normalized, heading, archive]
  ;[normalized, archive].forEach((key) => {
    if (key.length >= 8) keys.push(key.slice(1), key.slice(2), key.slice(-8))
    if (key.length >= 12) keys.push(key.slice(-10))
  })
  return Array.from(new Set(keys.filter((key) => key.length >= 4)))
}

function textMatchesTitleKey(text: string, title: string): boolean {
  const normalizedText = normalizeForMatch(text)
  const archiveText = normalizeArchiveMatchKey(text)
  return getTitleMatchKeys(title).some((key) => normalizedText.includes(key) || archiveText.includes(key))
}

function archiveTitleSimilarity(text: string, title: string): number {
  const titleKey = normalizeArchiveMatchKey(title)
  if (titleKey.length < 8) return 0
  const textKey = normalizeArchiveMatchKey(text)
  if (!textKey) return 0
  const chunks = new Set<string>()
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= titleKey.length - size; index += size) {
      const chunk = titleKey.slice(index, index + size)
      if (chunk.length === size) chunks.add(chunk)
    }
  }
  if (chunks.size === 0) return 0
  let hits = 0
  chunks.forEach((chunk) => {
    if (textKey.includes(chunk)) hits += 1
  })
  return hits / chunks.size
}

function normalizeTocLineTitle(value: string): string {
  let text = normalizeTitle(value)
  text = stripHtml(text)
  text = text.replace(TOC_PAGE_RANGE_SUFFIX_RE, '')
  text = text.replace(TOC_PAGE_REF_SUFFIX_RE, '')
  text = text.replace(/[.·\-—…\s]{2,}[一二两兩三四五六七八九十百千〇零]{1,8}(?:\s*[页頁])?\s*$/, '')
  text = text.replace(/^[（(]?\d+[)）.、]\s*/, '')
  text = text.replace(/^[一二两兩三四五六七八九十百千〇零]+[、.．]\s*/, '')
  return normalizeTitle(text)
}

function normalizeHeadingCandidateTitle(value: string): string {
  let text = normalizeTitle(value)
  text = stripHtml(text)
  text = text.replace(TOC_PAGE_RANGE_SUFFIX_RE, '')
  text = text.replace(TOC_PAGE_REF_SUFFIX_RE, '')
  text = text.replace(/[.·\-—…\s]{2,}[一二两兩三四五六七八九十百千〇零]{1,8}(?:\s*[页頁])?\s*$/, '')
  return normalizeTitle(text)
}

function stripHtml(value: string): string {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlTableCellTexts(value: string): string[] {
  const text = String(value || '')
  const result: string[] = []
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
  let match: RegExpExecArray | null
  while ((match = cellRe.exec(text))) {
    const cell = stripHtml(match[1])
    cell.split(/\n+/).map(normalizeTitle).filter(Boolean).forEach((item) => result.push(item))
  }
  return result
}

function htmlTableRows(value: string): string[][] {
  const text = String(value || '')
  const rows: string[][] = []
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch: RegExpExecArray | null
  while ((rowMatch = rowRe.exec(text))) {
    const cells: string[] = []
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
    let cellMatch: RegExpExecArray | null
    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const cell = stripHtml(cellMatch[1])
      if (cell) cells.push(cell)
    }
    if (cells.length) rows.push(cells)
  }
  return rows
}

function getOcrTableRows(page: PageRow): string[][] {
  const rows: string[][] = []
  getOcrBlocks(page).forEach((block) => {
    const label = getBlockLabel(block)
    const blockRows = asArray(block.rows)
    if (blockRows.length && /table|toc/.test(label)) {
      blockRows.forEach((row) => {
        const cells = Array.isArray(row) ? row : []
        const normalized = cells.map((cell) => stripHtml(String(cell || ''))).filter(Boolean)
        if (normalized.length) rows.push(normalized)
      })
    }
    const cells = asRecordArray(block.cells)
    if (cells.length && /table|toc/.test(label)) {
      const byRow = new Map<number, string[]>()
      cells.forEach((cell) => {
        const rowIndex = Number.isFinite(Number(cell.row)) ? Number(cell.row) : 0
        const colIndex = Number.isFinite(Number(cell.col)) ? Number(cell.col) : byRow.get(rowIndex)?.length || 0
        const text = stripHtml(textValue(cell.text || cell.words))
        if (!text) return
        const row = byRow.get(rowIndex) || []
        row[colIndex] = text
        byRow.set(rowIndex, row)
      })
      Array.from(byRow.keys()).sort((left, right) => left - right).forEach((rowIndex) => {
        const row = (byRow.get(rowIndex) || []).filter(Boolean)
        if (row.length) rows.push(row)
      })
    }
  })
  return rows
}

function combineTocTableRow(cells: string[]): string[] {
  const normalizedCells = cells.map((cell) => normalizeTitle(stripHtml(cell))).filter(Boolean)
  if (normalizedCells.length < 2) return []
  const results: string[] = []
  const last = normalizedCells[normalizedCells.length - 1]
  if (STANDALONE_PAGE_REF_RE.test(last)) {
    const title = normalizedCells.slice(0, -1).join(' ')
    if (title) results.push(`${title} ${last}`)
  }
  for (let index = 0; index < normalizedCells.length - 1; index += 1) {
    const title = normalizedCells[index]
    const page = normalizedCells[index + 1]
    if (title && STANDALONE_PAGE_REF_RE.test(page)) results.push(`${title} ${page}`)
  }
  return Array.from(new Set(results))
}

type ArchiveInventoryEntry = {
  title: string
  archivePageNum: number | null
  rawLine: string
}

function parseArchivePageNum(value: string): number | null {
  const match = normalizeTitle(value).match(/\d{1,5}|[一二两兩三四五六七八九十百千〇零○]{1,8}/)
  return match ? parseChineseNumber(match[0]) : null
}

function cleanArchiveInventoryTitle(value: string): string {
  return normalizeTitle(value)
    .replace(/^文件(?:標題|标题)或事由\s*/u, '')
    .replace(/^填(?:报|報)?\s*/u, '填报')
    .replace(/^(无|無|空白)$/u, '')
    .trim()
}

function parseArchiveInventoryLine(line: string): ArchiveInventoryEntry | null {
  const raw = normalizeTitle(line).replace(/[｜]/g, '|')
  if (!raw) return null
  const cells = raw.split('|').map((cell) => normalizeTitle(cell)).filter(Boolean)
  if (cells.length >= 5) {
    if (cells.some((cell) => /文件[頁页]次|文件(?:標題|标题)或事由|順序號|顺序号/.test(cell))) return null
    const archivePageNum = parseArchivePageNum(cells[0])
    const title = cleanArchiveInventoryTitle(cells[3] || cells[cells.length - 3] || '')
    if (archivePageNum && title.length >= 2 && title.length <= 90) {
      return { title, archivePageNum, rawLine: raw }
    }
  }

  const narrative = raw.match(/文件[頁页]次\s*([0-9一二两兩三四五六七八九十百千〇零○]+).*?文件(?:標題|标题)或事由\s*([^，,。；;]+?)(?:，|,|。|；|;|文件作者|$)/u)
  if (narrative) {
    const archivePageNum = parseArchivePageNum(narrative[1])
    const title = cleanArchiveInventoryTitle(narrative[2])
    if (archivePageNum && title.length >= 2 && title.length <= 90) {
      return { title, archivePageNum, rawLine: raw }
    }
  }

  return null
}

function getArchiveInventoryEntries(page: PageRow): ArchiveInventoryEntry[] {
  const seen = new Set<string>()
  const entries: ArchiveInventoryEntry[] = []
  pageText(page).split(/\n+/).forEach((line) => {
    const entry = parseArchiveInventoryLine(line)
    if (!entry) return
    const key = `${normalizeForMatch(entry.title)}:${entry.archivePageNum || ''}`
    if (!key || seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  })
  return entries
}

function getTocCandidateLines(page: PageRow): string[] {
  const text = pageText(page)
  return [
    ...text.split(/\n+/),
    ...htmlTableCellTexts(text),
    ...htmlTableRows(text).flatMap(combineTocTableRow),
    ...getOcrTableRows(page).flatMap(combineTocTableRow),
  ].map(normalizeTitle).filter(Boolean)
}

function parseChineseNumber(value: string): number | null {
  const text = String(value || '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  let total = 0
  let section = 0
  let current = 0
  for (const char of text) {
    if (char === '十') {
      section += (current || 1) * 10
      current = 0
    } else if (char === '百') {
      section += (current || 1) * 100
      current = 0
    } else if (char === '千') {
      section += (current || 1) * 1000
      current = 0
    } else if (char === '万' || char === '萬') {
      total += (section + current) * 10000
      section = 0
      current = 0
    } else if (CHINESE_NUMERAL_MAP[char] !== undefined) {
      current = CHINESE_NUMERAL_MAP[char]
    }
  }
  const result = total + section + current
  return result > 0 ? result : null
}

function getChapterOrdinal(title: string): number | null {
  const match = normalizeTitle(title).match(/^第\s*([一二两兩三四五六七八九十百千〇零\d]+)\s*[章节卷編编篇部]/)
  return match ? parseChineseNumber(match[1]) : null
}

function isRomanHeadingTitle(title: string): boolean {
  return /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩIVXLCDM]{1,8}\s*[.．、）)]\s*\S{2,70}$/i.test(normalizeTitle(title))
}

function isStandardArticleHeadingTitle(title: string): boolean {
  return /^(摘要|Abstract|要旨|前言|绪论|緒論|引言|结语|結語|结论|結論|文献|參考文獻|参考文献|引用書目|引用书目|附录|附錄|后记|後記)$/i.test(normalizeTitle(title))
}

function isArticleNumberedHeadingTitle(title: string): boolean {
  return /^[（(]?[一二两兩三四五六七八九十百千〇零○\d]{1,4}\s*[)）、.．]\s*\S{2,70}$/.test(normalizeTitle(title))
}

function getMarkdownHeadingLevel(title: string): number | null {
  const match = String(title || '').match(/^(#{1,6})\s+\S/)
  return match ? Math.max(1, Math.min(6, match[1].length)) : null
}

function getHeadingLevel(title: string): number {
  const text = normalizeTitle(title)
  const markdownLevel = getMarkdownHeadingLevel(title)
  if (markdownLevel) return markdownLevel
  if (isClassicalVolumeTitle(text)) return 1
  if (isClassicalSectionHeadingTitle(text)) return 2
  if (isStandardArticleHeadingTitle(text)) return 1
  if (isRomanHeadingTitle(text)) return 1
  if (isArticleNumberedHeadingTitle(text)) return 2
  if (/^第\s*[一二两兩三四五六七八九十百千〇零\d]+\s*[卷編编篇部]/.test(text)) return 1
  if (/^第\s*[一二两兩三四五六七八九十百千〇零\d]+\s*章/.test(text)) return 1
  if (/^第\s*[一二两兩三四五六七八九十百千〇零\d]+\s*节/.test(text)) return 2
  if (/^[一二两兩三四五六七八九十百千〇零\d]+[、.．]/.test(text)) return 2
  if (/^[（(][一二两兩三四五六七八九十百千〇零\d]+[)）]/.test(text)) return 3
  return 2
}

function isClassicalVolumeTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  if (text.length < 3 || text.length > 36) return false
  if (isClassicalCollectionHeaderTitle(text)) return false
  if (CLASSICAL_VOLUME_WITH_NAME_RE.test(text) || CLASSICAL_NAMED_VOLUME_RE.test(text)) return true
  if (/[一二三四五六七八九十百千〇零○\d]$/.test(text) && !/卷之?[一二两兩三四五六七八九十百千〇零○\d]+$/.test(text)) return false
  if (/卷之?[一二两兩三四五六七八九十百千〇零○\d]+/.test(text) && /(縣志|县志|府志|州志|志卷|藝文志|艺文志|地輿志|地舆志|營建志|营建志|民政志|選舉志|选举志|人物志|女貞志|女贞志)/.test(text)) return true
  if (new RegExp(`^(?:[\\u4e00-\\u9fff]{1,12})?卷之?[${CJK_NUMERAL}]{1,6}$`).test(text)) return true
  return false
}

function isClassicalCollectionHeaderTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  return /^(欽定|钦定)?(四庫全書|四库全书|續修四庫全書|续修四库全书|文淵閣四庫全書|文渊阁四库全书)/.test(text)
    || /^(四庫全書|四库全书).*(卷|冊|册)[一二两兩三四五六七八九十百千〇零○\d]+$/.test(text)
}

function isBareClassicalVolumeTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  return /^(?:卷(?:之)?[一二两兩三四五六七八九十百千〇零○\d]{1,6}|[一二两兩三四五六七八九十百千〇零○\d]{1,6}卷)$/.test(text)
}

function getBareClassicalVolumeOrdinal(title: string): number | null {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  const match = text.match(/^卷(?:之)?([一二两兩三四五六七八九十百千〇零○\d]{1,6})$/)
    || text.match(/^([一二两兩三四五六七八九十百千〇零○\d]{1,6})卷$/)
  return match ? parseChineseNumber(match[1]) : null
}

const REAL_CJK_NUMERAL_RE = '[\\u4e00\\u4e8c\\u4e24\\u5169\\u4e09\\u56db\\u4e94\\u516d\\u4e03\\u516b\\u4e5d\\u5341\\u767e\\u5343\\u3007\\u96f6\\u25cb\\d]'
const REAL_NUMERAL_VALUE: Record<string, number> = {
  '\u3007': 0,
  '\u96f6': 0,
  '\u25cb': 0,
  '\u4e00': 1,
  '\u4e8c': 2,
  '\u4e24': 2,
  '\u5169': 2,
  '\u4e09': 3,
  '\u56db': 4,
  '\u4e94': 5,
  '\u516d': 6,
  '\u4e03': 7,
  '\u516b': 8,
  '\u4e5d': 9,
}

function parseChineseNumberReal(value: string): number | null {
  const text = String(value || '').trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  let section = 0
  let current = 0
  for (const char of text) {
    if (char === '\u5341') {
      section += (current || 1) * 10
      current = 0
    } else if (char === '\u767e') {
      section += (current || 1) * 100
      current = 0
    } else if (char === '\u5343') {
      section += (current || 1) * 1000
      current = 0
    } else if (REAL_NUMERAL_VALUE[char] !== undefined) {
      current = REAL_NUMERAL_VALUE[char]
    }
  }
  const result = section + current
  return result > 0 ? result : null
}

function isRealClassicalCollectionHeaderTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  return /^(?:\u94a6\u5b9a|\u6b3d\u5b9a)?(?:\u56db\u5e93\u5168\u4e66|\u7eed\u4fee\u56db\u5e93\u5168\u4e66|\u6587\u6e0a\u9601\u56db\u5e93\u5168\u4e66|\u6587\u6d25\u9601\u56db\u5e93\u5168\u4e66)/.test(text)
    || new RegExp(`^(?:\\u56db\\u5e93\\u5168\\u4e66|\\u7eed\\u4fee\\u56db\\u5e93\\u5168\\u4e66).*\\u5377${REAL_CJK_NUMERAL_RE}+$`).test(text)
}

function isRealBareClassicalVolumeTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  return new RegExp(`^\\u5377(?:\\u4e4b)?${REAL_CJK_NUMERAL_RE}{1,6}$`).test(text)
    || new RegExp(`^${REAL_CJK_NUMERAL_RE}{1,6}\\u5377$`).test(text)
}

function getRealBareClassicalVolumeOrdinal(title: string): number | null {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  const match = text.match(new RegExp(`^\\u5377(?:\\u4e4b)?(${REAL_CJK_NUMERAL_RE}{1,6})$`))
    || text.match(new RegExp(`^(${REAL_CJK_NUMERAL_RE}{1,6})\\u5377$`))
  return match ? parseChineseNumberReal(match[1]) : null
}

function isClassicalSectionHeadingTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  if (text.length < 1 || text.length > 24) return false
  if (CLASSICAL_SECTION_RE.test(text)) return true
  if (/^[\u4e00-\u9fff]{1,10}志[上下]?$/.test(text)) return true
  if (/^[\u4e00-\u9fff]{1,8}(傳|传|記|记|錄|录|表|考|略|目)$/.test(text)) return true
  return false
}

function isClassicalCatalogEntryTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  if (!text || text.length > 24) return false
  return CLASSICAL_CATALOG_ENTRY_RE.test(text) || isClassicalVolumeTitle(text)
}

function isClassicalRuleTocTitle(title: string): boolean {
  return isClassicalVolumeTitle(title) || isClassicalCatalogEntryTitle(title)
}

function isLikelyHeadingLine(line: string): boolean {
  const text = normalizeTitle(line)
  if (text.length < 2 || text.length > 80) return false
  if (GENERIC_TITLES.has(text.toLowerCase())) return false
  if (/^#{1,6}\s+/.test(line)) return true
  if (isClassicalRuleTocTitle(text)) return true
  if (isRomanHeadingTitle(text)) return true
  if (isArticleNumberedHeadingTitle(text)) return true
  if (/^第\s*[一二两兩三四五六七八九十百千〇零\d]+\s*[章节卷編编篇部]/.test(text)) return true
  if (/^[一二两兩三四五六七八九十百千〇零\d]+[、.．]\s*\S{2,60}$/.test(text)) return true
  if (/^[（(][一二两兩三四五六七八九十百千〇零\d]+[)）]\s*\S{2,60}$/.test(text)) return true
  if (isStandardArticleHeadingTitle(text)) return true
  return false
}

function isRuleTocHeadingTitle(title: string): boolean {
  const text = normalizeTitle(title)
  if (text.length < 1 || text.length > 70) return false
  if (/^(?:\d{1,5})(?:\s+\d{1,5})*$/.test(text)) return false
  if (/^[\d\s]+[\u4e00-\u9fff]{0,2}[\d\s]+$/.test(text)) return false
  if (/^[×xX◇◆♦]+$/.test(text)) return false
  if (/^[〇○零一二两兩三四五六七八九十百千\dO\s、，.．,-]+$/.test(text)) return false
  if (/[。！？；;，,]/.test(text)) return false
  if (/^(備考|备考|图|圖|表|附表)/.test(text)) return false
  if (/[一二三四五六七八九十百千〇零○\d]$/.test(text) && !/卷之?[一二两兩三四五六七八九十百千〇零○\d]+$/.test(text)) return false
  if (isClassicalVolumeTitle(text)) return true
  if (isClassicalCatalogEntryTitle(text)) return true
  if (isStandardArticleHeadingTitle(text)) return true
  if (isRomanHeadingTitle(text)) return true
  if (isArticleNumberedHeadingTitle(text)) return true
  if (/^第\s*[一二两兩三四五六七八九十百千〇零○\d]{1,4}\s*章/.test(text)) return true
  if (/^[（(]?[一二两兩三四五六七八九十百千〇零○\d]{1,4}[)）、.．]\s*\S{2,60}$/.test(text)) return true
  return false
}

function pageText(page: PageRow): string {
  const proofed = String(page.proofed_text || '').trim()
  if (proofed) return proofed
  return String(page.ocr_text || '').trim()
}

function findTitleCharIndexInText(text: string, title: string): number {
  if (!text) return 0
  const direct = text.indexOf(title)
  if (direct >= 0) return direct
  const key = normalizeForMatch(title)
  const headingKey = normalizeHeadingKey(title)
  if (!key) return 0
  let cursor = 0
  for (const line of text.split(/\n+/)) {
    const lineKey = normalizeForMatch(line)
    const headingLineKey = normalizeHeadingKey(line)
    if (lineKey && (lineKey === key || lineKey.includes(key) || key.includes(lineKey))) return cursor
    if (headingKey && headingLineKey && (headingLineKey === headingKey || headingLineKey.includes(headingKey) || headingKey.includes(headingLineKey))) return cursor
    if (textMatchesTitleKey(line, title)) return cursor
    cursor += line.length + 1
  }
  return 0
}

function getPageHeadingHints(page: PageRow): Array<{ title: string; label: string; charIndex: number; order: number }> {
  const hints: Array<{ title: string; label: string; charIndex: number; order: number }> = []
  getOcrBlocks(page).forEach((block, index) => {
    const title = normalizeTocLineTitle(getBlockText(block))
    if (!title || !isOcrTitleBlock(block, title)) return
    hints.push({
      title,
      label: getBlockLabel(block),
      charIndex: findTitleCharIndexInText(textForAnchor(page), title),
      order: getBlockOrder(block, index),
    })
  })
  return hints.slice(0, 80)
}

function findHeadingHintForTitle(page: PageRow, title: string): { title: string; label: string; charIndex: number; order: number } | null {
  const key = normalizeForMatch(title)
  const headingKey = normalizeHeadingKey(title)
  if (!key) return null
  let fuzzy: { title: string; label: string; charIndex: number; order: number } | null = null
  for (const hint of getPageHeadingHints(page)) {
    const hintKey = normalizeForMatch(hint.title)
    const hintHeadingKey = normalizeHeadingKey(hint.title)
    if (!hintKey) continue
    if (hintKey === key) return hint
    if (!fuzzy && (hintKey.includes(key) || key.includes(hintKey))) fuzzy = hint
    if (!fuzzy && headingKey && hintHeadingKey && (hintHeadingKey === headingKey || hintHeadingKey.includes(headingKey) || headingKey.includes(hintHeadingKey))) fuzzy = hint
  }
  return fuzzy
}

function ocrBlockReadingText(page: PageRow): string {
  const blockText = getOcrBlocks(page).map(getBlockText).filter(Boolean).join('\n')
  return blockText || pageText(page)
}

function textForAnchor(page: PageRow): string {
  const text = pageText(page)
  return text || ocrBlockReadingText(page)
}

function lineLooksLikeTocEntry(line: string): boolean {
  const text = normalizeTitle(line)
  if (text.length < 3 || text.length > 120) return false
  if (GENERIC_TITLES.has(text.toLowerCase())) return false
  return TOC_PAGE_REF_SUFFIX_RE.test(text) || TOC_PAGE_RANGE_SUFFIX_RE.test(text)
}

function lineHasTocLeader(line: string): boolean {
  return /(?:\.{2,}|…{1,}|·{2,}|-{2,}|—{2,}|[|｜/／])/.test(String(line || ''))
}

function lineHasNumberColumnTail(line: string): boolean {
  const text = normalizeTitle(line)
  const tokens = text.split(/\s+/).filter(Boolean)
  let tailColumns = 0
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (!/^[?？\d一二两兩三四五六七八九十百千〇零○]+$/.test(tokens[index])) break
    tailColumns += 1
  }
  return tailColumns >= 2
}

function isInstitutionRosterTitle(title: string): boolean {
  const compact = normalizeTitle(title).replace(/\s+/g, '')
  if (!compact || compact.length > 28) return false
  if (/^(?:学校|學校|書院|书院)$/.test(compact)) return false
  return INSTITUTION_ROSTER_TITLE_RE.test(compact)
}

function looksLikeRosterOrIndexEntryLine(line: string, title: string): boolean {
  if (lineHasTocLeader(line)) return false
  if (lineHasNumberColumnTail(line)) return true
  return isInstitutionRosterTitle(title)
}

function lineLooksLikeStrongTocEntry(line: string): boolean {
  const raw = normalizeTitle(line)
  if (!lineLooksLikeTocEntry(raw)) return false
  const title = normalizeTocLineTitle(raw)
  if (!title || GENERIC_TITLES.has(title.toLowerCase())) return false
  if (looksLikeRosterOrIndexEntryLine(raw, title)) return false
  return lineHasTocLeader(raw)
    || TOC_PAGE_RANGE_SUFFIX_RE.test(raw)
    || isClassicalCatalogEntryTitle(title)
    || isArticleNumberedHeadingTitle(title)
    || isStandardArticleHeadingTitle(title)
    || /^第\s*[一二两兩三四五六七八九十百千〇零○\d]{1,4}\s*[章节卷編编篇部]/.test(title)
}

function normalizeTocProbeText(value: string): string {
  return normalizeChineseSearchText(String(value || '')).replace(/\s+/g, '')
}

function hasAnyKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword))
}

function isArchiveLikeDocTypeSafe(docType: string): boolean {
  const compact = normalizeTocProbeText(docType)
  return hasAnyKeyword(compact, ['档案', '手稿', '馆藏', '卷宗', '案卷', '文件', '记事簿', '紀事簿', '登記簿', '登记簿'])
}

function looksLikeArchiveRegisterTextSafe(text: string): boolean {
  const compact = normalizeTocProbeText(text)
  if (!compact) return false
  const hasRegisterName = hasAnyKeyword(compact, ['收文簿', '记事簿', '紀事簿', '登記簿', '登记簿', '登記冊', '登记册', '公文登记', '公文登記', '收发文', '收發文'])
  const hasRegisterColumns = hasAnyKeyword(compact, ['文牘', '文牍', '机关', '機關', '字号', '字號', '别号', '別號', '事由', '附件', '备考', '備考'])
  const serialRuns = (compact.match(/\d{3,4}(?:[、,，\s]*\d{3,4}){2,}/g) || []).length
  return hasRegisterName || (hasRegisterColumns && serialRuns >= 1)
}

function hasExplicitArchiveInventorySignalSafe(text: string): boolean {
  const compact = normalizeTocProbeText(text)
  return hasAnyKeyword(compact, [
    '卷内目录',
    '卷內目錄',
    '卷内文件目录',
    '卷內文件目錄',
    '文件页次',
    '文件頁次',
    '文件标题或事由',
    '文件標題或事由',
    '顺序号',
    '順序號',
  ])
}

function isRegisterLikeArchiveDocumentSafe(docId: string, pages: PageRow[]): boolean {
  const profile = getDocumentTocProfile(docId)
  const identityText = normalizeTocProbeText(`${profile.title} ${profile.docType}`)
  if (!isArchiveLikeDocTypeSafe(identityText)) return false
  if (hasAnyKeyword(identityText, ['收文簿', '记事簿', '紀事簿', '登記簿', '登记簿', '登記冊', '登记册', '公文登记', '收发文', '收發文'])) return true
  return pages.slice(0, 30).filter((page) => looksLikeArchiveRegisterTextSafe(pageText(page))).length >= 3
}

function looksLikeArchiveRegisterText(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return false
  const hasRegisterName = /收文簿|记事簿|記事簿|登记簿|登記簿|登记册|登記冊|公文登记|公文登記|收发文|收發文/.test(compact)
  const hasRegisterColumns = /文(?:牘|牍)?|机关|機關|字号|字號|别号|別號|事由|附件|備考|备考/.test(compact)
  const serialRuns = (compact.match(/\d{3,4}[、，,\s]*\d{3,4}[、，,\s]*\d{3,4}/g) || []).length
  return hasRegisterName || (hasRegisterColumns && serialRuns >= 1)
}

function hasExplicitArchiveInventorySignal(text: string): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  return /卷内目录|卷內目錄|卷内文件目录|卷內文件目錄|文件页次|文件頁次|文件标题或事由|文件標題或事由|顺序号|順序號/.test(compact)
}

function getDocumentTocProfile(docId: string): { title: string; docType: string } {
  const row = queryAll<{ title?: string; doc_type?: string }>(
    'SELECT title, doc_type FROM documents WHERE id = ? LIMIT 1',
    [docId],
  )[0]
  return {
    title: String(row?.title || ''),
    docType: String(row?.doc_type || ''),
  }
}

function isArchiveLikeDocType(docType: string): boolean {
  return /档案|檔案|手稿|馆藏|館藏|卷宗|案卷|文件|记事簿|記事簿/.test(String(docType || ''))
}

function isRegisterLikeArchiveDocument(docId: string, pages: PageRow[]): boolean {
  const profile = getDocumentTocProfile(docId)
  const identityText = `${profile.title} ${profile.docType}`
  if (!isArchiveLikeDocType(identityText)) return false
  if (/收文簿|记事簿|記事簿|登记簿|登記簿|登记册|登記冊|收发文|收發文/.test(identityText)) return true
  return pages.slice(0, 30).filter((page) => looksLikeArchiveRegisterText(pageText(page))).length >= 3
}

function hasExplicitArchiveInventory(pages: PageRow[]): boolean {
  return pages.some((page) => hasExplicitArchiveInventorySignal(pageText(page)))
}

function shouldSuppressTocForRegisterArchive(docId: string, pages: PageRow[]): boolean {
  return isRegisterLikeArchiveDocumentSafe(docId, pages) && !hasExplicitArchiveInventory(pages)
}

function isLikelyTocPageText(text: string, extraLines: string[] = []): boolean {
  const compact = String(text || '').replace(/\s+/g, '')
  if (!compact) return false
  const hasKeyword = TOC_KEYWORDS.some((keyword) => compact.includes(keyword))
  const lines = [...String(text || '').split(/\n+/), ...htmlTableCellTexts(text), ...htmlTableRows(text).flatMap(combineTocTableRow), ...extraLines]
  const pageRefCount = lines.filter((line) => lineLooksLikeStrongTocEntry(line)).length
  const classicalEntryCount = lines.filter((line) => isClassicalCatalogEntryTitle(normalizeTocLineTitle(line))).length
  const archiveEntryCount = lines.filter((line) => !!parseArchiveInventoryLine(line)).length
  const chapterCount = (compact.match(/第[一二两兩三四五六七八九十百千〇零○\d]{1,4}章/g) || []).length
  const sectionCount = (compact.match(/[（(]?[一二两兩三四五六七八九十百千〇零○\d]{1,4}[)）、.]/g) || []).length
  return (hasKeyword && (pageRefCount >= 3 || classicalEntryCount >= 4 || archiveEntryCount >= 3 || chapterCount >= 2 || sectionCount >= 8))
    || pageRefCount >= 8
    || classicalEntryCount >= 8
    || archiveEntryCount >= 5
}

function isLikelyTocPage(pageOrText: PageRow | string): boolean {
  if (typeof pageOrText === 'string') return isLikelyTocPageText(pageOrText)
  const text = pageText(pageOrText)
  if (looksLikeArchiveRegisterTextSafe(text) && !hasExplicitArchiveInventorySignalSafe(text)) return false
  return isLikelyTocPageText(text, getOcrTableRows(pageOrText).flatMap(combineTocTableRow))
}

function parseTocEntryLine(line: string): { title: string; level: number; hintedPageNum: number | null } | null {
  const raw = normalizeTitle(line)
  const isClassicalCatalogEntry = isClassicalCatalogEntryTitle(normalizeTocLineTitle(raw))
  if (!lineLooksLikeTocEntry(raw) && !isClassicalCatalogEntry) return null
  const pageMatch = raw.match(TOC_PAGE_REF_SUFFIX_RE) || raw.match(TOC_PAGE_RANGE_SUFFIX_RE)
  const title = normalizeTocLineTitle(raw)
  if (!title || title.length < 2 || title.length > 90) return null
  if (GENERIC_TITLES.has(title.toLowerCase())) return null
  if (!isClassicalCatalogEntry && looksLikeRosterOrIndexEntryLine(raw, title)) return null
  return {
    title,
    level: getHeadingLevel(title),
    hintedPageNum: pageMatch ? parseChineseNumber(pageMatch[1]) : null,
  }
}

function getPages(docId: string): PageRow[] {
  return queryAll<PageRow>(
    'SELECT id, page_num, ocr_text, proofed_text, ocr_result FROM pages WHERE doc_id = ? ORDER BY page_num ASC',
    [docId],
  )
}

function fromRow(row: TocRow): TocItemV2 {
  return {
    id: row.id,
    doc_id: row.doc_id,
    title: row.title,
    href: row.href || '',
    level: Math.max(1, Math.min(6, Number(row.level) || 1)),
    order: Number(row.order_index) || 0,
    parent_id: row.parent_id ?? null,
    anchor_text: row.anchor_text ?? null,
    anchor_context: row.anchor_context ?? null,
    anchor_key: row.anchor_key ?? null,
    source_page_num: row.source_page_num ?? null,
    source: normalizeSource(row.source),
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.5,
    status: normalizeStatus(row.status),
    created_at: row.created_at || undefined,
    updated_at: row.updated_at || undefined,
  }
}

function normalizeSource(value: unknown): TocItemSource {
  return value === 'manual' || value === 'ai' || value === 'rule' || value === 'imported' || value === 'legacy'
    ? value
    : 'rule'
}

function normalizeStatus(value: unknown): TocItemStatus {
  return value === 'active' || value === 'unresolved' || value === 'disabled' ? value : 'active'
}

function getTocSourcePage(value: string | null | undefined): number | null {
  const match = String(value || '').match(/toc_source_page:(\d+)/)
  return match ? Number(match[1]) : null
}

function getTocSearchStartPage(value: string | null | undefined): number | null {
  const match = String(value || '').match(/toc_search_start:(\d+)/)
  return match ? Number(match[1]) : null
}

function getArchivePageNum(value: string | null | undefined): number | null {
  const match = String(value || '').match(/archive_page_num:(\d+)/)
  return match ? Number(match[1]) : null
}

function normalizeItems(docId: string, items: Array<Partial<TocItemV2>>, defaultSource: TocItemSource): TocItemV2[] {
  const seen = new Set<string>()
  return items
    .map((raw, index) => {
      const title = normalizeTitle(String(raw.title || ''))
      const key = normalizeForMatch(title)
      const source = normalizeSource(raw.source || defaultSource)
      const sourcePageKey = source === 'rule'
        ? Number(raw.source_page_num) || getPageHint(String(raw.href || raw.anchor_key || '')) || getTocSourcePage(raw.anchor_context) || ''
        : ''
      const seenKey = sourcePageKey ? `${key}:${sourcePageKey}` : key
      if (!title || !key || seen.has(seenKey)) return null
      seen.add(seenKey)
      const sourcePageNum = Number(raw.source_page_num)
      const pageNum = Number.isFinite(sourcePageNum) && sourcePageNum > 0
        ? sourcePageNum
        : getPageHint(String(raw.href || raw.anchor_key || ''))
      return {
        id: String(raw.id || '') || tocUid(docId, source, index),
        doc_id: docId,
        title,
        href: String(raw.href || (pageNum ? `page:${pageNum}` : '')),
        level: Math.max(1, Math.min(6, Number(raw.level) || getHeadingLevel(title))),
        order: index,
        parent_id: raw.parent_id ?? null,
        anchor_text: typeof raw.anchor_text === 'string' ? raw.anchor_text : title,
        anchor_context: typeof raw.anchor_context === 'string' ? raw.anchor_context : null,
        anchor_key: typeof raw.anchor_key === 'string' ? raw.anchor_key : pageNum ? `page:${pageNum}` : null,
        source_page_num: pageNum || null,
        source,
        confidence: Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : source === 'manual' ? 1 : 0.62,
        status: normalizeStatus(raw.status || (pageNum ? 'active' : 'unresolved')),
      } as TocItemV2
    })
    .filter((item): item is TocItemV2 => !!item)
    .slice(0, MAX_TOC_ITEMS)
}

function ensureUniqueStorageIds(docId: string, items: TocItemV2[]): TocItemV2[] {
  const requestedIds = Array.from(new Set(items.map((item) => String(item.id || '').trim()).filter(Boolean)))
  const idsOwnedByOtherDocs = new Set<string>()
  if (requestedIds.length > 0) {
    const placeholders = requestedIds.map(() => '?').join(',')
    queryAll<{ id: string; doc_id: string }>(
      `SELECT id, doc_id FROM document_toc_items WHERE id IN (${placeholders})`,
      requestedIds,
    ).forEach((row) => {
      if (row.doc_id !== docId) idsOwnedByOtherDocs.add(row.id)
    })
  }

  const seenIds = new Set<string>()
  const idMap = new Map<string, string>()
  const withSafeIds = items.map((item, index) => {
    const source = normalizeSource(item.source)
    const originalId = String(item.id || '').trim()
    const needsReplacement = !originalId || seenIds.has(originalId) || idsOwnedByOtherDocs.has(originalId)
    const nextId = needsReplacement ? tocUid(docId, source, index) : originalId
    if (originalId && !idMap.has(originalId)) idMap.set(originalId, nextId)
    seenIds.add(nextId)
    return { ...item, id: nextId }
  })

  return withSafeIds.map((item) => {
    if (!item.parent_id) return item
    return { ...item, parent_id: idMap.get(item.parent_id) || item.parent_id }
  })
}

function getPageHint(href: string): number | null {
  const match = String(href || '').match(/(?:page|p|source-page)[:/_-]?(\d+)/i)
  return match ? Number(match[1]) : null
}

function getCharHint(value: string | null | undefined): number | null {
  const match = String(value || '').match(/(?:char|offset)[:/_-]?(\d+)/i)
  return match ? Number(match[1]) : null
}

function findPageIndexByPageNum(pages: PageRow[], pageNum: number | null | undefined): number {
  if (!Number.isFinite(Number(pageNum))) return -1
  return pages.findIndex((page) => Number(page.page_num) === Number(pageNum))
}

function findBestPageForTitle(pages: PageRow[], title: string, tocPages: Set<number>, preferredPageNum?: number | null): number | null {
  const candidates = pages
    .map((page) => ({
      pageNum: Number(page.page_num),
      score: scorePageForTitle(page, title, tocPages, preferredPageNum),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.pageNum - right.pageNum)
  return candidates[0]?.pageNum || null
}

function findBestPageForTitleInRange(
  pages: PageRow[],
  title: string,
  tocPages: Set<number>,
  minPageNum: number,
  preferredPageNum?: number | null,
): number | null {
  const candidates = pages
    .filter((page) => Number(page.page_num) >= minPageNum)
    .map((page) => ({
      pageNum: Number(page.page_num),
      score: scorePageForTitle(page, title, tocPages, preferredPageNum),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.pageNum - right.pageNum)
  return candidates[0]?.pageNum || null
}

function findNextPageForRuleTitle(
  pages: PageRow[],
  title: string,
  tocPages: Set<number>,
  minPageNum: number,
  preferredPageNum?: number | null,
  maxPageNum?: number | null,
): number | null {
  const minPage = Math.max(1, Number(minPageNum) || 1)
  const candidates = pages
    .filter((page) => Number(page.page_num) >= minPage && (!Number(maxPageNum) || Number(page.page_num) <= Number(maxPageNum)))
    .map((page) => ({
      pageNum: Number(page.page_num),
      score: scorePageForTitle(page, title, tocPages, preferredPageNum),
    }))
    .filter((candidate) => candidate.score > 0)
  const strong = candidates.filter((candidate) => candidate.score >= 55)
  strong.sort((left, right) => left.pageNum - right.pageNum || right.score - left.score)
  return strong[0]?.pageNum || null
}

function getCompactPageText(page: PageRow, maxChars = 1200): string {
  const text = pageText(page).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length <= maxChars) return text
  const head = text.slice(0, Math.floor(maxChars * 0.64)).trim()
  const tail = text.slice(Math.max(0, text.length - Math.floor(maxChars * 0.24))).trim()
  return `${head}\n...\n${tail}`.trim()
}

function getLikelyHeadingLines(page: PageRow, limit = 18): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  const add = (value: string) => {
    const title = normalizeTocLineTitle(value)
    const key = normalizeForMatch(title)
    if (!title || !key || seen.has(key)) return
    if (!isLikelyHeadingLine(title) && !isRuleTocHeadingTitle(title)) return
    seen.add(key)
    lines.push(title)
  }
  getPageHeadingHints(page).forEach((hint) => add(hint.title))
  textForAnchor(page).split(/\n+/).slice(0, 80).forEach(add)
  return lines.slice(0, limit)
}

function getAiTocCandidatePages(pages: PageRow[], tocPages: PageRow[]): PageRow[] {
  const selected = new Map<number, PageRow>()
  const add = (page: PageRow | undefined) => {
    if (!page) return
    selected.set(Number(page.page_num), page)
  }
  tocPages.slice(0, 8).forEach(add)
  if (tocPages.length === 0) {
    pages.slice(0, Math.min(10, pages.length)).forEach(add)
  } else {
    tocPages.slice(0, 4).forEach((page) => {
      const pageNum = Number(page.page_num)
      pages
        .filter((candidate) => Number(candidate.page_num) > pageNum && Number(candidate.page_num) <= pageNum + 3)
        .forEach(add)
    })
  }
  pages.slice(0, Math.min(4, pages.length)).forEach(add)
  return Array.from(selected.values())
    .sort((left, right) => Number(left.page_num) - Number(right.page_num))
    .slice(0, 18)
}

function getAiTocStructureHints(pages: PageRow[], limit = 90): Array<{ pageNum: number; titles: string[] }> {
  const hints: Array<{ pageNum: number; titles: string[] }> = []
  for (const page of pages) {
    if (hints.length >= limit) break
    if (isLikelyTocPage(page)) continue
    const titles = getLikelyHeadingLines(page, 8)
    if (titles.length) hints.push({ pageNum: Number(page.page_num), titles })
  }
  return hints
}

function getNextTocSourcePage(items: TocItemV2[], index: number): number | null {
  const current = getTocSearchStartPage(items[index]?.anchor_context) || getTocSourcePage(items[index]?.anchor_context)
  if (!current) return null
  for (let cursor = index + 1; cursor < items.length; cursor += 1) {
    const next = getTocSearchStartPage(items[cursor]?.anchor_context) || getTocSourcePage(items[cursor]?.anchor_context)
    if (next && next > current) return next
  }
  return null
}

function getUniformTocSource(items: TocItemV2[]): TocItemSource | null {
  const sources = new Set(items.map((item) => item.source).filter(Boolean))
  return sources.size === 1 ? Array.from(sources)[0] : null
}

function repairStoredTocItems(docId: string, existing: TocItemV2[], pages: PageRow[]): TocItemV2[] {
  const source = getUniformTocSource(existing)
  if (existing.some((item) => item.source === 'manual' || item.source === 'imported')) return existing
  if (source === 'manual') return existing
  const repaired = bindItemsToPages(existing, pages)
  const tocPages = tocPageSet(pages)
  const existingActive = existing.filter((item) => item.status === 'active' && Number(item.source_page_num || 0) > 0).length
  const repairedActive = repaired.filter((item) => item.status === 'active' && Number(item.source_page_num || 0) > 0).length
  const existingResolved = existing.filter((item) => item.status === 'active').length
  const repairedResolved = repaired.filter((item) => item.status === 'active').length
  const existingPrecise = existing.filter((item) => hasPreciseAnchor(item)).length
  const repairedPrecise = repaired.filter((item) => hasPreciseAnchor(item)).length
  const existingNullAnchors = existing.filter((item) => !item.anchor_key).length
  const repairedNullAnchors = repaired.filter((item) => !item.anchor_key).length
  const existingTocPageAnchors = existing.filter((item) => tocPages.has(Number(item.source_page_num || 0))).length
  const repairedTocPageAnchors = repaired.filter((item) => tocPages.has(Number(item.source_page_num || 0))).length
  const changedActivePages = repaired.some((item, index) => {
    const before = existing[index]
    if (!before) return false
    return item.status === 'active'
      && before.status === 'active'
      && Number(item.source_page_num || 0) > 0
      && Number(before.source_page_num || 0) > 0
      && Number(item.source_page_num || 0) !== Number(before.source_page_num || 0)
  })
  if (
    repairedActive > existingActive
    || repairedResolved > existingResolved
    || repairedPrecise > existingPrecise
    || repairedNullAnchors < existingNullAnchors
    || repairedTocPageAnchors < existingTocPageAnchors
    || changedActivePages
  ) {
    return saveDocumentToc(docId, repaired, source || 'rule')
  }
  return existing
}

function scorePageForTitle(page: PageRow, title: string, tocPages: Set<number>, preferredPageNum?: number | null): number {
  if (tocPages.has(Number(page.page_num))) return 0
  const text = textForAnchor(page)
  if (!text) return 0
  const normalizedTitle = normalizeForMatch(title)
  const headingTitle = normalizeHeadingKey(title)
  const normalizedText = normalizeForMatch(text)
  const archiveMatch = textMatchesTitleKey(text, title)
  const archiveSimilarity = archiveTitleSimilarity(text.slice(0, 2200), title)
  if (!normalizedTitle || (!normalizedText.includes(normalizedTitle) && (!headingTitle || !normalizedText.includes(headingTitle)) && !archiveMatch && archiveSimilarity < 0.45)) return 0
  let score = 20
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  lines.slice(0, 32).forEach((line, index) => {
    const normalizedLine = normalizeForMatch(line)
    const headingLine = normalizeHeadingKey(line)
    if (!normalizedLine) return
    if (normalizedLine === normalizedTitle) score = Math.max(score, 95 - index)
    else if (normalizedLine.startsWith(normalizedTitle) && normalizedLine.length <= normalizedTitle.length + 12) {
      score = Math.max(score, 80 - index)
    } else if (normalizedTitle.startsWith(normalizedLine) && normalizedLine.length >= Math.min(6, normalizedTitle.length)) {
      score = Math.max(score, 62 - index)
    } else if (headingTitle && headingLine && (headingLine === headingTitle || headingLine.startsWith(headingTitle) || headingTitle.startsWith(headingLine))) {
      score = Math.max(score, 78 - index)
    }
    if (textMatchesTitleKey(line, title)) score = Math.max(score, 70 - index)
    if (isLikelyHeadingLine(line) && (normalizedLine.includes(normalizedTitle) || (!!headingTitle && normalizedLine.includes(headingTitle)))) score += 12
  })
  if (archiveMatch) score = Math.max(score, 58)
  if (archiveSimilarity >= 0.62) score = Math.max(score, 58)
  else if (archiveSimilarity >= 0.45) score = Math.max(score, 44)
  if (preferredPageNum && Number(page.page_num) >= preferredPageNum) score += 4
  return score
}

function findTitleCharIndex(page: PageRow, title: string): number {
  const headingHint = findHeadingHintForTitle(page, title)
  if (headingHint) return Math.max(0, headingHint.charIndex)
  return findTitleCharIndexInText(textForAnchor(page), title)
}

function pageHasTitle(page: PageRow, title: string): boolean {
  const key = normalizeForMatch(title)
  if (!key) return false
  return normalizeForMatch(textForAnchor(page).slice(0, 8000)).includes(key)
    || textMatchesTitleKey(textForAnchor(page).slice(0, 8000), title)
}

function pageHasStrongTitle(page: PageRow, title: string, tocPages: Set<number>): boolean {
  return scorePageForTitle(page, title, tocPages) >= 55
}

function isGenericVolumeOnlyTitle(title: string): boolean {
  const text = normalizeTitle(title).replace(/\s+/g, '')
  if (!text) return false
  return /^(?:卷首|卷末|卷之?[一二兩两三四五六七八九十百千〇零○\d]{1,6}|[一二兩两三四五六七八九十百千〇零○\d]{1,6}卷)$/.test(text)
}

function hasPreciseAnchor(item: Partial<TocItemV2>): boolean {
  return getCharHint(item.anchor_key) !== null || getCharHint(item.href) !== null
}

function attachPreciseAnchor(item: TocItemV2, page: PageRow, title: string): TocItemV2 {
  const charIndex = Math.max(0, findTitleCharIndex(page, title))
  const pageNum = Number(page.page_num)
  return {
    ...item,
    href: `page:${pageNum}:char:${charIndex}`,
    anchor_key: `page:${pageNum}:char:${charIndex}`,
    anchor_text: item.anchor_text || title,
    source_page_num: pageNum,
    status: 'active',
    confidence: Math.max(Number(item.confidence || 0), 0.76),
  }
}

function tocPageSet(pages: PageRow[]): Set<number> {
  return new Set(pages
    .filter((page) => isLikelyTocPage(page) && !textForAnchor(page).split(/\n+/).some((line) => {
      const title = normalizeTitle(line.replace(/^#{1,6}\s*/, ''))
      return /^#{1,6}\s+\S/.test(line.trim()) && !GENERIC_TITLES.has(title.toLowerCase())
    }))
    .map((page) => Number(page.page_num)))
}

function improveAiAnchors(aiItems: TocItemV2[], ruleItems: TocItemV2[], pages: PageRow[]): TocItemV2[] {
  const ruleByTitle = new Map<string, TocItemV2>()
  const tocPages = tocPageSet(pages)
  ruleItems.forEach((item) => {
    const key = normalizeForMatch(item.title)
    if (key && !ruleByTitle.has(key)) ruleByTitle.set(key, item)
  })

  return aiItems.map((item) => {
    const key = normalizeForMatch(item.anchor_text || item.title)
    const matchedRule = key ? ruleByTitle.get(key) : undefined
    if (matchedRule?.source_page_num && hasPreciseAnchor(matchedRule)) {
      return {
        ...item,
        href: matchedRule.href || `page:${matchedRule.source_page_num}`,
        anchor_key: matchedRule.anchor_key,
        anchor_text: item.anchor_text || matchedRule.anchor_text || item.title,
        anchor_context: item.anchor_context ?? matchedRule.anchor_context ?? null,
        source_page_num: matchedRule.source_page_num,
        status: 'active',
        confidence: Math.max(Number(item.confidence || 0), Number(matchedRule.confidence || 0), 0.8),
      }
    }

    const preferredPageNum = Number(item.source_page_num || getPageHint(item.href || item.anchor_key || ''))
    const preferredPage = Number.isFinite(preferredPageNum) && preferredPageNum > 0
      ? pages.find((page) => Number(page.page_num) === preferredPageNum)
      : undefined
    if (preferredPage && pageHasStrongTitle(preferredPage, item.anchor_text || item.title, tocPages)) {
      return attachPreciseAnchor(item, preferredPage, item.anchor_text || item.title)
    }

    const hintMatch = pages
      .map((page) => ({ page, hint: findHeadingHintForTitle(page, item.anchor_text || item.title) }))
      .find((candidate) => !!candidate.hint)
    if (hintMatch) return attachPreciseAnchor(item, hintMatch.page, hintMatch.hint?.title || item.title)

    const bestPageNum = findBestPageForTitle(pages, item.anchor_text || item.title, tocPages, preferredPageNum || null)
    const bestPage = bestPageNum ? pages.find((page) => Number(page.page_num) === bestPageNum) : undefined
    if (bestPage && pageHasStrongTitle(bestPage, item.anchor_text || item.title, tocPages)) {
      return attachPreciseAnchor(item, bestPage, item.anchor_text || item.title)
    }

    return {
      ...item,
      href: '',
      anchor_key: null,
      source_page_num: null,
      status: 'unresolved',
      confidence: Math.min(Number(item.confidence || 0), 0.35),
    }
  })
}

function bindItemsToPages(items: TocItemV2[], pages: PageRow[]): TocItemV2[] {
  const tocPages = tocPageSet(pages)
  let lastChapterOrdinal = 0
  let lastPageNum = 0
  const orderedItems = [...items].sort((left, right) => {
    const leftPage = Number(left.source_page_num || getPageHint(left.href) || 0)
    const rightPage = Number(right.source_page_num || getPageHint(right.href) || 0)
    if (leftPage && rightPage && leftPage !== rightPage) return leftPage - rightPage
    if (leftPage && !rightPage) return -1
    if (!leftPage && rightPage) return 1
    return Number(left.order || 0) - Number(right.order || 0)
  })
  return orderedItems.map((item, index) => {
    const preferred = Number(item.source_page_num || getPageHint(item.href))
    const tocSourcePage = item.source === 'rule' ? getTocSourcePage(item.anchor_context) : null
    const tocSearchStartPage = item.source === 'rule' ? getTocSearchStartPage(item.anchor_context) : null
    const archivePageNum = item.source === 'rule' ? getArchivePageNum(item.anchor_context) : null
    const archivePageGuess = archivePageNum && tocSearchStartPage
      ? Math.max(1, tocSearchStartPage + archivePageNum - 1)
      : null
    let pageNum = Number.isFinite(preferred) && preferred > 0 ? preferred : null
    if (!pageNum && archivePageGuess) pageNum = archivePageGuess
    const title = item.anchor_text || item.title
    const ruleTitleTooGeneric = item.source === 'rule' && isGenericVolumeOnlyTitle(title)
    const nextTocSourcePage = item.source === 'rule' ? getNextTocSourcePage(items, index) : null
    const minRulePage = tocSearchStartPage
      ? Math.max(tocSearchStartPage, lastPageNum || 1)
      : tocSourcePage
        ? Math.max(tocSourcePage + 1, lastPageNum || 1)
        : Math.max(1, lastPageNum || 1)
    let preferredIndex = findPageIndexByPageNum(pages, pageNum)
    let preferredPage = preferredIndex >= 0 ? pages[preferredIndex] : null
    const maxRulePage = nextTocSourcePage ? Math.max(minRulePage, nextTocSourcePage - 1) : null
    const hasArticleStructureAnchor = item.source === 'rule'
      && String(item.anchor_context || '').startsWith('article_structure:')
      && hasPreciseAnchor(item)
    const rulePreferredLooksWrong = item.source === 'rule'
      && !!pageNum
      && !hasArticleStructureAnchor
      && (!preferredPage || tocPages.has(pageNum) || !pageHasStrongTitle(preferredPage, title, tocPages))

    if (rulePreferredLooksWrong || ruleTitleTooGeneric) {
      pageNum = null
      preferredIndex = -1
      preferredPage = null
    }

    if (!ruleTitleTooGeneric && (!pageNum || preferredIndex < 0 || tocPages.has(pageNum))) {
      const archiveSearchStart = archivePageGuess && archivePageGuess <= pages.length
        ? Math.max(minRulePage, archivePageGuess)
        : minRulePage
      pageNum = item.source === 'rule'
        ? findNextPageForRuleTitle(pages, title, tocPages, archivePageNum ? archiveSearchStart : minRulePage, preferred, maxRulePage) || pageNum
        : findBestPageForTitle(pages, title, tocPages, preferred) || pageNum
    }
    if (pageNum && tocPages.has(pageNum)) {
      const laterBodyHit = pages.find((page) => Number(page.page_num) > Number(pageNum) && !tocPages.has(Number(page.page_num)) && pageHasTitle(page, item.anchor_text || item.title))
      if (laterBodyHit) pageNum = Number(laterBodyHit.page_num)
      else if (item.status === 'unresolved' || Number(item.confidence || 0) < 0.5) pageNum = null
    }
    const boundPage = pages.find((page) => Number(page.page_num) === Number(pageNum))
    const existingChar = getCharHint(item.anchor_key)
    const charIndex = existingChar ?? (boundPage ? findTitleCharIndex(boundPage, item.anchor_text || item.title) : 0)
    const ordinal = getChapterOrdinal(item.title)
    if (ordinal && ordinal <= lastChapterOrdinal && pageNum && pageNum < lastPageNum) {
      pageNum = null
    }
    if (ordinal && ordinal > lastChapterOrdinal) lastChapterOrdinal = ordinal
    if (pageNum && pageNum > lastPageNum) lastPageNum = pageNum
    return {
      ...item,
      order: index,
      href: item.source === 'imported' && item.href ? item.href : pageNum ? `page:${pageNum}` : item.href || '',
      anchor_key: pageNum ? `page:${pageNum}:char:${Math.max(0, charIndex)}` : item.anchor_key ?? null,
      source_page_num: pageNum || null,
      status: pageNum ? 'active' : 'unresolved',
      confidence: pageNum ? Math.max(item.confidence, item.source === 'manual' ? 1 : 0.68) : Math.min(item.confidence, 0.35),
    }
  })
}

function extractTocFromTocPages(docId: string, pages: PageRow[]): TocItemV2[] {
  const rawItems: Partial<TocItemV2>[] = []
  const tocPageNums = tocPageSet(pages)
  const tocSearchStartByPage = new Map<number, number>()
  const docType = String(queryAll<{ doc_type?: string }>('SELECT doc_type FROM documents WHERE id = ? LIMIT 1', [docId])[0]?.doc_type || '')
  pages.forEach((page) => {
    const pageNum = Number(page.page_num)
    if (!tocPageNums.has(pageNum) || tocSearchStartByPage.has(pageNum)) return
    let end = pageNum
    while (tocPageNums.has(end + 1)) end += 1
    for (let cursor = pageNum; cursor <= end; cursor += 1) tocSearchStartByPage.set(cursor, end + 1)
  })
  pages.forEach((page) => {
    const searchStartPage = tocSearchStartByPage.get(Number(page.page_num))
    if (!searchStartPage) return
    const lines = getTocCandidateLines(page)
    const archiveEntries = getArchiveInventoryEntries(page)
    if (archiveEntries.length > 0 && /档案|手稿|馆藏|卷宗|案卷|文件|记事簿/.test(docType)) {
      archiveEntries.forEach((entry, index) => {
        const archivePageNum = entry.archivePageNum || 0
        if (!archivePageNum) return
        rawItems.push({
          id: uid('toc_rule_page'),
          title: entry.title,
          href: '',
          level: index === 0 ? 1 : 2,
          source_page_num: null,
          anchor_text: entry.title,
          anchor_context: `toc_source_page:${page.page_num}\ntoc_search_start:${searchStartPage}\narchive_page_num:${archivePageNum}\n${entry.rawLine.slice(0, 220)}`,
          confidence: 0.76,
        })
      })
      return
    }
    lines.forEach((line) => {
      const entry = parseTocEntryLine(line)
      if (!entry) return
      if (isRealClassicalCollectionHeaderTitle(entry.title) || isClassicalCollectionHeaderTitle(entry.title)) return
      rawItems.push({
        id: uid('toc_rule_page'),
        title: entry.title,
        href: entry.hintedPageNum ? `page:${entry.hintedPageNum}` : '',
        level: entry.level,
        source_page_num: entry.hintedPageNum,
        anchor_text: entry.title,
        anchor_context: `toc_source_page:${page.page_num}\ntoc_search_start:${searchStartPage}\n${line.slice(0, 220)}`,
        confidence: entry.hintedPageNum ? 0.78 : 0.55,
      })
    })
  })
  return bindItemsToPages(normalizeItems(docId, rawItems, 'rule'), pages)
}

function extractHeadingToc(docId: string, pages: PageRow[]): TocItemV2[] {
  if (shouldSuppressTocForRegisterArchive(docId, pages)) return []
  const result: Partial<TocItemV2>[] = []
  const repeated = new Map<string, number>()
  const tocTextKey = normalizeForMatch(pages.filter((page) => isLikelyTocPage(page)).map(pageText).join('\n'))
  const hasTocText = tocTextKey.length > 0
  const sparseLargeClassicalDoc = pages.length >= 200 && tocTextKey.length < 12000
  pages.forEach((page) => {
    const lines = textForAnchor(page).split(/\n+/).map((line) => line.trim()).filter(Boolean)
    const hasBodyMarkdownHeadings = lines.some((line) => {
      const title = normalizeTitle(line.replace(/^#{1,6}\s*/, ''))
      return /^#{1,6}\s+\S/.test(line) && !GENERIC_TITLES.has(title.toLowerCase())
    })
    if (isLikelyTocPage(page) && !hasBodyMarkdownHeadings) return
    const blocks = getOcrBlocks(page)
    const blockItems = blocks
      .map((block, index) => {
        const text = normalizeTocLineTitle(getBlockText(block))
        if (!text || !isOcrTitleBlock(block, text) || !isRuleTocHeadingTitle(text)) return null
        if (isRealClassicalCollectionHeaderTitle(text) || isClassicalCollectionHeaderTitle(text)) return null
        return {
          title: text,
          level: /doc_title|article_title|section_title/.test(getBlockLabel(block)) ? 1 : getHeadingLevel(text),
          order: getBlockOrder(block, index),
          context: getBlockText(block).slice(0, 220),
        }
      })
      .filter((item): item is { title: string; level: number; order: number; context: string } => !!item)
    const lineItems = lines
      .map((line, index) => {
        const title = normalizeHeadingCandidateTitle(line)
        if (!isLikelyHeadingLine(line) || !isRuleTocHeadingTitle(title)) return null
        if (isRealClassicalCollectionHeaderTitle(title) || isClassicalCollectionHeaderTitle(title)) return null
        return {
          title,
          level: getHeadingLevel(line),
          order: blocks.length + index,
          context: line.slice(0, 220),
        }
      })
      .filter((item): item is { title: string; level: number; order: number; context: string } => !!item)

    const candidates = [...blockItems, ...lineItems].sort((left, right) => left.order - right.order)
    for (const candidate of candidates) {
      const title = normalizeTocLineTitle(candidate.title)
      const key = normalizeForMatch(title)
      if (!title || !key) continue
      if (hasTocText && !sparseLargeClassicalDoc && !tocTextKey.includes(key) && !key.startsWith('第') && !isStandardArticleHeadingTitle(title) && !isRomanHeadingTitle(title) && !isArticleNumberedHeadingTitle(title) && !isClassicalRuleTocTitle(title)) continue
      if (isClassicalVolumeTitle(title) && title.length > 24) continue
      repeated.set(key, (repeated.get(key) || 0) + 1)
      if ((repeated.get(key) || 0) > 1 && /^第.+[章节卷編编篇部]/.test(title)) continue
      if ((repeated.get(key) || 0) > 1) continue
      result.push({
        id: uid('toc_rule_heading'),
        title,
        href: `page:${page.page_num}`,
        level: candidate.level,
        source_page_num: page.page_num,
        anchor_text: title,
        anchor_context: candidate.context,
        anchor_key: `page:${page.page_num}:char:${findTitleCharIndex(page, title)}`,
        confidence: blockItems.some((item) => item.title === candidate.title) ? 0.82 : 0.68,
      })
    }
  })
  return bindItemsToPages(normalizeItems(docId, result, 'rule'), pages)
}

function isShortArticleLikeDocument(docId: string, pages: PageRow[]): boolean {
  if (pages.length === 0 || pages.length > 40) return false
  const profile = getDocumentTocProfile(docId)
  const identity = `${profile.title} ${profile.docType}`.replace(/\s+/g, '')
  if (/期刊|论文|論文|学报|學報|journal|article/i.test(identity)) return true
  const firstPages = pages.slice(0, 2).map((page) => pageText(page)).join('\n')
  return /摘要|关键词|關鍵詞|Abstract|Keywords/i.test(firstPages)
}

function makeArticleStructureItem(
  title: string,
  page: PageRow,
  charIndex: number,
  level: number,
  confidence: number,
): Partial<TocItemV2> {
  const pageNum = Number(page.page_num)
  const safeCharIndex = Math.max(0, Math.floor(charIndex))
  return {
    id: uid('toc_rule_article'),
    title,
    href: `page:${pageNum}:char:${safeCharIndex}`,
    level,
    source_page_num: pageNum,
    anchor_text: title,
    anchor_context: `article_structure:${title}`,
    anchor_key: `page:${pageNum}:char:${safeCharIndex}`,
    confidence,
  }
}

function findArticleMarker(
  pages: PageRow[],
  title: string,
  patterns: RegExp[],
  level = 2,
  confidence = 0.8,
): Partial<TocItemV2> | null {
  for (const page of pages) {
    const text = textForAnchor(page)
    for (const pattern of patterns) {
      const match = text.match(pattern)
      if (!match) continue
      return makeArticleStructureItem(title, page, match.index ?? text.indexOf(match[0]), level, confidence)
    }
  }
  return null
}

function findShortArticleMainTitle(pages: PageRow[], fallback: string): string {
  const firstPage = pages[0]
  const markdownTitle = textForAnchor(firstPage || { id: '', page_num: 1, ocr_text: '', proofed_text: '', ocr_result: null })
    .split(/\n+/)
    .map((line) => line.trim())
    .map((line) => line.match(/^#\s+(.{2,120})$/)?.[1])
    .find(Boolean)
  if (markdownTitle) return normalizeTitle(markdownTitle)
  return normalizeTitle(fallback).replace(/[_-][^_-]{1,24}$/, '')
}

function isShortArticleStructureHeadingLine(line: string, title: string): boolean {
  const cleanTitle = normalizeTitle(title)
  if (!cleanTitle || cleanTitle.length > 90) return false
  if (GENERIC_TITLES.has(cleanTitle.toLowerCase())) return false
  if (/作者简介|基金项目|收稿日期|中图分类号|文献标识码|文章编号/.test(cleanTitle)) return false
  if (/^#{1,6}\s+\S/.test(line) && !/^#{1,6}\s*(摘要|关键词|關鍵詞|作者简介|基金项目)/i.test(line)) return true
  if (/^[一二两兩三四五六七八九十百千〇零○\d]{1,4}\s*[、.．]\s*\S{2,80}$/.test(cleanTitle)) return true
  if (/^[（(][一二两兩三四五六七八九十百千〇零○\d]{1,4}[)）]\s*\S{2,80}$/.test(cleanTitle)) return true
  if (isStandardArticleHeadingTitle(cleanTitle)) return true
  return false
}

function findImplicitReferenceListMarker(pages: PageRow[]): Partial<TocItemV2> | null {
  for (const page of pages.slice(-3)) {
    const text = textForAnchor(page)
    const lines = text.split(/\n+/)
    let cursor = 0
    for (const line of lines) {
      const trimmed = line.trim()
      const looksLikeReference = /(?:\[(?:J|M|R|Z|N|D|C)\]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚])/.test(trimmed)
        && /[.．]/.test(trimmed)
      if (looksLikeReference) return makeArticleStructureItem('参考文献', page, cursor, 1, 0.7)
      cursor += line.length + 1
    }
  }
  return null
}

function extractShortArticleStructureToc(docId: string, pages: PageRow[]): TocItemV2[] {
  if (!isShortArticleLikeDocument(docId, pages)) return []
  const rawItems: Partial<TocItemV2>[] = []
  const seen = new Set<string>()
  const add = (item: Partial<TocItemV2> | null) => {
    const key = normalizeForMatch(String(item?.title || ''))
    if (!item || !key || seen.has(key)) return
    seen.add(key)
    rawItems.push(item)
  }

  const profile = getDocumentTocProfile(docId)
  const firstPage = pages[0]
  const title = findShortArticleMainTitle(pages, profile.title || '')
  if (firstPage && title && title.length <= 120 && !GENERIC_TITLES.has(title.toLowerCase())) {
    add(makeArticleStructureItem(title, firstPage, findTitleCharIndex(firstPage, title), 1, 0.84))
  }

  add(findArticleMarker(pages.slice(0, 3), '摘要', [
    /[\[【〔(（]?\s*摘要\s*[\]】〕)）]?[:：]?/,
    /\bAbstract\b[:：]?/i,
  ]))
  add(findArticleMarker(pages.slice(0, 3), '关键词', [
    /[\[【〔(（]?\s*(?:关键词|關鍵詞)\s*[\]】〕)）]?[:：]?/,
    /\bKeywords?\b[:：]?/i,
  ]))

  for (const page of pages) {
    const lines = textForAnchor(page).split(/\n+/).map((line) => line.trim()).filter(Boolean)
    lines.slice(0, 120).forEach((line) => {
      const titleCandidate = normalizeHeadingCandidateTitle(line)
      if (titleCandidate && normalizeForMatch(titleCandidate) === normalizeForMatch(title)) return
      const usableHeading = (isLikelyHeadingLine(line) && isRuleTocHeadingTitle(titleCandidate))
        || isShortArticleStructureHeadingLine(line, titleCandidate)
      if (!usableHeading) return
      if (isStandardArticleHeadingTitle(titleCandidate) && /摘要|关键词|關鍵詞|Abstract|Keywords?/i.test(titleCandidate)) return
      add(makeArticleStructureItem(
        titleCandidate,
        page,
        findTitleCharIndex(page, titleCandidate),
        getHeadingLevel(titleCandidate),
        0.72,
      ))
    })
  }

  add(findArticleMarker(pages, '参考文献', [
    /(?:参考文献|參考文獻|引用书目|引用書目)[:：]?/,
    /\bReferences\b[:：]?/i,
  ], 1, 0.82) || findImplicitReferenceListMarker(pages))
  add(findArticleMarker(pages, '注释', [
    /(?:注释|註釋|注释和参考文献|註釋和參考文獻)[:：]?/,
  ], 1, 0.78))

  return bindItemsToPages(normalizeItems(docId, rawItems, 'rule'), pages)
}

export function buildRuleToc(docId: string): TocItemV2[] {
  const pages = getPages(docId)
  if (shouldSuppressTocForRegisterArchive(docId, pages)) return []
  const fromTocPages = filterWeakClassicalVolumeNoise(extractTocFromTocPages(docId, pages))
  const fromHeadings = filterWeakClassicalVolumeNoise(extractHeadingToc(docId, pages))
  const fromArticleStructure = extractShortArticleStructureToc(docId, pages)
  const tocActiveCount = fromTocPages.filter((item) => item.status === 'active').length
  const headingActiveCount = fromHeadings.filter((item) => item.status === 'active').length
  const articleStructureActiveCount = fromArticleStructure.filter((item) => item.status === 'active').length
  const archiveTocCount = fromTocPages.filter((item) => getArchivePageNum(item.anchor_context)).length
  const sparseLargeDocToc = pages.length >= 200 && tocActiveCount < 8
  if (archiveTocCount >= 3) return enforceOrder(repairTocPageOrder(fromTocPages, pages))
  if (tocActiveCount >= 8 || (tocActiveCount >= 4 && headingActiveCount === 0 && !sparseLargeDocToc)) return enforceOrder(repairTocPageOrder(fromTocPages, pages))
  if (tocActiveCount >= 3 && headingActiveCount >= 3) return enforceOrder(mergeRuleCandidates(fromTocPages, fromHeadings))
  if (tocActiveCount > 0 && headingActiveCount >= 3) return enforceOrder(mergeRuleCandidates(fromTocPages, fromHeadings))
  if (tocActiveCount >= 3 && !sparseLargeDocToc) return enforceOrder(repairTocPageOrder(fromTocPages, pages))
  if (tocActiveCount === 0 && headingActiveCount + articleStructureActiveCount >= 2) {
    return enforceOrder(mergeRuleCandidates(fromHeadings, fromArticleStructure))
  }
  return enforceOrder(repairTocPageOrder(fromHeadings, pages))
}

function filterWeakClassicalVolumeNoise(items: TocItemV2[]): TocItemV2[] {
  const cleanItems = items.filter((item) => {
    const title = item.anchor_text || item.title
    return !isRealClassicalCollectionHeaderTitle(title) && !isClassicalCollectionHeaderTitle(title)
  })
  const bareVolumeItems = cleanItems.filter((item) => isRealBareClassicalVolumeTitle(item.title) || isBareClassicalVolumeTitle(item.title))
  if (bareVolumeItems.length === 0) return cleanItems

  const meaningfulItems = cleanItems.filter((item) => !bareVolumeItems.includes(item))
  const ordinals = bareVolumeItems
    .map((item) => getRealBareClassicalVolumeOrdinal(item.title) ?? getBareClassicalVolumeOrdinal(item.title))
    .filter((value): value is number => Number.isFinite(value))
    .sort((left, right) => left - right)
  let adjacentPairs = 0
  for (let index = 1; index < ordinals.length; index += 1) {
    if (ordinals[index] === ordinals[index - 1] + 1) adjacentPairs += 1
  }
  const looksLikeVolumeCatalog = bareVolumeItems.length >= 4 && adjacentPairs >= 2
  if (looksLikeVolumeCatalog) return cleanItems

  // A lone volume header is usually a page running head, not a usable table of contents entry.
  return meaningfulItems
}

function isUsefulRuleToc(items: TocItemV2[]): boolean {
  const activeItems = items.filter((item) => item.status === 'active' && Number(item.source_page_num || 0) > 0)
  if (activeItems.length >= 3) return true
  const distinctPages = new Set(activeItems.map((item) => Number(item.source_page_num || 0))).size
  return activeItems.length >= 2 && distinctPages >= 2 && items.some((item) => Number(item.confidence || 0) >= 0.78)
}

function shouldRetryEmptyAutogenAttempt(docId: string, pages: PageRow[]): boolean {
  if (pages.length === 0 || pages.length > 60) return false
  if (isShortArticleLikeDocument(docId, pages)) return true
  return pages.slice(0, 20).some((page) => getLikelyHeadingLines(page, 4).length > 0)
}

function shouldRepairStoredRuleToc(existing: TocItemV2[], pages: PageRow[]): boolean {
  if (!existing.length || !pages.length) return false
  if (existing.some((item) => item.source === 'manual' || item.source === 'ai' || item.source === 'imported')) return false
  if (existing.some((item) => item.source !== 'rule')) return false

  const activeItems = existing.filter((item) => item.status === 'active' && Number(item.source_page_num || 0) > 0)
  const pageCount = pages.length
  const distinctPages = new Set(activeItems.map((item) => Number(item.source_page_num || 0))).size
  if (pageCount >= 1000 && activeItems.length < 12) return true
  if (pageCount >= 200 && activeItems.length < 4) return true
  return existing.length > 0 && distinctPages <= 1 && pageCount >= 80
}

function mergeRuleCandidates(primary: TocItemV2[], secondary: TocItemV2[]): TocItemV2[] {
  const result: TocItemV2[] = []
  const hasNearby = (candidate: TocItemV2) => {
    const key = normalizeForMatch(candidate.title)
    const page = Number(candidate.source_page_num || 0)
    return result.some((item) => {
      const itemPage = Number(item.source_page_num || 0)
      return normalizeForMatch(item.title) === key && itemPage > 0 && page > 0 && Math.abs(itemPage - page) <= 3
    })
  }
  for (const item of [...primary, ...secondary]) {
    if (!normalizeForMatch(item.title)) continue
    if (hasNearby(item)) continue
    result.push(item)
  }
  return result.sort((left, right) => {
    const leftPage = Number(left.source_page_num || 0)
    const rightPage = Number(right.source_page_num || 0)
    if (leftPage !== rightPage) return (leftPage || Number.MAX_SAFE_INTEGER) - (rightPage || Number.MAX_SAFE_INTEGER)
    return Number(left.order || 0) - Number(right.order || 0)
  })
}

function enforceOrder(items: TocItemV2[]): TocItemV2[] {
  const ordered = [...items].sort((left, right) => {
    const leftPage = Number(left.source_page_num || 0)
    const rightPage = Number(right.source_page_num || 0)
    if (leftPage !== rightPage) return (leftPage || Number.MAX_SAFE_INTEGER) - (rightPage || Number.MAX_SAFE_INTEGER)
    return Number(right.confidence || 0) - Number(left.confidence || 0) || Number(left.order || 0) - Number(right.order || 0)
  })
  const seen = new Map<string, number>()
  let lastPage = 0
  let lastChapter = 0
  const result: TocItemV2[] = []
  for (const item of ordered) {
    const key = normalizeForMatch(item.title)
    if (!key) continue
    const chapter = getChapterOrdinal(item.title)
    const page = Number(item.source_page_num || 0)
    const previousPage = seen.get(key)
    if (previousPage !== undefined) {
      if (!page || !previousPage || Math.abs(page - previousPage) <= 3) continue
    }
    if (chapter && chapter <= lastChapter && result.some((existing) => getChapterOrdinal(existing.title) === chapter)) continue
    if (chapter && page && page < lastPage) continue
    seen.set(key, page || 0)
    if (chapter) lastChapter = chapter
    if (page) lastPage = Math.max(lastPage, page)
    result.push({ ...item, order: result.length })
  }
  const reliable = result.filter((item) => Number(item.confidence || 0) >= 0.78 || isClassicalCatalogEntryTitle(item.title))
  return (reliable.length >= 20 ? reliable : result).slice(0, MAX_TOC_ITEMS).map((item, index) => ({ ...item, order: index }))
}

function repairTocPageOrder(items: TocItemV2[], pages: PageRow[]): TocItemV2[] {
  const tocPages = tocPageSet(pages)
  let lastActivePage = 0
  return items.map((item) => {
    const pageNum = Number(item.source_page_num || 0)
    if (item.status !== 'active' || !pageNum) return item
    if (pageNum >= lastActivePage) {
      lastActivePage = pageNum
      return item
    }
    const title = item.anchor_text || item.title
    const repairedPageNum = findBestPageForTitleInRange(pages, title, tocPages, lastActivePage, pageNum)
    if (repairedPageNum) {
      const repairedPage = pages.find((page) => Number(page.page_num) === repairedPageNum)
      if (repairedPage) {
        lastActivePage = repairedPageNum
        return attachPreciseAnchor(item, repairedPage, title)
      }
    }
    return {
      ...item,
      href: '',
      anchor_key: null,
      source_page_num: null,
      status: 'unresolved',
      confidence: Math.min(Number(item.confidence || 0), 0.35),
    }
  })
}

function mergeRuleAndAiToc(ruleItems: TocItemV2[], aiItems: TocItemV2[]): TocItemV2[] {
  if (aiItems.length === 0) return []

  const merged = new Map<string, TocItemV2>()
  const mergeKeepingRuleAnchor = (ruleItem: TocItemV2, aiItem: TocItemV2): TocItemV2 => ({
    ...ruleItem,
    title: aiItem.title || ruleItem.title,
    level: aiItem.level || ruleItem.level,
    order: ruleItem.order,
    parent_id: aiItem.parent_id ?? ruleItem.parent_id ?? null,
    anchor_text: ruleItem.anchor_text || aiItem.anchor_text || aiItem.title || ruleItem.title,
    anchor_context: ruleItem.anchor_context ?? aiItem.anchor_context ?? null,
    href: ruleItem.href || (ruleItem.source_page_num ? `page:${ruleItem.source_page_num}` : aiItem.href || ''),
    anchor_key: ruleItem.anchor_key || aiItem.anchor_key || null,
    source_page_num: ruleItem.source_page_num ?? aiItem.source_page_num ?? null,
    source: 'ai',
    confidence: Math.max(Number(ruleItem.confidence || 0), Number(aiItem.confidence || 0), 0.8),
    status: ruleItem.status || aiItem.status || 'active',
  })
  const addItem = (item: TocItemV2) => {
    const key = normalizeForMatch(item.title)
    if (!key) return
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, item)
      return
    }

    if (existing.source === 'rule' && hasPreciseAnchor(existing) && item.source === 'ai') {
      merged.set(key, mergeKeepingRuleAnchor(existing, item))
      return
    }

    const existingScore = [
      Number(existing.source_page_num || 0) > 0 ? 2 : 0,
      Number(existing.confidence || 0),
      existing.source === 'manual' ? 1 : 0,
    ].reduce((sum, value) => sum + value, 0)
    const incomingScore = [
      Number(item.source_page_num || 0) > 0 ? 2 : 0,
      Number(item.confidence || 0),
      item.source === 'manual' ? 1 : 0,
    ].reduce((sum, value) => sum + value, 0)

    if (incomingScore < existingScore) return
    merged.set(key, {
      ...existing,
      ...item,
      title: item.title || existing.title,
      href: item.href || existing.href,
      level: item.level || existing.level,
      order: existing.order,
      parent_id: item.parent_id ?? existing.parent_id ?? null,
      anchor_text: item.anchor_text || existing.anchor_text || item.title || existing.title,
      anchor_context: item.anchor_context ?? existing.anchor_context ?? null,
      anchor_key: hasPreciseAnchor(item) ? item.anchor_key : existing.anchor_key || item.anchor_key || null,
      source_page_num: item.source_page_num ?? existing.source_page_num ?? null,
      source: item.source || existing.source,
      confidence: Math.max(Number(existing.confidence || 0), Number(item.confidence || 0)),
      status: item.status || existing.status || 'active',
    })
  }

  ruleItems.forEach(addItem)
  aiItems.forEach(addItem)

  return enforceOrder(Array.from(merged.values()).sort((left, right) => {
    const leftPage = Number(left.source_page_num || 0)
    const rightPage = Number(right.source_page_num || 0)
    if (leftPage !== rightPage) return leftPage - rightPage
    return Number(left.order || 0) - Number(right.order || 0)
  }))
}

function getTocRuleAutogenAttemptKey(docId: string): string {
  return `${TOC_RULE_AUTOGEN_ATTEMPT_KEY_PREFIX}${docId}`
}

function hasTocRuleAutogenAttempt(docId: string): boolean {
  const row = queryOne<{ value?: string | null }>(
    'SELECT value FROM settings WHERE key = ?',
    [getTocRuleAutogenAttemptKey(docId)],
  )
  return row?.value === TOC_RULE_AUTOGEN_ATTEMPT_VERSION
}

function markTocRuleAutogenAttempt(docId: string): void {
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
    getTocRuleAutogenAttemptKey(docId),
    TOC_RULE_AUTOGEN_ATTEMPT_VERSION,
  ])
  scheduleDatabaseSave()
}

export function clearDocumentTocAutogenAttempt(docId: string): void {
  run('DELETE FROM settings WHERE key = ?', [getTocRuleAutogenAttemptKey(docId)])
  scheduleDatabaseSave()
}

export function getDocumentToc(docId: string): TocItemV2[] {
  const rows = queryAll<TocRow>(
    'SELECT * FROM document_toc_items WHERE doc_id = ? ORDER BY order_index ASC',
    [docId],
  )
  return rows.map(fromRow)
}

export function saveDocumentToc(docId: string, items: TocItemV2[], source: TocItemSource): TocItemV2[] {
  const pages = getPages(docId)
  const boundItems = bindItemsToPages(normalizeItems(docId, items, source), pages)
  const normalized = boundItems.every((item) => item.source === 'rule')
    ? enforceOrder(repairTocPageOrder(boundItems, pages))
    : boundItems
  const storageItems = ensureUniqueStorageIds(docId, normalized)
  const timestamp = nowIso()
  transaction(() => {
    run('DELETE FROM document_toc_items WHERE doc_id = ?', [docId])
    storageItems.forEach((item, index) => {
      const itemSource = normalizeSource(item.source || source)
      run(
        `INSERT INTO document_toc_items (
          id, doc_id, title, href, level, order_index, parent_id, anchor_text, anchor_context,
          anchor_key, source_page_num, source, confidence, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id || uid(`toc_${itemSource}`),
          docId,
          item.title,
          item.href || '',
          item.level,
          index,
          item.parent_id ?? null,
          item.anchor_text ?? null,
          item.anchor_context ?? null,
          item.anchor_key ?? null,
          item.source_page_num ?? null,
          itemSource,
          item.confidence,
          item.status,
          timestamp,
          timestamp,
        ],
      )
    })
  })
  scheduleDatabaseSave()
  return storageItems.map((item, index) => ({ ...item, order: index }))
}

export function rebuildRuleToc(docId: string): TocItemV2[] {
  const existingRows = queryAll<TocRow>(
    'SELECT * FROM document_toc_items WHERE doc_id = ? ORDER BY order_index ASC',
    [docId],
  )
  const existing = existingRows.map(fromRow)
  if (existing.some((item) => item.source === 'manual' || item.source === 'imported')) return existing
  const items = buildRuleToc(docId)
  if (!isUsefulRuleToc(items) && existing.length > 0) return existing
  const saved = saveDocumentToc(docId, items, 'rule')
  return repairStoredTocItems(docId, saved, getPages(docId))
}

export async function runAiToc(docId: string): Promise<TocItemV2[]> {
  const pages = getPages(docId)
  if (shouldSuppressTocForRegisterArchive(docId, pages)) {
    return saveDocumentToc(docId, [], 'ai')
  }
  const ruleItems = buildRuleToc(docId)
  const tocPages = pages.filter((page) => isLikelyTocPage(page)).slice(0, 10)
  const candidatePages = getAiTocCandidatePages(pages, tocPages)
  const structureHints = getAiTocStructureHints(pages)
  const ruleActive = ruleItems
    .filter((item) => normalizeForMatch(item.title))
    .slice(0, 160)
  const payload = JSON.stringify({
    mode: tocPages.length > 0 ? 'toc_pages_found' : 'no_toc_pages_use_structure_hints',
    limits: {
      source: 'compact_candidates_only',
      pageCount: pages.length,
      candidatePageCount: candidatePages.length,
      structureHintCount: structureHints.length,
      note: 'Do not reconstruct a whole-book TOC from missing full text. Use only candidate pages, ruleToc, and structureHints.',
    },
    ruleToc: ruleActive.map((item) => ({
      title: item.title,
      level: item.level,
      pageNum: item.source_page_num,
      anchorText: item.anchor_text || item.title,
      anchorKey: item.anchor_key,
      confidence: item.confidence,
      status: item.status,
    })),
    candidatePages: candidatePages.map((page) => ({
      pageNum: page.page_num,
      text: getCompactPageText(page, tocPages.some((tocPage) => Number(tocPage.page_num) === Number(page.page_num)) ? 1600 : 850),
      likelyHeadings: getLikelyHeadingLines(page, 18),
      headingHints: getPageHeadingHints(page).map((hint) => ({
        title: hint.title,
        label: hint.label,
        charIndex: hint.charIndex,
        order: hint.order,
      })),
    })),
    structureHints,
  }, null, 2)
  const parseAttempt = (raw: string, attempt: number) => {
    const cleaned = String(raw || '').trim()
    const parsed = parseAiJson(cleaned)
    const rawItems = extractAiTocItems(parsed)
    const aiItems: TocItemV2[] = rawItems.map((item, index) => {
      const pageNum = Number(item.pageNum ?? item.page_num ?? item.source_page_num) || null
      const charIndex = Number(item.charIndex ?? item.char_index ?? item.charStart ?? item.char_start)
      const hasCharIndex = Number.isFinite(charIndex) && charIndex >= 0
      const anchorKey = typeof item.anchorKey === 'string'
        ? item.anchorKey
        : typeof item.anchor_key === 'string'
          ? item.anchor_key
          : pageNum && hasCharIndex
            ? `page:${pageNum}:char:${Math.floor(charIndex)}`
            : pageNum
              ? `page:${pageNum}`
              : ''
      const title = textValue(item.title || item.heading || item.name)
      return {
        id: uid('toc_ai'),
        title,
        href: pageNum ? `page:${pageNum}${hasCharIndex ? `:char:${Math.floor(charIndex)}` : ''}` : '',
        level: Number(item?.level) || 2,
        order: index,
        anchor_text: String(item?.anchorText ?? item?.anchor_text ?? title).trim(),
        anchor_context: typeof item?.notes === 'string'
          ? item.notes
          : typeof item?.anchorContext === 'string'
            ? item.anchorContext
            : typeof item?.anchor_context === 'string'
              ? item.anchor_context
              : null,
        anchor_key: anchorKey || null,
        source_page_num: pageNum,
        source: 'ai',
        confidence: Number(item?.confidence) || 0.72,
        status: pageNum ? 'active' : 'unresolved',
      }
    })
    const anchoredAiItems = improveAiAnchors(aiItems, ruleItems, pages)
    const merged = mergeRuleAndAiToc(ruleItems, anchoredAiItems)
    const activeMerged = merged.filter((item) => item.status === 'active' && Number(item.source_page_num || 0) > 0)
    console.log(
      `[TOC] AI toc doc=${docId} attempt=${attempt} promptLen=${payload.length} rawLen=${cleaned.length} rawItems=${rawItems.length} aiItems=${anchoredAiItems.length} ruleItems=${ruleItems.length} merged=${merged.length} active=${activeMerged.length}`,
    )
    return { cleaned, rawItems, aiItems: anchoredAiItems, merged }
  }

  let lastAttempt = parseAttempt(await runAiTask('toc_extract', payload, { retry: 0 }), 1)
  if (lastAttempt.aiItems.length === 0) {
    const retryPayload = `${payload}\n\n上一次回答没有输出可解析的目录 JSON。请重新输出严格 JSON，格式只能是：{"items":[{"title":"标题","pageNum":1,"level":1,"anchorText":"标题","charIndex":0,"confidence":0.8,"notes":""}]}。不要解释，不要 Markdown。`
    lastAttempt = parseAttempt(await runAiTask('toc_extract', retryPayload, { retry: 1 }), 2)
  }

  if (lastAttempt.aiItems.length === 0) {
    console.warn(`[TOC] AI toc retry failed for doc=${docId}; sample=${lastAttempt.cleaned.slice(0, 500)}`)
    throw new Error('AI 没有输出可解析的目录 JSON，已自动重试一次。请稍后再试，或检查 AI 模型是否按 JSON 格式返回。')
  }

  if (lastAttempt.merged.length === 0 || lastAttempt.merged.every((item) => item.status !== 'active')) {
    throw new Error('AI 返回了目录，但没有可绑定到页面的有效标题。请重新运行 AI 目录，或先用生成目录建立基础结构。')
  }
  const aiSavedItems = lastAttempt.merged.map((item) => ({
    ...item,
    source: 'ai' as const,
  }))
  return saveDocumentToc(docId, aiSavedItems, 'ai')
}

export type TocFormattedEntry = {
  title: string
  pageLabel: string
  level: number
  rawText: string
}

const PAGE_LABEL_PATTERN = String.raw`(?:[0-9０-９]+|[ivxlcdmIVXLCDM]+|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+|[一二三四五六七八九十百千万零〇壹貳參肆伍陸柒捌玖拾佰仟萬]+)`
const LEADER_PATTERN = String.raw`[.\uFF0E\u00B7\u2022\u22EF\u2026\u3002\u30FB\uFE52]{2,}`
const TITLE_START_PATTERN = String.raw`(?:摘要|目(?:录|錄|次)|前言|序言|绪论|緒論|结论|結論|参考|參考|附录|附錄|第[\u4e00-\u9fff0-9０-９]+[章节章編编卷部篇]|[壹貳參肆伍陸柒捌玖拾一二三四五六七八九十]+[、.\uFF0E]|[0-9０-９]+(?:[、.)\uFF0E]|\.[0-9０-９])|[（(][一二三四五六七八九十0-9０-９]+[)）]|Chapter\s+[0-9]+|CHAPTER\s+[0-9]+)`

function normalizeForToc(value: string): string {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[⋯…]+/g, '......')
    .trim()
}

function normalizeTocTitle(value: string): string {
  return String(value || '')
    .replace(new RegExp(`${LEADER_PATTERN}.*$`), '')
    .replace(/[.．·•⋯…。・﹒]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeTocPageLabel(value: string): string {
  return String(value || '').replace(/\s+/g, '').trim()
}

export function isTocLabel(label: string): boolean {
  const normalized = String(label || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return /^(?:toc|table of contents|contents?|catalog|catalogue|directory)$/.test(normalized)
    || /目(?:录|錄|次)|目录|目錄/.test(normalized)
}

function inferTocLevel(title: string, leadingSpaces = 0): number {
  const compact = title.replace(/\s+/g, '')
  const indentLevel = leadingSpaces >= 6 ? 3 : leadingSpaces >= 2 ? 2 : 1
  if (/^(?:摘要|目(?:录|錄|次)|前言|序言|绪论|緒論|结论|結論)$/.test(compact)) return Math.max(1, indentLevel)
  if (/^(?:第[\u4e00-\u9fff0-9０-９]+[章节章編编卷部篇]|Chapter\s+[0-9]+|CHAPTER\s+[0-9]+)/.test(compact)) return 1
  if (/^[壹貳參肆伍陸柒捌玖拾一二三四五六七八九十]+[、.\uFF0E]/.test(compact)) return Math.max(2, indentLevel)
  if (/^[（(][一二三四五六七八九十0-9０-９]+[)）]/.test(compact)) return Math.max(3, indentLevel)
  const decimal = compact.match(/^[0-9０-９]+(?:\.[0-9０-９]+)+/)
  if (decimal) return Math.min(4, decimal[0].split('.').length)
  if (/^[0-9０-９]+[、.)\uFF0E]/.test(compact)) return Math.max(3, indentLevel)
  return indentLevel
}

function pushTocEntry(entries: TocFormattedEntry[], rawTitle: string, rawPage: string, rawText: string) {
  const leadingSpaces = rawTitle.match(/^\s*/)?.[0].length || 0
  const title = normalizeTocTitle(rawTitle)
  const pageLabel = normalizeTocPageLabel(rawPage)
  if (!title || !pageLabel || title.length > 180) return
  if (/^[.\uFF0E\u00B7\u2022\u22EF\u2026\u3002\u30FB\uFE52\s]+$/.test(title)) return
  entries.push({
    title,
    pageLabel,
    level: inferTocLevel(title, leadingSpaces),
    rawText: rawText.trim(),
  })
}

function parseTocLine(line: string): TocFormattedEntry[] {
  const entries: TocFormattedEntry[] = []
  const source = normalizeForToc(line)
  if (!source) return entries

  const leaderRegex = new RegExp(
    String.raw`(.+?)(${LEADER_PATTERN})\s*(${PAGE_LABEL_PATTERN})\s*(?=$|\s*${TITLE_START_PATTERN})`,
    'giu',
  )
  let match: RegExpExecArray | null
  while ((match = leaderRegex.exec(source))) {
    pushTocEntry(entries, match[1], match[3], match[0])
  }
  if (entries.length > 0) return entries

  const trailingPageRegex = new RegExp(String.raw`^(.{2,140}?)\s+(${PAGE_LABEL_PATTERN})$`, 'iu')
  const trailingMatch = source.match(trailingPageRegex)
  if (trailingMatch && /[\u4e00-\u9fffA-Za-z]/.test(trailingMatch[1])) {
    pushTocEntry(entries, trailingMatch[1], trailingMatch[2], source)
  }
  return entries
}

export function parseTocEntries(text: string): TocFormattedEntry[] {
  const source = normalizeForToc(text)
  if (!source) return []

  const lines = source
    .split(/\n+/)
    .map((line) => line.trimEnd())
    .filter(Boolean)

  const entries = lines.flatMap(parseTocLine)
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = `${entry.title}|${entry.pageLabel}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function looksLikeTocText(text: string, label = ''): boolean {
  const source = normalizeForToc(text)
  if (!source) return false
  if (isTocLabel(label)) return true

  const entries = parseTocEntries(source)
  if (entries.length >= 4) return true
  if (entries.length >= 2 && /目(?:录|錄|次)|目录|目錄|contents?/i.test(source)) return true

  const leaderCount = (source.match(new RegExp(LEADER_PATTERN, 'g')) || []).length
  return leaderCount >= 4 && entries.length >= 2
}

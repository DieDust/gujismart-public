export type CitationFieldIssueSeverity = 'info' | 'warning' | 'error'

export interface CitationFieldIssue {
  code: string
  severity: CitationFieldIssueSeverity
  field: string
  message: string
  recoverable: boolean
  action_hint?: string
}

export interface CitationFieldResolutionReport {
  placeholders: string[]
  resolved_fields: string[]
  missing_fields: string[]
  core_missing_fields: string[]
  issue_count: number
  warning_count: number
  error_count: number
  usable: boolean
  issues: CitationFieldIssue[]
}

export const CITATION_CORE_FIELD_PRIORITY: Record<string, string[]> = {
  title: ['documents.title', 'metadata.title'],
  author: ['documents.author', 'metadata.author'],
  dynasty: ['documents.dynasty', 'metadata.dynasty'],
  source: ['documents.source', 'metadata.source', 'metadata.journal', 'metadata.container_title'],
  page_reference: ['options.pageNum', 'options.fieldOverrides.page_reference', 'metadata.page_reference', 'metadata.pages'],
  pages: ['options.pageNum', 'options.fieldOverrides.pages', 'metadata.pages', 'metadata.page_range', 'metadata.cite_pages'],
  doc_type: ['documents.doc_type', 'metadata._doc_type'],
}

const CORE_CITATION_FIELDS = new Set(['title', 'author', 'source'])

function toTrimmedString(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeIssueCode(value: string): string {
  return toTrimmedString(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'citation_field_issue'
}

export function parseCitationTemplatePlaceholders(templateText: unknown): string[] {
  const text = toTrimmedString(templateText)
  const matches = [...text.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)]
    .map((match) => toTrimmedString(match[1]))
    .filter(Boolean)
  return [...new Set(matches)].sort()
}

function buildMissingFieldIssue(field: string): CitationFieldIssue {
  const isCore = CORE_CITATION_FIELDS.has(field)
  return {
    code: normalizeIssueCode(isCore ? `missing_core_${field}` : `missing_${field}`),
    severity: isCore ? 'warning' : 'info',
    field,
    message: `Citation field "${field}" is empty.`,
    recoverable: true,
    action_hint: CITATION_CORE_FIELD_PRIORITY[field] ? 'review_citation_metadata_priority' : 'review_citation_template_or_metadata',
  }
}

export function buildCitationFieldResolutionReport(
  fields: Record<string, unknown>,
  templateText: unknown,
): CitationFieldResolutionReport {
  const placeholders = parseCitationTemplatePlaceholders(templateText)
  const resolvedFields: string[] = []
  const missingFields: string[] = []
  const issues: CitationFieldIssue[] = []

  for (const field of placeholders) {
    const value = toTrimmedString(fields[field])
    if (value) {
      resolvedFields.push(field)
    } else {
      missingFields.push(field)
      issues.push(buildMissingFieldIssue(field))
    }
  }

  const warningCount = issues.filter((issue) => issue.severity === 'warning').length
  const errorCount = issues.filter((issue) => issue.severity === 'error').length
  return {
    placeholders,
    resolved_fields: resolvedFields.sort(),
    missing_fields: missingFields.sort(),
    core_missing_fields: missingFields.filter((field) => CORE_CITATION_FIELDS.has(field)).sort(),
    issue_count: issues.length,
    warning_count: warningCount,
    error_count: errorCount,
    usable: placeholders.length > 0 && resolvedFields.length > 0 && errorCount === 0,
    issues,
  }
}

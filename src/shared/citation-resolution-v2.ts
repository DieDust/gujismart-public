export type CitationResolvedFieldStatus = 'resolved' | 'missing' | 'invalid'

export interface CitationResolvedField {
  name: string
  value?: string
  source?: string
  status: CitationResolvedFieldStatus
}

export interface CitationResolutionDiagnostic {
  code: string
  severity: 'info' | 'warning' | 'error'
  field?: string
  message: string
}

export interface CitationResolutionV2 {
  schemaVersion: 'citation-resolution/v2'
  documentId: string
  citationType: string
  formatId: string
  styleVersion: string
  templateVersion: string
  fields: CitationResolvedField[]
  diagnostics: CitationResolutionDiagnostic[]
  verificationStatus: 'verified' | 'draft' | 'blocked' | 'legacy-unverified'
  rendered?: string
}

type RequiredSpec = { required: string[][]; recommended: string[][] }

const MODERN_FORMATS = new Set(['GB-T7714', 'APA', 'MLA', 'Chicago', 'IEEE'])

function registry(citationTypeValue: string, formatId: string): RequiredSpec {
  const citationType = String(citationTypeValue || '').toLowerCase()
  if (citationType === 'journal' || citationType === 'english_journal') {
    return { required: [['title'], ['author'], ['journal'], ['year', 'publication_year']], recommended: [['volume'], ['pages'], ['doi']] }
  }
  if (citationType === 'thesis') {
    return { required: [['title'], ['author'], ['university'], ['year', 'publication_year']], recommended: [['degree_type'], ['location']] }
  }
  if (citationType === 'online') {
    return { required: [['title'], ['url']], recommended: [['author', 'responsibility'], ['access_date'], ['year', 'publication_year']] }
  }
  if (citationType === 'archive' || citationType === 'english_archive') {
    return { required: [['title'], ['archive_id', 'collection']], recommended: [['author', 'responsibility'], ['date']] }
  }
  if (citationType === 'newspaper') {
    return { required: [['title'], ['author'], ['newspaper', 'source'], ['issue_date', 'date']], recommended: [['pages']] }
  }
  if (/guji|classic|local_gazetteer/.test(citationType)) {
    return { required: [['title'], ['author', 'responsibility']], recommended: [['dynasty'], ['version', 'publisher'], ['page_reference', 'pages']] }
  }
  if (MODERN_FORMATS.has(formatId)) {
    return { required: [['title'], ['author', 'responsibility'], ['year', 'publication_year']], recommended: [['source', 'publisher'], ['pages']] }
  }
  return { required: [['title'], ['author', 'responsibility']], recommended: [['year', 'publication_year'], ['source', 'publisher']] }
}

function normalizedField(input: { name: string; value?: string; source?: string }): CitationResolvedField {
  const name = String(input.name || '').trim()
  const value = String(input.value || '').trim()
  const source = String(input.source || '').trim()
  let status: CitationResolvedFieldStatus = value ? 'resolved' : 'missing'
  if (value && (name === 'year' || name === 'publication_year') && !/^(?:\d{4}|[^\d]{1,30})$/.test(value)) status = 'invalid'
  if (value && name === 'doi' && !/^10\.\d{4,9}\/.+/i.test(value)) status = 'invalid'
  return { name, ...(value ? { value } : {}), ...(source ? { source } : {}), status }
}

export function buildCitationResolutionV2(input: {
  documentId: string
  citationType: string
  formatId: string
  styleVersion: string
  templateVersion: string
  fields: Array<{ name: string; value?: string; source?: string }>
  rendered?: string
}): CitationResolutionV2 {
  const documentId = String(input.documentId || '').trim()
  if (!documentId) throw new Error('citation_resolution_document_required')
  const fields = input.fields.map(normalizedField).filter((field) => field.name)
  const byName = new Map(fields.map((field) => [field.name, field]))
  const spec = registry(input.citationType, input.formatId)
  const diagnostics: CitationResolutionDiagnostic[] = []
  for (const group of spec.required) {
    const resolved = group.some((name) => byName.get(name)?.status === 'resolved')
    if (!resolved) diagnostics.push({ code: 'citation.required_group_missing', severity: 'error', field: group[0], message: `Required citation field group is missing: ${group.join(' | ')}` })
  }
  for (const group of spec.recommended) {
    const resolved = group.some((name) => byName.get(name)?.status === 'resolved')
    if (!resolved) diagnostics.push({ code: 'citation.recommended_group_missing', severity: 'warning', field: group[0], message: `Recommended citation field group is missing: ${group.join(' | ')}` })
  }
  for (const field of fields.filter((item) => item.status === 'invalid')) {
    diagnostics.push({ code: 'citation.field_invalid', severity: 'error', field: field.name, message: `Citation field is invalid: ${field.name}` })
  }
  const verificationStatus = diagnostics.some((item) => item.severity === 'error')
    ? 'blocked'
    : diagnostics.some((item) => item.severity === 'warning') ? 'draft' : 'verified'
  return {
    schemaVersion: 'citation-resolution/v2',
    documentId,
    citationType: String(input.citationType || 'monograph'),
    formatId: String(input.formatId || 'Custom'),
    styleVersion: String(input.styleVersion || ''),
    templateVersion: String(input.templateVersion || ''),
    fields,
    diagnostics,
    verificationStatus,
    ...(input.rendered === undefined ? {} : { rendered: String(input.rendered) }),
  }
}

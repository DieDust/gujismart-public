export type ResearchProjectIntegritySeverity = 'info' | 'warning' | 'error'

export interface ResearchProjectIntegrityIssue {
  code: string
  severity: ResearchProjectIntegritySeverity
  message: string
  count?: number
  entityIds?: string[]
}

export interface ResearchProjectIntegrityNoteInput {
  id: string
  locatorJson?: string | null
  sourceHash?: string | null
  sourceAvailable?: boolean | number | null
}

export interface ResearchProjectIntegrityInput {
  projectId: string
  checkedAt?: string
  documentCount: number
  missingDocumentCount?: number
  outputCount: number
  aiDatasetCount?: number
  aiRecordCount?: number
  unconfirmedAiRecordCount?: number
  evidenceCount?: number
  staleEvidenceCount?: number
  formalOutputVersionCount?: number
  draftOutputVersionCount?: number
  notes: ResearchProjectIntegrityNoteInput[]
}

export interface ResearchProjectIntegrityReport {
  projectId: string
  checkedAt: string
  metrics: {
    documentCount: number
    missingDocumentCount: number
    noteCount: number
    missingLocatorNoteCount: number
    missingSourceHashNoteCount: number
    unavailableSourceNoteCount: number
    outputCount: number
    aiDatasetCount: number
    aiRecordCount: number
    unconfirmedAiRecordCount: number
    evidenceCount: number
    staleEvidenceCount: number
    formalOutputVersionCount: number
    draftOutputVersionCount: number
  }
  issues: ResearchProjectIntegrityIssue[]
  issueCount: number
  warningCount: number
  errorCount: number
}

function uniqueIds(items: ResearchProjectIntegrityNoteInput[]): string[] {
  return [...new Set(items.map((item) => String(item.id || '').trim()).filter(Boolean))]
}

function isMissingText(value: unknown): boolean {
  return String(value || '').trim() === ''
}

function isUnavailable(value: ResearchProjectIntegrityNoteInput['sourceAvailable']): boolean {
  if (value === null || value === undefined) return false
  return Number(value) === 0 || value === false
}

function addIssue(
  issues: ResearchProjectIntegrityIssue[],
  issue: ResearchProjectIntegrityIssue | null,
): void {
  if (issue) issues.push(issue)
}

export function buildResearchProjectIntegrityReport(input: ResearchProjectIntegrityInput): ResearchProjectIntegrityReport {
  const notes = input.notes || []
  const missingLocatorNotes = notes.filter((note) => isMissingText(note.locatorJson))
  const missingSourceHashNotes = notes.filter((note) => isMissingText(note.sourceHash))
  const unavailableSourceNotes = notes.filter((note) => isUnavailable(note.sourceAvailable))
  const metrics = {
    documentCount: Math.max(0, Number(input.documentCount || 0)),
    missingDocumentCount: Math.max(0, Number(input.missingDocumentCount || 0)),
    noteCount: notes.length,
    missingLocatorNoteCount: missingLocatorNotes.length,
    missingSourceHashNoteCount: missingSourceHashNotes.length,
    unavailableSourceNoteCount: unavailableSourceNotes.length,
    outputCount: Math.max(0, Number(input.outputCount || 0)),
    aiDatasetCount: Math.max(0, Number(input.aiDatasetCount || 0)),
    aiRecordCount: Math.max(0, Number(input.aiRecordCount || 0)),
    unconfirmedAiRecordCount: Math.max(0, Number(input.unconfirmedAiRecordCount || 0)),
    evidenceCount: Math.max(0, Number(input.evidenceCount || 0)),
    staleEvidenceCount: Math.max(0, Number(input.staleEvidenceCount || 0)),
    formalOutputVersionCount: Math.max(0, Number(input.formalOutputVersionCount || 0)),
    draftOutputVersionCount: Math.max(0, Number(input.draftOutputVersionCount || 0)),
  }
  const issues: ResearchProjectIntegrityIssue[] = []

  addIssue(issues, metrics.documentCount === 0 ? {
    code: 'project.no_documents',
    severity: 'warning',
    message: 'Research project has no linked documents.',
  } : null)
  addIssue(issues, metrics.missingDocumentCount > 0 ? {
    code: 'project.missing_documents',
    severity: 'error',
    message: 'Research project has document links that no longer resolve.',
    count: metrics.missingDocumentCount,
  } : null)
  addIssue(issues, metrics.noteCount === 0 ? {
    code: 'project.no_notes',
    severity: 'info',
    message: 'Research project has no saved notes yet.',
  } : null)
  addIssue(issues, metrics.missingLocatorNoteCount > 0 ? {
    code: 'notes.missing_locator',
    severity: 'warning',
    message: 'Some research notes do not have locator data.',
    count: metrics.missingLocatorNoteCount,
    entityIds: uniqueIds(missingLocatorNotes),
  } : null)
  addIssue(issues, metrics.missingSourceHashNoteCount > 0 ? {
    code: 'notes.missing_source_hash',
    severity: 'warning',
    message: 'Some research notes do not have source hashes.',
    count: metrics.missingSourceHashNoteCount,
    entityIds: uniqueIds(missingSourceHashNotes),
  } : null)
  addIssue(issues, metrics.unavailableSourceNoteCount > 0 ? {
    code: 'notes.unavailable_source',
    severity: 'error',
    message: 'Some research notes cannot currently resolve to their source pages.',
    count: metrics.unavailableSourceNoteCount,
    entityIds: uniqueIds(unavailableSourceNotes),
  } : null)
  addIssue(issues, metrics.outputCount === 0 ? {
    code: 'outputs.empty',
    severity: 'info',
    message: 'Research project has no saved outputs yet.',
  } : null)
  addIssue(issues, metrics.unconfirmedAiRecordCount > 0 ? {
    code: 'ai_records.unconfirmed',
    severity: 'warning',
    message: 'Some AI research records are still pending confirmation.',
    count: metrics.unconfirmedAiRecordCount,
  } : null)
  addIssue(issues, metrics.staleEvidenceCount > 0 ? {
    code: 'evidence.stale',
    severity: 'error',
    message: 'Some research evidence no longer resolves to its verified source content.',
    count: metrics.staleEvidenceCount,
  } : null)
  addIssue(issues, metrics.draftOutputVersionCount > 0 ? {
    code: 'outputs.draft_versions',
    severity: 'info',
    message: 'Some research output versions are drafts and may have incomplete evidence coverage.',
    count: metrics.draftOutputVersionCount,
  } : null)

  return {
    projectId: input.projectId,
    checkedAt: input.checkedAt || new Date().toISOString(),
    metrics,
    issues,
    issueCount: issues.length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    errorCount: issues.filter((issue) => issue.severity === 'error').length,
  }
}

export const RESEARCH_OUTPUT_INPUT_SNAPSHOT_SCHEMA_VERSION = 'gujismart-research-output-input/v1'

export interface ResearchOutputSnapshotDocument {
  id: string
  title?: string
  author?: string | null
  pageCount?: number | null
}

export interface ResearchOutputSnapshotNote {
  id: string
  docId: string
  pageNum?: number | null
  sourceType?: string
  sourceHash?: string
  locatorJson?: string
  citationText?: string
  excerptHash?: string
  excerptPreview?: string
}

export interface ResearchOutputSnapshotAiRecord {
  id: string
  datasetId: string
  taskId?: string
  docId: string
  pageNum?: number | null
  sourceHash?: string
  locatorJson?: string
  confidence?: number
  status?: string
  excerptHash?: string
  excerptPreview?: string
}

export interface ResearchOutputInputSnapshot {
  schemaVersion: typeof RESEARCH_OUTPUT_INPUT_SNAPSHOT_SCHEMA_VERSION
  createdAt: string
  source: 'research:synthesizeProject' | 'research:createOutput' | 'ai-research:generateReport' | (string & {})
  projectId: string
  outputType: string
  citationStyleId?: string | null
  sourceDatasetId?: string | null
  customPromptHash?: string
  customPromptPresent?: boolean
  documents?: ResearchOutputSnapshotDocument[]
  notes?: ResearchOutputSnapshotNote[]
  aiRecords?: ResearchOutputSnapshotAiRecord[]
  metadata?: Record<string, unknown>
}

export function createResearchOutputInputSnapshot(
  snapshot: Omit<ResearchOutputInputSnapshot, 'schemaVersion' | 'createdAt'> & { createdAt?: string },
): ResearchOutputInputSnapshot {
  return {
    ...snapshot,
    schemaVersion: RESEARCH_OUTPUT_INPUT_SNAPSHOT_SCHEMA_VERSION,
    createdAt: snapshot.createdAt || new Date().toISOString(),
  }
}

export function stringifyResearchOutputInputSnapshot(snapshot: ResearchOutputInputSnapshot): string {
  return JSON.stringify(snapshot)
}

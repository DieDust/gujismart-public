import type { AiResponseEnvelope } from './ai-response-envelope'
import type { BackupIntegrityReport } from './backup-integrity'
import type { ConfigValidationReport } from './config-validation'
import type { DocumentPipelineDiagnostics } from './document-pipeline-diagnostics'
import type { OcrRunMetadata } from './ocr-run-metadata'
import type { SearchIndexHealthDiagnostics } from './search-index-health'

export type OcrStatus = 'pending' | 'queued' | 'processing' | 'completed' | 'error'
export type ProofStatus = 'pending' | 'completed'
export type ImportStatus = 'unstored' | 'stored' | 'processing' | 'processed' | 'error'
export type ReadStatus = 'unread' | 'reading' | 'read'
export type MetadataStatus = 'pending' | 'review' | 'confirmed' | 'auto'
export type DocumentMetadataResult = Record<string, unknown>
export type AppPathName = 'userData' | 'home' | 'desktop'

export interface StatusEnvelope {
  status: string
  phase?: string
  progress?: number
  error_code?: string
  message?: string
  recoverable: boolean
  action_hint?: string
  updated_at?: string
}

export interface AppUpdateAsset {
  name: string
  url: string
  size?: number
  contentType?: string
}

export interface AppUpdateInfo {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  releaseUrl: string
  releaseName?: string
  publishedAt?: string
  body?: string
  assets: AppUpdateAsset[]
  checkedAt: string
  error?: string
}

export interface DatabaseTableStorageStat {
  tableName: string
  rowCount: number
  estimatedBytes?: number
}

export type DatabaseStorageLayerKind = 'metadata' | 'document-text' | 'external-payload' | 'search-index' | 'cache' | 'runtime'

export interface DatabaseStorageLayerStat {
  kind: DatabaseStorageLayerKind
  label: string
  rowCount: number
  estimatedBytes: number
}

export interface DatabaseExternalPayloadStorageStat {
  fileCount: number
  referencedFileCount: number
  missingReferencedFileCount: number
  orphanedFileCount: number
  bytes: number
  estimatedOrphanedBytes: number
  estimatedMissingReferencedBytes: number
}

export interface DatabaseSearchIndexStorageStat {
  ngramRows: number
  singleCharNgramRows: number
  ngramPositionsBytes: number
  segmentRows: number
  segmentTextBytes: number
  segmentOffsetMapBytes: number
  pagesFtsRows: number
  searchSegmentsFtsRows: number
  searchSegmentsTrigramRows: number
  enterpriseSearchMigrationRecommended: boolean
}

export type DatabaseRequiredMaintenanceReason =
  | 'legacy-ngram-index'
  | 'legacy-single-char-ngram'
  | 'legacy-ngram-positions'
  | 'legacy-cache-version'
  | 'inline-page-payloads'
  | 'enterprise-search-index'

export interface DatabaseRequiredMaintenance {
  required: boolean
  reasons: DatabaseRequiredMaintenanceReason[]
  title: string
  message: string
  actionLabel: string
}

export type DatabaseMaintenanceStage =
  | 'idle'
  | 'diagnose'
  | 'cleanup-legacy-index'
  | 'externalize-page-payloads'
  | 'queue-lightweight-index'
  | 'compact'
  | 'verify'
  | 'completed'
  | 'failed'

export interface DatabaseMaintenanceState {
  stage: DatabaseMaintenanceStage
  canResume: boolean
  lastStartedAt: string | null
  lastCompletedAt: string | null
  lastError: string | null
  oldIndexRowsRemaining: number
  legacyIndexPresent: boolean
  lightweightIndexQueued: boolean
  compactionRecommended: boolean
  migrationVersion: string
}

export interface DatabaseStorageDiagnostics {
  databasePath: string
  databaseBytes: number
  walBytes: number
  shmBytes: number
  pageSize: number
  pageCount: number
  freelistCount: number
  freelistBytes: number
  checkedAt: string
  searchIndexVersion: string
  storageModelVersion: string
  tables: DatabaseTableStorageStat[]
  storageLayers: DatabaseStorageLayerStat[]
  externalPayloads: DatabaseExternalPayloadStorageStat
  searchIndex: DatabaseSearchIndexStorageStat
  warnings: string[]
  requiredMaintenance: DatabaseRequiredMaintenance
  maintenanceState: DatabaseMaintenanceState
}

export type DatabaseLockActivityCategory =
  | 'document-delete'
  | 'ocr'
  | 'import'
  | 'search-index'
  | 'checkpoint'
  | 'maintenance'
  | 'foreground-write'
  | 'other'

export type DatabaseLockActivityState = 'queued' | 'waiting' | 'holding' | 'running'

export interface DatabaseLockActivity {
  id: string
  category: DatabaseLockActivityCategory
  label: string
  state: DatabaseLockActivityState
  startedAt: string
  elapsedMs: number
  detail?: string
}

export interface DatabaseBusyIncident {
  id: string
  operationLabel: string
  occurredAt: string
  waitedMs: number
  outcome: 'recovered' | 'failed'
  error: string
}

export type DatabaseLockDiagnosticsStatus =
  | 'available'
  | 'busy-confirmed-internal'
  | 'busy-internal-candidate'
  | 'busy-unattributed'
  | 'probe-error'

export interface DatabaseLockDiagnostics {
  status: DatabaseLockDiagnosticsStatus
  checkedAt: string
  processId: number
  writerAvailable: boolean
  probeElapsedMs: number
  ownerConfidence: 'confirmed' | 'candidate' | 'none'
  message: string
  activeActivities: DatabaseLockActivity[]
  likelyOwners: DatabaseLockActivity[]
  recentBusyIncidents: DatabaseBusyIncident[]
  probeError?: string
}

export interface DatabaseMaintenanceResult {
  success: boolean
  message: string
  beforeBytes?: number
  afterBytes?: number
  deletedRows?: number
  updatedRows?: number
  path?: string
  error?: string
}

export type LibrarySmartViewCountKey =
  | 'all'
  | 'missingMetadata'
  | 'unrecognized'
  | 'suspiciousTitle'
  | 'unknownType'
  | 'favorite'
  | 'unread'
  | 'proofed'
  | 'unproofed'
  | 'metadataPending'
  | 'unstored'
  | 'vectorized'
  | 'notVectorized'
  | 'embeddingQueued'
  | 'embeddingProcessing'
  | 'embeddingError'

export type LibrarySmartViewCounts = Record<LibrarySmartViewCountKey, number>

/** Vector-index refinement that can AND with folder/tag/all scope. */
export type LibraryEmbeddingFilter =
  | 'ready'
  | 'not_ready'
  | 'queued'
  | 'processing'
  | 'error'

export interface LibraryStateCache {
  smartViewCounts: LibrarySmartViewCounts
  unfiledDocumentTotal: number
  folderDocumentCounts: Record<string, number>
  tagDocumentCounts: Record<string, number>
  dirty: boolean
  version: string
  source: 'cache' | 'snapshot' | 'recalculated'
  lastCalibratedAt: string | null
  updatedAt: string | null
}
export type AiLayoutMode = 'reading_layout' | (string & {})
export type AiTaskType =
  | 'summary'
  | 'translate'
  | 'layout_reading_page'
  | 'keywords'
  | 'qa'
  | 'document_qa'
  | 'library_qa'
  | 'semantic_expansion'
  | 'ai_search_plan'
  | 'toc_extract'
  | 'toc_bind'
  | 'citation_template_infer'
  | (string & {})
export type AiSynthesisTemplate =
  | 'literature_review'
  | 'summary'
  | 'theme_analysis'
  | 'evidence_table'
  | 'timeline'
  | 'debate'
  | 'reading_list'
  | 'custom'
  | (string & {})
export type TagSource =
  | 'manual'
  | 'ai'
  | 'imported'
  | 'field'
  | '_doc_type'
  | 'doc_type'
  | 'author'
  | 'editor'
  | 'translator'
  | 'journal'
  | 'newspaper'
  | 'collection'
  | 'book_title'
  | 'meeting_name'
  | 'university'
  | 'publisher'
  | 'publish_place'
  | 'publication_time'
  | 'publication_year'
  | 'issue_date'
  | 'engraving_style'
  | 'dynasty'
  | 'version'
  | 'keywords'
  | (string & {})
export type OcrEngine = 'local_paddle' | 'paddle' | 'vision_model' | 'hybrid'

export type FileCapabilityErrorCode =
  | 'CAPABILITY_UNKNOWN'
  | 'CAPABILITY_EXPIRED'
  | 'CAPABILITY_OWNER_MISMATCH'
  | 'CAPABILITY_PURPOSE_MISMATCH'
  | 'CAPABILITY_KIND_MISMATCH'
  | 'CAPABILITY_ALREADY_CONSUMED'
  | 'CAPABILITY_ALREADY_LOCKED'
  | 'CAPABILITY_TARGET_MISSING'
  | 'CAPABILITY_TARGET_CHANGED'
  | 'CAPABILITY_SYMLINK_REJECTED'
  | 'CAPABILITY_BATCH_LIMIT'
  | 'CAPABILITY_INVALID_REQUEST'
  | 'CAPABILITY_LEASE_UNKNOWN'
  | 'CAPABILITY_LEASE_EXPIRED'
  | 'CAPABILITY_LEASE_MISMATCH'

export interface FileCapabilityErrorResult {
  code: FileCapabilityErrorCode
  message: string
}

export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'error' | 'canceled'
export type TaskCompletionKind = 'full' | 'partial'

export interface ErrorEnvelope {
  code: string
  message: string
  recoverable: boolean
  recoveryAction?: string
  details?: Record<string, string | number | boolean | null>
}

export interface TaskStateEnvelope {
  taskId: string
  kind: string
  status: TaskStatus
  phase?: string
  progress?: number
  committedCount?: number
  totalCount?: number
  completionKind?: TaskCompletionKind
  blockedReason?: string
  recoveryAction?: string
  error?: ErrorEnvelope
  updatedAt?: string
}

export interface TaskJobRecord {
  id: string
  kind: string
  status: TaskStatus
  phase: string | null
  priority: number
  idempotencyKey: string | null
  settingsSnapshot: Record<string, unknown>
  totalCount: number
  queuedCount: number
  runningCount: number
  completedCount: number
  errorCount: number
  canceledCount: number
  completionKind: TaskCompletionKind | null
  error: ErrorEnvelope | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface TaskItemRecord {
  id: string
  jobId: string
  ordinal: number
  status: TaskStatus
  phase: string | null
  idempotencyKey: string | null
  domainType: string | null
  domainRef: string | null
  input: Record<string, unknown>
  cursor: Record<string, unknown> | null
  attemptCount: number
  activeAttemptId: string | null
  leaseOwner: string | null
  leaseExpiresAt: number | null
  completionKind: TaskCompletionKind | null
  error: ErrorEnvelope | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface TaskClaim {
  jobId: string
  itemId: string
  attemptId: string
  attemptNo: number
  leaseToken: string
  leaseExpiresAt: number
  domainType: string | null
  domainRef: string | null
  input: Record<string, unknown>
  cursor: Record<string, unknown> | null
}

export interface TaskEventRecord {
  id: number
  jobId: string
  itemId: string | null
  attemptId: string | null
  eventType: string
  status: TaskStatus | null
  phase: string | null
  payload: Record<string, unknown>
  createdAt: number
}

export interface TaskArtifactRecord {
  id: string
  sequence: number
  jobId: string
  itemId: string | null
  attemptId: string | null
  kind: string
  ref: string
  version: number
  sha256: string | null
  idempotencyKey: string | null
  metadata: Record<string, unknown>
  createdAt: number
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

export type CanonicalContentSource = 'human-proof' | 'ocr-artifact' | 'legacy-projection' | 'unavailable'
export type CanonicalVerificationStatus = 'confirmed' | 'machine' | 'unavailable'

export interface CanonicalPageContent {
  pageId: string
  docId: string
  pageNum: number
  text: string
  source: CanonicalContentSource
  verificationStatus: CanonicalVerificationStatus
  sourceHash: string
  artifactId: string | null
  activeArtifactId: string | null
  baseArtifactId: string | null
  proofStatus: ProofStatus
  ocrStatus: OcrStatus
  proofBaseStale: boolean
}

export type SettingValueType = 'string' | 'boolean' | 'integer' | 'secret'
export type SettingSensitivity = 'public' | 'protected'

export interface SettingDefinition {
  key: string
  type: SettingValueType
  sensitivity: SettingSensitivity
  rendererVisible: boolean
  defaultValue?: string
  min?: number
  max?: number
}

export type CapabilityResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: FileCapabilityErrorResult }

export interface LocalFileGrantRef {
  grantId: string
  displayName: string
  kind: 'file' | 'directory'
  expiresAt: number
}

export interface ImportSourceRef extends LocalFileGrantRef {
  sourceId: string
  isDirectory: boolean
}

export interface ImportSelection {
  selectionId: string
  sources: ImportSourceRef[]
  discoveredFileCount: number | null
  authorizationStatus: 'authorized'
}

export interface ImportSelectionBatchItem {
  grantId: string
  sourceId: string
  displayName: string
  relativeDisplayPath?: string
}

export interface ImportSelectionBatch {
  selectionId: string
  items: ImportSelectionBatchItem[]
  nextCursor: string | null
  done: boolean
}

export interface LibraryImportQueueJobSnapshotV1 {
  id: number
  libraryProjectId?: string
  filePaths: string[]
  folderId?: string | null
  folderAssignments?: Array<[string, string]>
  engine: OcrEngine
}

export interface LibraryImportQueueJobSnapshotV2 {
  id: number
  libraryProjectId?: string
  selectionId: string | null
  sourceLabels: string[]
  pendingCount: number
  folderId?: string | null
  engine: OcrEngine
  authorizationStatus: 'authorized' | 'authorization-required'
  hasUndiscoveredSources?: boolean
}

export interface LibraryImportQueueStateV1 {
  version: 1
  savedAt: string
  jobs: LibraryImportQueueJobSnapshotV1[]
}

export interface LibraryImportQueueStateV2 {
  version: 2
  savedAt: string
  jobs: LibraryImportQueueJobSnapshotV2[]
}

export type LibraryImportQueueState = LibraryImportQueueStateV1 | LibraryImportQueueStateV2
export type LibraryImportQueueJobSnapshot = LibraryImportQueueJobSnapshotV1 | LibraryImportQueueJobSnapshotV2

export type LocalPaddleOcrInstallState = 'not_installed' | 'partial' | 'installed' | 'downloading' | 'error'
export type LocalPaddleOcrDownloadSourceId = 'auto' | 'paddle_bos' | 'modelscope' | 'huggingface' | 'manual'
export type LocalPaddleOcrRuntimeState = 'missing_python' | 'missing_packages' | 'outdated' | 'ready' | 'error'
export type LocalPaddleOcrRuntimeSource = 'managed' | 'system'

export interface LocalPaddleOcrSource {
  id: Exclude<LocalPaddleOcrDownloadSourceId, 'auto'>
  label: string
  url: string
  kind: 'model' | 'catalog' | 'manual'
  available?: boolean
  statusCode?: number
  bytes?: number
  error?: string
}

export interface LocalPaddleOcrRuntimeStatus {
  state: LocalPaddleOcrRuntimeState
  supported: boolean
  source?: LocalPaddleOcrRuntimeSource
  runtimePath: string
  pythonPath?: string
  paddleVersion?: string
  paddleocrVersion?: string
  paddlexVersion?: string
  requiredPaddleVersion: string
  requiredPaddleOcrVersion: string
  requiredPaddlexVersion: string
  message: string
  error?: string
}

export interface LocalPaddleOcrStatus {
  installed: boolean
  modelInstalled: boolean
  state: LocalPaddleOcrInstallState
  bundleVersion: string
  installPath: string
  runnerPath?: string
  pythonPath?: string
  modelPath?: string
  detModelPath?: string
  recModelPath?: string
  runtime: LocalPaddleOcrRuntimeStatus
  message?: string
  sources: LocalPaddleOcrSource[]
  updatedAt?: string
}

export interface LocalPaddleOcrDownloadOptions {
  source?: LocalPaddleOcrDownloadSourceId
  manualPath?: string
}

export interface LocalPaddleOcrDownloadProgress {
  state: 'checking' | 'downloading' | 'installing' | 'completed' | 'error'
  sourceId?: LocalPaddleOcrDownloadSourceId
  fileName?: string
  bytesDone?: number
  totalBytes?: number
  progress?: number
  message?: string
  error?: string
}

export type PaddleOcrTokenRuntimeStatus = 'active' | 'ready' | 'quota_exhausted' | 'rate_limited' | 'invalid'

/** Beginner-friendly MCP / AI-tool connection info from Settings. */
export interface McpClientConfigBundle {
  cursorJson: string
  claudeJson: string
  genericJson: string
  /** Plain text that maps 1:1 to Codex "自定义 MCP" form fields. */
  codexFormText: string
  /** Codex CLI ~/.codex/config.toml fragment. */
  codexToml: string
  beginnerSteps: string[]
}

export interface McpCodexFormFields {
  name: string
  type: 'STDIO'
  command: string
  args: string[]
  cwd: string
  env: Array<{ key: string; value: string }>
}

export interface McpSetupInfo {
  enabled: boolean
  dataDir: string
  execPath: string
  command: string
  args: string[]
  cwd?: string
  /** Required env for MCP host (e.g. ELECTRON_RUN_AS_NODE=1 on Windows). */
  env?: Record<string, string>
  token: string
  tokenPreview: string
  packaged: boolean
  codexForm: McpCodexFormFields
  configs: McpClientConfigBundle
}

export interface McpWriteCodexResult {
  ok: boolean
  path: string
  message: string
}

export interface PaddleOcrTokenPoolEntry {
  id: string
  label: string
  last4: string
  enabled: boolean
  primary: boolean
  status: PaddleOcrTokenRuntimeStatus
  unavailableUntil?: string
  lastError?: string
}

export interface PaddleOcrTokenPoolState {
  entries: PaddleOcrTokenPoolEntry[]
  activeTokenId: string | null
  configuredCount: number
  enabledCount: number
}
export type OcrProfile = 'general' | 'guji_print_vertical'
export type OcrSecondPass = 'none' | 'local_segmentation' | 'cloud_column_ocr'
export type SearchExportFormat = 'txt' | 'markdown' | 'csv' | 'json'
export type CitationMode = 'auto' | 'simple' | 'template'
export type ResearchKnowledgeKind = 'quote' | 'summary' | 'comment' | 'idea'
export type AiResearchFieldType = 'text' | 'number' | 'date' | 'place' | 'person' | 'category' | 'quote' | (string & {})
export type AiResearchTaskStatus = 'draft' | 'running' | 'completed' | 'error' | (string & {})
export type AiResearchStepStatus = 'pending' | 'running' | 'completed' | 'error' | (string & {})
export type AiResearchRecordStatus = 'pending' | 'confirmed' | 'excluded' | (string & {})
export type AiResearchTaskKind = 'statistical' | 'extraction' | 'synthesis' | 'mixed' | (string & {})
export type AiResearchRunPhase = 'planning' | 'counting' | 'faceting' | 'narrowing' | 'packing' | 'extracting' | 'reporting' | (string & {})
export type TypesetAnnotationType = 'body' | 'jiaZhu' | 'cePi' | 'meiPi' | 'jiaoZhu' | 'title' | 'chapter' | 'seal'
export type TypesetTemplate = '四库全书' | '四库全书彩色' | '红楼梦甲戌本'

export interface PageOcrOptions {
  profile?: OcrProfile
  secondPass?: OcrSecondPass
  /** Rotate the page image clockwise before OCR; coordinates are mapped back to the source page. */
  imageRotation?: 0 | 90
}

export interface OcrRegionRerecognitionOptions {
  maxBlocks?: number
}

export interface OcrRegionRerecognitionResult {
  attemptedBlockCount: number
  updatedBlockCount: number
  skippedBlockCount: number
  failedBlockCount: number
  updatedBlockIds: string[]
}

export interface TypesetAnnotationItem {
  id: string
  type: TypesetAnnotationType
  content: string
  children?: TypesetAnnotationItem[]
}

export interface TypesetMetadata {
  title?: string
  author?: string
  dynasty?: string
}

export interface TypesetLuaTeXStatus {
  available: boolean
  path: string
  version: string
}

export interface TypesetPackageStatus {
  installed: boolean
  version: string
}

export interface TypesetEnvironmentStatus {
  luatex: TypesetLuaTeXStatus
  luatexCn: TypesetPackageStatus
  configValidation?: ConfigValidationReport
}

export interface TypesetCompileResult {
  success: boolean
  pdfPath: string
  log: string
  error?: string
}

export const PRODUCT_NAME = '文献管理'
export const PRODUCT_NAME_EN = 'GujiSmart'
export const PRODUCT_FULL_NAME = '文献管理（GujiSmart）'
export const PRODUCT_SUBTITLE = '面向古籍与通用文献的研究工作台'

export interface ImportDocumentResult {
  id: string
  title: string
  success: boolean
  sourceGrantId?: string
  displayName?: string
  error?: string
  sourceType?: 'file' | 'image-file' | 'paddle-json' | 'ebook-text' | 'restored-pdf' | 'duplicate-pdf'
  ocrReady?: boolean
  restoredDocId?: string
  restoredAsset?: boolean
  duplicateOfDocId?: string
  storedPath?: string
  pageCount?: number
  pdfCompression?: PdfCompressionSummary
}

export interface ImportProgressEvent {
  phase: 'copying' | 'hashing' | 'stored'
  filePath: string
  fileName: string
  fileIndex: number
  totalFiles: number
  bytesDone?: number
  totalBytes?: number
  progress?: number
  statusEnvelope?: StatusEnvelope
  pipelineDiagnostics?: DocumentPipelineDiagnostics
}

export interface ImportDocumentOptions {
  ocrEngine?: OcrEngine
  libraryProjectId?: string
}

export interface BatchOcrOptions {
  engine?: OcrEngine
  forceFullRerun?: boolean
  retryFailedPagesOnly?: boolean
  concurrency?: number
}

export interface ImportAutoOcrTaskCreateOptions {
  engine: OcrEngine
  batchSize: number
  sourceImportJobId?: string | null
  libraryProjectId?: string
}

export interface ImportAutoOcrTaskItemInput {
  docId: string
  sourceOrder: number
  sourceType?: string | null
}

export interface ImportAutoOcrTaskCreateResult {
  jobId: string
  engine: OcrEngine
  batchSize: number
  totalCount: number
}

export interface ImportAutoOcrTaskAppendResult {
  jobId: string
  appendedCount: number
  totalCount: number
}

export interface ImportAutoOcrTaskStartResult {
  jobId: string
  totalCount: number
  started: boolean
}

export type OcrRecognizeMode = 'accurate' | 'traditional'

export interface OcrRecognizeWordResult {
  words?: string
  [key: string]: unknown
}

export interface OcrRecognizeLayoutBlock {
  words?: string
  raw_words?: string
  text?: string
  label?: string
  block_label?: string
  type?: string
  location?: unknown
  [key: string]: unknown
}

export type OcrIrSemanticType =
  | 'document_title'
  | 'heading'
  | 'paragraph'
  | 'abstract'
  | 'reference'
  | 'list'
  | 'index'
  | 'note'
  | 'caption'
  | 'footnote'
  | 'page_header'
  | 'page_footer'
  | 'page_number'
  | 'aside'
  | 'table'
  | 'image'
  | 'chart'
  | 'formula_inline'
  | 'formula_display'
  | 'code'
  | 'seal'
  | 'unknown'

export type OcrIrOrientation = 'horizontal' | 'vertical' | 'unknown'
export type OcrIrOrientationSource =
  | 'ocr'
  | 'coordinate'
  | 'page_consensus'
  | 'document_consensus'
  | 'manual'
  | 'unknown'
export type OcrReadingOrderSource = 'ocr' | 'coordinate' | 'source'
export type OcrIrSourceEngine = OcrEngine | 'native_pdf_text' | 'imported' | 'unknown'

export interface OcrBoundingBox {
  left: number
  top: number
  width: number
  height: number
}

export interface OcrIrSource {
  engine: OcrIrSourceEngine
  provider?: string
  model?: string
  stage?: string
  sourceIndex?: number
}

export interface OcrProcessingEvent {
  stage: string
  action: string
  timestamp?: string
  reason?: string
}

export interface OcrQualityIssue {
  code:
    | 'empty_text'
    | 'missing_coordinates'
    | 'low_confidence'
    | 'invalid_unicode'
    | 'suspicious_repetition'
    | 'reading_order_gap'
    | 'fallback_used'
    | 'needs_enhancement'
    | 'discarded_content'
  severity: 'info' | 'warning' | 'error'
  message: string
  blockId?: string
}

export interface OcrQualityReport {
  score: number
  coordinateCoverage: number
  confidenceCoverage: number
  lowConfidenceBlockCount: number
  missingCoordinateBlockCount: number
  discardedBlockCount: number
  issues: OcrQualityIssue[]
}

export interface OcrAssetRef {
  id: string
  kind: 'image' | 'chart' | 'table' | 'formula' | 'crop'
  path?: string
  mimeType?: string
  bbox?: OcrBoundingBox
  normalizedBbox?: OcrBoundingBox
}

export interface OcrTableCellV1 {
  row: number
  column: number
  rowSpan: number
  columnSpan: number
  text: string
  bbox?: OcrBoundingBox
  normalizedBbox?: OcrBoundingBox
}

export interface OcrTableV1 {
  rows: string[][]
  cells: OcrTableCellV1[]
  html?: string
  markdown?: string
  complexity: 'simple' | 'complex' | 'unknown'
  continuesFromPreviousPage?: boolean
  continuesToNextPage?: boolean
}

export interface OcrFormulaV1 {
  latex: string
  display: boolean
  sourceText?: string
  assetId?: string
}

export interface OcrSpanV1 {
  id: string
  type: 'text' | 'formula_inline' | 'phonetic' | 'unknown'
  text: string
  bbox?: OcrBoundingBox
  normalizedBbox?: OcrBoundingBox
  confidence?: number
  source: OcrIrSource
}

export interface OcrLineV1 {
  id: string
  text: string
  bbox?: OcrBoundingBox
  normalizedBbox?: OcrBoundingBox
  confidence?: number
  spans: OcrSpanV1[]
}

export interface OcrBlockV1 {
  id: string
  type: OcrIrSemanticType
  text: string
  rawText?: string
  bbox?: OcrBoundingBox
  normalizedBbox?: OcrBoundingBox
  confidence?: number
  orientation: OcrIrOrientation
  orientationSource: OcrIrOrientationSource
  sourceOrientation: OcrIrOrientation
  sourceOrientationSource: OcrIrOrientationSource
  readingOrder: number
  sourceReadingOrder?: number
  readingOrderSource: OcrReadingOrderSource
  manualReadingOrder?: number
  columnIndex?: number
  lines: OcrLineV1[]
  childBlockIds?: string[]
  parentBlockId?: string
  table?: OcrTableV1
  formula?: OcrFormulaV1
  assetId?: string
  source: OcrIrSource
  processing: OcrProcessingEvent[]
}

export interface OcrParagraphV1 {
  id: string
  type: 'heading' | 'paragraph' | 'list' | 'note' | 'reference'
  text: string
  blockIds: string[]
  readingOrder: number
  orientation?: OcrIrOrientation
  columnIndex?: number
  bbox?: OcrBoundingBox
  normalizedBbox?: OcrBoundingBox
  continuationGroupId?: string
  continuesFromPreviousPage?: boolean
  continuesToNextPage?: boolean
}

export interface OcrPageV1 {
  pageIndex: number
  width: number
  height: number
  orientation: OcrIrOrientation
  orientationSource: OcrIrOrientationSource
  blocks: OcrBlockV1[]
  discardedBlocks: OcrBlockV1[]
  paragraphs: OcrParagraphV1[]
  assets: OcrAssetRef[]
  quality: OcrQualityReport
}

export interface OcrPageIrEnvelopeV1 {
  schemaVersion: 'gujismart-ocr-ir/v1'
  generator: 'GujiSmart'
  pipelineVersion: string
  generatedAt: string
  page: OcrPageV1
}

export interface OcrDocumentV1 {
  schemaVersion: 'gujismart-ocr-ir/v1'
  generator: 'GujiSmart'
  pipelineVersion: string
  orientation: OcrIrOrientation
  orientationConfidence: number
  pages: OcrPageV1[]
  paragraphs: OcrParagraphV1[]
  quality: OcrQualityReport
}

export interface OcrRecognizeResult {
  text?: string
  words_result?: OcrRecognizeWordResult[]
  layout_result?: OcrRecognizeLayoutBlock[]
  source_type?: string
  gujismart_ir?: OcrPageIrEnvelopeV1
  [key: string]: unknown
}

export type OcrProgressPhase = 'queued' | 'ocr' | 'saving' | 'ai' | 'completed' | 'error' | 'canceled'

export interface OcrProgressEvent {
  docId: string
  status: string
  progress: number
  phase?: OcrProgressPhase
  message?: string
  completedPages?: number
  totalPages?: number
  pageNum?: number
  aiStatus?: 'processing' | 'completed' | 'error'
  errorMessage?: string
  canceled?: boolean
  statusEnvelope?: StatusEnvelope
  runMetadata?: OcrRunMetadata
}

export interface PageOcrVersion {
  id: string
  doc_id?: string
  page_id?: string
  page_num?: number
  engine: OcrEngine | string
  label?: string
  status: string
  is_active: number
  created_at?: string
  updated_at?: string
}

export interface BatchAutoExtractError {
  docId: string
  title?: string
  error: string
}

export interface BatchAutoExtractResult {
  totalCount: number
  successCount: number
  skippedCount: number
  failedCount: number
  concurrency: number
  errors: BatchAutoExtractError[]
}

export interface DocumentAppendPagePayload {
  pageNum?: number
  dataUrl: string
}

export interface DocumentAppendPagesOptions {
  reset?: boolean
  totalPages?: number
}

export interface InitializePdfPagesOptions {
  title?: string
}

export interface PdfInfoResult {
  title: string
  pageCount: number
  source?: 'qpdf' | 'pdf-lib' | 'pdfjs'
}

export type PdfTextLayerMode = 'native_text' | 'ocr' | 'mixed'

export interface PdfTextLayerPageAnalysis {
  pageNum: number
  mode: Exclude<PdfTextLayerMode, 'mixed'>
  pageWidth: number
  pageHeight: number
  text: string
  cleanCharacterCount: number
  invalidUnicodeRatio: number
  replacementCharacterRatio: number
  coordinateCoverage: number
  imageObjectCount: number
  reasons: string[]
  layoutBlocks: OcrRecognizeLayoutBlock[]
}

export interface PdfTextLayerAnalysis {
  mode: PdfTextLayerMode
  pageCount: number
  sampledPageNums: number[]
  nativeTextPageCount: number
  ocrPageCount: number
  averageCleanCharacters: number
  analyzedAt: string
  pages: PdfTextLayerPageAnalysis[]
}

export interface PdfAssetCleanupResult {
  cleaned: boolean
  bytesFreed: number
}

export interface CompletedPdfAssetCleanupResult {
  cleanedCount: number
  bytesFreed: number
}

export interface PdfRepositoryStatus {
  repositories: PdfRepositoryEntry[]
  paths: string[]
  stats: {
    fileCount: number
    totalBytes: number
  }
  lastIndexedAt: string | null
}

export interface PdfRepositoryEntry {
  repositoryId: string
  displayName: string
  displayPath: string
  available: boolean
}

export interface PdfRepositoryIndexResult {
  fileCount: number
  totalBytes: number
  matchedCount: number
}

/** How PDF original is restored into the library. */
export type PdfAssetRestoreStorageMode = 'copy' | 'link'

export interface PdfAssetRestoreOptions {
  /**
   * When true, only register the source absolute path (no copy into app storage).
   * Faster for large files; path must remain readable (external disk / NAS).
   * When omitted, main process uses the `pdf_restore_link_only` setting.
   */
  linkOnly?: boolean
}

export interface PdfAssetRestoreResult {
  restored: boolean
  path?: string
  error?: string
  pdfCompression?: PdfCompressionSummary
  /** copy = duplicated under data/storage; link = external path only */
  storageMode?: PdfAssetRestoreStorageMode
}

export interface PdfCompressionSummary {
  attempted: boolean
  compressed: boolean
  skipped?: boolean
  reason?: string
  originalBytes: number
  storedBytes: number
  savedBytes: number
  ratio: number
  quality: number
  thresholdBytes: number
  maxImageSide?: number
  tool: string
  toolVersion?: string
}

export type DocumentHealthIssueType =
  | 'missing_author'
  | 'missing_year'
  | 'missing_identifier'
  | 'missing_publisher'
  | 'missing_source'
  | 'suspicious_title'
  | 'unknown_type'
  | 'zero_page'
  | 'missing_metadata'
  | 'title_cleanup'

export interface DocumentHealthIssue {
  type: DocumentHealthIssueType
  severity: 'high' | 'medium' | 'low'
  label: string
  detail: string
}

export interface DocumentHealthRow {
  id: string
  title: string
  author: string | null
  doc_type: string
  page_count: number
  file_path?: string | null
  ocr_status: OcrStatus | string
  proof_status: ProofStatus | string
  metadata_status: MetadataStatus | string
  read_status: ReadStatus | string
  text_page_count: number
  image_page_count: number
  research_note_count: number
  search_segment_count: number
  pdf_size_bytes: number
  pdf_asset_state: string
  risk_score: number
  issues: DocumentHealthIssue[]
}

export interface DocumentHealthReport {
  generatedAt: string
  stats: Record<string, number>
  rows: DocumentHealthRow[]
}

export interface DocumentHealthReportOptions {
  refresh?: boolean
}

export const DEFAULT_LIBRARY_PROJECT_ID = 'library_project_default'

export interface LibraryProject {
  id: string
  name: string
  description: string
  color: string
  is_default: number
  document_count: number
  created_at: string
  updated_at: string
}

export interface CreateLibraryProjectPayload {
  name: string
  description?: string
  color?: string
  activate?: boolean
}

export interface MoveDocumentsToLibraryProjectResult {
  requested: number
  moved: number
  from_project_ids: string[]
  target_project_id: string
}

export interface RemoveDocumentsFromLibraryProjectResult {
  requested: number
  removed: number
  removed_document_ids: string[]
  reassigned_to_default: number
  skipped_last_default: number
  source_project_id: string
}

export interface AddDocumentsToLibraryProjectResult {
  requested: number
  added: number
  already_present: number
  source_project_id: string
  target_project_id: string
}

export interface CopiedLibraryProjectDocument {
  source_document_id: string
  copied_document_id: string
}

export interface CopyDocumentsToLibraryProjectResult {
  requested: number
  copied: number
  source_project_id: string
  target_project_id: string
  documents: CopiedLibraryProjectDocument[]
}

export interface Document {
  id: string
  library_project_id: string
  title: string
  author: string | null
  dynasty: string | null
  source: string | null
  doc_type: string
  file_path: string | null
  thumb_path: string | null
  page_count: number
  ocr_status: OcrStatus
  proof_status: ProofStatus
  import_status: ImportStatus
  error_message: string | null
  retry_count: number
  last_retry_at: string | null
  is_favorite: number
  favorite_at: string | null
  read_status: ReadStatus
  rating: number | null
  last_opened_at: string | null
  metadata_status: MetadataStatus
  metadata: string
  created_at: string
  updated_at: string
}

export interface DocumentUpdatePayload extends Partial<Pick<Document,
  | 'title'
  | 'author'
  | 'dynasty'
  | 'source'
  | 'doc_type'
  | 'page_count'
  | 'ocr_status'
  | 'proof_status'
  | 'import_status'
  | 'error_message'
  | 'retry_count'
  | 'last_retry_at'
  | 'is_favorite'
  | 'favorite_at'
  | 'read_status'
  | 'rating'
  | 'last_opened_at'
  | 'metadata_status'
>> {
  metadata?: string | DocumentMetadataResult
}

export type LibraryDocumentSortKey =
  | 'default'
  | 'title'
  | 'createdAt'
  | 'updatedAt'
  | 'publicationYear'
  | 'lastOpened'
  | 'pageCount'

export type LibraryDocumentSortDirection = 'asc' | 'desc'

export type LibraryDocumentSearchField = 'title' | 'author' | 'folder' | 'tag'

export interface ListDocumentOptions {
  search?: string
  searchFields?: LibraryDocumentSearchField[]
  author?: string
  docType?: string
  ocrStatus?: string
  ocrIncomplete?: boolean
  importStatus?: string
  folderId?: string
  folderIds?: string[]
  unfiledOnly?: boolean
  tagId?: string
  tagIds?: string[]
  readStatus?: string
  metadataStatus?: string
  proofStatus?: string
  metadataPending?: boolean
  favoritesOnly?: boolean
  yearFrom?: number
  yearTo?: number
  healthFilter?: LibraryHealthFilterType
  /** When true, only documents with ready embedding index status. */
  embeddingReady?: boolean
  /**
   * Finer embedding status filter (preferred over embeddingReady).
   * Can combine with folderIds/tagIds — e.g. folder ∩ not_ready.
   */
  embeddingFilter?: LibraryEmbeddingFilter
  sortKey?: LibraryDocumentSortKey
  sortDirection?: LibraryDocumentSortDirection
  limit?: number
  offset?: number
}

/**
 * Lightweight document rows for filter dropdowns (search filters, etc.).
 * Uses only documents-table fields — never scans pages or probes the filesystem.
 * page_count / ocr_status are whatever was written at import/OCR completion.
 */
export interface DocumentFilterOption {
  id: string
  title: string | null
  author: string | null
  doc_type: string | null
  page_count: number | null
  ocr_status: string | null
}

export type LibraryHealthFilterType =
  | 'healthMissingMetadata'
  | 'healthSuspiciousTitle'
  | 'healthUnknownType'
  | 'healthTitleCleanup'

export type LibraryFilterType =
  | 'all'
  | 'folder'
  | 'tag'
  | 'docType'
  | 'ocrStatus'
  | 'ocrIncomplete'
  | 'importStatus'
  | 'favorite'
  | 'readStatus'
  | 'metadataStatus'
  | 'proofStatus'
  | 'metadataPending'
  | 'embeddingReady'
  | 'embeddingNotReady'
  | 'embeddingQueued'
  | 'embeddingProcessing'
  | 'embeddingError'
  | LibraryHealthFilterType

export interface LibraryFilter {
  type: LibraryFilterType
  value?: string
  tagIds?: string[]
  /**
   * Optional AND folder scope when `type` is a smart filter (e.g. 已向量化 ∩ 某文件夹).
   * When `type === 'folder'`, use `value` as the folder id instead.
   */
  scopeFolderId?: string
  /**
   * Optional AND tag scope when `type` is a smart filter.
   * When `type === 'tag'`, use `tagIds` / `value` instead.
   */
  scopeTagIds?: string[]
  /**
   * Optional AND refinement for vector status (folder/tag/all ∩ embedding state).
   * Preferred over changing `type` to embedding* when combining scopes.
   */
  embeddingFilter?: LibraryEmbeddingFilter
}

export interface DocumentListItem extends Omit<Document, 'ocr_status' | 'proof_status' | 'import_status' | 'metadata_status' | 'metadata'> {
  ocr_status: string
  proof_status: string
  import_status: string
  metadata_status: MetadataStatus
  metadata?: string | null
  actual_page_count?: number
  text_page_count?: number
  ocr_completed_page_count?: number
  image_page_count?: number
  pdf_asset_state?: 'available' | 'text_only' | 'unknown' | string
  research_note_count?: number
  search_segment_count?: number
  /** ready | queued | processing | error | none (from embedding_index_status). */
  embedding_status?: string
  embedding_chunk_count?: number
  tag_names?: string
  tag_colors?: string
  tag_ids?: string
  tag_sources?: string
  folder_ids?: string
  folder_names?: string
}

export interface DocumentListPage {
  items: DocumentListItem[]
  total: number
  limit: number
  offset: number
}

export type BatchProgressStatus = 'pending' | 'running' | 'paused' | 'completed' | 'error' | 'canceled' | (string & {})

export interface BatchJob {
  id: string
  docIds: string[]
  batchSize: number
  currentBatch: number
  totalBatches: number
  status: BatchProgressStatus
  processedCount: number
  failedCount: number
  startTime: number | null
}

export interface BatchStartResult {
  jobId: string
  count: number
  batchSize: number
}

export interface BatchProgressEvent {
  jobId: string
  status: BatchProgressStatus
  currentBatch: number
  totalBatches: number
  processedCount: number
  failedCount: number
  totalCount: number
  progress: number
  estimatedTime: number
}

export interface TaskProgressEvent {
  taskId: string
  progress: number
  message: string
}

export type BackgroundTaskKind = 'search-index' | 'health-report' | 'ocr-finalize' | 'startup-recovery' | 'database-maintenance' | 'embedding-index' | 'document-delete'

export interface EmbeddingLinkedProfile {
  id: string
  name: string
  provider: string
  baseUrl: string
  chatModel: string
  /** True only when this profile has its own vault entry, or is active and uses global llm_api_key. */
  apiKeyConfigured: boolean
  apiKeyLast4?: string
  /**
   * profile = llm_profile:{id} vault entry exists
   * active-global = only the current AI key (llm_api_key), not a dedicated profile secret
   * none = no key bound
   */
  keySource: 'profile' | 'active-global' | 'none'
}

export interface EmbeddingIndexStats {
  modelId: string
  dim: number | null
  autoOnIngest: boolean
  useLlmCredentials: boolean
  sourceProfileId: string
  sourceProfileName: string
  baseUrl: string
  model: string
  /** Effective batch size used for /embeddings requests (already capped). */
  batchSize: number
  /** Model/provider hard cap for one /embeddings request (e.g. text-embedding-v4 = 10). */
  batchSizeCap: number
  /** User-requested batch before cap; equals batchSize when within limit. */
  batchSizeRequested: number
  /** Whether the last save/provider switch auto-clamped batch size. */
  batchSizeAutoAdjusted: boolean
  /** Short note for UI, e.g.「通义单次最多 10 条」. */
  batchSizeHint?: string
  /** Requested output dimensions; 0 = model default. */
  dimensions: number
  /** Allowed dimensions for current model (empty if not configurable). */
  dimensionsOptions: number[]
  dimensionsDefault: number | null
  modelSpecNote?: string
  apiKeyConfigured: boolean
  docsReady: number
  docsQueued: number
  docsProcessing: number
  docsError: number
  docsPending: number
  /** Marked ready but missing vectors for the currently selected model. */
  docsStale?: number
  chunks: number
  queuePaused: boolean
  message?: string
  linkedProfiles: EmbeddingLinkedProfile[]
}

export interface VectorSearchHit {
  documentId: string
  title: string | null
  author: string | null
  pageNum: number | null
  excerpt: string
  score: number
  ref: { docId: string; pageNum: number | null; segmentId?: string }
}

export interface VectorSearchResponse {
  ok: true
  query: string
  modelId: string
  totalHits: number
  hits: VectorSearchHit[]
  hint?: string
}

export interface VectorSearchFailure {
  ok: false
  code: string
  message: string
}
export type BackgroundTaskStatus = 'queued' | 'processing' | 'completed' | 'error'

export interface BackgroundTaskProgressEvent {
  taskId: string
  kind: BackgroundTaskKind
  status: BackgroundTaskStatus
  progress?: number
  message?: string
  docId?: string
  totalCount?: number
  completedCount?: number
  errorMessage?: string
  updatedAt: string
  taskState: TaskStateEnvelope
}

/** Per-document + queue aggregate progress for vectorization (mirrors OCR card/queue UX). */
export type EmbeddingProgressStatus = 'queued' | 'processing' | 'ready' | 'error' | 'pending' | 'idle'

export interface EmbeddingProgressEvent {
  docId?: string
  status: EmbeddingProgressStatus
  /** 0–100 progress for the current document (segment coverage). */
  progress: number
  message?: string
  embeddedCount?: number
  segmentCount?: number
  errorMessage?: string
  /** Queue snapshot across the library. */
  queueQueued: number
  queueProcessing: number
  queueReady: number
  queueError: number
  /** Session counters since the latest enqueue burst (for 处理队列). */
  sessionTotal: number
  sessionCompleted: number
  sessionFailed: number
  queuePaused: boolean
  updatedAt: string
}

export type TranslationStyle = 'academic_smooth' | (string & {})
export type TranslationMode = 'fast' | 'balanced' | 'quality'
export type TranslationUnitStatus = 'pending' | 'processing' | 'ready' | 'stale' | 'error' | 'skipped'
export type TranslationSearchScope = 'all' | 'source' | 'translation'

export interface TranslationUnitV1 {
  id: string
  docId: string
  pageId: string
  pageNum: number
  blockId: string
  blockIndex: number
  order: number
  blockType: string
  sourceText: string
  sourceHash: string
  translationText: string
  targetLanguage: 'zh-CN'
  mode: TranslationMode
  modelSignature: string
  glossarySignature: string
  status: TranslationUnitStatus
  manualOverride: boolean
  stale: boolean
  skipped: boolean
  quality: Record<string, unknown>
  sourceRect?: {
    left: number
    top: number
    width: number
    height: number
  } | null
  sourceIndex?: number | null
  createdAt?: string | null
  updatedAt?: string | null
  currentRevisionId?: string | null
  revision?: number | null
}

export interface PageTranslationRequest {
  taskId?: string
  docId: string
  pageId: string
  mode?: TranslationMode
  glossaryProjectId?: string | null
  style?: TranslationStyle
  force?: boolean
  unitIds?: string[]
  priority?: ReaderTranslationPriority
  documentTitle?: string
  pageContextBefore?: string
  pageContextAfter?: string
}

export interface PageTranslationProgressEvent {
  taskId: string
  docId: string
  pageId: string
  pageNum: number
  mode: TranslationMode
  completedBatches: number
  totalBatches: number
  units: TranslationUnitV1[]
  sourceText: string
  translationText: string
}

export interface PageTranslationResult {
  taskId: string
  docId: string
  pageId: string
  pageNum: number
  mode: TranslationMode
  units: TranslationUnitV1[]
  sourceText: string
  translationText: string
  translatedCount: number
  cachedCount: number
  failedCount: number
  skippedCount: number
  complete: boolean
}

export interface TranslationUnitUpdatePayload {
  translationText: string
  manualOverride?: boolean
  expectedRevisionId?: string | null
}

export interface TranslationContextSnapshot {
  id: string
  context_hash: string
  unit_id: string
  doc_id: string
  page_id: string
  unit_source_hash: string
  canonical_source_hash: string
  content_version: string
  source_locator_json: string
  target_language: string
  mode: TranslationMode
  style: string
  provider_id: string
  model: string
  model_signature: string
  parameters_hash: string
  glossary_version: string
  prompt_version: string
  protector_version: string
  normalizer_version: string
  created_at: number
}

export interface TranslationUnitRevision {
  id: string
  unit_id: string
  revision: number
  parent_revision_id: string | null
  context_snapshot_id: string | null
  source_hash: string
  translation_text: string
  origin: 'legacy' | 'machine' | 'manual'
  status: 'active' | 'superseded' | 'detached' | 'stale'
  content_hash: string
  quality_json: string
  created_at: number
}

export interface TranslationAttempt {
  id: string
  task_id: string
  unit_id: string
  context_snapshot_id: string
  base_revision_id: string
  status: 'running' | 'committed' | 'conflict' | 'error' | 'canceled'
  candidate_revision_id: string | null
  error_code: string | null
  created_at: number
  completed_at: number | null
}

export interface TranslationRevisionCommitResult {
  outcome: 'committed' | 'conflict'
  revision: TranslationUnitRevision
  activeRevisionId: string
}

export interface TranslationCacheKeyOptions {
  docId?: string | null
  pageId: string
  sourceText: string
  modelSignature?: string | null
  glossarySignature?: string | null
  style?: TranslationStyle | null
}

export type BookTranslationProgressStatus = 'started' | 'processing' | 'completed' | 'partial' | 'error' | (string & {})

export interface BookTranslationProgressEvent {
  jobId: string
  docId: string
  status: BookTranslationProgressStatus
  progress: number
  completedPages?: number
  failedPages?: number
  cachedPages?: number
  stalePages?: number
  skippedPages?: number
  translatedPages?: number
  totalPages?: number
  pageNum?: number
  outputPath?: string
  message?: string
  errorMessage?: string
}

export interface BookTranslationOptions {
  glossaryProjectId?: string | null
  style?: TranslationStyle
  mode?: TranslationMode
  concurrency?: number
  retryFailedOnly?: boolean
  clearCache?: boolean
}

export interface BookTranslationStartResult {
  jobId: string
  status: 'started' | 'running' | string
}

export type ReaderTranslationPriority = 'current' | 'prefetch' | 'book'

export interface ReaderTranslationPayload {
  pageId: string
  pageNum: number
  text: string
  readerPageKey?: string
  cachePageId?: string
}

export interface ReaderTranslationOptions {
  priority?: ReaderTranslationPriority
  force?: boolean
}

export interface MetadataReclassificationProgressEvent {
  status: 'started' | 'progress' | 'completed'
  totalCount: number
  processedCount: number
  successCount: number
  failedCount: number
  concurrency?: number
  currentDocId?: string
  currentTitle?: string
}

export interface Page {
  id: string
  doc_id: string
  /** Physical / PDF order (1-based image index in the library). */
  page_num: number
  /**
   * Continuous literature (printed) page number after OCR + continuity resolution.
   * Prefer this for citations, export labels, and AI/MCP page mentions.
   */
  literature_page_num?: number | null
  /** ocr | inferred | fallback */
  literature_page_source?: string | null
  /** Raw OCR-detected printed label before continuity smoothing. */
  ocr_page_label?: number | null
  image_path: string | null
  ocr_text: string | null
  ocr_result: string | null
  proofed_text: string | null
  ocr_text_ref?: string | null
  ocr_result_ref?: string | null
  proofed_text_ref?: string | null
  ocr_status: OcrStatus
  proof_status: ProofStatus
  created_at: string
}

export interface PageUpdatePayload extends Partial<Pick<Page,
  | 'ocr_text'
  | 'proofed_text'
  | 'ocr_status'
  | 'proof_status'
>> {
  ocr_result?: unknown
}

export interface DocumentPage extends Page {
  has_ocr_text?: boolean
  needs_layout_attention?: boolean
  has_text?: boolean | number
  __full?: boolean
  __light?: boolean
  __search_text_only?: boolean
  canonical_content?: CanonicalPageContent
}

export interface DocumentLightPage extends Pick<Page, 'id' | 'doc_id' | 'page_num' | 'image_path' | 'ocr_status' | 'proof_status' | 'created_at'> {
  has_text: boolean | number
  has_ocr_result: boolean | number
  __light?: boolean
}

export interface DocumentReadingWindow {
  document: Document
  pages: DocumentPage[]
  pageIndex: number
  pageCount: number
  startPageNum: number
  endPageNum: number
  radius: number
}

export interface AiLayoutCacheItem {
  id: string
  doc_id: string
  page_id: string
  page_num: number
  mode: AiLayoutMode
  source_hash: string
  result_text: string
  result_text_ref?: string | null
  status: 'ready' | 'error' | string
  error_message: string | null
  model: string | null
  created_at: string
  updated_at: string
}

export type PageTranslationCacheStatus = 'ready' | 'error' | string

export interface PageTranslationCacheItem {
  id: string
  doc_id: string
  page_id: string
  page_num: number
  source_hash: string
  source_text: string
  translation_text: string
  source_text_ref?: string | null
  translation_text_ref?: string | null
  skipped: number
  status: PageTranslationCacheStatus
  error_message?: string | null
  model?: string | null
  created_at?: string
  updated_at?: string
}

export interface PageTranslationCachePayload {
  sourceHash?: string
  source_hash?: string
  sourceText?: string
  source_text?: string
  translationText?: string
  translation_text?: string
  skipped?: boolean
  status?: PageTranslationCacheStatus
  errorMessage?: string | null
  error_message?: string | null
  model?: string
  style?: TranslationStyle
}

export interface EbookTocItem {
  id: string
  title: string
  href: string
  level: number
  order: number
  parent_id?: string | null
  anchor_text?: string | null
  anchor_context?: string | null
  anchor_key?: string | null
  source_page_num?: number | null
}

export type TocItemSource = 'manual' | 'ai' | 'rule' | 'imported' | 'legacy'
export type TocItemStatus = 'active' | 'unresolved' | 'disabled'

export interface TocItemV2 extends EbookTocItem {
  doc_id?: string
  source: TocItemSource
  confidence: number
  status: TocItemStatus
  created_at?: string
  updated_at?: string
}

export interface EbookTextSection {
  id: string
  href: string
  title: string
  level: number
  spine_index: number
  segment_index: number
  text: string
  html_blocks?: Array<{
    type: 'heading' | 'paragraph' | 'table'
    text: string
    level?: number
    rows?: string[][]
    anchor_id?: string
  }>
}

export interface EbookManifest {
  format: 'epub' | 'plain_text' | 'markdown'
  title?: string
  author?: string
  language?: string
  identifier?: string
  source_file_name?: string
  section_count: number
  spine: Array<{ href: string; title?: string }>
  toc: EbookTocItem[]
}

export interface ReaderState {
  doc_id: string
  location_key: string
  progress: number
  view_mode: 'single' | 'spread'
  font_size: number
  line_height: number
  theme: 'paper' | 'sepia' | 'dark'
  document_mode?: 'read' | 'proof'
  proof_location_key?: string
  proof_progress?: number
  proof_view_mode?: 'text' | 'facsimile'
  updated_at: string
}

export type ReaderStateSavePayload = Partial<Omit<ReaderState, 'doc_id' | 'updated_at'>>

export interface OpenDocumentTarget {
  docId: string
  pageIndex?: number
  keyword?: string
  excerpt?: string
  sourceId?: string
  locator?: SearchHitLocator
  stableLocator?: StableReaderLocator
  searchSession?: SearchSessionState
  revealToc?: boolean
  highlightExcerpt?: string
  sourceLabel?: string
  highlightColor?: string
  startReaderBookTranslation?: boolean
  openTranslation?: boolean
}

export interface Folder {
  id: string
  library_project_id: string
  name: string
  parent_id: string | null
  external_path: string | null
  icon: string
  color: string | null
  sort_order: number
  created_at: string
  updated_at: string
  document_count?: number
}

export interface FolderCreatePayload {
  name: string
  parent_id?: string | null
  icon?: string
  color?: string | null
}

export type FolderUpdatePayload = Partial<Pick<Folder, 'name' | 'parent_id' | 'icon' | 'color' | 'sort_order'>>

export interface FolderMovePayload {
  id: string
  parent_id?: string | null
  before_id?: string | null
  after_id?: string | null
}

export interface FolderDocumentMovePayload {
  docIds: string[]
  source_folder_id?: string | null
  target_folder_id: string
}

export interface FolderContentOptions {
  folderId?: string | null
  unfiledOnly?: boolean
  limit?: number
  offset?: number
  sortKey?: LibraryDocumentSortKey
  sortDirection?: LibraryDocumentSortDirection
}

export interface FolderOverviewDocument {
  id: string
  title: string
  author?: string | null
  doc_type?: string | null
  page_count?: number | null
  thumb_path?: string | null
  first_page_image_path?: string | null
  created_at?: string | null
  updated_at?: string | null
  last_opened_at?: string | null
}

export interface FolderContentResult {
  folder_id: string | null
  unfiled?: boolean
  documents: FolderOverviewDocument[]
  total_document_count: number
  limit: number
  offset: number
  has_more: boolean
}

export interface FolderOverviewItem extends Folder {
  direct_document_count: number
  cumulative_document_count: number
  child_folder_count: number
  recent_documents: FolderOverviewDocument[]
}

export interface FolderOverviewResult {
  folders: FolderOverviewItem[]
  root_folder_count: number
  total_folder_count: number
  total_document_count: number
  unfiled_document_count: number
}

export interface FolderImportFile {
  name: string
  path: string
  size: number
  ext: string
}

export interface DocumentFolder {
  doc_id: string
  folder_id: string
}

export interface Tag {
  id: string
  library_project_id: string
  name: string
  color: string
  parent_id: string | null
  source: TagSource
  confidence: number | null
  usage_count: number
  normalized_name: string
}

export interface TagCreatePayload {
  name: string
  color?: string
  parent_id?: string | null
  source?: TagSource
  confidence?: number | null
}

export type TagUpdatePayload = Partial<TagCreatePayload>

export interface DocumentTag {
  doc_id: string
  tag_id: string
}

export interface BulkAssociationResult {
  count: number
}

export interface MetadataTagBindingCleanupResult {
  removedRelations: number
  keptManualRelations: number
  removedTags: number
}

export interface MetadataTagBindingRebuildResult {
  processedDocuments: number
  syncedDocuments: number
  skippedDocuments: number
  createdOrUpdatedRelations: number
}

export interface SettingSetResult {
  success: boolean
  metadataTagCleanup?: MetadataTagBindingCleanupResult | null
  metadataTagRebuild?: MetadataTagBindingRebuildResult | null
}

export interface MetadataCandidate {
  id: string
  doc_id: string
  field_name: string
  candidate_value: string
  source: string
  confidence: number
  evidence_page: number | null
  evidence_text: string | null
  accepted: number
  rejected: number
  created_at: string
  updated_at: string
}

export interface AiTagSuggestion {
  name: string
  color: string
  confidence: number
}

export interface SavedSearch {
  id: string
  name: string
  filters: string
  created_at: string
  updated_at: string
}

export interface AiResult {
  id: string
  doc_id: string
  task_type: AiTaskType
  prompt: string
  prompt_hash: string
  result: string
  model: string
  created_at: string
  aiResponseEnvelope?: AiResponseEnvelope
}

export interface BatchQueueItem {
  id: string
  batch_id: string
  doc_id: string
  status: 'pending' | 'processing' | 'completed' | 'failed'
  batch_size: number
  progress: number
  error_message: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface BatchCreateResult {
  batchId: string
  count: number
}

export interface CitationTemplate {
  id: string
  style_id?: string | null
  name: string
  format_type: string
  template_text: string
  field_mappings: string
  is_default: number
  created_at: string
  updated_at: string
}

export interface CitationStyle {
  id: string
  name: string
  description: string
  is_default: number
  created_at: string
  updated_at: string
  templates?: CitationTemplate[]
}

export type CitationPageFieldOverrides = Partial<Record<'pages' | 'page_reference' | 'cite_pages', string | number | null | undefined>>

export interface CitationGenerateOptions {
  pageNum?: string | number | null
  fieldOverrides?: CitationPageFieldOverrides
}

export interface CitationStylePayload {
  name: string
  description?: string
  is_default?: number
}

export type CitationStyleUpdatePayload = Partial<CitationStylePayload>

export interface CitationTemplateDraft {
  name: string
  format_type: string
  template_text: string
  field_mappings?: string
  is_default?: number
}

export interface CitationTemplatePayload extends CitationTemplateDraft {
  style_id?: string | null
}

export type CitationTemplateUpdatePayload = Partial<CitationTemplatePayload>

export interface CitationStyleDraft {
  styleName: string
  description?: string
  templates: CitationTemplateDraft[]
  notes?: string
}

export interface CitationStyleDraftWithRaw extends CitationStyleDraft {
  raw: string
}

export interface CitationStyleDraftOptions {
  is_default?: number
}

export interface CitationTemplateInference {
  nameSuggestion: string
  formatType: string
  templateText: string
  notes?: string
}

export interface Setting {
  key: string
  value: string
}

export type SettingsMap = Record<string, string>

export interface CredentialPublicState {
  configured: boolean
  last4?: string
  version: number
  state: 'active' | 'missing' | 'corrupt'
}

export type {
  CitationResolutionDiagnostic,
  CitationResolutionV2,
  CitationResolvedField,
  CitationResolvedFieldStatus,
} from './citation-resolution-v2'

export interface CitationSnapshot {
  id: string
  identity_hash: string
  document_id: string
  style_id: string
  template_id: string
  citation_type: string
  format_id: string
  metadata_version: string
  style_version: string
  template_version: string
  resolution_json: string
  rendered_text: string
  verification_status: 'verified' | 'draft' | 'blocked' | 'legacy-unverified'
  snapshot_hash: string
  created_at: number
}

export interface CredentialDraftRef {
  draftRef: string
  expiresAt: number
}

export interface LlmProviderProfile {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey?: string
  model: string
  updatedAt?: string
  credential?: CredentialPublicState
  connectionTest?: VisionOcrConnectionTestState
}

export interface VisionOcrConnectionTestState {
  verified: boolean
  testedAt?: string
}

export interface VisionOcrConnectionTestPayload {
  id?: string
  name?: string
  provider?: string
  baseUrl?: string
  model?: string
  apiKey?: string
  useLlmConfig?: boolean
}

export interface VisionOcrConnectionTestResult extends VisionOcrConnectionTestState {
  profileId: string
  message: string
}

export interface ListModelsPayload {
  baseUrl?: string
  credentialDraftRef?: string
  credentialKey?: 'llm_api_key' | 'vision_ocr_api_key' | 'embedding_api_key'
}

export interface LlmProviderProfileState {
  activeId: string
  current: LlmProviderProfile
  profiles: LlmProviderProfile[]
  configValidation?: ConfigValidationReport
}

export interface LlmProviderProfilesResult {
  activeId: string
  profiles: LlmProviderProfile[]
  configValidation?: ConfigValidationReport
}

export interface BackupResult {
  success: boolean
  path?: string | null
  canceled?: boolean
  error?: string
  integrityReport?: BackupIntegrityReport
}

export interface BackupImportResult extends BackupResult {
  importedBackupPath?: string | null
  safetyBackupPath?: string | null
  requiresRestart?: boolean
  restoredIntegrityReport?: BackupIntegrityReport
}

export interface BackupSlot {
  slot: number
  path: string
  exists: boolean
  timestamp?: string
  sizeBytes?: number
  includesStorage?: boolean
  integrityReport?: BackupIntegrityReport
  credentialsExcluded?: boolean
  credentialRequiredAfterRestore?: boolean
}

export interface BackupStatus {
  enabled: boolean
  intervalHours: number
  slotCount: number
  nextSlot: number
  includeStorage: boolean
  lastBackupAt: string | null
  nextBackupAt: string | null
  autoBackupRoot: string
  slots: BackupSlot[]
  legacyCredentialRiskCount: number
  configValidation?: ConfigValidationReport
}

export interface CompactAutoBackupResult {
  success: boolean
  beforeBytes: number
  afterBytes: number
  bytesFreed: number
  backup?: BackupResult
  error?: string
}

export type DocumentExportFormat =
  | 'markdown'
  | 'tei-xml'
  | 'page-xml'
  | 'paddle-json'
  | 'txt'
  | 'reading-pdf'
  | 'layout-pdf'
  | 'layout-searchable-pdf'

/**
 * Page number label used in exports and reader UI:
 * - literature: 文献页码（书上印刷/校准后的连续页码，默认）
 * - natural: 自然页码（PDF/扫描影像物理页序 1…N）
 */
export type ExportPageNumberMode = 'literature' | 'natural'

export interface DocumentExportOptions {
  facsimileFontScale?: number
  facsimileShowRules?: boolean
  facsimileDisplayScript?: 'original' | 'simplified' | 'traditional'
  readingFontFamily?: string
  readingFontSize?: number
  readingLineHeight?: number
  readingPageWidth?: number
  readingTheme?: 'paper' | 'sepia' | 'dark'
  readingDisplayScript?: 'original' | 'simplified' | 'traditional'
  /** Default: literature (文献页码). */
  pageNumberMode?: ExportPageNumberMode
}

export interface DocumentExportBatchError {
  docId: string
  message: string
}

export interface DocumentExportBatchResult {
  canceled: boolean
  successCount: number
  failedCount: number
  directoryPath: string | null
  errors: DocumentExportBatchError[]
}

export type TranslationGlossaryScope = 'global' | 'project'

export interface TranslationGlossaryTerm {
  id: string
  glossary_id: string
  source_term: string
  target_term: string
  note: string
  enabled: number
  case_sensitive: number
  created_at: string
  updated_at: string
  scope?: TranslationGlossaryScope
  project_id?: string | null
  glossary_name?: string
}

export interface TranslationGlossaryTermPayload {
  id?: string
  scope?: TranslationGlossaryScope
  projectId?: string | null
  glossaryId?: string
  sourceTerm?: string
  targetTerm?: string
  note?: string
  enabled?: boolean
  caseSensitive?: boolean
}

export interface TranslationGlossaryListOptions {
  scope?: TranslationGlossaryScope | 'all'
  projectId?: string | null
  search?: string
  includeDisabled?: boolean
}

export interface ActiveTranslationGlossaryPayload {
  text?: string
  projectId?: string | null
}

export interface ActiveTranslationGlossaryResult {
  terms: TranslationGlossaryTerm[]
  signature: string
  promptBlock: string
}

export interface OnboardingStep {
  step_key: string
  completed: number
  completed_at: string | null
}

export interface ResearchProject {
  id: string
  library_project_id: string
  name: string
  description: string
  status: ResearchProjectStatus
  created_at: string
  updated_at: string
  document_count?: number
  note_count?: number
  output_count?: number
  outline_count?: number
  ai_dataset_count?: number
}

export type ResearchProjectStatus = 'active' | 'archived'

export interface ResearchProjectPayload {
  name: string
  description?: string
  status?: ResearchProjectStatus
}

export type ResearchProjectUpdatePayload = Partial<ResearchProjectPayload>

export interface ResearchOutlineItem {
  id: string
  project_id: string
  parent_id: string | null
  title: string
  description: string
  sort_order: number
  created_at: string
  updated_at: string
  note_count?: number
}

export interface ResearchOutlinePayload {
  project_id: string
  parent_id?: string | null
  title: string
  description?: string
  sort_order?: number
}

export type ResearchOutlineUpdatePayload = Partial<ResearchOutlinePayload>

export interface ResearchNote {
  id: string
  library_project_id: string
  project_id: string | null
  doc_id: string
  page_num: number | null
  excerpt: string
  note: string
  tags: string
  source_type: ResearchNoteSourceType
  source_id: string | null
  kind: ResearchKnowledgeKind
  outline_id: string | null
  color: string
  locator_json: string
  citation_text: string
  source_hash: string
  sort_order: number
  created_at: string
  updated_at: string
  doc_title?: string
  doc_author?: string | null
  doc_type?: string | null
  source_available?: number
}

export type ResearchNoteSourceType = 'manual' | 'search' | 'ai' | 'ai_research'

export type ResearchNoteListSort = 'updated_desc' | 'created_desc' | 'document_asc' | 'page_asc' | 'kind_asc'

export interface ListResearchNotesOptions {
  limit?: number
  offset?: number
  includeOverview?: boolean
  search?: string
  searchColors?: string[]
  projectId?: string
  unassignedOnly?: boolean
  kind?: ResearchKnowledgeKind
  source?: ResearchNoteSourceType | 'reader'
  color?: string
  tag?: string
  sort?: ResearchNoteListSort
}

export interface ResearchNoteListStats {
  total: number
  documentCount: number
  tags: string[]
  colorCount: number
}

export interface ResearchNoteListPage {
  items: ResearchNote[]
  total: number
  limit: number
  offset: number
  scopeDocIds?: string[]
  stats?: ResearchNoteListStats
}

export interface DeleteResearchNotesResult {
  requested: number
  deleted: number
}

export interface ResearchNotePayload {
  project_id?: string | null
  projectId?: string | null
  doc_id?: string
  docId?: string
  page_num?: number | null
  pageNum?: number | null
  excerpt: string
  note?: string
  tags?: string | string[]
  source_type?: ResearchNoteSourceType
  sourceType?: ResearchNoteSourceType
  source_id?: string | null
  sourceId?: string | null
  kind?: ResearchKnowledgeKind
  outline_id?: string | null
  outlineId?: string | null
  color?: string
  locator?: unknown
  locator_json?: string
  citation_text?: string
  citationText?: string
  source_hash?: string
  sourceHash?: string
  sort_order?: number
}

export type ResearchNoteUpdatePayload = Partial<ResearchNotePayload>

export type ResearchReferenceExportFormat = 'bibtex' | 'ris' | 'gbt7714'

export interface ResearchOutput {
  id: string
  project_id: string
  output_type: AiSynthesisTemplate
  title: string
  content: string
  source_dataset_id?: string | null
  input_snapshot_json?: string
  created_at: string
  sourceDatasetId?: string | null
  inputSnapshotJson?: string
}

export interface ResearchOutputPayload {
  project_id: string
  output_type: AiSynthesisTemplate
  title: string
  content: string
  source_dataset_id?: string | null
  input_snapshot_json?: string
  inputSnapshotJson?: string
  aggregate_ids?: string[]
  aggregateIds?: string[]
}

export interface ExportSnapshot {
  id: string
  identity_hash: string
  document_id: string
  format: string
  options_json: string
  source_version: string
  page_manifest_json: string
  snapshot_hash: string
  created_at: number
}

export interface ExportArtifact {
  id: string
  snapshot_id: string
  export_path: string
  content_hash: string
  byte_size: number
  created_at: number
}

export interface ResearchDashboardStats {
  totalDocuments: number
  recentReadCount: number
  pendingProofCount: number
  pendingMetadataCount: number
  citationMissingCount: number
  aiReadyCount: number
  projectCount: number
  noteCount: number
}

export interface ResearchProjectExportOptions {
  format: 'markdown' | 'json'
  includeReferences?: boolean
  citationStyleId?: string
}

export interface ResearchProjectExportResult {
  format: 'markdown' | 'json'
  content: string
  noteCount: number
  outlineCount: number
  referenceCount: number
}

export type {
  AiResponseEnvelope,
  AiResponseEnvelopeStatus,
  AiResponseSourceSummary,
} from './ai-response-envelope'

export type {
  BackupIntegrityIssue,
  BackupIntegrityMetrics,
  BackupIntegrityReport,
  BackupIntegritySeverity,
  BackupIntegrityStatus,
} from './backup-integrity'

export type {
  CitationFieldIssue,
  CitationFieldIssueSeverity,
  CitationFieldResolutionReport,
} from './citation-field-resolver'

export type {
  ConfigValidationIssue,
  ConfigValidationReport,
  ConfigValidationSeverity,
  ConfigValidationStatus,
} from './config-validation'

export type {
  DocumentPipelineDiagnosticIssue,
  DocumentPipelineDiagnosticSeverity,
  DocumentPipelineDiagnostics,
  DocumentPipelineStage,
  DocumentPipelineStatus,
  DocumentPipelineStatusSnapshot,
} from './document-pipeline-diagnostics'

export type {
  OcrRunMetadata,
  OcrRunPageSummary,
  OcrRunQualityStatus,
  OcrRunQualitySummary,
} from './ocr-run-metadata'

export type {
  ResearchProjectIntegrityIssue,
  ResearchProjectIntegrityReport,
} from './research-integrity'

export type {
  MetadataTagCleanupAction,
  MetadataTagCleanupDecision,
  MetadataTagRelationGuardInput,
} from './metadata-tag-guard'

export type {
  SearchIndexHealthDiagnostics,
  SearchIndexHealthIssue,
  SearchIndexHealthSeverity,
  SearchIndexHealthStatus,
} from './search-index-health'

export interface SearchResult {
  doc_id: string
  page_num: number
  occurrence_index?: number
  snippet: string
  rank: number
  doc_title: string
  doc_author: string | null
  doc_type: string
  relevance_score?: number
  hit_field?: string
  matched_query?: string
  folder_names?: string
  tag_names?: string
  tag_sources?: string
  read_status?: ReadStatus
  is_favorite?: number
  metadata_status?: MetadataStatus
  locator?: SearchHitLocator
  stableLocator?: StableReaderLocator
  updated_at?: string
  last_opened_at?: string | null
}

export interface SearchHitLocator {
  docId: string
  segmentId: string
  sourceType?: string
  blockId?: string | null
  translationUnitId?: string | null
  translationSource?: boolean
  pageId?: string | null
  pageNum?: number | null
  pageIndex?: number | null
  href?: string | null
  locationKey?: string
  segmentOrdinal: number
  charStart: number
  charEnd: number
  normalizedCharStart?: number
  normalizedCharEnd?: number
  matchText: string
  queryTerm: string
  occurrenceIndex: number
}

export interface ResearchEvidence {
  id: string
  identity_hash: string
  doc_id: string
  page_id: string | null
  page_num: number | null
  locator_json: string
  quote: string
  source_hash: string
  content_version: string
  verification_status: SearchEvidenceVerificationStatus
  created_at: number
  verified_at: number | null
}

export interface ResearchEvidenceRelation {
  id: string
  evidence_id: string
  project_id: string | null
  relation_kind: string
  note: string
  tags_json: string
  status: string
  created_at: number
  updated_at: number
}

export interface ResearchRecordVersion {
  id: string
  record_id: string
  version: number
  evidence_id: string | null
  values_json: string
  status: 'pending' | 'confirmed' | 'excluded' | 'needs-review'
  note: string
  content_hash: string
  parent_version_id: string | null
  created_at: number
}

export interface ResearchOutputVersion {
  id: string
  output_id: string | null
  project_id: string
  version: number
  parent_version_id: string | null
  output_type: AiSynthesisTemplate
  title: string
  content: string
  content_hash: string
  status: 'draft' | 'formal' | 'archived'
  input_manifest_json: string
  input_manifest_hash: string
  created_at: number
}

export interface ResearchClaimBinding {
  start: number
  end: number
  evidenceIds?: string[]
  aggregateIds?: string[]
}

export interface ResearchClaimManifest {
  id: string
  output_version_id: string
  schema_version: 'research-claim-manifest/v1'
  content_hash: string
  parser_version: 'claim-segmenter/v1'
  normalization_version: 'unicode-nfc-crlf/v1'
  coverage_json: string
  manifest_hash: string
  created_at: number
}

export interface ResearchClaimEntry {
  id: string
  manifest_id: string
  ordinal: number
  claim_kind: 'statement' | 'numeric'
  char_start: number
  char_end: number
  text_hash: string
  occurrence_index: number
  support_status: 'supported' | 'unsupported' | 'stale'
  evidence_ids_json: string
  aggregate_ids_json: string
  created_at: number
}

export interface ResearchClaimManifestPage {
  manifest: ResearchClaimManifest
  entries: CursorPage<ResearchClaimEntry>
}

export interface ResearchClaimManifestValidationResult {
  validation: 'verified' | 'incomplete' | 'stale' | 'corrupt' | 'not-found'
  manifest: ResearchClaimManifest | null
  coverage: { total: number; supported: number; unsupported: number; stale: number }
  reason?: string
}

export type StableReaderLocatorPrecision = 'exact' | 'block' | 'page' | 'document'
export type StableReaderLocatorVerificationStatus = 'verified' | 'legacy-unverified'
export type StableReaderOffsetUnit = 'utf16-code-unit'

export interface StableReaderSourceRange {
  start: number
  end: number
}

interface StableReaderLocatorBase {
  schemaVersion: 'stable-reader-locator/v2'
  precision: StableReaderLocatorPrecision
  documentId: string
  sourcePageId?: string
  pageNum?: number
  href?: string
  chapterPath?: string[]
  progressFallback?: number
  sourceKind?: string
  verificationStatus: StableReaderLocatorVerificationStatus
}

export interface StableReaderExactLocator extends StableReaderLocatorBase {
  precision: 'exact'
  contentVersion: string
  sourceHash: string
  offsetUnit: StableReaderOffsetUnit
  sourceRanges: StableReaderSourceRange[]
  quote: string
  prefix: string
  suffix: string
  occurrenceIndex: number
}

export interface StableReaderBlockLocator extends StableReaderLocatorBase {
  precision: 'block'
  blockId: string
  contentVersion: string
  sourceHash: string
}

export interface StableReaderPageLocator extends StableReaderLocatorBase {
  precision: 'page'
  contentVersion?: string
  sourceHash?: string
}

export interface StableReaderDocumentLocator extends StableReaderLocatorBase {
  precision: 'document'
  contentVersion?: string
  sourceHash?: string
}

export type StableReaderLocator = StableReaderExactLocator | StableReaderBlockLocator | StableReaderPageLocator | StableReaderDocumentLocator
export type StableReaderLocatorResolution = 'exact' | 'relocated' | 'unresolved'

export interface StableReaderLocatorResolutionResult {
  resolution: StableReaderLocatorResolution
  locator: StableReaderLocator
  reason?: string
}

export interface SearchHit {
  id: string
  locator: SearchHitLocator
  stableLocator?: StableReaderLocator
  snippet: string
  score: number
}

export interface EvidenceQaPlan {
  intent: string
  keywords: string[]
  expandedKeywords: string[]
  excludeKeywords: string[]
  inferredFilters?: {
    docType?: string
    author?: string
    dynasty?: string
    yearFrom?: number | null
    yearTo?: number | null
  }
  notes?: string
}

export interface EvidenceQaSource {
  doc_id: string
  doc_title: string
  page_num: number | null
  snippet: string
  locator?: SearchHitLocator
  stableLocator?: StableReaderLocator
  rank?: number
  matched_query?: string
  source_hash?: string
}

export interface EvidenceQaClusterPage {
  page_num: number
  text: string
  role: 'hit' | 'before' | 'after'
}

export interface EvidenceQaCluster {
  id: string
  doc_id: string
  doc_title: string
  anchor_page_num: number | null
  page_range: [number, number]
  score: number
  queries: string[]
  hit_count: number
  pages: EvidenceQaClusterPage[]
  sources: EvidenceQaSource[]
}

export interface EvidenceQaResponse {
  answer: string
  sources: EvidenceQaSource[]
  plan: EvidenceQaPlan
  expandedQueries: string[]
  evidenceClusters: EvidenceQaCluster[]
  warnings: string[]
  aiResponseEnvelope?: AiResponseEnvelope
}

export type AiStreamEventType = 'phase' | 'delta' | 'sources' | 'done' | 'error'

export interface AiStreamEvent {
  requestId: string
  type: AiStreamEventType
  payload: unknown
}

export type SummaryScope = 'selection' | 'paragraphs' | 'page' | 'toc-section' | 'document' | 'basket' | 'project'

export interface AiSummaryResult {
  markdown: string
  sources: EvidenceQaSource[]
  scope: SummaryScope
  aiResponseEnvelope?: AiResponseEnvelope
}

export interface AiSynthesisResult {
  markdown: string
  sources: EvidenceQaSource[]
  aiResponseEnvelope?: AiResponseEnvelope
}

export type LibraryAiScope =
  | { type: 'all' }
  | { type: 'tags'; tagIds: string[] }
  | { type: 'folders'; folderIds: string[] }
  | { type: 'documents'; docIds: string[] }

export type LibraryAiTab = 'qa' | 'analysis' | 'research'

export interface LibraryAiOpenPayload {
  question?: string
  scope?: LibraryAiScope
  scopeLabel?: string
  initialTab?: LibraryAiTab
  researchProjectId?: string | null
}

export interface LibraryAiScopePreview {
  count: number
  ocrReadyCount: number
  documents: Array<{
    id: string
    title: string
  }>
}

export interface ScopedLibraryAiResponse {
  answer: string
  results: SearchResult[]
  preview: LibraryAiScopePreview
}

export type AiChatMode = 'document' | 'library'

export interface AiChatSession {
  id: string
  library_project_id: string
  mode: AiChatMode
  doc_id?: string | null
  title: string
  scope_json?: string | null
  created_at: string
  updated_at: string
  message_count?: number
}

export interface AiChatTurn {
  id: string
  session_id: string
  prompt: string
  result: string
  task_type: AiTaskType
  metadata_json?: string | null
  created_at: string
  sources?: EvidenceQaSource[]
  plan?: EvidenceQaPlan
  expandedQueries?: string[]
  evidenceClusters?: EvidenceQaCluster[]
  warnings?: string[]
  aiResponseEnvelope?: AiResponseEnvelope
  researchTaskId?: string
  datasetId?: string
}

export interface AiResearchFieldSchema {
  key: string
  label: string
  type: AiResearchFieldType
  description?: string
  required?: boolean
}

export interface AiResearchPlan {
  title: string
  goal: string
  kind?: AiResearchTaskKind
  fields: AiResearchFieldSchema[]
  suggestedQueries: string[]
  notes?: string
}

export interface AiResearchPlanPayload {
  goal: string
  scope: LibraryAiScope
  projectId?: string | null
}

export interface AiResearchCreateTaskPayload extends AiResearchPlanPayload {
  title?: string
  kind?: AiResearchTaskKind
  fields: AiResearchFieldSchema[]
  suggestedQueries?: string[]
}

export interface AiResearchTask {
  id: string
  library_project_id: string
  project_id: string | null
  title: string
  goal: string
  kind: AiResearchTaskKind
  scope_json: string
  field_schema_json: string
  suggested_queries_json: string
  status: AiResearchTaskStatus
  error_message: string
  dataset_id: string | null
  created_at: string
  updated_at: string
  fieldSchema?: AiResearchFieldSchema[]
  suggestedQueries?: string[]
  record_count?: number
}

export interface AiResearchRetrievalPlan {
  taskId?: string | null
  projectId?: string | null
  goal: string
  scope: LibraryAiScope
  kind: AiResearchTaskKind
  queries: string[]
  coreQueries?: string[]
  excludeQueries: string[]
  maxRounds: number
  queriesPerRound: number
  highFrequencyHitThreshold: number
  highFrequencyDocThreshold: number
  evidenceBudget: number
  perQueryEvidenceLimit: number
  perDocumentPageLimit: number
  perPageSnippetLimit: number
}

export interface AiResearchFacetBucket {
  key: string
  label: string
  count: number
}

export interface AiResearchQueryFacets {
  docTypes: AiResearchFacetBucket[]
  years: AiResearchFacetBucket[]
  folders: AiResearchFacetBucket[]
  tags: AiResearchFacetBucket[]
  cooccurringTerms: AiResearchFacetBucket[]
}

export interface AiResearchQueryStat {
  query: string
  terms: string[]
  round: number
  hitCount: number
  documentCount: number
  pageCount: number
  segmentCount: number
  highFrequency: boolean
  facets: AiResearchQueryFacets
}

export interface AiResearchEvidenceLocalStats {
  documentCount: number
  pageCount: number
  hitCount: number
  highFrequency: boolean
  cooccurringTerms: string[]
}

export interface AiResearchRetrievalRound {
  round: number
  queries: string[]
  generatedQueries: string[]
  highFrequencyQueries: string[]
  message: string
}

export interface AiResearchRetrievalStats {
  taskId?: string | null
  runId?: string | null
  plan: AiResearchRetrievalPlan
  queryStats: AiResearchQueryStat[]
  rounds: AiResearchRetrievalRound[]
  totalHitCount: number
  totalDocumentCount: number
  totalPageCount: number
  readableSegmentCount: number
  highFrequencyTriggered: boolean
  cooccurringTerms: AiResearchFacetBucket[]
  createdAt: string
}

export interface AiResearchEvidenceItem {
  id: string
  query: string
  doc_id: string
  doc_title: string
  doc_type: string
  page_num: number
  snippet: string
  score: number
  matched_query: string
  localStats?: AiResearchEvidenceLocalStats
  locator?: SearchHitLocator
  stableLocator?: StableReaderLocator
}

export interface AiResearchEvidencePack {
  taskId?: string | null
  runId?: string | null
  evidence: AiResearchEvidenceItem[]
  totalEvidenceCount: number
  truncated: boolean
  createdAt: string
  statsSummary: {
    totalHitCount: number
    totalDocumentCount: number
    totalPageCount: number
  }
}

export interface AiResearchRetrievalPreviewPayload {
  goal: string
  scope: LibraryAiScope
  projectId?: string | null
  fields?: AiResearchFieldSchema[]
  suggestedQueries?: string[]
  kind?: AiResearchTaskKind
}

export interface AiResearchRetrievalRunResult {
  stats: AiResearchRetrievalStats
  evidencePack: AiResearchEvidencePack
}

export interface AiResearchRunProgressEvent {
  taskId: string
  phase: AiResearchRunPhase
  round?: number
  maxRounds?: number
  currentQuery?: string
  message: string
  hitCount?: number
  documentCount?: number
  pageCount?: number
  evidenceCount?: number
  progress: number
  statusEnvelope?: StatusEnvelope
}

export interface AiResearchTaskStep {
  id: string
  task_id: string
  step_key: string
  title: string
  status: AiResearchStepStatus
  message: string
  progress: number
  created_at: string
  updated_at: string
}

export interface AiResearchDataset {
  id: string
  library_project_id: string
  task_id: string
  project_id: string | null
  name: string
  description: string
  field_schema_json: string
  created_at: string
  updated_at: string
  fieldSchema?: AiResearchFieldSchema[]
  record_count?: number
}

export interface AiResearchRecord {
  id: string
  library_project_id: string
  dataset_id: string
  task_id: string
  project_id: string | null
  doc_id: string
  doc_title?: string
  page_num: number | null
  excerpt: string
  locator_json: string
  source_hash: string
  values_json: string
  confidence: number
  status: AiResearchRecordStatus
  note: string
  created_at: string
  updated_at: string
  values?: Record<string, string>
}

export interface AiResearchRunResult {
  task: AiResearchTask
  dataset: AiResearchDataset
  records: AiResearchRecord[]
  retrievalStats?: AiResearchRetrievalStats
  evidencePack?: AiResearchEvidencePack
}

export interface AiResearchRecordUpdatePayload {
  values?: Record<string, string>
  status?: AiResearchRecordStatus
  note?: string
}

export interface AiResearchRecordListOptions {
  limit?: number
  offset?: number
}

export interface AiResearchReportPayload {
  datasetId: string
  templateType?: AiSynthesisTemplate
  customPrompt?: string
}

export interface AiResearchExportResult {
  format: 'csv' | 'markdown' | 'json'
  content: string
  recordCount: number
}

export interface AiTaskOptions {
  question?: string
  selectedText?: string
  strictArticleOnly?: boolean
  length?: string
  onlyNonChinese?: boolean
  parallelSegments?: boolean
  segmentCount?: number
  glossaryProjectId?: string | null
  translationStyle?: TranslationStyle
  documentTitle?: string
  pageContextBefore?: string
  pageContextAfter?: string
  translationUnits?: boolean
  translationMode?: TranslationMode
  translationReview?: boolean
  previousTranslation?: string
  snippets?: string
  pageNum?: number
  [key: string]: unknown
}

export interface AiQuestionOptions {
  limit?: number
  sessionId?: string | null
  sessionTitle?: string
  requestId?: string
}

export interface AiQuestionResponse extends EvidenceQaResponse {
  session?: AiChatSession
  turn?: AiChatTurn
}

export interface AiStreamStartResult {
  requestId: string
  sessionId?: string
}

export interface AiChatSessionListPayload {
  mode: AiChatMode
  docId?: string | null
}

export interface AiChatSessionCreatePayload extends AiChatSessionListPayload {
  title?: string
  scope?: LibraryAiScope
}

export interface AiSummarySourcePayload {
  doc_id?: string
  docId?: string
  doc_title?: string
  docTitle?: string
  page_num?: number | null
  pageNum?: number | null
  locator?: SearchHitLocator
}

export interface AiSummaryPayload {
  text: string
  scope?: SummaryScope
  title?: string
  instruction?: string
  format?: string
  source?: AiSummarySourcePayload
}

export interface SearchDocumentGroup {
  docId: string
  title: string
  author: string | null
  docType: string
  readStatus?: ReadStatus
  isFavorite?: number
  metadataStatus?: MetadataStatus
  tagNames?: string[]
  folderNames?: string[]
  totalHits: number
  topHits: SearchHit[]
  hits: SearchHit[]
  score: number
  updatedAt?: string
  lastOpenedAt?: string | null
}

export interface SearchGroupedResponse {
  query: string
  totalDocuments: number
  totalHits: number
  groups: SearchDocumentGroup[]
  warnings: string[]
  status?: SearchQueryStatus
  page?: number
  pageSize?: number
  totalPages?: number
  snapshotId?: string
  librarySearchGeneration?: number
  indexGenerationVectorHash?: string
  snapshotExpiresAt?: number
}

export type SearchSnapshotValidation = 'active' | 'expired' | 'stale' | 'criteria-mismatch' | 'not-found'

export interface SearchSnapshotMetadata {
  snapshotId: string
  criteriaHash: string
  librarySearchGeneration: number
  indexGenerationVectorHash: string
  createdAt: number
  expiresAt: number
}

export interface SearchSnapshotValidationResult {
  validation: SearchSnapshotValidation
  snapshot: SearchSnapshotMetadata | null
  currentGeneration: number
}

export interface SearchSnapshotAggregateSummary {
  query: string
  totalDocuments: number
  totalHits: number
  status: SearchQueryStatus
  warnings: string[]
  exactness: 'exact' | 'bounded-preview'
  coverage: {
    returnedDocuments: number
    returnedHits: number
    totalsExact: boolean
  }
}

export interface ResearchAggregateArtifact {
  id: string
  identity_hash: string
  criteria_hash: string
  library_generation: number
  index_generation_vector_hash: string
  exactness: 'exact' | 'bounded-preview'
  result_json: string
  result_hash: string
  coverage_json: string
  created_at: number
}

export interface ResearchAggregateRelation {
  id: string
  aggregate_id: string
  project_id: string
  relation_kind: string
  label: string
  created_at: number
  updated_at: number
}

export type SearchEvidenceVerificationStatus = 'verified' | 'stale' | 'source-missing' | 'legacy-unverified' | 'migration-pending'

export interface ResolvedSearchEvidence {
  stableLocator: StableReaderLocator
  text: string
  sourceKind: string
  precision: StableReaderLocatorPrecision
  resolution: StableReaderLocatorResolution
  verificationStatus: SearchEvidenceVerificationStatus
  contentVersion?: string
  sourceHash?: string
  reason?: string
}

export type SearchQueryStatus = 'preview' | 'candidate' | 'verifying' | 'scanning' | 'complete'

export interface SearchSessionState {
  query: string
  hits: SearchHit[]
  activeHitIndex: number
  status: 'idle' | 'searching' | 'ready' | 'empty' | 'error'
  phase?: SearchQueryStatus
  /**
   * Reader navigation engine for this session.
   * - fulltext (default): in-document keyword hits; may expand via FTS.
   * - vector: semantic hits; must not re-run keyword search; highlight by excerpt.
   */
  engine?: 'fulltext' | 'vector'
}

export interface SearchDocumentHitPage {
  docId: string
  query: string
  hits: SearchHit[]
  totalHits: number
  page: number
  pageSize: number
  totalPages: number
  status: SearchSessionState['status']
}

export interface AiSearchPlan {
  intent: string
  keywords: string[]
  expandedKeywords: string[]
  excludeKeywords: string[]
  inferredFilters: {
    docType?: string
    author?: string
    dynasty?: string
    yearFrom?: number | null
    yearTo?: number | null
  }
  notes?: string
}

export interface AiPlannedSearchResponse {
  plan: AiSearchPlan
  results: SearchResult[]
  grouped: SearchGroupedResponse
  effectiveFilters: SearchOptions
  expandedQueries: string[]
  warnings: string[]
}

export interface SearchReindexDocumentResult {
  docId: string
  status: string
  segmentCount: number
  error?: string
}

export interface SearchReindexAllResult {
  total: number
  ready: number
  errors: number
  queued?: number
}

export interface SearchIndexStatus {
  doc_id: string
  status: string
  source_hash: string
  segment_count: number
  error_message: string | null
  indexed_at: string | null
  updated_at: string | null
  statusEnvelope?: StatusEnvelope
  healthDiagnostics?: SearchIndexHealthDiagnostics
}

export interface SearchOptions {
  docType?: string
  author?: string
  dynasty?: string
  folderId?: string
  folderIds?: string[]
  tagId?: string
  tagIds?: string[]
  docIds?: string[]
  importStatus?: ImportStatus
  ocrStatus?: OcrStatus
  readStatus?: ReadStatus
  metadataStatus?: MetadataStatus
  favoritesOnly?: boolean
  yearFrom?: number
  yearTo?: number
  limit?: number
  page?: number
  pageSize?: number
  sort?: 'relevance' | 'hitCount' | 'updated' | 'lastOpened' | 'title'
  contextMode?: 'short' | 'standard' | 'long'
  exhaustive?: boolean
  resultMode?: 'preview' | 'all'
  autoReindex?: boolean
  format?: SearchExportFormat
  citationMode?: CitationMode
  citationStyleId?: string
  citationTemplateId?: string
  previewOnly?: boolean
  translationScope?: TranslationSearchScope
  snapshotId?: string
  /**
   * Export/preview path: use embedding vector search hits instead of full-text FTS.
   * Desktop vector mode must set this so “导出命中摘录” does not re-run keyword search.
   */
  searchEngine?: 'fulltext' | 'vector'
  /** Default: literature (文献页码). */
  pageNumberMode?: ExportPageNumberMode
  /**
   * When set, export/preview/save builds from these on-screen groups instead of re-querying.
   * Avoids a second full-corpus vector scan (main-process freeze on large indexes).
   */
  exportGroups?: SearchDocumentGroup[]
  /** Optional warnings carried with exportGroups (e.g. vector model label). */
  exportWarnings?: string[]
  /**
   * Vector export only: keep hits with cosine similarity ≥ this value (0–1).
   * 0 or omitted = no score filter.
   */
  minVectorScore?: number
  /**
   * Max records to write on export/preview (vector evidence rows or fulltext paragraphs).
   * Clamped server-side; omit for engine default.
   */
  maxExportRecords?: number
}

export interface SearchExportOptions {
  citationMode?: CitationMode
  citationStyleId?: string
  citationTemplateId?: string
  previewOnly?: boolean
  format?: SearchExportFormat
  /** When true / from vector search, export includes similarity scores and AI-oriented layout. */
  searchEngine?: 'fulltext' | 'vector'
  /** Default: literature (文献页码). */
  pageNumberMode?: ExportPageNumberMode
  /**
   * Vector export only: keep hits with cosine similarity ≥ this value (0–1).
   * 0 or omitted = no score filter.
   */
  minVectorScore?: number
  /** Max exportable records after score filter (clamped). */
  maxExportRecords?: number
}

export interface SearchExportPreviewItem {
  title: string
  author: string | null
  docType: string
  pageNum: number | null
  paragraph: string
  hitTerms: string[]
  hitCount: number
  citation: string
  locatorText: string
  sourceType: string
  sourceKey: string
  /** Cosine similarity for vector hits (0–1). */
  score?: number | null
}

export interface SearchExportPreviewResult {
  exporterVersion: string
  keyword: string
  totalDocuments: number
  totalHits: number
  exportableParagraphs: number
  skippedHits: number
  /** Hits dropped because score &lt; minVectorScore (vector export). */
  filteredByMinScore?: number
  /** Effective min similarity used for this preview (0 = none). */
  minVectorScore?: number
  /** Cap applied to exportable records. */
  maxExportRecords?: number
  previewItems: SearchExportPreviewItem[]
}

export interface SearchExportResult {
  canceled: boolean
  filePath: string | null
  totalHits: number
  totalDocuments: number
  content?: string
  exportableParagraphs?: number
  skippedHits?: number
  /** Hits dropped because score &lt; minVectorScore (vector export). */
  filteredByMinScore?: number
  minVectorScore?: number
  maxExportRecords?: number
}

export interface SaveSearchExcerptsOptions extends SearchOptions {
  projectId?: string | null
}

export interface SaveSearchExcerptsResult {
  savedCount: number
  skippedCount: number
  totalRecords: number
}

export interface SavedSearchRunResult {
  savedSearch: SavedSearch | null
  keyword: string
  mode: 'fulltext' | 'ai' | 'vector'
  filters: SearchOptions
  sort?: SearchOptions['sort']
  contextMode?: SearchOptions['contextMode']
  results: SearchResult[]
  grouped: SearchGroupedResponse | null
  cacheHit?: boolean
}

export interface SavedSearchFilters {
  keyword?: string
  docType?: string
  author?: string
  folderId?: string
  tagId?: string
  tagIds?: string[]
  importStatus?: ImportStatus
  ocrStatus?: OcrStatus
  readStatus?: ReadStatus
  metadataStatus?: MetadataStatus
  favoritesOnly?: boolean
  yearFrom?: number
  yearTo?: number
  limit?: number
  resultMode?: 'preview' | 'all'
  exhaustive?: boolean
}

export interface SavedSearchCachePayload {
  grouped?: SearchGroupedResponse | null
  results?: SearchResult[]
  libraryFingerprint?: string
  cachedAt?: string
}

export interface SavedSearchPayload extends SavedSearchFilters {
  mode?: 'fulltext' | 'ai' | 'vector'
  filters?: SearchOptions
  sort?: SearchOptions['sort']
  contextMode?: SearchOptions['contextMode']
  cache?: SavedSearchCachePayload
  savedAt?: string
}

export interface LibraryAiSearchResponse {
  answer: string
  results: SearchResult[]
}

export interface DocumentDetail extends Document {
  pages: DocumentPage[]
  tags: Tag[]
  folders: Folder[]
  metadata_candidates?: MetadataCandidate[]
}

export interface DocumentLightDetail extends Omit<DocumentDetail, 'pages'> {
  pages: DocumentLightPage[]
}

export type BatchItemStatus = BatchQueueItem['status']

export const IMPORT_STATUS_MAP: Record<ImportStatus, { color: string; text: string }> = {
  unstored: { color: 'default', text: '未入库' },
  stored: { color: 'blue', text: '已入库' },
  processing: { color: 'processing', text: '处理中' },
  processed: { color: 'success', text: '已处理' },
  error: { color: 'error', text: '处理失败' },
}

export const OCR_STATUS_MAP: Record<OcrStatus, { color: string; text: string }> = {
  pending: { color: 'default', text: '待 OCR' },
  queued: { color: 'warning', text: '排队中' },
  processing: { color: 'processing', text: '识别中' },
  completed: { color: 'success', text: '已识别' },
  error: { color: 'error', text: '识别失败' },
}

export const READ_STATUS_MAP: Record<ReadStatus, { color: string; text: string }> = {
  unread: { color: 'default', text: '未读' },
  reading: { color: 'processing', text: '在读' },
  read: { color: 'success', text: '已读' },
}

export const METADATA_STATUS_MAP: Record<MetadataStatus, { color: string; text: string }> = {
  pending: { color: 'default', text: '待提取' },
  review: { color: 'warning', text: '待确认' },
  confirmed: { color: 'success', text: '已确认' },
  auto: { color: 'blue', text: '自动填充' },
}

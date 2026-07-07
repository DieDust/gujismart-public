import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AiChatSessionCreatePayload,
  AiChatSessionListPayload,
  AiChatSession,
  AiChatTurn,
  AiLayoutCacheItem,
  AiLayoutMode,
  AiQuestionOptions,
  AiQuestionResponse,
  AiResult,
  AiPlannedSearchResponse,
  AiResearchCreateTaskPayload,
  AiResearchDataset,
  AiResearchExportResult,
  AiResearchPlan,
  AiResearchPlanPayload,
  AiResearchRecord,
  AiResearchRecordListOptions,
  AiResearchRecordUpdatePayload,
  AiResearchReportPayload,
  AiResearchRetrievalPreviewPayload,
  AiResearchRetrievalRunResult,
  AiResearchRetrievalStats,
  AiResearchEvidencePack,
  AiResearchRunResult,
  AiResearchTask,
  AiResearchTaskStep,
  AiStreamStartResult,
  AiStreamEvent,
  AiSummaryPayload,
  AiSummaryResult,
  AiSynthesisResult,
  AiSynthesisTemplate,
  AiTaskOptions,
  AiTaskType,
  AiTagSuggestion,
  BatchAutoExtractResult,
  BatchCreateResult,
  BatchItemStatus,
  BatchJob,
  BatchOcrOptions,
  BatchQueueItem,
  BatchStartResult,
  BackupImportResult,
  BackupResult,
  BackupStatus,
  BatchProgressEvent,
  BackgroundTaskProgressEvent,
  BookTranslationOptions,
  BookTranslationProgressEvent,
  BookTranslationStartResult,
  DatabaseMaintenanceResult,
  DatabaseStorageDiagnostics,
  ActiveTranslationGlossaryPayload,
  AppPathName,
  AppUpdateInfo,
  CitationGenerateOptions,
  CitationStyle,
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
  BulkAssociationResult,
  CompletedPdfAssetCleanupResult,
  Document,
  DocumentAppendPagePayload,
  DocumentAppendPagesOptions,
  DocumentDetail,
  DocumentExportBatchResult,
  DocumentExportFormat,
  DocumentExportOptions,
  DocumentLightDetail,
  Folder,
  FolderContentResult,
  FolderContentOptions,
  FolderCreatePayload,
  FolderDocumentMovePayload,
  FolderImportFile,
  FolderMovePayload,
  FolderOverviewResult,
  FolderUpdatePayload,
  DocumentHealthReport,
  DocumentHealthReportOptions,
  DocumentListItem,
  DocumentListPage,
  DocumentMetadataResult,
  DocumentPage,
  DocumentReadingWindow,
  DocumentUpdatePayload,
  ImportDocumentResult,
  ImportDocumentOptions,
  ImportProgressEvent,
  InitializePdfPagesOptions,
  PdfInfoResult,
  LibraryImportQueueState,
  LibraryAiScope,
  LibraryAiScopePreview,
  LibraryAiSearchResponse,
  LibraryStateCache,
  ListDocumentOptions,
  ListModelsPayload,
  LocalPaddleOcrDownloadOptions,
  LocalPaddleOcrDownloadProgress,
  LocalPaddleOcrSource,
  LocalPaddleOcrStatus,
  LlmProviderProfile,
  LlmProviderProfileState,
  LlmProviderProfilesResult,
  MetadataReclassificationProgressEvent,
  MetadataTagBindingCleanupResult,
  MetadataCandidate,
  OcrEngine,
  OcrProgressEvent,
  OcrRegionRerecognitionOptions,
  OcrRegionRerecognitionResult,
  OcrRecognizeMode,
  OcrRecognizeResult,
  OnboardingStep,
  PageOcrOptions,
  PageOcrVersion,
  PageUpdatePayload,
  PageTranslationCacheItem,
  PageTranslationCachePayload,
  PageTranslationRequest,
  PageTranslationProgressEvent,
  PageTranslationResult,
  PdfAssetCleanupResult,
  PdfAssetRestoreResult,
  PdfRepositoryIndexResult,
  PdfRepositoryStatus,
  ReadStatus,
  ReaderState,
  ReaderStateSavePayload,
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
  ResearchReferenceExportFormat,
  ResearchProjectExportOptions,
  ResearchProjectExportResult,
  ResearchProjectPayload,
  ResearchProjectUpdatePayload,
  ResearchDashboardStats,
  ResolvedImportSource,
  SavedSearch,
  SavedSearchPayload,
  SavedSearchRunResult,
  SaveSearchExcerptsOptions,
  SaveSearchExcerptsResult,
  SearchExportPreviewResult,
  SearchExportResult,
  SearchDocumentHitPage,
  SearchGroupedResponse,
  SearchIndexStatus,
  SearchOptions,
  SearchReindexAllResult,
  SearchReindexDocumentResult,
  SearchResult,
  SearchSessionState,
  SettingSetResult,
  SettingsMap,
  ActiveTranslationGlossaryResult,
  Tag,
  TagCreatePayload,
  TagUpdatePayload,
  TaskProgressEvent,
  TranslationUnitUpdatePayload,
  TranslationUnitV1,
  TocItemSource,
  TocItemV2,
  TranslationGlossaryListOptions,
  TranslationGlossaryTerm,
  TranslationGlossaryTermPayload,
  TypesetAnnotationItem,
  TypesetCompileResult,
  TypesetEnvironmentStatus,
  TypesetMetadata,
  TypesetTemplate,
  CompactAutoBackupResult,
} from '../shared/types'

type IpcUnsubscribe = () => void

const api = {
  readFileBuffer: (filePath: string): Promise<ArrayBuffer> =>
    ipcRenderer.invoke('fs:readFileBuffer', filePath),
  readImageAsDataURL: (filePath: string): Promise<string> =>
    ipcRenderer.invoke('fs:readImageAsDataURL', filePath),
  readRemoteImageAsDataURL: (imageUrl: string): Promise<string> =>
    ipcRenderer.invoke('fs:readRemoteImageAsDataURL', imageUrl),
  saveDocumentPages: (docId: string, base64Images: string[]): Promise<boolean> =>
    ipcRenderer.invoke('documents:savePages', docId, base64Images),
  appendDocumentPages: (docId: string, pages: DocumentAppendPagePayload[], options?: DocumentAppendPagesOptions): Promise<boolean> =>
    ipcRenderer.invoke('documents:appendPages', docId, pages, options),
  initializePdfPages: (docId: string, pageCount: number, options?: InitializePdfPagesOptions): Promise<boolean> =>
    ipcRenderer.invoke('documents:initializePdfPages', docId, pageCount, options),
  getPdfInfo: (filePath: string): Promise<PdfInfoResult> =>
    ipcRenderer.invoke('documents:getPdfInfo', filePath),
  cachePageImage: (docId: string, pageNum: number, dataUrl: string): Promise<string> =>
    ipcRenderer.invoke('documents:cachePageImage', docId, pageNum, dataUrl),
  cleanupPdfAssets: (docId: string): Promise<PdfAssetCleanupResult> =>
    ipcRenderer.invoke('documents:cleanupPdfAssets', docId),
  cleanupCompletedPdfAssets: (): Promise<CompletedPdfAssetCleanupResult> =>
    ipcRenderer.invoke('documents:cleanupCompletedPdfAssets'),
  selectPdfRepositoryFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('pdfRepository:selectFolder'),
  listPdfRepositories: (): Promise<PdfRepositoryStatus> =>
    ipcRenderer.invoke('pdfRepository:list'),
  setPdfRepositoryPaths: (paths: string[]): Promise<PdfRepositoryStatus> =>
    ipcRenderer.invoke('pdfRepository:setPaths', paths),
  indexPdfRepositories: (paths?: string[]): Promise<PdfRepositoryIndexResult> =>
    ipcRenderer.invoke('pdfRepository:index', paths),
  restorePdfForDocument: (docId: string, manualPath?: string): Promise<PdfAssetRestoreResult> =>
    ipcRenderer.invoke('pdfRepository:restoreForDocument', docId, manualPath),

  openFileDialog: (): Promise<string[]> =>
    ipcRenderer.invoke('dialog:openFiles'),
  getPathForFile: (file: File): string =>
    webUtils.getPathForFile(file),
  resolveImportSources: (paths: string[]): Promise<ResolvedImportSource[]> =>
    ipcRenderer.invoke('documents:resolveImportSources', paths),

  importDocuments: (filePaths: string[], options?: ImportDocumentOptions): Promise<ImportDocumentResult[]> =>
    ipcRenderer.invoke('documents:import', filePaths, options),
  getImportQueueState: (): Promise<LibraryImportQueueState | null> =>
    ipcRenderer.invoke('documents:getImportQueueState'),
  saveImportQueueState: (state: LibraryImportQueueState | null): Promise<LibraryImportQueueState | null> =>
    ipcRenderer.invoke('documents:saveImportQueueState', state),
  clearImportQueueState: (): Promise<boolean> =>
    ipcRenderer.invoke('documents:clearImportQueueState'),

  listDocuments: (options?: ListDocumentOptions): Promise<DocumentListItem[]> =>
    ipcRenderer.invoke('documents:list', options),

  listDocumentsPage: (options?: ListDocumentOptions): Promise<DocumentListPage> =>
    ipcRenderer.invoke('documents:listPage', options),

  getDocumentHealthReport: (options?: DocumentHealthReportOptions): Promise<DocumentHealthReport> =>
    ipcRenderer.invoke('documents:getHealthReport', options),
  getLibraryStateCache: (): Promise<LibraryStateCache> =>
    ipcRenderer.invoke('library:getStateCache'),
  refreshLibraryStateCache: (): Promise<LibraryStateCache> =>
    ipcRenderer.invoke('library:refreshStateCache'),
  markLibraryStateCacheDirty: (): Promise<LibraryStateCache> =>
    ipcRenderer.invoke('library:markStateCacheDirty'),

  getDocument: (id: string): Promise<DocumentDetail | null> =>
    ipcRenderer.invoke('documents:get', id),
  getDocumentLight: (id: string): Promise<DocumentLightDetail | null> =>
    ipcRenderer.invoke('documents:getLight', id),
  getDocumentPagesRange: (docId: string, startPageNum: number, endPageNum: number): Promise<DocumentPage[]> =>
    ipcRenderer.invoke('documents:getPagesRange', docId, startPageNum, endPageNum),
  getDocumentSearchPages: (docId: string): Promise<DocumentPage[]> =>
    ipcRenderer.invoke('documents:getSearchPages', docId),
  getDocumentReadingWindow: (docId: string, pageIndex?: number, radius?: number): Promise<DocumentReadingWindow | null> =>
    ipcRenderer.invoke('documents:getReadingWindow', docId, pageIndex, radius),

  updateDocument: (id: string, data: DocumentUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('documents:update', id, data),
  toggleFavorite: (id: string, nextValue?: boolean): Promise<boolean> =>
    ipcRenderer.invoke('documents:toggleFavorite', id, nextValue),
  setReadStatus: (id: string, readStatus: ReadStatus): Promise<boolean> =>
    ipcRenderer.invoke('documents:setReadStatus', id, readStatus),
  setRating: (id: string, rating: number | null): Promise<boolean> =>
    ipcRenderer.invoke('documents:setRating', id, rating),
  getReaderState: (docId: string): Promise<ReaderState | null> =>
    ipcRenderer.invoke('reader:getState', docId),
  saveReaderState: (docId: string, state: ReaderStateSavePayload): Promise<boolean> =>
    ipcRenderer.invoke('reader:saveState', docId, state),
  getAiLayoutCache: (docId: string, pageIds: string[], mode?: AiLayoutMode): Promise<AiLayoutCacheItem[]> =>
    ipcRenderer.invoke('reader:getAiLayoutCache', docId, pageIds, mode),
  runAiLayoutPage: (docId: string, pageId: string, mode: AiLayoutMode, text: string, sourceHash: string): Promise<AiLayoutCacheItem | null> =>
    ipcRenderer.invoke('reader:runAiLayoutPage', docId, pageId, mode, text, sourceHash),
  getTranslationCache: (docId: string, pageIds: string[]): Promise<PageTranslationCacheItem[]> =>
    ipcRenderer.invoke('reader:getTranslationCache', docId, pageIds),
  saveTranslationCache: (docId: string, pageId: string, payload: PageTranslationCachePayload): Promise<PageTranslationCacheItem | null> =>
    ipcRenderer.invoke('reader:saveTranslationCache', docId, pageId, payload),
  getPageTranslationUnits: (pageId: string): Promise<TranslationUnitV1[]> =>
    ipcRenderer.invoke('translation:getPageUnits', pageId),
  getPagesTranslationUnits: (pageIds: string[]): Promise<Record<string, TranslationUnitV1[]>> =>
    ipcRenderer.invoke('translation:getPagesUnits', pageIds),
  translatePageUnits: (request: PageTranslationRequest): Promise<PageTranslationResult> =>
    ipcRenderer.invoke('translation:translatePage', request),
  updateTranslationUnit: (unitId: string, payload: TranslationUnitUpdatePayload): Promise<TranslationUnitV1 | null> =>
    ipcRenderer.invoke('translation:updateUnit', unitId, payload),
  clearMachineTranslationUnits: (docId: string, pageId?: string): Promise<number> =>
    ipcRenderer.invoke('translation:clearMachine', docId, pageId),
  cancelTranslationTask: (taskId: string): Promise<boolean> =>
    ipcRenderer.invoke('translation:cancelTask', taskId),
  onPageTranslationProgress: (callback: (event: PageTranslationProgressEvent) => void): IpcUnsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PageTranslationProgressEvent) => callback(payload)
    ipcRenderer.on('translation:pageProgress', listener)
    return () => ipcRenderer.removeListener('translation:pageProgress', listener)
  },
  translateBook: (docId: string, options?: BookTranslationOptions): Promise<BookTranslationStartResult> =>
    ipcRenderer.invoke('documents:translateBook', docId, options),
  getDocumentToc: (docId: string): Promise<TocItemV2[]> =>
    ipcRenderer.invoke('toc:getDocument', docId),
  saveDocumentToc: (docId: string, items: TocItemV2[], source?: TocItemSource): Promise<TocItemV2[]> =>
    ipcRenderer.invoke('toc:saveDocument', docId, items, source),
  rebuildRuleToc: (docId: string): Promise<TocItemV2[]> =>
    ipcRenderer.invoke('toc:rebuildRule', docId),
  runAiToc: (docId: string): Promise<TocItemV2[]> =>
    ipcRenderer.invoke('toc:runAi', docId),

  updatePage: (pageId: string, data: PageUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('pages:update', pageId, data),

  resetPageOcr: (pageId: string): Promise<boolean> =>
    ipcRenderer.invoke('pages:resetOcr', pageId),
  rerunPageOcr: (pageId: string, options?: PageOcrOptions): Promise<boolean> =>
    ipcRenderer.invoke('pages:rerunOcr', pageId, options),
  rerecognizeLowQualityOcrBlocks: (
    pageId: string,
    options?: OcrRegionRerecognitionOptions,
  ): Promise<OcrRegionRerecognitionResult> =>
    ipcRenderer.invoke('pages:rerecognizeLowQualityBlocks', pageId, options),
  rerunPageVisionOcr: (pageId: string): Promise<boolean> =>
    ipcRenderer.invoke('pages:rerunVisionOcr', pageId),
  enhanceGujiPage: (pageId: string, options?: PageOcrOptions): Promise<boolean> =>
    ipcRenderer.invoke('pages:enhanceGuji', pageId, options),
  rerunPageLayout: (pageId: string, options?: PageOcrOptions): Promise<boolean> =>
    ipcRenderer.invoke('pages:rerunLayout', pageId, options),
  listPageOcrVersions: (pageId: string): Promise<PageOcrVersion[]> =>
    ipcRenderer.invoke('pages:listOcrVersions', pageId),
  switchPageOcrVersion: (pageId: string, engine: string): Promise<boolean> =>
    ipcRenderer.invoke('pages:switchOcrVersion', pageId, engine),

  deleteDocument: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('documents:delete', id),
  deleteDocumentsBatch: (ids: string[]): Promise<{ deletedIds: string[]; failedIds: string[]; successCount: number }> =>
    ipcRenderer.invoke('documents:deleteBatch', ids),
  deleteZeroPageDocuments: (): Promise<{ deletedIds: string[]; failedIds: string[]; successCount: number }> =>
    ipcRenderer.invoke('documents:deleteZeroPage'),

  checkOcrToken: (): Promise<boolean> =>
    ipcRenderer.invoke('ocr:checkToken'),
  checkVisionOcrConfig: (): Promise<boolean> =>
    ipcRenderer.invoke('ocr:checkVisionConfig'),
  recognizeImage: (base64Image: string, mode?: OcrRecognizeMode): Promise<OcrRecognizeResult> =>
    ipcRenderer.invoke('ocr:recognize', base64Image, mode),
  cancelOcr: (docId: string): Promise<boolean> =>
    ipcRenderer.invoke('ocr:cancelDocument', docId),
  batchOcr: (docIds: string[], options?: BatchOcrOptions): Promise<number> =>
    ipcRenderer.invoke('documents:batchOcr', docIds, options),
  reprocessOcrStructure: (docId: string): Promise<number> =>
    ipcRenderer.invoke('documents:reprocessOcrStructure', docId),

  classifyDocument: (ocrText: string): Promise<string> =>
    ipcRenderer.invoke('ai:classify', ocrText),
  extractMetadata: (ocrText: string, docType: string): Promise<DocumentMetadataResult> =>
    ipcRenderer.invoke('ai:extractMetadata', ocrText, docType),
  extractMetadataStaged: (docId: string): Promise<DocumentMetadataResult> =>
    ipcRenderer.invoke('ai:extractMetadataStaged', docId),
  autoExtract: (docId: string): Promise<DocumentMetadataResult> =>
    ipcRenderer.invoke('ai:autoExtract', docId),
  batchAutoExtract: (docIds: string[]): Promise<BatchAutoExtractResult> =>
    ipcRenderer.invoke('ai:batchAutoExtract', docIds),
  getMetadataCandidates: (docId: string): Promise<MetadataCandidate[]> =>
    ipcRenderer.invoke('ai:getMetadataCandidates', docId),
  acceptMetadataCandidate: (candidateId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:acceptMetadataCandidate', candidateId),
  rejectMetadataCandidate: (candidateId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:rejectMetadataCandidate', candidateId),
  suggestTags: (docId: string): Promise<AiTagSuggestion[]> =>
    ipcRenderer.invoke('ai:suggestTags', docId),
  runAiTask: (docId: string, taskType: AiTaskType, text: string, options?: AiTaskOptions): Promise<string> =>
    ipcRenderer.invoke('ai:runTask', docId, taskType, text, options),
  askDocumentAi: (docId: string, question: string, options?: AiQuestionOptions): Promise<AiQuestionResponse> =>
    ipcRenderer.invoke('ai:askDocument', docId, question, options),
  askDocumentAiStream: (docId: string, question: string, options?: AiQuestionOptions): Promise<AiStreamStartResult> => {
    const requestId = String(options?.requestId || `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return ipcRenderer.invoke('ai:askDocumentStream', requestId, docId, question, options)
  },
  getAiResults: (docId: string): Promise<AiResult[]> =>
    ipcRenderer.invoke('ai:getResults', docId),
  previewAiScope: (scope: LibraryAiScope): Promise<LibraryAiScopePreview> =>
    ipcRenderer.invoke('ai:previewScope', scope),
  runScopedLibraryAi: (question: string, scope: LibraryAiScope, options?: AiQuestionOptions): Promise<AiQuestionResponse> =>
    ipcRenderer.invoke('ai:libraryAsk', question, scope, options),
  runScopedLibraryAiStream: (question: string, scope: LibraryAiScope, options?: AiQuestionOptions): Promise<AiStreamStartResult> => {
    const requestId = String(options?.requestId || `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return ipcRenderer.invoke('ai:libraryAskStream', requestId, question, scope, options)
  },
  summarizeSelection: (payload: AiSummaryPayload): Promise<AiSummaryResult> =>
    ipcRenderer.invoke('ai:summarizeSelection', payload),
  synthesizeDocuments: (docIds: string[], templateType: AiSynthesisTemplate, customPrompt?: string): Promise<AiSynthesisResult> =>
    ipcRenderer.invoke('ai:synthesize', docIds, templateType, customPrompt),
  listAiChatSessions: (payload: AiChatSessionListPayload): Promise<AiChatSession[]> =>
    ipcRenderer.invoke('ai:chatSessions:list', payload),
  createAiChatSession: (payload: AiChatSessionCreatePayload): Promise<AiChatSession> =>
    ipcRenderer.invoke('ai:chatSessions:create', payload),
  getAiChatTurns: (sessionId: string): Promise<AiChatTurn[]> =>
    ipcRenderer.invoke('ai:chatSessions:getTurns', sessionId),
  getAiChatTurnsPage: (sessionId: string, beforeCreatedAt?: string, limit?: number): Promise<AiChatTurn[]> =>
    ipcRenderer.invoke('ai:chatSessions:getTurnsPage', sessionId, beforeCreatedAt, limit),
  deleteAiChatSession: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('ai:chatSessions:delete', sessionId),
  planAiResearchTask: (payload: AiResearchPlanPayload): Promise<AiResearchPlan> =>
    ipcRenderer.invoke('aiResearch:planTask', payload),
  createAiResearchTask: (payload: AiResearchCreateTaskPayload): Promise<AiResearchTask> =>
    ipcRenderer.invoke('aiResearch:createTask', payload),
  runAiResearchTask: (taskId: string): Promise<AiResearchRunResult> =>
    ipcRenderer.invoke('aiResearch:runTask', taskId),
  previewAiResearchRetrieval: (payload: AiResearchRetrievalPreviewPayload): Promise<AiResearchRetrievalStats> =>
    ipcRenderer.invoke('aiResearch:previewRetrieval', payload),
  runAiResearchRetrieval: (taskId: string): Promise<AiResearchRetrievalRunResult> =>
    ipcRenderer.invoke('aiResearch:runRetrieval', taskId),
  getAiResearchRetrievalStats: (taskId: string): Promise<AiResearchRetrievalStats | null> =>
    ipcRenderer.invoke('aiResearch:getRetrievalStats', taskId),
  getAiResearchEvidencePack: (taskId: string): Promise<AiResearchEvidencePack | null> =>
    ipcRenderer.invoke('aiResearch:getEvidencePack', taskId),
  listAiResearchTasks: (projectId?: string | null): Promise<AiResearchTask[]> =>
    ipcRenderer.invoke('aiResearch:listTasks', projectId),
  getAiResearchTask: (taskId: string): Promise<AiResearchTask> =>
    ipcRenderer.invoke('aiResearch:getTask', taskId),
  listAiResearchTaskSteps: (taskId: string): Promise<AiResearchTaskStep[]> =>
    ipcRenderer.invoke('aiResearch:listTaskSteps', taskId),
  listAiResearchDatasets: (projectId?: string | null): Promise<AiResearchDataset[]> =>
    ipcRenderer.invoke('aiResearch:listDatasets', projectId),
  listAiResearchRecords: (datasetId: string, options?: AiResearchRecordListOptions): Promise<AiResearchRecord[]> =>
    ipcRenderer.invoke('aiResearch:listRecords', datasetId, options),
  updateAiResearchRecord: (recordId: string, payload: AiResearchRecordUpdatePayload): Promise<AiResearchRecord> =>
    ipcRenderer.invoke('aiResearch:updateRecord', recordId, payload),
  excludeAiResearchRecord: (recordId: string): Promise<AiResearchRecord> =>
    ipcRenderer.invoke('aiResearch:excludeRecord', recordId),
  generateAiResearchReport: (payload: AiResearchReportPayload): Promise<{ content: string; outputId: string | null }> =>
    ipcRenderer.invoke('aiResearch:generateReport', payload),
  exportAiResearchDataset: (datasetId: string, format?: 'csv' | 'markdown' | 'json'): Promise<AiResearchExportResult> =>
    ipcRenderer.invoke('aiResearch:exportDataset', datasetId, format),

  listFolders: (): Promise<Folder[]> => ipcRenderer.invoke('folders:list'),
  getFolderOverview: (): Promise<FolderOverviewResult> => ipcRenderer.invoke('folders:getOverview'),
  getFolderContent: (options?: FolderContentOptions | string | null): Promise<FolderContentResult> =>
    ipcRenderer.invoke('folders:getContent', options),
  getFolder: (id: string): Promise<Folder | null> => ipcRenderer.invoke('folders:get', id),
  createFolder: (data: FolderCreatePayload): Promise<Folder | null> =>
    ipcRenderer.invoke('folders:create', data),
  updateFolder: (id: string, data: FolderUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('folders:update', id, data),
  moveFolder: (data: FolderMovePayload): Promise<Folder[]> =>
    ipcRenderer.invoke('folders:move', data),
  moveDocumentsToFolder: (data: FolderDocumentMovePayload): Promise<BulkAssociationResult> =>
    ipcRenderer.invoke('folders:moveDocuments', data),
  deleteFolder: (id: string): Promise<boolean> => ipcRenderer.invoke('folders:delete', id),
  addDocumentToFolder: (docId: string, folderId: string): Promise<boolean> =>
    ipcRenderer.invoke('folders:addDocument', docId, folderId),
  addDocumentsToFolder: (docIds: string[], folderId: string): Promise<BulkAssociationResult> =>
    ipcRenderer.invoke('folders:addDocuments', docIds, folderId),
  removeDocumentFromFolder: (docId: string, folderId: string): Promise<boolean> =>
    ipcRenderer.invoke('folders:removeDocument', docId, folderId),
  getFolderDocuments: (folderId: string): Promise<Document[]> =>
    ipcRenderer.invoke('folders:getDocuments', folderId),
  scanExternalFolder: (folderId: string): Promise<FolderImportFile[]> =>
    ipcRenderer.invoke('folders:scanExternal', folderId),
  selectExternalFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('folders:selectExternal'),
  scanFolderPath: (dirPath: string): Promise<FolderImportFile[]> =>
    ipcRenderer.invoke('folders:scanPath', dirPath),

  listTags: (search?: string): Promise<Tag[]> => ipcRenderer.invoke('tags:list', search),
  createTag: (data: TagCreatePayload): Promise<Tag | null> =>
    ipcRenderer.invoke('tags:create', data),
  updateTag: (id: string, data: TagUpdatePayload): Promise<Tag | null> =>
    ipcRenderer.invoke('tags:update', id, data),
  deleteTag: (id: string): Promise<boolean> => ipcRenderer.invoke('tags:delete', id),
  addDocumentTag: (docId: string, tagId: string): Promise<boolean> =>
    ipcRenderer.invoke('tags:addDocument', docId, tagId),
  addDocumentTags: (docIds: string[], tagIds: string[]): Promise<BulkAssociationResult> =>
    ipcRenderer.invoke('tags:addDocuments', docIds, tagIds),
  removeDocumentTag: (docId: string, tagId: string): Promise<boolean> =>
    ipcRenderer.invoke('tags:removeDocument', docId, tagId),
  clearMetadataTagBindings: (): Promise<MetadataTagBindingCleanupResult> =>
    ipcRenderer.invoke('tags:clearMetadataBindings'),

  createBatch: (docIds: string[], batchSize?: number): Promise<BatchCreateResult> =>
    ipcRenderer.invoke('batch:create', docIds, batchSize),
  startBatch: (docIds: string[], batchSize?: number): Promise<BatchStartResult> =>
    ipcRenderer.invoke('batch:start', docIds, batchSize),
  pauseBatch: (jobId: string): Promise<boolean> => ipcRenderer.invoke('batch:pause', jobId),
  resumeBatch: (jobId: string): Promise<boolean> => ipcRenderer.invoke('batch:resume', jobId),
  cancelBatch: (jobId: string): Promise<boolean> => ipcRenderer.invoke('batch:cancel', jobId),
  getBatchJob: (jobId: string): Promise<BatchJob | null> => ipcRenderer.invoke('batch:getJob', jobId),
  isBatchProcessing: (): Promise<boolean> => ipcRenderer.invoke('batch:isProcessing'),
  listBatches: (): Promise<BatchQueueItem[]> => ipcRenderer.invoke('batch:list'),
  getBatchByBatchId: (batchId: string): Promise<BatchQueueItem[]> =>
    ipcRenderer.invoke('batch:getByBatchId', batchId),
  updateBatchStatus: (id: string, status: BatchItemStatus, errorMessage?: string): Promise<boolean> =>
    ipcRenderer.invoke('batch:updateStatus', id, status, errorMessage),
  clearCompletedBatches: (): Promise<boolean> => ipcRenderer.invoke('batch:clearCompleted'),

  fulltextSearch: (keyword: string, options?: SearchOptions): Promise<SearchResult[]> =>
    ipcRenderer.invoke('search:fulltext', keyword, options),
  querySearchV2: (keyword: string, options?: SearchOptions): Promise<SearchGroupedResponse> =>
    ipcRenderer.invoke('search:queryV2', keyword, options),
  exportSearchExcerpts: (keyword: string, options?: SearchOptions): Promise<SearchExportResult> =>
    ipcRenderer.invoke('search:exportExcerpts', keyword, options),
  previewSearchExportExcerpts: (keyword: string, options?: SearchOptions): Promise<SearchExportPreviewResult> =>
    ipcRenderer.invoke('search:previewExportExcerpts', keyword, options),
  exportSearchDiagnostics: (keyword: string, options?: SearchOptions): Promise<SearchExportResult> =>
    ipcRenderer.invoke('search:exportDiagnostics', keyword, options),
  saveSearchExcerpts: (keyword: string, options?: SaveSearchExcerptsOptions): Promise<SaveSearchExcerptsResult> =>
    ipcRenderer.invoke('search:saveExcerpts', keyword, options),
  getDocumentSearchHits: (docId: string, keyword: string, options?: SearchOptions): Promise<SearchSessionState> =>
    ipcRenderer.invoke('search:getDocumentHits', docId, keyword, options),
  getDocumentSearchHitPage: (docId: string, keyword: string, options?: SearchOptions): Promise<SearchDocumentHitPage> =>
    ipcRenderer.invoke('search:getDocumentHitPage', docId, keyword, options),
  reindexDocumentSearch: (docId: string): Promise<SearchReindexDocumentResult> =>
    ipcRenderer.invoke('search:reindexDocument', docId),
  reindexAllSearch: (): Promise<SearchReindexAllResult> =>
    ipcRenderer.invoke('search:reindexAll'),
  rebuildLightweightSearchIndex: (): Promise<DatabaseMaintenanceResult> =>
    ipcRenderer.invoke('search:rebuildLightweightIndex'),
  getSearchIndexStatus: (docId?: string): Promise<SearchIndexStatus[]> =>
    ipcRenderer.invoke('search:getIndexStatus', docId),
  semanticSearch: (keyword: string, options?: SearchOptions): Promise<SearchResult[]> =>
    ipcRenderer.invoke('search:semantic', keyword, options),
  aiSearch: (prompt: string, options?: SearchOptions): Promise<AiPlannedSearchResponse> =>
    ipcRenderer.invoke('search:aiPlanned', prompt, options),
  saveSearch: (name: string, filters: SavedSearchPayload): Promise<SavedSearch | null> =>
    ipcRenderer.invoke('search:save', name, filters),
  listSavedSearches: (): Promise<SavedSearch[]> =>
    ipcRenderer.invoke('search:listSaved'),
  deleteSavedSearch: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('search:deleteSaved', id),
  runSavedSearch: (id: string): Promise<SavedSearchRunResult> =>
    ipcRenderer.invoke('search:runSaved', id),
  runLibraryAiSearch: (question: string, options?: SearchOptions): Promise<LibraryAiSearchResponse> =>
    ipcRenderer.invoke('search:aiLibrary', question, options),

  listCitationTemplates: (): Promise<CitationTemplate[]> => ipcRenderer.invoke('citation:listTemplates'),
  listCitationStyles: (): Promise<CitationStyle[]> => ipcRenderer.invoke('citation:listStyles'),
  createCitationStyle: (data: CitationStylePayload): Promise<CitationStyle> =>
    ipcRenderer.invoke('citation:createStyle', data),
  updateCitationStyle: (id: string, data: CitationStyleUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('citation:updateStyle', id, data),
  deleteCitationStyle: (id: string): Promise<boolean> => ipcRenderer.invoke('citation:deleteStyle', id),
  getCitationTemplate: (id: string): Promise<CitationTemplate | null> => ipcRenderer.invoke('citation:getTemplate', id),
  createCitationTemplate: (data: CitationTemplatePayload): Promise<CitationTemplate> =>
    ipcRenderer.invoke('citation:createTemplate', data),
  updateCitationTemplate: (id: string, data: CitationTemplateUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('citation:updateTemplate', id, data),
  deleteCitationTemplate: (id: string): Promise<boolean> => ipcRenderer.invoke('citation:deleteTemplate', id),
  generateCitation: (docId: string, templateId: string, options?: CitationGenerateOptions): Promise<string> =>
    ipcRenderer.invoke('citation:generate', docId, templateId, options),
  generateCitationByStyle: (
    docId: string,
    styleId: string,
    docType?: string,
    options?: CitationGenerateOptions,
  ): Promise<string> =>
    ipcRenderer.invoke('citation:generateByStyle', docId, styleId, docType, options),
  generateBatchCitation: (docIds: string[], templateId: string): Promise<string[]> =>
    ipcRenderer.invoke('citation:generateBatch', docIds, templateId),
  inferCitationTemplateFromSample: (sampleText: string, preferredFormatType?: string): Promise<CitationTemplateInference> =>
    ipcRenderer.invoke('citation:inferTemplateFromSample', sampleText, preferredFormatType),
  selectCitationRuleFile: (): Promise<string | null> =>
    ipcRenderer.invoke('citation:selectRuleFile'),
  inferCitationStyleFromRuleFile: (filePath: string): Promise<CitationStyleDraftWithRaw> =>
    ipcRenderer.invoke('citation:inferStyleFromRuleFile', filePath),
  createCitationStyleFromDraft: (
    draft: CitationStyleDraft,
    options?: CitationStyleDraftOptions,
  ): Promise<CitationStyle> =>
    ipcRenderer.invoke('citation:createStyleFromDraft', draft, options),

  listResearchProjects: (): Promise<ResearchProject[]> => ipcRenderer.invoke('research:listProjects'),
  createResearchProject: (data: ResearchProjectPayload): Promise<ResearchProject> =>
    ipcRenderer.invoke('research:createProject', data),
  updateResearchProject: (id: string, data: ResearchProjectUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('research:updateProject', id, data),
  deleteResearchProject: (id: string): Promise<boolean> => ipcRenderer.invoke('research:deleteProject', id),
  addResearchProjectDocuments: (projectId: string, docIds: string[]): Promise<boolean> =>
    ipcRenderer.invoke('research:addDocuments', projectId, docIds),
  removeResearchProjectDocument: (projectId: string, docId: string): Promise<boolean> =>
    ipcRenderer.invoke('research:removeDocument', projectId, docId),
  listResearchProjectDocuments: (projectId: string): Promise<Document[]> =>
    ipcRenderer.invoke('research:listProjectDocuments', projectId),
  listResearchOutline: (projectId: string): Promise<ResearchOutlineItem[]> =>
    ipcRenderer.invoke('research:listOutline', projectId),
  createResearchOutlineItem: (data: ResearchOutlinePayload): Promise<ResearchOutlineItem> =>
    ipcRenderer.invoke('research:createOutlineItem', data),
  updateResearchOutlineItem: (id: string, data: ResearchOutlineUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('research:updateOutlineItem', id, data),
  deleteResearchOutlineItem: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('research:deleteOutlineItem', id),
  moveResearchOutlineItem: (id: string, parentId: string | null, sortOrder: number): Promise<boolean> =>
    ipcRenderer.invoke('research:moveOutlineItem', id, parentId, sortOrder),
  createResearchNote: (data: ResearchNotePayload): Promise<ResearchNote> =>
    ipcRenderer.invoke('research:createNote', data),
  updateResearchNote: (id: string, data: ResearchNoteUpdatePayload): Promise<boolean> =>
    ipcRenderer.invoke('research:updateNote', id, data),
  assignResearchNotesToOutline: (noteIds: string[], outlineId: string | null): Promise<boolean> =>
    ipcRenderer.invoke('research:assignNotesToOutline', noteIds, outlineId),
  listResearchNotes: (projectId?: string | null): Promise<ResearchNote[]> =>
    ipcRenderer.invoke('research:listNotes', projectId),
  deleteResearchNote: (id: string): Promise<boolean> => ipcRenderer.invoke('research:deleteNote', id),
  synthesizeResearchProject: (projectId: string, templateType: AiSynthesisTemplate, customPrompt?: string, citationStyleId?: string): Promise<ResearchOutput> =>
    ipcRenderer.invoke('research:synthesizeProject', projectId, templateType, customPrompt, citationStyleId),
  createResearchOutput: (payload: ResearchOutputPayload): Promise<ResearchOutput> =>
    ipcRenderer.invoke('research:createOutput', payload),
  listResearchOutputs: (projectId: string): Promise<ResearchOutput[]> =>
    ipcRenderer.invoke('research:listOutputs', projectId),
  getResearchOutputContent: (outputId: string): Promise<string> =>
    ipcRenderer.invoke('research:getOutputContent', outputId),
  exportResearchReferences: (projectId: string, format: ResearchReferenceExportFormat, citationStyleId?: string): Promise<string> =>
    ipcRenderer.invoke('research:exportReferences', projectId, format, citationStyleId),
  exportResearchProject: (projectId: string, options: ResearchProjectExportOptions): Promise<ResearchProjectExportResult> =>
    ipcRenderer.invoke('research:exportProject', projectId, options),
  getResearchDashboard: (): Promise<ResearchDashboardStats> => ipcRenderer.invoke('research:getDashboard'),

  getOnboardingProgress: (): Promise<OnboardingStep | null> => ipcRenderer.invoke('onboarding:getProgress'),
  getOnboardingStep: (stepKey: string): Promise<OnboardingStep | null> => ipcRenderer.invoke('onboarding:getStep', stepKey),
  completeOnboardingStep: (stepKey: string): Promise<boolean> => ipcRenderer.invoke('onboarding:completeStep', stepKey),
  isOnboardingCompleted: (): Promise<boolean> => ipcRenderer.invoke('onboarding:isCompleted'),
  resetOnboarding: (): Promise<boolean> => ipcRenderer.invoke('onboarding:reset'),

  exportDocument: (docId: string, format: DocumentExportFormat, options?: DocumentExportOptions): Promise<boolean> =>
    ipcRenderer.invoke('documents:export', docId, format, options),
  exportDocumentsBatch: (docIds: string[], format: DocumentExportFormat, options?: DocumentExportOptions): Promise<DocumentExportBatchResult> =>
    ipcRenderer.invoke('documents:exportBatch', docIds, format, options),

  getSetting: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: string): Promise<SettingSetResult> =>
    ipcRenderer.invoke('settings:set', key, value),
  getAllSettings: (): Promise<SettingsMap> =>
    ipcRenderer.invoke('settings:getAll'),
  listModels: (baseUrl: string, apiKey: string): Promise<string[]> => {
    const payload: ListModelsPayload = { baseUrl, apiKey }
    return ipcRenderer.invoke('settings:listModels', payload)
  },
  listPaddleOcrModels: (apiKey?: string): Promise<string[]> =>
    ipcRenderer.invoke('settings:listPaddleOcrModels', apiKey),
  getLocalPaddleOcrStatus: (): Promise<LocalPaddleOcrStatus> =>
    ipcRenderer.invoke('settings:getLocalPaddleOcrStatus'),
  checkLocalPaddleOcrSources: (): Promise<LocalPaddleOcrSource[]> =>
    ipcRenderer.invoke('settings:checkLocalPaddleOcrSources'),
  downloadLocalPaddleOcr: (options?: LocalPaddleOcrDownloadOptions): Promise<LocalPaddleOcrStatus> =>
    ipcRenderer.invoke('settings:downloadLocalPaddleOcr', options),
  installLocalPaddleOcrRuntime: (): Promise<LocalPaddleOcrStatus> =>
    ipcRenderer.invoke('settings:installLocalPaddleOcrRuntime'),
  importLocalPaddleOcrAddon: (filePath?: string): Promise<LocalPaddleOcrStatus> =>
    ipcRenderer.invoke('settings:importLocalPaddleOcrAddon', filePath),
  setDefaultOcrEngine: (engine: OcrEngine, providerId?: string): Promise<SettingsMap> =>
    ipcRenderer.invoke('settings:setDefaultOcrEngine', engine, providerId),
  listLlmProviderProfiles: (): Promise<LlmProviderProfileState> =>
    ipcRenderer.invoke('settings:llmProfiles:list'),
  saveCurrentLlmProviderProfile: (name?: string): Promise<LlmProviderProfileState> =>
    ipcRenderer.invoke('settings:llmProfiles:saveCurrent', name),
  upsertLlmProviderProfile: (profile: LlmProviderProfile): Promise<LlmProviderProfilesResult> =>
    ipcRenderer.invoke('settings:llmProfiles:upsert', profile),
  switchLlmProviderProfile: (profileId: string): Promise<LlmProviderProfileState> =>
    ipcRenderer.invoke('settings:llmProfiles:switch', profileId),
  deleteLlmProviderProfile: (profileId: string): Promise<LlmProviderProfilesResult> =>
    ipcRenderer.invoke('settings:llmProfiles:delete', profileId),
  listVisionOcrProviderProfiles: (): Promise<LlmProviderProfileState> =>
    ipcRenderer.invoke('settings:visionOcrProfiles:list'),
  upsertVisionOcrProviderProfile: (profile: LlmProviderProfile): Promise<LlmProviderProfilesResult> =>
    ipcRenderer.invoke('settings:visionOcrProfiles:upsert', profile),
  switchVisionOcrProviderProfile: (profileId: string): Promise<LlmProviderProfileState> =>
    ipcRenderer.invoke('settings:visionOcrProfiles:switch', profileId),
  deleteVisionOcrProviderProfile: (profileId: string): Promise<LlmProviderProfilesResult> =>
    ipcRenderer.invoke('settings:visionOcrProfiles:delete', profileId),

  listTranslationGlossaryTerms: (payload?: TranslationGlossaryListOptions): Promise<TranslationGlossaryTerm[]> =>
    ipcRenderer.invoke('glossary:listTerms', payload),
  upsertTranslationGlossaryTerm: (payload: TranslationGlossaryTermPayload): Promise<TranslationGlossaryTerm> =>
    ipcRenderer.invoke('glossary:upsertTerm', payload),
  deleteTranslationGlossaryTerm: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('glossary:deleteTerm', id),
  getActiveTranslationGlossary: (payload: ActiveTranslationGlossaryPayload): Promise<ActiveTranslationGlossaryResult> =>
    ipcRenderer.invoke('glossary:getActiveTerms', payload),
  getTranslationGlossaryVersionSignature: (projectId?: string | null): Promise<string> =>
    ipcRenderer.invoke('glossary:getVersionSignature', projectId),

  createBackup: (): Promise<BackupResult> => ipcRenderer.invoke('backup:create'),
  importBackup: (): Promise<BackupImportResult> => ipcRenderer.invoke('backup:import'),
  importBackupFromPath: (filePath: string): Promise<BackupImportResult> =>
    ipcRenderer.invoke('backup:importFromPath', filePath),
  restoreBackup: (): Promise<BackupImportResult> => ipcRenderer.invoke('backup:restore'),
  getBackupStatus: (): Promise<BackupStatus> => ipcRenderer.invoke('backup:getStatus'),
  configureAutoBackup: (enabled: boolean, intervalHours: number, includeStorage?: boolean, slotCount?: number): Promise<BackupStatus> =>
    ipcRenderer.invoke('backup:configureAuto', enabled, intervalHours, includeStorage, slotCount),
  runAutoBackupNow: (): Promise<BackupResult> => ipcRenderer.invoke('backup:runAutoNow'),
  compactAutoBackups: (): Promise<CompactAutoBackupResult> => ipcRenderer.invoke('backup:compactAuto'),
  openDataDirectory: (): Promise<boolean> => ipcRenderer.invoke('backup:openDataDirectory'),
  openAutoBackupDirectory: (): Promise<boolean> => ipcRenderer.invoke('backup:openAutoBackupDirectory'),
  exportDocumentList: (): Promise<BackupResult> => ipcRenderer.invoke('backup:exportDocumentList'),
  getDatabaseStorageDiagnostics: (): Promise<DatabaseStorageDiagnostics> =>
    ipcRenderer.invoke('database:getStorageDiagnostics'),
  exportDatabaseStorageDiagnostics: (): Promise<DatabaseMaintenanceResult> =>
    ipcRenderer.invoke('database:exportStorageDiagnostics'),
  compactDatabase: (): Promise<DatabaseMaintenanceResult> =>
    ipcRenderer.invoke('database:compact'),
  clearLegacySearchIndex: (): Promise<DatabaseMaintenanceResult> =>
    ipcRenderer.invoke('database:clearLegacySearchIndex'),
  optimizeLegacyDatabase: (): Promise<DatabaseMaintenanceResult> =>
    ipcRenderer.invoke('database:optimizeLegacyDatabase'),
  externalizePagePayloads: (): Promise<DatabaseMaintenanceResult> =>
    ipcRenderer.invoke('database:externalizePagePayloads'),
  cleanupExternalPayloads: (): Promise<DatabaseMaintenanceResult> =>
    ipcRenderer.invoke('database:cleanupExternalPayloads'),

  getVersion: (): Promise<string> =>
    ipcRenderer.invoke('app:getVersion'),
  checkForUpdates: (): Promise<AppUpdateInfo> =>
    ipcRenderer.invoke('app:checkForUpdates'),
  getPath: (name: AppPathName): Promise<string> =>
    ipcRenderer.invoke('app:getPath', name),
  quitApp: (): Promise<boolean> =>
    ipcRenderer.invoke('app:quit'),

  typesetCheckEnv: (): Promise<TypesetEnvironmentStatus> =>
    ipcRenderer.invoke('typeset:checkEnv'),
  typesetGenerateTeX: (annotations: TypesetAnnotationItem[], template: TypesetTemplate, metadata?: TypesetMetadata): Promise<string> =>
    ipcRenderer.invoke('typeset:generateTeX', annotations, template, metadata),
  typesetCompile: (docId: string, texContent: string): Promise<TypesetCompileResult> =>
    ipcRenderer.invoke('typeset:compile', docId, texContent),
  typesetReadPdf: (pdfPath: string): Promise<ArrayBuffer | null> =>
    ipcRenderer.invoke('typeset:readPdf', pdfPath),

  onProgress: (callback: (data: TaskProgressEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: TaskProgressEvent) => callback(data)
    ipcRenderer.on('task:progress', handler)
    return () => {
      ipcRenderer.removeListener('task:progress', handler)
    }
  },
  onImportProgress: (callback: (data: ImportProgressEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: ImportProgressEvent) => callback(data)
    ipcRenderer.on('documents:importProgress', handler)
    return () => {
      ipcRenderer.removeListener('documents:importProgress', handler)
    }
  },
  onOcrStatusChanged: (callback: (data: OcrProgressEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: OcrProgressEvent) => callback(data)
    ipcRenderer.on('ocr:statusChanged', handler)
    return () => {
      ipcRenderer.removeListener('ocr:statusChanged', handler)
    }
  },
  onLocalPaddleOcrDownloadProgress: (callback: (data: LocalPaddleOcrDownloadProgress) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: LocalPaddleOcrDownloadProgress) => callback(data)
    ipcRenderer.on('settings:localPaddleOcrDownloadProgress', handler)
    return () => {
      ipcRenderer.removeListener('settings:localPaddleOcrDownloadProgress', handler)
    }
  },
  onBackgroundTaskStatusChanged: (callback: (data: BackgroundTaskProgressEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: BackgroundTaskProgressEvent) => callback(data)
    ipcRenderer.on('background:taskStatusChanged', handler)
    return () => {
      ipcRenderer.removeListener('background:taskStatusChanged', handler)
    }
  },
  onBookTranslationProgress: (callback: (data: BookTranslationProgressEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: BookTranslationProgressEvent) => callback(data)
    ipcRenderer.on('documents:bookTranslationProgress', handler)
    return () => {
      ipcRenderer.removeListener('documents:bookTranslationProgress', handler)
    }
  },
  onBatchProgress: (callback: (data: BatchProgressEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: BatchProgressEvent) => callback(data)
    ipcRenderer.on('batch:progress', handler)
    return () => {
      ipcRenderer.removeListener('batch:progress', handler)
    }
  },
  onMetadataReclassificationProgress: (callback: (data: MetadataReclassificationProgressEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: MetadataReclassificationProgressEvent) => callback(data)
    ipcRenderer.on('metadata:reclassificationProgress', handler)
    return () => {
      ipcRenderer.removeListener('metadata:reclassificationProgress', handler)
    }
  },
  onAiStreamEvent: (callback: (event: AiStreamEvent) => void): IpcUnsubscribe => {
    const handler = (_event: Electron.IpcRendererEvent, data: AiStreamEvent) => callback(data)
    ipcRenderer.on('ai:streamEvent', handler)
    return () => {
      ipcRenderer.removeListener('ai:streamEvent', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ApiType = typeof api

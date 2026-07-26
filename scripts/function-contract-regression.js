const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const rootDir = path.resolve(__dirname, '..')
const preloadPath = path.join(rootDir, 'src', 'preload', 'index.ts')
const minimumPreloadApiCount = 250

const requiredApiGroups = {
  filesAndImport: [
    'selectImportSources',
    'grantDroppedImportSources',
    'readImportSelectionBatch',
    'importDocuments',
    'initializePdfPages',
    'cachePageImage',
    'getPdfInfo',
    'readFileBuffer',
    'readImageAsDataURL',
    'readRemoteImageAsDataURL',
  ],
  library: [
    'listDocuments',
    'listDocumentsPage',
    'listLibraryProjects',
    'getActiveLibraryProject',
    'createLibraryProject',
    'setActiveLibraryProject',
    'addDocumentsToLibraryProject',
    'moveDocumentsToLibraryProject',
    'copyDocumentsToLibraryProject',
    'getDocumentHealthReport',
    'getLibraryStateCache',
    'refreshLibraryStateCache',
    'getDocument',
    'getDocumentLight',
    'updateDocument',
    'toggleFavorite',
    'setReadStatus',
    'setRating',
    'deleteDocument',
    'deleteDocumentsBatch',
    'deleteZeroPageDocuments',
    'exportDocument',
    'exportDocumentsBatch',
  ],
  pdfRepository: [
    'cleanupPdfAssets',
    'cleanupCompletedPdfAssets',
    'selectAndAddPdfRepository',
    'listPdfRepositories',
    'removePdfRepository',
    'indexPdfRepositories',
    'restorePdfForDocument',
    'selectAndRestorePdfForDocument',
  ],
  ocr: [
    'checkOcrToken',
    'checkVisionOcrConfig',
    'recognizeImage',
    'cancelOcr',
    'cancelAllPendingOcr',
    'batchOcr',
    'reprocessOcrStructure',
    'resetPageOcr',
    'rerunPageOcr',
    'rerecognizeLowQualityOcrBlocks',
    'rerunPageVisionOcr',
    'enhanceGujiPage',
    'rerunPageLayout',
    'listPageOcrVersions',
    'switchPageOcrVersion',
    'onOcrStatusChanged',
  ],
  readerAndTranslation: [
    'getDocumentPagesRange',
    'getDocumentSearchPages',
    'getDocumentReadingWindow',
    'getReaderState',
    'saveReaderState',
    'getAiLayoutCache',
    'runAiLayoutPage',
    'getTranslationCache',
    'saveTranslationCache',
    'getPageTranslationUnits',
    'getPagesTranslationUnits',
    'translatePageUnits',
    'updateTranslationUnit',
    'listTranslationRevisions',
    'getTranslationContextSnapshot',
    'clearMachineTranslationUnits',
    'cancelTranslationTask',
    'onPageTranslationProgress',
    'translateBook',
    'onBookTranslationProgress',
  ],
  tocAndPageEditing: [
    'getDocumentToc',
    'saveDocumentToc',
    'rebuildRuleToc',
    'runAiToc',
    'updatePage',
    'saveDocumentPages',
    'appendDocumentPages',
  ],
  searchAndEvidence: [
    'fulltextSearch',
    'querySearchV2',
    'validateSearchSnapshot',
    'resolveSearchEvidence',
    'promoteSearchAggregate',
    'validateResearchAggregate',
    'listResearchAggregateRelations',
    'exportSearchExcerpts',
    'previewSearchExportExcerpts',
    'exportSearchDiagnostics',
    'saveSearchExcerpts',
    'getDocumentSearchHits',
    'getDocumentSearchHitPage',
    'reindexDocumentSearch',
    'reindexAllSearch',
    'rebuildLightweightSearchIndex',
    'getSearchIndexStatus',
    'semanticSearch',
    'aiSearch',
    'saveSearch',
    'listSavedSearches',
    'deleteSavedSearch',
    'runSavedSearch',
    'runLibraryAiSearch',
  ],
  ai: [
    'classifyDocument',
    'extractMetadata',
    'extractMetadataStaged',
    'autoExtract',
    'batchAutoExtract',
    'getMetadataCandidates',
    'acceptMetadataCandidate',
    'rejectMetadataCandidate',
    'suggestTags',
    'runAiTask',
    'askDocumentAi',
    'askDocumentAiStream',
    'getAiResults',
    'previewAiScope',
    'runScopedLibraryAi',
    'runScopedLibraryAiStream',
    'summarizeSelection',
    'synthesizeDocuments',
    'listAiChatSessions',
    'createAiChatSession',
    'getAiChatTurns',
    'getAiChatTurnsPage',
    'deleteAiChatSession',
    'onAiStreamEvent',
  ],
  aiResearch: [
    'planAiResearchTask',
    'createAiResearchTask',
    'runAiResearchTask',
    'previewAiResearchRetrieval',
    'runAiResearchRetrieval',
    'getAiResearchRetrievalStats',
    'getAiResearchEvidencePack',
    'listAiResearchTasks',
    'getAiResearchTask',
    'listAiResearchTaskSteps',
    'listAiResearchDatasets',
    'listAiResearchRecords',
    'updateAiResearchRecord',
    'excludeAiResearchRecord',
    'generateAiResearchReport',
    'exportAiResearchDataset',
  ],
  research: [
    'listResearchProjects',
    'createResearchProject',
    'updateResearchProject',
    'deleteResearchProject',
    'addResearchProjectDocuments',
    'removeResearchProjectDocument',
    'listResearchProjectDocuments',
    'listResearchOutline',
    'createResearchOutlineItem',
    'updateResearchOutlineItem',
    'deleteResearchOutlineItem',
    'moveResearchOutlineItem',
    'createResearchNote',
    'updateResearchNote',
    'assignResearchNotesToOutline',
    'listResearchNotes',
    'listResearchNotesPage',
    'listResearchEvidenceRelations',
    'getResearchClaimManifest',
    'validateResearchClaimManifest',
    'finalizeResearchOutputVersion',
    'promoteResearchNoteEvidence',
    'deleteResearchNote',
    'deleteResearchNotes',
    'synthesizeResearchProject',
    'createResearchOutput',
    'listResearchOutputs',
    'getResearchOutputContent',
    'exportResearchReferences',
    'exportResearchProject',
    'getResearchDashboard',
  ],
  foldersAndTags: [
    'listFolders',
    'getFolderOverview',
    'getFolderContent',
    'getFolder',
    'createFolder',
    'updateFolder',
    'moveFolder',
    'moveDocumentsToFolder',
    'deleteFolder',
    'addDocumentToFolder',
    'addDocumentsToFolder',
    'removeDocumentFromFolder',
    'getFolderDocuments',
    'scanExternalFolder',
    'createFolderFromImportSource',
    'listTags',
    'createTag',
    'updateTag',
    'deleteTag',
    'addDocumentTag',
    'addDocumentTags',
    'removeDocumentTag',
    'clearMetadataTagBindings',
  ],
  citationAndTypeset: [
    'listCitationTemplates',
    'listCitationStyles',
    'createCitationStyle',
    'updateCitationStyle',
    'deleteCitationStyle',
    'getCitationTemplate',
    'createCitationTemplate',
    'updateCitationTemplate',
    'deleteCitationTemplate',
    'generateCitation',
    'resolveCitationV2',
    'createCitationSnapshot',
    'validateCitationSnapshot',
    'listCitationSnapshots',
    'generateCitationByStyle',
    'generateBatchCitation',
    'inferCitationTemplateFromSample',
    'selectCitationRuleFile',
    'inferCitationStyleFromRuleFile',
    'createCitationStyleFromDraft',
    'typesetCheckEnv',
    'typesetGenerateTeX',
    'typesetCompile',
    'typesetReadPdf',
  ],
  settingsAndOnboarding: [
    'getSetting',
    'setSetting',
    'getAllSettings',
    'listModels',
    'listPaddleOcrModels',
    'getPaddleOcrTokenPool',
    'addPaddleOcrToken',
    'removePaddleOcrToken',
    'setPaddleOcrTokenEnabled',
    'listLlmProviderProfiles',
    'saveCurrentLlmProviderProfile',
    'upsertLlmProviderProfile',
    'switchLlmProviderProfile',
    'deleteLlmProviderProfile',
    'listVisionOcrProviderProfiles',
    'upsertVisionOcrProviderProfile',
    'switchVisionOcrProviderProfile',
    'deleteVisionOcrProviderProfile',
    'getOnboardingProgress',
    'getOnboardingStep',
    'completeOnboardingStep',
    'isOnboardingCompleted',
    'resetOnboarding',
  ],
  backupAndMaintenance: [
    'createBackup',
    'importBackup',
    'importDroppedBackup',
    'restoreBackup',
    'getBackupStatus',
    'configureAutoBackup',
    'runAutoBackupNow',
    'compactAutoBackups',
    'openDataDirectory',
    'openAutoBackupDirectory',
    'exportDocumentList',
    'getDatabaseStorageDiagnostics',
    'exportDatabaseStorageDiagnostics',
    'compactDatabase',
    'clearLegacySearchIndex',
    'optimizeLegacyDatabase',
    'externalizePagePayloads',
    'cleanupExternalPayloads',
    'onBackgroundTaskStatusChanged',
  ],
  glossaryAndApp: [
    'listTranslationGlossaryTerms',
    'upsertTranslationGlossaryTerm',
    'deleteTranslationGlossaryTerm',
    'getActiveTranslationGlossary',
    'getTranslationGlossaryVersionSignature',
    'getVersion',
    'checkForUpdates',
    'getPath',
    'quitApp',
    'onProgress',
    'onImportProgress',
    'onBatchProgress',
    'onMetadataReclassificationProgress',
  ],
}

function createSourceFile(filePath) {
  return ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function getNameText(nameNode) {
  if (!nameNode) return null
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isNumericLiteral(nameNode)) {
    return nameNode.text
  }
  return null
}

function getLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function collectPreloadApiProps() {
  const sourceFile = createSourceFile(preloadPath)
  const apiProps = new Map()

  function visit(node) {
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(sourceFile) === 'api'
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        const name = getNameText(prop.name)
        if (name) {
          apiProps.set(name, {
            name,
            line: getLine(sourceFile, prop.name),
          })
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return apiProps
}

const apiProps = collectPreloadApiProps()
const missingByGroup = []

for (const [groupName, apiNames] of Object.entries(requiredApiGroups)) {
  const missing = apiNames.filter((name) => !apiProps.has(name))
  if (missing.length > 0) {
    missingByGroup.push({ groupName, missing })
  }
}

if (apiProps.size < minimumPreloadApiCount) {
  console.error(
    `Preload API surface unexpectedly shrank to ${apiProps.size}; expected at least ${minimumPreloadApiCount}.`,
  )
  process.exit(1)
}

if (missingByGroup.length > 0) {
  console.error('Critical functional API regression detected:')
  for (const group of missingByGroup) {
    console.error(`\n${group.groupName}:`)
    for (const name of group.missing) {
      console.error(`- missing window.api.${name}`)
    }
  }
  process.exit(1)
}

const protectedApiCount = new Set(Object.values(requiredApiGroups).flat()).size
console.log(
  `Functional contract OK: ${protectedApiCount} protected APIs present across ${Object.keys(requiredApiGroups).length} groups (${apiProps.size} preload APIs total).`,
)

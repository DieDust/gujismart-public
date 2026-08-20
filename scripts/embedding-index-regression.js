const assert = require('assert')
const { readFileSync, existsSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')

const embedding = read('src', 'main', 'embedding-index.ts')
const vectorSearchContract = read('src', 'shared', 'vector-search.ts')
const database = read('src', 'main', 'database.ts')
const ipc = read('src', 'main', 'ipc', 'embedding.ts')
const searchIpc = read('src', 'main', 'ipc', 'search.ts')
const preload = read('src', 'preload', 'index.ts')
const tools = read('src', 'main', 'mcp', 'library-tools.ts')
const protectedSettings = read('src', 'main', 'protected-settings.ts')
const settingsView = read('src', 'renderer', 'src', 'views', 'SettingsView.tsx')
const libraryView = read('src', 'renderer', 'src', 'views', 'LibraryView.tsx')
const searchView = read('src', 'renderer', 'src', 'views', 'SearchView.tsx')

assert.ok(database.includes('embedding_chunks'), 'schema must define embedding_chunks')
assert.ok(database.includes('embedding_index_status'), 'schema must define embedding_index_status')
assert.ok(embedding.includes('enqueueDocumentsForEmbedding'), 'manual enqueue API')
assert.ok(embedding.includes('isEmbeddingAutoOnIngest'), 'auto-on-ingest flag')
assert.ok(embedding.includes("=== 'true'"), 'auto-on-ingest default must not be always true')
assert.ok(embedding.includes('dashscope.aliyuncs.com'), 'default embedding endpoint should be DashScope/Tongyi')
assert.ok(embedding.includes('text-embedding-v3'), 'default embedding model should be Tongyi text-embedding-v3')
assert.ok(/DEFAULT_BATCH\s*=\s*10/.test(embedding), 'default embedding batch must be <= DashScope limit of 10')
assert.ok(embedding.includes('getProviderBatchCap') || embedding.includes('PROVIDER_BATCH_CAPS'), 'must cap batch size per provider')
assert.ok(embedding.includes('batchSizeCap') && embedding.includes('requeueFailedEmbeddings'), 'batch cap stats + requeue failed')
assert.ok(embedding.includes('DASHSCOPE_EMBEDDING_SPECS') || embedding.includes('text-embedding-v4'), 'official Tongyi model specs')
assert.ok(embedding.includes('EMBEDDING_DIMENSIONS_KEY') || embedding.includes('dimensions'), 'dimensions setting for v3/v4')
assert.ok(embedding.includes('reindexDocumentsForEmbedding') && embedding.includes('force: true'), 'force re-vectorize path')
assert.ok(embedding.includes('reindexAllReadyEmbeddings') && embedding.includes('reindexStaleEmbeddings'), 'bulk reindex helpers')
// Ordinary enqueue must skip ready/in-flight docs (OCR-like policy); only force re-runs ready.
assert.ok(embedding.includes("wasReady || previousStatus === 'queued' || previousStatus === 'processing'"), 'non-force enqueue skips ready/queued/processing')
assert.ok(libraryView.includes('needsEmbeddingWork'), 'library batch vectorize skips completed like OCR')
assert.ok(libraryView.includes('先 OCR') || libraryView.includes('飞桨'), 'library vectorize auto-OCR with paddle')
assert.ok(libraryView.includes('function needsOcrBeforeEmbedding'), 'vectorize has dedicated OCR gate (not full needsOcrWork)')
assert.ok(libraryView.includes('function hasOcrBodyForEmbedding'), 'vectorize treats completed/partial OCR as embeddable')
assert.ok(libraryView.includes('needOcrIds') && libraryView.includes("runOcrInConfiguredBatches(needOcrIds, 'paddle'"), 'vectorize runs paddle OCR before embed when needed')
assert.ok(libraryView.includes('needsOcrBeforeEmbedding(doc)'), 'vectorize only OCRs books with no usable OCR body')
assert.ok(libraryView.includes('hasOcrBodyForEmbedding(doc)'), 'vectorize enqueues docs with completed or partial OCR body')
assert.ok(!libraryView.includes("return doc ? needsOcrWork(doc, 'paddle') : true"), 'vectorize must not reuse needsOcrWork (would re-OCR completed+review books)')
assert.ok(embedding.includes('ensureSearchSegmentsForEmbedding'), 'enqueue rebuilds search segments after OCR when missing')
assert.ok(embedding.includes('documentHasIndexableOcrText'), 'embedding requires OCR body text')
assert.ok(libraryView.includes('重新向量化') && libraryView.includes('覆盖'), 'library exposes explicit re-vectorize action')
assert.ok(embedding.includes('cancelDocumentsForEmbedding') && embedding.includes('cancelAllPendingEmbeddings'), 'cancel queue APIs')
assert.ok(embedding.includes('restoreEmbeddingStatusAfterCancel') || embedding.includes('恢复为已向量化') || embedding.includes("restored === 'ready'"), 'cancel restores ready when chunks remain')
assert.ok(preload.includes('cancelDocumentsForEmbedding') && preload.includes('cancelAllPendingEmbeddings'), 'preload cancel APIs')
assert.ok(ipc.includes('embedding:cancelDocuments') && ipc.includes('embedding:cancelAllPending'), 'embedding cancel IPC')
assert.ok(libraryView.includes('cancel_embedding') && libraryView.includes('停止全部向量化'), 'library UI stop embedding queue (OCR-aligned wording)')
assert.ok(libraryView.includes('停止排队') || libraryView.includes('停止向量化'), 'card progress cancel labels mirror OCR stop style')
assert.ok(settingsView.includes('单次请求批次') || settingsView.includes('embeddingBatchSizeDraft'), 'settings UI exposes batch size')
assert.ok(settingsView.includes('输出维度') || settingsView.includes('embeddingDimensionsDraft'), 'settings UI exposes dimensions')
assert.ok(settingsView.includes('重试失败') || settingsView.includes('requeueFailed'), 'settings UI can requeue failed embeddings')
assert.ok(settingsView.includes('全部重新向量化') || settingsView.includes('reindexAllReady'), 'settings UI reindex all')
assert.ok(settingsView.includes('重建过期') || settingsView.includes('reindexStale'), 'settings UI reindex stale')
assert.ok(libraryView.includes('revectorize') || libraryView.includes('重新向量化'), 'library batch re-vectorize')
assert.ok(preload.includes('requeueFailedEmbeddings'), 'preload requeue API')
assert.ok(preload.includes('reindexDocumentsForEmbedding') && preload.includes('reindexAllReadyEmbeddings'), 'preload reindex APIs')
assert.ok(ipc.includes('embedding:requeueFailed'), 'embedding requeue IPC')
assert.ok(ipc.includes('embedding:reindexDocuments') && ipc.includes('embedding:reindexStale'), 'embedding reindex IPC')
assert.ok(!embedding.includes("DEFAULT_MODEL = 'text-embedding-3-small'"), 'must not default to OpenAI small without Tongyi')
assert.ok(embedding.includes('vectorSearch'), 'vectorSearch service')
assert.ok(
  /VECTOR_SEARCH_DEFAULT_LIMIT\s*=\s*200/.test(vectorSearchContract),
  'desktop vector search should default to 200 hits',
)
const vectorSearchMaxMatch = vectorSearchContract.match(/VECTOR_SEARCH_MAX_LIMIT\s*=\s*([\d_]+)/)
assert.ok(
  vectorSearchMaxMatch && Number(vectorSearchMaxMatch[1].replace(/_/g, '')) > 200,
  '200 must be a default rather than the hard vector-search maximum',
)
assert.ok(
  embedding.includes('bestHeap')
    && embedding.includes('siftHeapDown')
    && embedding.includes('rowid > ?')
    && embedding.includes('segmentsByDocumentAndId'),
  'large Top-K search should use a bounded heap, keyset scan, and batched metadata hydration',
)
assert.ok(
  embedding.includes('HOST_IS_LITTLE_ENDIAN') && embedding.includes('new Float32Array(buf.buffer'),
  'embedding blob decode must use the typed-array fast path instead of per-element readFloatLE',
)
assert.ok(
  embedding.includes('invalidateVectorSearchCache')
    && embedding.includes('VECTOR_SCAN_CACHE_MAX_BYTES')
    && embedding.includes('VECTOR_SCAN_CACHE_TTL_MS'),
  'vector search must keep a bounded, TTL-guarded in-memory scan cache with an explicit invalidation API',
)
assert.ok(
  embedding.includes('SCOPED_VECTOR_SCAN_MAX_DOCS') && embedding.includes('ec.doc_id IN ('),
  'folder/tag-scoped vector search should fetch by indexed doc_id instead of scanning the whole table',
)
const documentsIpc = read('src', 'main', 'ipc', 'documents.ts')
assert.ok(
  (documentsIpc.match(/invalidateVectorSearchCache\(\)/g) || []).length >= 3,
  'document delete and manual page insert/delete must invalidate the vector scan cache',
)
assert.ok(
  searchView.includes('检索前召回')
    && searchView.includes('VECTOR_SEARCH_DEFAULT_LIMIT')
    && searchView.includes('VECTOR_SEARCH_MAX_LIMIT')
    && searchView.includes('exportPreviewExpanded'),
  'renderer should choose vector hit count before search and keep export preview collapsed on demand',
)
assert.ok(
  !searchView.includes('limit: VECTOR_SEARCH_UI_LIMIT')
    && !searchView.includes('EXPORT_MAX_RECORDS_PRESETS')
    && !searchView.includes('VECTOR_EXPORT_SCORE_PRESETS'),
  'renderer must not retain the old fixed-200 request or the cluttered export preset rows',
)
assert.ok(
  searchIpc.includes('recordBuildLimit')
    && searchIpc.includes('buildLiteraturePageCache')
    && searchIpc.includes('await writeFile(outputFilePath'),
  'vector export preview should build only samples and bulk export should avoid page-number N+1/sync writes',
)
assert.ok(!searchIpc.includes('HARD_FULLTEXT_EXPORT_MAX = 1000'), 'full-text export must not use the legacy 1,000-record cap')
assert.ok(embedding.includes('/embeddings'), 'OpenAI-compatible embeddings endpoint')
assert.ok(settingsView.includes('linkedProfiles') || settingsView.includes('handleSelectEmbeddingSourceProfile'), 'settings reuses AI provider list')
assert.ok(settingsView.includes('fetchEmbeddingModelOptions') || settingsView.includes('listEmbeddingModels'), 'settings can fetch embedding models')
assert.ok(embedding.includes('embedding_source_profile_id') || embedding.includes('EMBEDDING_SOURCE_PROFILE'), 'embedding links AI profile for keys')
assert.ok(ipc.includes('embedding:listModels'), 'embedding listModels IPC')
assert.ok(ipc.includes('embedding:getStats') && ipc.includes('embedding:enqueueDocuments'), 'embedding IPC')
assert.ok(preload.includes('enqueueDocumentsForEmbedding') && preload.includes('vectorSearch'), 'preload embedding APIs')
assert.ok(tools.includes("name: 'vector_search'") && tools.includes("name: 'vector_index_stats'"), 'MCP tools')
assert.ok(protectedSettings.includes('embedding_api_key'), 'embedding key is protected')
assert.ok(settingsView.includes('向量索引') && settingsView.includes('入库后自动向量化'), 'settings UI')
assert.ok(libraryView.includes('vectorize') && libraryView.includes('批量向量化'), 'library batch vectorize')

console.log('Embedding index regression checks passed.')

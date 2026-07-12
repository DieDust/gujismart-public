const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function assertIncludes(source, needle, label) {
  if (!source.includes(needle)) throw new Error(`${label}: missing ${needle}`)
}

function assertNotIncludes(source, needle, label) {
  if (source.includes(needle)) throw new Error(`${label}: unexpected ${needle}`)
}

const types = read('src/shared/types.ts')
const translationSource = read('src/shared/translation-source.ts')
const units = read('src/shared/translation-units.ts')
const service = read('src/main/translation-service.ts')
const revisions = read('src/main/translation-revisions.ts')
const documents = read('src/main/ipc/documents.ts')
const documentView = read('src/renderer/src/views/DocumentView.tsx')
const parallelView = read('src/renderer/src/components/ParallelTranslationView.tsx')
const facsimile = read('src/renderer/src/components/GujiFacsimileProofreader.tsx')
const database = read('src/main/database.ts')
const semanticSearch = read('src/main/semantic-search.ts')
const searchWorker = read('src/main/search-index-worker.ts')
const searchView = read('src/renderer/src/views/SearchView.tsx')
const packageJson = JSON.parse(read('package.json'))

assertIncludes(types, "export type TranslationMode = 'fast' | 'balanced' | 'quality'", 'shared types should expose three translation modes')
assertIncludes(types, 'export interface TranslationUnitV1', 'shared types should expose block translation units')
assertIncludes(types, 'manualOverride: boolean', 'translation units should protect manual edits')
assertIncludes(types, 'translationScope?: TranslationSearchScope', 'search options should expose source/translation scope')

assertIncludes(units, 'getStableBlockId', 'translation units should derive a stable OCR block identifier')
assertIncludes(units, 'manual_reading_order', 'translation order should follow manual reading order')
assertIncludes(units, 'protectTranslationText', 'translation units should protect inline formulas and code')
assertIncludes(units, '__GS_PH_', 'translation placeholders should be local and stable')
assertIncludes(units, 'shouldSkipTranslationBlock', 'non-body blocks should be excluded from model requests')
assertNotIncludes(units, '${page.id}|${blockId}|${sourceText}', 'translation unit IDs should not be based directly on editable source text')

assertIncludes(translationSource, 'function getLayoutOcrBlocks', 'translation source should keep coordinate-bearing OCR layout blocks')
assertIncludes(translationSource, 'if (layoutBlocks.length > 0) return layoutBlocks', 'translation source should prefer layout blocks before merged IR reading blocks')

assertIncludes(database, 'CREATE TABLE IF NOT EXISTS page_translation_units', 'database should store translations per OCR block')
assertIncludes(database, 'UNIQUE(page_id, unit_id, target_language)', 'translation units should be unique per page and language')

assertIncludes(service, 'chunkTranslationUnits', 'oversized pages should split only at consecutive OCR block boundaries')
assertIncludes(service, 'formatTranslationUnitInput', 'page requests should use stable unit markers')
assertIncludes(service, 'firstPass.invalidIds.length', 'only invalid units should enter the retry path')
assertIncludes(service, 'commitMachineTranslationAttempt', 'automatic saves should use revision CAS')
assertIncludes(revisions, "active.id === attempt.base_revision_id", 'machine commit should compare the active revision')
assertIncludes(revisions, 'unit.source_hash === snapshot.unit_source_hash', 'machine commit should compare the frozen source')
assertIncludes(revisions, "committed ? 'active' : 'detached'", 'conflicting machine results should remain detached candidates')
assertNotIncludes(service, "SET translation_text = CASE WHEN ? <> '' THEN ? ELSE translation_text END", 'automatic saves must not directly overwrite translation projections')
assertIncludes(service, 'normalizeDigitsForComparison', 'translation number checks should tolerate date and superscript formatting')
assertIncludes(service, 'unit_id NOT IN', 'translation unit refresh should delete stale machine-generated OCR unit rows')
assertIncludes(service, "? 'stale'", 'source edits should preserve and mark old translations stale')
assertIncludes(service, "unit.manualOverride || (!unit.skipped && unit.status === 'ready' && !unit.stale", 'legacy cache migration should not be blocked by skipped units or stale translations')
assertIncludes(service, "mode === 'quality'", 'quality mode should run a page review pass')
assertIncludes(service, 'TRANSLATION_RETRY_DELAYS_MS', 'rate limits should use exponential-style backoff')
assertIncludes(service, 'translation:pageProgress', 'completed page batches should stream progress to the renderer')
assertIncludes(service, 'cancelTranslationTask', 'translation service should expose task cancellation')

assertIncludes(documentView, 'window.api.translatePageUnits', 'reader translation should call the unified main-process service')
assertIncludes(documentView, 'onPageTranslationProgress', 'reader should display completed translation batches progressively')
assertIncludes(documentView, 'function isReadyTranslationUnit', 'reader cache reuse should validate translation unit state')
assertIncludes(documentView, "unit.status === 'ready' && !unit.stale", 'reader cache reuse should reject stale or failed unit translations')
assertIncludes(documentView, 'getReadyTranslationTextFromUnits(unitsByPage[pageId] || [])', 'translation mode should restore saved unit translations without retranslation')
assertIncludes(documentView, 'setPageTranslationUnits((current) => ({ ...current, ...unitsByPage }))', 'freshly loaded translation units should replace stale renderer state')
assertNotIncludes(documentView, 'parallelAlignmentRepair: true', 'renderer should not run whole-batch alignment repair')
assertNotIncludes(documentView, 'buildParallelTranslationInputFromSegments([segment]', 'renderer should not fall back to sentence-by-sentence translation')
assertIncludes(parallelView, 'units?: TranslationUnitV1[]', 'parallel reader should render OCR block translation units')
assertIncludes(parallelView, 'function getDisplayTranslationForUnit', 'parallel reader should filter unusable translation unit text')
assertIncludes(parallelView, "unit.status !== 'ready' || unit.stale", 'parallel reader should not display stale or failed unit translations as ready text')
assertIncludes(parallelView, '人工译文', 'parallel reader should label manual translations')
assertIncludes(parallelView, '原文已变化', 'parallel reader should expose stale translations')

assertIncludes(facsimile, 'buildFacsimileTranslationOverlaysFromUnits', 'facsimile should map translations directly by OCR block unit')
assertIncludes(facsimile, 'function isUsableTranslationUnit', 'facsimile translation should validate unit state before overlaying text')
assertIncludes(facsimile, 'if (!isUsableTranslationUnit(unit)) return []', 'facsimile translation should not overlay stale or failed unit translations')
assertIncludes(facsimile, 'const shouldUseOverlayTranslation = translationOpen && translatedSourceIndexes.has(sourceIndex) && !isImage', 'facsimile translation should replace original block text in place')
assertIncludes(facsimile, 'translationOpen && translationOverlayLayouts.map', 'facsimile translation should render overlays on the original restored page')
assertNotIncludes(facsimile, 'data-facsimile-translation-page="true"', 'facsimile translation should not render a separate translation page')

assertIncludes(documents, 'async function runLegacyBookTranslationJob', 'legacy translator should no longer be the active book job')
assertIncludes(documents, 'await translatePageUnits({', 'book translation should reuse the unified page service')
assertIncludes(documents, "mode === 'fast' ? 4 : mode === 'quality' ? 1 : 2", 'book translation should use mode-specific concurrency')
assertIncludes(documents, '!result.complete || result.failedCount > 0', 'book translation should report partial completion when page units fail')
assertIncludes(documents, 'ensurePageTranslationUnits(pageId)', 'legacy translation cache saves should migrate into block translation units')

assertIncludes(semanticSearch, "sourceKind: 'translation'", 'main search index should add translation segments')
assertIncludes(searchWorker, "sourceKind: 'translation'", 'worker search index should add translation segments')
assertIncludes(semanticSearch, "AND status = 'ready'", 'main search index should include only ready translation units')
assertIncludes(semanticSearch, 'AND stale = 0', 'main search index should exclude stale translation units')
assertIncludes(semanticSearch, 'AND skipped = 0', 'main search index should not index skipped source text as translation')
assertIncludes(searchWorker, "AND status = 'ready'", 'worker search index should include only ready translation units')
assertIncludes(searchWorker, 'AND stale = 0', 'worker search index should exclude stale translation units')
assertIncludes(searchWorker, 'AND skipped = 0', 'worker search index should not index skipped source text as translation')
assertIncludes(semanticSearch, "s.source_kind = 'translation'", 'search should support translation-only queries')
assertIncludes(searchView, '仅译文', 'search UI should expose translation scope')
assertIncludes(searchView, 'hit.locator.translationSource', 'search results should label translation hits')

assertIncludes(packageJson.scripts['check:translation-pipeline'] || '', 'scripts/translation-units-regression.js', 'package.json should expose translation regression checks')
assertIncludes(packageJson.scripts.check || '', 'npm run check:translation-pipeline', 'aggregate checks should include translation pipeline checks')

console.log('Translation unit pipeline regression checks passed')

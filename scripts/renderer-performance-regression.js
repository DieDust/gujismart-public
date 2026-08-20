const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gujismart-renderer-performance-'))

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')
}

function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle)
  if (start < 0) throw new Error(`${label}: missing start ${startNeedle}`)
  const end = source.indexOf(endNeedle, start + startNeedle.length)
  if (end < 0) throw new Error(`${label}: missing end ${endNeedle}`)
  return source.slice(start, end)
}

try {
  const storeBundle = path.join(tempRoot, 'document-store.cjs')
  buildSync({
    entryPoints: [path.join(root, 'src/renderer/src/stores/useDocumentStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: storeBundle,
    logLevel: 'silent',
  })

  const { useDocumentStore } = require(storeBundle)

  const retentionBundle = path.join(tempRoot, 'document-page-retention.cjs')
  buildSync({
    entryPoints: [path.join(root, 'src/renderer/src/utils/documentPageRetention.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: retentionBundle,
    logLevel: 'silent',
  })
  const { isDocumentPagePayloadHydrated, retainDocumentPagePayloadWindow } = require(retentionBundle)

  if (isDocumentPagePayloadHydrated(undefined) || isDocumentPagePayloadHydrated({ __light: true })) {
    throw new Error('lightweight reader pages are incorrectly treated as hydrated')
  }
  if (!isDocumentPagePayloadHydrated({ __full: true })) {
    throw new Error('full reader pages are not recognized as hydrated')
  }

  const searchNavigationBundle = path.join(tempRoot, 'reader-search-navigation.cjs')
  buildSync({
    entryPoints: [path.join(root, 'src/renderer/src/utils/readerSearchNavigation.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: searchNavigationBundle,
    logLevel: 'silent',
  })
  const {
    findFirstSearchHitAtOrAfterPage,
    findSearchOccurrenceContainer,
    sortSearchIndexesByReadingOrder,
  } = require(searchNavigationBundle)
  const pageAnchoredHits = [{ pageIndex: 0 }, { pageIndex: 0 }, { pageIndex: 2 }, { pageIndex: 2 }, { pageIndex: 4 }]
  if (findFirstSearchHitAtOrAfterPage(pageAnchoredHits, 2) !== 2) {
    throw new Error('new reader searches do not start at the first hit on the current page')
  }
  if (findFirstSearchHitAtOrAfterPage(pageAnchoredHits, 3) !== 4) {
    throw new Error('new reader searches do not continue from the next page when the current page has no hit')
  }
  if (findFirstSearchHitAtOrAfterPage(pageAnchoredHits, 6) !== 0) {
    throw new Error('new reader searches do not wrap to the beginning after the final page')
  }
  const facsimileTarget = findSearchOccurrenceContainer(['罗马与希腊', '农业罗马罗马经济', '结语'], '罗马', 2)
  if (facsimileTarget?.containerIndex !== 1 || facsimileTarget?.occurrenceIndex !== 1) {
    throw new Error('facsimile search cannot map a page occurrence to the correct block and in-block highlight')
  }
  const readingOrder = sortSearchIndexesByReadingOrder([
    { pageIndex: 6, elementOrder: 8, charIndex: 20 },
    { pageIndex: 6, elementOrder: 1, charIndex: 15 },
    { pageIndex: 6, elementOrder: 1, charIndex: 4 },
    { pageIndex: 7, elementOrder: 0, charIndex: 0 },
  ])
  if (readingOrder.join(',') !== '2,1,0,3') {
    throw new Error(`reader search does not follow rendered body-before-footnote order: ${readingOrder.join(',')}`)
  }
  const pagePayloads = Array.from({ length: 1_000 }, (_unused, index) => ({
    id: `page-${index}`,
    doc_id: 'doc-large',
    page_num: index + 1,
    image_path: `page-${index}.jpg`,
    ocr_text: `text-${index}`.repeat(1_000),
    ocr_result: JSON.stringify({ blocks: [{ text: `block-${index}`.repeat(1_000) }] }),
    proofed_text: index % 2 === 0 ? `proof-${index}` : null,
    ocr_status: 'completed',
    proof_status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    __full: true,
  }))
  const retainedPayloads = retainDocumentPagePayloadWindow(pagePayloads, 500, 12)
  const fullPayloads = retainedPayloads.filter((page) => page.__full)
  const originalPayloadBytes = Buffer.byteLength(JSON.stringify(pagePayloads))
  const retainedPayloadBytes = Buffer.byteLength(JSON.stringify(retainedPayloads))
  if (fullPayloads.length !== 25 || fullPayloads[0].page_num !== 489 || fullPayloads[24].page_num !== 513) {
    throw new Error('reader payload retention did not keep exactly the current 25-page window')
  }
  if (retainedPayloads.some((page, index) => page.id !== pagePayloads[index].id || page.image_path !== pagePayloads[index].image_path)) {
    throw new Error('reader payload retention changed the lightweight page manifest')
  }
  if (retainedPayloads[0].ocr_text !== null || retainedPayloads[0].ocr_result !== null || !retainedPayloads[0].has_text) {
    throw new Error('reader payload retention did not release heavy content while preserving text availability')
  }
  if (retainedPayloadBytes >= originalPayloadBytes * 0.1) {
    throw new Error(`reader payload retention kept too much data (${retainedPayloadBytes}/${originalPayloadBytes} bytes)`)
  }
  const documents = Array.from({ length: 12_000 }, (_unused, index) => ({
    id: `doc-${index}`,
    title: `Document ${index}`,
  }))
  const removedIds = Array.from({ length: 2_000 }, (_unused, index) => `doc-${index * 3}`)
  useDocumentStore.setState({ documents, selectedIds: documents.map((document) => document.id) })

  let notifications = 0
  const unsubscribe = useDocumentStore.subscribe(() => {
    notifications += 1
  })
  const startedAt = performance.now()
  const removeDocumentsFromList = useDocumentStore.getState().removeDocumentsFromList
  if (typeof removeDocumentsFromList !== 'function') {
    throw new Error('document store is missing one-shot bulk removal')
  }
  removeDocumentsFromList(removedIds)
  const elapsedMs = performance.now() - startedAt
  unsubscribe()

  const nextState = useDocumentStore.getState()
  if (notifications !== 1) {
    throw new Error(`bulk document removal emitted ${notifications} store notifications instead of 1`)
  }
  if (nextState.documents.length !== documents.length - removedIds.length) {
    throw new Error('bulk document removal kept an unexpected number of documents')
  }
  if (nextState.selectedIds.length !== documents.length - removedIds.length) {
    throw new Error('bulk document removal did not clear the removed selections')
  }
  if (nextState.documents.some((document) => removedIds.includes(document.id))) {
    throw new Error('bulk document removal left a removed document in the list')
  }

  const libraryView = read('src/renderer/src/views/LibraryView.tsx')
  if (libraryView.includes('result.deletedIds.forEach(removeDocumentFromList)')) {
    throw new Error('LibraryView still removes batch results one document at a time')
  }
  if (!libraryView.includes('removeDocumentsFromList(result.deletedIds)')) {
    throw new Error('LibraryView does not apply batch delete results in one store update')
  }
  if (!libraryView.includes('const applySubmittedDocumentDeletion = useCallback((deletedIds: string[], exitBatchMode: boolean) => {')
    || !libraryView.includes('startTransition(() => {\n        setDocumentTotal(nextDocumentTotal)\n        removeDocumentsFromList(uniqueDeletedIds)')) {
    throw new Error('library deletion still performs a blocking high-priority list rerender')
  }
  if (!libraryView.includes('card.hidden = true')
    || !libraryView.includes('window.requestAnimationFrame(() => {\n      startTransition(() => {')) {
    throw new Error('library deletion does not paint immediate card removal before list reconciliation')
  }
  if (!libraryView.includes('documentsRef.current = nextDocuments')
    || !libraryView.includes('listOffsetRef.current = Math.max(0, listOffsetRef.current - removedLoadedCount)')) {
    throw new Error('library deletion leaves loaded-list references stale and forces a corrective refresh')
  }

  const foldersView = read('src/renderer/src/views/FoldersView.tsx')
  const folderDeleteBody = sliceBetween(
    foldersView,
    'const handleDeleteDocuments = useCallback',
    'const getActionDocIds = useCallback',
    'folder document deletion',
  )
  if (!folderDeleteBody.includes('removeDeletedDocumentsFromFolderContent(result.deletedIds)')) {
    throw new Error('folder deletion still waits for a full folder-content reload before removing cards')
  }
  if (folderDeleteBody.includes('await loadFolderContent(selectedFolderId)')) {
    throw new Error('folder deletion blocks on a full folder-content reload')
  }

  const documentView = read('src/renderer/src/views/DocumentView.tsx')
  const searchMemo = sliceBetween(
    documentView,
    'const searchMatches = useMemo<SearchMatch[]>(() => {',
    'const activeProofSearchHitOrdinal',
    'reader search memo',
  )
  const dependencyStart = searchMemo.lastIndexOf('}, [')
  const dependencyList = dependencyStart >= 0 ? searchMemo.slice(dependencyStart) : ''
  if (!dependencyList) throw new Error('reader search memo dependency list is missing')
  if (/\bcurrentPage\b|\bcurrentPageIndex\b/.test(dependencyList)) {
    throw new Error('reader-mode page flips still invalidate the whole-document search memo')
  }
  if (!searchMemo.includes('proofSearchFallbackPage')) {
    throw new Error('proof-mode current-page search fallback is not isolated from reader-mode paging')
  }
  if (!documentView.includes('retainDocumentPagePayloadWindow(mergedPages, retainedPageIndex, READER_FULL_PAGE_RETENTION_RADIUS)')) {
    throw new Error('reader page windows are still accumulated without a bounded payload retention policy')
  }
  if (!documentView.includes('if (requestId !== pageRangeRequestRef.current) return')) {
    throw new Error('stale reading-window responses can still overwrite the active payload window')
  }
  if (!documentView.includes('const pageRangeInFlightRef = useRef<Map<string, Promise<DocumentPage[]>>>(new Map())')) {
    throw new Error('duplicate reader window requests are not reused in flight')
  }
  if (!documentView.includes('const existingRequest = pageRangeInFlightRef.current.get(requestKey)')) {
    throw new Error('reader window loading does not check for an identical in-flight request')
  }
  if (!documentView.includes('if (!isDocumentPagePayloadHydrated(sortedPagesRef.current[nextIndex])) {')) {
    throw new Error('source reader navigation still reloads an already-hydrated OCR page')
  }
  if (!documentView.includes('if (!isDocumentPagePayloadHydrated(sortedPages[currentPageIndex])) {')) {
    throw new Error('source reader page effects still reload an already-hydrated OCR page')
  }

  const searchPagesEffect = sliceBetween(
    documentView,
    'const hasReaderSearchQuery = Boolean(localSearchKeyword.trim())',
    'useEffect(() => {\n    if (!doc || readerStateLoadedRef.current',
    'reader search pages effect',
  )
  if (searchPagesEffect.includes('shouldUseSourcePageReader || documentMode === \'proof\'')) {
    throw new Error('source reader still hydrates the whole document just to search')
  }
  if (!searchPagesEffect.includes("const shouldLoadSearchPages = documentMode === 'proof'")) {
    throw new Error('full search-page hydration is not restricted to coordinate-aware proof mode')
  }
  const searchPagesDependencies = searchPagesEffect.slice(searchPagesEffect.lastIndexOf('}, ['))
  if (/\blocalSearchKeyword\b/.test(searchPagesDependencies)) {
    throw new Error('each search keystroke still starts another full-document page hydration')
  }

  const sourcePageReader = read('src/renderer/src/components/SourcePageReader.tsx')
  const ebookReader = read('src/renderer/src/components/EbookReader.tsx')
  const searchView = read('src/renderer/src/views/SearchView.tsx')
  if (sourcePageReader.includes('window.api.getDocumentSearchHits(')) {
    throw new Error('SourcePageReader still duplicates its parent full-document search request')
  }
  if (!sourcePageReader.includes('const MemoizedSourcePageSpread = memo(SourcePageSpread, areSourcePageSpreadPropsEqual)')) {
    throw new Error('OCR/PDF reader spread is not isolated from previous/next search cursor rerenders')
  }
  if (!sourcePageReader.includes('const readablePageElementsCache = new WeakMap<object, ReadablePageElement[]>()')
    || !sourcePageReader.includes('const pageElementRenderOrderCache = new WeakMap<object, Map<number, number>>()')) {
    throw new Error('OCR/PDF search reparses the same page payload for every indexed hit')
  }
  const sourceSpread = sliceBetween(
    sourcePageReader,
    'function SourcePageSpread({',
    'const MemoizedSourcePageSpread = memo(SourcePageSpread, areSourcePageSpreadPropsEqual)',
    'OCR/PDF reader spread',
  )
  if (/activeSearchHit/.test(sourceSpread)) {
    throw new Error('OCR/PDF reader spread still rebuilds all page elements for the active search cursor')
  }
  if (!sourcePageReader.includes('if (isVisible) revealSourceSearchHit(hitIndex)')) {
    throw new Error('OCR/PDF local search still waits for a React commit before revealing the next highlight')
  }
  if (!sourcePageReader.includes('if (isVisible) revealSourceSearchHit(boundedIndex)')) {
    throw new Error('OCR/PDF indexed search still waits for a React commit before revealing the next highlight')
  }
  if (!sourcePageReader.includes('revealSourceSearchHit(visibleSearchHitIndex)')) {
    throw new Error('OCR/PDF reader does not restore the active highlight after rendering a new page spread')
  }
  if (!sourcePageReader.includes('syncSourceSearchNavigation(cursorIndex, allSearchMatches.length)')) {
    throw new Error('OCR/PDF local same-page search still rerenders the entire reader just to update its counter')
  }
  if (!sourcePageReader.includes('syncSourceSearchNavigation(boundedIndex, session.hits.length)')) {
    throw new Error('OCR/PDF indexed same-page search still rerenders the entire reader just to update its counter')
  }
  const sourceSearchInput = sliceBetween(
    sourcePageReader,
    'data-reader-search-input="true"',
    "placeholder={localSearchEngine === 'vector' ? '语义检索' : '页内检索'}",
    'source reader committed search input',
  )
  if (sourceSearchInput.includes('onSearchKeywordChange?.(nextKeyword)')) {
    throw new Error('source reader still starts a full search on every search-input keystroke')
  }
  if (!sourceSearchInput.includes('onPressEnter={() => commitLocalSearch({ force: true })}')
    && !sourceSearchInput.includes('onPressEnter={() => commitLocalSearch()}')) {
    throw new Error('source reader does not require Enter to commit a search')
  }
  const ebookSearchInput = sliceBetween(
    ebookReader,
    'data-reader-search-input="true"',
    'placeholder="搜索文内关键词"',
    'ebook reader committed search input',
  )
  if (ebookSearchInput.includes('onSearchKeywordChange?.(event.target.value)')) {
    throw new Error('ebook reader still starts a full search on every search-input keystroke')
  }
  if (!ebookSearchInput.includes('onPressEnter={commitSearchDraft}')) {
    throw new Error('ebook reader does not require Enter to commit a search')
  }
  if (!(
    /const searchStartPageIndex\s*=\s*documentMode\s*===\s*'proof'\s*\?\s*currentPageIndex\s*:\s*readerVisiblePageIndexRef\.current\s*\?\?\s*currentPageIndex/.test(documentView)
    || documentView.includes("documentMode === 'proof'")
      && documentView.includes('readerVisiblePageIndexRef.current ?? currentPageIndex')
      && documentView.includes('const searchStartPageIndex')
  )) {
    throw new Error('proof search still anchors from the stale reading-mode page instead of the current proof page')
  }
  if (
    !documentView.includes('const DocumentSearchBox = memo(DocumentSearchBoxInner)')
    || !documentView.includes('const [draft, setDraft] = useState(() => draftRef.current)')
  ) {
    throw new Error('document reader search input must keep its draft in a memoized child, separated from the committed query')
  }
  if (!ebookReader.includes('.filter((page) => page.text || page.sourcePage?.has_text || page.sourcePage?.has_ocr_text)')) {
    throw new Error('lightweight text pages can still shift reader search locator indexes')
  }
  const activeTextHitReveal = sliceBetween(
    ebookReader,
    'if (!activeTextHit || isEpub) return',
    'if (!pendingReaderNoteId || isEpub) return',
    'reader active search-hit reveal',
  )
  if (activeTextHitReveal.includes('setTimeout(') || activeTextHitReveal.includes("behavior: 'smooth'")) {
    throw new Error('reader previous/next search still delays the active highlight with animated scrolling')
  }
  const synchronousTextHitReveal = sliceBetween(
    ebookReader,
    'const revealTextSearchHit = (globalIndex: number): boolean => {',
    '\n\n  useEffect(() => {\n    epubFlatTocRef.current',
    'synchronous reader search-hit reveal',
  )
  if (!synchronousTextHitReveal.includes("behavior: 'auto'")) {
    throw new Error('reader previous/next search does not reveal the active highlight immediately')
  }
  if (!ebookReader.includes('const MemoizedReaderTextContent = memo(function MemoizedReaderTextContent(')) {
    throw new Error('reader Markdown content is not isolated from previous/next search cursor rerenders')
  }
  const memoizedReaderTextContent = sliceBetween(
    ebookReader,
    'const MemoizedReaderTextContent = memo(function MemoizedReaderTextContent(',
    'function makeSnippet(',
    'memoized reader text content',
  )
  if (/activeIndex|searchCursor|activeTextHit/.test(memoizedReaderTextContent)) {
    throw new Error('memoized reader Markdown content still depends on the active search cursor')
  }
  const renderedTextPages = sliceBetween(
    ebookReader,
    'const renderTextPages = () => {',
    '\n  return (',
    'rendered reader text pages',
  )
  if (!renderedTextPages.includes('<MemoizedReaderTextContent')) {
    throw new Error('reader page flips still rebuild Markdown instead of using the cursor-independent memoized content')
  }
  const jumpSearchHandler = sliceBetween(
    ebookReader,
    'const jumpSearch = (direction: 1 | -1) => {',
    'const commitSearchDraft = () => {',
    'reader previous/next search handler',
  )
  const localTextNavigation = jumpSearchHandler.slice(jumpSearchHandler.indexOf('if (!textHits.length) return'))
  if (!localTextNavigation.includes('revealTextSearchHit(nextHit.globalIndex)')) {
    throw new Error('reader previous/next search still waits for a React commit before revealing the next highlight')
  }
  if (localTextNavigation.indexOf('revealTextSearchHit(nextHit.globalIndex)') > localTextNavigation.indexOf('setSearchCursor(next)')) {
    throw new Error('reader previous/next search reveals the next highlight only after scheduling the cursor rerender')
  }
  const searchDirectoryMemo = sliceBetween(
    ebookReader,
    'const searchDirectoryItems = useMemo<SearchDirectoryItem[]>(() => {',
    'const searchResultTotalPages',
    'reader search directory memo',
  )
  const searchDirectoryDependencies = searchDirectoryMemo.slice(searchDirectoryMemo.lastIndexOf('}, ['))
  if (/\bsearchCursor\b|\bactiveSessionHitIndex\b/.test(searchDirectoryDependencies)) {
    throw new Error('each reader previous/next search still rebuilds every search-result snippet')
  }
  if (!documentView.includes('window.api.translateBook(documentId, {')) {
    throw new Error('full-book translation still depends on the bounded renderer page window')
  }
  const viewerCountCalibration = sliceBetween(
    searchView,
    'async function applyViewerHitCounts(',
    'function buildFocusedSearchSession(',
    'global search viewer count calibration',
  )
  if (viewerCountCalibration.includes('totalDocuments: groups.length') || viewerCountCalibration.includes('totalHits: groups.reduce(')) {
    throw new Error('global search viewer-count calibration overwrites full-library totals with the current result page')
  }
  if (!searchView.includes('当前显示第 ${groupedResultStart}-${groupedResultEnd} 篇')) {
    throw new Error('global search pagination is still presented as ambiguous document page numbers or result pages')
  }
  if (!documentView.includes("const requestKey = `book-translation:${documentId}`")
    || !documentView.includes('if (handledBookTranslationRequestRef.current === requestKey) return')) {
    throw new Error('full-book translation requests can restart after unrelated reader settings change')
  }

  if (!libraryView.includes('const IMPORT_LIST_REFRESH_BATCHES = 4')) {
    throw new Error('large imports still refresh the whole library list after every batch')
  }
  if (!libraryView.includes('const importListRefreshBatchCountRef = useRef<Map<number, number>>(new Map())')
    || !libraryView.includes('completedRefreshBatches % IMPORT_LIST_REFRESH_BATCHES === 0 && hasMoreImportBatches')) {
    throw new Error('directory selection chunks reset the import refresh throttle')
  }
  if (!libraryView.includes('if (!hasMoreSelectionBatches) {\n        importListRefreshBatchCountRef.current.delete(job.id)\n        await refreshLibraryAfterImport()')) {
    throw new Error('import completion does not perform one final authoritative refresh')
  }
  if (libraryView.includes('cancelScheduledImportListRefresh()\n        await refreshLibraryAfterImport()')) {
    throw new Error('import completion cancels a shared PDF workflow status refresh')
  }

  const payloadReductionPercent = (1 - retainedPayloadBytes / originalPayloadBytes) * 100
  console.log(`Renderer performance regressions passed (bulk removal ${elapsedMs.toFixed(1)} ms, one notification; reader payload -${payloadReductionPercent.toFixed(1)}%)`)
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
